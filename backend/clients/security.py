"""Validation anti-SSRF pour les URLs de webhooks, notifications et passerelles UART LAN."""
import ipaddress
import socket
from typing import Any
from urllib.parse import urlparse

_FORBIDDEN_HOSTS = {
    "127.0.0.1", "localhost", "localhost.localdomain", "::1", "0.0.0.0", "0",
    "169.254.169.254", "metadata.google.internal", "broadcasthost",
}


def _is_forbidden_webhook_ip(ip_obj: ipaddress._BaseAddress) -> bool:
    """Retourne True si l'adresse IP appartient à un réseau local, privé, loopback ou réservé."""
    mapped = getattr(ip_obj, "ipv4_mapped", None)
    if mapped is not None and _is_forbidden_webhook_ip(mapped):
        return True
    return bool(
        ip_obj.is_private
        or ip_obj.is_loopback
        or ip_obj.is_link_local
        or ip_obj.is_multicast
        or ip_obj.is_reserved
        or ip_obj.is_unspecified
    )


def _is_loopback_or_metadata_ip(ip_obj: ipaddress._BaseAddress) -> bool:
    """Retourne True si l'IP cible loopback, link-local (metadata), multicast ou unspecified."""
    mapped = getattr(ip_obj, "ipv4_mapped", None)
    if mapped is not None and _is_loopback_or_metadata_ip(mapped):
        return True
    return bool(
        ip_obj.is_loopback
        or ip_obj.is_link_local
        or ip_obj.is_multicast
        or ip_obj.is_unspecified
    )


def _extract_safe_parsed_host(url: str, *, block_dot_local: bool) -> tuple[Any, str] | None:
    """Parse et valide schéma HTTP(S) et nom d'hôte non réservé."""
    if not url or not isinstance(url, str):
        return None
    parsed = urlparse(url.strip())
    if parsed.scheme not in ("http", "https"):
        return None
    hostname = (parsed.hostname or "").lower().strip().rstrip(".")
    forbidden_suffixes = (".internal", ".localhost", ".localdomain") + ((".local",) if block_dot_local else ())
    if (
        not hostname
        or hostname in _FORBIDDEN_HOSTS
        or hostname.startswith("127.")
        or hostname.endswith(forbidden_suffixes)
        or "127.0.0.1" in hostname
    ):
        return None
    return parsed, hostname


def _check_literal_ip(hostname: str, forbidden_fn) -> bool | None:
    """Retourne True/False si hostname est une IP littérale, sinon None."""
    try:
        ip_obj = ipaddress.ip_address(hostname)
    except ValueError:
        return None
    return not forbidden_fn(ip_obj)


def _all_dns_ips_allowed(hostname: str, forbidden_fn) -> bool | None:
    """Résout le DNS et vérifie chaque IP. Retourne None si la résolution échoue (gaierror)."""
    try:
        infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror:
        return None
    if not infos:
        return False
    for info in infos:
        raw_addr = str(info[4][0]).split("%")[0]
        if forbidden_fn(ipaddress.ip_address(raw_addr)):
            return False
    return True


def is_safe_webhook_url(url: str) -> bool:
    """Vérifie qu'une URL de webhook est sûre et ne tente pas un SSRF (loopback, IPv6 mappé, RFC1918, métadonnées)."""
    try:
        parsed_host = _extract_safe_parsed_host(url, block_dot_local=True)
        if not parsed_host:
            return False
        _, hostname = parsed_host

        literal_ok = _check_literal_ip(hostname, _is_forbidden_webhook_ip)
        if literal_ok is not None:
            return literal_ok

        dns_ok = _all_dns_ips_allowed(hostname, _is_forbidden_webhook_ip)
        if dns_ok is not None:
            return dns_ok

        # Environnement hors-ligne ou test unitaire : refuser les hôtes mono-label / numériques ambigus
        stripped = hostname.replace(".", "")
        return "." in hostname and not stripped.isdigit() and not stripped.startswith("0x")
    except Exception:
        return False


def is_safe_gateway_url(url: str) -> bool:
    """Vérifie qu'une URL de passerelle UART LAN est sûre (autorise LAN privé, bloque loopback/metadata/ports internes)."""
    try:
        parsed_host = _extract_safe_parsed_host(url, block_dot_local=False)
        if not parsed_host:
            return False
        parsed, hostname = parsed_host
        try:
            port = parsed.port
        except ValueError:
            return False
        if port in (5549, 8080, 1220, 1221):
            return False

        literal_ok = _check_literal_ip(hostname, _is_loopback_or_metadata_ip)
        if literal_ok is not None:
            return literal_ok

        dns_ok = _all_dns_ips_allowed(hostname, _is_loopback_or_metadata_ip)
        return True if dns_ok is None else dns_ok
    except Exception:
        return False
