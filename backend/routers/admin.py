"""Sous-routeur d'administration système : redémarrage backend, stockage/sauvegarde ZIP et MAJ interne / Watchtower."""
import asyncio
from datetime import datetime
import os
from typing import Annotated

from fastapi import APIRouter, Body, HTTPException, Request
from fastapi.responses import Response
import httpx
from pydantic import BaseModel, ConfigDict, StrictBool

from database import add_container_log, db_log, get_active_mode
from services.api_token_service import build_pairing_info, rotate_api_token
from services.installer_auth import clear_installer_sessions, require_installer_auth_if_configured
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


@router.get("/system/storage")
async def api_system_storage():
    """Retourne le diagnostic de persistance du dossier DATA_DIR (bind mount, volume nommé, anonyme ou éphémère)."""
    return await asyncio.to_thread(inspect_storage_persistence)


@router.get("/system/pairing-info")
async def api_system_pairing_info(request: Request):
    """Retourne l'URL HTTP et le jeton API pour connecter l'application mobile (Option +)."""
    base_url = str(request.base_url).rstrip("/")
    return await asyncio.to_thread(build_pairing_info, base_url)


@router.post("/system/pairing-token/rotate", responses={403: {"description": "Authentification installateur requise"}})
async def api_system_pairing_token_rotate(request: Request):
    """Régénère le jeton API du conteneur compagnon."""
    require_installer_auth_if_configured(request)
    new_tok = await asyncio.to_thread(rotate_api_token)
    active_mode = await asyncio.to_thread(get_active_mode)
    db_log("WARNING", "SECURITY", "Jeton API du conteneur compagnon régénéré.", active_mode)
    return {"status": "ok", "api_token": new_tok}


@router.get(
    "/system/backup",
    responses={
        200: {"content": {"application/zip": {}}},
        403: {"description": "Authentification installateur requise"},
    },
)
async def api_system_backup_download(request: Request):
    """Télécharge une sauvegarde ZIP atomique complète (bases SQLite, .secret.key, certificats TLS et Matter)."""
    require_installer_auth_if_configured(request)
    zip_bytes = await asyncio.to_thread(create_backup_zip_bytes)
    active_mode = await asyncio.to_thread(get_active_mode)
    db_log("INFO", "BACKUP", f"Export sauvegarde complète généré ({len(zip_bytes)} octets).", active_mode)
    add_container_log("INFO", "BACKUP", f"Export sauvegarde complète généré ({len(zip_bytes)} octets).")
    filename = f"nobis_supervisor_backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}.zip"
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
        403: {"description": "Authentification installateur requise"},
        413: {"description": "Archive trop volumineuse"},
    },
)
async def api_system_backup_restore(request: Request):
    """Restaure atomiquement une sauvegarde ZIP validée dans DATA_DIR (bases SQLite, .secret.key, certs, Matter)."""
    require_installer_auth_if_configured(request)
    body = await request.body()
    if len(body) > MAX_BACKUP_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Archive de sauvegarde trop volumineuse (limite 100 Mo).")

    try:
        result = await asyncio.to_thread(restore_backup_zip_bytes, body)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if "nobis_a10_system.db" in result.get("restored_files", []):
        clear_installer_sessions()

    active_mode = await asyncio.to_thread(get_active_mode)
    msg = f"Restauration sauvegarde ZIP effectuée ({result['restored_count']} fichier(s))."
    db_log("WARNING", "BACKUP", msg, active_mode)
    add_container_log("WARNING", "BACKUP", msg)
    return result


@router.post("/system/restart", responses={403: {"description": "Authentification installateur requise"}})
async def api_system_restart(request: Request):
    """Déclenche un redémarrage propre du backend (relancé automatiquement par Docker)."""
    import routers.system as _sys_facade

    require_installer_auth_if_configured(request)
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
        403: {"description": "Authentification installateur requise"},
        502: {"description": "GitHub API inaccessible ou en erreur"},
    },
)
async def api_system_update_check(
    request: Request,
    payload: Annotated[UpdateCheckPayload | None, Body()] = None,
):
    """Interroge GitHub (sans recréer le conteneur) pour vérifier la disponibilité d'une mise à jour."""
    require_installer_auth_if_configured(request)
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
        403: {"description": "Authentification installateur requise"},
        409: {"description": "Une mise à jour est déjà en cours"},
        502: {"description": "Téléchargement GitHub impossible"},
    },
)
async def api_system_update_apply(
    request: Request,
    payload: Annotated[UpdateApplyPayload | None, Body()] = None,
):
    """Télécharge, valide, sauvegarde et applique une mise à jour interne sans perte de /app/data."""
    require_installer_auth_if_configured(request)
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
        403: {"description": "Authentification installateur requise"},
        409: {"description": "Une opération de mise à jour est déjà en cours"},
    },
)
async def api_system_update_rollback(request: Request):
    """Bascule vers la version précédente ou l'image Docker d'origine puis redémarre en interne."""
    require_installer_auth_if_configured(request)
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
        403: {"description": "Authentification installateur requise"},
    },
)
async def api_system_update_config(request: Request, payload: UpdateConfigPayload):
    """Met à jour le canal et les options d'auto-vérification / auto-installation des MAJ."""
    require_installer_auth_if_configured(request)
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
        403: {"description": "Authentification installateur requise"},
        502: {"description": "Service de mise à jour injoignable ou en erreur"},
    },
)
async def api_system_check_update(request: Request):
    """Vérifie les mises à jour via Watchtower si WATCHTOWER_URL est configuré, sinon via GitHub."""
    require_installer_auth_if_configured(request)
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
