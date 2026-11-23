"""Orchestrateur du cycle d'acquisition télémétrique, persistance SQLite, SSE, Matter et calibration."""
import asyncio
from datetime import datetime
import logging
import os
from typing import Any

from analytics import enrich_telemetry_record
from clients import agua_client, local_gateway_client, notification_service, weather_service
from config import APP_VERSION, DOCKER_VERSION, MODE_DB_PATHS, TELEMETRY_COLUMNS
from database import (
    db_log,
    get_active_mode,
    get_db,
    get_latest_telemetry,
    get_public_settings_dict,
    get_registers_dict,
    get_settings_dict,
)
from matter_service import matter_manager
from telemetry.decoder import build_offline_record, decode_hardware_buffer
from telemetry.hub import _stove_io_lock, broadcast_sse_event, get_comm_status
from telemetry.simulator import simulate_telemetry_step

logger = logging.getLogger("nobis.telemetry")


async def _dispatch_post_telemetry_effects(
    comm_mode: str,
    settings: dict[str, str],
    record: dict[str, Any],
    raw_buf: dict[int, float],
) -> None:
    """Exécute les effets de bord non critiques (alertes, SSE, Matter, calibration) hors verrou bus I/O."""
    from services.silence_service import get_silence_status

    consumption_stats = {
        "conso_week_kg": record.get("conso_week_kg", 0.0),
        "conso_month_kg": record.get("conso_month_kg", 0.0),
    }

    await notification_service.evaluate_telemetry_alerts(record, settings)
    await broadcast_sse_event("telemetry", {
        "version": APP_VERSION,
        "docker_version": DOCKER_VERSION,
        "active_mode": comm_mode,
        "active_db_file": os.path.basename(MODE_DB_PATHS.get(comm_mode, MODE_DB_PATHS["simulation"])),
        "stove_name": settings.get("stove_name") or agua_client.stove_name or "Poêle Micronova",
        "capabilities": agua_client.get_capabilities(settings),
        "latest": record,
        "comm_status": get_comm_status(),
        "settings": get_public_settings_dict(),
        "registers": get_registers_dict(comm_mode),
        "consumption_stats": consumption_stats,
        "pellet_quality": record.get("pellet_quality"),
        "exhaust_quality": record.get("exhaust_quality"),
        "silence_mode": get_silence_status(),
    })
    await matter_manager.sync_telemetry(record)

    try:
        from src.calibration.calibration_service import get_calibration_service

        calib_srv = get_calibration_service()
        calib_srv.process_telemetry_record(record, raw_buf)
    except Exception as e:
        logger.debug(f"Erreur d'ingestion calibration en tâche de fond : {e}")


async def collect_telemetry_cycle(force_mode: str | None = None) -> dict[str, Any]:
    """Exécute un cycle complet de collecte et décodage de télémétrie en limitant le verrou aux I/O bus."""
    pre_settings = get_settings_dict()
    weather = await weather_service.fetch_current(
        pre_settings.get("weather_lat", "48.8566"),
        pre_settings.get("weather_lon", "2.3522"),
    )

    try:
        await asyncio.wait_for(_stove_io_lock.acquire(), timeout=5.0)
    except TimeoutError:
        active_m = force_mode or get_active_mode()
        conn = get_db(active_m)
        try:
            last_row = conn.execute("SELECT * FROM telemetry ORDER BY epoch DESC LIMIT 1").fetchone()
            rec = dict(last_row) if last_row else {}
            if rec:
                enrich_telemetry_record(conn, rec)
            return rec
        finally:
            conn.close()

    try:
        try:
            comm_mode, settings, record, raw_buf = await _read_and_store_telemetry_unlocked(
                force_mode=force_mode,
                pre_weather=weather,
            )
        except Exception as e:
            active_m = force_mode or get_active_mode()
            db_log("ERROR", "TELEMETRY", f"Échec inattendu cycle télémétrie : {str(e)}", active_m)
            raise
    finally:
        _stove_io_lock.release()

    await _dispatch_post_telemetry_effects(comm_mode, settings, record, raw_buf)
    return record


async def _read_and_store_telemetry_unlocked(
    force_mode: str | None = None,
    pre_weather: dict[str, Any] | None = None,
) -> tuple[str, dict[str, str], dict[str, Any], dict[int, float]]:
    """Lecture du buffer physique/cloud, décodage/simulation et persistance SQLite sous verrou I/O."""
    settings = get_settings_dict()
    comm_mode = force_mode or settings.get("comm_mode", "agua_cloud")
    regs = get_registers_dict(comm_mode)
    weather = pre_weather if pre_weather is not None else await weather_service.fetch_current(
        settings.get("weather_lat", "48.8566"),
        settings.get("weather_lon", "2.3522"),
    )
    prev = get_latest_telemetry(comm_mode)

    now = datetime.now()
    now_str = now.strftime("%Y-%m-%d %H:%M:%S")
    dt_hours = max(0.005, (int(now.timestamp()) - int(prev.get("epoch", int(now.timestamp()) - 120))) / 3600.0)
    r_val = {k: float(v["current_val"]) for k, v in regs.items()}

    raw_buf: dict[int, float] = {}
    cloud_error: str | None = None

    if comm_mode == "agua_cloud":
        if settings.get("agua_email") and settings.get("agua_password"):
            try:
                raw_buf = await agua_client.read_buffer(settings)
            except Exception as e:
                cloud_error = str(e)
                db_log("ERROR", "AGUA_CLOUD", f"Échec lecture buffer Agua IOT : {str(e)}", "agua_cloud")
        else:
            cloud_error = "Identifiants Cloud Nobis Agua IOT non renseignés"
    elif comm_mode == "local_gateway":
        gw_url = settings.get("local_gateway_url", "http://192.168.1.150")
        try:
            raw_buf = await local_gateway_client.read_buffer(gw_url)
        except Exception as e:
            cloud_error = str(e)
            db_log("ERROR", "LOCAL_GATEWAY", f"Échec lecture passerelle UART : {str(e)}", "local_gateway")

    if raw_buf:
        record = decode_hardware_buffer(
            raw_buf=raw_buf,
            regs=regs,
            r_val=r_val,
            prev=prev,
            settings=settings,
            weather=weather,
            comm_mode=comm_mode,
            now=now,
            now_str=now_str,
            dt_hours=dt_hours,
            register_map=agua_client.raw_registers_map if comm_mode == "agua_cloud" else None,
        )
    elif comm_mode != "simulation":
        record = build_offline_record(
            prev=prev,
            r_val=r_val,
            weather=weather,
            comm_mode=comm_mode,
            now=now,
            now_str=now_str,
            cloud_error=cloud_error,
        )
    else:
        record = simulate_telemetry_step(
            r_val=r_val,
            prev=prev,
            settings=settings,
            weather=weather,
            comm_mode=comm_mode,
            now=now,
            now_str=now_str,
            dt_hours=dt_hours,
        )

    cols = [c for c in TELEMETRY_COLUMNS.keys() if c != "id"]
    placeholders = ", ".join(["?"] * len(cols))
    conn = get_db(comm_mode)
    try:
        conn.execute(
            f"INSERT INTO telemetry ({', '.join(cols)}) VALUES ({placeholders})",
            tuple(record[c] for c in cols),
        )
        conn.commit()
        enrich_telemetry_record(conn, record)
    finally:
        conn.close()

    return comm_mode, settings, record, raw_buf


async def _collect_telemetry_unlocked(force_mode: str | None = None) -> dict[str, Any]:
    """Compatibilité interne : lecture/stockage + effets de bord."""
    comm_mode, settings, record, raw_buf = await _read_and_store_telemetry_unlocked(force_mode=force_mode)
    await _dispatch_post_telemetry_effects(comm_mode, settings, record, raw_buf)
    return record
