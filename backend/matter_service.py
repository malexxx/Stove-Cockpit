"""Superviseur du sous-processus Node.js Matter (thermostat local et appairage aléatoire en HTTP local)."""
import asyncio
import logging
import os
import secrets
import shutil
import subprocess
import sys
from typing import Any

logger = logging.getLogger("nobis.matter")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from clients import borrow_http_client
from config import DATA_DIR
from database import db_log, get_active_mode, get_settings_dict, get_sys_db

MATTER_BRIDGE_DIR = os.path.join(BASE_DIR, "matter_bridge")
MATTER_SCRIPT_PATH = os.path.join(MATTER_BRIDGE_DIR, "bridge.mjs")
MATTER_STORAGE_DIR = os.path.join(DATA_DIR, "matter_storage")
MATTER_CONTROL_URL = "http://127.0.0.1:5549"

# Passcodes interdits par la spécification Matter §5.1.1.6
_INVALID_MATTER_PASSCODES = {
    0, 11111111, 22222222, 33333333, 44444444,
    55555555, 66666666, 77777777, 88888888, 99999999,
    12345678, 87654321,
}


def generate_matter_passcode() -> int:
    """Génère un passcode Matter cryptographiquement aléatoire conforme à la spec §5.1.1.6."""
    while True:
        code = 1 + secrets.randbelow(99999998)
        if code not in _INVALID_MATTER_PASSCODES:
            return code


def generate_matter_discriminator() -> int:
    """Génère un discriminator Matter 12-bit aléatoire (0..4095)."""
    return secrets.randbelow(4096)


def _load_or_create_commissioning_params(regenerate: bool = False) -> tuple[int, int]:
    """Lit ou génère et persiste (passcode, discriminator) dans la base système."""
    settings = get_settings_dict()
    passcode = None
    discriminator = None

    if not regenerate:
        try:
            raw_p = int(str(settings.get("matter_passcode") or "").strip())
            if 1 <= raw_p <= 99999998 and raw_p not in _INVALID_MATTER_PASSCODES:
                passcode = raw_p
        except (ValueError, TypeError):
            pass
        try:
            raw_d = int(str(settings.get("matter_discriminator") or "").strip())
            if 0 <= raw_d <= 4095:
                discriminator = raw_d
        except (ValueError, TypeError):
            pass

    changed = False
    if passcode is None:
        passcode = generate_matter_passcode()
        changed = True
    if discriminator is None:
        discriminator = generate_matter_discriminator()
        changed = True

    if changed:
        conn = get_sys_db()
        try:
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES ('matter_passcode', ?)",
                (str(passcode),),
            )
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES ('matter_discriminator', ?)",
                (str(discriminator),),
            )
            conn.commit()
        finally:
            conn.close()

    return passcode, discriminator


def _resolve_backend_api_connection() -> tuple[str, None]:
    """Détermine l'URL locale HTTP du backend FastAPI (toujours en HTTP pur)."""
    explicit_url = (os.environ.get("STOVE_API_URL") or os.environ.get("NOBIS_API_URL") or "").strip()
    port = os.environ.get("NOBIS_RUNTIME_PORT") or os.environ.get("PORT") or "8080"
    if explicit_url:
        return explicit_url, None
    return f"http://127.0.0.1:{port}", None


def _find_node_binary() -> str | None:
    """Recherche l'exécutable Node.js (portable local Windows ou global Linux/Docker)."""
    project_root = os.path.dirname(BASE_DIR)
    candidates = [
        os.path.join(project_root, ".node", "node.exe"),
        os.path.join(BASE_DIR, ".node", "node.exe"),
        shutil.which("node"),
        "/usr/bin/node",
        "/usr/local/bin/node",
        r"C:\Program Files\nodejs\node.exe",
    ]
    for c in candidates:
        if c and os.path.isfile(c):
            return c
    return None


class MatterBridgeManager:
    """Gère le cycle de vie, la synchronisation télémétrique et le reset d'usine du pont Matter local."""

    def __init__(self) -> None:
        self._proc: subprocess.Popen | None = None
        self._lock = asyncio.Lock()
        self._stopping = False
        self._webhook_secret: str = secrets.token_hex(32)

    @property
    def webhook_secret(self) -> str:
        """Retourne le secret éphémère partagé avec le pont Node.js pour authentifier /api/matter/webhook."""
        return self._webhook_secret

    def is_enabled(self) -> bool:
        """Indique si le pont thermostat Matter est activé dans la configuration système."""
        s = get_settings_dict()
        return s.get("matter_enabled", "1") not in ("0", "false", "False")

    async def is_control_alive(self) -> bool:
        """Vérifie si l'API HTTP locale du pont Matter (127.0.0.1:5549) répond."""
        try:
            async with borrow_http_client(timeout=1.5) as client:
                r = await client.get(f"{MATTER_CONTROL_URL}/status", timeout=1.5)
                return r.status_code == 200
        except Exception:
            return False

    def _build_bridge_env(self) -> tuple[dict[str, str], str, str]:
        settings = get_settings_dict()
        device_name = (settings.get("matter_device_name") or "Poêle Nobis A10").strip()
        matter_port = str(settings.get("matter_port") or "5540").strip()
        passcode, discriminator = _load_or_create_commissioning_params(regenerate=False)
        api_url, _ = _resolve_backend_api_connection()

        env = os.environ.copy()
        env["NOBIS_API_URL"] = api_url
        env["MATTER_WEBHOOK_SECRET"] = self._webhook_secret
        env["MATTER_PASSCODE"] = str(passcode)
        env["MATTER_DISCRIMINATOR"] = str(discriminator)
        env["MATTER_PORT"] = matter_port
        env["MATTER_CONTROL_PORT"] = "5549"
        env["MATTER_STORAGE_DIR"] = MATTER_STORAGE_DIR
        env["MATTER_DEVICE_NAME"] = device_name
        return env, device_name, matter_port

    async def _wait_for_bridge_ready(self, device_name: str, matter_port: str) -> dict[str, Any]:
        for _ in range(25):
            await asyncio.sleep(0.25)
            if await self.is_control_alive():
                status = await self._fetch_status_unlocked()
                code = status.get("manualPairingCodeFormatted") or status.get("manualPairingCode") or "---"
                db_log(
                    "INFO",
                    "MATTER",
                    f"Pont Thermostat Matter '{device_name}' démarré (UDP:{matter_port} | Code d'appairage: {code}).",
                    get_active_mode(),
                )
                return status
        return {
            "running": False,
            "enabled": True,
            "error": "Délai dépassé lors de l'initialisation du pont Matter.",
        }

    async def ensure_started(self) -> dict[str, Any]:
        """Démarre le sous-processus Node.js Matter de manière idempotente et attend sa disponibilité."""
        async with self._lock:
            if not self.is_enabled():
                return {"running": False, "enabled": False, "reason": "Pont Matter désactivé dans la configuration"}
            if await self.is_control_alive():
                return await self._fetch_status_unlocked()

            node_bin = await asyncio.to_thread(_find_node_binary)
            if not node_bin:
                return {"running": False, "enabled": True, "error": "Exécutable Node.js introuvable pour le pont Matter."}
            if not await asyncio.to_thread(os.path.isfile, MATTER_SCRIPT_PATH):
                return {"running": False, "enabled": True, "error": f"Script Matter introuvable : {MATTER_SCRIPT_PATH}"}

            self._stopping = False
            await asyncio.to_thread(os.makedirs, MATTER_STORAGE_DIR, exist_ok=True)
            env, device_name, matter_port = self._build_bridge_env()
            creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000) if os.name == "nt" else 0

            def _spawn():
                return subprocess.Popen(
                    [node_bin, MATTER_SCRIPT_PATH],
                    cwd=MATTER_BRIDGE_DIR,
                    env=env,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    creationflags=creationflags,
                )

            try:
                self._proc = await asyncio.to_thread(_spawn)
            except Exception as e:
                db_log("ERROR", "MATTER", f"Impossible de lancer le pont Matter : {e}", get_active_mode())
                return {"running": False, "enabled": True, "error": str(e)}

            return await self._wait_for_bridge_ready(device_name, matter_port)

    async def stop(self) -> None:
        """Arrête proprement le sous-processus Node.js du pont Matter."""
        self._stopping = True
        proc = self._proc
        if proc and proc.poll() is None:
            def _terminate_proc():
                try:
                    proc.terminate()
                    try:
                        proc.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                except Exception as exc:
                    logger.debug("Erreur arrêt processus Matter : %s", exc)

            await asyncio.to_thread(_terminate_proc)
        self._proc = None

    async def _fetch_status_unlocked(self) -> dict[str, Any]:
        try:
            async with borrow_http_client(timeout=2.5) as client:
                r = await client.get(f"{MATTER_CONTROL_URL}/status", timeout=2.5)
                if r.status_code == 200:
                    data = r.json()
                    data["enabled"] = self.is_enabled()
                    return data
        except Exception as e:
            return {"running": False, "enabled": self.is_enabled(), "error": str(e)}
        return {"running": False, "enabled": self.is_enabled()}

    async def get_status(self) -> dict[str, Any]:
        """Retourne le statut courant du pont Matter (avec redémarrage automatique si activé)."""
        if not self.is_enabled():
            return {"running": False, "enabled": False}
        if not await self.is_control_alive() and not self._stopping:
            return await self.ensure_started()
        return await self._fetch_status_unlocked()

    async def sync_telemetry(self, record: dict[str, Any]) -> None:
        """Synchronise la température ambiante, la consigne et l'état du poêle vers le thermostat Matter."""
        if not self.is_enabled() or self._stopping:
            return
        try:
            if not await self.is_control_alive():
                await self.ensure_started()
            payload = {
                "temp_ambient": record.get("temp_ambient"),
                "temp_amb_setpoint": record.get("temp_amb_setpoint"),
                "status_code": record.get("status_code"),
                "status_managed": record.get("status_managed"),
            }
            async with borrow_http_client(timeout=2.0) as client:
                await client.post(f"{MATTER_CONTROL_URL}/sync", json=payload, timeout=2.0)
        except Exception as exc:
            logger.debug("Échec synchronisation télémétrie Matter : %s", exc)

    async def factory_reset(self) -> dict[str, Any]:
        """Efface le stockage Matter, régénère passcode/discriminator aléatoires et relance le pont."""
        try:
            async with borrow_http_client(timeout=3.0) as client:
                await client.post(f"{MATTER_CONTROL_URL}/factory-reset", timeout=3.0)
        except Exception as exc:
            logger.debug("Échec appel HTTP /factory-reset Matter (non bloquant) : %s", exc)
        await asyncio.sleep(0.5)
        await self.stop()
        if await asyncio.to_thread(os.path.isdir, MATTER_STORAGE_DIR):
            await asyncio.to_thread(shutil.rmtree, MATTER_STORAGE_DIR, True)
        # Régénérer passcode & discriminator aléatoires pour obtenir un vrai nouveau QR Code
        _load_or_create_commissioning_params(regenerate=True)
        db_log(
            "WARNING",
            "MATTER",
            "Réinitialisation d'usine de l'appairage Matter effectuée (nouveau QR Code généré).",
            get_active_mode(),
        )
        return await self.ensure_started()


matter_manager = MatterBridgeManager()
