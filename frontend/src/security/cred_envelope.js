// Chiffrement de bout en bout AES-256-GCM (WebCrypto) pour le transfert sécurisé d'identifiants Cloud.

const CRED_SYNC_AAD = new TextEncoder().encode("stove-cockpit-cred-v1");

export const SYNCABLE_CLOUD_KEYS = [
  "agua_brand",
  "agua_api_url",
  "agua_customer_code",
  "agua_brand_id",
  "agua_brand_header",
  "agua_login_api_url",
  "agua_email",
  "agua_password",
  "agua_uuid",
  "agua_id_device",
  "agua_id_product",
  "stove_name",
  "hopper_capacity_kg",
  "weather_city",
  "weather_lat",
  "weather_lon",
];

function _getSubtle() {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("WebCrypto SubtleCrypto indisponible dans cet environnement.");
  }
  return subtle;
}

function _b64urlEncode(bytes) {
  let bin = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) {
    bin += String.fromCharCode(arr[i]);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function _b64urlDecode(str) {
  const s = String(str || "").trim().replace(/-/g, "+").replace(/_/g, "/");
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

export async function deriveSyncKey(apiToken, authProof = "") {
  const subtle = _getSubtle();
  const material = `stove-cockpit-cred-sync-v1:${String(apiToken || "").trim()}:${String(authProof || "").trim()}`;
  const hash = await subtle.digest("SHA-256", new TextEncoder().encode(material));
  return subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptCredEnvelope(credentials, apiToken, authProof = "") {
  const subtle = _getSubtle();
  const cleanCreds = {};
  for (const key of SYNCABLE_CLOUD_KEYS) {
    const val = credentials?.[key];
    if (val !== undefined && val !== null && String(val) !== "") {
      cleanCreds[key] = String(val);
    }
  }
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(
    JSON.stringify({ ts: Math.floor(Date.now() / 1000), credentials: cleanCreds })
  );
  const key = await deriveSyncKey(apiToken, authProof);
  const ctBuf = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: CRED_SYNC_AAD }, key, plaintext);
  return {
    v: 1,
    iv: _b64urlEncode(iv),
    ct: _b64urlEncode(new Uint8Array(ctBuf)),
  };
}

export async function decryptCredEnvelope(envelope, apiToken, authProof = "", maxSkewS = 300) {
  const subtle = _getSubtle();
  if (!envelope || typeof envelope !== "object" || Number(envelope.v) !== 1) {
    throw new Error("Version d'enveloppe chiffrée non supportée.");
  }
  const iv = _b64urlDecode(envelope.iv);
  const ct = _b64urlDecode(envelope.ct);
  if (iv.length !== 12 || ct.length === 0) {
    throw new Error("Vecteur d'initialisation ou texte chiffré invalide.");
  }
  const key = await deriveSyncKey(apiToken, authProof);
  let plainBuf;
  try {
    plainBuf = await subtle.decrypt({ name: "AES-GCM", iv, additionalData: CRED_SYNC_AAD }, key, ct);
  } catch {
    throw new Error("Échec de déchiffrement ou d'authentification de l'enveloppe.");
  }
  const obj = JSON.parse(new TextDecoder().decode(plainBuf));
  if (!obj || typeof obj !== "object" || obj.ts === undefined || !obj.credentials || typeof obj.credentials !== "object") {
    throw new Error("Structure interne de l'enveloppe invalide.");
  }
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(obj.ts)) > maxSkewS) {
    throw new Error("Enveloppe expirée (fenêtre anti-rejeu dépassée).");
  }
  const out = {};
  for (const keyName of SYNCABLE_CLOUD_KEYS) {
    const val = obj.credentials[keyName];
    if (val !== undefined && val !== null && String(val) !== "") {
      out[keyName] = String(val);
    }
  }
  return out;
}
