import { describe, expect, it, vi } from "vitest";
import { buildPairingQrPayload, parsePairingQrPayload, renderQrSvg } from "../src/qr/pairing_qr.js";
import { decryptCredEnvelope, encryptCredEnvelope } from "../src/security/cred_envelope.js";
import { ProviderManager } from "../src/providers/manager.js";
import { ContainerApiClient } from "../src/providers/container_api.js";

describe("QR Code Appairage & Chiffrement AES-256-GCM des identifiants Cloud", () => {
  it("génère, parse et rend en SVG le payload QR d'appairage", async () => {
    const raw = buildPairingQrPayload({
      url: "http://192.168.1.50:8080/",
      token: "tok-abc-123",
      syncTicket: "ticket-xyz",
    });
    const parsed = parsePairingQrPayload(raw);
    expect(parsed).toEqual({
      url: "http://192.168.1.50:8080",
      token: "tok-abc-123",
      syncTicket: "ticket-xyz",
    });

    const uriParsed = parsePairingQrPayload("stovecockpit://pair?url=http://192.168.1.50:8080&token=tok-uri");
    expect(uriParsed).toEqual({
      url: "http://192.168.1.50:8080",
      token: "tok-uri",
      syncTicket: "",
    });

    expect(() => parsePairingQrPayload('{"type":"autre","url":"http://x","token":"t"}')).toThrow();
    expect(() => parsePairingQrPayload("not-json")).toThrow();

    const svg = await renderQrSvg(raw);
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
  });

  it("chiffre et déchiffre une enveloppe AES-256-GCM et rejette clé fausse, altération ou expiration", async () => {
    const creds = {
      agua_brand: "nobis",
      agua_email: "user@example.com",
      agua_password: "SuperSecretPassword!",
      weather_city: "Lyon (69000)",
    };
    const env = await encryptCredEnvelope(creds, "api-token-1", "proof-1");
    expect(env.v).toBe(1);
    expect(JSON.stringify(env)).not.toContain("SuperSecretPassword!");
    expect(JSON.stringify(env)).not.toContain("user@example.com");

    const dec = await decryptCredEnvelope(env, "api-token-1", "proof-1");
    expect(dec).toEqual(creds);

    await expect(decryptCredEnvelope(env, "wrong-token", "proof-1")).rejects.toThrow();
    await expect(decryptCredEnvelope(env, "api-token-1", "wrong-proof")).rejects.toThrow();

    const tampered = { ...env, ct: env.ct.slice(0, -2) + "AA" };
    await expect(decryptCredEnvelope(tampered, "api-token-1", "proof-1")).rejects.toThrow();

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 305 * 1000);
    await expect(decryptCredEnvelope(env, "api-token-1", "proof-1", 300)).rejects.toThrow(/expirée/);
    nowSpy.mockRestore();
  });

  it("envoie et récupère les identifiants Cloud via ProviderManager sans jamais exposer de mot de passe en clair", async () => {
    const pm = new ProviderManager();
    pm.prefs = {
      app_mode: "standalone",
      agua_brand: "nobis",
      agua_email: "alice@example.com",
      agua_password: "SecretCloudPassword",
      container_url: "http://192.168.1.42:8080",
      container_api_token: "container-secret-tok",
    };

    let capturedBody = null;
    const reqSpy = vi.spyOn(ContainerApiClient.prototype, "request").mockImplementation(async (path, opts) => {
      if (path === "/api/system/cloud-credentials/import") {
        capturedBody = opts.body;
        return { ok: true, status: 200, json: async () => ({ status: "ok", comm_mode: "agua_cloud" }) };
      }
      if (path === "/api/system/cloud-credentials/export") {
        const outEnv = await encryptCredEnvelope(
          {
            agua_brand: "mypiazzetta",
            agua_email: "bob@example.com",
            agua_password: "PulledSecretPassword",
          },
          "container-secret-tok",
          opts.body.sync_ticket
        );
        return { ok: true, status: 200, json: async () => ({ status: "ok", envelope: outEnv }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const pushRes = await pm.pushCloudCredentialsToContainer({
      url: "http://192.168.1.42:8080",
      token: "container-secret-tok",
      syncTicket: "ticket-push-1",
    });
    expect(pushRes.status).toBe("ok");
    expect(capturedBody.envelope.v).toBe(1);
    expect(JSON.stringify(capturedBody)).not.toContain("SecretCloudPassword");
    expect(JSON.stringify(capturedBody)).not.toContain("alice@example.com");

    const pulled = await pm.pullCloudCredentialsFromContainer({
      url: "http://192.168.1.42:8080",
      token: "container-secret-tok",
      syncTicket: "ticket-pull-1",
    });
    expect(pulled.agua_brand).toBe("mypiazzetta");
    expect(pulled.agua_email).toBe("bob@example.com");
    expect(pulled.agua_password).toBe("PulledSecretPassword");
    expect(pm.prefs.agua_email).toBe("bob@example.com");
    expect(pm.prefs.agua_password).toBe("PulledSecretPassword");

    reqSpy.mockRestore();
  });

  it("synchronise la station météo seule par enveloppe chiffrée sans exiger d'identifiants Cloud", async () => {
    const pm = new ProviderManager();
    pm.prefs = {
      app_mode: "standalone",
      weather_city: "Grenoble (38000)",
      weather_lat: "45.1885",
      weather_lon: "5.7245",
      container_url: "http://192.168.1.42:8080",
      container_api_token: "container-secret-tok",
    };

    let capturedBody = null;
    const reqSpy = vi.spyOn(ContainerApiClient.prototype, "request").mockImplementation(async (path, opts) => {
      if (path === "/api/system/cloud-credentials/import") {
        capturedBody = opts.body;
        return { ok: true, status: 200, json: async () => ({ status: "ok", comm_mode: "local_gateway" }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const res = await pm.pushCloudCredentialsToContainer();
    expect(res.status).toBe("ok");
    expect(capturedBody.activate_cloud_mode).toBe(false);
    const decoded = await decryptCredEnvelope(capturedBody.envelope, "container-secret-tok", "");
    expect(decoded.weather_city).toBe("Grenoble (38000)");
    expect(decoded.weather_lat).toBe("45.1885");
    expect(decoded.weather_lon).toBe("5.7245");

    reqSpy.mockRestore();
  });

  it("synchronise automatiquement la météo à la connexion au conteneur (push si conteneur par défaut, sinon miroir local)", async () => {
    // Cas 1 : l'app a Bordeaux, le conteneur est sur Paris par défaut -> push vers le conteneur
    const pmPush = new ProviderManager();
    pmPush.prefs = {
      app_mode: "container",
      weather_city: "Bordeaux (33000)",
      weather_lat: "44.8378",
      weather_lon: "-0.5792",
      container_url: "http://192.168.1.42:8080",
      container_api_token: "tok-1",
    };
    let pushedWeather = null;
    const spyPush = vi.spyOn(ContainerApiClient.prototype, "request").mockImplementation(async (path, opts) => {
      if (path.startsWith("/api/dashboard")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            settings: { weather_city: "Paris (75000)", weather_lat: "48.8566", weather_lon: "2.3522" },
          }),
        };
      }
      if (path === "/api/settings" && opts.method === "POST") {
        pushedWeather = opts.body;
        return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    await pmPush.syncWeatherOnContainerConnect();
    expect(pushedWeather).toEqual({
      weather_city: "Bordeaux (33000)",
      weather_lat: "44.8378",
      weather_lon: "-0.5792",
    });
    spyPush.mockRestore();

    // Cas 2 : le conteneur a Marseille -> miroir vers prefs locales et invalidation du cache météo
    const pmPull = new ProviderManager();
    pmPull.prefs = {
      app_mode: "container",
      weather_city: "Paris (75000)",
      weather_lat: "48.8566",
      weather_lon: "2.3522",
      container_url: "http://192.168.1.42:8080",
      container_api_token: "tok-1",
    };
    pmPull.weather.lastFetchTs = 123456;
    pmPull.weather.lastCoords = "48.8566,2.3522";
    const spyPull = vi.spyOn(ContainerApiClient.prototype, "request").mockImplementation(async (path) => {
      if (path.startsWith("/api/dashboard")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            settings: { weather_city: "Marseille (13000)", weather_lat: "43.2965", weather_lon: "5.3698" },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    await pmPull.syncWeatherOnContainerConnect();
    expect(pmPull.prefs.weather_city).toBe("Marseille (13000)");
    expect(pmPull.prefs.weather_lat).toBe("43.2965");
    expect(pmPull.prefs.weather_lon).toBe("5.3698");
    expect(pmPull.weather.lastFetchTs).toBe(0);
    expect(pmPull.weather.lastCoords).toBe("");
    spyPull.mockRestore();
  });
});
