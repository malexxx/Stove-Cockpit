// Client météo direct Open-Meteo (sans clé API, cache TTL 10 min, timeout 8s) + géocodage inverse Nominatim.

export class WeatherDirectClient {
  constructor() {
    this.cacheTtlMs = 600_000;
    this.lastFetchTs = 0;
    this.lastCoords = "";
    this._inFlight = null;
    this.lastWeather = {
      weather_temp_ext: null,
      weather_humidity: null,
      weather_wind_kmh: null,
      forecast_daily_means: [],
      forecast_daily_mins: [],
      forecast_daily_maxs: [],
      forecast_daily_dates: [],
      last_update_epoch: 0,
    };
  }

  /** Récupère la météo courante et les prévisions 14 jours avec cache 10 min et déduplication en vol. */
  async fetchCurrent(lat, lon, force = false) {
    const fLat = Number(lat);
    const fLon = Number(lon);
    if (!Number.isFinite(fLat) || !Number.isFinite(fLon) || fLat < -90 || fLat > 90 || fLon < -180 || fLon > 180) {
      return this.lastWeather;
    }
    const coordKey = `${fLat.toFixed(4)},${fLon.toFixed(4)}`;
    const now = Date.now();
    if (!force && coordKey === this.lastCoords && (now - this.lastFetchTs) < this.cacheTtlMs) {
      return this.lastWeather;
    }
    if (this._inFlight && this._inFlight.coordKey === coordKey) {
      return this._inFlight.promise;
    }

    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${encodeURIComponent(fLat)}&longitude=${encodeURIComponent(fLon)}` +
      `&current=temperature_2m,relative_humidity_2m,wind_speed_10m` +
      `&daily=temperature_2m_mean,temperature_2m_min,temperature_2m_max` +
      `&forecast_days=14&timezone=auto`;

    const runFetch = async () => {
      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), 8000) : null;
      try {
        const resp = await fetch(url, controller ? { signal: controller.signal } : undefined);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const payload = await resp.json();
        const cur = payload.current || {};
        const daily = payload.daily || {};
        this.lastWeather = {
          weather_temp_ext: cur.temperature_2m ?? this.lastWeather.weather_temp_ext,
          weather_humidity: cur.relative_humidity_2m ?? this.lastWeather.weather_humidity,
          weather_wind_kmh: cur.wind_speed_10m ?? this.lastWeather.weather_wind_kmh,
          forecast_daily_means: (daily.temperature_2m_mean || []).filter((x) => x !== null),
          forecast_daily_mins: (daily.temperature_2m_min || []).filter((x) => x !== null),
          forecast_daily_maxs: (daily.temperature_2m_max || []).filter((x) => x !== null),
          forecast_daily_dates: daily.time || [],
          last_update_epoch: Math.floor(Date.now() / 1000),
        };
        this.lastFetchTs = Date.now();
        this.lastCoords = coordKey;
      } catch {
        this.lastFetchTs = Date.now() - (this.cacheTtlMs - 60_000);
      } finally {
        if (timer) clearTimeout(timer);
        this._inFlight = null;
      }
      return this.lastWeather;
    };

    const promise = runFetch();
    this._inFlight = { coordKey, promise };
    return promise;
  }

  /** Résout un nom de ville et code postal depuis des coordonnées GPS (timeout 6s). */
  async reverseGeocode(lat, lon) {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 6000) : null;
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&zoom=10&addressdetails=1`;
      const resp = await fetch(url, {
        headers: { Accept: "application/json", "Accept-Language": "fr" },
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (resp.ok) {
        const data = await resp.json();
        const addr = data?.address || {};
        const city = (addr.city || addr.town || addr.village || addr.municipality || "").trim();
        const pc = (addr.postcode || "").trim();
        if (city) return pc ? `${city} (${pc})` : city;
      }
    } catch {
      // Repli silencieux si Nominatim injoignable
    } finally {
      if (timer) clearTimeout(timer);
    }
    return "";
  }
}
