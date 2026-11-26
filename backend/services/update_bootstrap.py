"""
Amorce et superviseur pur-stdlib de mise à jour interne au conteneur Docker.
Ce module ne doit importer QUE la bibliothèque standard Python afin de maintenir
le processus parent de `server.py` ultra-léger (~8 Mo RAM) et indépendant des mises à jour.
"""
from datetime import UTC, datetime
import json
import os
import re
from typing import Any

EXIT_CODE_RELOAD = 75
MIN_HEALTHY_UPTIME_S = 15.0
UPDATES_SUBDIR = "updates"
RELEASES_SUBDIR = "releases"
BACKUPS_SUBDIR = "backups"
STATE_FILENAME = "state.json"

_RELEASE_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
_SEMVER_RE = re.compile(r"^v?(\d+(?:\.\d+)*)")


def _utc_now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_semver_tuple(version_str: str) -> tuple[int, ...]:
    """Extrait le tuple numérique (major, minor, patch, ...) depuis une chaîne de version."""
    m = _SEMVER_RE.match((version_str or "").strip())
    if not m:
        return (0,)
    return tuple(int(part) for part in m.group(1).split("."))


def compare_versions(v1: str, v2: str) -> int:
    """Compare deux chaînes de version semver (-1 si v1 < v2, 0 si égal, 1 si v1 > v2)."""
    t1 = parse_semver_tuple(v1)
    t2 = parse_semver_tuple(v2)
    max_len = max(len(t1), len(t2))
    p1 = t1 + (0,) * (max_len - len(t1))
    p2 = t2 + (0,) * (max_len - len(t2))
    if p1 < p2:
        return -1
    if p1 > p2:
        return 1
    return 0


def get_updates_root(data_dir: str) -> str:
    """Retourne le dossier racine des mises à jour internes sous DATA_DIR."""
    return os.path.join(data_dir, UPDATES_SUBDIR)


def get_releases_root(data_dir: str) -> str:
    """Retourne le dossier contenant les versions extraites sous DATA_DIR/updates/releases."""
    return os.path.join(data_dir, UPDATES_SUBDIR, RELEASES_SUBDIR)


def get_backups_root(data_dir: str) -> str:
    """Retourne le dossier des sauvegardes automatiques pré-MAJ sous DATA_DIR/updates/backups."""
    return os.path.join(data_dir, UPDATES_SUBDIR, BACKUPS_SUBDIR)


def get_state_path(data_dir: str) -> str:
    """Retourne le chemin du fichier pointeur atomique state.json."""
    return os.path.join(data_dir, UPDATES_SUBDIR, STATE_FILENAME)


def default_update_state() -> dict[str, Any]:
    """Retourne la structure par défaut du fichier state.json des mises à jour internes."""
    return {
        "active_release": None,
        "previous_release": None,
        "last_check": None,
        "last_error": None,
        "last_rollback": None,
        "last_notified_sha": "",
    }


def read_update_state(data_dir: str) -> dict[str, Any]:
    """Lit atomiquement l'état des mises à jour internes (ou retourne les valeurs par défaut)."""
    state = default_update_state()
    state_path = get_state_path(data_dir)
    if not os.path.isfile(state_path):
        return state
    try:
        with open(state_path, encoding="utf-8") as fh:
            raw = json.load(fh)
        if isinstance(raw, dict):
            for key in state:
                if key in raw:
                    state[key] = raw[key]
    except (OSError, ValueError, TypeError):
        return default_update_state()
    return state


def write_update_state(data_dir: str, state: dict[str, Any]) -> None:
    """Écrit state.json de façon atomique (fichier temporaire + fsync + os.replace)."""
    state_path = get_state_path(data_dir)
    os.makedirs(os.path.dirname(state_path), exist_ok=True)
    tmp_path = f"{state_path}.{os.getpid()}.tmp"
    payload = default_update_state()
    for key in payload:
        if key in state:
            payload[key] = state[key]
    try:
        with open(tmp_path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, ensure_ascii=False)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_path, state_path)
    except Exception:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                return
        raise


def is_valid_release_dir(data_dir: str, release_id: str) -> str | None:
    """Valide qu'un release_id est sûr et pointe vers un répertoire applicatif exécutable."""
    if not isinstance(release_id, str) or not _RELEASE_ID_RE.match(release_id):
        return None
    if release_id in (".", "..") or ".." in release_id:
        return None
    releases_root = os.path.realpath(get_releases_root(data_dir))
    candidate = os.path.realpath(os.path.join(releases_root, release_id))
    if not candidate.startswith(releases_root + os.sep):
        return None
    if not os.path.isdir(candidate):
        return None
    if not (
        os.path.isfile(os.path.join(candidate, "server.py"))
        and os.path.isfile(os.path.join(candidate, "main.py"))
    ):
        return None
    return candidate


def resolve_boot_target(
    data_dir: str,
    image_dir: str,
    image_version: str,
    image_commit: str = "",
) -> dict[str, Any]:
    """Résout le répertoire code actif (release surchargée ou image Docker d'origine)."""
    state = read_update_state(data_dir)
    active = state.get("active_release")
    if not isinstance(active, dict) or not active.get("id"):
        return {"target_dir": image_dir, "is_override": False, "release": None}

    rel_id = str(active.get("id", ""))
    target_dir = is_valid_release_dir(data_dir, rel_id)
    if not target_dir:
        state["active_release"] = None
        state["last_error"] = (
            f"Répertoire de mise à jour introuvable ({rel_id}), démarrage sur l'image Docker."
        )
        write_update_state(data_dir, state)
        return {"target_dir": image_dir, "is_override": False, "release": None}

    rel_version = str(active.get("app_version") or "0.0.0")
    if image_version and compare_versions(image_version, rel_version) > 0:
        state["previous_release"] = None
        state["active_release"] = None
        state["last_rollback"] = {
            "reason": "docker_image_newer",
            "failed_release_id": rel_id,
            "image_version": image_version,
            "image_commit": image_commit,
            "release_version": rel_version,
            "at": _utc_now_iso(),
            "automatic": True,
        }
        write_update_state(data_dir, state)
        return {"target_dir": image_dir, "is_override": False, "release": None}

    return {"target_dir": target_dir, "is_override": True, "release": active}


def build_child_env(
    base_env: dict[str, str],
    target: dict[str, Any],
    image_dir: str,
    image_version: str,
    image_commit: str = "",
) -> dict[str, str]:
    """Construit l'environnement du processus fils Uvicorn selon la cible choisie."""
    env = dict(base_env)
    env["NOBIS_SUPERVISOR_CHILD"] = "1"
    env["NOBIS_SUPERVISOR_ENABLED"] = "1"
    env["NOBIS_IMAGE_DIR"] = image_dir
    env["NOBIS_IMAGE_VERSION"] = image_version
    env["NOBIS_IMAGE_COMMIT"] = image_commit

    if target.get("is_override") and isinstance(target.get("release"), dict):
        rel = target["release"]
        app_ver = str(rel.get("app_version") or image_version)
        disp_ver = str(
            rel.get("display_version")
            or (f"v{app_ver}" if not app_ver.startswith("v") else app_ver)
        )
        rel_id = str(rel.get("id") or "")
        env["APP_VERSION"] = app_ver
        env["DOCKER_VERSION"] = disp_ver
        env["NOBIS_ACTIVE_RELEASE_ID"] = rel_id
        env["NOBIS_ACTIVE_RELEASE_SHA"] = str(rel.get("sha") or "")
        env["NOBIS_ACTIVE_RELEASE_DIR"] = str(target["target_dir"])
        env["NOBIS_ASSET_BUST"] = rel_id
        rel_fe_dist = os.path.join(target["target_dir"], "frontend_dist")
        if os.path.isfile(os.path.join(rel_fe_dist, "index.html")):
            env["STOVE_FRONTEND_DIST"] = rel_fe_dist
        else:
            env.pop("STOVE_FRONTEND_DIST", None)
        pydeps_dir = os.path.join(target["target_dir"], "pydeps")
        if os.path.isdir(pydeps_dir):
            existing_pp = env.get("PYTHONPATH", "").strip()
            env["PYTHONPATH"] = f"{pydeps_dir}{os.pathsep}{existing_pp}" if existing_pp else pydeps_dir
        return env

    had_override = "NOBIS_ACTIVE_RELEASE_ID" in env
    env["APP_VERSION"] = image_version
    default_docker_ver = f"v{image_version}" if not image_version.startswith("v") else image_version
    existing_docker_ver = env.get("DOCKER_VERSION", "").strip()
    if had_override or not existing_docker_ver or compare_versions(existing_docker_ver, image_version) < 0:
        env["DOCKER_VERSION"] = default_docker_ver
    for key in (
        "NOBIS_ACTIVE_RELEASE_ID",
        "NOBIS_ACTIVE_RELEASE_SHA",
        "NOBIS_ACTIVE_RELEASE_DIR",
        "NOBIS_ASSET_BUST",
        "STOVE_FRONTEND_DIST",
    ):
        env.pop(key, None)
    return env


def mark_active_release_healthy(data_dir: str, release_id: str) -> bool:
    """Confirme que la release surchargée a démarré avec succès et désactive pending_verify."""
    if not release_id:
        return False
    state = read_update_state(data_dir)
    active = state.get("active_release")
    if not isinstance(active, dict) or active.get("id") != release_id:
        return False
    if not active.get("pending_verify") and active.get("verified_at"):
        return False
    active["pending_verify"] = False
    active["verified_at"] = _utc_now_iso()
    state["last_error"] = None
    write_update_state(data_dir, state)
    return True


def rollback_after_boot_failure(
    data_dir: str,
    failed_release_id: str,
    exit_code: int,
    uptime_s: float,
) -> dict[str, Any]:
    """Bascule automatiquement vers la release précédente valide (ou l'image Docker) après crash au boot."""
    state = read_update_state(data_dir)
    prev = state.get("previous_release")
    restored: dict[str, Any] | None = None
    if isinstance(prev, dict) and prev.get("id"):
        prev_id = str(prev["id"])
        if prev_id != failed_release_id and is_valid_release_dir(data_dir, prev_id):
            restored = dict(prev)
            restored["pending_verify"] = False

    state["active_release"] = restored
    state["previous_release"] = None
    target_label = restored["id"] if restored else "docker-image"
    state["last_rollback"] = {
        "reason": "boot_failure",
        "failed_release_id": failed_release_id,
        "restored_release_id": target_label,
        "exit_code": exit_code,
        "uptime_s": round(uptime_s, 2),
        "at": _utc_now_iso(),
        "automatic": True,
    }
    state["last_error"] = (
        f"Échec du démarrage de la mise à jour {failed_release_id} "
        f"(code {exit_code}, {uptime_s:.1f}s) — rollback automatique vers {target_label}."
    )
    write_update_state(data_dir, state)
    return state
