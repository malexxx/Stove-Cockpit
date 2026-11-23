"""
Service de sécurité et d'authentification du menu installateur.
Protège l'accès aux opérations privilégiées via mot de passe Agua Cloud, sessions à jetons éphémères,
comparaison à temps constant (anti-timing attacks) et limitation anti force-brute.
"""
import hmac
import ipaddress
import os
import secrets
import time
from typing import Any

from fastapi import HTTPException, Request

from database import db_log, get_active_mode, get_settings_dict

_installer_sessions: dict[str, float] = {}  # token -> expires_at
_failed_auth_attempts: dict[str, list[float]] = {}  # ip -> timestamps


def _is_trusted_proxy_host(host: str) -> bool:
    """Retourne True uniquement si l'hôte peer correspond aux proxys de confiance (TRUSTED_PROXY_IPS)."""
    if not host:
        return False
    raw = os.environ.get("TRUSTED_PROXY_IPS", "127.0.0.1,::1,localhost")
    entries = [item.strip() for item in raw.split(",") if item.strip()]
    if host in entries:
        return True
    try:
        peer_ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    for entry in entries:
        if entry == "localhost":
            continue
        try:
            if "/" in entry:
                if peer_ip in ipaddress.ip_network(entry, strict=False):
                    return True
            elif peer_ip == ipaddress.ip_address(entry):
                return True
        except ValueError:
            continue
    return False


def _clean_expired_installer_sessions() -> None:
    """Purge de la mémoire les jetons de session installateur expirés et les tentatives anciennes."""
    now_ts = time.time()
    for tok in list(_installer_sessions.keys()):
        if _installer_sessions[tok] <= now_ts:
            _installer_sessions.pop(tok, None)
    for ip in list(_failed_auth_attempts.keys()):
        valid = [t for t in _failed_auth_attempts[ip] if now_ts - t < 60.0]
        if valid:
            _failed_auth_attempts[ip] = valid
        else:
            _failed_auth_attempts.pop(ip, None)


def _get_client_ip(request: Request) -> str:
    """Identifie l'IP réelle du client en ne faisant confiance aux en-têtes proxy qu'en provenance de TRUSTED_PROXY_IPS."""
    host = request.client.host if request.client else "unknown"
    if _is_trusted_proxy_host(host):
        xff = request.headers.get("X-Forwarded-For", "").split(",")[0].strip()
        if xff:
            return xff
        xri = request.headers.get("X-Real-IP", "").strip()
        if xri:
            return xri
    return host


def is_installer_authenticated(request: Request) -> bool:
    """Vérifie si la requête HTTP contient un en-tête X-Installer-Token valide et non expiré."""
    _clean_expired_installer_sessions()
    tok = request.headers.get("X-Installer-Token", "").strip()
    return bool(tok and tok in _installer_sessions and _installer_sessions[tok] > time.time())


def require_installer_auth_if_configured(request: Request) -> None:
    """Exige un jeton installateur valide si un mot de passe Agua Cloud est configuré en base."""
    pwd = (get_settings_dict().get("agua_password") or "").strip()
    if not pwd:
        return None
    if not is_installer_authenticated(request):
        raise HTTPException(
            status_code=403,
            detail="Authentification installateur requise (jeton X-Installer-Token manquant ou expiré).",
        )


def clear_installer_sessions() -> None:
    """Réinitialise toutes les sessions installateur actives (ex: changement de mot de passe)."""
    _installer_sessions.clear()


def verify_installer_password(password: str, request: Request) -> dict[str, Any]:
    """Vérifie le mot de passe Agua Cloud et crée un jeton éphémère de session installateur (2h)."""
    client_ip = _get_client_ip(request)
    now_ts = time.time()
    _clean_expired_installer_sessions()

    attempts = [t for t in _failed_auth_attempts.get(client_ip, []) if now_ts - t < 60.0]
    if len(attempts) >= 5:
        db_log(
            "WARNING",
            "SECURITY",
            f"Blocage anti force-brute accès installateur déclenché pour l'IP {client_ip}.",
            get_active_mode(),
        )
        raise HTTPException(
            status_code=429,
            detail="Trop de tentatives erronées. Veuillez patienter 60 secondes avant de réessayer.",
        )

    settings = get_settings_dict()
    stored_pwd = (settings.get("agua_password") or "").strip()
    active_mode = get_active_mode()

    if not stored_pwd:
        db_log(
            "WARNING",
            "SECURITY",
            "Tentative d'accès installateur rejetée : aucun mot de passe Agua Cloud configuré.",
            active_mode,
        )
        raise HTTPException(
            status_code=401,
            detail="Aucun mot de passe Agua Cloud n'est configuré dans les réglages. Veuillez d'abord le renseigner.",
        )

    submitted_bytes = password.strip().encode("utf-8")
    stored_bytes = stored_pwd.encode("utf-8")
    if not hmac.compare_digest(submitted_bytes, stored_bytes):
        attempts.append(now_ts)
        _failed_auth_attempts[client_ip] = attempts
        db_log(
            "WARNING",
            "SECURITY",
            f"Échec d'authentification installateur depuis {client_ip} : mot de passe incorrect.",
            active_mode,
        )
        raise HTTPException(status_code=401, detail="Mot de passe Agua Cloud incorrect.")

    _failed_auth_attempts.pop(client_ip, None)
    token = secrets.token_hex(24)
    expires_at = now_ts + 7200.0
    _installer_sessions[token] = expires_at

    db_log("INFO", "SECURITY", f"Accès menu installateur déverrouillé avec succès (IP {client_ip}).", active_mode)
    return {
        "status": "ok",
        "success": True,
        "authenticated": True,
        "token": token,
        "expires_in_s": 7200,
    }


def get_installer_auth_status(request: Request) -> dict[str, bool]:
    """Retourne l'état d'authentification actuel du menu installateur."""
    settings = get_settings_dict()
    has_pwd = bool((settings.get("agua_password") or "").strip())
    authenticated = is_installer_authenticated(request)
    return {
        "authenticated": authenticated,
        "has_password_configured": has_pwd,
    }


def lock_installer_session(request: Request) -> dict[str, Any]:
    """Verrouille immédiatement la session du menu installateur."""
    tok = request.headers.get("X-Installer-Token", "").strip()
    if tok:
        _installer_sessions.pop(tok, None)
    active_mode = get_active_mode()
    db_log("INFO", "SECURITY", "Verrouillage manuel du menu installateur.", active_mode)
    return {"status": "ok", "authenticated": False}
