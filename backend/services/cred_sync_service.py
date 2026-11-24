"""Synchronisation chiffrée AES-256-GCM des identifiants Cloud entre application et conteneur."""
import base64
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

CRED_SYNC_AAD = b"stove-cockpit-cred-v1"

SYNCABLE_CLOUD_KEYS: tuple[str, ...] = (
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
    "stove_name",
    "hopper_capacity_kg",
    "weather_city",
    "weather_lat",
    "weather_lon",
)

_ticket_lock = threading.Lock()
_sync_tickets: dict[str, float] = {}


def _purge_expired_tickets_locked(now_ts: float) -> None:
    for tok in [k for k, exp in _sync_tickets.items() if exp <= now_ts]:
        _sync_tickets.pop(tok, None)


def create_sync_ticket(ttl_seconds: int = 300) -> dict[str, Any]:
    """Génère un ticket éphémère à usage unique pour transfert chiffré via QR Code."""
    now_ts = time.time()
    tok = secrets.token_urlsafe(24)
    with _ticket_lock:
        _purge_expired_tickets_locked(now_ts)
        _sync_tickets[tok] = now_ts + max(30, int(ttl_seconds))
    return {"sync_ticket": tok, "expires_in": max(30, int(ttl_seconds))}


def consume_sync_ticket(candidate: str | None) -> bool:
    """Vérifie et consomme atomiquement un ticket éphémère de synchronisation."""
    if not candidate or not str(candidate).strip():
        return False
    cand = str(candidate).strip()
    now_ts = time.time()
    with _ticket_lock:
        _purge_expired_tickets_locked(now_ts)
        matched_key = None
        for active_key in _sync_tickets:
            if hmac.compare_digest(cand, active_key):
                matched_key = active_key
                break
        if matched_key is None:
            return False
        _sync_tickets.pop(matched_key, None)
        return True


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64url_decode(encoded: str) -> bytes:
    s = str(encoded or "").strip()
    pad = "=" * ((4 - len(s) % 4) % 4)
    return base64.urlsafe_b64decode(s + pad)


def derive_sync_key(api_token: str, auth_proof: str = "") -> bytes:
    """Dérive une clé AES-256 à partir du jeton API du conteneur et de la preuve d'autorisation."""
    material = f"stove-cockpit-cred-sync-v1:{str(api_token or '').strip()}:{str(auth_proof or '').strip()}"
    return hashlib.sha256(material.encode("utf-8")).digest()


def encrypt_cred_envelope(credentials: dict[str, Any], api_token: str, auth_proof: str = "") -> dict[str, Any]:
    """Chiffre un dictionnaire d'identifiants Cloud dans une enveloppe AES-256-GCM horodatée."""
    clean_creds = {
        k: str(credentials[k])
        for k in SYNCABLE_CLOUD_KEYS
        if k in credentials and credentials[k] not in (None, "")
    }
    iv = os.urandom(12)
    plaintext = json.dumps({"ts": int(time.time()), "credentials": clean_creds}, separators=(",", ":")).encode("utf-8")
    ct = AESGCM(derive_sync_key(api_token, auth_proof)).encrypt(iv, plaintext, CRED_SYNC_AAD)
    return {"v": 1, "iv": _b64url_encode(iv), "ct": _b64url_encode(ct)}


def decrypt_cred_envelope(
    envelope: dict[str, Any],
    api_token: str,
    auth_proof: str = "",
    max_skew_s: int = 300,
) -> dict[str, str]:
    """Déchiffre et valide l'authenticité et la fraîcheur d'une enveloppe AES-256-GCM."""
    if not isinstance(envelope, dict) or int(envelope.get("v") or 0) != 1:
        raise ValueError("Version d'enveloppe chiffrée non supportée.")
    try:
        iv = _b64url_decode(envelope.get("iv") or "")
        ct = _b64url_decode(envelope.get("ct") or "")
    except Exception as exc:
        raise ValueError("Encodage Base64URL invalide.") from exc

    if len(iv) != 12 or not ct:
        raise ValueError("Vecteur d'initialisation ou texte chiffré invalide.")

    try:
        raw_plain = AESGCM(derive_sync_key(api_token, auth_proof)).decrypt(iv, ct, CRED_SYNC_AAD)
        obj = json.loads(raw_plain.decode("utf-8"))
    except Exception as exc:
        raise ValueError("Échec de déchiffrement ou d'authentification de l'enveloppe.") from exc

    if not isinstance(obj, dict) or "ts" not in obj or not isinstance(obj.get("credentials"), dict):
        raise ValueError("Structure interne de l'enveloppe invalide.")

    ts = int(obj["ts"])
    if abs(time.time() - ts) > max_skew_s:
        raise ValueError("Enveloppe expirée (fenêtre anti-rejeu dépassée).")

    raw_creds = obj["credentials"]
    return {
        k: str(raw_creds[k])
        for k in SYNCABLE_CLOUD_KEYS
        if k in raw_creds and raw_creds[k] not in (None, "")
    }
