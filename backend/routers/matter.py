"""
Sous-routeur pour le pont Matter local (Google Home, Nest Hub Max, Apple Home).
Gère le statut du pont, le redémarrage, le reset d'appairage et le webhook local.
"""
import hmac

from fastapi import APIRouter, HTTPException, Request

from database import db_log, get_active_mode
from matter_service import matter_manager
from schemas import MatterWebhookPayload
from telemetry import execute_register_write

router = APIRouter(prefix="/api/matter", tags=["Matter"])


@router.get("/status")
async def api_matter_status():
    """Retourne l'état du pont Thermostat Matter, le QR Code SVG et le code d'appairage à 11 chiffres."""
    return await matter_manager.get_status()


@router.post("/restart")
async def api_matter_restart():
    """Redémarre le pont Thermostat Matter."""
    await matter_manager.stop()
    return await matter_manager.ensure_started(force=True)


@router.post("/factory-reset")
async def api_matter_factory_reset():
    """Réinitialise l'appairage Matter et génère un nouveau code d'appairage."""
    return await matter_manager.factory_reset()


@router.post("/webhook", responses={400: {"description": "Paramètres invalides"}, 403: {"description": "Accès réservé au pont local Matter"}})
async def api_matter_webhook(payload: MatterWebhookPayload, request: Request):
    """Point d'entrée interne appelé par le pont Matter lors d'une commande Google Home / Nest Hub Max."""
    client_ip = request.client.host if request.client else ""
    if client_ip not in ("127.0.0.1", "::1", "localhost", "testclient"):
        raise HTTPException(status_code=403, detail="Accès réservé au pont local Matter (127.0.0.1)")

    provided_secret = (request.headers.get("X-Matter-Secret") or "").strip()
    if not provided_secret or not hmac.compare_digest(provided_secret, matter_manager.webhook_secret):
        raise HTTPException(status_code=403, detail="Jeton interne X-Matter-Secret manquant ou invalide.")

    action = payload.action.strip()
    active_mode = get_active_mode()

    if action == "set_power":
        target_state = (payload.state or "OFF").upper()
        cmd_val = 85.0 if target_state == "ON" else 170.0
        label_action = "Allumage (85)" if target_state == "ON" else "Extinction (170)"
        db_log(
            "COMMAND",
            "GOOGLE_MATTER",
            f"Commande Google Home / Nest Hub Max reçue : {label_action} du poêle.",
            active_mode,
        )
        res = await execute_register_write("status_code", cmd_val, 232)
        return {"status": "ok", "action": action, "state": target_state, "result": res}

    elif action == "set_temperature":
        temp_val = payload.temperature if payload.temperature is not None else 20.0
        temp_c = float(max(7, min(40, round(temp_val))))
        db_log(
            "COMMAND",
            "GOOGLE_MATTER",
            f"Commande Google Home / Nest Hub Max reçue : Consigne T° Ambiante réglée à {temp_c:g} °C.",
            active_mode,
        )
        res = await execute_register_write("temp_amb_setpoint", temp_c, 33122)
        return {"status": "ok", "action": action, "temperature": temp_c, "result": res}

    raise HTTPException(status_code=400, detail=f"Action Matter inconnue : {action}")
