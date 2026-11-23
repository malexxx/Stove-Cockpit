"""
Sous-routeur pour les commandes de pilotage du poêle et la gestion des granulés.
Regroupe le réglage des températures/ventilations/puissances (/api/stove/set),
les écritures directes de registres, le réapprovisionnement de la trémie et la gestion des lots de pellets.
"""
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Body, HTTPException, Path, Request

from analytics import get_pellet_batch_state
from config import PELLET_BAG_WEIGHT_KG, get_hopper_capacity_kg
from database import db_log, get_active_mode, get_db, get_registers_dict, get_settings_dict, get_sys_db
from schemas import (
    BatchCommandPayload,
    CommandPayload,
    PelletBatchRazPayload,
    RefillHopperPayload,
    StoveSetPayload,
)
from services.installer_auth import require_installer_auth_if_configured
from telemetry import (
    _stove_io_lock,
    collect_telemetry_cycle,
    execute_register_write,
    execute_registers_batch_write,
    reset_pellet_batch_calibration,
)

router = APIRouter(prefix="/api", tags=["Stove Control"])

_RAZ_DEFAULT = PelletBatchRazPayload()
_AuditIdPath = Annotated[int, Path(ge=1, le=9223372036854775807)]


def _is_raw_or_privileged_write(reg_key: str, offset: int | None, regs_catalog: dict[str, Any]) -> bool:
    """Identifie les écritures d'offsets bruts ou hors catalogue réservées à l'installateur."""
    rk = (reg_key or "").strip()
    if rk == "raw_offset" or rk.upper().startswith("RAW_") or rk not in regs_catalog:
        return True
    if offset is not None and int(offset) != int(regs_catalog[rk].get("offset", offset)):
        return True
    return False


@router.post("/command")
async def api_command(payload: CommandPayload, request: Request):
    """Écriture unitaire d'un registre."""
    regs = get_registers_dict(get_active_mode())
    if _is_raw_or_privileged_write(payload.reg_key, payload.offset, regs):
        require_installer_auth_if_configured(request)
    return await execute_register_write(payload.reg_key, payload.value, payload.offset)


@router.post("/command-batch")
async def api_command_batch(payload: BatchCommandPayload, request: Request):
    """Écriture groupée de plusieurs registres en une seule transaction."""
    regs = get_registers_dict(get_active_mode())
    if any(_is_raw_or_privileged_write(c.reg_key, c.offset, regs) for c in payload.commands):
        require_installer_auth_if_configured(request)
    cmds = [{"reg_key": c.reg_key, "value": c.value, "offset": c.offset} for c in payload.commands]
    return await execute_registers_batch_write(cmds)


@router.post("/stove/set", responses={400: {"description": "Type de commande inconnu"}})
async def api_stove_set(payload: StoveSetPayload):
    """Point d'entrée unifié de pilotage pour le composant modulaire NobisPilotage (temp, fan, power)."""
    cmd_type = (payload.type or "").strip().lower()
    zone = (payload.zone or "salon").strip().lower()
    val = float(payload.value)

    if cmd_type == "temp":
        zone_map = {
            "salon": ("temp_amb_setpoint", 33122),
            "front": ("temp_amb_setpoint", 33122),
            "sx": ("duct_left_setpoint", 33126),
            "dx": ("duct_right_setpoint", 33124),
        }
        reg_key, offset = zone_map.get(zone, ("temp_amb_setpoint", 33122))
        if val <= 6.0:
            mapped_val = 7.0
        elif val >= 31.0 and val < 41.0:
            mapped_val = 41.0
        else:
            mapped_val = max(7.0, min(41.0, round(val * 2.0) / 2.0))
        return await execute_register_write(reg_key, mapped_val, offset)

    elif cmd_type == "fan":
        zone_map = {
            "salon": ("fan_front_speed", 33132),
            "front": ("fan_front_speed", 33132),
            "sx": ("duct_left_speed", 33136),
            "dx": ("duct_right_speed", 33134),
        }
        reg_key, offset = zone_map.get(zone, ("fan_front_speed", 33132))
        iv = max(0, min(8, int(round(val))))
        return await execute_register_write(reg_key, float(iv), offset)

    elif cmd_type == "power":
        iv = max(0, min(8, int(round(val))))
        if iv == 0:
            return {
                "status": "ok",
                "reg_key": "power_level",
                "new_value": 0.0,
                "message": "P0 (Éco) est un ralenti automatique enclenché lorsque la température atteint la consigne.",
            }
        if iv == 8:
            return await execute_register_write("fun_pwf_set", 1.0, 33154)
        active_mode = get_active_mode()
        regs = get_registers_dict(active_mode)
        pwf_cur = float(regs.get("fun_pwf_set", {}).get("current_val", 0.0))
        if pwf_cur > 0.0:
            await execute_register_write("fun_pwf_set", 0.0, 33154, skip_poll=True)
        return await execute_register_write("power_level", float(iv), 33120)

    raise HTTPException(status_code=400, detail=f"Type de commande inconnu : {cmd_type}")


@router.post("/refill-hopper")
async def api_refill_hopper(payload: Annotated[RefillHopperPayload | None, Body()] = None):
    """Recharge la trémie en granulés et met à jour le stock disponible."""
    bags_added = payload.bags_added if payload is not None else 2.0
    active_mode = get_active_mode()
    settings = get_settings_dict()
    hopper_capacity_kg = get_hopper_capacity_kg(settings)

    async with _stove_io_lock:
        conn = get_db(active_mode)
        try:
            last_row = conn.execute("SELECT id, pellet_hopper_pct FROM telemetry ORDER BY epoch DESC LIMIT 1").fetchone()
            prev_pct = float(last_row["pellet_hopper_pct"]) if last_row else 50.0
            if payload is not None and payload.level_pct is not None:
                new_pct = round(min(100.0, max(0.0, float(payload.level_pct))), 1)
            elif payload is not None and "target_pct" in payload.model_fields_set:
                new_pct = round(min(100.0, max(0.0, float(payload.target_pct))), 1)
            elif payload is not None and "bags_added" in payload.model_fields_set:
                added_pct = (float(payload.bags_added) * PELLET_BAG_WEIGHT_KG / hopper_capacity_kg) * 100.0
                new_pct = round(min(100.0, prev_pct + added_pct), 1)
            else:
                req_pct = payload.target_pct if payload is not None else 100.0
                new_pct = round(min(100.0, max(0.0, float(req_pct))), 1)

            if last_row:
                conn.execute(
                    "UPDATE telemetry SET pellet_hopper_pct = ?, popup_pellet_empty = 0 WHERE id = ?",
                    (new_pct, last_row["id"]),
                )
                conn.commit()
        finally:
            conn.close()

        try:
            cur_stock = float(settings.get("pellet_bags_stock", "40"))
        except (ValueError, TypeError):
            cur_stock = 40.0
        try:
            cur_used = float(settings.get("pellet_bags_used_season", "0"))
        except (ValueError, TypeError):
            cur_used = 0.0

        new_stock = max(0.0, round(cur_stock - bags_added, 1))
        new_used = round(cur_used + bags_added, 1)

        sconn = get_sys_db()
        try:
            sconn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('pellet_bags_stock', ?)", (str(new_stock),))
            sconn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('pellet_bags_used_season', ?)", (str(new_used),))
            sconn.commit()
        finally:
            sconn.close()

    kg_added = round(bags_added * PELLET_BAG_WEIGHT_KG, 1)
    db_log(
        "COMMAND",
        "HOPPER",
        f"Trémie rechargée (+{bags_added:g} sac(s) / +{kg_added:g} kg) -> {new_pct}% (Capacité {int(hopper_capacity_kg)} kg | Stock restant: {new_stock:g} sacs).",
        active_mode,
    )
    latest = await collect_telemetry_cycle(active_mode)
    async with _stove_io_lock:
        conn = get_db(active_mode)
        try:
            new_last = conn.execute("SELECT id FROM telemetry ORDER BY epoch DESC LIMIT 1").fetchone()
            if new_last:
                conn.execute("UPDATE telemetry SET pellet_hopper_pct = ?, popup_pellet_empty = 0 WHERE id = ?", (new_pct, new_last["id"]))
                conn.commit()
        finally:
            conn.close()
    latest["pellet_hopper_pct"] = new_pct
    return {
        "status": "ok",
        "pellet_hopper_pct": new_pct,
        "hopper_capacity_kg": hopper_capacity_kg,
        "bags_stock": new_stock,
        "pellet_bags_stock": new_stock,
        "bags_used_season": new_used,
        "latest": latest,
    }


@router.post("/pellet-batch/raz", responses={403: {"description": "Authentification installateur requise"}})
async def api_pellet_batch_raz(
    request: Request,
    payload: Annotated[PelletBatchRazPayload, Body()] = _RAZ_DEFAULT,
):
    """Réinitialise l'évaluation algorithmique lors d'un changement de marque de granulés."""
    require_installer_auth_if_configured(request)
    brand = (payload.pellet_brand or "Nouveau Lot Certifié A1").strip() or "Nouveau Lot Certifié A1"
    return await reset_pellet_batch_calibration(brand)


@router.get("/pellet-batch/status")
async def api_pellet_batch_status():
    """Retourne l'état courant du lot de granulés évalué."""
    return get_pellet_batch_state()


@router.post("/sync-clock")
async def api_sync_clock():
    """Synchronise l'horloge interne de la carte électronique Micronova (heure Europe/Paris)."""
    try:
        from zoneinfo import ZoneInfo
        now = datetime.now(ZoneInfo("Europe/Paris"))
    except Exception:
        now = datetime.now()
    clock_commands = [
        {"reg_key": "clock_hour_set", "offset": 34048, "value": float(now.hour)},
        {"reg_key": "clock_minute_set", "offset": 34049, "value": float(now.minute)},
        {"reg_key": "calendar_day_set", "offset": 34050, "value": float(now.day)},
        {"reg_key": "calendar_month_set", "offset": 34051, "value": float(now.month)},
        {"reg_key": "calendar_year_set", "offset": 34052, "value": float(now.year - 2000)},
        {"reg_key": "calendar_day_week_set", "offset": 34053, "value": float(now.isoweekday())},
    ]
    await execute_registers_batch_write(clock_commands, skip_poll=True)
    active_mode = get_active_mode()
    db_log("COMMAND", "RTC_SYNC", f"Horloge synchronisée sur {now.strftime('%H:%M %d/%m/%Y')}", active_mode)
    latest = await collect_telemetry_cycle(active_mode)
    return {"status": "ok", "synced_to": now.strftime("%H:%M %d/%m/%Y"), "latest": latest}


@router.post(
    "/rollback/{audit_id}",
    responses={
        403: {"description": "Authentification installateur requise"},
        404: {"description": "Entrée d'audit introuvable"},
    },
)
async def api_rollback(request: Request, audit_id: _AuditIdPath):
    """Restaure une valeur antérieure de registre depuis le journal d'audit."""
    require_installer_auth_if_configured(request)
    active_mode = get_active_mode()
    conn = get_db(active_mode)
    try:
        row = conn.execute("SELECT * FROM command_audit WHERE id = ?", (audit_id,)).fetchone()
    finally:
        conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Entrée d'audit introuvable")
    return await execute_register_write(row["reg_key"], float(row["old_value"]), int(row["offset"]))
