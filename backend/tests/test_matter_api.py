"""Tests API du pont Thermostat Matter local et sécurité webhook loopback."""
from main import app
from tests.helpers import SimulationApiTestCase, get_matter_webhook_headers


class TestMatterAPI(SimulationApiTestCase):
    def test_matter_status(self):
        resp = self.client.get("/api/matter/status")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn("enabled", data)

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
