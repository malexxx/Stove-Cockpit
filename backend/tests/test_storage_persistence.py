"""Tests unitaires et d'intégration pour la persistance Docker, la détection de volumes anonymes et backup/restore ZIP."""
import io
import json
import os
import sqlite3
import tempfile
from unittest.mock import patch
import zipfile

import config
import database
from services.storage_service import (
    create_backup_zip_bytes,
    inspect_storage_persistence,
    restore_backup_zip_bytes,
)
from tests.helpers import BugBountyTestCase, temporary_settings


class TestStoragePersistenceAndBackup(BugBountyTestCase):
    def test_resolve_data_dir_handles_file_directory_and_edge_cases(self):
        default_dir = "/app/data"
        self.assertEqual(config.resolve_data_dir("", default_dir), default_dir)
        self.assertEqual(config.resolve_data_dir("nobis_a10.db", default_dir), default_dir)
        self.assertEqual(
            config.resolve_data_dir("/app/data/nobis_a10.db", default_dir).replace("\\", "/"),
            "/app/data",
        )
        # DB_PATH pointant vers un répertoire ne doit PAS remonter à /app
        self.assertEqual(
            config.resolve_data_dir("/app/data", default_dir).replace("\\", "/"),
            "/app/data",
        )
        self.assertEqual(
            config.resolve_data_dir("/app/data/", default_dir).replace("\\", "/"),
            "/app/data",
        )
        self.assertEqual(
            config.resolve_data_dir("/custom/nobis_storage", default_dir).replace("\\", "/"),
            "/custom/nobis_storage",
        )
        # La racine système ne doit jamais être retenue
        self.assertEqual(config.resolve_data_dir("/", default_dir), default_dir)

        with tempfile.TemporaryDirectory() as tmpdir:
            self.assertEqual(
                os.path.normpath(config.resolve_data_dir(tmpdir, default_dir)),
                os.path.normpath(tmpdir),
            )

    def test_dockerfile_and_entrypoint_storage_hardening(self):
        with open(os.path.join(config.BASE_DIR, "Dockerfile"), encoding="utf-8") as fh:
            dockerfile = fh.read()
        self.assertIn("chown -R root:root /app", dockerfile)
        self.assertIn("chown -R nobis:nobis /app/data", dockerfile)
        self.assertNotIn("chown -R nobis:nobis /app \\", dockerfile)

        with open(os.path.join(config.BASE_DIR, "docker-entrypoint.sh"), encoding="utf-8") as fh:
            entrypoint = fh.read()
        self.assertIn("resolve_data_dir", entrypoint)
        self.assertIn("exec setpriv --reuid=nobis --regid=nobis --init-groups --", entrypoint)

    def test_inspect_storage_persistence_mountinfo_classification(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            # Hors Docker -> disque local
            local_info = inspect_storage_persistence(tmpdir, in_docker=False)
            self.assertFalse(local_info["in_docker"])
            self.assertTrue(local_info["persistent"])
            self.assertEqual(local_info["status"], "local")
            self.assertEqual(local_info["mount_type"], "host_fs")
            self.assertEqual(local_info["warning"], "")

        # Volume anonyme Docker (cas Synology réel)
        mi_anon = (
            "100 99 0:42 / / rw,relatime - overlay overlay rw\n"
            "101 100 253:1 /@docker/volumes/bc719070846038b6ddd55470d5686a7a72cec76e76fa0a46f43a85e58c7c2b76/_data "
            "/app/data rw,relatime - ext4 /dev/mapper/cachedev_0 rw\n"
        )
        anon_info = inspect_storage_persistence("/app/data", in_docker=True, mountinfo_text=mi_anon)
        self.assertEqual(anon_info["status"], "anonymous_volume")
        self.assertFalse(anon_info["persistent"])
        self.assertEqual(anon_info["mount_type"], "anonymous_volume")
        self.assertIn("Volume Docker anonyme", anon_info["warning"])

        # Volume nommé Docker
        mi_named = (
            "100 99 0:42 / / rw,relatime - overlay overlay rw\n"
            "101 100 253:1 /@docker/volumes/nobis_nobis_data/_data /app/data rw,relatime - ext4 /dev/sda1 rw\n"
        )
        named_info = inspect_storage_persistence("/app/data", in_docker=True, mountinfo_text=mi_named)
        self.assertEqual(named_info["status"], "persistent")
        self.assertTrue(named_info["persistent"])
        self.assertEqual(named_info["mount_type"], "named_volume")
        self.assertEqual(named_info["warning"], "")

        # Bind mount hôte
        mi_bind = (
            "100 99 0:42 / / rw,relatime - overlay overlay rw\n"
            "101 100 253:1 /docker/nobis.supervisor/data /app/data rw,relatime - btrfs /dev/vg1/volume_1 rw\n"
        )
        bind_info = inspect_storage_persistence("/app/data", in_docker=True, mountinfo_text=mi_bind)
        self.assertEqual(bind_info["status"], "persistent")
        self.assertTrue(bind_info["persistent"])
        self.assertEqual(bind_info["mount_type"], "bind_mount")
        self.assertEqual(bind_info["warning"], "")

        # Aucun volume sur /app/data (couche éphémère)
        mi_ephemeral = "100 99 0:42 / / rw,relatime - overlay overlay rw\n"
        eph_info = inspect_storage_persistence("/app/data", in_docker=True, mountinfo_text=mi_ephemeral)
        self.assertEqual(eph_info["status"], "ephemeral")
        self.assertFalse(eph_info["persistent"])
        self.assertEqual(eph_info["mount_type"], "container_layer")
        self.assertIn("Aucun volume persistant", eph_info["warning"])

    def test_backup_and_restore_roundtrip_preserves_encrypted_secrets_and_telemetry(self):
        with tempfile.TemporaryDirectory() as src_dir, tempfile.TemporaryDirectory() as dst_dir:
            src_sys = os.path.join(src_dir, "nobis_a10_system.db")
            src_modes = {
                "simulation": os.path.join(src_dir, "nobis_a10_simulation.db"),
                "agua_cloud": os.path.join(src_dir, "nobis_a10_agua_cloud.db"),
                "local_gateway": os.path.join(src_dir, "nobis_a10_local_gateway.db"),
            }
            with (
                patch.object(database, "DATA_DIR", src_dir),
                patch.object(database, "SYSTEM_DB_PATH", src_sys),
                patch.object(database, "MODE_DB_PATHS", src_modes),
                patch.dict(os.environ, {}, clear=False),
            ):
                os.environ.pop("NOBIS_SECRET_KEY", None)
                database.reset_secret_key_cache()
                database.reset_db_caches()
                database.init_all_databases()

                sconn = database.get_sys_db()
                try:
                    sconn.execute(
                        "INSERT OR REPLACE INTO settings (key, value) VALUES ('agua_email', 'owner@nobis.test')"
                    )
                    sconn.execute(
                        "INSERT OR REPLACE INTO settings (key, value) VALUES ('agua_password', ?)",
                        (database.encrypt_secret("MyAguaSecret!42"),),
                    )
                    sconn.commit()
                finally:
                    sconn.close()

                aconn = database.get_db("agua_cloud")
                try:
                    aconn.execute(
                        "INSERT INTO telemetry (timestamp, epoch, comm_mode, status_code, temp_ambient, raw_buffer_json) "
                        "VALUES ('2026-11-22 08:00:00', 1795330800, 'agua_cloud', 5, 21.4, '{\"8\": 5}')"
                    )
                    aconn.commit()
                finally:
                    aconn.close()

                os.makedirs(os.path.join(src_dir, "matter_storage"), exist_ok=True)
                with open(os.path.join(src_dir, "matter_storage", "node.json"), "w", encoding="utf-8") as fh:
                    fh.write('{"node": 1}')

                zip_bytes = create_backup_zip_bytes(src_dir)

            with zipfile.ZipFile(io.BytesIO(zip_bytes), "r") as zf:
                names = set(zf.namelist())
                self.assertIn("manifest.json", names)
                self.assertIn(".secret.key", names)
                self.assertIn("nobis_a10_system.db", names)
                self.assertIn("nobis_a10_agua_cloud.db", names)
                self.assertIn("matter_storage/node.json", names)
                manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
                self.assertEqual(manifest["format"], "nobis-backup-v1")

            dst_sys = os.path.join(dst_dir, "nobis_a10_system.db")
            dst_modes = {
                "simulation": os.path.join(dst_dir, "nobis_a10_simulation.db"),
                "agua_cloud": os.path.join(dst_dir, "nobis_a10_agua_cloud.db"),
                "local_gateway": os.path.join(dst_dir, "nobis_a10_local_gateway.db"),
            }
            with (
                patch.object(database, "DATA_DIR", dst_dir),
                patch.object(database, "SYSTEM_DB_PATH", dst_sys),
                patch.object(database, "MODE_DB_PATHS", dst_modes),
                patch.dict(os.environ, {}, clear=False),
            ):
                os.environ.pop("NOBIS_SECRET_KEY", None)
                res = restore_backup_zip_bytes(zip_bytes, dst_dir)
                self.assertEqual(res["status"], "ok")
                self.assertIn(".secret.key", res["restored_files"])
                self.assertIn("nobis_a10_system.db", res["restored_files"])
                self.assertIn("nobis_a10_agua_cloud.db", res["restored_files"])

                restored_settings = database.get_settings_dict()
                self.assertEqual(restored_settings["agua_email"], "owner@nobis.test")
                self.assertEqual(restored_settings["agua_password"], "MyAguaSecret!42")

                rconn = sqlite3.connect(dst_modes["agua_cloud"])
                try:
                    row = rconn.execute("SELECT temp_ambient FROM telemetry WHERE epoch = 1795330800").fetchone()
                    self.assertIsNotNone(row)
                    self.assertAlmostEqual(row[0], 21.4, places=1)
                finally:
                    rconn.close()

                with open(os.path.join(dst_dir, "matter_storage", "node.json"), encoding="utf-8") as fh:
                    self.assertEqual(fh.read(), '{"node": 1}')

    def test_restore_rejects_malicious_and_corrupt_archives(self):
        def _make_zip(entries: list[tuple[str, bytes, int | None]]) -> bytes:
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w") as zf:
                for name, content, mode in entries:
                    zi = zipfile.ZipInfo(name)
                    if mode is not None:
                        zi.external_attr = mode << 16
                    zf.writestr(zi, content)
            return buf.getvalue()

        with tempfile.TemporaryDirectory() as tmpdir:
            with self.assertRaises(ValueError):
                restore_backup_zip_bytes(b"", tmpdir)
            with self.assertRaises(ValueError):
                restore_backup_zip_bytes(b"not-a-zip", tmpdir)
            with self.assertRaises(ValueError):
                restore_backup_zip_bytes(_make_zip([("../escape.db", b"x", None)]), tmpdir)
            with self.assertRaises(ValueError):
                restore_backup_zip_bytes(_make_zip([("evil.py", b"print(1)", None)]), tmpdir)
            with self.assertRaises(ValueError):
                restore_backup_zip_bytes(_make_zip([("certs/link", b"/etc/passwd", 0o120777)]), tmpdir)
            with self.assertRaises(ValueError):
                restore_backup_zip_bytes(_make_zip([("manifest.json", b"{}", None)]), tmpdir)
            with self.assertRaises(ValueError):
                restore_backup_zip_bytes(_make_zip([("nobis_a10_system.db", b"corrupted", None)]), tmpdir)

            # Base SQLite valide mais sans table 'settings'
            empty_db_path = os.path.join(tmpdir, "empty.db")
            c = sqlite3.connect(empty_db_path)
            c.execute("CREATE TABLE other (id INTEGER)")
            c.commit()
            c.close()
            with open(empty_db_path, "rb") as fh:
                bad_schema_bytes = fh.read()
            with self.assertRaises(ValueError):
                restore_backup_zip_bytes(_make_zip([("nobis_a10_system.db", bad_schema_bytes, None)]), tmpdir)

    def test_storage_and_backup_http_endpoints(self):
        r_storage = self.client.get("/api/system/storage")
        self.assertEqual(r_storage.status_code, 200)
        st = r_storage.json()
        self.assertIn("status", st)
        self.assertIn("persistent", st)
        self.assertIn("mount_type", st)
        self.assertIn("databases", st)

        r_health = self.client.get("/health")
        self.assertEqual(r_health.status_code, 200)
        self.assertIn("storage_status", r_health.json())
        self.assertIn("storage_persistent", r_health.json())

        with temporary_settings({"comm_mode": "simulation", "agua_password": "bkp-secret-pass"}):
            # Archive invalide -> 400
            r_bad = self.client.post(
                "/api/system/backup/restore",
                content=b"not-a-zip",
                headers={"Content-Type": "application/zip"},
            )
            self.assertEqual(r_bad.status_code, 400)

            # Export + restauration isolés sur répertoire temporaire
            with tempfile.TemporaryDirectory() as iso_dir:
                iso_sys = os.path.join(iso_dir, "nobis_a10_system.db")
                iso_modes = {
                    "simulation": os.path.join(iso_dir, "nobis_a10_simulation.db"),
                    "agua_cloud": os.path.join(iso_dir, "nobis_a10_agua_cloud.db"),
                    "local_gateway": os.path.join(iso_dir, "nobis_a10_local_gateway.db"),
                }
                with (
                    patch.object(database, "DATA_DIR", iso_dir),
                    patch.object(database, "SYSTEM_DB_PATH", iso_sys),
                    patch.object(database, "MODE_DB_PATHS", iso_modes),
                ):
                    database.reset_db_caches()
                    database.init_all_databases()
                    sconn = database.get_sys_db()
                    try:
                        sconn.execute(
                            "INSERT OR REPLACE INTO settings (key, value) VALUES ('agua_password', ?)",
                            (database.encrypt_secret("bkp-secret-pass"),),
                        )
                        sconn.commit()
                    finally:
                        sconn.close()

                    r_dl = self.client.get("/api/system/backup")
                    self.assertEqual(r_dl.status_code, 200)
                    self.assertEqual(r_dl.headers.get("content-type"), "application/zip")
                    self.assertIn("attachment; filename=", r_dl.headers.get("content-disposition", ""))

                    r_rst = self.client.post(
                        "/api/system/backup/restore",
                        content=r_dl.content,
                        headers={"Content-Type": "application/zip"},
                    )
                    self.assertEqual(r_rst.status_code, 200)
                    self.assertEqual(r_rst.json()["status"], "ok")
