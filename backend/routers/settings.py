"""Sous-routeur configuration, diagnostics de liaison, webhooks, cartographie Agua et géocodage inverse."""
import asyncio
import logging
import os

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

import clients as _clients_pkg
from clients import (
    AguaCloudClient,
    agua_client,
    is_safe_gateway_url,
    is_safe_webhook_url,
    local_gateway_client,
    notification_service,
    weather_service,
)
from config import APP_VERSION, BRANDS_BY_ID, BRANDS_CATALOG, MODE_DB_PATHS, get_hopper_capacity_kg
from database import (
    db_log,
    encrypt_setting_value,
    get_active_mode,
    get_public_settings_dict,
    get_settings_dict,
    get_sys_db,
)
from matter_service import matter_manager
from schemas import SettingsPayload, TestConnectionPayload, TestWebhookPayload
from services.installer_auth import clear_installer_sessions, require_installer_auth_if_configured
from services.lifecycle import scheduler
from telemetry import collect_telemetry_cycle

logger = logging.getLogger("nobis.settings")
router = APIRouter(prefix="/api", tags=["Settings & Diagnostics"])

_SENSITIVE_SETTINGS = {
    "comm_mode",
    "agua_brand",
    "agua_api_url",
    "agua_customer_code",
    "agua_brand_id",
    "agua_brand_header",
    "agua_login_api_url",
    "agua_email",
    "agua_password",
    "agua_uuid",
    "agua_id_device",
    "agua_id_product",
    "local_gateway_url",
    "webhook_url",
    "matter_enabled",
    "matter_port",
}


@router.get("/brands")
async def api_list_brands():
    """Retourne le catalogue des marques compatibles Micronova Agua IOT."""
    return {"brands": BRANDS_CATALOG}


_CLOUD_AUTH_KEYS = {
    "agua_brand",
    "agua_api_url",
    "agua_customer_code",
    "agua_brand_id",
    "agua_brand_header",
    "agua_login_api_url",
    "agua_email",
    "agua_password",
}


def _apply_brand_preset_defaults(raw_dict: dict) -> None:
    """Synchronise automatiquement URL/codes Agua IOT depuis brands.json lorsqu'une marque prédéfinie est choisie."""
    brand_key = str(raw_dict.get("agua_brand") or "").strip()
    if not brand_key or brand_key == "custom":
        return
    preset = BRANDS_BY_ID.get(brand_key)
    if not preset or not preset.get("api_url"):
        return
    raw_dict["agua_api_url"] = str(preset.get("api_url") or "").strip().rstrip("/")
    raw_dict["agua_customer_code"] = str(preset.get("customer_code") or "").strip()
    raw_dict["agua_brand_id"] = str(preset.get("brand_id") or "1").strip()
    raw_dict["agua_brand_header"] = str(preset.get("brand") or "").strip()
    raw_dict["agua_login_api_url"] = str(preset.get("login_api_url") or "").strip()


async def _validate_and_normalize_settings(raw_dict: dict) -> None:
    _apply_brand_preset_defaults(raw_dict)
    if "webhook_url" in raw_dict:
        wh_url = str(raw_dict["webhook_url"] or "").strip()
        if wh_url and not await asyncio.to_thread(is_safe_webhook_url, wh_url):
            raise HTTPException(status_code=400, detail="URL de webhook invalide ou rejetée par le filtre de sécurité anti-SSRF.")
        raw_dict["webhook_url"] = wh_url

    if "local_gateway_url" in raw_dict:
        gw_url_in = str(raw_dict["local_gateway_url"] or "").strip()
        if gw_url_in and not await asyncio.to_thread(is_safe_gateway_url, gw_url_in):
            raise HTTPException(status_code=400, detail="URL de passerelle locale invalide ou rejetée par le filtre de sécurité anti-SSRF.")
        raw_dict["local_gateway_url"] = gw_url_in

    if "duct_left_name" in raw_dict:
        raw_dict["duct_left_name"] = (str(raw_dict["duct_left_name"] or "").strip()[:20]) or "SX"
    if "duct_right_name" in raw_dict:
        raw_dict["duct_right_name"] = (str(raw_dict["duct_right_name"] or "").strip()[:20]) or "DX"


def _persist_settings_dict(raw_dict: dict) -> None:
    conn = get_sys_db()
    try:
        for k, v in raw_dict.items():
            if v is not None and str(v) != "********":
                stored_val = encrypt_setting_value(str(k), str(v))
                conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (str(k), stored_val))
        conn.commit()
    finally:
        conn.close()


def _apply_poll_interval_update(raw_dict: dict) -> None:
    if "poll_interval_s" not in raw_dict or not str(raw_dict["poll_interval_s"]).strip():
        return
    try:
        interval_s = max(15, min(3600, int(float(str(raw_dict["poll_interval_s"]).strip()))))
    except (ValueError, TypeError):
        interval_s = 120
    if scheduler.get_job("telemetry_job"):
        scheduler.reschedule_job("telemetry_job", trigger="interval", seconds=interval_s)
    else:
        scheduler.add_job(collect_telemetry_cycle, "interval", seconds=interval_s, id="telemetry_job", replace_existing=True)


async def _apply_matter_settings_update(raw_dict: dict, new_mode: str) -> None:
    matter_keys = {"matter_enabled", "matter_device_name", "matter_port"}
    if not any(k in raw_dict for k in matter_keys):
        return
    try:
        if matter_manager.is_enabled():
            await matter_manager.stop()
            await matter_manager.ensure_started()
        else:
            await matter_manager.stop()
    except Exception as e:
        db_log("WARNING", "MATTER", f"Erreur ajustement pont Matter post-settings: {e}", new_mode)


@router.post("/settings")
async def api_save_settings(payload: SettingsPayload, request: Request):
    """Sauvegarde les paramètres de configuration dans la base système SQLite."""
    raw_dict = payload.model_dump(exclude_none=True)
    current_settings = get_settings_dict()
    sensitive_changed = any(
        k in _SENSITIVE_SETTINGS
        and raw_dict[k] is not None
        and str(raw_dict[k]) != "********"
        and str(raw_dict[k]) != str(current_settings.get(k, ""))
        for k in raw_dict
    )
    if sensitive_changed:
        require_installer_auth_if_configured(request)

    await _validate_and_normalize_settings(raw_dict)
    _persist_settings_dict(raw_dict)

    if any(k in _CLOUD_AUTH_KEYS for k in raw_dict):
        agua_client.reset_session()
    if "agua_password" in raw_dict and raw_dict["agua_password"] != "********":
        clear_installer_sessions()

    _apply_poll_interval_update(raw_dict)

    new_mode = get_active_mode()
    db_file_name = os.path.basename(MODE_DB_PATHS.get(new_mode, MODE_DB_PATHS["simulation"]))
    db_log("INFO", "SETTINGS", f"Configuration enregistrée. Base active : {db_file_name}", new_mode)

    await _apply_matter_settings_update(raw_dict, new_mode)
    await collect_telemetry_cycle(new_mode)
    return {"status": "ok", "settings": get_public_settings_dict(), "active_db": db_file_name}


@router.post(
    "/test-webhook",
    responses={
        200: {"description": "Notification de test envoyée avec succès"},
        400: {"description": "URL de webhook invalide ou rejetée"},
        403: {"description": "Authentification installateur requise"},
    },
)
async def api_test_webhook(payload: TestWebhookPayload, request: Request):
    """Envoie une notification push de test avec vérification stricte anti-SSRF."""
    require_installer_auth_if_configured(request)
    url = (payload.webhook_url or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="Aucune URL de Webhook / ntfy.sh renseignée.")
    if not await asyncio.to_thread(is_safe_webhook_url, url):
        raise HTTPException(status_code=400, detail="URL de webhook invalide ou rejetée par le filtre de sécurité anti-SSRF.")
    active_mode = get_active_mode()
    settings = get_settings_dict()
    stove_label = (settings.get("stove_name") or "Stove Cockpit").strip()
    hopper_cap = int(round(get_hopper_capacity_kg(settings)))
    notification_service._last_sent_by_key.pop("test_alert", None)
    ok = await notification_service.send_webhook(
        url,
        f"🔥 Test {stove_label}",
        f"Connexion notifications Push/Webhook opérationnelle (Trémie {hopper_cap} kg).",
        "test_alert",
        active_mode,
    )
    if not ok:
        return {"status": "error", "message": "Échec de l'envoi vers l'URL Webhook."}
    return {"status": "ok", "message": "Notification de test envoyée avec succès !"}


@router.post(
    "/test-connection",
    responses={
        200: {"description": "Résultat du test de communication"},
        403: {"description": "Authentification installateur requise"},
    },
)
async def api_test_connection(payload: TestConnectionPayload, request: Request):
    """Teste la communication avec le protocole sélectionné (Agua Cloud, Passerelle UART ou Simulation)."""
    require_installer_auth_if_configured(request)
    raw_dict = payload.model_dump(exclude_none=True)
    mode = raw_dict.get("comm_mode", "agua_cloud")
    settings = get_settings_dict()
    settings.update({k: str(v) for k, v in raw_dict.items() if str(v) != "********"})
    weather = await weather_service.fetch_current(settings.get("weather_lat", "48.8566"), settings.get("weather_lon", "2.3522"))
    if mode == "simulation":
        return {"status": "ok", "mode": "simulation", "active_db": os.path.basename(MODE_DB_PATHS["simulation"]), "weather": weather}
    elif mode == "agua_cloud":
        # Client isolé dédié au test pour ne jamais muter le singleton agua_client en cours de collecte
        probe_client = AguaCloudClient()
        try:
            res = await probe_client.login_and_discover(
                settings.get("agua_email", ""),
                settings.get("agua_password", ""),
                settings.get("agua_uuid", ""),
                persist_discovery=False,
                settings=settings,
            )
            return {"status": "ok", "mode": "agua_cloud", "active_db": os.path.basename(MODE_DB_PATHS["agua_cloud"]), "details": res, "weather": weather}
        except Exception as e:
            db_log("ERROR", "AGUA_CLOUD", f"Échec test connexion Agua IOT : {str(e)}", "agua_cloud")
            return JSONResponse(status_code=200, content={"status": "error", "details": f"Erreur Cloud Agua IOT : {str(e)}"})
    elif mode == "local_gateway":
        gw_url = settings.get("local_gateway_url", "http://192.168.1.150")
        if not await asyncio.to_thread(is_safe_gateway_url, gw_url):
            raise HTTPException(status_code=400, detail="URL de passerelle locale invalide ou rejetée par le filtre de sécurité anti-SSRF.")
        try:
            res = await local_gateway_client.test_connection(gw_url)
            return {"status": "ok", "mode": "local_gateway", "details": res, "weather": weather}
        except Exception as e:
            db_log("ERROR", "LOCAL_GATEWAY", f"Échec test connexion Passerelle UART : {str(e)}", "local_gateway")
            return JSONResponse(status_code=200, content={"status": "error", "details": f"Erreur Passerelle UART : {str(e)}"})


@router.get("/agua-registers-map", responses={403: {"description": "Authentification installateur requise"}})
async def api_agua_registers_map(request: Request):
    """Scanne et retourne la cartographie exhaustive des registres Agua IOT."""
    require_installer_auth_if_configured(request)
    settings = get_settings_dict()
    try:
        reg_map = await agua_client.scan_registers_map(settings)
        raw_buffer = await agua_client.read_buffer(settings)
    except Exception as e:
        return {
            "id_device": agua_client.id_device,
            "id_product": agua_client.id_product,
            "working_write_endpoint": agua_client.working_write_endpoint,
            "cached_offsets_count": len(agua_client.registers_map_by_offset),
            "raw_buffer_count": 0,
            "raw_buffer": {},
            "registers_map": [],
            "status": "offline",
            "details": f"Agua IOT non accessible : {str(e)}",
        }
    return {
        "id_device": agua_client.id_device,
        "id_product": agua_client.id_product,
        "working_write_endpoint": agua_client.working_write_endpoint,
        "cached_offsets_count": len(agua_client.registers_map_by_offset),
        "raw_buffer_count": len(raw_buffer),
        "raw_buffer": raw_buffer,
        "registers_map": reg_map,
    }


async def _reverse_geocode_ban(client, lat: float, lon: float) -> str:
    try:
        r_ban = await client.get(
            "https://api-adresse.data.gouv.fr/reverse/",
            params={"lon": f"{lon:.5f}", "lat": f"{lat:.5f}", "limit": 1},
        )
        if r_ban.status_code != 200:
            return ""
        feats = (r_ban.json() or {}).get("features") or []
        if not feats:
            return ""
        props = feats[0].get("properties") or {}
        city = (props.get("city") or props.get("municipality") or "").strip()
        postcode = (props.get("postcode") or "").strip()
        return f"{city} ({postcode})" if (city and postcode) else city
    except Exception as exc:
        logger.debug("Géocodage inverse BAN indisponible : %s", exc)
        return ""


async def _reverse_geocode_nominatim(client, lat: float, lon: float) -> str:
    try:
        r_nom = await client.get(
            "https://nominatim.openstreetmap.org/reverse",
            params={"format": "json", "lat": f"{lat:.5f}", "lon": f"{lon:.5f}", "zoom": 10, "addressdetails": 1},
            headers={"User-Agent": f"StoveCockpit/{APP_VERSION}"},
        )
        if r_nom.status_code != 200:
            return ""
        addr = (r_nom.json() or {}).get("address") or {}
        city = (
            addr.get("city")
            or addr.get("town")
            or addr.get("village")
            or addr.get("municipality")
            or ""
        ).strip()
        postcode = (addr.get("postcode") or "").strip()
        return f"{city} ({postcode})" if (city and postcode) else city
    except Exception as exc:
        logger.debug("Géocodage inverse Nominatim indisponible : %s", exc)
        return ""


@router.get("/reverse-geocode")
async def api_reverse_geocode(lat: float, lon: float):
    """Résout le nom de la commune à partir de coordonnées GPS (BAN France puis Nominatim)."""
    if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lon <= 180.0):
        raise HTTPException(status_code=400, detail="Coordonnées GPS invalides.")

    city_label = ""
    try:
        async with _clients_pkg.borrow_http_client(timeout=6.0) as client:
            city_label = await _reverse_geocode_ban(client, lat, lon)
            if not city_label:
                city_label = await _reverse_geocode_nominatim(client, lat, lon)
    except Exception as exc:
        logger.debug("Échec global géocodage inverse : %s", exc)

    return {
        "status": "ok",
        "city": city_label,
        "lat": f"{lat:.4f}",
        "lon": f"{lon:.4f}",
    }
