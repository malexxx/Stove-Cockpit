"""Pool de connexions HTTPX asynchrone partagé sur le lifespan FastAPI."""
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx

_shared_http_client: httpx.AsyncClient | None = None


async def init_http_client() -> None:
    """Initialise le client HTTPX asynchrone partagé (keep-alive pool) au démarrage."""
    global _shared_http_client
    if _shared_http_client is None or _shared_http_client.is_closed:
        _shared_http_client = httpx.AsyncClient(
            timeout=25.0,
            limits=httpx.Limits(max_keepalive_connections=10, max_connections=20),
        )


async def close_http_client() -> None:
    """Ferme proprement le client HTTPX partagé lors de l'arrêt du serveur."""
    global _shared_http_client
    if _shared_http_client is not None and not _shared_http_client.is_closed:
        await _shared_http_client.aclose()
    _shared_http_client = None


@asynccontextmanager
async def borrow_http_client(timeout: float = 5.0) -> AsyncIterator[httpx.AsyncClient]:
    """Réutilise le client HTTP partagé (connection pooling) ou en crée un temporaire hors lifespan."""
    if _shared_http_client is not None and not _shared_http_client.is_closed:
        yield _shared_http_client
    else:
        async with httpx.AsyncClient(timeout=timeout) as temp_client:
            yield temp_client
