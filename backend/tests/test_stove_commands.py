"""
Tests de vérification exhaustive de chaque ordre et configuration envoyé au poêle Nobis.
Vérifie la bonne prise en compte de chaque commande (consignes, ventilations, puissances,
modes spéciaux, synchronisation horaire, réapprovisionnement, rollback, tarages et Matter).
"""
import unittest
from fastapi.testclient import TestClient

from database import get_db, get_sys_db
from main import app


class TestStoveCommandsAndConfigurations(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sconn = get_sys_db()
        try:
            row = sconn.execute("SELECT value FROM settings WHERE key = 'comm_mode'").fetchone()
            cls.orig_mode = row["value"] if (row and row["value"]) else "agua_cloud"
            sconn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('comm_mode', 'simulation')")
            sconn.commit()
        finally:
            sconn.close()
        cls.client = TestClient(app, raise_server_exceptions=False)

    @classmethod
    def tearDownClass(cls):
        sconn = get_sys_db()
        try:
            sconn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('comm_mode', ?)", (cls.orig_mode,))
            sconn.commit()
        finally:
            sconn.close()

    def setUp(self):
        sconn = get_sys_db()
        try:
            sconn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('comm_mode', 'simulation')")
            sconn.execute("DELETE FROM settings WHERE key = 'silence_state'")
            sconn.commit()
        finally:
            sconn.close()

    def test_01_unit_temperature_setpoints(self):
        """Test consignes de température (Salon, SX, DX)."""
        for rk, val, off in [
            ("temp_amb_setpoint", 22.5, 33122),
            ("duct_left_setpoint", 19.0, 33126),
            ("duct_right_setpoint", 20.0, 33124),
        ]:
            resp = self.client.post("/api/command", json={"reg_key": rk, "value": val, "offset": off})
            self.assertEqual(resp.status_code, 200, f"Failed for {rk}")
            data = resp.json()
            self.assertEqual(data["status"], "ok")
            self.assertEqual(data["reg_key"], rk)
            self.assertEqual(data["new_value"], val)

            # Vérification de bonne prise en compte dans /api/latest
            regs = self.client.get("/api/latest").json()["registers"]
            self.assertEqual(regs[rk]["current_val"], val, f"Register {rk} not updated in latest")

    def test_02_unit_fans(self):
        """Test vitesses de ventilation (Salon, SX, DX) de 0 à 8."""
        for rk, off in [
            ("fan_front_speed", 33132),
            ("duct_left_speed", 33136),
            ("duct_right_speed", 33134),
        ]:
            for speed in [0.0, 3.0, 7.0, 8.0]:
                resp = self.client.post("/api/command", json={"reg_key": rk, "value": speed, "offset": off})
                self.assertEqual(resp.status_code, 200, f"Failed for {rk}={speed}")
                self.assertEqual(resp.json()["new_value"], speed)

                # Vérification prise en compte
                regs = self.client.get("/api/latest").json()["registers"]
                self.assertEqual(regs[rk]["current_val"], speed)

            # Test rejet hors limites (> 8 ou < 0)
            r_bad = self.client.post("/api/command", json={"reg_key": rk, "value": 9.0, "offset": off})
            self.assertEqual(r_bad.status_code, 400)

    def test_03_unit_power_level(self):
        """Test consigne de puissance combustion P1..P7."""
        rk, off = "power_level", 33120
        for p in [1.0, 3.0, 5.0, 7.0]:
            resp = self.client.post("/api/command", json={"reg_key": rk, "value": p, "offset": off})
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.json()["new_value"], p)
            regs = self.client.get("/api/latest").json()["registers"]
            self.assertEqual(regs[rk]["current_val"], p)

        # Hors limites (P0 ou P8 non autorisés directement sur ce registre 1..7)
        r_zero = self.client.post("/api/command", json={"reg_key": rk, "value": 0.0, "offset": off})
        self.assertEqual(r_zero.status_code, 400)
        r_eight = self.client.post("/api/command", json={"reg_key": rk, "value": 8.0, "offset": off})
        self.assertEqual(r_eight.status_code, 400)

    def test_04_modes_auto_eco_boost_silence(self):
        """Test des modes Auto, Éco (standby), Boost (pwf) et Silence."""
        # 1. Auto
        r_auto = self.client.post("/api/command", json={"reg_key": "fun_auto_set", "value": 1.0, "offset": 33128})
        self.assertEqual(r_auto.status_code, 200)
        regs = self.client.get("/api/latest").json()["registers"]
        self.assertEqual(regs["fun_auto_set"]["current_val"], 1.0)

        # 2. Standby / Eco
        r_eco = self.client.post("/api/command", json={"reg_key": "standby_set", "value": 1.0, "offset": 33130})
        self.assertEqual(r_eco.status_code, 200)
        regs = self.client.get("/api/latest").json()["registers"]
        self.assertEqual(regs["standby_set"]["current_val"], 1.0)

        # 3. Boost (pwf)
        for pwf_val in [0.0, 1.0, 2.0]:
            r_boost = self.client.post("/api/command", json={"reg_key": "fun_pwf_set", "value": pwf_val, "offset": 33154})
            self.assertEqual(r_boost.status_code, 200)
            regs = self.client.get("/api/latest").json()["registers"]
            self.assertEqual(regs["fun_pwf_set"]["current_val"], pwf_val)

        # 4. Registre #33250 (set_silece_set) retiré du catalogue (inactif sur Nobis A10, #107 bit 2048 = 0)
        regs = self.client.get("/api/latest").json()["registers"]
        self.assertNotIn("set_silece_set", regs)

    def test_05_stove_on_off(self):
        """Test ordre Allumage (85) et Extinction (170) et mapping (6->85, 9->170)."""
        # Allumage 85
        r_on = self.client.post("/api/command", json={"reg_key": "status_code", "value": 85.0, "offset": 232})
        self.assertEqual(r_on.status_code, 200)
        self.assertEqual(r_on.json()["new_value"], 85.0)

        # Extinction 170
        r_off = self.client.post("/api/command", json={"reg_key": "status_code", "value": 170.0, "offset": 232})
        self.assertEqual(r_off.status_code, 200)
        self.assertEqual(r_off.json()["new_value"], 170.0)

        # Mapping raccourci 6 -> 85
        r_m6 = self.client.post("/api/command", json={"reg_key": "status_code", "value": 6.0, "offset": 232})
        self.assertEqual(r_m6.status_code, 200)
        self.assertEqual(r_m6.json()["new_value"], 85.0)

        # Mapping raccourci 9 -> 170
        r_m9 = self.client.post("/api/command", json={"reg_key": "status_code", "value": 9.0, "offset": 232})
        self.assertEqual(r_m9.status_code, 200)
        self.assertEqual(r_m9.json()["new_value"], 170.0)

    def test_06_tarages_trims(self):
        """Test tarage mélange granulés (offset 70) et extracteur fumées (offset 71)."""
        for rk, off, val in [("trim_pellet_pct", 70, -3.0), ("trim_exhaust_pct", 71, 4.0)]:
            resp = self.client.post("/api/command", json={"reg_key": rk, "value": val, "offset": off})
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.json()["new_value"], val)
            regs = self.client.get("/api/latest").json()["registers"]
            self.assertEqual(regs[rk]["current_val"], val)

        # Rejet hors limites (-5%..+5%)
        r_low = self.client.post("/api/command", json={"reg_key": "trim_pellet_pct", "value": -10.0, "offset": 70})
        self.assertEqual(r_low.status_code, 400)
        r_high = self.client.post("/api/command", json={"reg_key": "trim_exhaust_pct", "value": 15.0, "offset": 71})
        self.assertEqual(r_high.status_code, 400)

    def test_07_command_batch(self):
        """Test envoi groupé atomique multi-registres."""
        cmds = [
            {"reg_key": "temp_amb_setpoint", "value": 21.0, "offset": 33122},
            {"reg_key": "fan_front_speed", "value": 4.0, "offset": 33132},
            {"reg_key": "duct_left_speed", "value": 2.0, "offset": 33136},
            {"reg_key": "duct_right_speed", "value": 2.0, "offset": 33134},
            {"reg_key": "power_level", "value": 3.0, "offset": 33120},
        ]
        resp = self.client.post("/api/command-batch", json={"commands": cmds})
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["status"], "ok")
        self.assertEqual(data["count"], 5)

        # Vérifier prise en compte dans latest
        regs = self.client.get("/api/latest").json()["registers"]
        self.assertEqual(regs["temp_amb_setpoint"]["current_val"], 21.0)
        self.assertEqual(regs["fan_front_speed"]["current_val"], 4.0)
        self.assertEqual(regs["duct_left_speed"]["current_val"], 2.0)
        self.assertEqual(regs["duct_right_speed"]["current_val"], 2.0)
        self.assertEqual(regs["power_level"]["current_val"], 3.0)

    def test_08_stove_set_unified_endpoint(self):
        """Test point d'entrée modulaire /api/stove/set (temp, fan, power)."""
        # Température avec mapping
        r_t = self.client.post("/api/stove/set", json={"type": "temp", "zone": "salon", "value": 23.0})
        self.assertEqual(r_t.status_code, 200)
        self.assertEqual(r_t.json()["new_value"], 23.0)

        # Clamping hors gel (6 -> 7.0)
        r_f = self.client.post("/api/stove/set", json={"type": "temp", "zone": "salon", "value": 5.0})
        self.assertEqual(r_f.status_code, 200)
        self.assertEqual(r_f.json()["new_value"], 7.0)

        # Ventilation
        r_fan = self.client.post("/api/stove/set", json={"type": "fan", "zone": "dx", "value": 5.0})
        self.assertEqual(r_fan.status_code, 200)
        self.assertEqual(r_fan.json()["new_value"], 5.0)

        # Power 0 (Ralenti Éco)
        r_p0 = self.client.post("/api/stove/set", json={"type": "power", "value": 0.0})
        self.assertEqual(r_p0.status_code, 200)
        self.assertEqual(r_p0.json()["new_value"], 0.0)

        # Power 8 (Boost)
        r_p8 = self.client.post("/api/stove/set", json={"type": "power", "value": 8.0})
        self.assertEqual(r_p8.status_code, 200)
        self.assertEqual(r_p8.json()["reg_key"], "fun_pwf_set")

        # Power 1..7 (avec vérification de l'offset 33120)
        r_p5 = self.client.post("/api/stove/set", json={"type": "power", "value": 5.0})
        self.assertEqual(r_p5.status_code, 200)
        self.assertEqual(r_p5.json()["reg_key"], "power_level")
        self.assertEqual(r_p5.json()["new_value"], 5.0)

    def test_09_refill_hopper(self):
        """Test réapprovisionnement trémie et mise à jour stock."""
        resp = self.client.post("/api/refill-hopper", json={"bags_added": 1.0, "target_pct": 90.0})
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["status"], "ok")
        self.assertEqual(data["pellet_hopper_pct"], 90.0)

        # Vérifier dans latest
        latest = self.client.get("/api/latest").json()["latest"]
        self.assertEqual(latest["pellet_hopper_pct"], 90.0)

    def test_10_pellet_batch_raz(self):
        """Test RAZ d'un lot de granulés."""
        # Modifier d'abord les trims
        self.client.post("/api/command", json={"reg_key": "trim_pellet_pct", "value": 2.0, "offset": 70})
        self.client.post("/api/command", json={"reg_key": "trim_exhaust_pct", "value": -2.0, "offset": 71})

        # Exécuter RAZ
        resp = self.client.post("/api/pellet-batch/raz", json={"pellet_brand": "Total Pellets Premium"})
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["status"], "ok")
        self.assertEqual(data["pellet_batch_state"]["pellet_brand"], "Total Pellets Premium")

        # Vérifier que les trims sont remis à 0
        regs = self.client.get("/api/latest").json()["registers"]
        self.assertEqual(regs["trim_pellet_pct"]["current_val"], 0.0)
        self.assertEqual(regs["trim_exhaust_pct"]["current_val"], 0.0)

    def test_11_sync_clock(self):
        """Test synchronisation horloge poêle."""
        resp = self.client.post("/api/sync-clock")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["status"], "ok")
        self.assertIn("synced_to", data)
        self.assertIn("latest", data)
        self.assertTrue(len(data["latest"]["stove_clock_str"]) > 5)

    def test_12_silence_mode_full_cycle(self):
        """Test cycle complet Mode Silence (activation, consignes à 7, puis restauration)."""
        # Initialiser consigne à 21.0
        self.client.post("/api/command", json={"reg_key": "temp_amb_setpoint", "value": 21.0, "offset": 33122})

        # Activer Silence pour 1h
        r_act = self.client.post("/api/silence/activate", json={"duration_hours": 1.0})
        self.assertEqual(r_act.status_code, 200)
        self.assertTrue(r_act.json()["silence_mode"]["active"])

        # Consigne passée en hors gel (7°C) et état Silence logiciel reflété en télémétrie
        latest_act = self.client.get("/api/latest").json()
        regs = latest_act["registers"]
        self.assertEqual(regs["temp_amb_setpoint"]["current_val"], 7.0)
        self.assertNotIn("set_silece_set", regs)
        self.assertEqual(latest_act["latest"]["set_silece_set"], 1)

        # Désactiver Silence
        r_deact = self.client.post("/api/silence/deactivate")
        self.assertEqual(r_deact.status_code, 200)
        self.assertFalse(r_deact.json()["silence_mode"]["active"])

        # Consigne restaurée à 21.0 et état Silence logiciel remis à 0
        latest_deact = self.client.get("/api/latest").json()
        regs = latest_deact["registers"]
        self.assertEqual(regs["temp_amb_setpoint"]["current_val"], 21.0)
        self.assertNotIn("set_silece_set", regs)
        self.assertEqual(latest_deact["latest"]["set_silece_set"], 0)

    def test_13_rollback(self):
        """Test annulation (rollback) d'une consigne."""
        self.client.post("/api/command", json={"reg_key": "temp_amb_setpoint", "value": 25.0, "offset": 33122})

        conn = get_db("simulation")
        try:
            row = conn.execute(
                "SELECT id, old_value, new_value FROM command_audit WHERE reg_key='temp_amb_setpoint' ORDER BY id DESC LIMIT 1"
            ).fetchone()
            self.assertIsNotNone(row)
            audit_id = row["id"]
            old_val = float(row["old_value"])
        finally:
            conn.close()

        r_rb = self.client.post(f"/api/rollback/{audit_id}")
        self.assertEqual(r_rb.status_code, 200)

        regs = self.client.get("/api/latest").json()["registers"]
        self.assertEqual(regs["temp_amb_setpoint"]["current_val"], old_val)

    def test_14_matter_webhook(self):
        """Test webhook passerelle Matter (set_power ON/OFF, set_temperature)."""
        from tests.helpers import get_matter_webhook_headers

        m_headers = get_matter_webhook_headers()
        r_on = self.client.post("/api/matter/webhook", json={"action": "set_power", "state": "ON"}, headers=m_headers)
        self.assertEqual(r_on.status_code, 200)
        self.assertEqual(r_on.json()["status"], "ok")

        r_off = self.client.post("/api/matter/webhook", json={"action": "set_power", "state": "OFF"}, headers=m_headers)
        self.assertEqual(r_off.status_code, 200)
        self.assertEqual(r_off.json()["status"], "ok")

        r_temp = self.client.post("/api/matter/webhook", json={"action": "set_temperature", "temperature": 20.0}, headers=m_headers)
        self.assertEqual(r_temp.status_code, 200)
        regs = self.client.get("/api/latest").json()["registers"]
        self.assertEqual(regs["temp_amb_setpoint"]["current_val"], 20.0)


if __name__ == "__main__":
    unittest.main()
