import { describe, expect, it } from "vitest";
import {
  decodeBufferToTelemetry,
  detectCapabilities,
  evaluateBuffer,
  parseRegistersMap,
  prepareWriteValue,
} from "../src/micronova/register_engine.js";

describe("Micronova register engine (parité backend)", () => {
  const sampleAir2Ducts = {
    registers_map: [
      { reg_key: "temp_air_get", offset: 103, formula: "#", reg_type: "GET" },
      { reg_key: "temp_air_set", offset: 33122, formula: "#", set_min: 7, set_max: 41, reg_type: "SET" },
      { reg_key: "power_set", offset: 33120, formula: "#", set_min: 1, set_max: 7, reg_type: "SET" },
      { reg_key: "vent_front_set", offset: 33132, formula: "#", set_min: 0, set_max: 8, reg_type: "SET" },
      { reg_key: "can_sx_vent_set", offset: 33136, formula: "#", set_min: 0, set_max: 8, reg_type: "SET" },
      { reg_key: "can_dx_vent_set", offset: 33134, formula: "#", set_min: 0, set_max: 8, reg_type: "SET" },
      { reg_key: "can_sx_temp_get", offset: 29, formula: "#/2", reg_type: "GET" },
      { reg_key: "can_dx_temp_get", offset: 28, formula: "#/2", reg_type: "GET" },
      { reg_key: "fun_auto_set", offset: 33128, formula: "#", reg_type: "SET" },
      { reg_key: "fun_pwf_set", offset: 33154, formula: "#", reg_type: "SET" },
      { reg_key: "standby_set", offset: 33130, formula: "#", reg_type: "SET" },
      { reg_key: "temp_gas_flue_get", offset: 2, formula: "#", reg_type: "GET" },
    ],
  };

  it("parseRegistersMap et detectCapabilities détectent un poêle Air 2 zones", () => {
    const rmap = parseRegistersMap(sampleAir2Ducts);
    expect(Object.keys(rmap).length).toBe(12);
    const caps = detectCapabilities(rmap, {}, { agua_brand: "nobis" });
    expect(caps.stove_type).toBe("air");
    expect(caps.temp_min).toBe(7);
    expect(caps.temp_max).toBe(41);
    expect(caps.power_max).toBe(7);
    expect(caps.ducts.map((d) => d.id)).toEqual(["SX", "DX"]);
    expect(caps.has_boost).toBe(true);
  });

  it("detectCapabilities détecte un poêle Hydro sans canalisations ni ventilateur frontal", () => {
    const hydroMap = parseRegistersMap({
      registers_map: [
        { reg_key: "temp_water_get", offset: 1, formula: "#", reg_type: "GET" },
        { reg_key: "temp_water_set", offset: 33122, formula: "#", set_min: 40, set_max: 80, reg_type: "SET" },
        { reg_key: "power_set", offset: 33120, formula: "#", set_min: 1, set_max: 5, reg_type: "SET" },
      ],
    });
    const caps = detectCapabilities(hydroMap, {});
    expect(caps.stove_type).toBe("hydro");
    expect(caps.temp_min).toBe(40);
    expect(caps.temp_max).toBe(80);
    expect(caps.power_max).toBe(5);
    expect(caps.has_fan_front).toBe(false);
    expect(caps.ducts).toEqual([]);
  });

  it("evaluateBuffer ignore les valeurs erreur 0x8000 (32768) et décode les formules", () => {
    const rmap = parseRegistersMap(sampleAir2Ducts);
    const ev = evaluateBuffer({ 103: 21, 29: 45, 28: 32768 }, rmap);
    expect(ev.temp_air_get.value).toBe(21);
    expect(ev.can_sx_temp_get.value).toBe(22.5);
    expect(ev.can_dx_temp_get.value).toBeNull();
  });

  it("prepareWriteValue valide les bornes min/max et applique formula_inverse", () => {
    const reg = { offset: 33122, set_min: 7, set_max: 41, formula_inverse: "#*2" };
    expect(prepareWriteValue(reg, 20)).toBe(40);
    expect(() => prepareWriteValue(reg, 5)).toThrow();
    expect(() => prepareWriteValue(reg, 45)).toThrow();
  });

  it("decodeBufferToTelemetry produit le payload complet compatible UI", () => {
    const rmap = parseRegistersMap(sampleAir2Ducts);
    const { latest, capabilities } = decodeBufferToTelemetry(
      { 8: 5, 103: 21, 33122: 20, 33120: 4, 11: 4, 2: 145, 29: 44 },
      rmap,
      { agua_brand: "nobis" },
      { weather_temp_ext: 9.5 },
      "Mon Poêle Test",
    );
    expect(latest.stove_name).toBe("Mon Poêle Test");
    expect(latest.status_code).toBe(5);
    expect(latest.temp_ambient).toBe(21);
    expect(latest.weather_temp_ext).toBe(9.5);
    expect(capabilities.ducts.length).toBe(2);
  });
});
