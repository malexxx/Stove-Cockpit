"""
Sous-routeur HTTP pour la sécurité et l'authentification du menu installateur.
Délègue la logique d'authentification et de limitation anti force-brute à services/installer_auth.py.
"""
from fastapi import APIRouter, Request

from schemas import InstallerVerifyPayload
from services.installer_auth import (
    _clean_expired_installer_sessions,
    _failed_auth_attempts,
    _get_client_ip,
    _installer_sessions,
    clear_installer_sessions,
    get_installer_auth_status,
    is_installer_authenticated,
    lock_installer_session,
    require_installer_auth_if_configured,
    verify_installer_password,
)

__all__ = [
    "router",
    "_installer_sessions",
    "_failed_auth_attempts",
    "_clean_expired_installer_sessions",
    "_get_client_ip",
    "is_installer_authenticated",
    "require_installer_auth_if_configured",
    "clear_installer_sessions",
]

router = APIRouter(prefix="/api/installer", tags=["Installer"])


@router.post(
    "/verify",
    responses={
        400: {"description": "Mot de passe non configuré"},
        401: {"description": "Mot de passe Agua Cloud incorrect"},
        429: {"description": "Trop de tentatives échouées"},
    },
)
async def api_installer_verify(payload: InstallerVerifyPayload, request: Request):
    """Vérifie le mot de passe Agua Cloud pour déverrouiller l'accès au menu installateur et registres."""
    return verify_installer_password(payload.password, request)


@router.get("/status")
async def api_installer_status(request: Request):
    """Retourne l'état d'authentification actuel du menu installateur."""
    return get_installer_auth_status(request)


@router.post("/lock")
async def api_installer_lock(request: Request):
    """Verrouille immédiatement la session du menu installateur."""
    return lock_installer_session(request)
