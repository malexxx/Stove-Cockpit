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
    expect(latest.fun_auto_set).toBe(0);
    expect(capabilities.ducts.length).toBe(2);
  });

  it("decodeBufferToTelemetry reflète l'état réel de fun_auto_set et priorise fun_auto_get", () => {
    const rmapAbsent = parseRegistersMap(sampleAir2Ducts);
    const resAbsent = decodeBufferToTelemetry({ 8: 5, 103: 20 }, rmapAbsent, { agua_brand: "nobis" });
    expect(resAbsent.latest.fun_auto_set).toBe(0);
    expect(resAbsent.registers.fun_auto_set.current_val).toBe(0);

    const resOff = decodeBufferToTelemetry({ 8: 5, 103: 20, 33128: 0 }, rmapAbsent, { agua_brand: "nobis" });
    expect(resOff.latest.fun_auto_set).toBe(0);
    expect(resOff.registers.fun_auto_set.current_val).toBe(0);

    const resOn = decodeBufferToTelemetry({ 8: 5, 103: 20, 33128: 1 }, rmapAbsent, { agua_brand: "nobis" });
    expect(resOn.latest.fun_auto_set).toBe(1);
    expect(resOn.registers.fun_auto_set.current_val).toBe(1);

    const rmapWithLiveGet = parseRegistersMap({
      registers_map: [
        ...sampleAir2Ducts.registers_map,
        { reg_key: "auto_mode_get", offset: 25, formula: "#", reg_type: "GET" },
      ],
    });
    const resLiveOverride = decodeBufferToTelemetry(
      { 8: 5, 103: 20, 33128: 1, 25: 0 },
      rmapWithLiveGet,
      { agua_brand: "nobis" },
    );
    expect(resLiveOverride.latest.fun_auto_set).toBe(0);
    expect(resLiveOverride.registers.fun_auto_set.current_val).toBe(0);
  });

  it("decodeBufferToTelemetry reflète l'état réel de fun_pwf_set (0/1/2) et priorise fun_pwf_get", () => {
    const rmap = parseRegistersMap(sampleAir2Ducts);
    const resAbsent = decodeBufferToTelemetry({ 8: 5, 103: 20 }, rmap, { agua_brand: "nobis" });
    expect(resAbsent.latest.fun_pwf_set).toBe(0);
    expect(resAbsent.registers.fun_pwf_set.current_val).toBe(0);

    const resOn = decodeBufferToTelemetry({ 8: 5, 103: 20, 33154: 1 }, rmap, { agua_brand: "nobis" });
    expect(resOn.latest.fun_pwf_set).toBe(1);
    expect(resOn.registers.fun_pwf_set.current_val).toBe(1);

    const resProg = decodeBufferToTelemetry({ 8: 5, 103: 20, 33154: 2 }, rmap, { agua_brand: "nobis" });
    expect(resProg.latest.fun_pwf_set).toBe(2);
    expect(resProg.registers.fun_pwf_set.current_val).toBe(2);

    const rmapWithPwfGet = parseRegistersMap({
      registers_map: [
        ...sampleAir2Ducts.registers_map,
        { reg_key: "powerful_get", offset: 26, formula: "#", reg_type: "GET" },
      ],
    });
    const resLiveOverride = decodeBufferToTelemetry(
      { 8: 5, 103: 20, 33154: 1, 26: 0 },
      rmapWithPwfGet,
      { agua_brand: "nobis" },
    );
    expect(resLiveOverride.latest.fun_pwf_set).toBe(0);
    expect(resLiveOverride.registers.fun_pwf_set.current_val).toBe(0);
  });

  it("decodeBufferToTelemetry reflète l'état réel de Confort/Éco (standby_enabled & can_write_eco)", () => {
    const baseList = sampleAir2Ducts.registers_map.filter((r) => r.reg_key !== "standby_set");
    const nobisNoStandbyReg = parseRegistersMap({ registers_map: baseList });
    const resWork = decodeBufferToTelemetry({ 8: 5, 103: 20 }, nobisNoStandbyReg, { agua_brand: "nobis" });
    expect(resWork.capabilities.has_eco).toBe(true);
    expect(resWork.capabilities.can_write_eco).toBe(false);
    expect(resWork.latest.standby_enabled).toBe(0);

    const resEcoStop = decodeBufferToTelemetry({ 8: 8, 103: 22 }, nobisNoStandbyReg, { agua_brand: "nobis" });
    expect(resEcoStop.latest.standby_enabled).toBe(1);

    const resStandby = decodeBufferToTelemetry({ 8: 9, 103: 18 }, nobisNoStandbyReg, { agua_brand: "nobis" });
    expect(resStandby.latest.standby_enabled).toBe(1);

    const multiBrandEcoMap = parseRegistersMap({
      registers_map: [
        ...baseList,
        { reg_key: "comfort_clima_set", offset: 33130, formula: "#", reg_type: "SET" },
        { reg_key: "standby_get", offset: 27, formula: "#", reg_type: "GET" },
      ],
    });
    const resRegOn = decodeBufferToTelemetry({ 8: 5, 103: 20, 33130: 0, 27: 1 }, multiBrandEcoMap, {});
    expect(resRegOn.capabilities.has_eco).toBe(true);
    expect(resRegOn.capabilities.can_write_eco).toBe(true);
    expect(resRegOn.latest.standby_enabled).toBe(1);
  });

  it("décode ECO STOP comme état 8 et expose les trois registres Comfort Clima", () => {
    const rmap = parseRegistersMap({
      registers_map: [
        { reg_key: "status_get", offset: 8, formula: "#", reg_type: "GET", enc_val: [{ lang: "ENG", value: 8, description: "ECO STOP" }] },
        { reg_key: "comfortclima_ability_set", offset: 33148, formula: "#", reg_type: "SET", is_word: false, set_min: 0, set_max: 1 },
        { reg_key: "comfortclima_time_set", offset: 33150, formula: "#", reg_type: "SET", is_word: false, set_min: 0, set_max: 9 },
        { reg_key: "comfortclima_time_enable", offset: 33148, formula: "#", reg_type: "ENABLE", enable_val: [{ value: 1 }] },
        { reg_key: "comfortclima_restart_set", offset: 33152, formula: "#", reg_type: "SET", is_word: false, set_min: 2, set_max: 5 },
        { reg_key: "comfortclima_restart_enable", offset: 33148, formula: "#", reg_type: "ENABLE", enable_val: [{ value: 1 }] },
      ],
    });
    const result = decodeBufferToTelemetry(
      { 8: 8, 33148: 1, 33150: 5, 33152: 2 },
      rmap,
      { agua_brand: "nobis" },
    );
    expect(result.latest.status_code).toBe(8);
    expect(result.latest.standby_enabled).toBe(1);
    expect(result.latest.comfortclima_ability_set).toBe(1);
    expect(result.latest.comfortclima_time_set).toBe(5);
    expect(result.latest.comfortclima_restart_set).toBe(2);
    expect(result.capabilities.can_write_eco).toBe(true);
  });

  it("detectCapabilities résout les clés retour canalization_2sx_* et canalization_2dx_* sur Nobis A10", () => {
    const nobisMap = parseRegistersMap({
      registers_map: [
        { reg_key: "temp_air2_get", offset: 103, formula: "#", reg_type: "GET" },
        { reg_key: "temp_air_set", offset: 33122, formula: "#", set_min: 7, set_max: 41, reg_type: "SET" },
        { reg_key: "power_set", offset: 33120, formula: "#", set_min: 1, set_max: 7, reg_type: "SET" },
        { reg_key: "canalization_sx_set", offset: 33136, formula: "#", set_min: 0, set_max: 8, reg_type: "SET" },
        { reg_key: "canalization_dx_set", offset: 33134, formula: "#", set_min: 0, set_max: 8, reg_type: "SET" },
        { reg_key: "canalization_2sx_get", offset: 32, formula: "#", reg_type: "GET" },
        { reg_key: "canalization_2sx_temp_air_get", offset: 29, formula: "#/2", reg_type: "GET" },
        { reg_key: "canalization_2dx_get", offset: 31, formula: "#", reg_type: "GET" },
        { reg_key: "canalization_2dx_temp_air_get", offset: 28, formula: "#/2", reg_type: "GET" },
      ],
    });
    const caps = detectCapabilities(nobisMap, {}, { agua_brand: "nobis" });
    const sx = caps.ducts.find((d) => d.id === "SX");
    const dx = caps.ducts.find((d) => d.id === "DX");
    expect(sx?.speed_get_key).toBe("canalization_2sx_get");
    expect(sx?.temp_get_key).toBe("canalization_2sx_temp_air_get");
    expect(dx?.speed_get_key).toBe("canalization_2dx_get");
    expect(dx?.temp_get_key).toBe("canalization_2dx_temp_air_get");
  });
});
