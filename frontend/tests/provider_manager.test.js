import { describe, expect, it, vi } from "vitest";
import { ProviderManager } from "../src/providers/manager.js";

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
    expect(pm.getFrontendVersion()).toBe("v0.0.6");
    expect(pm.getBackendVersion()).toBe("v2.9.0");

    const res = await pm.activateSilence(2);
    expect(res.silence_mode.active).toBe(true);
    expect(reqSpy).toHaveBeenCalledWith("/api/silence/activate", expect.objectContaining({ method: "POST" }));

    pm.prefs.app_mode = "demo";
    await pm.resolveActiveMode();
    expect(pm.getBackendVersion()).toBeNull();
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
});
