"""Sous-routeur d'administration système : redémarrage backend, stockage/sauvegarde ZIP et MAJ interne / Watchtower."""
import asyncio
from datetime import datetime
import os
from typing import Annotated

from fastapi import APIRouter, Body, HTTPException, Request
from fastapi.responses import JSONResponse, Response
import httpx
from pydantic import BaseModel, ConfigDict, StrictBool

from clients import agua_client
from database import add_container_log, db_log, get_active_mode, get_settings_dict
from routers.settings import _persist_settings_dict, _validate_and_normalize_settings
from services.api_token_service import build_pairing_info, rotate_api_token, verify_api_token
from services.cred_sync_service import (
    SYNCABLE_CLOUD_KEYS,
    consume_sync_ticket,
    create_sync_ticket,
    decrypt_cred_envelope,
    encrypt_cred_envelope,
)
from services.lifecycle import spawn_background_task
from services.storage_service import (
    MAX_BACKUP_UPLOAD_BYTES,
    create_backup_zip_bytes,
    inspect_storage_persistence,
    restore_backup_zip_bytes,
)
from services.update_service import (
    UpdateConflictError,
    UpdateUpstreamError,
    apply_internal_update,
    check_for_updates,
    get_update_status,
    rollback_internal_update,
    save_update_settings,
)
from telemetry import collect_telemetry_cycle

router = APIRouter(prefix="/api", tags=["System Admin"])


class UpdateCheckPayload(BaseModel):
    """Paramètres optionnels pour vérifier une mise à jour GitHub."""

    model_config = ConfigDict(extra="ignore")
    channel: str | None = None


class UpdateApplyPayload(BaseModel):
    """Paramètres optionnels pour installer une mise à jour interne."""

    model_config = ConfigDict(extra="ignore")
    channel: str | None = None
    force: StrictBool = False


class UpdateConfigPayload(BaseModel):
    """Configuration des préférences de mise à jour interne."""

    model_config = ConfigDict(extra="ignore")
    channel: str | None = None
    auto_check: StrictBool | None = None
    auto_apply: StrictBool | None = None


class CloudSyncExportPayload(BaseModel):
    """Paramètres d'export chiffré des identifiants Cloud vers l'application mobile."""

    model_config = ConfigDict(extra="ignore")
    sync_ticket: str | None = None


class CloudSyncImportPayload(BaseModel):
    """Paramètres d'import chiffré des identifiants Cloud depuis l'application mobile."""

    model_config = ConfigDict(extra="ignore")
    envelope: dict
    sync_ticket: str | None = None
    activate_cloud_mode: StrictBool = True


def _require_valid_api_token(request: Request) -> str:
    """Exige et retourne le jeton API du conteneur via X-API-Key ou Authorization Bearer."""
    tok = (request.headers.get("x-api-key") or "").strip()
    if not tok:
        auth_hdr = (request.headers.get("authorization") or "").strip()
        if auth_hdr.lower().startswith("bearer "):
            tok = auth_hdr[7:].strip()
    if not tok or not verify_api_token(tok):
        raise HTTPException(status_code=401, detail="Jeton API du conteneur requis ou invalide.")
    return tok


@router.get("/system/storage")
async def api_system_storage():
    """Retourne le diagnostic de persistance du dossier DATA_DIR (bind mount, volume nommé, anonyme ou éphémère)."""
    return await asyncio.to_thread(inspect_storage_persistence)


@router.get("/system/pairing-info")
async def api_system_pairing_info(request: Request):
    """Retourne l'URL HTTP et le jeton API pour connecter l'application mobile."""
    base_url = str(request.base_url).rstrip("/")
    payload = await asyncio.to_thread(build_pairing_info, base_url)
    settings = await asyncio.to_thread(get_settings_dict)
    payload["has_cloud_credentials"] = bool(
        (settings.get("agua_email") or "").strip() and (settings.get("agua_password") or "").strip()
    )
    return JSONResponse(content=payload, headers={"Cache-Control": "no-store"})


@router.post("/system/pairing-token/rotate")
async def api_system_pairing_token_rotate():
    """Régénère le jeton API du conteneur compagnon."""
    new_tok = await asyncio.to_thread(rotate_api_token)
    active_mode = await asyncio.to_thread(get_active_mode)
    db_log("WARNING", "SECURITY", "Jeton API du conteneur compagnon régénéré.", active_mode)
    return JSONResponse(content={"status": "ok", "api_token": new_tok}, headers={"Cache-Control": "no-store"})


@router.post("/system/cloud-credentials/ticket")
async def api_system_cloud_sync_ticket(request: Request):
    """Génère un QR Code incluant un ticket éphémère à usage unique (5 min) pour transférer les identifiants Cloud."""
    ticket = await asyncio.to_thread(create_sync_ticket, 300)
    base_url = str(request.base_url).rstrip("/")
    pairing_payload = await asyncio.to_thread(build_pairing_info, base_url, ticket["sync_ticket"])
    return JSONResponse(
        content={**pairing_payload, "expires_in": ticket["expires_in"]},
        headers={"Cache-Control": "no-store"},
    )


@router.post(
    "/system/cloud-credentials/export",
    responses={
        401: {"description": "Jeton API du conteneur requis ou invalide"},
        403: {"description": "Ticket de transfert invalide ou expiré"},
        404: {"description": "Aucun identifiant Cloud ou météo configuré"},
    },
)
async def api_system_cloud_credentials_export(
    request: Request,
    payload: Annotated[CloudSyncExportPayload | None, Body()] = None,
):
    """Exporte les identifiants Cloud et la station météo du conteneur chiffrés en AES-256-GCM."""
    api_tok = _require_valid_api_token(request)
    settings = await asyncio.to_thread(get_settings_dict)

    ticket_val = (payload.sync_ticket or "").strip() if payload and payload.sync_ticket else ""
    if ticket_val:
        if not consume_sync_ticket(ticket_val):
            raise HTTPException(status_code=403, detail="Ticket de synchronisation invalide ou expiré.")
        auth_proof = ticket_val
    else:
        auth_proof = ""

    creds = {
        k: str(settings.get(k, ""))
        for k in SYNCABLE_CLOUD_KEYS
        if settings.get(k) not in (None, "")
    }
    if not creds:
        raise HTTPException(status_code=404, detail="Aucun identifiant Cloud ou paramètre météo configuré sur ce conteneur.")

    envelope = encrypt_cred_envelope(creds, api_tok, auth_proof)
    active_mode = await asyncio.to_thread(get_active_mode)
    db_log("INFO", "SECURITY", "Export chiffré AES-256-GCM des paramètres Cloud/Météo vers application.", active_mode)
    return JSONResponse(content={"status": "ok", "envelope": envelope}, headers={"Cache-Control": "no-store"})


@router.post(
    "/system/cloud-credentials/import",
    responses={
        400: {"description": "Enveloppe chiffrée invalide ou expirée"},
        401: {"description": "Jeton API du conteneur requis ou invalide"},
        403: {"description": "Ticket de transfert invalide ou expiré"},
    },
)
async def api_system_cloud_credentials_import(payload: CloudSyncImportPayload, request: Request):
    """Importe dans le conteneur des identifiants Cloud chiffrés en AES-256-GCM depuis l'application."""
    api_tok = _require_valid_api_token(request)

    ticket_val = (payload.sync_ticket or "").strip() if payload.sync_ticket else ""
    if ticket_val:
        if not consume_sync_ticket(ticket_val):
            raise HTTPException(status_code=403, detail="Ticket de synchronisation invalide ou expiré.")
        auth_proof = ticket_val
    else:
        auth_proof = ""

    try:
        creds = decrypt_cred_envelope(payload.envelope, api_tok, auth_proof)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Enveloppe chiffrée invalide ou expirée : {exc}") from exc

    has_incoming_cloud_auth = bool((creds.get("agua_email") or "").strip() or (creds.get("agua_password") or "").strip())

    to_save = {
        k: v
        for k, v in creds.items()
        if k in SYNCABLE_CLOUD_KEYS and v not in (None, "", "********")
    }
    has_valid_cloud = bool((to_save.get("agua_email") or "").strip() and (to_save.get("agua_password") or "").strip())
    has_valid_weather = bool((to_save.get("weather_lat") or "").strip() and (to_save.get("weather_lon") or "").strip())
    if not has_valid_cloud and not has_valid_weather:
        raise HTTPException(status_code=400, detail="Aucune donnée Cloud ou Météo valide à importer.")

    if payload.activate_cloud_mode and has_valid_cloud:
        to_save["comm_mode"] = "agua_cloud"

    await _validate_and_normalize_settings(to_save)
    await asyncio.to_thread(_persist_settings_dict, to_save)
    if has_incoming_cloud_auth:
        agua_client.reset_session()

    new_mode = await asyncio.to_thread(get_active_mode)
    db_log("INFO", "SECURITY", "Import chiffré AES-256-GCM des paramètres Cloud/Météo depuis application.", new_mode)
    await collect_telemetry_cycle(new_mode)
    return JSONResponse(content={"status": "ok", "comm_mode": new_mode}, headers={"Cache-Control": "no-store"})


@router.get(
    "/system/backup",
    responses={
        200: {"content": {"application/zip": {}}},
    },
)
async def api_system_backup_download():
    """Télécharge une sauvegarde ZIP atomique complète (bases SQLite, .secret.key et état Matter)."""
    zip_bytes = await asyncio.to_thread(create_backup_zip_bytes)
    active_mode = await asyncio.to_thread(get_active_mode)
    db_log("INFO", "BACKUP", f"Export sauvegarde complète généré ({len(zip_bytes)} octets).", active_mode)
    add_container_log("INFO", "BACKUP", f"Export sauvegarde complète généré ({len(zip_bytes)} octets).")
    filename = f"stove_cockpit_backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}.zip"
    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )


@router.post(
    "/system/backup/restore",
    responses={
        400: {"description": "Archive ZIP invalide ou rejetée"},
        413: {"description": "Archive trop volumineuse"},
    },
)
async def api_system_backup_restore(request: Request):
    """Restaure atomiquement une sauvegarde ZIP validée dans DATA_DIR (bases SQLite, .secret.key, Matter)."""
    body = await request.body()
    if len(body) > MAX_BACKUP_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Archive de sauvegarde trop volumineuse (limite 100 Mo).")

    try:
        result = await asyncio.to_thread(restore_backup_zip_bytes, body)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    active_mode = await asyncio.to_thread(get_active_mode)
    msg = f"Restauration sauvegarde ZIP effectuée ({result['restored_count']} fichier(s))."
    db_log("WARNING", "BACKUP", msg, active_mode)
    add_container_log("WARNING", "BACKUP", msg)
    return result


@router.post("/system/restart")
async def api_system_restart():
    """Déclenche un redémarrage propre du backend (relancé automatiquement par Docker)."""
    import routers.system as _sys_facade

    active_mode = get_active_mode()
    db_log("COMMAND", "SYSTEM", "Redémarrage du backend demandé depuis l'interface.", active_mode)
    add_container_log("WARNING", "SYSTEM", "Redémarrage du backend demandé depuis l'interface.")
    spawn_background_task(_sys_facade._delayed_process_restart(0.5))
    return {"status": "ok", "message": "Redémarrage du backend déclenché. Reconnexion en cours..."}


async def _trigger_watchtower_update(watchtower_url: str, active_mode: str) -> dict[str, str]:
    import routers.system as _sys_facade

    watchtower_token = os.environ.get("WATCHTOWER_HTTP_API_TOKEN", "").strip()
    headers = {"Authorization": f"Bearer {watchtower_token}"} if watchtower_token else {}
    add_container_log("INFO", "WATCHTOWER", f"Vérification de mise à jour demandée ({watchtower_url}).")
    try:
        async with _sys_facade.borrow_http_client(timeout=15.0) as client:
            resp = await client.post(watchtower_url, headers=headers)
        if 200 <= resp.status_code < 300:
            db_log("INFO", "WATCHTOWER", "Vérification de mise à jour Watchtower déclenchée avec succès.", active_mode)
            add_container_log("INFO", "WATCHTOWER", "Vérification de mise à jour Watchtower déclenchée avec succès.")
            return {
                "status": "ok",
                "message": "Vérification de mise à jour Watchtower déclenchée avec succès.",
            }
        err_detail = f"Watchtower a répondu HTTP {resp.status_code} : {resp.text[:200]}"
        db_log("WARNING", "WATCHTOWER", err_detail, active_mode)
        add_container_log("WARNING", "WATCHTOWER", err_detail)
        raise HTTPException(status_code=502, detail=err_detail)
    except httpx.RequestError as exc:
        err_detail = f"Impossible de joindre Watchtower ({watchtower_url}) : {exc}"
        db_log("WARNING", "WATCHTOWER", err_detail, active_mode)
        add_container_log("WARNING", "WATCHTOWER", err_detail)
        raise HTTPException(status_code=502, detail=err_detail) from exc


@router.get("/system/update/status")
async def api_system_update_status():
    """Retourne l'état du système de mise à jour interne au conteneur."""
    return await asyncio.to_thread(get_update_status)


@router.post(
    "/system/update/check",
    responses={
        400: {"description": "Canal de mise à jour invalide"},
        502: {"description": "GitHub API inaccessible ou en erreur"},
    },
)
async def api_system_update_check(
    payload: Annotated[UpdateCheckPayload | None, Body()] = None,
):
    """Interroge GitHub (sans recréer le conteneur) pour vérifier la disponibilité d'une mise à jour."""
    channel = payload.channel if payload else None
    try:
        res = await check_for_updates(channel=channel)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except UpdateUpstreamError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    active_mode = await asyncio.to_thread(get_active_mode)
    db_log("INFO", "UPDATE", res["message"], active_mode)
    add_container_log("INFO", "UPDATE", res["message"])
    return res


@router.post(
    "/system/update/apply",
    responses={
        400: {"description": "Environnement non supporté ou archive invalide"},
        409: {"description": "Une mise à jour est déjà en cours"},
        502: {"description": "Téléchargement GitHub impossible"},
    },
)
async def api_system_update_apply(
    payload: Annotated[UpdateApplyPayload | None, Body()] = None,
):
    """Télécharge, valide, sauvegarde et applique une mise à jour interne sans perte de /app/data."""
    channel = payload.channel if payload else None
    force = bool(payload.force) if payload else False
    try:
        return await apply_internal_update(channel=channel, force=force)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except UpdateConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except UpdateUpstreamError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post(
    "/system/update/rollback",
    responses={
        400: {"description": "Aucune mise à jour interne active à annuler"},
        409: {"description": "Une opération de mise à jour est déjà en cours"},
    },
)
async def api_system_update_rollback():
    """Bascule vers la version précédente ou l'image Docker d'origine puis redémarre en interne."""
    try:
        return await rollback_internal_update()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except UpdateConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post(
    "/system/update/config",
    responses={
        400: {"description": "Paramètres de mise à jour invalides"},
    },
)
async def api_system_update_config(payload: UpdateConfigPayload):
    """Met à jour le canal et les options d'auto-vérification / auto-installation des MAJ."""
    try:
        await asyncio.to_thread(
            save_update_settings,
            channel=payload.channel,
            auto_check=payload.auto_check,
            auto_apply=payload.auto_apply,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return await asyncio.to_thread(get_update_status)


@router.post(
    "/system/check-update",
    responses={
        502: {"description": "Service de mise à jour injoignable ou en erreur"},
    },
)
async def api_system_check_update():
    """Vérifie les mises à jour via Watchtower si WATCHTOWER_URL est configuré, sinon via GitHub."""
    active_mode = await asyncio.to_thread(get_active_mode)
    env_watchtower_url = os.environ.get("WATCHTOWER_URL", "").strip()
    if env_watchtower_url:
        return await _trigger_watchtower_update(env_watchtower_url, active_mode)
    try:
        res = await check_for_updates()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except UpdateUpstreamError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    db_log("INFO", "UPDATE", res["message"], active_mode)
    add_container_log("INFO", "UPDATE", res["message"])
    return res
