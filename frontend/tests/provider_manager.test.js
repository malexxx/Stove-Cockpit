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
  });
});
