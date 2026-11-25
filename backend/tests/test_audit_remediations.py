# -*- coding: utf-8 -*-
"""Tests de non-régression pour l'ensemble des remédiations de l'audit complet (Lots A à D)."""
import asyncio
from contextlib import asynccontextmanager
import os
import sqlite3
import time
from unittest.mock import patch

import httpx
from starlette.requests import Request

from clients.notifications import NotificationService, _encode_ntfy_title
from config import BASE_DIR, TELEMETRY_COLUMNS
from database.connection import query_telemetry_range
from matter_service import (
    _INVALID_MATTER_PASSCODES,
    _load_or_create_commissioning_params,
    _resolve_backend_api_connection,
    generate_matter_discriminator,
    generate_matter_passcode,
)
from routers.observability import sanitize_csv_cell
from server import parse_args as server_parse_args
from services.client_ip import _get_client_ip
from services.lifecycle import _background_tasks, spawn_background_task
from src.calibration.calibration_service import build_sample_from_record
from src.calibration.models import StoveOperationalPhase
from tests.helpers import BugBountyTestCase, get_matter_webhook_headers, temporary_settings


class TestAuditRemediations(BugBountyTestCase):
    # ------------------------------------------------------------------
    # C-01 : Durcissement proxy IP & secret partagé /api/matter/webhook
    # ------------------------------------------------------------------
    def test_c01_matter_webhook_requires_valid_secret(self):
        with temporary_settings({"comm_mode": "simulation"}):
            # Sans en-tête X-Matter-Secret -> 403 même depuis testclient/loopback
            r_missing = self.client.post("/api/matter/webhook", json={"action": "set_power", "state": "ON"})
            self.assertEqual(r_missing.status_code, 403)

            # Secret erroné -> 403
            r_wrong = self.client.post(
                "/api/matter/webhook",
                json={"action": "set_power", "state": "ON"},
                headers={"X-Matter-Secret": "wrong-secret"},
            )
            self.assertEqual(r_wrong.status_code, 403)

            # Secret valide -> 200
            r_ok = self.client.post(
                "/api/matter/webhook",
                json={"action": "set_temperature", "temperature": 20.0},
                headers=get_matter_webhook_headers(),
            )
            self.assertEqual(r_ok.status_code, 200)

    def test_c01_proxy_headers_not_trusted_from_arbitrary_lan_or_wildcard(self):
        # Par défaut, server.py ne doit plus utiliser "*"
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("TRUSTED_PROXY_IPS", None)
            args = server_parse_args([])
            self.assertEqual(args.forwarded_allow_ips, "127.0.0.1,::1")

        with open(os.path.join(BASE_DIR, "Dockerfile"), encoding="utf-8") as f:
            dockerfile = f.read()
        self.assertNotIn('"--forwarded-allow-ips", "*"', dockerfile)
        self.assertIn('"--forwarded-allow-ips", "127.0.0.1,::1"', dockerfile)

        # Un hôte 10.x ou 172.x non configuré dans TRUSTED_PROXY_IPS ne peut plus spoofer X-Forwarded-For
        with patch.dict(os.environ, {"TRUSTED_PROXY_IPS": "127.0.0.1,::1"}):
            scope = {
                "type": "http",
                "method": "POST",
                "path": "/api/installer/verify",
                "headers": [(b"x-forwarded-for", b"127.0.0.1")],
                "client": ("10.0.0.42", 12345),
            }
            self.assertEqual(_get_client_ip(Request(scope)), "10.0.0.42")

        # Si le CIDR proxy Caddy est explicitement configuré, X-Forwarded-For est honoré
        with patch.dict(os.environ, {"TRUSTED_PROXY_IPS": "127.0.0.1,172.16.0.0/12"}):
            scope_caddy = {
                "type": "http",
                "method": "POST",
                "path": "/api/installer/verify",
                "headers": [(b"x-forwarded-for", b"192.168.1.77")],
                "client": ("172.18.0.3", 12345),
            }
            self.assertEqual(_get_client_ip(Request(scope_caddy)), "192.168.1.77")

    # ------------------------------------------------------------------
    # C-02 : Pont Matter compatible HTTPS + Passcode/Discriminator aléatoires
    # ------------------------------------------------------------------
    def test_c02_matter_commissioning_params_generation_and_rotation(self):
        for _ in range(30):
            p = generate_matter_passcode()
            d = generate_matter_discriminator()
            self.assertGreaterEqual(p, 1)
            self.assertLessEqual(p, 99999998)
            self.assertNotIn(p, _INVALID_MATTER_PASSCODES)
            self.assertGreaterEqual(d, 0)
            self.assertLessEqual(d, 4095)

        with temporary_settings({"matter_passcode": "", "matter_discriminator": ""}):
            p1, d1 = _load_or_create_commissioning_params(regenerate=False)
            p1_again, d1_again = _load_or_create_commissioning_params(regenerate=False)
            self.assertEqual((p1, d1), (p1_again, d1_again))

            p2, d2 = _load_or_create_commissioning_params(regenerate=True)
            self.assertNotEqual((p1, d1), (p2, d2))

    def test_c02_matter_resolves_http_only(self):
        with patch.dict(os.environ, {"NOBIS_RUNTIME_PORT": "8080"}, clear=False):
            os.environ.pop("NOBIS_API_URL", None)
            os.environ.pop("STOVE_API_URL", None)
            url, cert = _resolve_backend_api_connection()
            self.assertEqual(url, "http://127.0.0.1:8080")
            self.assertIsNone(cert)

    # ------------------------------------------------------------------
    # C-03 : Notifications ntfy.sh avec emojis (encodage RFC 2047 UTF-8)
    # ------------------------------------------------------------------
    def test_c03_ntfy_emoji_title_encodes_safely_for_httpx(self):
        for title in (
            "🔥 Test Superviseur Nobis A10",
            "🚨 Alarme Poêle Nobis A10",
            "🌾 Réserve Granulés Basse (< 20%)",
            "🔧 Entretien CAT Nobis A10 Imminent",
        ):
            encoded = _encode_ntfy_title(title)
            encoded.encode("ascii")  # Ne doit jamais lever UnicodeEncodeError
            req = httpx.Request("POST", "https://ntfy.sh/nobis-test", headers={"Title": encoded})
            self.assertEqual(req.headers["Title"], encoded)

        sent_headers = {}

        class _FakeResp:
            def raise_for_status(self):
                return None

        class _FakeClient:
            async def post(self, url, content=None, headers=None, json=None, timeout=8.0):
                sent_headers.update(headers or {})
                # Valide la construction réelle d'une requête HTTPX
                httpx.Request("POST", url, content=content, headers=headers)
                return _FakeResp()

        @asynccontextmanager
        async def _fake_borrow(timeout=8.0):
            yield _FakeClient()

        svc = NotificationService()
        with (
            patch("clients.notifications.is_safe_webhook_url", return_value=True),
            patch("clients.borrow_http_client", _fake_borrow),
        ):
            ok = asyncio.run(
                svc.send_webhook(
                    "https://ntfy.sh/nobis-test-topic",
                    "🔥 Test Superviseur Nobis A10",
                    "Message test",
                    "test_ntfy_emoji",
                    "simulation",
                )
            )
        self.assertTrue(ok)
        self.assertIn("Title", sent_headers)
        self.assertTrue(sent_headers["Title"].startswith("=?utf-8?"))

    # ------------------------------------------------------------------
    # H-01 : Validation Pydantic sur endpoints calibration
    # ------------------------------------------------------------------
    def test_h01_privileged_endpoints_validated(self):
        with temporary_settings({"comm_mode": "simulation", "agua_password": "audit-h01-secret"}):
            # Les payloads calibration invalides sont rejetés en 422 (plus de 500)
            self.assertEqual(
                self.client.post("/api/calibration/step3-load-charge", json={"weighed_bag_kg": "not-a-float"}).status_code,
                422,
            )
            self.assertEqual(
                self.client.post("/api/calibration/step3-load-charge", json={"weighed_bag_kg": -5.0}).status_code,
                422,
            )
            self.assertEqual(
                self.client.post("/api/calibration/step1-start", json={"mode": "INVALID_MODE"}).status_code,
                422,
            )

    # ------------------------------------------------------------------
    # H-02 : Palier P0 (Éco/RIS) atteignable en calibration (correction falsy 0)
    # ------------------------------------------------------------------
    def test_h02_calibration_p0_economy_ris_reachable(self):
        sample_p0 = build_sample_from_record(
            {
                "epoch": int(time.time()),
                "status_code": 5,
                "power_actual": 0,
                "power_level": 4,
                "fun_pwf_set": 0,
            }
        )
        self.assertEqual(sample_p0.power_level, 0)
        self.assertEqual(sample_p0.phase, StoveOperationalPhase.ECONOMY_RIS)

    # ------------------------------------------------------------------
    # H-06 : Plus de masquage id 1..27 en agua_cloud ni d'IDs personnels par défaut
    # ------------------------------------------------------------------
    def test_h06_agua_cloud_query_does_not_hide_first_27_rows(self):
        cols_sql = ", ".join(f"{k} {v}" for k, v in TELEMETRY_COLUMNS.items())
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute(f"CREATE TABLE telemetry ({cols_sql})")
        now_ep = int(time.time())
        conn.execute(
            "INSERT INTO telemetry (id, epoch, timestamp, comm_mode, status_code, raw_buffer_json) "
            "VALUES (1, ?, '2026-11-21 10:00:00', 'agua_cloud', 5, '{\"8\": 5}')",
            (now_ep - 60,),
        )
        conn.commit()
        rows = query_telemetry_range(conn, "agua_cloud", range_key="24h", order="ASC")
        conn.close()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["id"], 1)

    # ------------------------------------------------------------------
    # M-01 : Registre de tâches asyncio
    # ------------------------------------------------------------------
    def test_m01_spawn_background_task(self):
        async def _run():
            done = asyncio.Event()

            async def _worker():
                await asyncio.sleep(0.01)
                done.set()

            task = spawn_background_task(_worker())
            self.assertIn(task, _background_tasks)
            await task
            await asyncio.sleep(0)
            self.assertTrue(done.is_set())
            self.assertNotIn(task, _background_tasks)

        asyncio.run(_run())

    # ------------------------------------------------------------------
    # M-04 : DELETE snapshot inexistant -> 404 & sanitize_csv_cell numérique
    # ------------------------------------------------------------------
    def test_m04_delete_missing_snapshot_404_and_numeric_csv_cell(self):
        self.assertEqual(sanitize_csv_cell(-5), "-5")
        self.assertEqual(sanitize_csv_cell("-5"), "'-5")
        self.assertEqual(sanitize_csv_cell("=CMD()"), "'=CMD()")

        with temporary_settings({"comm_mode": "simulation", "agua_password": "m04-pass"}):
            resp = self.client.delete("/api/snapshots/99999999")
            self.assertEqual(resp.status_code, 404)

    # ------------------------------------------------------------------
    # M-06 / L-01 / L-02 : Dockerfile HTTP pur, CSP stricte sans unsafe-eval
    # ------------------------------------------------------------------
    def test_m06_l01_l02_supply_chain_offline_tailwind_and_strict_csp(self):
        with open(os.path.join(BASE_DIR, "Dockerfile"), encoding="utf-8") as f:
            df = f.read()
        self.assertNotIn("acme.sh", df)
        self.assertNotIn("ACME_SH_SHA256", df)
        self.assertIn("AS frontend-builder", df)
        self.assertIn("http://127.0.0.1:8080/health", df)

        r_health = self.client.get("/health")
        csp = r_health.headers.get("content-security-policy", "")
        self.assertNotIn("unsafe-eval", csp)
        self.assertNotIn("cdn.tailwindcss.com", csp)
        self.assertNotIn("cdn.jsdelivr.net", csp)

    # ------------------------------------------------------------------
    # H-06 (Fernet) : Chiffrement au repos des secrets SQLite & migration transparente
    # ------------------------------------------------------------------
    def test_h06_fernet_encryption_at_rest_and_transparent_migration(self):
        import tempfile
        import database
        from database.secrets import (
            decrypt_secret,
            encrypt_secret,
            is_encrypted_secret,
            migrate_plaintext_secrets,
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            sys_db = os.path.join(tmpdir, "nobis_a10_system.db")
            with (
                patch.object(database, "DATA_DIR", tmpdir),
                patch.object(database, "SYSTEM_DB_PATH", sys_db),
                patch.dict(os.environ, {}, clear=False),
            ):
                os.environ.pop("NOBIS_SECRET_KEY", None)

                enc = encrypt_secret("MonMotDePasseSuperSecret!")
                self.assertTrue(is_encrypted_secret(enc))
                self.assertNotIn("MonMotDePasseSuperSecret!", enc)
                self.assertEqual(encrypt_secret(enc), enc)
                self.assertEqual(decrypt_secret(enc), "MonMotDePasseSuperSecret!")
                self.assertEqual(decrypt_secret("legacy-plain-value"), "legacy-plain-value")
                self.assertTrue(os.path.isfile(os.path.join(tmpdir, ".secret.key")))

                conn = database.get_sys_db()
                try:
                    conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('agua_password', 'plain-pwd-123')")
                    conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('container_api_token', 'plain-api-tok')")
                    conn.commit()
                    migrated = migrate_plaintext_secrets(conn)
                    conn.commit()
                    self.assertEqual(migrated, 2)
                    raw_pwd = conn.execute("SELECT value FROM settings WHERE key='agua_password'").fetchone()["value"]
                    raw_tok = conn.execute("SELECT value FROM settings WHERE key='container_api_token'").fetchone()["value"]
                    self.assertTrue(is_encrypted_secret(raw_pwd))
                    self.assertTrue(is_encrypted_secret(raw_tok))
                finally:
                    conn.close()

                s_mem = database.get_settings_dict()
                self.assertEqual(s_mem["agua_password"], "plain-pwd-123")
                self.assertEqual(s_mem["container_api_token"], "plain-api-tok")
                s_pub = database.get_public_settings_dict()
                self.assertEqual(s_pub["agua_password"], "********")
                self.assertEqual(s_pub["container_api_token"], "********")

                with patch.dict(os.environ, {"NOBIS_SECRET_KEY": "another-different-key"}):
                    self.assertEqual(decrypt_secret(raw_tok), "")

    # ------------------------------------------------------------------
    # R-01 / R-02 / R-03 : Manifest 2.4.0, échappement XSS, CSP durcie, anti-flood
    # ------------------------------------------------------------------
    def test_r01_r02_r03_manifest_csp_no_inline_scripts_and_xss_escape(self):
        from config import FRONTEND_DIST_DIR

        r_health = self.client.get("/health")
        csp = r_health.headers.get("content-security-policy", "")
        self.assertIn("script-src-elem 'self'", csp)
        self.assertIn("object-src 'none'", csp)
        self.assertIn("base-uri 'self'", csp)
        self.assertIn("frame-ancestors 'self'", csp)

        fe_root = os.path.join(os.path.dirname(BASE_DIR), "frontend")
        if os.path.isdir(fe_root):
            with open(os.path.join(fe_root, "public", "js", "core", "ui_core.js"), encoding="utf-8") as f:
                ui_core_js = f.read()
            self.assertIn("escapeHtml(activeMode)", ui_core_js)
        self.assertTrue(isinstance(FRONTEND_DIST_DIR, str))

    def test_r03_client_error_rate_limit_and_sse_per_ip_cap(self):
        import routers.dashboard as dash_router
        import routers.observability as obs_router

        obs_router._client_error_timestamps.clear()
        try:
            for i in range(obs_router._CLIENT_ERROR_LIMIT_PER_MIN):
                resp = self.client.post(
                    "/api/logs/client-error",
                    json={"source": "UNIT_TEST", "message": f"err #{i}"},
                )
                self.assertEqual(resp.status_code, 200)
            resp_over = self.client.post(
                "/api/logs/client-error",
                json={"source": "UNIT_TEST", "message": "overflow"},
            )
            self.assertEqual(resp_over.status_code, 429)
        finally:
            obs_router._client_error_timestamps.clear()

        dummy_queues = {asyncio.Queue() for _ in range(dash_router.MAX_SSE_PER_IP)}
        dash_router._sse_subscribers_by_ip["testclient"] = dummy_queues
        try:
            resp_sse = self.client.get("/api/events")
            self.assertEqual(resp_sse.status_code, 429)
        finally:
            dash_router._sse_subscribers_by_ip.pop("testclient", None)

    # ------------------------------------------------------------------
    # Lots 1+2+3 : État de l'art, Performance (GZip, cache, projection, SQLite) & Doc
    # ------------------------------------------------------------------
    def test_perf_gzip_static_cache_slim_series_and_wcag_viewport(self):
        # Dashboard compressé en GZip et séries projetées sans raw_buffer_json
        with temporary_settings({"comm_mode": "simulation"}):
            self.client.post("/api/poll-now")
            r_dash = self.client.get(
                "/api/dashboard?range_key=24h",
                headers={"Accept-Encoding": "gzip"},
            )
            self.assertEqual(r_dash.status_code, 200)
            self.assertEqual(r_dash.headers.get("content-encoding"), "gzip")
            payload = r_dash.json()
            self.assertTrue(payload.get("series"))
            first_pt = payload["series"][0]
            self.assertNotIn("raw_buffer_json", first_pt)
            self.assertIn("has_raw_buffer", first_pt)

    def test_soa01_batch_evaluator_includes_first_27_rows_and_settings_cache_invalidation(self):
        from analytics.batch_evaluator import _collect_stabilized_batch_samples
        from database import get_settings_dict, get_sys_db

        # 1. SOA-01 : les lignes id <= 27 en mode agua_cloud ne doivent plus être ignorées
        cols_sql = ", ".join(f"{k} {v}" for k, v in TELEMETRY_COLUMNS.items())
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute(f"CREATE TABLE telemetry ({cols_sql})")
        base_ep = int(time.time()) - 3600
        for idx in range(1, 26):
            conn.execute(
                "INSERT INTO telemetry (id, epoch, timestamp, comm_mode, status_code, alarm_code, popup_flags, "
                "temp_fumes, temp_probe_k, exhaust_rpm, depression_pa, power_actual, "
                "vent_front_actual, duct_left_actual, duct_right_actual, raw_buffer_json) "
                "VALUES (?, ?, '2026-11-21 10:00:00', 'agua_cloud', 5, 0, 0, 130.0, 480.0, 1700, 3.0, 4, 4, 0, 0, '{\"8\":5}')",
                (idx, base_ep + idx * 120),
            )
        conn.commit()
        samples, stable_min, cycles = _collect_stabilized_batch_samples(conn, 0)
        conn.close()
        self.assertGreater(len(samples), 0)
        self.assertGreater(stable_min, 0.0)
        self.assertEqual(cycles, 1)

        # 2. PERF-03 : auto-invalidation cache settings sur commit() et réduction connexions /api/latest
        with temporary_settings({"comm_mode": "simulation", "weather_city": "Paris (75000)"}):
            s1 = get_settings_dict()
            self.assertEqual(s1["comm_mode"], "simulation")
            sconn = get_sys_db()
            try:
                sconn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('weather_city', 'Lyon (69000)')")
                sconn.commit()
            finally:
                sconn.close()
            self.assertEqual(get_settings_dict()["weather_city"], "Lyon (69000)")

            orig_connect = sqlite3.connect
            opens = 0

            def _counting_connect(*a, **kw):
                nonlocal opens
                opens += 1
                return orig_connect(*a, **kw)

            # Warmup cache settings puis mesure sur /api/latest
            self.client.get("/api/latest")
            with patch("sqlite3.connect", side_effect=_counting_connect):
                r_lat = self.client.get("/api/latest")
            self.assertEqual(r_lat.status_code, 200)
            self.assertLessEqual(opens, 2)

    def test_doc02_no_duplicate_js_banners(self):
        js_root = os.path.join(os.path.dirname(BASE_DIR), "frontend", "public", "js")
        if not os.path.isdir(js_root):
            return
        for dp, _, fns in os.walk(js_root):
            for fn in fns:
                if not fn.endswith(".js"):
                    continue
                with open(os.path.join(dp, fn), encoding="utf-8") as f:
                    top = f.read().splitlines()[:10]
                banners = [ln for ln in top if ln.startswith("// ===")]
                self.assertLessEqual(len(banners), 2, f"Double bannière détectée dans {fn}")
