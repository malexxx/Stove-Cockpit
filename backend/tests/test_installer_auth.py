"""Tests sécurité HTTP, protection anti-SSRF et suppression des endpoints /api/installer."""
from tests.helpers import SimulationApiTestCase


class TestInstallerAuthAPI(SimulationApiTestCase):
    def test_security_headers_present(self):
        resp = self.client.get("/health")
        self.assertEqual(resp.headers.get("x-content-type-options"), "nosniff")
        self.assertEqual(resp.headers.get("x-frame-options"), "SAMEORIGIN")
        self.assertEqual(resp.headers.get("referrer-policy"), "strict-origin-when-cross-origin")

    def test_ssrf_protection_on_webhook(self):
        # Tentative d'atteindre l'API de contrôle Matter interne
        bad_payload = {"webhook_url": "http://127.0.0.1:5549/factory-reset"}
        resp = self.client.post("/api/test-webhook", json=bad_payload)
        self.assertEqual(resp.status_code, 400)
        self.assertIn("anti-SSRF", resp.json()["detail"])

        # Tentative d'atteindre le service de métadonnées AWS / Cloud
        bad_cloud = {"webhook_url": "http://169.254.169.254/latest/meta-data/"}
        resp_cloud = self.client.post("/api/test-webhook", json=bad_cloud)
        self.assertEqual(resp_cloud.status_code, 400)

    def test_installer_auth_endpoints_removed(self):
        self.assertEqual(self.client.get("/api/installer/status").status_code, 404)
        self.assertEqual(self.client.post("/api/installer/verify", json={"password": "test"}).status_code, 404)
        self.assertEqual(self.client.post("/api/installer/lock").status_code, 404)
