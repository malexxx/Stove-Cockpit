// Client météo direct Open-Meteo (sans clé API, cache TTL 10 min) + géocodage inverse.

export class WeatherDirectClient {
  constructor() {
    this.cacheTtlMs = 600_000;
    this.lastFetchTs = 0;
    this.lastCoords = "";
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

    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${encodeURIComponent(fLat)}&longitude=${encodeURIComponent(fLon)}` +
      `&current=temperature_2m,relative_humidity_2m,wind_speed_10m` +
      `&daily=temperature_2m_mean,temperature_2m_min,temperature_2m_max` +
      `&forecast_days=14&timezone=auto`;

    try {
      const resp = await fetch(url);
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
        last_update_epoch: Math.floor(now / 1000),
      };
      this.lastFetchTs = now;
      this.lastCoords = coordKey;
    } catch {
      this.lastFetchTs = now - (this.cacheTtlMs - 60_000);
    }
    return this.lastWeather;
  }

  async reverseGeocode(lat, lon) {
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&zoom=10&addressdetails=1`;
      const resp = await fetch(url, { headers: { Accept: "application/json" } });
      if (resp.ok) {
        const data = await resp.json();
        const addr = data?.address || {};
        const city = (addr.city || addr.town || addr.village || addr.municipality || "").trim();
        const pc = (addr.postcode || "").trim();
        if (city) return pc ? `${city} (${pc})` : city;
      }
    } catch {
      // ignore
    }
    return "";
  }
}
