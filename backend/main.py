"""
Stove Cockpit Server — Point d'entrée principal FastAPI (HTTP pur + Pont Matter + API Compagnon Mode +).
Point d'assemblage léger : cycle de vie (lifespan), middlewares sécurité/CORS et montage des routeurs modulaires.
"""
import asyncio
from contextlib import asynccontextmanager
from datetime import datetime
import os
import sys
import time

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from clients import close_http_client, init_http_client
from config import APP_VERSION, DATA_DIR, DOCKER_VERSION, FRONTEND_DIST_DIR
from database import (
    add_container_log,
    db_log,
    get_active_mode,
    get_settings_dict,
    init_all_databases,
    prune_database_retention,
    seed_simulation_db_if_empty,
)
from matter_service import matter_manager
from middleware.security import register_security_and_error_handlers
from routers.calibration import router as calibration_router
from routers.dashboard import (
    MAX_SSE_SUBSCRIBERS,
    notify_sse_shutdown,
    router as dashboard_router,
    set_shutting_down,
)
from routers.matter import router as matter_router
from routers.silence import router as silence_router
from routers.stove import router as stove_router
from routers.system import router as system_router
from services.api_token_service import get_or_create_api_token
from services.lifecycle import (
    install_windows_proactor_guard,
    prepare_scheduler_for_running_loop,
    scheduler,
)
from services.logging_handlers import attach_logging_handlers
from services.silence_service import (
    _auto_expire_silence_job,
    activate_silence_mode,
    deactivate_silence_mode,
    get_silence_state,
    get_silence_status,
    save_silence_state,
)
from services.storage_service import inspect_storage_persistence
from services.update_bootstrap import mark_active_release_healthy
from services.update_service import scheduled_update_check_job
from telemetry import collect_telemetry_cycle

__all__ = [
    "app",
    "scheduler",
    "MAX_SSE_SUBSCRIBERS",
    "activate_silence_mode",
    "deactivate_silence_mode",
    "get_silence_status",
    "get_silence_state",
    "save_silence_state",
]

install_windows_proactor_guard()
attach_logging_handlers()


def _install_win_loop_exception_filter() -> None:
    if sys.platform != "win32":
        return
    loop = asyncio.get_running_loop()
    orig_handler = loop.get_exception_handler()

    def _win_loop_exc_handler(lp, context):
        exc = context.get("exception")
        if isinstance(exc, ConnectionResetError) and getattr(exc, "winerror", None) == 10054:
            return
        if orig_handler:
            orig_handler(lp, context)
        else:
            lp.default_exception_handler(context)

    loop.set_exception_handler(_win_loop_exc_handler)


async def _restore_or_schedule_silence_on_startup(active_mode: str) -> None:
    st = get_silence_state()
    if not st.get("active"):
        return
    end_ep = float(st.get("end_epoch") or 0.0)
    rem_s = int(end_ep - time.time())
    if rem_s <= 0:
        db_log("INFO", "SILENCE", "Mode Silence ! expiré pendant l'arrêt du superviseur : restauration immédiate.", active_mode)
        try:
            await deactivate_silence_mode(is_auto_expired=True)
        except Exception as e:
            db_log("ERROR", "SILENCE", f"Échec restauration Silence au démarrage: {e}", active_mode)
        return
    end_dt = datetime.fromtimestamp(end_ep)
    scheduler.add_job(
        _auto_expire_silence_job,
        "date",
        run_date=end_dt,
        id="silence_timer_job",
        replace_existing=True,
    )
    db_log(
        "INFO",
        "SILENCE",
        f"Reprise du compte à rebours Silence ! ({rem_s}s restantes jusqu'à {end_dt.strftime('%H:%M:%S')}).",
        active_mode,
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialise les bases, le jeton API, le pool HTTP, APScheduler et le pont Matter puis arrête proprement."""
    set_shutting_down(False)
    _install_win_loop_exception_filter()

    init_all_databases()
    get_or_create_api_token()
    seed_simulation_db_if_empty()
    await init_http_client()

    settings = get_settings_dict()
    try:
        interval_s = max(15, min(3600, int(float(settings.get("poll_interval_s", "120")))))
    except (ValueError, TypeError):
        interval_s = 120

    active_mode = get_active_mode()
    attach_logging_handlers()
    add_container_log(
        "INFO",
        "CONTAINER",
        f"Démarrage Stove Cockpit Server v{APP_VERSION} (mode={active_mode}, docker={DOCKER_VERSION})",
    )
    storage_info = inspect_storage_persistence()
    if storage_info["warning"]:
        add_container_log("WARNING", "STORAGE", storage_info["warning"])
        db_log("WARNING", "STORAGE", storage_info["warning"], active_mode)
    else:
        add_container_log(
            "INFO",
            "STORAGE",
            f"Stockage persistant vérifié ({storage_info['mount_type']} -> {storage_info['data_dir']}).",
        )

    prepare_scheduler_for_running_loop()
    scheduler.add_job(collect_telemetry_cycle, "interval", seconds=interval_s, id="telemetry_job", replace_existing=True)
    scheduler.add_job(prune_database_retention, "interval", hours=12, id="retention_prune_job", replace_existing=True)
    scheduler.add_job(scheduled_update_check_job, "interval", hours=6, id="update_check_job", replace_existing=True)
    scheduler.start()

    if matter_manager.is_enabled():
        await matter_manager.ensure_started()

    try:
        await collect_telemetry_cycle(active_mode)
    except Exception as e:
        db_log("ERROR", "STARTUP", f"Échec première collecte au démarrage : {str(e)}", active_mode)

    await _restore_or_schedule_silence_on_startup(active_mode)

    active_rel_id = os.environ.get("NOBIS_ACTIVE_RELEASE_ID", "").strip()
    if active_rel_id and await asyncio.to_thread(mark_active_release_healthy, DATA_DIR, active_rel_id):
        ok_msg = f"Mise à jour interne {active_rel_id} vérifiée et validée au démarrage."
        add_container_log("INFO", "UPDATE", ok_msg)
        db_log("INFO", "UPDATE", ok_msg, active_mode)

    try:
        yield
    except (asyncio.CancelledError, KeyboardInterrupt):
        pass
    finally:
        notify_sse_shutdown()
        if scheduler.running:
            scheduler.shutdown(wait=False)
        await matter_manager.stop()
        await close_http_client()


app = FastAPI(
    title="Stove Cockpit Server — Supervision Micronova & Pont Matter",
    version=APP_VERSION,
    lifespan=lifespan,
)

register_security_and_error_handlers(app)

app.include_router(silence_router)
app.include_router(matter_router)
app.include_router(calibration_router)
app.include_router(stove_router)
app.include_router(system_router)
app.include_router(dashboard_router)

if os.path.isdir(FRONTEND_DIST_DIR):
    for sub in ("assets", "css", "js", "vendor", "icons", "static"):
        sub_path = os.path.join(FRONTEND_DIST_DIR, sub)
        if os.path.isdir(sub_path):
            app.mount(f"/{sub}", StaticFiles(directory=sub_path), name=f"dist_{sub}")

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8080, reload=True)
