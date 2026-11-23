"""Middlewares de sécurité HTTP (CORS Capacitor/LAN, auth X-API-Key/Bearer, CSP, GZip hors SSE)."""
import os
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Request
from fastapi.openapi.utils import get_openapi
from fastapi.responses import JSONResponse, Response
from starlette.middleware.gzip import GZipMiddleware
from starlette.types import ASGIApp, Receive, Scope, Send

from database import db_log, get_active_mode
from services.api_token_service import verify_api_token

_routes_cache: list[tuple] = []

_DEFAULT_CORS_ORIGINS = {
    "capacitor://localhost",
    "ionic://localhost",
    "http://localhost",
    "https://localhost",
}

_PUBLIC_API_PATHS = {
    "/api/brands",
    "/api/matter/webhook",
}


class SelectiveGZipMiddleware:
    """Compression HTTP GZip (>= 512 o) contournant explicitement le flux SSE /api/events."""

    def __init__(self, app: ASGIApp, minimum_size: int = 512, compresslevel: int = 6) -> None:
        self.app = app
        self._gzip = GZipMiddleware(app, minimum_size=minimum_size, compresslevel=compresslevel)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Applique GZip sauf sur /api/events et requêtes Accept: text/event-stream."""
        if scope["type"] == "http":
            path = scope.get("path", "")
            accept = next(
                (v.decode("latin-1", errors="ignore").lower() for k, v in scope.get("headers", ()) if k.lower() == b"accept"),
                "",
            )
            if path == "/api/events" or "text/event-stream" in accept:
                await self.app(scope, receive, send)
                return
            await self._gzip(scope, receive, send)
            return
        await self.app(scope, receive, send)


_CSP_POLICY = (
    "default-src 'self'; "
    "script-src 'self' 'unsafe-inline'; "
    "script-src-elem 'self'; "
    "script-src-attr 'unsafe-inline'; "
    "style-src 'self' 'unsafe-inline'; "
    "font-src 'self' data:; "
    "img-src 'self' data: blob: https:; "
    "connect-src 'self' ws: wss: http: https:; "
    "object-src 'none'; "
    "base-uri 'self'; "
    "frame-ancestors 'self';"
)


def _extract_api_token(request: Request) -> str:
    api_key = (request.headers.get("x-api-key") or "").strip()
    if api_key:
        return api_key
    auth_hdr = (request.headers.get("authorization") or "").strip()
    if auth_hdr.lower().startswith("bearer "):
        return auth_hdr[7:].strip()
    q_tok = (request.query_params.get("token") or "").strip()
    if q_tok:
        return q_tok
    return ""


def _is_origin_allowed(origin: str) -> bool:
    if not origin or origin == "null":
        return False
    low = origin.strip().lower()
    if low in _DEFAULT_CORS_ORIGINS:
        return True
    parsed = urlparse(low)
    if parsed.hostname in ("localhost", "127.0.0.1"):
        return True
    extra = os.environ.get("STOVE_CORS_ORIGINS", "") or os.environ.get("NOBIS_CORS_ORIGINS", "")
    allowed_extra = {o.strip().lower().rstrip("/") for o in extra.split(",") if o.strip()}
    return low.rstrip("/") in allowed_extra


def _resolve_cors_allow_origin(request: Request, has_valid_token: bool) -> str | None:
    origin = (request.headers.get("origin") or "").strip()
    if not origin or origin == "null":
        return None
    if _is_origin_allowed(origin) or has_valid_token:
        return origin
    return None


def _get_allowed_methods_for_path(app: FastAPI, path: str) -> set[str]:
    global _routes_cache
    if not _routes_cache:
        def _collect(router):
            for route in router.routes:
                if hasattr(route, "routes"):
                    _collect(route)
                elif hasattr(route, "original_router"):
                    _collect(route.original_router)
                elif hasattr(route, "path_regex") and hasattr(route, "methods"):
                    _routes_cache.append((route.path_regex, route.methods))

        _collect(app)

    methods: set[str] = set()
    for regex, r_methods in _routes_cache:
        if regex.match(path):
            methods.update(r_methods)
    return methods


def _check_api_auth_and_csrf(request: Request) -> JSONResponse | None:
    """Protège /api/* contre CSRF et exige X-API-Key/Bearer pour les clients cross-origin (mobile Mode +)."""
    path = request.url.path
    if not path.startswith("/api/"):
        return None

    # 1. Blocage CSRF sur types de formulaires non JSON
    if request.method in ("POST", "PUT", "DELETE", "PATCH") and path != "/api/matter/webhook":
        ctype = (request.headers.get("content-type") or "").lower()
        if ctype.startswith(("application/x-www-form-urlencoded", "multipart/form-data", "text/plain")):
            return JSONResponse(
                status_code=403,
                content={"detail": "Type de contenu de formulaire refusé (protection anti-CSRF)."},
            )

    if path in _PUBLIC_API_PATHS:
        return None

    origin = (request.headers.get("origin") or "").strip()
    if origin == "null":
        return JSONResponse(
            status_code=403,
            content={"detail": "Origine Cross-Origin nulle refusée."},
        )

    orig_host = urlparse(origin).netloc.lower() if origin else ""
    req_host = (request.headers.get("host") or "").lower()
    is_cross_origin = bool(origin and req_host and orig_host != req_host)
    require_always = os.environ.get("STOVE_REQUIRE_API_TOKEN", "").strip().lower() in ("1", "true", "yes")

    token = _extract_api_token(request)
    if is_cross_origin or require_always or bool(token):
        if not verify_api_token(token):
            headers = {}
            if origin and _is_origin_allowed(origin):
                headers["Access-Control-Allow-Origin"] = origin
                headers["Vary"] = "Origin"
            return JSONResponse(
                status_code=401,
                content={"detail": "Jeton API requis ou invalide (X-API-Key / Bearer)."},
                headers=headers,
            )
    return None


def _apply_security_headers(request: Request, response: Response) -> None:
    """Applique les en-têtes HTTP de sécurité (CSP, CORS, anti-sniff, cache statique)."""
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Content-Security-Policy"] = _CSP_POLICY

    token = _extract_api_token(request)
    cors_origin = _resolve_cors_allow_origin(request, verify_api_token(token) if token else False)
    if cors_origin:
        response.headers["Access-Control-Allow-Origin"] = cors_origin
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-API-Key, X-Installer-Token"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
        response.headers["Vary"] = "Origin"

    if request.url.path.startswith(("/static/", "/assets/")):
        if request.query_params.get("v") or request.url.path.startswith("/assets/"):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            response.headers["Cache-Control"] = "public, max-age=3600, must-revalidate"


def _build_options_response(app: FastAPI, request: Request) -> Response | None:
    path = request.url.path
    allowed = _get_allowed_methods_for_path(app, path)
    if not allowed and not path.startswith("/api/"):
        return None
    allow_str = ", ".join(sorted(allowed or {"GET", "POST", "PUT", "DELETE", "OPTIONS"}))
    headers = {
        "Allow": allow_str,
        "Access-Control-Allow-Methods": allow_str,
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, X-Installer-Token",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "SAMEORIGIN",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    }
    origin = (request.headers.get("origin") or "").strip()
    if origin and origin != "null":
        headers["Access-Control-Allow-Origin"] = origin if _is_origin_allowed(origin) else "*"
        headers["Vary"] = "Origin"
    return Response(status_code=200, headers=headers)


async def _handle_global_exception(request: Request, exc: Exception) -> JSONResponse:
    active_mode = get_active_mode()
    err_msg = f"{request.method} {request.url.path} -> {type(exc).__name__}: {str(exc)}"
    db_log("ERROR", "API", err_msg, active_mode)
    if isinstance(exc, OverflowError) or "too large to convert to SQLite" in str(exc):
        return JSONResponse(
            status_code=422,
            content={"detail": [{"loc": ["body"], "msg": "Entier hors limites pour SQLite", "type": "overflow_error"}]},
        )
    return JSONResponse(status_code=500, content={"detail": f"Erreur interne : {str(exc)}"})


async def _handle_http_exception(request: Request, exc: HTTPException) -> JSONResponse:
    active_mode = get_active_mode()
    severity = "ERROR" if exc.status_code >= 400 else "WARNING"
    db_log(severity, "API", f"{request.method} {request.url.path} [{exc.status_code}] : {exc.detail}", active_mode)
    if exc.status_code == 400 and ("parsing the body" in str(exc.detail) or "JSONDecodeError" in str(exc.detail)):
        return JSONResponse(
            status_code=422,
            content={"detail": [{"loc": ["body"], "msg": "Erreur décodage JSON", "type": "value_error.jsondecode"}]},
        )
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


def _build_custom_openapi(app: FastAPI):
    def custom_openapi():
        """Génère le schéma OpenAPI enrichi des réponses 400 standardisées."""
        if app.openapi_schema:
            return app.openapi_schema
        openapi_schema = get_openapi(
            title=app.title,
            version=app.version,
            openapi_version=app.openapi_version,
            description=app.description,
            routes=app.routes,
        )
        for path_item in openapi_schema.get("paths", {}).values():
            for method, op in path_item.items():
                if method.lower() in ("get", "post", "put", "delete", "patch") and "responses" in op:
                    op["responses"].setdefault("400", {"description": "Bad Request / Requête invalide"})
        app.openapi_schema = openapi_schema
        return app.openapi_schema

    return custom_openapi


def register_security_and_error_handlers(app: FastAPI) -> None:
    """Enregistre les exception handlers, GZip sélectif hors SSE, middleware CORS/API-Key et OpenAPI."""
    app.add_exception_handler(Exception, _handle_global_exception)
    app.add_exception_handler(HTTPException, _handle_http_exception)
    app.add_middleware(SelectiveGZipMiddleware, minimum_size=512, compresslevel=6)

    @app.middleware("http")
    async def security_headers_middleware(request: Request, call_next):
        """Gère OPTIONS/CORS, contrôle API Token/CSRF, en-tête Allow sur 405 et en-têtes de sécurité."""
        if request.method == "OPTIONS":
            opt_resp = _build_options_response(app, request)
            if opt_resp is not None:
                return opt_resp

        auth_err = _check_api_auth_and_csrf(request)
        if auth_err is not None:
            return auth_err

        response = await call_next(request)
        if response.status_code == 405:
            allowed = _get_allowed_methods_for_path(app, request.url.path)
            if allowed:
                response.headers["Allow"] = ", ".join(sorted(allowed))

        _apply_security_headers(request, response)
        return response

    app.openapi = _build_custom_openapi(app)
