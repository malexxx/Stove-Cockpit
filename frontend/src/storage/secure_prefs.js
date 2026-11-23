// Persistance unifiée (Capacitor Preferences uniquement sur natif, localStorage sur Web/PWA).
import { Capacitor } from "@capacitor/core";
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
  hopper_capacity_kg: "35",
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

function _isNativePlatform() {
  return typeof Capacitor !== "undefined" && typeof Capacitor.isNativePlatform === "function" && Capacitor.isNativePlatform();
}

/** Génère un UUID v4 cryptographiquement sûr (WebCrypto). */
function generateUuid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
  }
  return "00000000-0000-4000-8000-000000000001";
}

async function rawGet(key) {
  if (_isNativePlatform()) {
    try {
      const { value } = await Preferences.get({ key: PREFIX + key });
      if (value !== null && value !== undefined) return value;
    } catch {
      // Fallback sécurisé si plugin indisponible
    }
    return null;
  }
  try {
    const { value } = await Preferences.get({ key: PREFIX + key });
    if (value !== null && value !== undefined) return value;
  } catch {
    // Fallback Web / Vitest Node
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
  // Sur natif Android/iOS, ne pas dupliquer identifiants et jetons dans localStorage WebView
  if (_isNativePlatform()) return;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(PREFIX + key, str);
    }
  } catch {
    // ignore
  }
}

/** Charge toutes les préférences en parallèle et initialise un UUID persistant si absent. */
export async function loadAllPrefs() {
  const out = { ...DEFAULTS };
  const keys = Object.keys(DEFAULTS);
  const values = await Promise.all(keys.map((key) => rawGet(key)));
  keys.forEach((key, idx) => {
    if (values[idx] !== null && values[idx] !== undefined) {
      out[key] = values[idx];
    }
  });
  if (!out.agua_uuid) {
    out.agua_uuid = generateUuid();
    await rawSet("agua_uuid", out.agua_uuid);
  }
  return out;
}

/** Enregistre un dictionnaire partiel de préférences en parallèle. */
export async function savePrefsPatch(patch) {
  const entries = Object.entries(patch || {}).filter(([, v]) => v !== undefined);
  await Promise.all(entries.map(([k, v]) => rawSet(k, v)));
}

/** Réinitialise toutes les préférences aux valeurs par défaut. */
export async function clearAllPrefs() {
  await Promise.all(Object.keys(DEFAULTS).map((key) => rawSet(key, DEFAULTS[key])));
}
