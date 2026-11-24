// Client météo direct Open-Meteo (sans clé API, cache TTL 10 min, timeout 8s) + géocodage inverse Nominatim.
import { Capacitor, CapacitorHttp } from "@capacitor/core";

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

  async _fetchJson(url, { headers = {}, timeoutMs = 8000 } = {}) {
    const isNative = typeof Capacitor !== "undefined"
      && typeof Capacitor.isNativePlatform === "function"
      && Capacitor.isNativePlatform();
    if (isNative) {
      const res = await CapacitorHttp.request({
        url,
        method: "GET",
        headers: { Accept: "application/json", ...headers },
        connectTimeout: timeoutMs,
        readTimeout: timeoutMs,
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`HTTP ${res.status}`);
      }
      return typeof res.data === "string" ? JSON.parse(res.data || "{}") : res.data;
    }

    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const hasHeaders = Object.keys(headers).length > 0;
      const init = {};
      if (hasHeaders) init.headers = headers;
      if (controller) init.signal = controller.signal;
      const resp = await fetch(url, Object.keys(init).length > 0 ? init : undefined);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
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
      try {
        const payload = await this._fetchJson(url, { timeoutMs: 8000 });
        const cur = payload?.current || {};
        const daily = payload?.daily || {};
        const rawDates = Array.isArray(daily.time) ? daily.time : [];
        const rawMeans = Array.isArray(daily.temperature_2m_mean) ? daily.temperature_2m_mean : [];
        const rawMins = Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min : [];
        const rawMaxs = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max : [];
        const dayCount = Math.max(rawDates.length, rawMeans.length, rawMins.length, rawMaxs.length);

        const means = [];
        const mins = [];
        const maxs = [];
        const dates = [];
        for (let i = 0; i < dayCount; i++) {
          const mn = rawMins[i] !== undefined && rawMins[i] !== null ? Number(rawMins[i]) : null;
          const mx = rawMaxs[i] !== undefined && rawMaxs[i] !== null ? Number(rawMaxs[i]) : null;
          let mean = rawMeans[i] !== undefined && rawMeans[i] !== null ? Number(rawMeans[i]) : null;
          if ((mean === null || !Number.isFinite(mean)) && Number.isFinite(mn) && Number.isFinite(mx)) {
            mean = Number(((mn + mx) / 2).toFixed(1));
          }
          if (!Number.isFinite(mean) && !Number.isFinite(mn) && !Number.isFinite(mx)) {
            continue;
          }
          means.push(Number.isFinite(mean) ? mean : 0);
          mins.push(Number.isFinite(mn) ? mn : (Number.isFinite(mean) ? mean - 3.2 : 0));
          maxs.push(Number.isFinite(mx) ? mx : (Number.isFinite(mean) ? mean + 3.2 : 0));
          if (rawDates[i]) dates.push(String(rawDates[i]));
        }

        this.lastWeather = {
          weather_temp_ext: cur.temperature_2m ?? this.lastWeather.weather_temp_ext,
          weather_humidity: cur.relative_humidity_2m ?? this.lastWeather.weather_humidity,
          weather_wind_kmh: cur.wind_speed_10m ?? this.lastWeather.weather_wind_kmh,
          forecast_daily_means: means.length > 0 ? means : this.lastWeather.forecast_daily_means,
          forecast_daily_mins: mins.length > 0 ? mins : this.lastWeather.forecast_daily_mins,
          forecast_daily_maxs: maxs.length > 0 ? maxs : this.lastWeather.forecast_daily_maxs,
          forecast_daily_dates: dates.length > 0 ? dates : this.lastWeather.forecast_daily_dates,
          last_update_epoch: Math.floor(Date.now() / 1000),
        };
        this.lastFetchTs = Date.now();
        this.lastCoords = coordKey;
      } catch {
        this.lastFetchTs = Date.now() - (this.cacheTtlMs - 60_000);
      } finally {
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
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&zoom=10&addressdetails=1`;
      const data = await this._fetchJson(url, {
        headers: { Accept: "application/json", "Accept-Language": "fr" },
        timeoutMs: 6000,
      });
      const addr = data?.address || {};
      const city = (addr.city || addr.town || addr.village || addr.municipality || "").trim();
      const pc = (addr.postcode || "").trim();
      if (city) return pc ? `${city} (${pc})` : city;
    } catch {
      // Repli silencieux si Nominatim injoignable
    }
    return "";
  }

  /** Estime la position approximative via IP publique (repli sans GPS / HTTP LAN). */
  async geolocateByIp() {
    const endpoints = [
      {
        url: "https://get.geojs.io/v1/ip/geo.json",
        parse: (d) => ({
          lat: Number(d?.latitude),
          lon: Number(d?.longitude),
          city: String(d?.city || "").trim(),
        }),
      },
      {
        url: "https://ipwho.is/",
        parse: (d) => (d && d.success !== false ? {
          lat: Number(d?.latitude),
          lon: Number(d?.longitude),
          city: String(d?.city || "").trim(),
        } : null),
      },
    ];

    for (const ep of endpoints) {
      try {
        const raw = await this._fetchJson(ep.url, { timeoutMs: 5000 });
        const parsed = ep.parse(raw);
        if (parsed && Number.isFinite(parsed.lat) && Number.isFinite(parsed.lon)
            && Math.abs(parsed.lat) <= 90 && Math.abs(parsed.lon) <= 180) {
          return { ...parsed, source: "ip" };
        }
      } catch {
        // Repli silencieux sur le fournisseur suivant
      }
    }
    return null;
  }
}
