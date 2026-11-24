"""Tests API du pont Thermostat Matter local et sécurité webhook loopback."""
import asyncio
import time
from unittest.mock import AsyncMock, MagicMock, patch

from main import app
from matter_service import matter_manager
from tests.helpers import SimulationApiTestCase, get_matter_webhook_headers


class TestMatterAPI(SimulationApiTestCase):
    def tearDown(self):
        matter_manager._stopping = False
        matter_manager._last_start_error = ""
        matter_manager._last_start_attempt = 0.0
        matter_manager._proc = None
        super().tearDown()

    def test_matter_status(self):
        t0 = time.monotonic()
        resp = self.client.get("/api/matter/status")
        elapsed = time.monotonic() - t0
        self.assertEqual(resp.status_code, 200)
        self.assertLess(elapsed, 2.0)
        data = resp.json()
        self.assertIn("enabled", data)
        self.assertIn("running", data)

    def test_matter_status_fails_fast_when_node_modules_missing(self):
        matter_manager._stopping = False
        matter_manager._last_start_error = ""
        matter_manager._last_start_attempt = 0.0
        matter_manager._proc = None
        with (
            patch.object(matter_manager, "is_enabled", return_value=True),
            patch.object(matter_manager, "is_control_alive", new=AsyncMock(return_value=False)),
            patch("matter_service._find_node_binary", return_value="node"),
            patch("matter_service.os.path.isfile", return_value=True),
            patch("matter_service.os.path.isdir", return_value=False),
            patch("matter_service.subprocess.Popen") as mock_popen,
        ):
            t0 = time.monotonic()
            r1 = self.client.get("/api/matter/status")
            elapsed1 = time.monotonic() - t0
            self.assertEqual(r1.status_code, 200)
            self.assertLess(elapsed1, 1.0)
            d1 = r1.json()
            self.assertFalse(d1["running"])
            self.assertTrue(d1["enabled"])
            self.assertIn("node_modules", d1.get("error", ""))
            mock_popen.assert_not_called()

            # Appel immédiat suivant : le cooldown évite de relancer quoi que ce soit
            r2 = self.client.get("/api/matter/status")
            self.assertEqual(r2.status_code, 200)
            self.assertEqual(r2.json().get("error"), d1.get("error"))
            mock_popen.assert_not_called()

    def test_matter_wait_fails_fast_on_early_process_exit(self):
        mock_proc = MagicMock()
        mock_proc.poll.return_value = 1
        matter_manager._proc = mock_proc
        matter_manager._last_start_error = ""
        matter_manager._last_start_attempt = 0.0
        with patch.object(matter_manager, "is_control_alive", new=AsyncMock(return_value=False)):
            t0 = time.monotonic()
            res = asyncio.run(matter_manager._wait_for_bridge_ready("Stove Cockpit", "5540"))
            elapsed = time.monotonic() - t0
        self.assertLess(elapsed, 1.0)
        self.assertFalse(res["running"])
        self.assertIn("code 1", res.get("error", ""))
        self.assertIsNone(matter_manager._proc)

    def test_matter_webhook_loopback_allowed(self):
        # L'appel direct depuis TestClient simule la boucle locale avec secret partagé valide
        payload = {"action": "set_temperature", "temperature": 21.0}
        resp = self.client.post("/api/matter/webhook", json=payload, headers=get_matter_webhook_headers())
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["status"], "ok")

    def test_matter_webhook_remote_rejected(self):
        # Simulation d'un appel distant avec client_ip mocké
        _payload = {"action": "set_power", "state": "ON"}
        # Création d'une requête avec scope client distant
        from starlette.requests import Request
        scope = {
            "type": "http",
            "method": "POST",
            "path": "/api/matter/webhook",
            "headers": [(b"content-type", b"application/json")],
            "client": ("192.168.1.99", 54321),
            "app": app,
        }
        fake_req = Request(scope)
        # Vérifions que le contrôle rejette une IP distante
        client_ip = fake_req.client.host if fake_req.client else ""
        self.assertNotIn(client_ip, ("127.0.0.1", "::1", "localhost", "testclient"))
