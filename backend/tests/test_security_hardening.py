# -*- coding: utf-8 -*-
"""Tests de durcissement sécurité, anti-SSRF, anti-CSRF/CSP/SSE, déploiement Docker & persistance."""
import asyncio
import importlib.util
import os
import socket
import sqlite3
import tempfile
from unittest.mock import patch

from starlette.requests import Request

import clients
import telemetry
from config import BASE_DIR
from database import get_db
from main import MAX_SSE_SUBSCRIBERS
from services.client_ip import _get_client_ip
from tests.helpers import BugBountyTestCase, get_matter_webhook_headers, temporary_settings


class TestSecurityHardening(BugBountyTestCase):
    def test_bb01_privileged_endpoints_accessible_without_installer_auth(self):
        with temporary_settings({"comm_mode": "simulation", "agua_password": "bb01-test-password"}):
            snap_resp = self.client.post("/api/snapshots", json={"label": "bb01-temp"})
            self.assertEqual(snap_resp.status_code, 200)
            snap_id = snap_resp.json()["id"]
            del_resp = self.client.delete(f"/api/snapshots/{snap_id}")
            self.assertEqual(del_resp.status_code, 200)

            non_priv = self.client.post(
                "/api/command",
                json={"reg_key": "power_level", "offset": 33120, "value": 4.0},
            )
            self.assertEqual(non_priv.status_code, 200)

    def test_bb03_ssrf_webhook_and_local_gateway_validation(self):
        blocked_webhooks = [
            "http://127.0.0.1:8080/hook",
            "http://localhost/hook",
            "http://169.254.169.254/latest/meta-data",
            "http://[::1]/hook",
            "http://[::ffff:127.0.0.1]/hook",
            "http://10.0.0.5/hook",
            "http://192.168.1.50/hook",
            "http://172.16.0.1/hook",
            "ftp://example.com/hook",
            "file:///etc/passwd",
        ]
        for url in blocked_webhooks:
            self.assertFalse(clients.is_safe_webhook_url(url), msg=f"Should block webhook URL: {url}")

        with patch("socket.getaddrinfo", return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))]):
            self.assertFalse(clients.is_safe_webhook_url("https://rebind.example.com/hook"))

        with patch("socket.getaddrinfo", return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))]):
            self.assertTrue(clients.is_safe_webhook_url("https://hooks.example.com/webhook"))

        self.assertTrue(clients.is_safe_gateway_url("http://192.168.1.50"))
        self.assertTrue(clients.is_safe_gateway_url("http://10.0.0.12:8088"))
        for bad_gw in [
            "http://127.0.0.1:8080",
            "http://localhost:5549",
            "http://169.254.169.254",
            "http://[::1]/",
            "http://192.168.1.50:1220",
            "http://192.168.1.50:1221",
            "http://192.168.1.50:8080",
            "http://192.168.1.50:5549",
        ]:
            self.assertFalse(clients.is_safe_gateway_url(bad_gw), msg=f"Should block gateway URL: {bad_gw}")

        with temporary_settings({"comm_mode": "simulation", "agua_password": "bb03-pass"}):
            self.assertEqual(
                self.client.post(
                    "/api/settings",
                    json={"webhook_url": "http://169.254.169.254/latest/meta-data"},
                ).status_code,
                400,
            )
            self.assertEqual(
                self.client.post(
                    "/api/settings",
                    json={"local_gateway_url": "http://127.0.0.1:8080"},
                ).status_code,
                400,
            )

    def test_bb08_anti_csrf_csp_and_sse_limit(self):
        with temporary_settings({"comm_mode": "simulation"}):
            r_form = self.client.post(
                "/api/command",
                data="reg_key=power_level&offset=33120&value=3",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            self.assertIn(r_form.status_code, (403, 415))

            r_evil = self.client.post(
                "/api/command",
                json={"reg_key": "power_level", "offset": 33120, "value": 4.0},
                headers={"Origin": "https://evil.example"},
            )
            self.assertEqual(r_evil.status_code, 401)

            r_null = self.client.post(
                "/api/command",
                json={"reg_key": "power_level", "offset": 33120, "value": 4.0},
                headers={"Origin": "null"},
            )
            self.assertEqual(r_null.status_code, 403)

            sim_conn = get_db("simulation")
            orig_status = sim_conn.execute(
                "SELECT current_val FROM registers_catalog WHERE reg_key = 'status_code'"
            ).fetchone()["current_val"]
            sim_conn.close()
            try:
                r_hook = self.client.post(
                    "/api/matter/webhook",
                    json={"action": "set_power", "state": "ON"},
                    headers=get_matter_webhook_headers({"Origin": "https://matter-bridge.example"}),
                )
                self.assertEqual(r_hook.status_code, 200)
            finally:
                sim_conn = get_db("simulation")
                try:
                    sim_conn.execute(
                        "UPDATE registers_catalog SET current_val = ? WHERE reg_key = 'status_code'",
                        (orig_status,),
                    )
                    sim_conn.commit()
                finally:
                    sim_conn.close()

        r_health = self.client.get("/health")
        self.assertEqual(r_health.status_code, 200)
        self.assertIn("content-security-policy", {k.lower(): v for k, v in r_health.headers.items()})

        dummy_queues = [asyncio.Queue(maxsize=1) for _ in range(MAX_SSE_SUBSCRIBERS)]
        telemetry.sse_subscribers.update(dummy_queues)
        try:
            r_sse = self.client.get("/api/events")
            self.assertEqual(r_sse.status_code, 503)
        finally:
            for q in dummy_queues:
                telemetry.sse_subscribers.discard(q)

    def test_bb09_forwarded_ip_lookup(self):
        proxied_scope = {
            "type": "http",
            "method": "POST",
            "path": "/api/logs/client-error",
            "headers": [(b"x-forwarded-for", b"203.0.113.42, 10.0.0.1")],
            "client": ("127.0.0.1", 54321),
        }
        self.assertEqual(_get_client_ip(Request(proxied_scope)), "203.0.113.42")

        spoofed_scope = {
            "type": "http",
            "method": "POST",
            "path": "/api/logs/client-error",
            "headers": [(b"x-forwarded-for", b"1.2.3.4")],
            "client": ("198.51.100.5", 54321),
        }
        self.assertEqual(_get_client_ip(Request(spoofed_scope)), "198.51.100.5")

    def test_bb15_batch_max_length_and_deployment_hardening(self):
        with temporary_settings({"comm_mode": "simulation"}):
            cmds_65 = [{"reg_key": "power_level", "offset": 33120, "value": 4.0} for _ in range(65)]
            r_65 = self.client.post("/api/command-batch", json={"commands": cmds_65})
            self.assertEqual(r_65.status_code, 422)

        with open(os.path.join(BASE_DIR, "Dockerfile"), encoding="utf-8") as f:
            dockerfile = f.read()
        self.assertIn("--workers", dockerfile)
        self.assertIn("--proxy-headers", dockerfile)
        self.assertIn("--forwarded-allow-ips", dockerfile)
        self.assertIn('VOLUME ["/app/data"]', dockerfile)
        self.assertIn("FROM node:26-trixie-slim AS node-builder", dockerfile)
        self.assertIn("FROM python:3.12-slim-trixie", dockerfile)
        self.assertIn('org.opencontainers.image.licenses="MIT"', dockerfile)
        self.assertIn('org.opencontainers.image.source="https://github.com/malexxx/Stove-Cockpit"', dockerfile)
        self.assertIn("tini", dockerfile)
        self.assertIn("gosu", dockerfile)
        self.assertIn("urllib.request", dockerfile)
        self.assertNotIn("curl", dockerfile)
        self.assertNotIn("acme.sh", dockerfile)
        self.assertIn('ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]', dockerfile)

        entrypoint_path = os.path.join(BASE_DIR, "docker-entrypoint.sh")
        self.assertTrue(os.path.isfile(entrypoint_path))
        with open(entrypoint_path, encoding="utf-8") as f:
            entrypoint = f.read()
        self.assertIn('exec gosu nobis:nobis "$@"', entrypoint)

        repo_root = os.path.dirname(BASE_DIR)
        wf_pub = os.path.join(repo_root, ".github", "workflows", "docker-publish.yml")
        if os.path.isfile(wf_pub):
            with open(wf_pub, encoding="utf-8") as f:
                publish_yml = f.read()
            self.assertIn("sbom: true", publish_yml)
            self.assertIn("provenance: true", publish_yml)

        self.assertFalse(os.path.exists(os.path.join(BASE_DIR, "Dockerfile.txt")))

        with open(os.path.join(BASE_DIR, "docker-compose.yml"), encoding="utf-8") as f:
            compose = f.read()
        self.assertIn("8080:8080", compose)
        self.assertIn("stove_data:/app/data", compose)
        self.assertNotIn("caddy", compose.lower())

        r_spa = self.client.get("/")
        self.assertEqual(r_spa.status_code, 200)

        r_health = self.client.get("/health")
        self.assertEqual(r_health.status_code, 200)
        self.assertTrue(r_health.json().get("docker_version", "").startswith("v"))

    def test_docker_persistence_and_env_settings_fallback(self):
        """Vérifie le fallback DATA_DIR si DB_PATH est relatif et l'initialisation par variables d'env."""
        import database

        with patch.dict(os.environ, {"DB_PATH": "nobis_a10.db"}):
            spec = importlib.util.spec_from_file_location("config_isolated", os.path.join(BASE_DIR, "config.py"))
            cfg_mod = importlib.util.module_from_spec(spec)
            assert spec and spec.loader
            spec.loader.exec_module(cfg_mod)
            self.assertTrue(os.path.isabs(cfg_mod.DATA_DIR))
            self.assertEqual(cfg_mod.DATA_DIR, cfg_mod._DEFAULT_DATA_DIR)

        with tempfile.TemporaryDirectory() as tmpdir:
            sys_db = os.path.join(tmpdir, "nobis_a10_system.db")
            mode_dbs = {
                "simulation": os.path.join(tmpdir, "nobis_a10_simulation.db"),
                "agua_cloud": os.path.join(tmpdir, "nobis_a10_agua_cloud.db"),
                "local_gateway": os.path.join(tmpdir, "nobis_a10_local_gateway.db"),
            }
            with patch.object(database, "DATA_DIR", tmpdir), \
                 patch.object(database, "SYSTEM_DB_PATH", sys_db), \
                 patch.object(database, "MODE_DB_PATHS", mode_dbs):
                # 1. Premier démarrage sans variables d'env : email/mdp vides
                with patch.dict(os.environ, {}, clear=False):
                    for k in ("COMM_MODE", "AGUA_EMAIL", "AGUA_PASSWORD", "AGUA_UUID", "AGUA_ID_DEVICE", "AGUA_ID_PRODUCT", "LOCAL_GATEWAY_URL"):
                        os.environ.pop(k, None)
                    database.init_all_databases()

                conn = sqlite3.connect(sys_db)
                conn.row_factory = sqlite3.Row
                rows = {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM settings").fetchall()}
                conn.close()
                self.assertEqual(rows["agua_email"], "")
                self.assertEqual(rows["agua_password"], "")

                # 2. Redémarrage avec variables d'env : remplit les champs vides sans écraser les valeurs déjà définies
                conn = sqlite3.connect(sys_db)
                conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('comm_mode', 'simulation')")
                conn.commit()
                conn.close()

                with patch.dict(os.environ, {
                    "COMM_MODE": "agua_cloud",
                    "AGUA_EMAIL": "user@nobis.test",
                    "AGUA_PASSWORD": "secret-pass",
                    "LOCAL_GATEWAY_URL": "http://192.168.1.200",
                }):
                    database.init_all_databases()

                conn = sqlite3.connect(sys_db)
                conn.row_factory = sqlite3.Row
                rows2 = {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM settings").fetchall()}
                conn.close()
                self.assertEqual(rows2["agua_email"], "user@nobis.test")
                # Le mot de passe doit être chiffré au repos (Fernet) en SQLite et déchiffré par get_settings_dict()
                self.assertTrue(rows2["agua_password"].startswith("enc:v1:"))
                self.assertNotEqual(rows2["agua_password"], "secret-pass")
                self.assertEqual(database.get_settings_dict()["agua_password"], "secret-pass")
                # comm_mode déjà non-vide en base reste préservé
                self.assertEqual(rows2["comm_mode"], "simulation")
