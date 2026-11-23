# -*- coding: utf-8 -*-
"""Tests d'authentification par Jeton API (X-API-Key / Bearer), CORS Capacitor et endpoints appairage."""
from services.api_token_service import get_or_create_api_token
from services.installer_auth import clear_installer_sessions
from tests.helpers import BugBountyTestCase, temporary_settings


class TestApiTokenAndCors(BugBountyTestCase):
    def test_brands_endpoint_is_public_and_returns_catalog(self):
        resp = self.client.get("/api/brands", headers={"Origin": "capacitor://localhost"})
        self.assertEqual(resp.status_code, 200)
        brands = resp.json().get("brands", [])
        self.assertGreaterEqual(len(brands), 36)
        self.assertEqual(resp.headers.get("access-control-allow-origin"), "capacitor://localhost")

    def test_cross_origin_requires_valid_api_token_and_allows_capacitor(self):
        token = get_or_create_api_token()
        self.assertTrue(len(token) >= 20)

        # Sans jeton depuis une origine Capacitor -> 401 + CORS header
        r_unauth = self.client.get("/api/latest", headers={"Origin": "capacitor://localhost"})
        self.assertEqual(r_unauth.status_code, 401)
        self.assertEqual(r_unauth.headers.get("access-control-allow-origin"), "capacitor://localhost")

        # Mauvais jeton -> 401
        r_bad = self.client.get(
            "/api/latest",
            headers={"Origin": "capacitor://localhost", "X-API-Key": "invalid-token"},
        )
        self.assertEqual(r_bad.status_code, 401)

        # Jeton valide via X-API-Key -> 200
        r_ok = self.client.get(
            "/api/latest",
            headers={"Origin": "capacitor://localhost", "X-API-Key": token},
        )
        self.assertEqual(r_ok.status_code, 200)
        self.assertEqual(r_ok.headers.get("access-control-allow-origin"), "capacitor://localhost")

        # Jeton valide via Authorization: Bearer -> 200
        r_bearer = self.client.get(
            "/api/latest",
            headers={"Origin": "http://localhost", "Authorization": f"Bearer {token}"},
        )
        self.assertEqual(r_bearer.status_code, 200)

        # Preflight OPTIONS -> 200 avec Allow-Headers incluant X-API-Key
        r_opt = self.client.options("/api/command", headers={"Origin": "capacitor://localhost"})
        self.assertEqual(r_opt.status_code, 200)
        self.assertIn("X-API-Key", r_opt.headers.get("access-control-allow-headers", ""))

    def test_pairing_info_and_token_rotation(self):
        clear_installer_sessions()
        with temporary_settings({"comm_mode": "simulation", "agua_password": "pair-secret"}):
            info = self.client.get("/api/system/pairing-info").json()
            self.assertIn("api_token", info)
            self.assertIn("qr_payload", info)
            old_tok = info["api_token"]

            # Rotation protégée par auth installateur
            self.assertEqual(self.client.post("/api/system/pairing-token/rotate").status_code, 403)
            inst_tok = self.client.post("/api/installer/verify", json={"password": "pair-secret"}).json()["token"]
            rot = self.client.post("/api/system/pairing-token/rotate", headers={"X-Installer-Token": inst_tok})
            self.assertEqual(rot.status_code, 200)
            new_tok = rot.json()["api_token"]
            self.assertNotEqual(old_tok, new_tok)

            # Ancien jeton refusé, nouveau jeton accepté
            self.assertEqual(
                self.client.get("/api/latest", headers={"Origin": "capacitor://localhost", "X-API-Key": old_tok}).status_code,
                401,
            )
            self.assertEqual(
                self.client.get("/api/latest", headers={"Origin": "capacitor://localhost", "X-API-Key": new_tok}).status_code,
                200,
            )
