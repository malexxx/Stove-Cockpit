"""Tests API du Mode Silence ! intelligent (poêle éteint & allumé, restauration complète)."""
from tests.helpers import SimulationApiTestCase


class TestSilenceAPI(SimulationApiTestCase):
    def test_silence_status(self):
        resp = self.client.get("/api/silence/status")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn("active", data)
        self.assertIn("remaining_seconds", data)

    def test_silence_mode_intelligent_stove_off(self):
        import time
        from database import get_active_mode, get_db
        active_mode = get_active_mode()
        conn = get_db(active_mode)
        try:
            max_ep = conn.execute("SELECT MAX(epoch) FROM telemetry").fetchone()[0] or int(time.time())
            test_epoch = max_ep + 100
            # 1. Simuler poêle éteint (status_code = 0)
            conn.execute("INSERT INTO telemetry (timestamp, epoch, comm_mode, status_code, status_label) VALUES ('2026-11-11 12:00:00', ?, ?, 0, 'OFF (Éteint)')", (test_epoch, active_mode))
            # Initialiser des consignes personnalisées
            for rk, _off, val in [("temp_amb_setpoint", 33122, 21.0), ("duct_left_setpoint", 33126, 22.0), ("duct_right_setpoint", 33124, 20.0), ("power_level", 33120, 4.0)]:
                conn.execute("UPDATE registers_catalog SET current_val = ? WHERE reg_key = ?", (val, rk))
            conn.commit()
        finally:
            conn.close()

        try:
            # 2. Activation du mode Silence intelligent
            resp_act = self.client.post("/api/silence/activate", json={"duration_hours": 1.0})
            self.assertEqual(resp_act.status_code, 200)
            data_act = resp_act.json()
            self.assertEqual(data_act["status"], "ok")
            self.assertTrue(data_act["silence_mode"]["active"])
            self.assertFalse(data_act["silence_mode"]["is_stove_on"])
            self.assertIn("temp_amb_setpoint", data_act["silence_mode"]["modified_keys"])

            # Vérifier que toutes les consignes sont passées en hors gel (7°C)
            resp_latest = self.client.get("/api/latest")
            latest_json = resp_latest.json()
            regs = latest_json["registers"]
            self.assertEqual(regs["temp_amb_setpoint"]["current_val"], 7.0)
            self.assertEqual(regs["duct_left_setpoint"]["current_val"], 7.0)
            self.assertEqual(regs["duct_right_setpoint"]["current_val"], 7.0)
            # Le registre EEPROM #33250 (set_silece_set) a été retiré (inactif sur Nobis A10, #107:b11=0)
            self.assertNotIn("set_silece_set", regs)
            self.assertEqual(data_act["latest"]["set_silece_set"], 1)
            # Seules les 3 consignes doivent avoir été modifiées (pas la puissance, ni ventilations, ni auto, ni éco, ni chrono)
            self.assertEqual(
                sorted(data_act["silence_mode"]["modified_keys"]),
                sorted(["temp_amb_setpoint", "duct_left_setpoint", "duct_right_setpoint"])
            )

            # 3. Désactivation et restauration
            resp_deact = self.client.post("/api/silence/deactivate")
            self.assertEqual(resp_deact.status_code, 200)
            data_deact = resp_deact.json()
            self.assertFalse(data_deact["silence_mode"]["active"])

            resp_latest2 = self.client.get("/api/latest")
            latest_json2 = resp_latest2.json()
            regs2 = latest_json2["registers"]
            self.assertEqual(regs2["temp_amb_setpoint"]["current_val"], 21.0)
            self.assertEqual(regs2["duct_left_setpoint"]["current_val"], 22.0)
            self.assertEqual(regs2["duct_right_setpoint"]["current_val"], 20.0)
            self.assertNotIn("set_silece_set", regs2)
            self.assertEqual(data_deact["latest"]["set_silece_set"], 0)
        finally:
            conn = get_db(active_mode)
            try:
                conn.execute("DELETE FROM telemetry WHERE epoch = ?", (test_epoch,))
                conn.commit()
            finally:
                conn.close()

    def test_silence_mode_intelligent_stove_on(self):
        import time
        from database import get_active_mode, get_db
        active_mode = get_active_mode()
        conn = get_db(active_mode)
        try:
            max_ep = conn.execute("SELECT MAX(epoch) FROM telemetry").fetchone()[0] or int(time.time())
            test_epoch = max_ep + 100
            # 1. Simuler poêle allumé (status_code = 5, TRAVAIL)
            conn.execute("INSERT INTO telemetry (timestamp, epoch, comm_mode, status_code, status_label) VALUES ('2026-11-11 12:05:00', ?, ?, 5, 'TRAVAIL (Normal)')", (test_epoch, active_mode))
            init_vals = [
                ("fun_pwf_set", 33154, 1.0),
                ("standby_set", 33130, 1.0),
                ("chrono_week_enable_set", 33162, 1.0),
                ("fun_auto_set", 33128, 0.0),
                ("fan_front_speed", 33132, 3.0),
                ("duct_left_speed", 33136, 2.0),
                ("duct_right_speed", 33134, 2.0),
                ("temp_amb_setpoint", 33122, 20.0),
                ("duct_left_setpoint", 33126, 21.0),
                ("duct_right_setpoint", 33124, 19.0),
            ]
            for rk, _off, val in init_vals:
                conn.execute("UPDATE registers_catalog SET current_val = ? WHERE reg_key = ?", (val, rk))
            conn.commit()
        finally:
            conn.close()

        try:
            # 2. Activation du mode Silence intelligent poêle allumé
            resp_act = self.client.post("/api/silence/activate", json={"duration_hours": 2.0})
            self.assertEqual(resp_act.status_code, 200)
            data_act = resp_act.json()
            self.assertEqual(data_act["status"], "ok")
            self.assertTrue(data_act["silence_mode"]["active"])
            self.assertTrue(data_act["silence_mode"]["is_stove_on"])

            # Vérifier les ordres de bascule :
            # - boost, éco, chrono désactivés (0)
            # - auto total activé (fun_auto=1, ventilations=8)
            # - consignes en hors-gel (7°C)
            resp_latest = self.client.get("/api/latest")
            latest_json = resp_latest.json()
            regs = latest_json["registers"]
            self.assertEqual(regs["fun_pwf_set"]["current_val"], 0.0)
            self.assertEqual(regs["standby_set"]["current_val"], 0.0)
            self.assertEqual(regs["chrono_week_enable_set"]["current_val"], 0.0)
            self.assertEqual(regs["fun_auto_set"]["current_val"], 1.0)
            self.assertEqual(regs["fan_front_speed"]["current_val"], 8.0)
            self.assertEqual(regs["duct_left_speed"]["current_val"], 8.0)
            self.assertEqual(regs["duct_right_speed"]["current_val"], 8.0)
            self.assertEqual(regs["temp_amb_setpoint"]["current_val"], 7.0)
            self.assertEqual(regs["duct_left_setpoint"]["current_val"], 7.0)
            self.assertEqual(regs["duct_right_setpoint"]["current_val"], 7.0)
            self.assertNotIn("set_silece_set", regs)
            self.assertEqual(data_act["latest"]["set_silece_set"], 1)

            # 3. Désactivation et restauration intégrale des paramètres
            resp_deact = self.client.post("/api/silence/deactivate")
            self.assertEqual(resp_deact.status_code, 200)
            data_deact = resp_deact.json()

            resp_latest2 = self.client.get("/api/latest")
            latest_json2 = resp_latest2.json()
            regs2 = latest_json2["registers"]
            self.assertEqual(regs2["fun_pwf_set"]["current_val"], 1.0)
            self.assertEqual(regs2["standby_set"]["current_val"], 1.0)
            self.assertEqual(regs2["chrono_week_enable_set"]["current_val"], 1.0)
            self.assertEqual(regs2["fun_auto_set"]["current_val"], 0.0)
            self.assertEqual(regs2["fan_front_speed"]["current_val"], 3.0)
            self.assertEqual(regs2["duct_left_speed"]["current_val"], 2.0)
            self.assertEqual(regs2["duct_right_speed"]["current_val"], 2.0)
            self.assertEqual(regs2["temp_amb_setpoint"]["current_val"], 20.0)
            self.assertEqual(regs2["duct_left_setpoint"]["current_val"], 21.0)
            self.assertEqual(regs2["duct_right_setpoint"]["current_val"], 19.0)
            self.assertNotIn("set_silece_set", regs2)
            self.assertEqual(data_deact["latest"]["set_silece_set"], 0)
        finally:
            conn = get_db(active_mode)
            try:
                conn.execute("DELETE FROM telemetry WHERE epoch = ?", (test_epoch,))
                conn.commit()
            finally:
                conn.close()
