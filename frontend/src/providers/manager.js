// Orchestrateur unifié des providers : Mode Autonome (AguaDirect) / Mode « + » (Conteneur) / Repli Cloud / Démo.
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { Geolocation } from "@capacitor/geolocation";
import { Network } from "@capacitor/network";
import { decodeBufferToTelemetry } from "../micronova/register_engine.js";
import { loadAllPrefs, savePrefsPatch } from "../storage/secure_prefs.js";
import { AguaDirectProvider, getAllBrands, getBrandPreset } from "./agua_direct.js";
import { ContainerApiClient } from "./container_api.js";
import { DemoProvider } from "./demo_provider.js";
import { WeatherDirectClient } from "./weather_direct.js";
import { FRONTEND_VERSION, FRONTEND_VERSION_TAG, formatVersionTag } from "../version.js";
import { SYNCABLE_CLOUD_KEYS, decryptCredEnvelope, encryptCredEnvelope } from "../security/cred_envelope.js";

export class ProviderManager {
  constructor() {
    this.agua = new AguaDirectProvider();
    this.weather = new WeatherDirectClient();
    this.container = new ContainerApiClient();
    this.demo = new DemoProvider();
    this.prefs = {};
    this.mode = "standalone"; // "standalone" | "container" | "fallback" | "demo"
    this.servedByContainer = false;
    this.backendVersion = null;
    this.pollTimer = null;
    this.onStateCallback = null;
    this.lastPayload = null;
    this._lastDirectFetchAt = 0;
    this.listenersAttached = false;
  }

  _looksLikeContainerHttpOrigin() {
    if (typeof window === "undefined") return false;
    const isNative = typeof Capacitor !== "undefined" && typeof Capacitor.isNativePlatform === "function" && Capacitor.isNativePlatform();
    if (isNative) return false;
    const proto = window.location?.protocol || "";
    const port = window.location?.port || "";
    return (proto === "http:" || proto === "https:") && port !== "5173";
  }

  async init() {
    this.prefs = (await loadAllPrefs()) || {};
    this.servedByContainer = false;
    if (this._looksLikeContainerHttpOrigin()) {
      const sameOriginPing = await this.container.pingHealth("", this.prefs.container_api_token || "");
      this.servedByContainer = Boolean(sameOriginPing.ok);
      if (this.servedByContainer) {
        this._recordBackendVersion(sameOriginPing.data);
      }
    }
    if (this.servedByContainer) {
      this.prefs.app_mode = "container";
      this.prefs.container_url = "";
      await savePrefsPatch({ app_mode: "container", container_url: "" });
    }
    this.container.configure(this.prefs.container_url, this.prefs.container_api_token);
    this.demo.setProfile(this.prefs.demo_profile || "nobis_2ducts");
    await this.resolveActiveMode();
    this._attachPlatformListeners();
    return this.mode;
  }

  getMode() {
    return this.mode;
  }

  isContainerActive() {
    return this.mode === "container";
  }

  isServedByContainer() {
    return Boolean(this.servedByContainer);
  }

  getFrontendVersion() {
    return FRONTEND_VERSION_TAG;
  }

  getBackendVersion() {
    return this.isContainerActive() ? this.backendVersion : null;
  }

  _recordBackendVersion(payload) {
    if (!payload || typeof payload !== "object") return;
    const raw = payload.backend_version || payload.docker_version || payload.version;
    if (raw) {
      this.backendVersion = formatVersionTag(raw);
    }
  }

  needsOnboarding() {
    if (this.servedByContainer) return false;
    return !this.prefs.app_mode;
  }

  getBrands() {
    return getAllBrands();
  }

  getBrandPreset(brandId) {
    return getBrandPreset(brandId);
  }

  async resolveActiveMode() {
    const desired = this.prefs.app_mode || (this.servedByContainer ? "container" : "demo");
    if (desired === "demo") {
      this.mode = "demo";
      this.backendVersion = null;
      return this.mode;
    }
    if (desired === "container") {
      if (this.servedByContainer) {
        this.mode = "container";
        return this.mode;
      }
      const health = await this.container.pingHealth();
      if (health.ok) {
        this.mode = "container";
        this._recordBackendVersion(health.data);
        return this.mode;
      }
      const canFallback = this.prefs.fallback_to_cloud !== "0" && Boolean(this.prefs.agua_email && this.prefs.agua_password);
      this.mode = canFallback ? "fallback" : "container";
      if (this.mode !== "container") {
        this.backendVersion = null;
      }
      return this.mode;
    }
    this.mode = "standalone";
    this.backendVersion = null;
    return this.mode;
  }

  _attachPlatformListeners() {
    if (this.listenersAttached) return;
    this.listenersAttached = true;
    try {
      App.addListener("appStateChange", async ({ isActive }) => {
        if (isActive && this.onStateCallback) {
          await this.resolveActiveMode();
          await this.pollNow().catch(() => {});
        }
      });
    } catch {
      // ignore outside native
    }
    try {
      Network.addListener("networkStatusChange", async (status) => {
        if (status.connected && this.prefs.app_mode === "container" && !this.servedByContainer) {
          const prevMode = this.mode;
          await this.resolveActiveMode();
          if (prevMode !== this.mode && this.onStateCallback) {
            await this.pollNow().catch(() => {});
          }
        }
      });
    } catch {
      // ignore outside native
    }
  }

  async _fetchDirectTelemetryPayload() {
    const weatherData = await this.weather.fetchCurrent(this.prefs.weather_lat, this.prefs.weather_lon);
    const rawBuf = await this.agua.readBuffer(this.prefs);
    const decoded = decodeBufferToTelemetry(
      rawBuf,
      this.agua.rawRegistersMap,
      this.prefs,
      weatherData,
      this.agua.stoveName,
    );
    const payload = {
      frontend_version: FRONTEND_VERSION,
      active_mode: this.mode,
      stove_name: decoded.latest.stove_name,
      capabilities: decoded.capabilities,
      latest: decoded.latest,
      comm_status: {
        connected: true,
        comm_mode: "agua_cloud",
        last_sync_time: decoded.latest.timestamp,
        last_sync_epoch: decoded.latest.epoch,
      },
      settings: this.getPublicSettings(),
      registers: decoded.registers,
      silence_mode: { active: false, remaining_seconds: 0, end_epoch: 0 },
      weather_data: weatherData,
    };
    this.lastPayload = payload;
    this._lastDirectFetchAt = Date.now();
    return payload;
  }

  getPublicSettings() {
    return {
      ...this.prefs,
      agua_password: this.prefs.agua_password ? "********" : "",
      container_api_token: this.prefs.container_api_token ? "********" : "",
    };
  }

  _isDefaultWeather(src) {
    if (!src) return true;
    const lat = Number(src.weather_lat);
    const lon = Number(src.weather_lon);
    const isDefCoords = (!src.weather_lat || (Number.isFinite(lat) && lat.toFixed(4) === "48.8566"))
      && (!src.weather_lon || (Number.isFinite(lon) && lon.toFixed(4) === "2.3522"));
    const city = String(src.weather_city || "").trim();
    return isDefCoords && (!city || city.startsWith("Paris"));
  }

  async _mirrorContainerSettingsToLocalPrefs(remoteSettings) {
    if (!remoteSettings || typeof remoteSettings !== "object" || this.servedByContainer) return;
    const sharedKeys = ["weather_city", "weather_lat", "weather_lon", "duct_left_name", "duct_right_name", "hopper_capacity_kg"];
    const patch = {};
    for (const k of sharedKeys) {
      const val = remoteSettings[k];
      if (val !== undefined && val !== null && String(val) !== "" && String(val) !== String(this.prefs[k] ?? "")) {
        patch[k] = String(val);
      }
    }
    if (patch.weather_lat !== undefined || patch.weather_lon !== undefined) {
      this.weather.lastFetchTs = 0;
      this.weather.lastCoords = "";
    }
    if (Object.keys(patch).length > 0) {
      Object.assign(this.prefs, patch);
      await savePrefsPatch(patch);
    }
  }

  async loadDashboard(rangeKey = "24h") {
    if (this.mode === "container") {
      const r = await this.container.request(`/api/dashboard?range_key=${encodeURIComponent(rangeKey)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      this._recordBackendVersion(data);
      await this._mirrorContainerSettingsToLocalPrefs(data?.settings);
      this.lastPayload = data;
      return data;
    }
    if (this.mode === "demo") {
      const w = await this.weather.fetchCurrent(this.prefs.weather_lat, this.prefs.weather_lon);
      const data = this.demo.buildPayload(this.getPublicSettings(), w);
      data.series = [];
      this.lastPayload = data;
      return data;
    }
    const data = await this._fetchDirectTelemetryPayload();
    data.series = [];
    return data;
  }

  async getLatest() {
    if (this.mode === "container") {
      const r = await this.container.request("/api/latest");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      this._recordBackendVersion(data);
      this.lastPayload = data;
      return data;
    }
    if (this.mode === "demo") {
      const w = await this.weather.fetchCurrent(this.prefs.weather_lat, this.prefs.weather_lon);
      const data = this.demo.buildPayload(this.getPublicSettings(), w);
      this.lastPayload = data;
      return data;
    }
    if (this.lastPayload && (Date.now() - this._lastDirectFetchAt) < 2500) {
      return this.lastPayload;
    }
    return this._fetchDirectTelemetryPayload();
  }

  async pollNow(force = false) {
    if (this.mode === "container") {
      const r = await this.container.request("/api/poll-now", { method: "POST" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    }
    if (force) this._lastDirectFetchAt = 0;
    const data = await this.getLatest();
    if (this.onStateCallback) this.onStateCallback(data);
    return { status: "ok", latest: data.latest, comm_status: data.comm_status };
  }

  async sendCommand(regKey, value, offset = null, extraHeaders = {}) {
    return this.sendCommandBatch([{ reg_key: regKey, value: Number(value), offset }], extraHeaders);
  }

  async sendCommandBatch(commands, extraHeaders = {}) {
    if (this.mode === "container") {
      const ep = commands.length === 1 ? "/api/command" : "/api/command-batch";
      const body = commands.length === 1 ? commands[0] : { commands };
      const r = await this.container.request(ep, { method: "POST", headers: extraHeaders, body });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${r.status}`);
      }
      return await r.json();
    }
    if (this.mode === "demo") {
      return this.demo.applyCommands(commands);
    }
    const res = await this.agua.writeRegistersBatch(this.prefs, commands);
    await this.pollNow(true).catch(() => {});
    return res;
  }

  async syncClock() {
    if (this.mode === "container") {
      const r = await this.container.request("/api/sync-clock", { method: "POST" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    }
    const now = new Date();
    const cmds = [
      { reg_key: "clock_hour_set", offset: 34048, value: now.getHours() },
      { reg_key: "clock_minute_set", offset: 34049, value: now.getMinutes() },
      { reg_key: "calendar_day_set", offset: 34050, value: now.getDate() },
      { reg_key: "calendar_month_set", offset: 34051, value: now.getMonth() + 1 },
      { reg_key: "calendar_year_set", offset: 34052, value: now.getFullYear() - 2000 },
      { reg_key: "calendar_day_week_set", offset: 34053, value: (now.getDay() + 6) % 7 + 1 },
    ];
    await this.sendCommandBatch(cmds);
    return { status: "ok", synced_to: now.toLocaleString("fr-FR") };
  }

  async activateSilence(durationHours = 2.0) {
    this._requireContainer("Le mode Silence");
    return this._containerJson("/api/silence/activate", {
      method: "POST",
      body: { duration_hours: durationHours },
    });
  }

  async deactivateSilence(overrideCommands = null) {
    this._requireContainer("Le mode Silence");
    return this._containerJson("/api/silence/deactivate", {
      method: "POST",
      body: overrideCommands ? { override_commands: overrideCommands } : {},
    });
  }

  async saveSettings(patch, extraHeaders = {}) {
    const cleanPatch = { ...patch };
    if (cleanPatch.agua_password === "********") delete cleanPatch.agua_password;
    if (cleanPatch.container_api_token === "********") delete cleanPatch.container_api_token;

    const cloudAuthKeys = [
      "agua_brand",
      "agua_api_url",
      "agua_customer_code",
      "agua_brand_id",
      "agua_brand_header",
      "agua_login_api_url",
      "agua_email",
      "agua_password",
    ];
    if (cloudAuthKeys.some((k) => k in cleanPatch)) {
      this.agua.tokenJwt = null;
      this.agua.refreshToken = null;
      this.agua.idDevice = "";
      this.agua.idProduct = "";
      this.agua.stoveName = "";
      this.agua.workingWriteEndpoint = null;
      this._lastDirectFetchAt = 0;
    }

    Object.assign(this.prefs, cleanPatch);
    await savePrefsPatch(cleanPatch);
    this.container.configure(this.prefs.container_url, this.prefs.container_api_token);
    if (cleanPatch.demo_profile) this.demo.setProfile(cleanPatch.demo_profile);

    if (this.mode === "container" && !cleanPatch.app_mode) {
      const r = await this.container.request("/api/settings", {
        method: "POST",
        headers: extraHeaders,
        body: cleanPatch,
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${r.status}`);
      }
      return await r.json();
    }
    await this.resolveActiveMode();
    return { status: "ok", mode: this.mode, settings: this.getPublicSettings() };
  }

  async testCloudDirect(cfg) {
    const merged = { ...this.prefs, ...cfg };
    if (merged.agua_password === "********") merged.agua_password = this.prefs.agua_password;
    return await this.agua.loginAndDiscover(merged);
  }

  async testContainerConnection(url, token) {
    return await this.container.pingHealth(url, token);
  }

  async reverseGeocode(lat, lon) {
    if (this.mode === "container") {
      const r = await this.container.request(`/api/reverse-geocode?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`);
      if (r.ok) return await r.json();
    }
    const city = await this.weather.reverseGeocode(lat, lon);
    return { status: "ok", city, lat: String(lat), lon: String(lon) };
  }

  /**
   * Obtient la position GPS (Capacitor natif sur Android/iOS, navigator.geolocation sur Web sécurisé)
   * avec repli automatique par géolocalisation IP en contexte HTTP LAN ou si le GPS échoue.
   */
  async getCurrentPosition() {
    const isNative = typeof Capacitor !== "undefined"
      && typeof Capacitor.isNativePlatform === "function"
      && Capacitor.isNativePlatform();
    const opts = { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 };
    let lastError = null;

    if (isNative) {
      try {
        const perm = await Geolocation.checkPermissions();
        if (perm?.location !== "granted" && perm?.coarseLocation !== "granted") {
          const req = await Geolocation.requestPermissions();
          if (req?.location !== "granted" && req?.coarseLocation !== "granted") {
            const err = new Error("Permission de géolocalisation refusée sur l'appareil.");
            err.code = 1;
            throw err;
          }
        }
        const pos = await Geolocation.getCurrentPosition(opts);
        return { lat: pos.coords.latitude, lon: pos.coords.longitude, source: "gps" };
      } catch (err) {
        lastError = err;
      }
    } else if (typeof navigator !== "undefined" && navigator.geolocation && (typeof window === "undefined" || window.isSecureContext !== false)) {
      try {
        const pos = await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, opts);
        });
        return { lat: pos.coords.latitude, lon: pos.coords.longitude, source: "gps" };
      } catch (err) {
        lastError = err;
      }
    }

    // Repli par IP publique (utile en HTTP LAN non sécurisé ou sans capteur GPS)
    if (this.mode === "container") {
      try {
        const r = await this.container.request("/api/geolocate-ip");
        if (r.ok) {
          const data = await r.json();
          const lat = Number(data?.lat);
          const lon = Number(data?.lon);
          if (Number.isFinite(lat) && Number.isFinite(lon)) {
            return { lat, lon, city: String(data?.city || "").trim(), source: "ip" };
          }
        }
      } catch {
        // Repli silencieux sur le client météo direct
      }
    }

    const ipPos = await this.weather.geolocateByIp();
    if (ipPos) return ipPos;

    if (lastError) throw lastError;
    const err = new Error("Géolocalisation indisponible.");
    err.code = 2;
    throw err;
  }

  startLiveUpdates(onState) {
    this.stopLiveUpdates();
    this.onStateCallback = onState;
    if (this.mode === "container") {
      this.container.openSse(
        (evt) => {
          try {
            const msg = JSON.parse(evt.data);
            this._recordBackendVersion(msg);
            if (msg.latest) {
              this.lastPayload = msg;
              onState(msg);
            }
          } catch {
            // ignore
          }
        },
        () => {
          // fallback timer below covers temporary SSE loss
        },
      );
    }
    const intervalMs = Math.max(15000, Number(this.prefs.poll_interval_s || 60) * 1000);
    this.pollTimer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      this.getLatest().then((d) => onState(d)).catch(() => {});
    }, intervalMs);
  }

  stopLiveUpdates() {
    this.container.closeSse();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  _requireContainer(feature = "Cette fonctionnalité") {
    if (this.mode !== "container") {
      throw new Error(`${feature} nécessite le Mode « + » (Conteneur Compagnon connecté).`);
    }
  }

  async _containerJson(path, opts = {}) {
    const r = await this.container.request(path, opts);
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      const e = new Error(err.detail || `HTTP ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return await r.json();
  }

  getContainerDownloadUrl(path) {
    return this.container.buildUrl(path, true);
  }

  async pingContainerHealth() {
    return await this.container.pingHealth();
  }

  // --- Actions Conteneur uniquement (Mode « + ») ---
  async refillHopper(payload, extraHeaders = {}) {
    this._requireContainer("La gestion trémie");
    return this._containerJson("/api/refill-hopper", { method: "POST", headers: extraHeaders, body: payload });
  }

  async pelletBatchRaz(pelletBrandOrPayload, extraHeaders = {}) {
    this._requireContainer("La réinitialisation de lot granulés");
    const body = typeof pelletBrandOrPayload === "string"
      ? { pellet_brand: pelletBrandOrPayload }
      : (pelletBrandOrPayload || {});
    return this._containerJson("/api/pellet-batch/raz", { method: "POST", headers: extraHeaders, body });
  }

  async getMatterStatus() {
    this._requireContainer("Le pont Matter");
    return this._containerJson("/api/matter/status");
  }

  async factoryResetMatter(extraHeaders = {}) {
    this._requireContainer("La réinitialisation Matter");
    return this._containerJson("/api/matter/factory-reset", { method: "POST", headers: extraHeaders });
  }

  async getSnapshots(extraHeaders = {}) {
    this._requireContainer("Les snapshots EEPROM");
    return this._containerJson("/api/snapshots", { headers: extraHeaders });
  }

  async createSnapshot(name, refreshLive = false, extraHeaders = {}) {
    this._requireContainer("La création de snapshot");
    return this._containerJson("/api/snapshots", { method: "POST", headers: extraHeaders, body: { name, refresh_live: Boolean(refreshLive) } });
  }

  async restoreSnapshot(id, extraHeaders = {}) {
    this._requireContainer("La restauration de snapshot");
    return this._containerJson(`/api/snapshots/${encodeURIComponent(id)}/restore`, { method: "POST", headers: extraHeaders });
  }

  async deleteSnapshot(id, extraHeaders = {}) {
    this._requireContainer("La suppression de snapshot");
    return this._containerJson(`/api/snapshots/${encodeURIComponent(id)}`, { method: "DELETE", headers: extraHeaders });
  }

  async getLogs(severity = "ALL") {
    this._requireContainer("Les journaux serveur");
    return this._containerJson(`/api/logs?severity=${encodeURIComponent(severity)}`, { headers: { "Cache-Control": "no-store" } });
  }

  async reportClientError(severity, source, message, extraHeaders = {}) {
    if (this.mode !== "container") return { status: "ignored_standalone" };
    return this.container.request("/api/logs/client-error", {
      method: "POST",
      headers: extraHeaders,
      body: { severity, source, message },
    }).catch(() => null);
  }

  async getAudit() {
    this._requireContainer("L'historique d'audit");
    return this._containerJson("/api/audit");
  }

  async rollbackAudit(id, extraHeaders = {}) {
    this._requireContainer("Le rollback d'audit");
    return this._containerJson(`/api/rollback/${encodeURIComponent(id)}`, { method: "POST", headers: extraHeaders });
  }

  async verifyInstaller(password) {
    this._requireContainer("Le mode installateur serveur");
    return this._containerJson("/api/installer/verify", { method: "POST", body: { password } });
  }

  async getInstallerStatus(extraHeaders = {}) {
    if (this.mode !== "container") {
      return { unlocked: false, remaining_seconds: 0 };
    }
    return this._containerJson("/api/installer/status", { headers: extraHeaders });
  }

  async lockInstaller(extraHeaders = {}) {
    if (this.mode !== "container") return { unlocked: false };
    return this._containerJson("/api/installer/lock", { method: "POST", headers: extraHeaders });
  }

  async getStorageStatus() {
    this._requireContainer("Le diagnostic stockage");
    return this._containerJson("/api/system/storage");
  }

  async getUpdateStatus() {
    this._requireContainer("Les mises à jour conteneur");
    return this._containerJson("/api/system/update/status");
  }

  async setUpdateConfig(cfg, extraHeaders = {}) {
    this._requireContainer("La configuration MAJ conteneur");
    return this._containerJson("/api/system/update/config", { method: "POST", headers: extraHeaders, body: cfg });
  }

  async checkUpdate(extraHeaders = {}) {
    this._requireContainer("La vérification MAJ conteneur");
    return this._containerJson("/api/system/update/check", { method: "POST", headers: extraHeaders });
  }

  async applyUpdate(extraHeaders = {}) {
    this._requireContainer("L'application MAJ conteneur");
    return this._containerJson("/api/system/update/apply", { method: "POST", headers: extraHeaders, timeoutMs: 60000 });
  }

  async rollbackUpdate(extraHeaders = {}) {
    this._requireContainer("Le rollback MAJ conteneur");
    return this._containerJson("/api/system/update/rollback", { method: "POST", headers: extraHeaders, timeoutMs: 30000 });
  }

  async restartBackend(extraHeaders = {}) {
    this._requireContainer("Le redémarrage serveur");
    return this._containerJson("/api/system/restart", { method: "POST", headers: extraHeaders });
  }

  async getPairingInfo() {
    this._requireContainer("L'appairage mobile");
    return this._containerJson("/api/system/pairing-info");
  }

  async rotatePairingToken(extraHeaders = {}) {
    this._requireContainer("La rotation du token d'appairage");
    return this._containerJson("/api/system/pairing-token/rotate", { method: "POST", headers: extraHeaders });
  }

  async createCloudSyncTicket(extraHeaders = {}) {
    this._requireContainer("La génération du QR Code de synchronisation");
    return this._containerJson("/api/system/cloud-credentials/ticket", { method: "POST", headers: extraHeaders });
  }

  hasLocalCloudCredentials() {
    return Boolean(this.prefs?.agua_email && this.prefs?.agua_password);
  }

  async syncWeatherOnContainerConnect({ url, token } = {}) {
    if (this.servedByContainer) return;
    const targetUrl = String(url !== undefined ? url : (this.prefs.container_url || "")).trim().replace(/\/+$/, "");
    const targetTok = String(token !== undefined ? token : (this.prefs.container_api_token || "")).trim();
    const client = new ContainerApiClient();
    client.configure(targetUrl, targetTok);
    try {
      const r = await client.request("/api/dashboard?range_key=24h");
      if (!r.ok) return;
      const data = await r.json();
      const remoteSettings = data?.settings || {};
      if (!this._isDefaultWeather(this.prefs) && this._isDefaultWeather(remoteSettings)) {
        await client.request("/api/settings", {
          method: "POST",
          body: {
            weather_city: String(this.prefs.weather_city || ""),
            weather_lat: String(this.prefs.weather_lat || ""),
            weather_lon: String(this.prefs.weather_lon || ""),
          },
        });
      } else {
        await this._mirrorContainerSettingsToLocalPrefs(remoteSettings);
      }
    } catch {
      // Repli silencieux si conteneur injoignable
    }
  }

  async pushCloudCredentialsToContainer({ url, token, syncTicket = "", installerToken = "", activateCloudMode = true, credentials = null } = {}) {
    const targetUrl = String(url !== undefined ? url : (this.prefs.container_url || "")).trim().replace(/\/+$/, "");
    const targetTok = String(token || this.prefs.container_api_token || "").trim();
    if (!targetTok) {
      throw new Error("Token API du conteneur requis pour chiffrer l'envoi des identifiants.");
    }
    const src = credentials || this.prefs || {};
    const creds = {};
    for (const key of SYNCABLE_CLOUD_KEYS) {
      const val = src[key];
      if (val !== undefined && val !== null && String(val) !== "" && String(val) !== "********") {
        creds[key] = String(val);
      }
    }
    const hasCloud = Boolean(creds.agua_email && creds.agua_password);
    const hasWeather = Boolean(creds.weather_lat && creds.weather_lon);
    if (!hasCloud && !hasWeather) {
      throw new Error("Aucun identifiant Cloud ni coordonnée météo renseigné dans l'application.");
    }

    const cleanTicket = String(syncTicket || "").trim();
    const cleanInst = String(installerToken || "").trim();
    const authProof = cleanTicket || cleanInst;
    const envelope = await encryptCredEnvelope(creds, targetTok, authProof);

    const client = new ContainerApiClient();
    client.configure(targetUrl, targetTok);
    const headers = cleanInst ? { "X-Installer-Token": cleanInst } : {};
    const r = await client.request("/api/system/cloud-credentials/import", {
      method: "POST",
      headers,
      body: {
        envelope,
        ...(cleanTicket ? { sync_ticket: cleanTicket } : {}),
        activate_cloud_mode: Boolean(activateCloudMode && hasCloud),
      },
    });
    if (!r.ok) {
      const errBody = await r.json().catch(() => ({}));
      const err = new Error(errBody.detail || `HTTP ${r.status}`);
      err.status = r.status;
      throw err;
    }
    return await r.json();
  }

  async pullCloudCredentialsFromContainer({ url, token, syncTicket = "", installerToken = "" } = {}) {
    const targetUrl = String(url !== undefined ? url : (this.prefs.container_url || "")).trim().replace(/\/+$/, "");
    const targetTok = String(token || this.prefs.container_api_token || "").trim();
    if (!targetTok) {
      throw new Error("Token API du conteneur requis pour déchiffrer les identifiants.");
    }
    const cleanTicket = String(syncTicket || "").trim();
    const cleanInst = String(installerToken || "").trim();
    const authProof = cleanTicket || cleanInst;

    const client = new ContainerApiClient();
    client.configure(targetUrl, targetTok);
    const headers = cleanInst ? { "X-Installer-Token": cleanInst } : {};
    const r = await client.request("/api/system/cloud-credentials/export", {
      method: "POST",
      headers,
      body: cleanTicket ? { sync_ticket: cleanTicket } : {},
    });
    if (!r.ok) {
      const errBody = await r.json().catch(() => ({}));
      const err = new Error(errBody.detail || `HTTP ${r.status}`);
      err.status = r.status;
      throw err;
    }
    const data = await r.json();
    const creds = await decryptCredEnvelope(data.envelope, targetTok, authProof);
    Object.assign(this.prefs, creds);
    await savePrefsPatch(creds);
    if (creds.weather_lat || creds.weather_lon) {
      this.weather.lastFetchTs = 0;
      this.weather.lastCoords = "";
    }
    this.agua.tokenJwt = null;
    this.agua.refreshToken = null;
    this.agua.idDevice = "";
    this.agua.idProduct = "";
    this.agua.stoveName = "";
    this.agua.workingWriteEndpoint = null;
    this._lastDirectFetchAt = 0;
    return creds;
  }

  async testConnection(extraHeaders = {}) {
    if (this.mode === "container") {
      return this._containerJson("/api/test-connection", { method: "POST", headers: extraHeaders });
    }
    if (this.mode === "demo") {
      return { status: "ok", mode: "demo", message: "Mode Démo actif" };
    }
    return await this.testCloudDirect(this.prefs);
  }

  async testWebhook(extraHeaders = {}) {
    this._requireContainer("Le test Webhook");
    return this._containerJson("/api/test-webhook", { method: "POST", headers: extraHeaders });
  }

  async downloadBackupBlob(extraHeaders = {}) {
    this._requireContainer("La sauvegarde ZIP");
    const r = await this.container.request("/api/system/backup", { method: "GET", headers: extraHeaders, timeoutMs: 60000 });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${r.status}`);
    }
    return r;
  }

  async restoreBackupFile(file, extraHeaders = {}) {
    this._requireContainer("La restauration ZIP");
    return this._containerJson("/api/system/backup/restore", {
      method: "POST",
      headers: { ...extraHeaders, "Content-Type": "application/zip" },
      body: file,
      timeoutMs: 60000,
    });
  }
}
