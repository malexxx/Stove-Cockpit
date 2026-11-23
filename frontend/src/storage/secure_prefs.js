// Persistance unifiée (Capacitor Preferences sur Android/iOS, localStorage sur Web).
import { Preferences } from "@capacitor/preferences";

const PREFIX = "stove_cockpit_";

const DEFAULTS = {
  app_mode: "", // "" = onboarding requis | "standalone" | "container" | "demo"
  agua_brand: "nobis",
  agua_api_url: "https://nobis.agua-iot.com",
  agua_customer_code: "700700",
  agua_brand_id: "1",
  agua_brand_header: "",
  agua_login_api_url: "",
  agua_email: "",
  agua_password: "",
  agua_uuid: "",
  agua_id_device: "",
  agua_id_product: "",
  stove_name: "",
  container_url: "",
  container_api_token: "",
  fallback_to_cloud: "1",
  poll_interval_s: "60",
  weather_city: "Paris (75000)",
  weather_lat: "48.8566",
  weather_lon: "2.3522",
  duct_left_name: "SX",
  duct_right_name: "DX",
  demo_profile: "nobis_2ducts",
  local_silence_state: "",
};

function generateUuid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function rawGet(key) {
  try {
    const { value } = await Preferences.get({ key: PREFIX + key });
    if (value !== null && value !== undefined) return value;
  } catch {
    // Fallback Web / Tests Node
  }
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem(PREFIX + key);
    }
  } catch {
    // ignore
  }
  return null;
}

async function rawSet(key, val) {
  const str = val === null || val === undefined ? "" : String(val);
  try {
    await Preferences.set({ key: PREFIX + key, value: str });
  } catch {
    // ignore
  }
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(PREFIX + key, str);
    }
  } catch {
    // ignore
  }
}

export async function loadAllPrefs() {
  const out = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    const v = await rawGet(key);
    if (v !== null && v !== undefined) {
      out[key] = v;
    }
  }
  if (!out.agua_uuid) {
    out.agua_uuid = generateUuid();
    await rawSet("agua_uuid", out.agua_uuid);
  }
  return out;
}

export async function savePrefsPatch(patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (v !== undefined) {
      await rawSet(k, v);
    }
  }
}

export async function clearAllPrefs() {
  for (const key of Object.keys(DEFAULTS)) {
    await rawSet(key, DEFAULTS[key]);
  }
}
