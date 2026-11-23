"""Diagnostic de persistance Docker (détection volumes anonymes/éphémères) et sauvegarde/restauration ZIP atomique."""
from datetime import datetime
import io
import json
import logging
import os
from pathlib import PurePosixPath
import posixpath
import re
import shutil
import sqlite3
import stat
import tempfile
from typing import Any
import zipfile

from config import APP_VERSION

logger = logging.getLogger("nobis.storage")

MAX_BACKUP_UPLOAD_BYTES = 100 * 1024 * 1024
MAX_BACKUP_UNCOMPRESSED_BYTES = 250 * 1024 * 1024

ALLOWED_ROOT_DB_FILES: frozenset[str] = frozenset({
    "nobis_a10_system.db",
    "nobis_a10_agua_cloud.db",
    "nobis_a10_simulation.db",
    "nobis_a10_local_gateway.db",
})
ALLOWED_ROOT_EXTRA_FILES: frozenset[str] = frozenset({".secret.key", "manifest.json"})
ALLOWED_SUBDIRS: frozenset[str] = frozenset({"matter_storage"})

_ANON_VOLUME_RE = re.compile(r"/volumes/[0-9a-f]{64}/_data(?:/|$)", re.IGNORECASE)
_NAMED_VOLUME_RE = re.compile(r"/volumes/[^/]+/_data(?:/|$)")


def _unescape_mount_path(raw: str) -> str:
    return (
        raw.replace("\\040", " ")
        .replace("\\011", "\t")
        .replace("\\012", "\n")
        .replace("\\134", "\\")
    )


def _parse_mountinfo_entries(text: str) -> list[tuple[str, str]]:
    entries: list[tuple[str, str]] = []
    for line in (text or "").splitlines():
        parts = line.split(" ")
        if len(parts) < 5:
            continue
        root = _unescape_mount_path(parts[3])
        mount_point = _unescape_mount_path(parts[4])
        entries.append((root, mount_point))
    return entries


def _find_best_mount_for_path(target_path: str, entries: list[tuple[str, str]]) -> tuple[str, str] | None:
    norm_target = target_path.rstrip("/") or "/"
    best: tuple[str, str] | None = None
    best_len = -1
    for root, mount_point in entries:
        norm_mp = mount_point.rstrip("/") or "/"
        is_match = (
            norm_mp == "/"
            or norm_target == norm_mp
            or norm_target.startswith(norm_mp + "/")
        )
        if is_match and len(norm_mp) > best_len:
            best = (root, norm_mp)
            best_len = len(norm_mp)
    return best


def _classify_docker_mount(
    target_path: str,
    best_mount: tuple[str, str] | None,
) -> tuple[str, bool, str, str]:
    if best_mount is None:
        return ("unknown", True, "unknown", "")

    root_path, mount_point = best_mount
    if mount_point == "/":
        warning = (
            f"Aucun volume persistant détecté sur {target_path} : les données seront perdues "
            "à la prochaine mise à jour du conteneur. Montez un dossier hôte ou un volume nommé sur /app/data."
        )
        return ("ephemeral", False, "container_layer", warning)

    if _ANON_VOLUME_RE.search(root_path):
        warning = (
            f"Volume Docker anonyme détecté sur {mount_point} : lors d'une mise à jour "
            "(Synology Container Manager / Watchtower), Docker crée un nouveau volume vide. "
            "Mappez explicitement un dossier persistant hôte (ex: /docker/nobis.supervisor/data:/app/data) "
            "ou un volume nommé."
        )
        return ("anonymous_volume", False, "anonymous_volume", warning)

    if _NAMED_VOLUME_RE.search(root_path):
        return ("persistent", True, "named_volume", "")

    return ("persistent", True, "bind_mount", "")


def _list_data_dir_databases(data_dir: str) -> list[dict[str, Any]]:
    dbs: list[dict[str, Any]] = []
    for name in sorted(ALLOWED_ROOT_DB_FILES):
        full = os.path.join(data_dir, name)
        exists = os.path.isfile(full)
        size = 0
        if exists:
            try:
                size = os.path.getsize(full)
            except OSError:
                size = 0
        dbs.append({"name": name, "exists": exists, "size_bytes": size})
    return dbs


def inspect_storage_persistence(
    data_dir: str | None = None,
    *,
    in_docker: bool | None = None,
    mountinfo_text: str | None = None,
) -> dict[str, Any]:
    """Analyse si DATA_DIR est sauvegardé par un montage Docker persistant (bind/volume nommé) ou à risque."""
    import database as _db_pkg

    raw_dir = data_dir or _db_pkg.DATA_DIR
    if raw_dir.startswith("/") and os.name == "nt":
        resolved_dir = posixpath.normpath(raw_dir)
    elif os.path.exists(raw_dir):
        resolved_dir = os.path.realpath(raw_dir)
    else:
        resolved_dir = os.path.abspath(raw_dir)
    is_docker = os.path.exists("/.dockerenv") if in_docker is None else bool(in_docker)
    dbs = _list_data_dir_databases(raw_dir)
    total_bytes = sum(d["size_bytes"] for d in dbs)

    if not is_docker:
        return {
            "in_docker": False,
            "data_dir": resolved_dir,
            "status": "local",
            "persistent": True,
            "mount_type": "host_fs",
            "warning": "",
            "databases": dbs,
            "total_db_bytes": total_bytes,
        }

    text = mountinfo_text
    if text is None:
        try:
            with open("/proc/self/mountinfo", encoding="utf-8", errors="replace") as fh:
                text = fh.read()
        except OSError as exc:
            logger.debug("Lecture /proc/self/mountinfo impossible : %s", exc)
            text = ""

    entries = _parse_mountinfo_entries(text)
    best_mount = _find_best_mount_for_path(resolved_dir.replace("\\", "/"), entries)
    status, persistent, mount_type, warning = _classify_docker_mount(resolved_dir, best_mount)
    return {
        "in_docker": True,
        "data_dir": resolved_dir,
        "status": status,
        "persistent": persistent,
        "mount_type": mount_type,
        "warning": warning,
        "databases": dbs,
        "total_db_bytes": total_bytes,
    }


def _snapshot_sqlite_file(src_path: str, dst_path: str) -> None:
    src_conn = sqlite3.connect(src_path, timeout=30.0)
    dst_conn = sqlite3.connect(dst_path)
    try:
        src_conn.backup(dst_conn)
    finally:
        dst_conn.close()
        src_conn.close()


def _add_subdir_to_zip(
    zf: zipfile.ZipFile,
    data_dir: str,
    rel_subdir: str,
    manifest_files: list[str],
) -> None:
    sub_root = os.path.join(data_dir, rel_subdir)
    if not os.path.isdir(sub_root):
        return
    for root, _, filenames in os.walk(sub_root):
        for fname in sorted(filenames):
            full = os.path.join(root, fname)
            if os.path.islink(full) or not os.path.isfile(full):
                continue
            rel = os.path.relpath(full, data_dir).replace("\\", "/")
            zf.write(full, arcname=rel)
            manifest_files.append(rel)


def create_backup_zip_bytes(data_dir: str | None = None) -> bytes:
    """Crée en mémoire une archive ZIP cohérente (API SQLite backup) des bases, .secret.key, certs et Matter."""
    import database as _db_pkg

    target_dir = data_dir or _db_pkg.DATA_DIR
    buf = io.BytesIO()
    manifest_files: list[str] = []

    with tempfile.TemporaryDirectory(prefix="nobis_bkp_") as tmpdir, zipfile.ZipFile(
        buf, mode="w", compression=zipfile.ZIP_DEFLATED, compresslevel=6
    ) as zf:
        for db_name in sorted(ALLOWED_ROOT_DB_FILES):
            src_db = os.path.join(target_dir, db_name)
            if not os.path.isfile(src_db):
                continue
            snap_path = os.path.join(tmpdir, db_name)
            _snapshot_sqlite_file(src_db, snap_path)
            zf.write(snap_path, arcname=db_name)
            manifest_files.append(db_name)

        secret_key_path = os.path.join(target_dir, ".secret.key")
        if os.path.isfile(secret_key_path) and not os.path.islink(secret_key_path):
            zf.write(secret_key_path, arcname=".secret.key")
            manifest_files.append(".secret.key")

        for subdir in sorted(ALLOWED_SUBDIRS):
            _add_subdir_to_zip(zf, target_dir, subdir, manifest_files)

        manifest = {
            "format": "nobis-backup-v1",
            "app_version": APP_VERSION,
            "created_at": datetime.now().isoformat(timespec="seconds"),
            "files": manifest_files,
        }
        zf.writestr("manifest.json", json.dumps(manifest, indent=2, ensure_ascii=False))

    return buf.getvalue()


def _validate_zip_member(info: zipfile.ZipInfo) -> str | None:
    unix_mode = info.external_attr >> 16
    if stat.S_ISLNK(unix_mode):
        raise ValueError(f"Lien symbolique interdit dans l'archive : {info.filename}")

    raw_name = info.filename
    if "\\" in raw_name or raw_name.startswith("/") or ":" in raw_name:
        raise ValueError(f"Chemin interdit dans l'archive : {raw_name}")

    posix_path = PurePosixPath(raw_name)
    parts = posix_path.parts
    if not parts or ".." in parts:
        raise ValueError(f"Traversée de chemin interdite : {raw_name}")

    if info.is_dir():
        if parts[0] not in ALLOWED_SUBDIRS:
            raise ValueError(f"Dossier non autorisé dans l'archive : {raw_name}")
        return None

    if len(parts) == 1:
        if parts[0] not in (ALLOWED_ROOT_DB_FILES | ALLOWED_ROOT_EXTRA_FILES):
            raise ValueError(f"Fichier non autorisé dans l'archive : {raw_name}")
        return parts[0]

    if parts[0] not in ALLOWED_SUBDIRS:
        raise ValueError(f"Sous-répertoire non autorisé dans l'archive : {raw_name}")
    return "/".join(parts)


def _validate_staged_sqlite(db_path: str, filename: str) -> None:
    conn = sqlite3.connect(db_path)
    try:
        try:
            chk = conn.execute("PRAGMA quick_check").fetchone()
            tables = {
                r[0]
                for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
            }
        except sqlite3.Error as exc:
            raise ValueError(f"Base SQLite invalide ou corrompue ({filename}) : {exc}") from exc

        if not chk or str(chk[0]).lower() != "ok":
            raise ValueError(f"Base SQLite corrompue dans la sauvegarde : {filename}")
        required_table = "settings" if filename == "nobis_a10_system.db" else "telemetry"
        if required_table not in tables:
            raise ValueError(f"Schéma SQLite invalide pour {filename} (table '{required_table}' absente).")
    finally:
        conn.close()


def _extract_member_bounded(
    zf: zipfile.ZipFile,
    info: zipfile.ZipInfo,
    dest_path: str,
    total_written: int,
) -> int:
    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
    with zf.open(info, "r") as src, open(dest_path, "wb") as dst:
        while True:
            chunk = src.read(65536)
            if not chunk:
                break
            total_written += len(chunk)
            if total_written > MAX_BACKUP_UNCOMPRESSED_BYTES:
                raise ValueError("Archive de sauvegarde trop volumineuse après décompression (limite 250 Mo).")
            dst.write(chunk)
    return total_written


def _extract_and_validate_backup(
    zip_bytes: bytes,
    stage_dir: str,
) -> tuple[list[str], list[str], bool]:
    if not zip_bytes:
        raise ValueError("Archive de sauvegarde vide.")
    if len(zip_bytes) > MAX_BACKUP_UPLOAD_BYTES:
        raise ValueError("Archive trop volumineuse (limite 100 Mo).")

    db_files: list[str] = []
    subdir_files: list[str] = []
    has_secret_key = False
    total_written = 0

    try:
        zf_ctx = zipfile.ZipFile(io.BytesIO(zip_bytes), mode="r")
    except zipfile.BadZipFile as exc:
        raise ValueError("Fichier ZIP invalide ou corrompu.") from exc

    with zf_ctx as zf:
        for info in zf.infolist():
            rel = _validate_zip_member(info)
            if rel is None or rel == "manifest.json":
                continue
            dest = os.path.join(stage_dir, *rel.split("/"))
            total_written = _extract_member_bounded(zf, info, dest, total_written)
            if rel in ALLOWED_ROOT_DB_FILES:
                db_files.append(rel)
            elif rel == ".secret.key":
                has_secret_key = True
            else:
                subdir_files.append(rel)

    if not db_files:
        raise ValueError("Aucune base de données Nobis (nobis_a10_*.db) trouvée dans l'archive.")

    for db_name in db_files:
        _validate_staged_sqlite(os.path.join(stage_dir, db_name), db_name)

    return db_files, subdir_files, has_secret_key


def _restore_sqlite_file(staged_path: str, target_path: str, *, secure_mode: bool = False) -> None:
    os.makedirs(os.path.dirname(target_path), exist_ok=True)
    src = sqlite3.connect(staged_path)
    dst = sqlite3.connect(target_path, timeout=30.0)
    try:
        src.backup(dst)
        dst.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    finally:
        dst.close()
        src.close()
    if secure_mode and os.name != "nt":
        try:
            os.chmod(target_path, 0o600)
        except OSError as exc:
            logger.debug("chmod 0600 ignoré sur %s : %s", target_path, exc)


def _restore_secret_key(staged_key: str, target_dir: str) -> None:
    target_key = os.path.join(target_dir, ".secret.key")
    tmp_key = f"{target_key}.restore.{os.getpid()}"
    shutil.copyfile(staged_key, tmp_key)
    if os.name != "nt":
        try:
            os.chmod(tmp_key, 0o600)
        except OSError as exc:
            logger.debug("chmod 0600 ignoré sur %s : %s", tmp_key, exc)
    os.replace(tmp_key, target_key)


def _restore_subdir_files(stage_dir: str, target_dir: str, subdir_files: list[str]) -> None:
    target_root = os.path.realpath(target_dir)
    for rel in subdir_files:
        src = os.path.join(stage_dir, *rel.split("/"))
        dst = os.path.join(target_dir, *rel.split("/"))
        dst_parent = os.path.dirname(dst)
        os.makedirs(dst_parent, exist_ok=True)
        if not os.path.realpath(dst_parent).startswith(target_root + os.sep):
            raise ValueError(f"Chemin cible hors DATA_DIR refusé : {rel}")
        shutil.copyfile(src, dst)


def restore_backup_zip_bytes(zip_bytes: bytes, data_dir: str | None = None) -> dict[str, Any]:
    """Valide puis restaure atomiquement une sauvegarde ZIP Nobis dans DATA_DIR (bases SQLite, .secret.key, certs, Matter)."""
    import database as _db_pkg

    target_dir = data_dir or _db_pkg.DATA_DIR
    os.makedirs(target_dir, exist_ok=True)
    restored: list[str] = []

    with tempfile.TemporaryDirectory(prefix="nobis_rst_") as stage_dir:
        db_files, subdir_files, has_secret_key = _extract_and_validate_backup(zip_bytes, stage_dir)

        if has_secret_key:
            _restore_secret_key(os.path.join(stage_dir, ".secret.key"), target_dir)
            restored.append(".secret.key")

        for db_name in sorted(db_files):
            _restore_sqlite_file(
                os.path.join(stage_dir, db_name),
                os.path.join(target_dir, db_name),
                secure_mode=(db_name == "nobis_a10_system.db"),
            )
            restored.append(db_name)

        _restore_subdir_files(stage_dir, target_dir, subdir_files)
        restored.extend(sorted(subdir_files))

    if os.path.realpath(target_dir) == os.path.realpath(_db_pkg.DATA_DIR):
        _db_pkg.reset_secret_key_cache()
        _db_pkg.reset_db_caches()
        _db_pkg.init_all_databases()

    return {
        "status": "ok",
        "restored_count": len(restored),
        "restored_files": restored,
        "message": (
            f"Sauvegarde restaurée avec succès ({len(restored)} fichier(s)). "
            "Un redémarrage du backend est recommandé si les données Matter ont changé."
        ),
    }
