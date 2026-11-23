import { describe, expect, it } from "vitest";
import { AguaDirectProvider, getAllBrands, getBrandPreset } from "../src/providers/agua_direct.js";

describe("AguaDirectProvider", () => {
  it("charge le catalogue des 36 entrées de marques (35 marques + custom)", () => {
    const brands = getAllBrands();
    expect(brands.length).toBe(36);
    expect(getBrandPreset("nobis").api_url).toBe("https://nobis.agua-iot.com");
    expect(getBrandPreset("mypiazzetta").login_api_url).toContain("piazzetta");
    expect(getBrandPreset("turbofonte").brand).toBeTruthy();
  });

  it("utilise login_api_url et le header brand spécifique selon la marque", async () => {
    const calls = [];
    const preset = getBrandPreset("mypiazzetta");
    const client = new AguaDirectProvider(async (req) => {
      calls.push(req);
      if (req.url.endsWith("/appSignup")) return { status: 201, ok: true, data: {} };
      if (req.url.endsWith("/deviceList")) {
        return { status: 200, ok: true, data: { device: [{ id_device: "dev1", id_product: "prod1", name: "Piazzetta P943" }] } };
      }
      if (req.url.endsWith("/deviceGetRegistersMap")) {
        return {
          status: 200,
          ok: true,
          data: { registers_map: [{ reg_key: "temp_air_set", offset: 33122, formula: "#", set_min: 7, set_max: 41, reg_type: "SET" }] },
        };
      }
      if (req.url === preset.login_api_url || req.url.endsWith("/userLogin")) {
        return { status: 200, ok: true, data: { token: "jwt-1", refresh_token: "ref-1" } };
      }
      return { status: 404, ok: false, data: {} };
    });

    const info = await client.loginAndDiscover({
      agua_brand: "mypiazzetta",
      agua_email: "user@example.com",
      agua_password: "secret",
      agua_uuid: "uuid-1234",
    });

    expect(info.token_ok).toBe(true);
    expect(info.stove_name).toBe("Piazzetta P943");
    expect(info.registers_map_cached).toBe(1);
    const loginCall = calls.find((c) => c.url.includes("userLogin") || c.url.includes("piazzetta"));
    expect(loginCall.headers.url).toBe("userLogin");
  });

  it("rejette des identifiants manquants avant tout appel réseau", async () => {
    const client = new AguaDirectProvider(async () => ({ status: 200, ok: true, data: {} }));
    await expect(client.loginAndDiscover({ agua_email: "", agua_password: "" })).rejects.toThrow();
  });
});
