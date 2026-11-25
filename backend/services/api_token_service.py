"""Gestion du jeton API du conteneur compagnon (« Mode + ») et génération des infos d'appairage mobile."""
import hmac
import ipaddress
import json
import os
import secrets
import socket
from typing import Any
from urllib.parse import urlparse

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


def _is_private_or_lan_ipv4(value: str) -> bool:
    """Retourne True si `value` est une adresse IPv4 valide non-loopback et non-non-spécifiée."""
    try:
        ip = ipaddress.ip_address((value or "").strip())
    except ValueError:
        return False
    return isinstance(ip, ipaddress.IPv4Address) and not ip.is_loopback and not ip.is_unspecified


def _detect_lan_ipv4() -> str | None:
    """Détecte l'adresse IPv4 LAN locale sans émettre de paquet réseau."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("10.255.255.255", 1))
        ip = sock.getsockname()[0]
        if ip and not ip.startswith("127."):
            return ip
    except OSError:
        return None
    finally:
        sock.close()
    return None


def _resolve_preferred_lan_ipv4(hostname: str | None) -> str | None:
    """Préfère une IPv4 locale (STOVE_LAN_IP / hôte IP / résolution DNS locale / LAN) à un nom DNS."""
    for env_key in ("STOVE_LAN_IP", "HOST_LAN_IP"):
        env_ip = (os.environ.get(env_key) or "").strip()
        if env_ip and _is_private_or_lan_ipv4(env_ip):
            return env_ip

    clean_host = (hostname or "").strip()
    if clean_host and _is_private_or_lan_ipv4(clean_host):
        return clean_host

    if clean_host and clean_host not in ("localhost", "127.0.0.1", "::1"):
        is_literal_ip = True
        try:
            ipaddress.ip_address(clean_host)
        except ValueError:
            is_literal_ip = False
        if not is_literal_ip:
            try:
                infos = socket.getaddrinfo(clean_host, None, socket.AF_INET)
                for info in infos:
                    cand = info[4][0]
                    ip_obj = ipaddress.ip_address(cand)
                    if isinstance(ip_obj, ipaddress.IPv4Address) and ip_obj.is_private and not ip_obj.is_loopback:
                        return cand
            except OSError:
                pass

    return _detect_lan_ipv4()


def build_pairing_info(request_base_url: str, sync_ticket: str = "") -> dict[str, Any]:
    """Construit la charge utile d'appairage mobile pour activer l'Option « + »."""
    clean_url = (request_base_url or "").strip().rstrip("/")
    effective_url = clean_url
    if clean_url:
        parsed = urlparse(clean_url)
        lan_ip = _resolve_preferred_lan_ipv4(parsed.hostname)
        if lan_ip and lan_ip != parsed.hostname:
            scheme = "http" if parsed.scheme == "https" else (parsed.scheme or "http")
            port_part = f":{parsed.port}" if parsed.port else ""
            effective_url = f"{scheme}://{lan_ip}{port_part}"

    token = get_or_create_api_token()
    qr_obj: dict[str, Any] = {
        "type": "stove-cockpit-plus",
        "version": 1,
        "url": effective_url,
        "token": token,
    }
    clean_ticket = (sync_ticket or "").strip()
    if clean_ticket:
        qr_obj["sync_ticket"] = clean_ticket

    qr_payload = json.dumps(qr_obj, separators=(",", ":"))
    res: dict[str, Any] = {
        "url": effective_url,
        "api_token": token,
        "qr_payload": qr_payload,
    }
    if clean_ticket:
        res["sync_ticket"] = clean_ticket
    return res
