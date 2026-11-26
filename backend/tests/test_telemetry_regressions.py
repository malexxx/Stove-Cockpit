# -*- coding: utf-8 -*-
"""Tests de régression télémétrie, clients Agua/UART, Mode Silence, Analytics et trémie (BB-06, BB-10..BB-14)."""
import asyncio
from datetime import datetime
import json
import sqlite3
from unittest.mock import AsyncMock, MagicMock, patch
from zoneinfo import ZoneInfo

import clients
import telemetry
from analytics import evaluate_batch_combustion_and_trim
from config import TELEMETRY_COLUMNS
from database import get_db, get_sys_db
from tests.helpers import BugBountyTestCase, temporary_settings


class TestTelemetryRegressions(BugBountyTestCase):
    def test_bb06_test_connection_does_not_overwrite_singleton_or_settings(self):
        orig_attrs = (
            clients.agua_client.token_jwt,
            clients.agua_client.refresh_token,
            clients.agua_client.id_device,
            clients.agua_client.id_product,
            clients.agua_client.working_write_endpoint,
        )
        with temporary_settings(
            {
                "comm_mode": "simulation",
                "agua_id_device": "orig-dev-01",
                "agua_id_product": "orig-prod-01",
            }
        ):
            clients.agua_client.token_jwt = "orig-jwt"
            clients.agua_client.refresh_token = "orig-refresh"
            clients.agua_client.id_device = "orig-dev-01"
            clients.agua_client.id_product = "orig-prod-01"
            clients.agua_client.working_write_endpoint = "/orig"

            seen_kwargs = {}

            async def fake_login(self_client, email, password, app_uuid, persist_discovery=True, settings=None):
                seen_kwargs["persist_discovery"] = persist_discovery
                seen_kwargs["is_singleton"] = self_client is clients.agua_client
                self_client.token_jwt = "temp-jwt"
                self_client.id_device = "temp-dev-99"
                self_client.id_product = "temp-prod-99"
                return {"token_ok": True}

            try:
                with patch.object(clients.AguaCloudClient, "login_and_discover", autospec=True, side_effect=fake_login):
                    resp = self.client.post(
                        "/api/test-connection",
                        json={
                            "comm_mode": "agua_cloud",
                            "agua_email": "test@example.com",
                            "agua_password": "secret",
                            "agua_uuid": "uuid-test",
                        },
                    )
                self.assertEqual(resp.status_code, 200)
                self.assertFalse(seen_kwargs.get("persist_discovery", True))
                self.assertFalse(seen_kwargs.get("is_singleton", True))
                self.assertEqual(clients.agua_client.token_jwt, "orig-jwt")
                self.assertEqual(clients.agua_client.id_device, "orig-dev-01")
                self.assertEqual(clients.agua_client.id_product, "orig-prod-01")
                self.assertEqual(clients.agua_client.working_write_endpoint, "/orig")

                conn = get_sys_db()
                try:
                    dev_row = conn.execute("SELECT value FROM settings WHERE key='agua_id_device'").fetchone()
                    self.assertEqual(dev_row["value"], "orig-dev-01")
                finally:
                    conn.close()

                # Vérifie persist_discovery=False vs persist_discovery=True sur un client isolé
                local_client = clients.AguaCloudClient()
                local_client._registered_uuids.add(("https://nobis.agua-iot.com", "700700", "uuid"))
                mock_http = AsyncMock()
                mock_resp_login = MagicMock(status_code=200)
                mock_resp_login.json.return_value = {"token": "jwt-1", "refresh_token": "ref-1"}
                mock_resp_devs = MagicMock(status_code=200)
                mock_resp_devs.json.return_value = {
                    "device": [{"id_device": "disc-dev-2", "id_product": "disc-prod-2", "name": "Nobis A10"}]
                }
                mock_resp_map = MagicMock(status_code=404)

                class _AsyncCtx:
                    async def __aenter__(self):
                        return mock_http

                    async def __aexit__(self, *args):
                        return False

                mock_http.post.side_effect = [mock_resp_login, mock_resp_devs, mock_resp_map]
                with patch("clients.borrow_http_client", return_value=_AsyncCtx()):
                    res_no_persist = asyncio.run(
                        local_client.login_and_discover("user@example.com", "p", "uuid", persist_discovery=False)
                    )
                self.assertTrue(res_no_persist["token_ok"])
                conn = get_sys_db()
                try:
                    dev_row = conn.execute("SELECT value FROM settings WHERE key='agua_id_device'").fetchone()
                    self.assertEqual(dev_row["value"], "orig-dev-01")
                finally:
                    conn.close()

                mock_http.post.side_effect = [mock_resp_login, mock_resp_devs, mock_resp_map]
                with patch("clients.borrow_http_client", return_value=_AsyncCtx()):
                    res_persist = asyncio.run(
                        local_client.login_and_discover("user@example.com", "p", "uuid", persist_discovery=True)
                    )
                self.assertTrue(res_persist["token_ok"])
                conn = get_sys_db()
                try:
                    dev_row = conn.execute("SELECT value FROM settings WHERE key='agua_id_device'").fetchone()
                    prod_row = conn.execute("SELECT value FROM settings WHERE key='agua_id_product'").fetchone()
                    self.assertEqual(dev_row["value"], "disc-dev-2")
                    self.assertEqual(prod_row["value"], "disc-prod-2")
                finally:
                    conn.close()
            finally:
                (
                    clients.agua_client.token_jwt,
                    clients.agua_client.refresh_token,
                    clients.agua_client.id_device,
                    clients.agua_client.id_product,
                    clients.agua_client.working_write_endpoint,
                ) = orig_attrs

    def test_bb10_signed_int8_trims_decoding_and_persistence(self):
        client = clients.AguaCloudClient()
        client.token_jwt = "fake-jwt"
        mock_http = AsyncMock()
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json.return_value = {
            "Items": [70, 71, 20, 21],
            "Values": [253, 251, 180, 215],
        }
        mock_http.post.return_value = mock_resp

        class _AsyncCtx:
            async def __aenter__(self):
                return mock_http

            async def __aexit__(self, *args):
                return False

        with patch("clients.borrow_http_client", return_value=_AsyncCtx()):
            buf = asyncio.run(client.read_buffer({"agua_id_device": "d1", "agua_id_product": "p1"}))
        self.assertEqual(buf[70], -3.0)
        self.assertEqual(buf[71], -5.0)

        sconn = get_db("local_gateway")
        max_row = sconn.execute("SELECT COALESCE(MAX(id), 0) FROM telemetry").fetchone()[0]
        orig_regs = {}
        try:
            for k in ("trim_pellet_pct", "trim_exhaust_pct"):
                r = sconn.execute("SELECT current_val FROM registers_catalog WHERE reg_key = ?", (k,)).fetchone()
                orig_regs[k] = r["current_val"] if r else 0.0
        finally:
            sconn.close()

        with temporary_settings({"comm_mode": "local_gateway", "local_gateway_url": "http://192.168.1.50"}):
            mock_buf = {8: 5.0, 1: 21.0, 20: 180.0, 21: 215.0, 70: 253.0, 71: 251.0}
            try:
                with patch(
                    "telemetry.local_gateway_client.read_buffer",
                    new_callable=AsyncMock,
                    return_value=mock_buf,
                ):
                    rec = asyncio.run(telemetry.collect_telemetry_cycle(force_mode="local_gateway"))
                self.assertEqual(rec["trim_pellet_pct"], -3)
                self.assertEqual(rec["trim_exhaust_pct"], -5)
            finally:
                sconn = get_db("local_gateway")
                try:
                    sconn.execute("DELETE FROM telemetry WHERE id > ?", (max_row,))
                    for k, val in orig_regs.items():
                        sconn.execute("UPDATE registers_catalog SET current_val = ? WHERE reg_key = ?", (val, k))
                    sconn.commit()
                finally:
                    sconn.close()

    def test_bb11_silence_reentry_preserves_initial_state_and_resets_silece(self):
        sim_conn = get_db("simulation")
        orig_regs = {}
        try:
            for k in ("power_level", "fan_front_speed"):
                r = sim_conn.execute("SELECT current_val FROM registers_catalog WHERE reg_key = ?", (k,)).fetchone()
                orig_regs[k] = r["current_val"] if r else 0.0
        finally:
            sim_conn.close()

        with temporary_settings(
            {
                "comm_mode": "simulation",
                "silence_mode_active": None,
                "silence_mode_initial_state": None,
                "silence_mode_overrides": None,
            }
        ):
            r_init = self.client.post(
                "/api/command-batch",
                json={
                    "commands": [
                        {"reg_key": "power_level", "offset": 33120, "value": 6.0},
                        {"reg_key": "fan_front_speed", "offset": 33132, "value": 4.0},
                    ]
                },
            )
            self.assertEqual(r_init.status_code, 200)

            try:
                r_act1 = self.client.post("/api/silence/activate", json={"power_level": 2, "fan_front_speed": 1})
                self.assertEqual(r_act1.status_code, 200)
                first_initial = r_act1.json()["silence_mode"]["initial_state"]
                self.assertEqual(first_initial["power_level"], 6.0)
                self.assertEqual(first_initial["fan_front_speed"], 4.0)

                # Deuxième activation à chaud : conserve initial_state d'origine
                r_act2 = self.client.post("/api/silence/activate", json={"power_level": 1, "fan_front_speed": 0})
                self.assertEqual(r_act2.status_code, 200)
                second_initial = r_act2.json()["silence_mode"]["initial_state"]
                self.assertEqual(second_initial["power_level"], 6.0)
                self.assertEqual(second_initial["fan_front_speed"], 4.0)

                r_deact = self.client.post("/api/silence/deactivate")
                self.assertEqual(r_deact.status_code, 200)

                latest_resp = self.client.get("/api/latest")
                self.assertEqual(latest_resp.status_code, 200)
                latest_data = latest_resp.json()
                regs_map = latest_data["registers"]
                self.assertEqual(float(regs_map["power_level"]["current_val"]), 6.0)
                self.assertNotIn("set_silece_set", regs_map)
                self.assertEqual(int(latest_data["latest"]["set_silece_set"]), 0)
            finally:
                self.client.post("/api/silence/deactivate")
                sim_conn = get_db("simulation")
                try:
                    for k, val in orig_regs.items():
                        sim_conn.execute("UPDATE registers_catalog SET current_val = ? WHERE reg_key = ?", (val, k))
                    sim_conn.commit()
                finally:
                    sim_conn.close()

    def test_bb12_analytics_dynamic_poll_gap_and_probe_k_delta(self):
        cols_sql = ", ".join(f"{k} {v}" for k, v in TELEMETRY_COLUMNS.items())
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute(f"CREATE TABLE telemetry ({cols_sql})")

        with temporary_settings(
            {
                "poll_interval_s": "180",
                "pellet_batch_state": json.dumps({"raz_epoch": 0, "baseline_rpm_pa": 600.0, "pellet_brand": "Test Lot"}),
            }
        ):
            base_epoch = 1793900000
            last_rec = {}
            for cycle in range(4):
                for idx in range(26):
                    ep = base_epoch + cycle * 10000 + idx * 180
                    ts_str = datetime.fromtimestamp(ep).isoformat()
                    conn.execute(
                        """
                        INSERT INTO telemetry (
                            epoch, timestamp, comm_mode, status_code, alarm_code, popup_flags,
                            power_level, power_actual, temp_probe_k, temp_fumes,
                            depression_pa, exhaust_rpm, vent_front_actual,
                            duct_right_actual, duct_left_actual,
                            trim_pellet_pct, trim_exhaust_pct, pellet_rate_kgh
                        ) VALUES (?, ?, 'simulation', 5, 0, 0, 4, 4, 620.0, 150.0, 3.2, 1750, 3, 0, 0, 0, 0, 1.5)
                        """,
                        (ep, ts_str),
                    )
                    last_rec = {
                        "epoch": ep,
                        "comm_mode": "simulation",
                        "status_code": 5,
                        "alarm_code": 0,
                        "popup_flags": 0,
                        "power_level": 4,
                        "power_actual": 4,
                        "temp_probe_k": 620.0,
                        "temp_fumes": 150.0,
                        "depression_pa": 3.2,
                        "exhaust_rpm": 1750,
                        "vent_front_actual": 3,
                        "duct_right_actual": 0,
                        "duct_left_actual": 0,
                        "trim_pellet_pct": 0,
                        "trim_exhaust_pct": 0,
                        "pellet_rate_kgh": 1.5,
                    }
            conn.commit()

            pellet_q, exhaust_q = evaluate_batch_combustion_and_trim(conn, last_rec)
            conn.close()

            self.assertEqual(pellet_q["status"], "active")
            self.assertEqual(exhaust_q["status"], "active")
            self.assertEqual(pellet_q["target_flame_temp"], 590.0)
            self.assertEqual(pellet_q["flame_delta"], 30.0)
            self.assertEqual(pellet_q["flame_delta_avg"], 30.0)

    def test_bb13_hopper_refill_fractional_bags_and_paris_clock(self):
        with temporary_settings({"comm_mode": "simulation"}):
            sys_conn = get_sys_db()
            orig_stock_row = sys_conn.execute("SELECT value FROM settings WHERE key = 'pellet_bags_stock'").fetchone()
            orig_stock_val = orig_stock_row["value"] if orig_stock_row else None
            sys_conn.close()

            sconn = get_db("simulation")
            row = sconn.execute("SELECT id, epoch, pellet_hopper_pct FROM telemetry ORDER BY epoch DESC LIMIT 1").fetchone()
            self.assertIsNotNone(row)
            orig_id, orig_epoch, orig_pct = row["id"], row["epoch"], row["pellet_hopper_pct"]
            try:
                sconn.execute("UPDATE telemetry SET pellet_hopper_pct = 20.0 WHERE id = ?", (orig_id,))
                sconn.commit()
                sconn.close()

                r_refill = self.client.post("/api/refill-hopper", json={"bags_added": 0.5})
                self.assertEqual(r_refill.status_code, 200)
                self.assertAlmostEqual(r_refill.json()["pellet_hopper_pct"], 41.4, places=1)

                sconn2 = get_db("simulation")
                try:
                    updated = sconn2.execute(
                        "SELECT epoch, pellet_hopper_pct FROM telemetry WHERE id = ?",
                        (orig_id,),
                    ).fetchone()
                    self.assertEqual(updated["epoch"], orig_epoch)
                    self.assertAlmostEqual(updated["pellet_hopper_pct"], 41.4, places=1)
                finally:
                    sconn2.close()
            finally:
                sconn_restore = get_db("simulation")
                try:
                    sconn_restore.execute(
                        "UPDATE telemetry SET pellet_hopper_pct = ?, epoch = ? WHERE id = ?",
                        (orig_pct, orig_epoch, orig_id),
                    )
                    sconn_restore.commit()
                finally:
                    sconn_restore.close()
                sys_conn2 = get_sys_db()
                try:
                    if orig_stock_val is None:
                        sys_conn2.execute("DELETE FROM settings WHERE key = 'pellet_bags_stock'")
                    else:
                        sys_conn2.execute(
                            "INSERT OR REPLACE INTO settings (key, value) VALUES ('pellet_bags_stock', ?)",
                            (orig_stock_val,),
                        )
                    sys_conn2.commit()
                finally:
                    sys_conn2.close()

            fixed_paris = datetime(2026, 7, 15, 14, 25, 30, tzinfo=ZoneInfo("Europe/Paris"))
            with patch("routers.stove.execute_registers_batch_write", new_callable=AsyncMock) as mock_batch:
                mock_batch.return_value = {"status": "ok"}
                with patch("routers.stove.datetime") as mock_dt:
                    mock_dt.now.return_value = fixed_paris
                    r_clk = self.client.post("/api/sync-clock")
                self.assertEqual(r_clk.status_code, 200)
                mock_dt.now.assert_called_with(ZoneInfo("Europe/Paris"))
                cmds = mock_batch.await_args.args[0]
                by_off = {c["offset"]: c["value"] for c in cmds}
                self.assertEqual(by_off[34048], 14)
                self.assertEqual(by_off[34049], 25)
                self.assertEqual(by_off[34050], 15)
                self.assertEqual(by_off[34051], 7)
                self.assertEqual(by_off[34052], 26)

    def test_bb14_duct_offsets_31_32_and_ambient_fallback(self):
        sim_conn = get_db("simulation")
        sim_max = sim_conn.execute("SELECT COALESCE(MAX(id), 0) FROM telemetry").fetchone()[0]
        sim_orig = {}
        try:
            for k in ("status_code", "duct_right_speed", "duct_left_speed"):
                r = sim_conn.execute("SELECT current_val FROM registers_catalog WHERE reg_key = ?", (k,)).fetchone()
                sim_orig[k] = r["current_val"] if r else 0.0
            sim_conn.execute("UPDATE registers_catalog SET current_val = 85.0 WHERE reg_key = 'status_code'")
            sim_conn.execute("UPDATE registers_catalog SET current_val = 3.0 WHERE reg_key = 'duct_right_speed'")
            sim_conn.execute("UPDATE registers_catalog SET current_val = 1.0 WHERE reg_key = 'duct_left_speed'")
            sim_conn.commit()
        finally:
            sim_conn.close()

        try:
            sim_rec = asyncio.run(telemetry.collect_telemetry_cycle(force_mode="simulation"))
            raw_sim = json.loads(sim_rec["raw_buffer_json"])
            self.assertEqual(raw_sim["31"], sim_rec["duct_right_actual"])
            self.assertEqual(raw_sim["32"], sim_rec["duct_left_actual"])
            # Encodage natif Micronova #31/#32 : 0=OFF, 1=RIS, 2..8=Vit 1..7 (décalage +1 vs consigne)
            self.assertEqual(sim_rec["duct_right_actual"], 4)
            self.assertEqual(sim_rec["duct_left_actual"], 2)
            # Vérification de l'helper d'encodage natif sur tous les cas (OFF, RIS P0, manuel, PS Auto, Boost)
            self.assertEqual(telemetry._sim_real_fan_register(3, state=0, p_actual=0, is_front=True), 0)
            self.assertEqual(telemetry._sim_real_fan_register(0, state=5, p_actual=4, is_front=True), 0)
            self.assertEqual(telemetry._sim_real_fan_register(8, state=5, p_actual=0, is_front=True), 1)
            self.assertEqual(telemetry._sim_real_fan_register(8, state=5, p_actual=0, is_front=False), 0)
            self.assertEqual(telemetry._sim_real_fan_register(8, state=5, p_actual=4, is_front=True), 5)
            self.assertEqual(telemetry._sim_real_fan_register(8, state=5, p_actual=8, is_front=True), 8)
            self.assertEqual(telemetry._sim_real_fan_register(3, state=5, p_actual=3, is_front=True), 4)
        finally:
            sim_conn = get_db("simulation")
            try:
                sim_conn.execute("DELETE FROM telemetry WHERE id > ?", (sim_max,))
                for k, val in sim_orig.items():
                    sim_conn.execute("UPDATE registers_catalog SET current_val = ? WHERE reg_key = ?", (val, k))
                sim_conn.commit()
            finally:
                sim_conn.close()

        gw_conn = get_db("local_gateway")
        gw_max = gw_conn.execute("SELECT COALESCE(MAX(id), 0) FROM telemetry").fetchone()[0]
        gw_conn.close()

        with temporary_settings({"comm_mode": "local_gateway", "local_gateway_url": "http://192.168.1.50"}):
            mock_buf = {8: 5.0, 1: 21.6, 20: 175.0, 21: 215.0, 31: 4.0, 32: 2.0}
            try:
                with patch(
                    "telemetry.local_gateway_client.read_buffer",
                    new_callable=AsyncMock,
                    return_value=mock_buf,
                ):
                    gw_rec = asyncio.run(telemetry.collect_telemetry_cycle(force_mode="local_gateway"))
                self.assertEqual(gw_rec["temp_ambient"], 21.6)
                self.assertEqual(gw_rec["duct_right_actual"], 4)
                self.assertEqual(gw_rec["duct_left_actual"], 2)
            finally:
                gw_conn = get_db("local_gateway")
                try:
                    gw_conn.execute("DELETE FROM telemetry WHERE id > ?", (gw_max,))
                    gw_conn.commit()
                finally:
                    gw_conn.close()

    def test_bb15_hopper_requires_confirmation_after_al02_or_lid_open(self):
        from telemetry.decoder import _compute_hopper_level, compute_hopper_runway

        # 1. Ouverture trappe granulés -> passe à -1.0 ("?")
        lvl_lid = _compute_hopper_level(
            0,
            {"pellet_hopper_pct": 64.0, "popup_pellet_open": 0, "alarm_code": 0},
            0.2,
            "simulation",
            hopper_capacity_kg=35.0,
            popup_pellet_open=1,
            alarm_code=0,
        )
        self.assertEqual(lvl_lid, -1.0)

        # Reste à -1.0 tant que l'utilisateur n'a pas confirmé
        lvl_stay = _compute_hopper_level(
            0,
            {"pellet_hopper_pct": -1.0, "popup_pellet_open": 1, "alarm_code": 0},
            0.2,
            "simulation",
            hopper_capacity_kg=35.0,
            popup_pellet_open=0,
            alarm_code=0,
        )
        self.assertEqual(lvl_stay, -1.0)

        # 2. Alarme AL02 (manque allumage) -> passe à -1.0 ("?") et y reste après acquittement
        lvl_al02 = _compute_hopper_level(
            0,
            {"pellet_hopper_pct": 42.0, "popup_pellet_open": 0, "alarm_code": 0},
            0.0,
            "simulation",
            hopper_capacity_kg=35.0,
            popup_pellet_open=0,
            alarm_code=2,
        )
        self.assertEqual(lvl_al02, -1.0)

        lvl_after_al02 = _compute_hopper_level(
            0,
            {"pellet_hopper_pct": -1.0, "popup_pellet_open": 0, "alarm_code": 2},
            0.0,
            "simulation",
            hopper_capacity_kg=35.0,
            popup_pellet_open=0,
            alarm_code=0,
        )
        self.assertEqual(lvl_after_al02, -1.0)

        # 3. Réinitialisation sonde réserve vide -> -1.0 (plus de passage auto à 100%)
        lvl_empty_clear = _compute_hopper_level(
            0,
            {"pellet_hopper_pct": 12.0, "popup_pellet_empty": 1, "alarm_code": 0},
            0.0,
            "simulation",
            hopper_capacity_kg=35.0,
        )
        self.assertEqual(lvl_empty_clear, -1.0)

        # compute_hopper_runway borne -1.0 à 0.0 pour ne pas soustraire du stock de sacs
        self.assertEqual(
            compute_hopper_runway(-1.0, {}, {"pellet_bags_stock": "10", "hopper_capacity_kg": "35"}),
            compute_hopper_runway(0.0, {}, {"pellet_bags_stock": "10", "hopper_capacity_kg": "35"}),
        )

        # 4. Confirmation via /api/refill-hopper depuis -1.0 (1 sac = 42.9%, 2 sacs = 85.7%, plein = 100%)
        with temporary_settings({"comm_mode": "simulation", "hopper_capacity_kg": "35"}):
            sconn = get_db("simulation")
            row = sconn.execute(
                "SELECT id, epoch, pellet_hopper_pct, popup_pellet_open, popup_pellet_empty FROM telemetry ORDER BY epoch DESC LIMIT 1"
            ).fetchone()
            self.assertIsNotNone(row)
            orig = dict(row)
            try:
                sconn.execute(
                    "UPDATE telemetry SET pellet_hopper_pct = -1.0, popup_pellet_open = 1, popup_pellet_empty = 0 WHERE id = ?",
                    (orig["id"],),
                )
                sconn.commit()
                sconn.close()

                r1 = self.client.post("/api/refill-hopper", json={"bags_added": 1})
                self.assertEqual(r1.status_code, 200)
                self.assertAlmostEqual(r1.json()["pellet_hopper_pct"], 42.9, places=1)
                self.assertEqual(r1.json()["latest"]["popup_pellet_open"], 0)

                sconn_reset = get_db("simulation")
                last_r = sconn_reset.execute("SELECT id FROM telemetry ORDER BY epoch DESC LIMIT 1").fetchone()
                sconn_reset.execute("UPDATE telemetry SET pellet_hopper_pct = -1.0 WHERE id = ?", (last_r["id"],))
                sconn_reset.commit()
                sconn_reset.close()

                r2 = self.client.post("/api/refill-hopper", json={"bags_added": 2})
                self.assertEqual(r2.status_code, 200)
                self.assertAlmostEqual(r2.json()["pellet_hopper_pct"], 85.7, places=1)
            finally:
                sconn_restore = get_db("simulation")
                try:
                    sconn_restore.execute("DELETE FROM telemetry WHERE id > ?", (orig["id"],))
                    sconn_restore.execute(
                        "UPDATE telemetry SET pellet_hopper_pct = ?, popup_pellet_open = ?, popup_pellet_empty = ? WHERE id = ?",
                        (orig["pellet_hopper_pct"], orig["popup_pellet_open"], orig["popup_pellet_empty"], orig["id"]),
                    )
                    sconn_restore.commit()
                finally:
                    sconn_restore.close()
