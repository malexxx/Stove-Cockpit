import { describe, expect, it, vi } from "vitest";
import { ProviderManager } from "../src/providers/manager.js";
import { decryptCredEnvelope, encryptCredEnvelope } from "../src/security/cred_envelope.js";

describe("ProviderManager", () => {
  it("passe en mode demo et pilote le poêle virtuel sans réseau", async () => {
    const pm = new ProviderManager();
    pm.prefs = { app_mode: "demo", demo_profile: "hydro", agua_uuid: "u-demo" };
    pm.demo.setProfile("hydro");
    await pm.resolveActiveMode();

    expect(pm.getMode()).toBe("demo");
    expect(pm.isContainerActive()).toBe(false);

    const dash = await pm.loadDashboard("24h");
    expect(dash.capabilities.stove_type).toBe("hydro");
    expect(dash.capabilities.ducts).toEqual([]);

    await pm.sendCommand("temp_amb_setpoint", 62);
    const latest = await pm.getLatest();
    expect(latest.latest.temp_amb_setpoint).toBe(62);
  });

  it("bascule automatiquement en mode fallback quand le conteneur est injoignable hors LAN", async () => {
    const pm = new ProviderManager();
    pm.prefs = {
      app_mode: "container",
      container_url: "http://192.168.1.99:8080",
      fallback_to_cloud: "1",
      agua_email: "user@example.com",
      agua_password: "secret",
    };
    vi.spyOn(pm.container, "pingHealth").mockResolvedValue({ ok: false, error: "timeout" });

    const mode = await pm.resolveActiveMode();
    expect(mode).toBe("fallback");
    expect(pm.isContainerActive()).toBe(false);
  });

  it("active le mode container lorsque /health répond healthy", async () => {
    const pm = new ProviderManager();
    pm.prefs = {
      app_mode: "container",
      container_url: "http://192.168.1.50:8080",
      container_api_token: "tok-123",
    };
    vi.spyOn(pm.container, "pingHealth").mockResolvedValue({ ok: true, data: { status: "healthy" } });

    const mode = await pm.resolveActiveMode();
    expect(mode).toBe("container");
    expect(pm.isContainerActive()).toBe(true);
  });

  it("bloque les actions exclusives conteneur lorsque Mode + est inactif", async () => {
    const pm = new ProviderManager();
    pm.prefs = { app_mode: "standalone" };
    await pm.resolveActiveMode();
    await expect(pm.refillHopper({ target_pct: 100 })).rejects.toThrow(/Mode « \+ »/);
    await expect(pm.activateSilence(2)).rejects.toThrow(/Mode « \+ »/);
    await expect(pm.deactivateSilence()).rejects.toThrow(/Mode « \+ »/);
  });

  it("gère le mode Silence uniquement côté conteneur et dissocie versions Frontend / Backend", async () => {
    const pm = new ProviderManager();
    pm.prefs = { app_mode: "container", container_url: "http://192.168.1.50:8080" };
    vi.spyOn(pm.container, "pingHealth").mockResolvedValue({
      ok: true,
      data: { status: "healthy", version: "2.9.0", backend_version: "2.9.0", docker_version: "v2.9.0" },
    });
    const reqSpy = vi.spyOn(pm.container, "request").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "ok", silence_mode: { active: true, duration_hours: 2 } }),
    });

    await pm.resolveActiveMode();
    expect(pm.getFrontendVersion()).toBe("v0.0.9");
    expect(pm.getBackendVersion()).toBe("v2.9.0");
    expect(pm.getAppVersion()).toBe("v2.9.0");

    const res = await pm.activateSilence(2);
    expect(res.silence_mode.active).toBe(true);
    expect(reqSpy).toHaveBeenCalledWith("/api/silence/activate", expect.objectContaining({ method: "POST" }));

    pm.prefs.app_mode = "demo";
    await pm.resolveActiveMode();
    expect(pm.getBackendVersion()).toBeNull();
    expect(pm.getAppVersion()).toBe("v0.0.9");
  });

  it("synchronise automatiquement Cloud & Météo de manière bidirectionnelle (téléphone <-> conteneur)", async () => {
    const tok = "tok-bidir-secret";
    // 1. Téléphone configuré, conteneur vierge -> pousse Cloud + Météo vers conteneur
    const pmPush = new ProviderManager();
    pmPush.prefs = {
      app_mode: "container",
      container_url: "http://192.168.1.50:8080",
      container_api_token: tok,
      agua_brand: "nobis",
      agua_email: "phone@example.com",
      agua_password: "phone-password",
      weather_city: "Lyon",
      weather_lat: "45.7640",
      weather_lon: "4.8357",
    };
    pmPush.container.configure(pmPush.prefs.container_url, tok);
    let pushedBody = null;
    const reqPush = vi.spyOn(pmPush.container, "request").mockImplementation(async (path, opts) => {
      if (path === "/api/latest") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            settings: { agua_email: "", agua_password: "", weather_city: "Paris (75000)", weather_lat: "48.8566", weather_lon: "2.3522" },
          }),
        };
      }
      if (path === "/api/system/cloud-credentials/import") {
        pushedBody = opts.body;
        return { ok: true, status: 200, json: async () => ({ status: "ok", comm_mode: "agua_cloud" }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });
    const res1 = await pmPush.syncCloudAndWeatherBidirectional();
    expect(res1).toEqual({ pushedCloud: true, pushedWeather: true, pulledCloud: false, pulledWeather: false });
    const imported = await decryptCredEnvelope(pushedBody.envelope, tok, "");
    expect(imported.agua_email).toBe("phone@example.com");
    expect(imported.agua_password).toBe("phone-password");
    expect(imported.weather_city).toBe("Lyon");
    reqPush.mockRestore();

    // 2. Conteneur configuré, téléphone vierge -> récupère Cloud + Météo vers téléphone
    const pmPull = new ProviderManager();
    pmPull.prefs = {
      app_mode: "container",
      container_url: "http://192.168.1.50:8080",
      container_api_token: tok,
      weather_city: "Paris (75000)",
      weather_lat: "48.8566",
      weather_lon: "2.3522",
    };
    pmPull.container.configure(pmPull.prefs.container_url, tok);
    const exportEnvelope = await encryptCredEnvelope({
      agua_brand: "piazzetta",
      agua_email: "docker@example.com",
      agua_password: "docker-password",
      weather_city: "Annecy",
      weather_lat: "45.8992",
      weather_lon: "6.1294",
    }, tok, "");
    const reqPull = vi.spyOn(pmPull.container, "request").mockImplementation(async (path) => {
      if (path === "/api/latest") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            settings: {
              agua_email: "docker@example.com",
              agua_password: "********",
              weather_city: "Annecy",
              weather_lat: "45.8992",
              weather_lon: "6.1294",
            },
          }),
        };
      }
      if (path === "/api/system/cloud-credentials/export") {
        return { ok: true, status: 200, json: async () => ({ status: "ok", envelope: exportEnvelope }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });
    const res2 = await pmPull.syncCloudAndWeatherBidirectional();
    expect(res2).toEqual({ pushedCloud: false, pushedWeather: false, pulledCloud: true, pulledWeather: true });
    expect(pmPull.prefs.agua_email).toBe("docker@example.com");
    expect(pmPull.prefs.agua_password).toBe("docker-password");
    expect(pmPull.prefs.weather_city).toBe("Annecy");
    reqPull.mockRestore();

    // 3. Cas mixte : Téléphone a la météo (Grenoble), Conteneur a le Cloud -> transfert croisé sans écraser
    const pmMixed = new ProviderManager();
    pmMixed.prefs = {
      app_mode: "container",
      container_url: "http://192.168.1.50:8080",
      container_api_token: tok,
      weather_city: "Grenoble",
      weather_lat: "45.1885",
      weather_lon: "5.7245",
    };
    pmMixed.container.configure(pmMixed.prefs.container_url, tok);
    let mixedPush = null;
    const reqMixed = vi.spyOn(pmMixed.container, "request").mockImplementation(async (path, opts) => {
      if (path === "/api/latest") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            settings: {
              agua_email: "docker@example.com",
              agua_password: "********",
              weather_city: "Paris (75000)",
              weather_lat: "48.8566",
              weather_lon: "2.3522",
            },
          }),
        };
      }
      if (path === "/api/system/cloud-credentials/import") {
        mixedPush = opts.body;
        return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
      }
      if (path === "/api/system/cloud-credentials/export") {
        return { ok: true, status: 200, json: async () => ({ status: "ok", envelope: exportEnvelope }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });
    const res3 = await pmMixed.syncCloudAndWeatherBidirectional();
    expect(res3).toEqual({ pushedCloud: false, pushedWeather: true, pulledCloud: true, pulledWeather: false });
    const mixedImported = await decryptCredEnvelope(mixedPush.envelope, tok, "");
    expect(mixedImported.weather_city).toBe("Grenoble");
    expect(pmMixed.prefs.agua_email).toBe("docker@example.com");
    expect(pmMixed.prefs.weather_city).toBe("Grenoble"); // Préservée
    reqMixed.mockRestore();
  });

  it("ne contacte jamais le Cloud directement depuis le smartphone lorsque le conteneur est disponible", async () => {
    const pm = new ProviderManager();
    pm.prefs = {
      app_mode: "container",
      container_url: "http://192.168.1.50:8080",
      container_api_token: "tok-123",
      fallback_to_cloud: "1",
      agua_email: "user@example.com",
      agua_password: "secret",
    };
    pm.container.configure(pm.prefs.container_url, pm.prefs.container_api_token);

    // Simule un smartphone provisoirement en fallback puis retour sur LAN (conteneur joignable)
    pm.mode = "fallback";
    const pingSpy = vi.spyOn(pm.container, "pingHealth").mockResolvedValue({ ok: true, data: { status: "healthy", version: "0.0.9" } });
    const reqSpy = vi.spyOn(pm.container, "request").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ latest: { status_code: 5, temp_ambient: 20 }, settings: {} }),
    });
    const aguaReadSpy = vi.spyOn(pm.agua, "readBuffer");
    const aguaWriteSpy = vi.spyOn(pm.agua, "writeRegistersBatch");
    const aguaLoginSpy = vi.spyOn(pm.agua, "loginAndDiscover");
    const weatherSpy = vi.spyOn(pm.weather, "fetchCurrent");

    await pm.getLatest();
    await pm.sendCommandBatch([{ reg_key: "temp_amb_setpoint", value: 21 }]);
    await pm.testConnection();

    expect(pm.getMode()).toBe("container");
    expect(pingSpy).toHaveBeenCalled();
    expect(reqSpy).toHaveBeenCalledWith("/api/latest");
    expect(reqSpy).toHaveBeenCalledWith("/api/command", expect.objectContaining({ method: "POST" }));
    expect(reqSpy).toHaveBeenCalledWith("/api/test-connection", expect.objectContaining({ method: "POST" }));
    expect(aguaReadSpy).not.toHaveBeenCalled();
    expect(aguaWriteSpy).not.toHaveBeenCalled();
    expect(aguaLoginSpy).not.toHaveBeenCalled();
    expect(weatherSpy).not.toHaveBeenCalled();
  });

  it("bascule sur la géolocalisation IP en contexte HTTP non sécurisé ou sans GPS", async () => {
    const pm = new ProviderManager();
    pm.mode = "standalone";
    const ipSpy = vi.spyOn(pm.weather, "geolocateByIp").mockResolvedValue({
      lat: 48.8566,
      lon: 2.3522,
      city: "Paris",
      source: "ip",
    });

    const pos = await pm.getCurrentPosition();
    expect(ipSpy).toHaveBeenCalledTimes(1);
    expect(pos).toEqual({ lat: 48.8566, lon: 2.3522, city: "Paris", source: "ip" });
  });

  it("normalise l'URL conteneur sans schéma http:// et bascule standalone -> container via saveSettings", async () => {
    const pm = new ProviderManager();
    pm.prefs = { app_mode: "standalone" };
    await pm.resolveActiveMode();
    expect(pm.isContainerActive()).toBe(false);

    const pingSpy = vi.spyOn(pm.container, "pingHealth").mockResolvedValue({
      ok: true,
      data: { status: "healthy", version: "0.0.9" },
    });

    const res = await pm.saveSettings({
      app_mode: "container",
      container_url: "192.168.1.50:8080/",
      container_api_token: "tok-mob",
    });

    expect(pm.container.baseUrl).toBe("http://192.168.1.50:8080");
    expect(res.mode).toBe("container");
    expect(pm.isContainerActive()).toBe(true);
    pingSpy.mockRestore();
  });
});
