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
            # - auto flamme seulement activé (fun_auto=1, ventilations=0)
            # - consignes en hors-gel (7°C)
            resp_latest = self.client.get("/api/latest")
            latest_json = resp_latest.json()
            regs = latest_json["registers"]
            self.assertEqual(regs["fun_pwf_set"]["current_val"], 0.0)
            self.assertEqual(regs["standby_set"]["current_val"], 0.0)
            self.assertEqual(regs["chrono_week_enable_set"]["current_val"], 0.0)
            self.assertEqual(regs["fun_auto_set"]["current_val"], 1.0)
            self.assertEqual(regs["fan_front_speed"]["current_val"], 0.0)
            self.assertEqual(regs["duct_left_speed"]["current_val"], 0.0)
            self.assertEqual(regs["duct_right_speed"]["current_val"], 0.0)
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

    def test_silence_agua_cloud_skips_unwritable_standby(self):
        """En mode agua_cloud avec can_write_eco=False, Silence n'écrit pas standby_set dans modified_keys ni command_audit."""
        import asyncio
        import time
        from unittest.mock import AsyncMock, patch

        from database import get_db
        from services.silence_service import activate_silence_mode, deactivate_silence_mode
        from tests.helpers import temporary_settings

        conn = get_db("agua_cloud")
        test_epoch = 0
        try:
            max_ep = conn.execute("SELECT MAX(epoch) FROM telemetry").fetchone()[0] or int(time.time())
            test_epoch = max_ep + 100
            conn.execute(
                "INSERT INTO telemetry (timestamp, epoch, comm_mode, status_code, status_label) VALUES ('2026-11-11 12:10:00', ?, 'agua_cloud', 5, 'TRAVAIL (Normal)')",
                (test_epoch,),
            )
            conn.execute("DELETE FROM command_audit")
            conn.commit()
        finally:
            conn.close()

        fake_caps = {"can_write_eco": False}
        fake_latest = {"status_code": 5, "set_silece_set": 1}
        try:
            with (
                temporary_settings({"comm_mode": "agua_cloud", "agua_email": "", "agua_password": ""}),
                patch("services.silence_service.agua_client.get_capabilities", return_value=fake_caps),
                patch("services.silence_service.collect_telemetry_cycle", new=AsyncMock(return_value=fake_latest)),
            ):
                res_act = asyncio.run(activate_silence_mode(1.0))
                self.assertNotIn("standby_set", res_act["silence_mode"]["modified_keys"])
                self.assertNotIn("standby_set", res_act["silence_mode"]["initial_state"])

                conn = get_db("agua_cloud")
                try:
                    aud_keys = [r["reg_key"] for r in conn.execute("SELECT reg_key FROM command_audit").fetchall()]
                finally:
                    conn.close()
                self.assertNotIn("standby_set", aud_keys)

                asyncio.run(deactivate_silence_mode())
        finally:
            conn = get_db("agua_cloud")
            try:
                conn.execute("DELETE FROM telemetry WHERE epoch = ?", (test_epoch,))
                conn.execute("DELETE FROM command_audit")
                conn.commit()
            finally:
                conn.close()

    def test_silence_override_restores_previous_first_and_eco_boost_deactivate_silence(self):
        """La surcharge manuelle (ou l'activation Éco/Boost) restaure d'abord l'état précédent avant d'appliquer la nouvelle commande."""
        import time
        from database import get_active_mode, get_db

        active_mode = get_active_mode()
        conn = get_db(active_mode)
        try:
            max_ep = conn.execute("SELECT MAX(epoch) FROM telemetry").fetchone()[0] or int(time.time())
            test_epoch = max_ep + 200
            conn.execute(
                "INSERT INTO telemetry (timestamp, epoch, comm_mode, status_code, status_label) VALUES ('2026-11-11 12:15:00', ?, ?, 5, 'TRAVAIL (Normal)')",
                (test_epoch, active_mode),
            )
            for rk, val in [
                ("temp_amb_setpoint", 21.0),
                ("fan_front_speed", 4.0),
                ("fun_auto_set", 0.0),
                ("standby_set", 0.0),
                ("fun_pwf_set", 0.0),
                ("chrono_week_enable_set", 0.0),
            ]:
                conn.execute("UPDATE registers_catalog SET current_val = ? WHERE reg_key = ?", (val, rk))
            conn.commit()
        finally:
            conn.close()

        try:
            # 1. Activer Silence puis appliquer Boost via /api/command
            self.assertEqual(self.client.post("/api/silence/activate", json={"duration_hours": 1.0}).status_code, 200)
            conn = get_db(active_mode)
            try:
                conn.execute("DELETE FROM command_audit")
                conn.commit()
            finally:
                conn.close()

            resp_boost = self.client.post("/api/command", json={"reg_key": "fun_pwf_set", "value": 1})
            self.assertEqual(resp_boost.status_code, 200)
            self.assertFalse(resp_boost.json()["silence_mode"]["active"])

            conn = get_db(active_mode)
            try:
                rows = conn.execute("SELECT reg_key, new_value FROM command_audit ORDER BY id ASC").fetchall()
            finally:
                conn.close()
            seq = [(r["reg_key"], r["new_value"]) for r in rows]
            # La restauration (temp=21, fan=4, pwf=0) doit précéder l'écriture finale fun_pwf_set=1
            self.assertIn(("temp_amb_setpoint", 21.0), seq)
            self.assertIn(("fan_front_speed", 4.0), seq)
            self.assertEqual(seq[-1], ("fun_pwf_set", 1.0))

            # 2. Réactiver Silence puis activer Mode Éco (standby_set=1)
            self.assertEqual(self.client.post("/api/silence/activate", json={"duration_hours": 1.0}).status_code, 200)
            resp_eco = self.client.post("/api/command", json={"reg_key": "standby_set", "value": 1})
            self.assertEqual(resp_eco.status_code, 200)
            self.assertFalse(resp_eco.json()["silence_mode"]["active"])
            regs_after = self.client.get("/api/latest").json()["registers"]
            self.assertEqual(regs_after["standby_set"]["current_val"], 1.0)
            self.assertEqual(regs_after["temp_amb_setpoint"]["current_val"], 21.0)
        finally:
            conn = get_db(active_mode)
            try:
                conn.execute("DELETE FROM telemetry WHERE epoch = ?", (test_epoch,))
                conn.execute("DELETE FROM command_audit")
                conn.commit()
            finally:
                conn.close()

    def test_silence_deactivate_uses_active_chrono_program(self):
        """Si Chrono était actif avant Silence et qu'un programme est dans la plage horaire, sa consigne prime sur l'état précédent."""
        import asyncio
        from datetime import datetime
        import time
        from database import get_active_mode, get_db
        from services.silence_service import activate_silence_mode, deactivate_silence_mode

        active_mode = get_active_mode()
        conn = get_db(active_mode)
        try:
            max_ep = conn.execute("SELECT MAX(epoch) FROM telemetry").fetchone()[0] or int(time.time())
            test_epoch = max_ep + 300
            conn.execute(
                "INSERT INTO telemetry (timestamp, epoch, comm_mode, status_code, status_label) VALUES ('2026-11-11 12:20:00', ?, ?, 5, 'TRAVAIL (Normal)')",
                (test_epoch, active_mode),
            )
            for rk, val in [
                ("chrono_week_enable_set", 1.0),
                ("temp_amb_setpoint", 18.0),
                ("power_level", 2.0),
                ("fan_front_speed", 2.0),
                ("duct_left_setpoint", 18.0),
                ("duct_left_speed", 1.0),
                ("duct_right_setpoint", 18.0),
                ("duct_right_speed", 1.0),
                # P1 : tous les jours, 08:00 (48) -> 10:00 (60)
                ("chrono_p1_start_set", 48.0),
                ("chrono_p1_stop_set", 60.0),
                ("chrono_p1_days_mask", 127.0),
                ("chrono_p1_temperature_set", 22.0),
                ("chrono_p1_power_set", 6.0),
                ("chrono_p1_fan_front_set", 5.0),
                ("chrono_p1_tcanl_set", 23.0),
                ("chrono_p1_canl_set", 4.0),
                ("chrono_p1_tcanr_set", 21.0),
                ("chrono_p1_canr_set", 3.0),
            ]:
                conn.execute("UPDATE registers_catalog SET current_val = ? WHERE reg_key = ?", (val, rk))
            conn.commit()
        finally:
            conn.close()

        try:
            asyncio.run(activate_silence_mode(1.0))
            # 09:00 -> dans le créneau P1 (08:00-10:00)
            asyncio.run(deactivate_silence_mode(now_dt=datetime(2026, 11, 11, 9, 0, 0)))
            regs = self.client.get("/api/latest").json()["registers"]
            self.assertEqual(regs["chrono_week_enable_set"]["current_val"], 1.0)
            self.assertEqual(regs["temp_amb_setpoint"]["current_val"], 22.0)
            self.assertEqual(regs["power_level"]["current_val"], 6.0)
            self.assertEqual(regs["fan_front_speed"]["current_val"], 5.0)
            self.assertEqual(regs["duct_left_setpoint"]["current_val"], 23.0)
            self.assertEqual(regs["duct_left_speed"]["current_val"], 4.0)
            self.assertEqual(regs["duct_right_setpoint"]["current_val"], 21.0)
            self.assertEqual(regs["duct_right_speed"]["current_val"], 3.0)
        finally:
            conn = get_db(active_mode)
            try:
                conn.execute("DELETE FROM telemetry WHERE epoch = ?", (test_epoch,))
                conn.commit()
            finally:
                conn.close()

    def test_silence_override_preserves_explicit_offset_and_paris_tz(self):
        """Vérifie la conservation de l'offset explicite des surcharges et le fuseau Europe/Paris de Chrono."""
        from datetime import datetime
        from unittest.mock import patch
        from zoneinfo import ZoneInfo

        from services.silence_service import _build_override_commands, _find_active_chrono_program

        cmds = _build_override_commands(
            [{"reg_key": "custom_reg", "value": 42, "offset": 33999}],
            regs={},
        )
        self.assertEqual(cmds, [{"reg_key": "custom_reg", "value": 42.0, "offset": 33999}])

        with patch("services.silence_service.datetime") as mock_dt:
            mock_dt.now.return_value = datetime(2026, 11, 11, 9, 0, 0, tzinfo=ZoneInfo("Europe/Paris"))
            prog = _find_active_chrono_program(
                {
                    "chrono_p1_start_set": {"current_val": 48.0},
                    "chrono_p1_stop_set": {"current_val": 60.0},
                    "chrono_p1_days_mask": {"current_val": 127.0},
                    "chrono_p1_temperature_set": {"current_val": 21.5},
                }
            )
            mock_dt.now.assert_called_once_with(ZoneInfo("Europe/Paris"))
            self.assertIsNotNone(prog)
            self.assertEqual(prog["values"]["temp_amb_setpoint"], 21.5)
