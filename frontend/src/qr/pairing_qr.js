// Génération et lecture de QR Code d'appairage Conteneur <-> Application Mobile (Capacitor + Web).
import { Capacitor } from "@capacitor/core";
import { CapacitorBarcodeScanner, CapacitorBarcodeScannerTypeHint } from "@capacitor/barcode-scanner";
import jsQR from "jsqr";
import QRCode from "qrcode";

export function buildPairingQrPayload({ url, token, syncTicket = "" }) {
  const cleanUrl = String(url || "").trim().replace(/\/+$/, "");
  const cleanTok = String(token || "").trim();
  const payload = {
    type: "stove-cockpit-plus",
    version: 1,
    url: cleanUrl,
    token: cleanTok,
  };
  const cleanTicket = String(syncTicket || "").trim();
  if (cleanTicket) {
    payload.sync_ticket = cleanTicket;
  }
  return JSON.stringify(payload);
}

export function parsePairingQrPayload(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    throw new Error("QR Code vide.");
  }

  let url = "";
  let token = "";
  let syncTicket = "";

  if (text.startsWith("stovecockpit://")) {
    let parsedUri;
    try {
      parsedUri = new URL(text);
    } catch {
      throw new Error("URI d'appairage Stove Cockpit invalide.");
    }
    url = parsedUri.searchParams.get("url") || "";
    token = parsedUri.searchParams.get("token") || "";
    syncTicket = parsedUri.searchParams.get("sync_ticket") || "";
  } else {
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      throw new Error("Format de QR Code non reconnu (JSON attendu).");
    }
    if (!obj || obj.type !== "stove-cockpit-plus") {
      throw new Error("Ce QR Code ne correspond pas à un serveur Stove Cockpit.");
    }
    url = obj.url || "";
    token = obj.token || "";
    syncTicket = obj.sync_ticket || "";
  }

  const cleanUrl = String(url).trim().replace(/\/+$/, "");
  if (!/^https?:\/\/.+/i.test(cleanUrl)) {
    throw new Error("URL HTTP/HTTPS du conteneur absente ou invalide dans le QR Code.");
  }
  const cleanTok = String(token).trim();
  if (!cleanTok) {
    throw new Error("Token API absent du QR Code.");
  }

  return {
    url: cleanUrl,
    token: cleanTok,
    syncTicket: String(syncTicket || "").trim(),
  };
}

export async function renderQrSvg(text) {
  return await QRCode.toString(String(text || ""), {
    type: "svg",
    margin: 1,
    width: 196,
    color: { dark: "#0f172a", light: "#ffffff" },
  });
}

export function decodeQrFromRgba(rgbaData, width, height) {
  if (!rgbaData || !width || !height) return null;
  const code = jsQR(rgbaData, width, height, { inversionAttempts: "dontInvert" });
  return code?.data || null;
}

export function isNativeQrScannerAvailable() {
  return Boolean(typeof Capacitor !== "undefined" && typeof Capacitor.isNativePlatform === "function" && Capacitor.isNativePlatform());
}

export async function scanNativeQr() {
  const res = await CapacitorBarcodeScanner.scanBarcode({
    hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
    scanInstructions: "Scannez le QR Code affiché sur votre conteneur Stove Cockpit",
  });
  return String(res?.ScanResult || "").trim();
}
