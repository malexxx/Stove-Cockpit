"""Résolution fiable de l'adresse IP client derrière un reverse-proxy de confiance."""
import ipaddress
import os

from fastapi import Request


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
