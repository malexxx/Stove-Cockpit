# -*- coding: utf-8 -*-
"""Tests d'authentification par Jeton API (X-API-Key / Bearer), CORS Capacitor et endpoints appairage."""
import os
import socket
from unittest.mock import patch

from services.api_token_service import build_pairing_info, get_or_create_api_token
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
        with temporary_settings({"comm_mode": "simulation", "agua_password": "pair-secret"}):
            info = self.client.get("/api/system/pairing-info").json()
            self.assertIn("api_token", info)
            self.assertIn("qr_payload", info)
            old_tok = info["api_token"]

            # Rotation directe sans authentification installateur
            rot = self.client.post("/api/system/pairing-token/rotate")
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

    def test_pairing_info_prefers_local_ip_over_dns(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("STOVE_LAN_IP", None)
            os.environ.pop("HOST_LAN_IP", None)

            # Nom DNS résolu en IP privée LAN -> préfère l'IP locale HTTP
            with patch(
                "services.api_token_service.socket.getaddrinfo",
                return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("192.168.1.42", 0))],
            ):
                p_dns = build_pairing_info("https://mon-nas.local:8443")
                self.assertEqual(p_dns["url"], "http://192.168.1.42:8443")

            # localhost -> repli sur l'IP LAN détectée
            with patch("services.api_token_service._detect_lan_ipv4", return_value="192.168.1.55"):
                p_local = build_pairing_info("http://localhost:8080")
                self.assertEqual(p_local["url"], "http://192.168.1.55:8080")

            # IP locale directe conservée telle quelle
            p_ip = build_pairing_info("http://192.168.1.50:8080")
            self.assertEqual(p_ip["url"], "http://192.168.1.50:8080")

            # STOVE_LAN_IP prioritaire
            with patch.dict(os.environ, {"STOVE_LAN_IP": "10.0.0.25"}):
                p_env = build_pairing_info("http://stove.home.arpa:8080")
                self.assertEqual(p_env["url"], "http://10.0.0.25:8080")

    def test_cors_never_uses_wildcard_and_hardens_security_headers(self):
        # Origine tierce non autorisée sur OPTIONS -> pas de Access-Control-Allow-Origin: *
        r_opt_evil = self.client.options("/api/latest", headers={"Origin": "https://evil.example"})
        self.assertEqual(r_opt_evil.status_code, 200)
        self.assertIsNone(r_opt_evil.headers.get("access-control-allow-origin"))

        # Pairing info & rotation jamais mis en cache
        r_pair = self.client.get("/api/system/pairing-info")
        self.assertEqual(r_pair.status_code, 200)
        self.assertEqual(r_pair.headers.get("cache-control"), "no-store")

        # Géolocalisation autorisée uniquement en same-origin
        r_health = self.client.get("/health")
        self.assertIn("geolocation=(self)", r_health.headers.get("permissions-policy", ""))

        # Cache actif sur /css/styles.css servi depuis frontend/dist
        r_css = self.client.get("/css/styles.css")
        if r_css.status_code == 200:
            self.assertIn("max-age=3600", r_css.headers.get("cache-control", ""))
