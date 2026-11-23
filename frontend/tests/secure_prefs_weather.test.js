import { afterEach, describe, expect, it, vi } from "vitest";
import { WeatherDirectClient } from "../src/providers/weather_direct.js";
import { loadAllPrefs, savePrefsPatch } from "../src/storage/secure_prefs.js";

describe("secure_prefs & WeatherDirectClient", () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
  });

  it("loadAllPrefs retourne hopper_capacity_kg='35' par défaut et génère un UUID v4 valide", async () => {
    const prefs = await loadAllPrefs();
    expect(prefs.hopper_capacity_kg).toBe("35");
    expect(prefs.agua_uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    await savePrefsPatch({ hopper_capacity_kg: "42" });
  });

  it("WeatherDirectClient ignore les coordonnées invalides et déduplique les appels simultanés", async () => {
    const wc = new WeatherDirectClient();
    const invalid = await wc.fetchCurrent(999, 999);
    expect(invalid.weather_temp_ext).toBeNull();

    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 15));
      return {
        ok: true,
        json: async () => ({
          current: { temperature_2m: 11.4, relative_humidity_2m: 70, wind_speed_10m: 15 },
          daily: { temperature_2m_mean: [10], temperature_2m_min: [5], temperature_2m_max: [14], time: ["2026-11-23"] },
        }),
      };
    });

    const [a, b] = await Promise.all([wc.fetchCurrent(48.8566, 2.3522), wc.fetchCurrent(48.8566, 2.3522)]);
    expect(calls).toBe(1);
    expect(a.weather_temp_ext).toBe(11.4);
    expect(b.weather_temp_ext).toBe(11.4);
  });
});
