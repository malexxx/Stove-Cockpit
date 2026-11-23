"""
Façade agrégatrice de rétro-compatibilité pour les sous-routeurs système :
- routers/snapshots.py (snapshots de registres)
- routers/observability.py (audit, logs, exports CSV)
- routers/settings.py (configuration, diagnostics, géocodage)
- routers/admin.py (redémarrage backend, Watchtower / Git)
"""
from fastapi import APIRouter

from clients import borrow_http_client
from routers.admin import router as admin_router
from routers.observability import router as observability_router, sanitize_csv_cell
from routers.settings import _SENSITIVE_SETTINGS, router as settings_router
from routers.snapshots import router as snapshots_router
from services.lifecycle import delayed_process_restart as _delayed_process_restart

router = APIRouter()
router.include_router(snapshots_router)
router.include_router(observability_router)
router.include_router(settings_router)
router.include_router(admin_router)

__all__ = [
    "router",
    "_SENSITIVE_SETTINGS",
    "_delayed_process_restart",
    "borrow_http_client",
    "sanitize_csv_cell",
]
