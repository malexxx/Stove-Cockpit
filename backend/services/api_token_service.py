"""Gestion du jeton API du conteneur compagnon (« Mode + ») et génération des infos d'appairage mobile."""
import hmac
import json
import os
import secrets
from typing import Any

from database import encrypt_setting_value, get_settings_dict, get_sys_db

API_TOKEN_SETTING_KEY = "container_api_token"


def get_or_create_api_token() -> str:
    """Retourne le jeton API actif (env STOVE_API_TOKEN/NOBIS_API_TOKEN prioritaire, sinon SQLite chiffré)."""
    env_tok = (os.environ.get("STOVE_API_TOKEN") or os.environ.get("NOBIS_API_TOKEN") or "").strip()
    if env_tok:
        return env_tok

    settings = get_settings_dict()
    existing = str(settings.get(API_TOKEN_SETTING_KEY) or "").strip()
    if existing:
        return existing

    new_tok = secrets.token_urlsafe(32)
    conn = get_sys_db()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
            (API_TOKEN_SETTING_KEY, encrypt_setting_value(API_TOKEN_SETTING_KEY, new_tok)),
        )
        conn.commit()
    finally:
        conn.close()
    return new_tok


def rotate_api_token() -> str:
    """Régénère un nouveau jeton API et le persiste chiffré dans la base système."""
    new_tok = secrets.token_urlsafe(32)
    conn = get_sys_db()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
            (API_TOKEN_SETTING_KEY, encrypt_setting_value(API_TOKEN_SETTING_KEY, new_tok)),
        )
        conn.commit()
    finally:
        conn.close()
    return new_tok


def verify_api_token(candidate: str | None) -> bool:
    """Vérifie en temps constant si `candidate` correspond au jeton API du conteneur."""
    if not candidate:
        return False
    expected = get_or_create_api_token()
    if not expected:
        return False
    return hmac.compare_digest(str(candidate).strip(), expected)


def build_pairing_info(request_base_url: str) -> dict[str, Any]:
    """Construit la charge utile d'appairage mobile pour activer l'Option « + »."""
    clean_url = (request_base_url or "").strip().rstrip("/")
    token = get_or_create_api_token()
    qr_payload = json.dumps(
        {
            "type": "stove-cockpit-plus",
            "version": 1,
            "url": clean_url,
            "token": token,
        },
        separators=(",", ":"),
    )
    return {
        "url": clean_url,
        "api_token": token,
        "qr_payload": qr_payload,
    }
