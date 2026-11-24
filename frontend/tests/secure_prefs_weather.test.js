import { afterEach, describe, expect, it, vi } from "vitest";
import { WeatherDirectClient } from "../src/providers/weather_direct.js";
import { DemoProvider } from "../src/providers/demo_provider.js";
import { decodeBufferToTelemetry } from "../src/micronova/register_engine.js";
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
    expect(a.forecast_daily_means).toEqual([10]);
  });

  it("WeatherDirectClient calcule les moyennes journalières manquantes et propage weather_details en Autonome/Démo", async () => {
    const wc = new WeatherDirectClient();
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        current: { temperature_2m: 8.2, relative_humidity_2m: 81, wind_speed_10m: 9.5 },
        daily: {
          time: ["2026-11-24", "2026-11-25"],
          temperature_2m_mean: [null, 7.0],
          temperature_2m_min: [4.0, 3.0],
          temperature_2m_max: [12.0, 11.0],
        },
      }),
    }));

    const w = await wc.fetchCurrent(45.75, 4.85);
    expect(w.forecast_daily_dates).toEqual(["2026-11-24", "2026-11-25"]);
    expect(w.forecast_daily_means).toEqual([8, 7]);
    expect(w.forecast_daily_mins).toEqual([4, 3]);
    expect(w.forecast_daily_maxs).toEqual([12, 11]);

    const decoded = decodeBufferToTelemetry({ 8: 5, 103: 20.5 }, {}, {}, w, "TestPoêle");
    expect(decoded.latest.weather_details.forecast_daily_means).toEqual([8, 7]);

    const demo = new DemoProvider("nobis_2ducts");
    const demoEmptyWeather = demo.buildPayload({}, {});
    expect(demoEmptyWeather.latest.weather_details.forecast_daily_means.length).toBeGreaterThan(0);

    const demoLiveWeather = demo.buildPayload({}, w);
    expect(demoLiveWeather.latest.weather_details.forecast_daily_dates).toEqual(["2026-11-24", "2026-11-25"]);
  });
});
