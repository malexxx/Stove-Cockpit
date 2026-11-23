"""
Sous-routeur pour l'assistant d'étalonnage couplé Nobis A10 (Nobis.Supervisor).
Gère la page HTML du wizard et les étapes d'acquisition multi-phases et tarage EEPROM.
"""
import asyncio
import os
from typing import Annotated

from fastapi import APIRouter, Body, HTTPException, Request
from fastapi.responses import HTMLResponse

from config import BASE_DIR
from database import get_active_mode, get_latest_telemetry, get_registers_dict
from schemas import CalibrationStep1Payload, CalibrationStep3Payload
from services.installer_auth import require_installer_auth_if_configured
from telemetry import execute_register_write, execute_registers_batch_write

router = APIRouter(tags=["Calibration"])

_CALIB_STEP1_DEFAULT = CalibrationStep1Payload()
_CALIB_STEP3_DEFAULT = CalibrationStep3Payload()


def _read_calibration_wizard_html() -> str:
    calib_file = os.path.join(BASE_DIR, "src", "ui", "wizard_calibration.html")
    if not os.path.exists(calib_file):
        return ""
    with open(calib_file, encoding="utf-8") as f:
        return f.read()


@router.get("/calibration", response_class=HTMLResponse)
@router.head("/calibration", response_class=HTMLResponse, include_in_schema=False)
async def serve_calibration_wizard():
    """Sert l'interface HTML de l'assistant d'étalonnage Nobis A10."""
    no_cache = {"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"}
    html = await asyncio.to_thread(_read_calibration_wizard_html)
    if html:
        return HTMLResponse(content=html, headers=no_cache)
    raise HTTPException(status_code=404, detail="Page de calibration introuvable")


@router.get("/api/calibration/status")
async def api_calibration_status():
    """Retourne l'état complet de la session de calibration active (persiste en arrière-plan)."""
    from src.calibration.calibration_service import get_calibration_service

    calib_srv = get_calibration_service()
    return calib_srv.get_status(get_latest_telemetry())


@router.post("/api/calibration/step1-start", responses={403: {"description": "Authentification installateur requise"}})
async def api_calibration_step1_start(
    request: Request,
    payload: Annotated[CalibrationStep1Payload, Body()] = _CALIB_STEP1_DEFAULT,
):
    """Étape 1 : Choix du mode et désactivation automatique de POWERFUL (P8)."""
    require_installer_auth_if_configured(request)
    from src.calibration.calibration_service import build_sample_from_record, get_calibration_service

    calib_srv = get_calibration_service()
    mode_str = payload.mode
    sample = build_sample_from_record(get_latest_telemetry())

    if sample.powerful_enabled_mode != "OFF" or sample.power_level == 8:
        res_pwf = await execute_register_write("fun_pwf_set", 0.0, 33154, skip_poll=True)
        pwf_ok = res_pwf.get("status") == "ok"
    else:
        pwf_ok = True

    return calib_srv.start_preflight(mode_str, sample, disable_p8_fn=lambda: pwf_ok)


@router.post("/api/calibration/step2-confirm-al03", responses={403: {"description": "Authentification installateur requise"}})
async def api_calibration_step2_confirm(request: Request):
    """Étape 2 : Confirmation de l'état initial AL-03 et réarmement automatique."""
    require_installer_auth_if_configured(request)
    from src.calibration.calibration_service import build_sample_from_record, get_calibration_service

    calib_srv = get_calibration_service()
    sample = build_sample_from_record(get_latest_telemetry())

    if sample.alarm_code == "AL-03":
        # Sécurité physique (BB-02) : envoyer 170.0 (OFF / Reset Alarme) et JAMAIS 85.0 (Allumage) sur cuve vide
        res_rst = await execute_register_write("status_code", 170.0, 232, skip_poll=True)
        rst_ok = res_rst.get("status") == "ok"
    else:
        rst_ok = False

    return calib_srv.confirm_initial_al03(sample, reset_alarm_fn=lambda: rst_ok)


@router.post("/api/calibration/step3-load-charge", responses={403: {"description": "Authentification installateur requise"}})
async def api_calibration_step3_load(
    request: Request,
    payload: Annotated[CalibrationStep3Payload, Body()] = _CALIB_STEP3_DEFAULT,
):
    """Étape 3 : Verrouille le poids du sac étalon et lance l'acquisition en arrière-plan."""
    require_installer_auth_if_configured(request)
    from src.calibration.calibration_service import build_sample_from_record, get_calibration_service

    calib_srv = get_calibration_service()
    sample = build_sample_from_record(get_latest_telemetry())
    return calib_srv.load_weighed_charge(
        sample,
        weighed_bag_kg=payload.weighed_bag_kg,
        aspirated_priming_g=payload.aspirated_priming_grams,
    )


@router.post("/api/calibration/step5-apply", responses={403: {"description": "Authentification installateur requise"}})
async def api_calibration_step5_apply(request: Request):
    """Étape 5 : Application en 1 clic des Offsets 70 et 71 dans l'EEPROM Micronova."""
    require_installer_auth_if_configured(request)
    from src.calibration.calibration_service import get_calibration_service
    calib_srv = get_calibration_service()
    active_mode = get_active_mode()

    if calib_srv.engine.result is not None:
        t70 = int(calib_srv.engine.result.recommended_offset_70)
        t71 = int(calib_srv.engine.result.recommended_offset_71)
        batch_res = await execute_registers_batch_write([
            {"reg_key": "trim_pellet_pct", "value": float(t70), "offset": 70},
            {"reg_key": "trim_exhaust_pct", "value": float(t71), "offset": 71},
        ])
        batch_ok = batch_res.get("status") == "ok"
    else:
        batch_ok = False

    def _write_reg(reg: int, val: int) -> bool:
        return bool(batch_ok)

    def _read_reg(reg: int) -> int:
        regs = get_registers_dict(active_mode)
        rk = "trim_pellet_pct" if reg == 70 else "trim_exhaust_pct"
        return int(round(float(regs.get(rk, {}).get("current_val", 0))))

    res = calib_srv.apply_recommendations(write_fn=_write_reg, read_fn=_read_reg)
    if active_mode == "agua_cloud" and res.get("success"):
        res["remote_manual_required"] = True
        res["message"] = (
            res.get("message", "")
            + " (En mode Agua Cloud, reportez également ces valeurs sur la radiocommande physique)."
        )
    return res


@router.post("/api/calibration/reset", responses={403: {"description": "Authentification installateur requise"}})
async def api_calibration_reset(request: Request):
    """Réinitialise la calibration pour repartir de zéro si souhaité."""
    require_installer_auth_if_configured(request)
    from src.calibration.calibration_service import get_calibration_service
    calib_srv = get_calibration_service()
    return calib_srv.reset_session()
