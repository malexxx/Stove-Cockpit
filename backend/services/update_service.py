"""
Service de mise à jour interne au conteneur Docker (téléchargement GitHub sécurisé,
validation syntaxique, gestion des dépendances différentielles, sauvegarde pré-MAJ et rollback).
"""
import asyncio
from datetime import UTC, datetime
import hashlib
import os
from pathlib import PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from typing import Any
from urllib.parse import urlparse

import httpx

from clients import borrow_http_client, notification_service
import config
from database import (
    add_container_log,
    db_log,
    get_active_mode,
    get_settings_dict,
    get_sys_db,
)
from services.lifecycle import delayed_process_restart, spawn_background_task
from services.storage_service import ALLOWED_ROOT_DB_FILES, create_backup_zip_bytes
from services.update_bootstrap import (
    compare_versions,
    get_backups_root,
    get_releases_root,
    get_updates_root,
    is_valid_release_dir,
    read_update_state,
    write_update_state,
)

DEFAULT_UPDATE_REPO = "malexxx/Stove-Cockpit"
_REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
_APP_VERSION_RE = re.compile(
    r'^APP_VERSION\b[^#\r\n]*?["\']([0-9]+(?:\.[0-9]+)+)["\']',
    re.MULTILINE,
)
_SAFE_ID_CHARS_RE = re.compile(r"[^A-Za-z0-9._-]+")

VALID_CHANNELS: tuple[str, ...] = ("main", "releases")
ALLOWED_GITHUB_HOSTS: frozenset[str] = frozenset(
    {
        "api.github.com",
        "github.com",
        "codeload.github.com",
        "objects.githubusercontent.com",
        "raw.githubusercontent.com",
    }
)
MAX_TARBALL_BYTES = 50 * 1024 * 1024
MAX_EXTRACTED_BYTES = 150 * 1024 * 1024
MAX_EXTRACTED_FILES = 3000
KEEP_RELEASE_COUNT = 2
KEEP_BACKUP_COUNT = 2

REQUIRED_RELEASE_FILES: tuple[str, ...] = (
    "server.py",
    "main.py",
    "config.py",
    "routers/admin.py",
    "services/update_service.py",
)


class UpdateConflictError(RuntimeError):
    """Erreur levée lorsqu'une opération de mise à jour est déjà en cours."""


class UpdateUpstreamError(RuntimeError):
    """Erreur levée lorsque GitHub ou le téléchargement distant est inaccessible."""


_update_lock = asyncio.Lock()
_operation_state: dict[str, Any] = {
    "status": "idle",
    "step": "",
    "message": "",
    "progress_pct": 0,
    "started_at": "",
    "finished_at": "",
}


def _utc_now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _set_operation(
    status: str,
    step: str = "",
    message: str = "",
    progress_pct: int = 0,
    *,
    finished: bool = False,
) -> None:
    _operation_state["status"] = status
    _operation_state["step"] = step
    _operation_state["message"] = message
    _operation_state["progress_pct"] = progress_pct
    if status == "running" and not _operation_state["started_at"]:
        _operation_state["started_at"] = _utc_now_iso()
        _operation_state["finished_at"] = ""
    elif status != "running":
        if not _operation_state["started_at"]:
            _operation_state["started_at"] = _utc_now_iso()
        if finished:
            _operation_state["finished_at"] = _utc_now_iso()


def _resolve_dirs(
    data_dir: str | None = None,
    image_dir: str | None = None,
) -> tuple[str, str]:
    import database as _db_pkg

    target_data = data_dir or _db_pkg.DATA_DIR
    env_img = os.environ.get("NOBIS_IMAGE_DIR", "").strip()
    target_image = image_dir or env_img or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return target_data, target_image


def get_update_repo() -> str:
    """Retourne le dépôt GitHub configuré (owner/repo) pour les mises à jour internes."""
    raw = os.environ.get("NOBIS_UPDATE_REPO", "").strip()
    if raw and _REPO_RE.match(raw):
        return raw
    return DEFAULT_UPDATE_REPO


def get_update_settings() -> dict[str, Any]:
    """Lit les préférences de mise à jour interne depuis la table système settings."""
    try:
        s = get_settings_dict()
    except Exception:
        s = {}
    env_chan = os.environ.get("NOBIS_UPDATE_CHANNEL", "v2").strip().lower()
    default_chan = env_chan if env_chan in VALID_CHANNELS else "v2"
    raw_chan = (s.get("update_channel") or default_chan).strip().lower()
    channel = raw_chan if raw_chan in VALID_CHANNELS else default_chan
    auto_check = str(s.get("update_auto_check", "1")).strip().lower() in ("1", "true", "yes", "on")
    auto_apply = str(s.get("update_auto_apply", "0")).strip().lower() in ("1", "true", "yes", "on")
    return {
        "channel": channel,
        "auto_check": auto_check,
        "auto_apply": auto_apply,
    }


def save_update_settings(
    channel: str | None = None,
    auto_check: bool | None = None,
    auto_apply: bool | None = None,
) -> dict[str, Any]:
    """Valide et enregistre les préférences de mise à jour interne en base SQLite système."""
    updates: dict[str, str] = {}
    if channel is not None:
        clean_chan = str(channel).strip().lower()
        if clean_chan not in VALID_CHANNELS:
            raise ValueError(f"Canal de mise à jour invalide : {channel}. Valeurs autorisées : {', '.join(VALID_CHANNELS)}.")
        updates["update_channel"] = clean_chan
    if auto_check is not None:
        updates["update_auto_check"] = "1" if auto_check else "0"
    if auto_apply is not None:
        updates["update_auto_apply"] = "1" if auto_apply else "0"

    if updates:
        conn = get_sys_db()
        try:
            for key, val in updates.items():
                conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, val))
            conn.commit()
        finally:
            conn.close()
    return get_update_settings()


def _is_self_update_supported() -> tuple[bool, bool, bool]:
    in_docker = os.path.exists("/.dockerenv")
    supervisor_active = os.environ.get("NOBIS_SUPERVISOR_ENABLED") == "1"
    allow_local = os.environ.get("NOBIS_ALLOW_LOCAL_SELF_UPDATE") == "1"
    return in_docker, supervisor_active, (supervisor_active or allow_local)


def get_update_status(data_dir: str | None = None) -> dict[str, Any]:
    """Retourne l'état complet des mises à jour internes pour l'API et l'interface Paramètres."""
    target_data, _ = _resolve_dirs(data_dir=data_dir)
    state = read_update_state(target_data)
    prefs = get_update_settings()
    in_docker, supervisor_active, supported = _is_self_update_supported()

    active_rel_id = os.environ.get("NOBIS_ACTIVE_RELEASE_ID", "").strip()
    active_rel_sha = os.environ.get("NOBIS_ACTIVE_RELEASE_SHA", "").strip()
    image_ver = os.environ.get("NOBIS_IMAGE_VERSION", "").strip() or config.APP_VERSION
    image_commit = os.environ.get("NOBIS_IMAGE_COMMIT", "").strip()
    current_commit = active_rel_sha or image_commit

    active_rel = state.get("active_release")
    can_rollback = bool(active_rel and isinstance(active_rel, dict) and active_rel.get("id"))

    return {
        "current_version": config.APP_VERSION,
        "docker_version": config.DOCKER_VERSION,
        "current_commit": current_commit,
        "image_version": image_ver,
        "image_commit": image_commit,
        "in_docker": in_docker,
        "supervisor_active": supervisor_active,
        "self_update_supported": supported,
        "is_override": bool(active_rel_id or can_rollback),
        "active_release": active_rel,
        "previous_release": state.get("previous_release"),
        "can_rollback": can_rollback,
        "channel": prefs["channel"],
        "auto_check": prefs["auto_check"],
        "auto_apply": prefs["auto_apply"],
        "repo": get_update_repo(),
        "last_check": state.get("last_check"),
        "last_error": state.get("last_error"),
        "last_rollback": state.get("last_rollback"),
        "operation": dict(_operation_state),
    }


def _validate_github_url(url: str) -> str:
    parsed = urlparse((url or "").strip())
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or host not in ALLOWED_GITHUB_HOSTS:
        raise ValueError(f"URL distante refusée (hôte non autorisé) : {url}")
    return parsed.geturl()


def _github_headers(*, include_auth: bool = True) -> dict[str, str]:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": f"Nobis.Supervisor/{config.APP_VERSION}",
    }
    if include_auth:
        token = os.environ.get("GITHUB_TOKEN", "").strip()
        if token:
            headers["Authorization"] = f"Bearer {token}"
    return headers


def _raise_for_github_status(resp: httpx.Response, url: str) -> None:
    if 200 <= resp.status_code < 300:
        return
    if resp.status_code == 403 and "rate limit" in resp.text.lower():
        raise UpdateUpstreamError(
            "Limite de requêtes GitHub API atteinte (rate limit). Réessayez plus tard ou configurez GITHUB_TOKEN."
        )
    if resp.status_code == 404:
        raise UpdateUpstreamError(f"Ressource GitHub introuvable ({url}).")
    raise UpdateUpstreamError(f"GitHub a répondu HTTP {resp.status_code} sur {url}.")


async def _fetch_github_json(url: str, timeout: float = 15.0) -> Any:
    safe_url = _validate_github_url(url)
    try:
        async with borrow_http_client(timeout=timeout) as client:
            resp = await client.get(safe_url, headers=_github_headers(), timeout=timeout)
    except httpx.RequestError as exc:
        raise UpdateUpstreamError(f"Impossible de joindre GitHub ({safe_url}) : {exc}") from exc
    _raise_for_github_status(resp, safe_url)
    try:
        return resp.json()
    except ValueError as exc:
        raise UpdateUpstreamError(f"Réponse JSON invalide de GitHub ({safe_url}).") from exc


async def _fetch_remote_app_version(repo: str, sha: str) -> str:
    raw_url = _validate_github_url(f"https://raw.githubusercontent.com/{repo}/{sha}/config.py")
    try:
        async with borrow_http_client(timeout=8.0) as client:
            resp = await client.get(raw_url, headers=_github_headers(include_auth=False), timeout=8.0)
        if resp.status_code != 200:
            return ""
        match = _APP_VERSION_RE.search(resp.text)
        return match.group(1) if match else ""
    except (httpx.RequestError, ValueError):
        return ""


def _resolve_channel_arg(channel: str | None) -> str:
    if channel is None:
        return get_update_settings()["channel"]
    clean = str(channel).strip().lower()
    if clean not in VALID_CHANNELS:
        raise ValueError(f"Canal de mise à jour invalide : {channel}")
    return clean


def _compute_update_available(
    chan: str,
    remote_sha: str,
    remote_ver: str,
    current_ver: str,
    current_commit: str,
    state: dict[str, Any],
    *,
    supervisor_active: bool,
) -> tuple[bool, str]:
    active_rel = state.get("active_release") if isinstance(state.get("active_release"), dict) else {}
    effective_commit = current_commit or str(active_rel.get("sha") or "")

    if chan == "releases":
        if remote_ver and compare_versions(remote_ver, current_ver) > 0:
            return True, ""
        if effective_commit and remote_sha:
            return (remote_sha != effective_commit), ""
        return False, ""

    if effective_commit and remote_sha:
        if remote_sha == effective_commit:
            return False, ""
        if remote_ver and compare_versions(remote_ver, current_ver) < 0 and not active_rel:
            return False, ""
        return True, ""

    if remote_ver and compare_versions(remote_ver, current_ver) > 0:
        return True, ""
    if supervisor_active:
        return True, f"Commit image inconnu : installation recommandée pour suivre '{chan}' ({remote_sha[:7]})."
    return False, "Version identique et commit image non renseigné."


async def _fetch_latest_release_info(repo: str) -> dict[str, Any]:
    data = await _fetch_github_json(f"https://api.github.com/repos/{repo}/releases/latest")
    tag = str(data.get("tag_name") or "").strip()
    if not tag:
        raise UpdateUpstreamError("Dernière release GitHub sans tag_name valide.")
    remote_sha = str(data.get("target_commitish") or "").strip()
    if not re.fullmatch(r"[0-9a-f]{40}", remote_sha, re.IGNORECASE):
        try:
            ref_data = await _fetch_github_json(f"https://api.github.com/repos/{repo}/git/ref/tags/{tag}")
            obj = ref_data.get("object") or {}
            remote_sha = str(obj.get("sha") or remote_sha).strip()
        except UpdateUpstreamError:
            remote_sha = ""
    tarball_url = str(data.get("tarball_url") or f"https://api.github.com/repos/{repo}/tarball/{tag}").strip()
    return {
        "remote_version": tag.lstrip("v"),
        "remote_tag": tag,
        "remote_sha": remote_sha,
        "tarball_url": tarball_url,
        "html_url": str(data.get("html_url") or ""),
        "published_at": str(data.get("published_at") or ""),
        "commit_message": str(data.get("name") or tag).splitlines()[0][:180],
    }


async def _fetch_branch_commit_info(repo: str, branch: str) -> dict[str, Any]:
    data = await _fetch_github_json(f"https://api.github.com/repos/{repo}/commits/{branch}")
    sha = str(data.get("sha") or "").strip()
    if not sha:
        raise UpdateUpstreamError(f"Impossible de résoudre le commit HEAD sur la branche '{branch}'.")
    commit_obj = data.get("commit") or {}
    raw_msg = str(commit_obj.get("message") or "").strip()
    first_line = raw_msg.splitlines()[0][:180] if raw_msg else sha[:7]
    committer = commit_obj.get("committer") or {}
    remote_ver = await _fetch_remote_app_version(repo, sha)
    return {
        "remote_version": remote_ver or config.APP_VERSION,
        "remote_tag": branch,
        "remote_sha": sha,
        "tarball_url": f"https://api.github.com/repos/{repo}/tarball/{sha}",
        "html_url": str(data.get("html_url") or ""),
        "published_at": str(committer.get("date") or ""),
        "commit_message": first_line,
    }


def _persist_last_check(data_dir: str, check_info: dict[str, Any]) -> None:
    state = read_update_state(data_dir)
    state["last_check"] = check_info
    write_update_state(data_dir, state)


async def check_for_updates(channel: str | None = None, data_dir: str | None = None) -> dict[str, Any]:
    """Interroge GitHub (sans recréer le conteneur) et compare à la version/commit actif."""
    target_data, _ = _resolve_dirs(data_dir=data_dir)
    chan = _resolve_channel_arg(channel)
    repo = get_update_repo()

    remote = (
        await _fetch_latest_release_info(repo)
        if chan == "releases"
        else await _fetch_branch_commit_info(repo, chan)
    )

    state = await asyncio.to_thread(read_update_state, target_data)
    _, supervisor_active, supported = _is_self_update_supported()
    current_commit = (
        os.environ.get("NOBIS_ACTIVE_RELEASE_SHA", "").strip()
        or os.environ.get("NOBIS_IMAGE_COMMIT", "").strip()
    )
    update_available, note = _compute_update_available(
        chan,
        remote["remote_sha"],
        remote["remote_version"],
        config.APP_VERSION,
        current_commit,
        state,
        supervisor_active=supervisor_active,
    )

    short_sha = remote["remote_sha"][:7] if remote["remote_sha"] else ""
    if update_available:
        msg = (
            f"Mise à jour disponible sur '{chan}' : v{remote['remote_version']}"
            f"{f' ({short_sha})' if short_sha else ''} — {remote['commit_message']}"
        )
    else:
        msg = (
            f"Application à jour sur '{chan}' : v{config.APP_VERSION}"
            f"{f' ({short_sha})' if short_sha else ''}."
        )

    check_info: dict[str, Any] = {
        "status": "ok",
        "checked_at": _utc_now_iso(),
        "channel": chan,
        "repo": repo,
        "current_version": config.APP_VERSION,
        "current_commit": current_commit,
        "remote_version": remote["remote_version"],
        "remote_tag": remote["remote_tag"],
        "remote_sha": remote["remote_sha"],
        "tarball_url": remote["tarball_url"],
        "html_url": remote["html_url"],
        "published_at": remote["published_at"],
        "commit_message": remote["commit_message"],
        "update_available": update_available,
        "self_update_supported": supported,
        "note": note,
        "message": msg,
    }
    await asyncio.to_thread(_persist_last_check, target_data, check_info)
    return check_info


def _write_bytes_atomically(dest_path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
    with open(dest_path, "wb") as fh:
        fh.write(data)


async def _download_tarball_bounded(url: str, dest_path: str) -> str:
    """Télécharge une archive tar.gz GitHub en validant chaque saut de redirection (anti-SSRF)."""
    current_url = _validate_github_url(url)
    for _ in range(6):
        host = (urlparse(current_url).hostname or "").lower()
        req_headers = _github_headers(include_auth=(host in ("api.github.com", "github.com")))
        try:
            async with borrow_http_client(timeout=60.0) as client, client.stream(
                "GET",
                current_url,
                headers=req_headers,
                follow_redirects=False,
                timeout=60.0,
            ) as resp:
                if resp.status_code in (301, 302, 303, 307, 308):
                    loc = (resp.headers.get("location") or "").strip()
                    if not loc:
                        raise UpdateUpstreamError("Redirection GitHub sans en-tête Location.")
                    current_url = _validate_github_url(loc)
                    continue
                if not (200 <= resp.status_code < 300):
                    raise UpdateUpstreamError(f"Échec téléchargement archive GitHub (HTTP {resp.status_code}).")
                buf = bytearray()
                hasher = hashlib.sha256()
                async for chunk in resp.aiter_bytes(chunk_size=65536):
                    if len(buf) + len(chunk) > MAX_TARBALL_BYTES:
                        raise ValueError("Archive de mise à jour trop volumineuse (limite 50 Mo).")
                    buf.extend(chunk)
                    hasher.update(chunk)
                await asyncio.to_thread(_write_bytes_atomically, dest_path, bytes(buf))
                return hasher.hexdigest()
        except httpx.RequestError as exc:
            raise UpdateUpstreamError(f"Erreur réseau lors du téléchargement GitHub : {exc}") from exc

    raise UpdateUpstreamError("Trop de redirections lors du téléchargement depuis GitHub.")


def _normalize_tar_member_relpath(raw_name: str) -> tuple[str | None, bool]:
    cleaned = (raw_name or "").replace("\\", "/")
    if cleaned.startswith("/") or ":" in cleaned:
        raise ValueError(f"Chemin interdit dans l'archive : {raw_name}")
    parts = [p for p in PurePosixPath(cleaned).parts if p not in ("", ".")]
    if not parts:
        return None, False
    if ".." in parts:
        raise ValueError(f"Traversée de chemin interdite dans l'archive : {raw_name}")
    # Les tarballs GitHub possèdent un unique dossier racine <owner>-<repo>-<sha>/
    if len(parts) == 1:
        return None, True
    return "/".join(parts[1:]), False


def _validate_tar_member_type(member: tarfile.TarInfo) -> None:
    if member.issym() or member.islnk():
        raise ValueError(f"Lien symbolique ou dur interdit dans l'archive : {member.name}")
    if member.isdev() or member.ischr() or member.isblk() or member.isfifo():
        raise ValueError(f"Entrée spéciale interdite dans l'archive : {member.name}")
    if not (member.isfile() or member.isdir()):
        raise ValueError(f"Type de fichier non supporté dans l'archive : {member.name}")


def _extract_regular_member_bounded(
    tf: tarfile.TarFile,
    member: tarfile.TarInfo,
    target_path: str,
    total_bytes: int,
) -> int:
    if member.size < 0 or total_bytes + member.size > MAX_EXTRACTED_BYTES:
        raise ValueError("Taille totale extraite supérieure à la limite autorisée (150 Mo).")
    src_fh = tf.extractfile(member)
    if src_fh is None:
        return total_bytes
    os.makedirs(os.path.dirname(target_path), exist_ok=True)
    with src_fh, open(target_path, "wb") as dst_fh:
        while True:
            block = src_fh.read(65536)
            if not block:
                break
            total_bytes += len(block)
            if total_bytes > MAX_EXTRACTED_BYTES:
                raise ValueError("Taille totale extraite supérieure à la limite autorisée (150 Mo).")
            dst_fh.write(block)
    return total_bytes


def _extract_tarball_safely(tar_path: str, dest_dir: str) -> int:
    os.makedirs(dest_dir, exist_ok=True)
    dest_root = os.path.realpath(dest_dir)
    extracted_files = 0
    total_bytes = 0

    try:
        tf_ctx = tarfile.open(tar_path, "r:gz")
    except (tarfile.TarError, OSError) as exc:
        raise ValueError(f"Archive tar.gz invalide ou corrompue : {exc}") from exc

    with tf_ctx as tf:
        for member in tf.getmembers():
            _validate_tar_member_type(member)
            rel, is_root_entry = _normalize_tar_member_relpath(member.name)
            if is_root_entry and not member.isdir():
                raise ValueError(f"Fichier racine inattendu sans dossier conteneur : {member.name}")
            if rel is None:
                continue

            target_path = os.path.realpath(os.path.join(dest_root, *rel.split("/")))
            if not target_path.startswith(dest_root + os.sep):
                raise ValueError(f"Chemin cible hors répertoire de destination : {member.name}")

            if member.isdir():
                os.makedirs(target_path, exist_ok=True)
                continue

            extracted_files += 1
            if extracted_files > MAX_EXTRACTED_FILES:
                raise ValueError("Nombre maximal de fichiers dépassé dans l'archive de mise à jour.")
            total_bytes = _extract_regular_member_bounded(tf, member, target_path, total_bytes)

    return extracted_files


def _compile_staged_python_files(stage_dir: str) -> None:
    skip_dirs = {".venv", "venv", "tests", "pydeps", "node_modules", "__pycache__"}
    for root, dirs, filenames in os.walk(stage_dir):
        dirs[:] = [d for d in dirs if d not in skip_dirs]
        for fname in filenames:
            if not fname.endswith(".py"):
                continue
            full_path = os.path.join(root, fname)
            with open(full_path, encoding="utf-8") as fh:
                source = fh.read()
            try:
                compile(source, full_path, "exec")
            except SyntaxError as exc:
                rel = os.path.relpath(full_path, stage_dir)
                raise ValueError(f"Erreur de syntaxe Python dans {rel} (ligne {exc.lineno}) : {exc.msg}") from exc


def _validate_staged_release(stage_dir: str, image_dir: str) -> dict[str, Any]:
    for rel in REQUIRED_RELEASE_FILES:
        full = os.path.join(stage_dir, *rel.split("/"))
        if not os.path.isfile(full):
            raise ValueError(f"Mise à jour incomplète : fichier requis manquant ({rel}).")

    cfg_path = os.path.join(stage_dir, "config.py")
    with open(cfg_path, encoding="utf-8") as fh:
        cfg_text = fh.read()
    m_ver = _APP_VERSION_RE.search(cfg_text)
    app_version = m_ver.group(1) if m_ver else config.APP_VERSION

    _compile_staged_python_files(stage_dir)

    matter_changed = False
    stage_pkg = os.path.join(stage_dir, "matter_bridge", "package.json")
    image_pkg = os.path.join(image_dir, "matter_bridge", "package.json")
    if os.path.isfile(stage_pkg) and os.path.isfile(image_pkg):
        with open(stage_pkg, encoding="utf-8") as f1, open(image_pkg, encoding="utf-8") as f2:
            matter_changed = f1.read().strip() != f2.read().strip()

    return {
        "app_version": app_version,
        "matter_deps_changed": matter_changed,
    }


def _parse_requirement_lines(req_path: str) -> list[str]:
    if not os.path.isfile(req_path):
        return []
    lines: list[str] = []
    with open(req_path, encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            lines.append(line)
    return lines


def _compute_changed_requirements(stage_req: str, image_req: str) -> list[str]:
    if not os.path.isfile(stage_req) or not os.path.isfile(image_req):
        return []
    image_lines = set(_parse_requirement_lines(image_req))
    return [line for line in _parse_requirement_lines(stage_req) if line not in image_lines]


def _sync_python_dependencies_if_needed(stage_dir: str, image_dir: str) -> list[str]:
    changed = _compute_changed_requirements(
        os.path.join(stage_dir, "requirements.txt"),
        os.path.join(image_dir, "requirements.txt"),
    )
    if not changed:
        return []
    pydeps_dir = os.path.join(stage_dir, "pydeps")
    os.makedirs(pydeps_dir, exist_ok=True)
    cmd = [
        sys.executable,
        "-m",
        "pip",
        "install",
        "--no-cache-dir",
        "--disable-pip-version-check",
        "--target",
        pydeps_dir,
        *changed,
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if res.returncode != 0:
        err_tail = (res.stderr or res.stdout or "").strip()[-240:]
        raise ValueError(
            "Échec d'installation des nouvelles dépendances Python "
            f"({', '.join(changed)}) : {err_tail}. Une mise à jour de l'image Docker est requise."
        )
    return changed


def _link_matter_node_modules(stage_dir: str, image_dir: str) -> bool:
    src_nm = os.path.join(image_dir, "matter_bridge", "node_modules")
    dst_bridge = os.path.join(stage_dir, "matter_bridge")
    dst_nm = os.path.join(dst_bridge, "node_modules")
    if not os.path.isdir(src_nm) or not os.path.isdir(dst_bridge) or os.path.exists(dst_nm):
        return False
    try:
        os.symlink(src_nm, dst_nm, target_is_directory=True)
        return True
    except OSError:
        return False


def _create_pre_update_backup(data_dir: str) -> str | None:
    has_db = any(os.path.isfile(os.path.join(data_dir, name)) for name in ALLOWED_ROOT_DB_FILES)
    if not has_db:
        return None
    zip_bytes = create_backup_zip_bytes(data_dir)
    backups_dir = get_backups_root(data_dir)
    os.makedirs(backups_dir, exist_ok=True)
    filename = f"pre_update_{datetime.now().strftime('%Y%m%d_%H%M%S')}.zip"
    _write_bytes_atomically(os.path.join(backups_dir, filename), zip_bytes)

    existing = sorted(
        (os.path.join(backups_dir, f) for f in os.listdir(backups_dir) if f.endswith(".zip")),
        key=lambda p: os.path.getmtime(p),
        reverse=True,
    )
    for old_path in existing[KEEP_BACKUP_COUNT:]:
        try:
            os.remove(old_path)
        except OSError:
            continue
    return filename


def _prune_old_releases(data_dir: str, protected_ids: set[str]) -> None:
    releases_root = get_releases_root(data_dir)
    if not os.path.isdir(releases_root):
        return
    entries = []
    for name in os.listdir(releases_root):
        full = os.path.join(releases_root, name)
        if os.path.isdir(full):
            entries.append((name, full, os.path.getmtime(full)))
    entries.sort(key=lambda item: item[2], reverse=True)

    kept_non_protected = 0
    allowed_non_protected = max(0, KEEP_RELEASE_COUNT - len(protected_ids))
    for name, full, _ in entries:
        if name in protected_ids:
            continue
        if kept_non_protected < allowed_non_protected:
            kept_non_protected += 1
            continue
        shutil.rmtree(full, ignore_errors=True)


def _make_release_id(version: str, sha: str, releases_root: str) -> str:
    short_sha = (sha or "manual")[:7]
    base_raw = f"v{version.lstrip('v')}-{short_sha}" if version else short_sha
    clean_base = _SAFE_ID_CHARS_RE.sub("-", base_raw).strip(".-")[:60] or "release"
    candidate = clean_base
    if os.path.exists(os.path.join(releases_root, candidate)):
        candidate = f"{clean_base[:48]}-{int(time.time())}"
    return candidate


def _stage_and_promote_release(
    tar_path: str,
    data_dir: str,
    image_dir: str,
    *,
    sha: str,
    channel: str,
    fallback_version: str,
) -> dict[str, Any]:
    updates_root = get_updates_root(data_dir)
    releases_root = get_releases_root(data_dir)
    os.makedirs(releases_root, exist_ok=True)
    stage_dir = tempfile.mkdtemp(prefix="stage_", dir=updates_root)
    try:
        file_count = _extract_tarball_safely(tar_path, stage_dir)
        meta = _validate_staged_release(stage_dir, image_dir)
        py_deps = _sync_python_dependencies_if_needed(stage_dir, image_dir)
        _link_matter_node_modules(stage_dir, image_dir)
        backup_file = _create_pre_update_backup(data_dir)

        app_ver = meta["app_version"] or fallback_version
        release_id = _make_release_id(app_ver, sha, releases_root)
        final_dir = os.path.join(releases_root, release_id)
        os.replace(stage_dir, final_dir)
    except Exception:
        shutil.rmtree(stage_dir, ignore_errors=True)
        raise

    short_sha = sha[:7] if sha else ""
    display_ver = f"v{app_ver}+{short_sha}" if short_sha and channel != "releases" else f"v{app_ver}"
    new_release = {
        "id": release_id,
        "app_version": app_ver,
        "display_version": display_ver,
        "sha": sha,
        "channel": channel,
        "installed_at": _utc_now_iso(),
        "pending_verify": True,
        "backup_file": backup_file,
        "matter_deps_changed": meta["matter_deps_changed"],
        "py_deps_installed": py_deps,
        "file_count": file_count,
    }
    state = read_update_state(data_dir)
    prev_rel = state.get("active_release")
    state["previous_release"] = prev_rel if isinstance(prev_rel, dict) else None
    state["active_release"] = new_release
    state["last_error"] = None
    write_update_state(data_dir, state)

    protected = {release_id}
    if isinstance(prev_rel, dict) and prev_rel.get("id"):
        protected.add(str(prev_rel["id"]))
    _prune_old_releases(data_dir, protected)
    return new_release


def _record_update_error(data_dir: str, message: str) -> None:
    try:
        state = read_update_state(data_dir)
        state["last_error"] = message
        write_update_state(data_dir, state)
    except Exception:
        return


async def apply_internal_update(
    channel: str | None = None,
    force: bool = False,
    *,
    data_dir: str | None = None,
    image_dir: str | None = None,
    trigger_restart: bool = True,
) -> dict[str, Any]:
    """Télécharge, valide, installe la mise à jour dans DATA_DIR/updates et relance en interne."""
    target_data, target_image = _resolve_dirs(data_dir=data_dir, image_dir=image_dir)
    _, _, supported = _is_self_update_supported()
    if not supported:
        raise ValueError(
            "La mise à jour interne est disponible uniquement dans le conteneur Docker Nobis supervisé."
        )
    if _update_lock.locked():
        raise UpdateConflictError("Une opération de mise à jour est déjà en cours.")

    async with _update_lock:
        _set_operation("running", "check", "Vérification de la dernière version sur GitHub...", 10)
        try:
            check_res = await check_for_updates(channel=channel, data_dir=target_data)
            if not check_res["update_available"] and not force:
                _set_operation("idle", "done", check_res["message"], 100, finished=True)
                return {
                    "status": "up_to_date",
                    "version": config.APP_VERSION,
                    "sha": check_res.get("remote_sha", ""),
                    "message": check_res["message"],
                }

            updates_root = get_updates_root(target_data)
            await asyncio.to_thread(os.makedirs, updates_root, exist_ok=True)
            tar_path = os.path.join(updates_root, f"download_{os.getpid()}.tar.gz")
            try:
                _set_operation("running", "download", "Téléchargement de la mise à jour depuis GitHub...", 35)
                await _download_tarball_bounded(check_res["tarball_url"], tar_path)

                _set_operation("running", "install", "Extraction, validation et sauvegarde de sécurité...", 75)
                new_rel = await asyncio.to_thread(
                    _stage_and_promote_release,
                    tar_path,
                    target_data,
                    target_image,
                    sha=check_res["remote_sha"],
                    channel=check_res["channel"],
                    fallback_version=check_res["remote_version"],
                )
            finally:
                await asyncio.to_thread(_safe_remove_file, tar_path)

            msg = f"Mise à jour {new_rel['display_version']} installée. Redémarrage interne du serveur..."
            _set_operation("restarting", "restart", msg, 100, finished=True)
            mode = await asyncio.to_thread(get_active_mode)
            db_log("COMMAND", "UPDATE", msg, mode)
            add_container_log("WARNING", "UPDATE", msg)
            if trigger_restart:
                spawn_background_task(delayed_process_restart(0.6, reload_exit=True))
            return {
                "status": "applying",
                "release_id": new_rel["id"],
                "version": new_rel["app_version"],
                "display_version": new_rel["display_version"],
                "sha": new_rel["sha"],
                "backup_created": bool(new_rel.get("backup_file")),
                "backup_file": new_rel.get("backup_file"),
                "matter_deps_changed": bool(new_rel.get("matter_deps_changed")),
                "py_deps_installed": new_rel.get("py_deps_installed", []),
                "message": msg,
            }
        except Exception as exc:
            err_msg = str(exc) or type(exc).__name__
            await asyncio.to_thread(_record_update_error, target_data, err_msg)
            _set_operation("error", "failed", err_msg, 0, finished=True)
            raise


def _safe_remove_file(path: str) -> None:
    if os.path.isfile(path):
        try:
            os.remove(path)
        except OSError:
            return


def _perform_manual_rollback(data_dir: str) -> dict[str, Any]:
    state = read_update_state(data_dir)
    active = state.get("active_release")
    if not isinstance(active, dict) or not active.get("id"):
        raise ValueError(
            "Aucune mise à jour interne active à annuler (l'image Docker d'origine est déjà utilisée)."
        )

    failed_id = str(active["id"])
    prev = state.get("previous_release")
    restored: dict[str, Any] | None = None
    if isinstance(prev, dict) and prev.get("id"):
        prev_id = str(prev["id"])
        if prev_id != failed_id and is_valid_release_dir(data_dir, prev_id):
            restored = dict(prev)
            restored["pending_verify"] = False

    target_label = restored["display_version"] if restored else "Image Docker d'origine"
    state["active_release"] = restored
    state["previous_release"] = None
    state["last_rollback"] = {
        "reason": "manual_rollback",
        "failed_release_id": failed_id,
        "restored_release_id": restored["id"] if restored else "docker-image",
        "at": _utc_now_iso(),
        "automatic": False,
    }
    state["last_error"] = None
    write_update_state(data_dir, state)
    return {
        "failed_id": failed_id,
        "target_label": target_label,
        "restored_release_id": restored["id"] if restored else "",
    }


async def rollback_internal_update(
    *,
    data_dir: str | None = None,
    trigger_restart: bool = True,
) -> dict[str, Any]:
    """Revient manuellement à la version précédente (ou à l'image Docker d'origine) et relance."""
    target_data, _ = _resolve_dirs(data_dir=data_dir)
    if _update_lock.locked():
        raise UpdateConflictError("Une opération de mise à jour est déjà en cours.")

    async with _update_lock:
        res = await asyncio.to_thread(_perform_manual_rollback, target_data)
        msg = f"Rollback vers « {res['target_label']} » préparé. Redémarrage interne en cours..."
        _set_operation("restarting", "rollback", msg, 100, finished=True)
        mode = await asyncio.to_thread(get_active_mode)
        db_log("WARNING", "UPDATE", msg, mode)
        add_container_log("WARNING", "UPDATE", msg)
        if trigger_restart:
            spawn_background_task(delayed_process_restart(0.6, reload_exit=True))
        return {
            "status": "rolling_back",
            "rolled_back_from": res["failed_id"],
            "target_label": res["target_label"],
            "restored_release_id": res["restored_release_id"],
            "message": msg,
        }


def _mark_sha_notified(data_dir: str, sha: str) -> bool:
    state = read_update_state(data_dir)
    if not sha or state.get("last_notified_sha") == sha:
        return False
    state["last_notified_sha"] = sha
    write_update_state(data_dir, state)
    return True


async def _notify_update_available(target_data: str, check_res: dict[str, Any]) -> None:
    remote_sha = str(check_res.get("remote_sha") or "")
    first_notice = await asyncio.to_thread(_mark_sha_notified, target_data, remote_sha)
    if not first_notice:
        return
    mode = await asyncio.to_thread(get_active_mode)
    db_log("INFO", "UPDATE", check_res["message"], mode)
    add_container_log("INFO", "UPDATE", check_res["message"])
    try:
        settings = await asyncio.to_thread(get_settings_dict)
        webhook_url = (settings.get("webhook_url") or "").strip()
        if webhook_url:
            await notification_service.send_webhook(
                webhook_url,
                "⬆️ Mise à jour Nobis.Supervisor disponible",
                check_res["message"],
                f"update_{remote_sha[:7]}",
                mode,
            )
    except Exception as exc:
        add_container_log("WARNING", "UPDATE", f"Envoi webhook MAJ ignoré : {exc}")


async def scheduled_update_check_job() -> None:
    """Tâche APScheduler vérifiant périodiquement les MAJ GitHub (et auto-apply si activé)."""
    prefs = await asyncio.to_thread(get_update_settings)
    if not prefs.get("auto_check"):
        return

    target_data, _ = _resolve_dirs()
    try:
        check_res = await check_for_updates(channel=prefs["channel"], data_dir=target_data)
    except Exception as exc:
        add_container_log("WARNING", "UPDATE", f"Vérification périodique MAJ ignorée : {exc}")
        return

    if not check_res.get("update_available"):
        return

    await _notify_update_available(target_data, check_res)

    if prefs.get("auto_apply") and check_res.get("self_update_supported") and not _update_lock.locked():
        try:
            await apply_internal_update(channel=prefs["channel"], trigger_restart=True)
        except Exception as exc:
            add_container_log("ERROR", "UPDATE", f"Échec mise à jour automatique : {exc}")
