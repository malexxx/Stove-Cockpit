# -*- coding: utf-8 -*-
"""Tests unitaires ciblés pour les modules bas-niveau (database/seeder, telemetry/hub, clients/local_gateway)."""
import asyncio
from contextlib import asynccontextmanager
import json
import os
import sqlite3
import tempfile
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import httpx

from clients.local_gateway import LocalGatewayClient
from database.migrations import _ensure_mode_tables
from database.seeder import seed_simulation_db_if_empty
import telemetry.hub as hub_mod


class TestDatabaseSeeder(unittest.TestCase):
    def test_seed_simulation_db_populates_when_empty_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "sim_test.db")

            def _open_conn(_mode="simulation"):
                c = sqlite3.connect(db_path)
                c.row_factory = sqlite3.Row
                return c

            init_conn = _open_conn()
            _ensure_mode_tables(init_conn)
            init_conn.close()

            with (
                patch("database.seeder.get_db", side_effect=_open_conn),
                patch("database.seeder.db_log") as mock_log,
            ):
                seed_simulation_db_if_empty()
                mock_log.assert_called_once()

                check_conn = _open_conn()
                try:
                    cnt = check_conn.execute("SELECT COUNT(*) AS c FROM telemetry").fetchone()["c"]
                    sample = check_conn.execute(
                        "SELECT comm_mode, raw_buffer_json, status_code FROM telemetry ORDER BY epoch DESC LIMIT 1"
                    ).fetchone()
                finally:
                    check_conn.close()

                # ~29j * 96 pts/j + 24h * 30 pts/h ≈ 3500 points
                self.assertGreater(cnt, 3000)
                self.assertEqual(sample["comm_mode"], "simulation")
                parsed_buf = json.loads(sample["raw_buffer_json"])
                self.assertIn("8", parsed_buf)

                # Deuxième appel : no-op car table déjà peuplée
                mock_log.reset_mock()
                seed_simulation_db_if_empty()
                mock_log.assert_not_called()

                check_conn2 = _open_conn()
                try:
                    cnt2 = check_conn2.execute("SELECT COUNT(*) AS c FROM telemetry").fetchone()["c"]
                finally:
                    check_conn2.close()
                self.assertEqual(cnt, cnt2)


class TestTelemetryHub(unittest.TestCase):
    def setUp(self):
        self._saved_status = dict(hub_mod._comm_status)
        self._saved_subs = set(hub_mod.sse_subscribers)

    def tearDown(self):
        hub_mod._comm_status.clear()
        hub_mod._comm_status.update(self._saved_status)
        hub_mod.sse_subscribers.clear()
        hub_mod.sse_subscribers.update(self._saved_subs)

    def test_get_comm_status_bootstrap_from_db_branches(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "hub_test.db")

            def _open_conn(_mode):
                c = sqlite3.connect(db_path)
                c.row_factory = sqlite3.Row
                return c

            c = _open_conn("agua_cloud")
            _ensure_mode_tables(c)
            c.close()

            # 1. Base vide en agua_cloud -> connected=False
            hub_mod._comm_status["last_sync_time"] = None
            with (
                patch("telemetry.hub.get_active_mode", return_value="agua_cloud"),
                patch("telemetry.hub.get_db", side_effect=_open_conn),
            ):
                st = hub_mod.get_comm_status()
            self.assertFalse(st["connected"])
            self.assertEqual(st["comm_mode"], "agua_cloud")

            # 2. Ligne hors-ligne (status_code=-1) -> connected=False + last_error
            c = _open_conn("agua_cloud")
            c.execute(
                "INSERT INTO telemetry (epoch, timestamp, comm_mode, status_code) VALUES (1000, '2026-11-21 10:00:00', 'agua_cloud', -1)"
            )
            c.commit()
            c.close()
            hub_mod._comm_status["last_sync_time"] = None
            with (
                patch("telemetry.hub.get_active_mode", return_value="agua_cloud"),
                patch("telemetry.hub.get_db", side_effect=_open_conn),
            ):
                st_off = hub_mod.get_comm_status()
            self.assertFalse(st_off["connected"])
            self.assertIn("hors ligne", st_off["last_error"])

            # 3. Ligne en ligne (status_code=5) -> connected=True
            c = _open_conn("agua_cloud")
            c.execute(
                "INSERT INTO telemetry (epoch, timestamp, comm_mode, status_code) VALUES (2000, '2026-11-21 10:05:00', 'agua_cloud', 5)"
            )
            c.commit()
            c.close()
            hub_mod._comm_status["last_sync_time"] = None
            with (
                patch("telemetry.hub.get_active_mode", return_value="agua_cloud"),
                patch("telemetry.hub.get_db", side_effect=_open_conn),
            ):
                st_on = hub_mod.get_comm_status()
            self.assertTrue(st_on["connected"])
            self.assertEqual(st_on["last_sync_epoch"], 2000)

            # 4. Erreur SQLite -> fallback sûr
            hub_mod._comm_status["last_sync_time"] = None
            with (
                patch("telemetry.hub.get_active_mode", return_value="simulation"),
                patch("telemetry.hub.get_db", side_effect=RuntimeError("db locked")),
            ):
                st_err = hub_mod.get_comm_status()
            self.assertEqual(st_err["comm_mode"], "simulation")

    def test_broadcast_sse_event_handles_normal_full_and_broken_queues(self):
        async def _run():
            hub_mod.sse_subscribers.clear()
            # Aucun abonné -> no-op
            await hub_mod.broadcast_sse_event("ping", {"v": 1})

            q_normal: asyncio.Queue = asyncio.Queue(maxsize=4)
            q_full: asyncio.Queue = asyncio.Queue(maxsize=1)
            q_full.put_nowait("stale-event")

            class _BrokenQueue:
                def full(self):
                    return False

                def put_nowait(self, _item):
                    raise RuntimeError("closed queue")

            q_dead = _BrokenQueue()
            hub_mod.sse_subscribers.update({q_normal, q_full, q_dead})

            await hub_mod.broadcast_sse_event("telemetry", {"temp_ambient": 21.5})

            msg_normal = json.loads(q_normal.get_nowait())
            msg_full = json.loads(q_full.get_nowait())
            self.assertEqual(msg_normal, {"event": "telemetry", "temp_ambient": 21.5})
            self.assertEqual(msg_full, {"event": "telemetry", "temp_ambient": 21.5})
            self.assertNotIn(q_dead, hub_mod.sse_subscribers)

        asyncio.run(_run())


class TestLocalGatewayClient(unittest.TestCase):
    def test_local_gateway_test_connection_read_buffer_and_write_registers(self):
        gw = LocalGatewayClient(default_timeout=4.0)
        posted = []

        class _FakeResp:
            def __init__(self, payload, status_code=200):
                self._payload = payload
                self.status_code = status_code

            def raise_for_status(self):
                if self.status_code >= 400:
                    raise httpx.HTTPStatusError("err", request=MagicMock(), response=MagicMock(status_code=self.status_code))

            def json(self):
                return self._payload

        class _FakeClient:
            async def get(self, url, timeout=5.0):
                self.last_get_url = url
                return _FakeResp({"8": 5, "103": "20.5", "firmware": "1.2.3", "33122": 19})

            async def post(self, url, json=None, timeout=8.0):
                posted.append((url, json))
                return _FakeResp({"ok": True})

        fake_client = _FakeClient()

        @asynccontextmanager
        async def _fake_borrow(timeout=5.0):
            yield fake_client

        async def _run():
            with patch("clients.borrow_http_client", _fake_borrow):
                status = await gw.test_connection("http://192.168.1.150/")
                self.assertEqual(status["firmware"], "1.2.3")
                self.assertEqual(fake_client.last_get_url, "http://192.168.1.150/status")

                buf = await gw.read_buffer("http://192.168.1.150/")
                self.assertEqual(buf, {8: 5.0, 103: 20.5, 33122: 19.0})

                await gw.write_registers(
                    "http://192.168.1.150/",
                    [
                        {"offset": 33122, "reg_key": "temp_amb_setpoint", "new_val": 21.0},
                        {"offset": 33120, "reg_key": "power_level", "new_val": 4},
                    ],
                )
                self.assertEqual(len(posted), 2)
                self.assertEqual(posted[0], ("http://192.168.1.150/write", {"offset": 33122, "reg_key": "temp_amb_setpoint", "value": 21.0}))
                self.assertEqual(posted[1], ("http://192.168.1.150/write", {"offset": 33120, "reg_key": "power_level", "value": 4}))

        asyncio.run(_run())

    def test_local_gateway_propagates_http_errors(self):
        gw = LocalGatewayClient()
        bad_resp = MagicMock()
        bad_resp.raise_for_status.side_effect = httpx.HTTPStatusError("500", request=MagicMock(), response=MagicMock(status_code=500))

        fake_client = MagicMock()
        fake_client.get = AsyncMock(return_value=bad_resp)

        @asynccontextmanager
        async def _fake_borrow(timeout=5.0):
            yield fake_client

        async def _run():
            with patch("clients.borrow_http_client", _fake_borrow):
                with self.assertRaises(httpx.HTTPStatusError):
                    await gw.test_connection("http://192.168.1.150")

        asyncio.run(_run())


if __name__ == "__main__":
    unittest.main()
