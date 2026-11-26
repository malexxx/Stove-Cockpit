"""
Point d'entrée serveur Uvicorn et superviseur léger de mise à jour interne pour Stove Cockpit Server.
En environnement Docker, le processus parent orchestre les relances internes (code 75) et le
rollback automatique en cas d'échec de démarrage sans recréer le conteneur ni perdre /app/data.
Fonctionne exclusivement en HTTP pur (déléguer TLS à un reverse-proxy externe si besoin).
"""
import argparse
import logging
import os
import signal
import subprocess
import sys
import time

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from config import resolve_data_dir
from services.update_bootstrap import (
    EXIT_CODE_RELOAD,
    MIN_HEALTHY_UPTIME_S,
    build_child_env,
    compare_versions,
    read_update_state,
    resolve_boot_target,
    rollback_after_boot_failure,
)

IMAGE_CODE_VERSION = "0.0.91"

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger("nobis.server")


def parse_args(argv=None) -> argparse.Namespace:
    """Analyse les arguments CLI et variables d'environnement du serveur Uvicorn."""
    parser = argparse.ArgumentParser(description="Lanceur Stove Cockpit Server (HTTP pur)")
    parser.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8080")))
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--proxy-headers", action="store_true", default=True)
    parser.add_argument(
        "--forwarded-allow-ips",
        default=os.environ.get("TRUSTED_PROXY_IPS", "127.0.0.1,::1"),
    )
    parser.add_argument("--timeout-graceful-shutdown", type=int, default=5)
    args, _ = parser.parse_known_args(argv)
    return args


def should_run_supervisor() -> bool:
    """Indique si server.py doit démarrer la boucle superviseur (Docker parent uniquement)."""
    return (
        os.path.exists("/.dockerenv")
        and os.environ.get("NOBIS_SUPERVISOR_CHILD") != "1"
        and os.environ.get("NOBIS_DISABLE_SUPERVISOR") != "1"
        and not sys.platform.startswith("win")
    )


def _terminate_child_gracefully(proc: subprocess.Popen | None) -> None:
    if proc is None or proc.poll() is not None:
        return
    try:
        proc.terminate()
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=3)
    except OSError:
        return


def _should_auto_rollback(data_dir: str, target: dict, rc: int, uptime_s: float) -> bool:
    if not target.get("is_override") or not isinstance(target.get("release"), dict):
        return False
    rel_id = str(target["release"].get("id") or "")
    fresh_state = read_update_state(data_dir)
    fresh_active = fresh_state.get("active_release")
    still_pending = bool(
        isinstance(fresh_active, dict)
        and fresh_active.get("id") == rel_id
        and fresh_active.get("pending_verify")
    )
    if still_pending:
        return True
    return rc != 0 and uptime_s < MIN_HEALTHY_UPTIME_S


def _run_supervisor_loop(argv: list[str]) -> int:
    """Orchestre le sous-processus Uvicorn et bascule automatiquement en cas de boot défaillant."""
    data_dir = resolve_data_dir(os.environ.get("DB_PATH", ""))
    env_app_ver = os.environ.get("APP_VERSION", "").strip()
    image_version = (
        env_app_ver
        if (env_app_ver and compare_versions(env_app_ver, IMAGE_CODE_VERSION) >= 0)
        else IMAGE_CODE_VERSION
    )
    image_commit = os.environ.get("NOBIS_IMAGE_COMMIT", "").strip()

    state = {"stop_requested": False, "proc": None}

    def _on_stop_signal(signum, _frame):
        state["stop_requested"] = True
        logger.info("Signal d'arrêt (%s) reçu par le superviseur.", signum)
        _terminate_child_gracefully(state["proc"])

    for sig_name in ("SIGTERM", "SIGINT"):
        sig = getattr(signal, sig_name, None)
        if sig is not None:
            signal.signal(sig, _on_stop_signal)

    while not state["stop_requested"]:
        target = resolve_boot_target(data_dir, BASE_DIR, image_version, image_commit)
        target_dir = target["target_dir"]
        child_env = build_child_env(os.environ, target, BASE_DIR, image_version, image_commit)
        rel_info = target.get("release") or {}
        if target["is_override"]:
            logger.info(
                "Superviseur : lancement release interne %s (%s)",
                rel_info.get("id", "?"),
                target_dir,
            )
        else:
            logger.info("Superviseur : lancement version image Docker (%s)", image_version)

        started_at = time.monotonic()
        proc = subprocess.Popen(
            [sys.executable, os.path.join(target_dir, "server.py"), *argv],
            cwd=target_dir,
            env=child_env,
        )
        state["proc"] = proc
        rc = proc.wait()
        state["proc"] = None
        uptime_s = time.monotonic() - started_at

        if state["stop_requested"]:
            return 0 if rc in (0, -15, 143) else rc
        if rc == EXIT_CODE_RELOAD:
            logger.info("Superviseur : rechargement interne demandé (code %d).", EXIT_CODE_RELOAD)
            continue
        if _should_auto_rollback(data_dir, target, rc, uptime_s):
            failed_id = str(rel_info.get("id") or "unknown")
            logger.error(
                "Superviseur : échec boot release %s (rc=%d, uptime=%.1fs) -> rollback automatique.",
                failed_id,
                rc,
                uptime_s,
            )
            rollback_after_boot_failure(data_dir, failed_id, rc, uptime_s)
            time.sleep(1.0)
            continue
        return rc

    return 0


def _run_server(argv=None) -> None:
    """Initialise les bases et démarre Uvicorn en HTTP pur."""
    import uvicorn

    from database import init_all_databases
    from services.api_token_service import get_or_create_api_token
    from services.lifecycle import (
        install_windows_proactor_guard,
        is_reload_requested,
        reset_reload_requested,
    )

    install_windows_proactor_guard()
    args = parse_args(argv)
    os.environ["NOBIS_RUNTIME_PORT"] = str(args.port)
    init_all_databases()
    get_or_create_api_token()

    kwargs = {
        "host": args.host,
        "port": args.port,
        "workers": args.workers,
        "proxy_headers": args.proxy_headers,
        "forwarded_allow_ips": args.forwarded_allow_ips,
        "timeout_graceful_shutdown": args.timeout_graceful_shutdown,
    }

    logger.info("Démarrage Stove Cockpit Server en HTTP sur http://%s:%d", args.host, args.port)
    uvicorn.run("main:app", **kwargs)
    if is_reload_requested():
        reset_reload_requested()
        sys.exit(EXIT_CODE_RELOAD)


def main() -> None:
    """Point d'entrée unifié : boucle superviseur en Docker parent, sinon serveur Uvicorn."""
    if should_run_supervisor():
        sys.exit(_run_supervisor_loop(sys.argv[1:]))
    _run_server()


if __name__ == "__main__":
    main()
