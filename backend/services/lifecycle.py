"""
Gestion du cycle de vie processus, planificateur APScheduler et compatibilité Windows.
Centralise les primitives partagées entre server.py, main.py et les routeurs admin
afin d'éliminer les duplications et inversions de couches.
"""
import asyncio
import logging
import os
import signal
import subprocess
import sys
from typing import Any
from collections.abc import Coroutine

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from services.update_bootstrap import EXIT_CODE_RELOAD

logger = logging.getLogger("nobis.lifecycle")
scheduler = AsyncIOScheduler()
_background_tasks: set[asyncio.Task] = set()
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_reload_requested = False


def request_reload() -> None:
    """Demande la sortie avec code EXIT_CODE_RELOAD (75) pour relance interne par le superviseur."""
    global _reload_requested
    _reload_requested = True


def is_reload_requested() -> bool:
    """Indique si une relance interne par le superviseur a été demandée."""
    return _reload_requested


def reset_reload_requested() -> None:
    """Réinitialise le drapeau de relance interne (utile dans les tests)."""
    global _reload_requested
    _reload_requested = False


def prepare_scheduler_for_running_loop() -> None:
    """Rattache APScheduler à l'event loop courante avant start() (évite RuntimeError sur ré-entrée lifespan)."""
    if scheduler.running:
        return
    try:
        scheduler._eventloop = asyncio.get_running_loop()
    except RuntimeError:
        pass


def spawn_background_task(coro: Coroutine[Any, Any, Any]) -> asyncio.Task:
    """Lance une tâche asyncio en conservant une référence forte jusqu'à sa fin (évite RUF006/GC)."""
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return task


def install_windows_proactor_guard() -> None:
    """Ignore le bruit bénin WinError 10054 lors de la fermeture de sockets sous Windows (ProactorEventLoop)."""
    if sys.platform != "win32":
        return
    try:
        from asyncio.proactor_events import _ProactorBasePipeTransport

        if not getattr(_ProactorBasePipeTransport._call_connection_lost, "_nobis_patched", False):
            orig = _ProactorBasePipeTransport._call_connection_lost

            def _safe_call_connection_lost(self, exc):
                try:
                    orig(self, exc)
                except ConnectionResetError:
                    pass

            _safe_call_connection_lost._nobis_patched = True
            _ProactorBasePipeTransport._call_connection_lost = _safe_call_connection_lost
    except Exception as exc:
        logger.debug("Patch Proactor Windows non appliqué : %s", exc)


async def _shutdown_subsystems_for_restart() -> None:
    from matter_service import matter_manager
    from telemetry import sse_subscribers

    for q in list(sse_subscribers):
        try:
            q.put_nowait(None)
        except Exception as exc:
            logger.debug("Fermeture flux SSE ignorée : %s", exc)
    try:
        if scheduler.running:
            scheduler.shutdown(wait=False)
    except Exception as exc:
        logger.debug("Arrêt scheduler ignoré : %s", exc)
    try:
        await matter_manager.stop()
    except Exception as exc:
        logger.debug("Arrêt pont Matter ignoré : %s", exc)


async def _build_local_restart_cmd() -> list[str]:
    argv0 = sys.argv[0] if sys.argv else ""
    if sys.platform != "win32" or not argv0 or argv0.lower().endswith(".py"):
        return [sys.executable] + sys.argv
    exe_candidate = argv0 if argv0.lower().endswith(".exe") else f"{argv0}.exe"
    if await asyncio.to_thread(os.path.isfile, exe_candidate):
        return [exe_candidate] + sys.argv[1:]
    if os.path.basename(argv0).lower().startswith("uvicorn"):
        return [sys.executable, "-m", "uvicorn"] + sys.argv[1:]
    return [sys.executable] + sys.argv


async def delayed_process_restart(delay_s: float = 0.5, *, reload_exit: bool = True) -> None:
    """Ferme les flux SSE et redémarre le processus (reload superviseur 75, SIGTERM Docker ou local)."""
    await asyncio.sleep(delay_s)
    await _shutdown_subsystems_for_restart()

    if os.environ.get("NOBIS_SUPERVISOR_ENABLED") == "1" and reload_exit:
        request_reload()
        os.kill(os.getpid(), signal.SIGTERM)
        await asyncio.sleep(4.0)
        os._exit(EXIT_CODE_RELOAD)

    if await asyncio.to_thread(os.path.exists, "/.dockerenv"):
        os.kill(os.getpid(), signal.SIGTERM)
        await asyncio.sleep(3.0)
        os._exit(0)
    if "--reload" in sys.argv:
        main_py = os.path.join(_PROJECT_ROOT, "main.py")
        if await asyncio.to_thread(os.path.isfile, main_py):
            await asyncio.to_thread(os.utime, main_py, None)
            return
    cmd = await _build_local_restart_cmd()
    await asyncio.to_thread(subprocess.Popen, cmd, close_fds=(sys.platform != "win32"))
    os._exit(0)
