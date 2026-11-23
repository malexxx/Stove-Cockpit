import unittest
from unittest.mock import AsyncMock, patch
from fastapi.testclient import TestClient
from main import app
from routers.system import sanitize_csv_cell


class TestSystemEndpoints(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from database import get_sys_db
        sconn = get_sys_db()
        try:
            row = sconn.execute("SELECT value FROM settings WHERE key = 'comm_mode'").fetchone()
            cls.orig_comm_mode = row["value"] if (row and row["value"]) else "agua_cloud"
            sconn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('comm_mode', 'simulation')")
            sconn.commit()
        finally:
            sconn.close()
        cls.client = TestClient(app, raise_server_exceptions=False)

    @classmethod
    def tearDownClass(cls):
        from database import get_sys_db
        sconn = get_sys_db()
        try:
            mode = getattr(cls, "orig_comm_mode", "agua_cloud") or "agua_cloud"
            sconn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('comm_mode', ?)", (mode,))
            sconn.commit()
        finally:
            sconn.close()

    def test_sanitize_csv_cell(self):
        """Vérifie la neutralisation des injections de formules CSV (CWE-1236)."""
        self.assertEqual(sanitize_csv_cell(None), "")
        self.assertEqual(sanitize_csv_cell("Normal text"), "Normal text")
        # Injection avec =, +, -, @
        self.assertTrue(sanitize_csv_cell("=SUM(A1:A10)").startswith("'="))
        self.assertTrue(sanitize_csv_cell("+cmd|' /C calc'!A0").startswith("'+"))
        self.assertTrue(sanitize_csv_cell("-123").startswith("'-123"))
        self.assertTrue(sanitize_csv_cell("@alert").startswith("'@"))
        # Remplacement des points-virgules et retours chariot
        self.assertEqual(sanitize_csv_cell("val1;val2\r\nextra"), "val1,val2  extra")

    def test_snapshots_lifecycle_and_exports(self):
        """Vérifie la création, consultation, export CSV, restauration et suppression de snapshots."""
        from database import get_settings_dict
        pwd = (get_settings_dict().get("agua_password") or "").strip()
        auth_headers = {}
        if pwd:
            r_auth = self.client.post("/api/installer/verify", json={"password": pwd})
            self.assertEqual(r_auth.status_code, 200)
            auth_headers = {"X-Installer-Token": r_auth.json().get("token", "")}

        # 1. Création d'un snapshot avec nom
        resp_create = self.client.post("/api/snapshots", json={"name": "Snapshot Test Unitaire", "refresh_live": False}, headers=auth_headers)
        self.assertEqual(resp_create.status_code, 200)
        data_create = resp_create.json()
        self.assertEqual(data_create["status"], "ok")
        self.assertIn("id", data_create)
        snap_id = data_create["id"]

        # Création d'un snapshot sans nom (génération automatique de libellé)
        resp_create_auto = self.client.post("/api/snapshots", json={"refresh_live": False}, headers=auth_headers)
        self.assertEqual(resp_create_auto.status_code, 200)
        snap_auto_id = resp_create_auto.json()["id"]

        try:
            # 2. Liste des snapshots
            resp_list = self.client.get("/api/snapshots")
            self.assertEqual(resp_list.status_code, 200)
            snaps = resp_list.json()
            ids = [s["id"] for s in snaps]
            self.assertIn(snap_id, ids)
            self.assertIn(snap_auto_id, ids)

            target_snap = next(s for s in snaps if s["id"] == snap_id)
            self.assertEqual(target_snap["name"], "Snapshot Test Unitaire")
            self.assertGreater(target_snap["registers_count"], 0)

            # 3. Export CSV du snapshot
            resp_csv = self.client.get(f"/api/snapshots/{snap_id}/export-csv")
            self.assertEqual(resp_csv.status_code, 200)
            self.assertIn("text/csv", resp_csv.headers["content-type"])
            self.assertIn("CATALOG_REGISTER", resp_csv.text)

            # Export CSV d'un snapshot introuvable -> 404
            resp_csv_404 = self.client.get("/api/snapshots/99999999/export-csv")
            self.assertEqual(resp_csv_404.status_code, 404)

            # 4. Restauration du snapshot
            resp_restore = self.client.post(f"/api/snapshots/{snap_id}/restore", headers=auth_headers)
            self.assertEqual(resp_restore.status_code, 200)
            self.assertEqual(resp_restore.json()["status"], "ok")

            # Restauration d'un snapshot introuvable -> 404
            resp_restore_404 = self.client.post("/api/snapshots/99999999/restore", headers=auth_headers)
            self.assertEqual(resp_restore_404.status_code, 404)
        finally:
            # 5. Suppression des snapshots créés
            resp_del1 = self.client.delete(f"/api/snapshots/{snap_id}", headers=auth_headers)
            self.assertEqual(resp_del1.status_code, 200)
            resp_del2 = self.client.delete(f"/api/snapshots/{snap_auto_id}", headers=auth_headers)
            self.assertEqual(resp_del2.status_code, 200)

    def test_audit_and_logs(self):
        """Vérifie la consultation de l'audit et des logs applicatifs (avec filtres et export CSV)."""
        # 1. Audit
        resp_audit = self.client.get("/api/audit")
        self.assertEqual(resp_audit.status_code, 200)
        self.assertIsInstance(resp_audit.json(), list)

        # 2. Logs avec différents niveaux de sévérité
        resp_logs_all = self.client.get("/api/logs?severity=ALL")
        self.assertEqual(resp_logs_all.status_code, 200)
        self.assertIsInstance(resp_logs_all.json(), list)

        resp_logs_warn = self.client.get("/api/logs?severity=WARNING")
        self.assertEqual(resp_logs_warn.status_code, 200)
        self.assertIsInstance(resp_logs_warn.json(), list)

        resp_logs_err = self.client.get("/api/logs?severity=ERROR")
        self.assertEqual(resp_logs_err.status_code, 200)
        self.assertIsInstance(resp_logs_err.json(), list)

        # 3. Export CSV des logs
        resp_csv_all = self.client.get("/api/export-logs-csv?severity=ALL")
        self.assertEqual(resp_csv_all.status_code, 200)
        self.assertIn("text/csv", resp_csv_all.headers["content-type"])
        self.assertIn("id;timestamp;severity;source;message", resp_csv_all.text)

        resp_csv_warn = self.client.get("/api/export-logs-csv?severity=WARNING")
        self.assertEqual(resp_csv_warn.status_code, 200)

        resp_csv_err = self.client.get("/api/export-logs-csv?severity=ERROR")
        self.assertEqual(resp_csv_err.status_code, 200)

    def test_export_csv_telemetry(self):
        """Vérifie l'export CSV complet des données de télémétrie et registres."""
        resp_24h = self.client.get("/api/export-csv?range_key=24h")
        self.assertEqual(resp_24h.status_code, 200)
        self.assertIn("text/csv", resp_24h.headers["content-type"])
        self.assertIn("REG_", resp_24h.text)

        resp_3h = self.client.get("/api/export-csv?range_key=3h")
        self.assertEqual(resp_3h.status_code, 200)

    def test_settings_save_flow(self):
        """Vérifie la mise à jour des paramètres de configuration (avec restauration complète)."""
        from database import get_settings_dict, get_sys_db

        tracked_keys = (
            "poll_interval_s",
            "pellet_bag_price_eur",
            "weather_city",
            "weather_lat",
            "weather_lon",
            "pellet_bags_stock",
        )
        orig_settings = get_settings_dict()
        backup = {k: orig_settings.get(k) for k in tracked_keys}

        try:
            payload = {
                "poll_interval_s": "60",
                "pellet_bag_price_eur": 5.10,
                "weather_city": "Test City",
                "pellet_bags_stock": 25,
            }
            resp = self.client.post("/api/settings", json=payload)
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertEqual(data["status"], "ok")
            self.assertIn("settings", data)
            self.assertEqual(data["settings"]["poll_interval_s"], "60")
            self.assertEqual(data["settings"]["weather_city"], "Test City")
        finally:
            sconn = get_sys_db()
            try:
                for k, v in backup.items():
                    if v is not None:
                        sconn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (k, str(v)))
                sconn.commit()
            finally:
                sconn.close()

    def test_test_connection_simulation(self):
        """Vérifie le endpoint /api/test-connection en mode simulation."""
        from tests.helpers import get_installer_auth_headers

        headers = get_installer_auth_headers(self.client)
        payload = {"comm_mode": "simulation"}
        resp = self.client.post("/api/test-connection", json=payload, headers=headers)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["status"], "ok")
        self.assertEqual(data["mode"], "simulation")
        self.assertIn("active_db", data)
        self.assertIn("weather", data)

    def test_test_connection_local_gateway_mocked(self):
        """Vérifie le test de connexion passerelle UART (succès et échec)."""
        from tests.helpers import get_installer_auth_headers

        headers = get_installer_auth_headers(self.client)
        payload = {"comm_mode": "local_gateway", "local_gateway_url": "http://192.168.1.150"}

        # Cas succès
        with patch("clients.local_gateway_client.test_connection", new_callable=AsyncMock) as mock_test:
            mock_test.return_value = {"status": "ok", "latency_ms": 12}
            resp = self.client.post("/api/test-connection", json=payload, headers=headers)
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.json()["status"], "ok")

        # Cas échec (diagnostic renvoie status: error sans crash 5xx)
        with patch("clients.local_gateway_client.test_connection", new_callable=AsyncMock) as mock_test:
            mock_test.side_effect = Exception("Hôte passerelle UART injoignable")
            resp = self.client.post("/api/test-connection", json=payload, headers=headers)
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.json()["status"], "error")

    def test_test_connection_agua_cloud_mocked(self):
        """Vérifie le test de connexion Cloud Agua IOT (succès et échec) sur client isolé."""
        from tests.helpers import get_installer_auth_headers

        headers = get_installer_auth_headers(self.client)
        payload = {
            "comm_mode": "agua_cloud",
            "agua_email": "test@example.com",
            "agua_password": "valid_password",
            "agua_uuid": "test-uuid-1234",
        }

        # Cas succès
        with patch("clients.AguaCloudClient.login_and_discover", new_callable=AsyncMock) as mock_login:
            mock_login.return_value = {"token": "fake_tok", "id_device": "dev1"}
            resp = self.client.post("/api/test-connection", json=payload, headers=headers)
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.json()["status"], "ok")

        # Cas échec (diagnostic renvoie status: error sans crash 5xx)
        with patch("clients.AguaCloudClient.login_and_discover", new_callable=AsyncMock) as mock_login:
            mock_login.side_effect = Exception("Identifiants Agua IOT rejetés")
            resp = self.client.post("/api/test-connection", json=payload, headers=headers)
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.json()["status"], "error")

    def test_agua_registers_map_endpoint_mocked(self):
        """Vérifie le endpoint /api/agua-registers-map."""
        from tests.helpers import get_installer_auth_headers

        headers = get_installer_auth_headers(self.client)
        with patch("clients.agua_client.scan_registers_map", new_callable=AsyncMock) as mock_scan, \
             patch("clients.agua_client.read_buffer", new_callable=AsyncMock) as mock_read:
            mock_scan.return_value = [{"offset": 103, "formula": "val", "label": "Temp amb"}]
            mock_read.return_value = {103: 19.5, 2: 150.0}

            resp = self.client.get("/api/agua-registers-map", headers=headers)
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertIn("registers_map", data)
            self.assertIn("raw_buffer", data)
            self.assertEqual(data["raw_buffer_count"], 2)

    def test_container_logs_and_csv_export(self):
        """Vérifie le buffer mémoire des logs conteneur et son export CSV."""
        from database import add_container_log

        add_container_log("INFO", "CONTAINER_TEST", "Ligne de test conteneur")
        resp = self.client.get("/api/logs?severity=CONTAINER")
        self.assertEqual(resp.status_code, 200)
        logs = resp.json()
        self.assertIsInstance(logs, list)
        self.assertTrue(any(entry.get("message") == "Ligne de test conteneur" for entry in logs))

        resp_csv = self.client.get("/api/export-logs-csv?severity=CONTAINER")
        self.assertEqual(resp_csv.status_code, 200)
        self.assertIn("text/csv", resp_csv.headers["content-type"])
        self.assertIn("Ligne de test conteneur", resp_csv.text)

    def test_system_restart_and_watchtower_update(self):
        """Vérifie les endpoints /api/system/restart et /api/system/check-update."""
        from contextlib import asynccontextmanager
        import httpx
        from database import get_settings_dict

        pwd = (get_settings_dict().get("agua_password") or "").strip()
        auth_headers = {}
        if pwd:
            r_auth = self.client.post("/api/installer/verify", json={"password": pwd})
            self.assertEqual(r_auth.status_code, 200)
            auth_headers = {"X-Installer-Token": r_auth.json().get("token", "")}

        with patch("routers.system._delayed_process_restart", new_callable=AsyncMock) as mock_restart:
            resp_restart = self.client.post("/api/system/restart", headers=auth_headers)
            self.assertEqual(resp_restart.status_code, 200)
            self.assertEqual(resp_restart.json()["status"], "ok")
            mock_restart.assert_called_once()

        class _FakeResp:
            def __init__(self, status_code, text=""):
                self.status_code = status_code
                self.text = text

        class _FakeClientOk:
            async def post(self, url, headers=None):
                return _FakeResp(200, "ok")

        @asynccontextmanager
        async def _borrow_ok(timeout=15.0):
            yield _FakeClientOk()

        with patch.dict("os.environ", {"WATCHTOWER_URL": "http://watchtower:8080/v1/update"}):
            with patch("routers.system.borrow_http_client", _borrow_ok):
                resp_upd = self.client.post("/api/system/check-update", headers=auth_headers)
                self.assertEqual(resp_upd.status_code, 200)
                self.assertEqual(resp_upd.json()["status"], "ok")

            class _FakeClientErr:
                async def post(self, url, headers=None):
                    raise httpx.ConnectError("Connection refused")

            @asynccontextmanager
            async def _borrow_err(timeout=15.0):
                yield _FakeClientErr()

            with patch("routers.system.borrow_http_client", _borrow_err):
                resp_err = self.client.post("/api/system/check-update", headers=auth_headers)
                self.assertEqual(resp_err.status_code, 502)


if __name__ == "__main__":
    unittest.main()
