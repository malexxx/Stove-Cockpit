"""
Package clients externes pour Nobis.Supervisor.
Regroupe les validateurs anti-SSRF, le pool HTTPX partagé, les notifications webhook,
la météo Open-Meteo, le client Cloud Agua IOT et la passerelle locale UART/RS485.
"""
from clients.agua_cloud import (
    AguaCloudClient,
    agua_client,
)
from clients.http_pool import (
    borrow_http_client,
    close_http_client,
    init_http_client,
)
from clients.local_gateway import LocalGatewayClient, local_gateway_client
from clients.notifications import NotificationService, notification_service
from clients.security import (
    _FORBIDDEN_HOSTS,
    _is_forbidden_webhook_ip,
    _is_loopback_or_metadata_ip,
    is_safe_gateway_url,
    is_safe_webhook_url,
)
from clients.weather import WeatherService, weather_service

__all__ = [
    "_FORBIDDEN_HOSTS",
    "_is_forbidden_webhook_ip",
    "_is_loopback_or_metadata_ip",
    "is_safe_webhook_url",
    "is_safe_gateway_url",
    "init_http_client",
    "close_http_client",
    "borrow_http_client",
    "NotificationService",
    "notification_service",
    "WeatherService",
    "weather_service",
    "AguaCloudClient",
    "agua_client",
    "LocalGatewayClient",
    "local_gateway_client",
]
