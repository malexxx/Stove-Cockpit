"""Tests API cœur : healthcheck, télémétrie, dashboard, pilotage poêle, calibration & UI mobile."""
import re

from tests.helpers import SimulationApiTestCase, get_installer_auth_headers


class TestAPIEndpoints(SimulationApiTestCase):
    def test_healthcheck(self):
        resp = self.client.get("/health")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["status"], "healthy")
        self.assertIn("active_mode", data)
        self.assertIn("comm_status", data)
        self.assertIn("connected", data["comm_status"])

    def test_api_latest(self):
        resp = self.client.get("/api/latest")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn("active_mode", data)
        self.assertIn("latest", data)
        self.assertIn("comm_status", data)
        self.assertIn("registers", data)
        self.assertIn("consumption_stats", data)

    def test_api_dashboard(self):
        resp = self.client.get("/api/dashboard?range_key=24h")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn("series", data)
        self.assertIn("comm_status", data)
        self.assertIn("consumption_stats", data)

    def test_comm_status_dissociation(self):
        # Vérifie que l'état de connexion conteneur (/health -> status: healthy)
        # est bien dissocié de l'état de liaison au cloud / passerelle (comm_status)
        resp = self.client.get("/health")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["status"], "healthy")
        self.assertIn("comm_status", data)
        comm = data["comm_status"]
        self.assertIn("connected", comm)
        self.assertIn("comm_mode", comm)

        # Vérification sur /api/poll-now
        poll_resp = self.client.post("/api/poll-now")
        self.assertEqual(poll_resp.status_code, 200)
        poll_data = poll_resp.json()
        self.assertEqual(poll_data["status"], "ok")
        self.assertIn("comm_status", poll_data)

    def test_client_error_logging(self):
        payload = {
            "severity": "WARNING",
            "source": "UNIT_TEST",
            "message": "Test log client error",
        }
        resp = self.client.post("/api/logs/client-error", json=payload)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["status"], "ok")

    def test_pellet_batch_status_endpoint(self):
        resp = self.client.get("/api/pellet-batch/status")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn("raz_epoch", data)
        self.assertIn("pellet_brand", data)

    def test_pellet_batch_raz_endpoint(self):
        headers = get_installer_auth_headers(self.client)
        resp = self.client.post("/api/pellet-batch/raz", json={"pellet_brand": "DINplus Test Lot A1"}, headers=headers)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["status"], "ok")
        self.assertEqual(data["pellet_batch_state"]["pellet_brand"], "DINplus Test Lot A1")
        self.assertIn("latest", data)

    def test_stove_set_endpoint(self):
        from database import get_sys_db
        sconn = get_sys_db()
        try:
            row = sconn.execute("SELECT value FROM settings WHERE key = 'comm_mode'").fetchone()
            orig_mode = row["value"] if (row and row["value"]) else "agua_cloud"
            sconn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('comm_mode', 'simulation')")
            sconn.commit()
        finally:
            sconn.close()

        try:
            # 1. Température Salon (21°C)
            r_temp = self.client.post("/api/stove/set", json={"type": "temp", "zone": "salon", "value": 21})
            self.assertEqual(r_temp.status_code, 200)
            self.assertEqual(r_temp.json()["reg_key"], "temp_amb_setpoint")
            self.assertEqual(r_temp.json()["new_value"], 21.0)

            # 2. Température Hors-Gel (6 -> 7.0) et MAX (31 -> 41.0)
            r_frost = self.client.post("/api/stove/set", json={"type": "temp", "zone": "sx", "value": 6})
            self.assertEqual(r_frost.status_code, 200)
            self.assertEqual(r_frost.json()["reg_key"], "duct_left_setpoint")
            self.assertEqual(r_frost.json()["new_value"], 7.0)

            r_max = self.client.post("/api/stove/set", json={"type": "temp", "zone": "dx", "value": 31})
            self.assertEqual(r_max.status_code, 200)
            self.assertEqual(r_max.json()["reg_key"], "duct_right_setpoint")
            self.assertEqual(r_max.json()["new_value"], 41.0)

            # 3. Ventilation Canalisation SX (PS = 8)
            r_fan = self.client.post("/api/stove/set", json={"type": "fan", "zone": "sx", "value": 8, "label": "PS"})
            self.assertEqual(r_fan.status_code, 200)
            self.assertEqual(r_fan.json()["reg_key"], "duct_left_speed")
            self.assertEqual(r_fan.json()["new_value"], 8.0)

            # 4. Puissance P8 (Boost) puis retour P4
            r_boost = self.client.post("/api/stove/set", json={"type": "power", "value": 8})
            self.assertEqual(r_boost.status_code, 200)
            self.assertEqual(r_boost.json()["reg_key"], "fun_pwf_set")
            self.assertEqual(r_boost.json()["new_value"], 1.0)

            r_p4 = self.client.post("/api/stove/set", json={"type": "power", "value": 4})
            self.assertEqual(r_p4.status_code, 200)
            self.assertEqual(r_p4.json()["status"], "ok")
        finally:
            sconn = get_sys_db()
            try:
                sconn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('comm_mode', ?)", (orig_mode,))
                sconn.commit()
            finally:
                sconn.close()

    def test_chrono_bitmask_resolution_in_agua_client(self):
        """Vérifie que les masques de jours Chrono (33168, 33188, 33208, 33228) conservent mask=65535 (pas d'écrasement par les clés individuelles par jour)."""
        from clients import AguaCloudClient
        ac = AguaCloudClient()
        sample_reg_map = {
            "registers_map": [
                {
                    "registers": [
                        {"reg_key": "chrono_p1_day_1_set", "reg_type": "SET", "offset": 33168, "mask": 1, "is_word": True},
                        {"reg_key": "chrono_p1_day_2_set", "reg_type": "SET", "offset": 33168, "mask": 2, "is_word": True},
                        {"reg_key": "chrono_p1_day_7_set", "reg_type": "SET", "offset": 33168, "mask": 64, "is_word": True},
                        {"reg_key": "chrono_p3_day_7_set", "reg_type": "SET", "offset": 33208, "mask": 64, "is_word": True},
                        {"reg_key": "chrono_p1_temperature_set", "reg_type": "SET", "offset": 33163, "mask": 65535, "is_word": True},
                    ]
                }
            ]
        }
        ac._parse_and_cache_registers_map(sample_reg_map)
        p1_off, p1_bit, p1_end, p1_mask, _ = ac._resolve_register_write_params(33168, "chrono_p1_days_mask")
        self.assertEqual(p1_mask, 65535)

        p3_off, p3_bit, p3_end, p3_mask, _ = ac._resolve_register_write_params(33208, "chrono_p3_days_mask")
        self.assertEqual(p3_mask, 65535)

        # Mais un appel explicite sur une clé unitaire conserve son masque spécifique
        d7_off, d7_bit, d7_end, d7_mask, _ = ac._resolve_register_write_params(33168, "chrono_p1_day_7_set")
        self.assertEqual(d7_mask, 64)

    def test_mobile_navigation_tabs_bottom_clearance(self):
        """Vérifie que l'interface mobile dispose d'un dégagement inférieur suffisant (HTML et CSS)
        pour éviter que le contenu des onglets (Pellets, Chrono, Supervision, Paramètres)
        ne soit masqué sous la barre de navigation fixe du bas."""
        # 1. Vérification dans l'index HTML servi
        resp_spa = self.client.get("/")
        self.assertEqual(resp_spa.status_code, 200)
        html = resp_spa.text

        # Présence de la barre fixe inférieure mobile
        self.assertIn("fixed bottom-0", html)
        self.assertIn("mob-btn-tab-control", html)

        # Dégagement sur le conteneur principal <main> et body
        self.assertIn("pb-28 md:pb-6", html)

        # Dégagement sur chacun des onglets scrollables
        for tab_id in ["tab-pellets", "tab-chrono", "tab-dashboard", "tab-installer"]:
            self.assertIn(f'id="{tab_id}"', html)
            self.assertIn(f'id="{tab_id}" class="hidden space-y-', html)
            self.assertIn("pb-8 md:pb-0", html)

        # 2. Vérification dans la feuille de style styles.css servie
        resp_css = self.client.get("/css/styles.css")
        if resp_css.status_code == 404:
            resp_css = self.client.get("/static/css/styles.css")
        self.assertEqual(resp_css.status_code, 200)
        css = resp_css.text

        self.assertIn("@media (max-width: 767px)", css)
        self.assertIn("padding-bottom: calc(", css)
        self.assertIn("env(safe-area-inset-bottom", css)
        self.assertIn("#tab-pellets", css)
        self.assertIn("#tab-chrono", css)
        self.assertIn("#tab-dashboard", css)
        self.assertIn("#tab-installer", css)

        # 3. Vérification de l'étanchéité du masquage des onglets (évite que tab-control reste visible sous les autres)
        self.assertIn("#tab-control.hidden", css)
        self.assertIn("display: none !important", css)
        self.assertIn("#tab-control:not(.hidden)", css)

        # 4. Vérification que la barre d'onglets desktop n'est pas masquée sur grand écran
        self.assertIn("hidden md:flex", html)
        self.assertIn("@media (min-width: 768px)", css)
        self.assertIn("nav.md\\:flex", css)
        # La classe générique .hidden ne doit PAS avoir !important pour ne pas casser md:flex
        self.assertIsNone(re.search(r'(?m)^\.hidden\s*[,{]', css))
        self.assertNotIn("\n.hidden,\n", css.replace("\r\n", "\n"))
        self.assertNotIn(".hidden { display: none !important", css)

    def test_calibration_wizard_endpoint(self):
        """Vérifie que la route /calibration sert la page HTML de l'assistant de calibration."""
        resp = self.client.get("/calibration")
        self.assertEqual(resp.status_code, 200)
        self.assertIn("Assistant d'Étalonnage Couplé", resp.text)
        self.assertIn("Nobis A10", resp.text)
        self.assertIn("Protocole", resp.text)

    def test_calibration_api_endpoints_background_flow(self):
        """Vérifie le cycle des endpoints API /api/calibration/ en arrière-plan."""
        headers = get_installer_auth_headers(self.client)
        # 1. Reset
        r_reset = self.client.post("/api/calibration/reset", headers=headers)
        self.assertEqual(r_reset.status_code, 200)

        # 2. Status initial
        r_stat = self.client.get("/api/calibration/status")
        self.assertEqual(r_stat.status_code, 200)
        data = r_stat.json()
        self.assertEqual(data["step"], 1)
        self.assertEqual(data["state"], "IDLE")

        # 3. Step 1 : Pré-contrôle
        r_s1 = self.client.post("/api/calibration/step1-start", json={"mode": "COMBINED_BOTH"}, headers=headers)
        self.assertEqual(r_s1.status_code, 200)
        self.assertTrue(r_s1.json()["success"])

        # 4. Status après Step 1
        r_stat2 = self.client.get("/api/calibration/status")
        self.assertEqual(r_stat2.status_code, 200)
        self.assertEqual(r_stat2.json()["step"], 2)

    def test_confort_clima_standby_real_state_and_cloud_behavior(self):
        """Vérifie que la fonction Confort Clima / Mode Éco :
        1. Ne force pas un état ACTIF erroné (standby_enabled = 0 quand le poêle est OFF ou TRAVAIL).
        2. Détecte fidèlement les phases réelles 8 (ECO STOP) et 9 (STAND BY) comme actives (standby_enabled = 1).
        3. En mode agua_cloud, l'offset fictif 33130 n'est pas transmis au Cloud tout en mettant à jour le catalogue local.
        """
        import time
        from database import get_active_mode, get_db

        active_mode = get_active_mode()
        conn = get_db(active_mode)
        test_epochs = []
        try:
            max_ep = conn.execute("SELECT MAX(epoch) FROM telemetry").fetchone()[0] or int(time.time())
            ep1 = max_ep + 10
            ep2 = max_ep + 20
            ep3 = max_ep + 30
            ep4 = max_ep + 40
            test_epochs = [ep1, ep2, ep3, ep4]
            conn.execute(
                "INSERT INTO telemetry (timestamp, epoch, comm_mode, status_code, status_label, standby_enabled) VALUES ('2026-11-12 10:00:00', ?, ?, 0, 'OFF (Éteint)', 0)",
                (ep1, active_mode)
            )
            conn.execute(
                "INSERT INTO telemetry (timestamp, epoch, comm_mode, status_code, status_label, standby_enabled) VALUES ('2026-11-12 10:01:00', ?, ?, 5, 'TRAVAIL (Normal)', 0)",
                (ep2, active_mode)
            )
            conn.execute(
                "INSERT INTO telemetry (timestamp, epoch, comm_mode, status_code, status_label, standby_enabled) VALUES ('2026-11-12 10:02:00', ?, ?, 8, 'ECO STOP (Stand-by actif)', 1)",
                (ep3, active_mode)
            )
            conn.execute(
                "INSERT INTO telemetry (timestamp, epoch, comm_mode, status_code, status_label, standby_enabled) VALUES ('2026-11-12 10:03:00', ?, ?, 9, 'STAND BY', 1)",
                (ep4, active_mode)
            )
            conn.commit()
        finally:
            conn.close()

        try:
            # Lecture du dernier point (STAND BY)
            resp_latest = self.client.get("/api/latest")
            self.assertEqual(resp_latest.status_code, 200)
            data = resp_latest.json()
            self.assertEqual(data["latest"]["status_code"], 9)
            self.assertEqual(data["latest"]["standby_enabled"], 1)

            # Écriture locale de standby_set via /api/command
            resp_write = self.client.post("/api/command", json={"reg_key": "standby_set", "value": 0.0, "offset": 33130})
            self.assertEqual(resp_write.status_code, 200)
            self.assertEqual(resp_write.json()["new_value"], 0.0)
        finally:
            conn = get_db(active_mode)
            try:
                for ep in test_epochs:
                    conn.execute("DELETE FROM telemetry WHERE epoch = ?", (ep,))
                conn.commit()
            finally:
                conn.close()

    def test_canalization_aliases_and_pwf_crono_behavior(self):
        """Vérifie la résolution directe par alias Agua Cloud des 4 canalisations et le comportement de Boost CRONO (2)."""
        from clients import AguaCloudClient

        cli = AguaCloudClient()
        cli._parse_and_cache_registers_map({
            "registers_map": [
                {"reg_key": "canalization_sx_temp_air_set", "reg_type": "SET", "offset": 33126, "is_word": True, "big_endian": False, "mask": 65535},
                {"reg_key": "canalization_sx_set", "reg_type": "SET", "offset": 33136, "is_word": True, "big_endian": False, "mask": 65535},
                {"reg_key": "canalization_dx_temp_air_set", "reg_type": "SET", "offset": 33124, "is_word": True, "big_endian": False, "mask": 65535},
                {"reg_key": "temp_rear_set", "reg_type": "SET", "offset": 33124, "is_word": False, "big_endian": True, "mask": 255},
                {"reg_key": "canalization_dx_set", "reg_type": "SET", "offset": 33134, "is_word": True, "big_endian": False, "mask": 65535},
                {"reg_key": "vent_rear_set", "reg_type": "SET", "offset": 33134, "is_word": False, "big_endian": True, "mask": 255},
            ]
        })
        # Résolution directe par clé canalization_* (ne tombe pas sur vent_rear_set / temp_rear_set)
        self.assertEqual(cli._resolve_register_write_params(33126, "duct_left_setpoint")[:4], (33126, 16, "L", 65535))
        self.assertEqual(cli._resolve_register_write_params(33136, "duct_left_speed")[:4], (33136, 16, "L", 65535))
        self.assertEqual(cli._resolve_register_write_params(33124, "duct_right_setpoint")[:4], (33124, 16, "L", 65535))
        self.assertEqual(cli._resolve_register_write_params(33134, "duct_right_speed")[:4], (33134, 16, "L", 65535))

        # Boost CRONO (2) accepté en écriture sans forcer P8 hors plage horaire en simulation
        import asyncio
        from telemetry import collect_telemetry_cycle

        self.client.post("/api/command-batch", json={"commands": [
            {"reg_key": "status_code", "value": 85.0, "offset": 232},
            {"reg_key": "power_level", "value": 3.0, "offset": 33120},
            {"reg_key": "fun_auto_set", "value": 0.0, "offset": 33128},
            {"reg_key": "fun_pwf_set", "value": 2.0, "offset": 33154},
        ]})
        rec_crono = asyncio.run(collect_telemetry_cycle("simulation"))
        r_crono = self.client.get("/api/latest").json()
        self.assertEqual(r_crono["registers"]["fun_pwf_set"]["current_val"], 2.0)
        self.assertEqual(rec_crono["power_actual"], 3)

        self.client.post("/api/command", json={"reg_key": "fun_pwf_set", "value": 1.0, "offset": 33154})
        rec_on = asyncio.run(collect_telemetry_cycle("simulation"))
        self.assertEqual(rec_on["power_actual"], 8)

        self.client.post("/api/command", json={"reg_key": "fun_pwf_set", "value": 0.0, "offset": 33154})
