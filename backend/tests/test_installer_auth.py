"""Tests API d'authentification installateur, en-têtes sécurité HTTP et protection anti-SSRF."""
from tests.helpers import SimulationApiTestCase, get_installer_auth_headers


class TestInstallerAuthAPI(SimulationApiTestCase):
    def test_security_headers_present(self):
        resp = self.client.get("/health")
        self.assertEqual(resp.headers.get("x-content-type-options"), "nosniff")
        self.assertEqual(resp.headers.get("x-frame-options"), "SAMEORIGIN")
        self.assertEqual(resp.headers.get("referrer-policy"), "strict-origin-when-cross-origin")

    def test_ssrf_protection_on_webhook(self):
        headers = get_installer_auth_headers(self.client)
        # Tentative d'atteindre l'API de contrôle Matter interne
        bad_payload = {"webhook_url": "http://127.0.0.1:5549/factory-reset"}
        resp = self.client.post("/api/test-webhook", json=bad_payload, headers=headers)
        self.assertEqual(resp.status_code, 400)
        self.assertIn("anti-SSRF", resp.json()["detail"])

        # Tentative d'atteindre le service de métadonnées AWS / Cloud
        bad_cloud = {"webhook_url": "http://169.254.169.254/latest/meta-data/"}
        resp_cloud = self.client.post("/api/test-webhook", json=bad_cloud, headers=headers)
        self.assertEqual(resp_cloud.status_code, 400)

    def test_installer_auth_flow(self):
        from database import get_sys_db

        # 1. Vérification du statut initial
        status_resp = self.client.get("/api/installer/status")
        self.assertEqual(status_resp.status_code, 200)
        self.assertFalse(status_resp.json()["authenticated"])

        # 2. Configurer temporairement un mot de passe de test en base
        test_pwd = "MonSuperMotDePasse123!"
        conn = get_sys_db()
        try:
            old_pwd_row = conn.execute("SELECT value FROM settings WHERE key = 'agua_password'").fetchone()
            orig_pwd = old_pwd_row["value"] if old_pwd_row else ""
            conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('agua_password', ?)", (test_pwd,))
            conn.commit()
        finally:
            conn.close()

        try:
            # 3. Test mot de passe erroné -> HTTP 401
            bad_resp = self.client.post("/api/installer/verify", json={"password": "MauvaisMotDePasse"})
            self.assertEqual(bad_resp.status_code, 401)
            self.assertIn("incorrect", bad_resp.json()["detail"])

            # 4. Test bon mot de passe -> HTTP 200 avec jeton
            good_resp = self.client.post("/api/installer/verify", json={"password": test_pwd})
            self.assertEqual(good_resp.status_code, 200)
            data = good_resp.json()
            self.assertTrue(data["authenticated"])
            token = data["token"]
            self.assertTrue(len(token) >= 20)

            # 5. Vérifier le statut avec le jeton
            auth_status = self.client.get("/api/installer/status", headers={"X-Installer-Token": token})
            self.assertEqual(auth_status.status_code, 200)
            self.assertTrue(auth_status.json()["authenticated"])
            self.assertTrue(auth_status.json()["has_password_configured"])

            # 6. Verrouiller la session
            lock_resp = self.client.post("/api/installer/lock", headers={"X-Installer-Token": token})
            self.assertEqual(lock_resp.status_code, 200)
            self.assertFalse(lock_resp.json()["authenticated"])

            # 7. Vérifier que le statut est désormais non authentifié
            locked_status = self.client.get("/api/installer/status", headers={"X-Installer-Token": token})
            self.assertFalse(locked_status.json()["authenticated"])
        finally:
            # Restaurer l'état initial
            conn = get_sys_db()
            try:
                conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('agua_password', ?)", (orig_pwd,))
                conn.commit()
            finally:
                conn.close()
