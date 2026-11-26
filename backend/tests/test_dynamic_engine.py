# -*- coding: utf-8 -*-
"""Tests du moteur générique Micronova Agua IOT (formules, multi-marques, Air/Hydro, canalisations)."""
import unittest

from clients.agua_cloud import AguaCloudClient
from config import BRANDS_BY_ID, BRANDS_CATALOG
from telemetry.dynamic_engine import (
    detect_capabilities,
    evaluate_buffer,
    infer_normalized_status_code,
    parse_registers_map,
    prepare_write_value,
)
from telemetry.formula_eval import evaluate_micronova_formula


class TestDynamicMicronovaEngine(unittest.TestCase):
    def test_eco_stop_status_is_not_misclassified_as_off(self):
        self.assertEqual(infer_normalized_status_code("ECO STOP", 8), 8)
        self.assertEqual(infer_normalized_status_code("FINAL CLEANING", 6), 0)

    def test_comfortclima_registers_enable_remote_eco_writes(self):
        register_map = parse_registers_map({
            "registers_map": [
                {"reg_key": "comfortclima_ability_set", "offset": 33148, "reg_type": "SET", "is_word": False, "set_min": 0, "set_max": 1},
                {"reg_key": "comfortclima_time_set", "offset": 33150, "reg_type": "SET", "is_word": False, "set_min": 0, "set_max": 9},
                {"reg_key": "comfortclima_time_enable", "offset": 33148, "reg_type": "ENABLE", "enable_val": [{"value": 1}]},
                {"reg_key": "comfortclima_restart_set", "offset": 33152, "reg_type": "SET", "is_word": False, "set_min": 2, "set_max": 5},
                {"reg_key": "comfortclima_restart_enable", "offset": 33148, "reg_type": "ENABLE", "enable_val": [{"value": 1}]},
            ]
        })
        caps = detect_capabilities(register_map)
        self.assertTrue(caps["can_write_eco"])
        self.assertEqual(register_map["comfortclima_ability_set"]["offset"], 33148)
        self.assertEqual(register_map["comfortclima_time_set"]["set_max"], 9)
        self.assertEqual(register_map["comfortclima_restart_set"]["set_min"], 2)

        client = AguaCloudClient()
        client._parse_and_cache_registers_map({"registers_map": list(register_map.values())})
        payload = client._build_rwms_payload(
            "device",
            "product",
            [
                (33148, 1, "standby_set"),
                (33150, 5, "comfortclima_time_set"),
                (33152, 2, "comfortclima_restart_set"),
            ],
        )
        self.assertEqual(payload["Items"], [33148, 33150, 33152])
        self.assertEqual(payload["BitData"], [8, 8, 8])
        self.assertEqual(payload["Masks"], [255, 255, 255])
        self.assertEqual(payload["Values"], [1, 5, 2])

    def test_brands_catalog_contains_35_plus_brands_and_piazzetta_bridge(self):
        self.assertGreaterEqual(len(BRANDS_CATALOG), 36)
        self.assertIn("nobis", BRANDS_BY_ID)
        self.assertIn("easy_connect", BRANDS_BY_ID)
        self.assertIn("evacalor", BRANDS_BY_ID)
        self.assertIn("mypiazzetta", BRANDS_BY_ID)
        self.assertIn("mysuperior", BRANDS_BY_ID)
        self.assertIn("custom", BRANDS_BY_ID)

        client = AguaCloudClient()
        cfg_sup = client.resolve_brand_config({"agua_brand": "mysuperior"})
        self.assertEqual(cfg_sup["brand_id"], "2")
        self.assertEqual(cfg_sup["brand_header"], "superior")
        self.assertIn("piazzetta-iot.app2cloud.it", cfg_sup["login_api_url"])
        hdrs = client._headers_for_login("uuid-123", cfg_sup)
        self.assertEqual(hdrs["brand"], "superior")
        self.assertEqual(hdrs["url"], "userLogin")

    def test_safe_formula_evaluator(self):
        self.assertEqual(evaluate_micronova_formula("#/2", 42), 21)
        self.assertEqual(evaluate_micronova_formula("#*2", 21.5), 43)
        self.assertEqual(evaluate_micronova_formula("IF(#>100,#-256,#)", 253), -3)
        self.assertEqual(evaluate_micronova_formula("IF(#>100,#-256,#)", 4), 4)
        self.assertEqual(evaluate_micronova_formula("# Mod 10", 27), 7)
        self.assertEqual(evaluate_micronova_formula("int(#/10)", 199), 19)
        with self.assertRaises(ValueError):
            evaluate_micronova_formula("__import__('os').system('id')", 1)

    def test_eval_buffer_0x8000_drop_and_is_hex_write(self):
        raw_map = {
            "device_registers_map": {
                "registers_map": [
                    {
                        "registers": [
                            {"reg_key": "status_get", "offset": 8, "mask": 255, "formula": "#", "enc_val": [{"lang": "FRA", "value": 5, "description": "Travail"}]},
                            {"reg_key": "temp_air_get", "offset": 1, "mask": 65535, "formula": "#/2"},
                            {"reg_key": "temp_gas_flue_get", "offset": 2, "mask": 65535, "formula": "#"},
                            {"reg_key": "power_set", "offset": 33120, "mask": 255, "formula": "#", "formula_inverse": "#", "set_min": 1, "set_max": 5},
                            {"reg_key": "chrono_bcd_set", "offset": 33164, "mask": 255, "formula": "#", "formula_inverse": "#", "is_hex": True, "set_min": 0, "set_max": 99},
                        ]
                    }
                ]
            }
        }
        reg_map = parse_registers_map(raw_map)
        ev = evaluate_buffer({8: 5, 1: 43, 2: 0x8000}, reg_map, lang="FRA")
        self.assertEqual(ev["status_get"]["description"], "Travail")
        self.assertEqual(ev["temp_air_get"]["value"], 21.5)
        self.assertIsNone(ev["temp_gas_flue_get"]["value"])

        self.assertEqual(prepare_write_value(reg_map["chrono_bcd_set"], 25), 0x25)
        with self.assertRaises(ValueError):
            prepare_write_value(reg_map["power_set"], 7)

    def test_detect_capabilities_air_0_ducts_vs_hydro_vs_nobis(self):
        # 1. Poêle Air simple (0 canalisation, P1..P5)
        air_simple = parse_registers_map({
            "registers_map": [
                {"reg_key": "temp_air_get", "offset": 1},
                {"reg_key": "temp_air_set", "offset": 33122, "set_min": 10, "set_max": 35},
                {"reg_key": "power_set", "offset": 33120, "set_min": 1, "set_max": 5},
                {"reg_key": "vent_front_set", "offset": 33132, "set_min": 0, "set_max": 5},
            ]
        })
        caps_simple = detect_capabilities(air_simple)
        self.assertEqual(caps_simple["stove_type"], "air")
        self.assertEqual(caps_simple["power_max"], 5)
        self.assertEqual(caps_simple["temp_min"], 10.0)
        self.assertEqual(caps_simple["temp_max"], 35.0)
        self.assertEqual(len(caps_simple["ducts"]), 0)

        # 2. Poêle Hydro (temp_water_set uniquement, sans ventilateur frontal)
        hydro = parse_registers_map({
            "registers_map": [
                {"reg_key": "temp_water_get", "offset": 3},
                {"reg_key": "temp_water_set", "offset": 33122, "set_min": 40, "set_max": 80},
                {"reg_key": "power_set", "offset": 33120, "set_min": 1, "set_max": 5},
                {"reg_key": "pres_h2o_get", "offset": 4},
            ]
        })
        caps_hydro = detect_capabilities(hydro)
        self.assertEqual(caps_hydro["stove_type"], "hydro")
        self.assertFalse(caps_hydro["has_fan_front"])
        self.assertTrue(caps_hydro["has_water_pressure"])
        self.assertEqual(caps_hydro["temp_min"], 40.0)
        self.assertEqual(caps_hydro["temp_max"], 80.0)

        # 3. Nobis A10 (2 canalisations SX/DX, P1..P7, retours canalization_2sx_*/2dx_*)
        nobis = parse_registers_map({
            "registers_map": [
                {"reg_key": "temp_air2_get", "offset": 103},
                {"reg_key": "temp_air_set", "offset": 33122, "set_min": 7, "set_max": 41},
                {"reg_key": "power_set", "offset": 33120, "set_min": 1, "set_max": 7},
                {"reg_key": "vent_front_set", "offset": 33132, "set_min": 0, "set_max": 8},
                {"reg_key": "canalization_sx_set", "offset": 33136, "set_min": 0, "set_max": 8},
                {"reg_key": "canalization_dx_set", "offset": 33134, "set_min": 0, "set_max": 8},
                {"reg_key": "canalization_2sx_get", "offset": 32},
                {"reg_key": "canalization_2sx_temp_air_get", "offset": 29},
                {"reg_key": "canalization_2dx_get", "offset": 31},
                {"reg_key": "canalization_2dx_temp_air_get", "offset": 28},
            ]
        })
        caps_nobis = detect_capabilities(nobis, settings={"agua_brand": "nobis"})
        self.assertEqual(caps_nobis["stove_type"], "air")
        self.assertEqual(len(caps_nobis["ducts"]), 2)
        self.assertTrue(caps_nobis["is_nobis_a10_profile"])
        ducts_by_id = {d["id"]: d for d in caps_nobis["ducts"]}
        self.assertEqual(ducts_by_id["SX"]["speed_get_key"], "canalization_2sx_get")
        self.assertEqual(ducts_by_id["SX"]["temp_get_key"], "canalization_2sx_temp_air_get")
        self.assertEqual(ducts_by_id["DX"]["speed_get_key"], "canalization_2dx_get")
        self.assertEqual(ducts_by_id["DX"]["temp_get_key"], "canalization_2dx_temp_air_get")
