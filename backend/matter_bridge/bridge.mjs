// Pont thermostat Matter local (Google Home / Apple Maison / Home Assistant) pour Stove Cockpit.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ServerNode, Environment } from "@matter/main";
import { ThermostatDevice } from "@matter/main/devices";
import { ThermostatServer, IdentifyServer } from "@matter/main/behaviors";
import { Thermostat } from "@matter/main/clusters";
import QRCode from "qrcode";

// =============================================================================
// CONFIGURATION DU PONT MATTER LOCAL (GOOGLE HOME / NEST HUB MAX / APPLE HOME)
// =============================================================================
const NOBIS_API_URL = (process.env.NOBIS_API_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
const WEBHOOK_SECRET = (process.env.MATTER_WEBHOOK_SECRET || "").trim();
const MATTER_PORT = parseInt(process.env.MATTER_PORT || "5540", 10);
const CONTROL_PORT = parseInt(process.env.MATTER_CONTROL_PORT || "5549", 10);
const STORAGE_DIR = process.env.MATTER_STORAGE_DIR || path.resolve(process.cwd(), "../../data/matter_storage");
const DEVICE_NAME = process.env.MATTER_DEVICE_NAME || "Poêle à granulés";
const PASSCODE = parseInt(process.env.MATTER_PASSCODE || "20202021", 10);
const DISCRIMINATOR = parseInt(process.env.MATTER_DISCRIMINATOR || "3840", 10);
const MAX_SYNC_BODY_BYTES = 64 * 1024;

fs.mkdirSync(STORAGE_DIR, { recursive: true });

const env = Environment.default;
env.vars.set("storage.path", STORAGE_DIR);

// État interne synchronisé avec Nobis_App
let isInternalSync = false;
let setpointDebounceTimer = null;
let bridgeReady = false;
let lastError = null;
let lastSyncIso = null;
let lastMatterCommand = null;
let cachedQrSvg = "";
let cachedQrString = "";

let liveState = {
  localTemperatureC: 20.0,
  setpointC: 19.0,
  systemMode: "Heat", // "Heat" | "Off"
  statusCode: 5,
};

function clampSetpointC(val) {
  const n = Number(val);
  if (Number.isNaN(n)) return 19;
  // Si le poêle est en mode MAN (41), on plafonne à 40°C côté thermostat Matter
  return Math.max(7, Math.min(40, Math.round(n)));
}

function clampAmbientC(val) {
  const n = Number(val);
  if (Number.isNaN(n)) return 20.0;
  return Math.max(-10, Math.min(60, Math.round(n * 10) / 10));
}

function isStoveHeatingFromTelemetry(statusCode, statusManaged) {
  const sc = Number(statusCode ?? 0);
  // États actifs Nobis : 1(Attente), 2(Préchauffage), 3(Chargement), 4(Allumage), 5(Travail), 6(Nettoyage), 8(Eco Stop / Stand-by), 9(Stand-by)
  if ([1, 2, 3, 4, 5, 6, 8, 9].includes(sc)) {
    return true;
  }
  if (sc === 0 || sc === 7 || sc === 10 || sc === 11) {
    return false;
  }
  return Number(statusManaged ?? 85) === 85;
}

function formatManualCode(raw) {
  const s = String(raw || "").replace(/\D/g, "");
  if (s.length === 11) {
    return `${s.slice(0, 4)}-${s.slice(4, 7)}-${s.slice(7, 11)}`;
  }
  return s;
}

// =============================================================================
// CLUSTERS PERSONNALISÉS (THERMOSTAT CHAUFFAGE + IDENTIFY SANS WARNING)
// =============================================================================
class NobisThermostatServer extends ThermostatServer.with(Thermostat.Feature.Heating) {
  setpointRaiseLower({ mode, amount }) {
    // amount est exprimé en 0.1°C dans la spécification Matter, occupiedHeatingSetpoint en 0.01°C
    const current = this.state.occupiedHeatingSetpoint ?? 1900;
    const delta = Number(amount || 0) * 10;
    const next = Math.max(700, Math.min(4000, Math.round((current + delta) / 100) * 100));
    this.state.occupiedHeatingSetpoint = next;
  }
}

class QuietIdentifyServer extends IdentifyServer {
  triggerEffect() {
    // No-op visuel sur le poêle
  }
}

const HeatingThermostatDevice = ThermostatDevice.with(NobisThermostatServer, QuietIdentifyServer);

// =============================================================================
// COMMUNICATION AVEC LE BACKEND PYTHON FASTAPI (STOVE COCKPIT — HTTP PUR)
// =============================================================================
/**
 * Exécute une requête HTTP locale vers le backend FastAPI Stove Cockpit.
 * @param {string} apiPath Chemin API relatif (ex: "/api/matter/webhook").
 * @param {{method?: string, headers?: Record<string, string>, body?: any, timeoutMs?: number}} [opts]
 * @returns {Promise<{status: number, ok: boolean, text: string}>}
 */
function nobisApiRequest(apiPath, { method = "GET", headers = {}, body = null, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const targetUrl = new URL(`${NOBIS_API_URL}${apiPath}`);
    const bodyStr = body !== null && body !== undefined ? JSON.stringify(body) : null;
    const reqHeaders = { ...headers };
    if (bodyStr !== null) {
      reqHeaders["Content-Type"] = "application/json";
      reqHeaders["Content-Length"] = Buffer.byteLength(bodyStr, "utf8");
    }

    const reqOpts = {
      protocol: "http:",
      hostname: targetUrl.hostname,
      port: targetUrl.port || 80,
      path: `${targetUrl.pathname}${targetUrl.search}`,
      method,
      headers: reqHeaders,
      timeout: timeoutMs,
    };

    let settled = false;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(val);
    };

    const req = http.request(reqOpts, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        finish(null, { status: res.statusCode || 0, ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300, text: raw });
      });
    });

    req.on("timeout", () => {
      req.destroy(new Error(`Timeout API Stove Cockpit (${timeoutMs}ms)`));
    });
    req.on("error", (err) => finish(err));

    if (bodyStr !== null) req.write(bodyStr);
    req.end();
  });
}

async function fetchInitialStoveState() {
  try {
    const res = await nobisApiRequest("/api/latest", { method: "GET", timeoutMs: 3500 });
    if (!res.ok) return;
    const data = JSON.parse(res.text || "{}");
    const latest = data?.latest || {};
    if (latest.temp_ambient !== undefined) {
      liveState.localTemperatureC = clampAmbientC(latest.temp_ambient);
    }
    if (latest.temp_amb_setpoint !== undefined) {
      liveState.setpointC = clampSetpointC(latest.temp_amb_setpoint);
    }
    const isOn = isStoveHeatingFromTelemetry(latest.status_code, latest.status_managed);
    liveState.systemMode = isOn ? "Heat" : "Off";
    liveState.statusCode = Number(latest.status_code ?? 0);
    lastSyncIso = new Date().toISOString();
  } catch {
    // Le serveur FastAPI peut être encore en phase de démarrage
  }
}

async function notifyNobisBackend(payload) {
  try {
    const headers = WEBHOOK_SECRET ? { "X-Matter-Secret": WEBHOOK_SECRET } : {};
    const res = await nobisApiRequest("/api/matter/webhook", {
      method: "POST",
      headers,
      body: payload,
      timeoutMs: 10000,
    });
    if (!res.ok) {
      console.error("[MatterBridge] Erreur webhook Nobis:", res.status, res.text);
    }
  } catch (err) {
    console.error("[MatterBridge] Échec appel webhook Nobis:", err?.message || err);
  }
}

// =============================================================================
// DÉMARRAGE DU NOEUD MATTER & DU SERVEUR DE CONTRÔLE LOCAL
// =============================================================================
let serverNode = null;
let thermostatEndpoint = null;

async function startMatterNode() {
  await fetchInitialStoveState();

  serverNode = await ServerNode.create({
    id: "nobis-a10-matter",
    network: {
      port: MATTER_PORT,
    },
    commissioning: {
      passcode: PASSCODE,
      discriminator: DISCRIMINATOR,
    },
    productDescription: {
      name: DEVICE_NAME,
      deviceType: HeatingThermostatDevice.deviceType,
    },
    basicInformation: {
      vendorName: "Stove Cockpit (Micronova)",
      vendorId: 0xfff1,
      nodeLabel: DEVICE_NAME,
      productName: DEVICE_NAME,
      productLabel: DEVICE_NAME,
      productId: 0x8001,
      serialNumber: "STOVE-COCKPIT-01",
      uniqueId: "stove-cockpit-matter-thermostat",
      hardwareVersion: 1,
      softwareVersion: 1,
    },
  });

  thermostatEndpoint = await serverNode.add(HeatingThermostatDevice, {
    id: "thermostat",
    thermostat: {
      localTemperature: Math.round(liveState.localTemperatureC * 100),
      occupiedHeatingSetpoint: Math.round(liveState.setpointC * 100),
      minHeatSetpointLimit: 700,
      maxHeatSetpointLimit: 4000,
      absMinHeatSetpointLimit: 700,
      absMaxHeatSetpointLimit: 4000,
      controlSequenceOfOperation: Thermostat.ControlSequenceOfOperation.HeatingOnly,
      systemMode:
        liveState.systemMode === "Heat"
          ? Thermostat.SystemMode.Heat
          : Thermostat.SystemMode.Off,
    },
  });

  // 1. Écoute des changements de mode (Allumage / Extinction depuis Google Home / Nest Hub Max)
  thermostatEndpoint.events.thermostat.systemMode$Changed.on(async (newVal, oldVal) => {
    if (isInternalSync || newVal === oldVal) return;

    const targetOn = newVal === Thermostat.SystemMode.Heat || newVal === Thermostat.SystemMode.Auto;
    liveState.systemMode = targetOn ? "Heat" : "Off";
    lastMatterCommand = {
      type: "systemMode",
      value: liveState.systemMode,
      timestamp: new Date().toISOString(),
    };
    console.log(`[MatterBridge] Commande Google Home/Matter reçue -> Mode: ${liveState.systemMode}`);
    await notifyNobisBackend({
      action: "set_power",
      state: targetOn ? "ON" : "OFF",
    });
  });

  // 2. Écoute des changements de température de consigne (avec anti-rebond 600ms pour la molette Nest Hub Max)
  thermostatEndpoint.events.thermostat.occupiedHeatingSetpoint$Changed.on((newVal, oldVal) => {
    if (isInternalSync || newVal === oldVal) return;

    const targetDegC = clampSetpointC(Math.round(Number(newVal) / 100));
    liveState.setpointC = targetDegC;

    if (setpointDebounceTimer) {
      clearTimeout(setpointDebounceTimer);
    }
    setpointDebounceTimer = setTimeout(async () => {
      lastMatterCommand = {
        type: "setpoint",
        value: targetDegC,
        timestamp: new Date().toISOString(),
      };
      console.log(`[MatterBridge] Commande Google Home/Matter reçue -> Consigne: ${targetDegC} °C`);
      await notifyNobisBackend({
        action: "set_temperature",
        temperature: targetDegC,
      });
    }, 600);
  });

  // Pré-génération du QR Code SVG d'appairage Matter
  const qrStr = serverNode.state?.commissioning?.pairingCodes?.qrPairingCode || "";
  if (qrStr) {
    cachedQrString = qrStr;
    cachedQrSvg = await QRCode.toString(qrStr, {
      type: "svg",
      margin: 1,
      width: 220,
      color: {
        dark: "#0f172a",
        light: "#ffffff",
      },
    });
  }

  bridgeReady = true;
  console.log(
    `[MatterBridge] Noeud Matter '${DEVICE_NAME}' prêt sur UDP:${MATTER_PORT} | Code: ${formatManualCode(
      serverNode.state?.commissioning?.pairingCodes?.manualPairingCode
    )}`
  );

  // Démarrage de l'annonce mDNS et du serveur Matter
  serverNode.start().catch((err) => {
    lastError = String(err?.message || err);
    console.error("[MatterBridge] Erreur exécution ServerNode:", err);
  });
}

async function applySyncFromNobis(body) {
  if (!thermostatEndpoint || !bridgeReady) return;

  const updates = {};
  if (body.temp_ambient !== undefined && body.temp_ambient !== null) {
    const amb = clampAmbientC(body.temp_ambient);
    liveState.localTemperatureC = amb;
    updates.localTemperature = Math.round(amb * 100);
  }
  if (body.temp_amb_setpoint !== undefined && body.temp_amb_setpoint !== null) {
    const sp = clampSetpointC(body.temp_amb_setpoint);
    liveState.setpointC = sp;
    updates.occupiedHeatingSetpoint = Math.round(sp * 100);
  }
  if (body.status_code !== undefined || body.status_managed !== undefined) {
    const isOn = isStoveHeatingFromTelemetry(body.status_code, body.status_managed);
    liveState.systemMode = isOn ? "Heat" : "Off";
    liveState.statusCode = Number(body.status_code ?? liveState.statusCode);
    updates.systemMode = isOn ? Thermostat.SystemMode.Heat : Thermostat.SystemMode.Off;
  }

  if (Object.keys(updates).length > 0) {
    isInternalSync = true;
    try {
      await thermostatEndpoint.set({ thermostat: updates });
      lastSyncIso = new Date().toISOString();
    } finally {
      isInternalSync = false;
    }
  }
}

async function getBridgeStatusPayload() {
  const comm = serverNode?.state?.commissioning || {};
  const pairingCodes = comm.pairingCodes || {};
  const qrStr = pairingCodes.qrPairingCode || cachedQrString || "";
  if (qrStr && qrStr !== cachedQrString) {
    cachedQrString = qrStr;
    try {
      cachedQrSvg = await QRCode.toString(qrStr, {
        type: "svg",
        margin: 1,
        width: 220,
        color: { dark: "#0f172a", light: "#ffffff" },
      });
    } catch {
      // ignore
    }
  }

  const fabricsObj = comm.fabrics || {};
  const fabricsList = Object.values(fabricsObj).map((f) => ({
    fabricIndex: f.fabricIndex,
    fabricId: String(f.fabricId ?? ""),
    nodeId: String(f.nodeId ?? ""),
    rootVendorId: f.rootVendorId,
    label: f.label || (f.rootVendorId === 0x6006 || f.rootVendorId === 24582 ? "Google Home" : `Fabric #${f.fabricIndex}`),
  }));

  const manualRaw = pairingCodes.manualPairingCode || "";
  return {
    running: bridgeReady,
    error: lastError,
    deviceName: DEVICE_NAME,
    matterPort: MATTER_PORT,
    commissioned: Boolean(comm.commissioned) || fabricsList.length > 0,
    fabricsCount: fabricsList.length,
    fabrics: fabricsList,
    passcode: comm.passcode || PASSCODE,
    discriminator: comm.discriminator ?? DISCRIMINATOR,
    manualPairingCode: manualRaw,
    manualPairingCodeFormatted: formatManualCode(manualRaw),
    qrPairingCode: qrStr,
    qrSvg: cachedQrSvg,
    liveState,
    lastSyncIso,
    lastMatterCommand,
  };
}

// =============================================================================
// SERVEUR HTTP INTERNE (127.0.0.1:5549) POUR DIALOGUER AVEC FASTAPI
// =============================================================================
const controlServer = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  try {
    if (req.method === "GET" && req.url === "/status") {
      const status = await getBridgeStatusPayload();
      res.writeHead(200);
      res.end(JSON.stringify(status));
      return;
    }

    if (req.method === "POST" && req.url === "/sync") {
      let rawBody = "";
      let totalBytes = 0;
      for await (const chunk of req) {
        totalBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
        if (totalBytes > MAX_SYNC_BODY_BYTES) {
          res.writeHead(413);
          res.end(JSON.stringify({ error: "Payload trop volumineux" }));
          return;
        }
        rawBody += chunk;
      }
      const data = rawBody ? JSON.parse(rawBody) : {};
      await applySyncFromNobis(data);
      const status = await getBridgeStatusPayload();
      res.writeHead(200);
      res.end(JSON.stringify({ status: "ok", bridge: status }));
      return;
    }

    if (req.method === "POST" && req.url === "/factory-reset") {
      res.writeHead(200);
      res.end(JSON.stringify({ status: "resetting" }));
      setTimeout(async () => {
        try {
          if (serverNode) {
            await serverNode.close();
          }
        } catch {
          // ignore
        }
        try {
          fs.rmSync(STORAGE_DIR, { recursive: true, force: true });
        } catch {
          // ignore
        }
        process.exit(0);
      }, 150);
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (err) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: String(err?.message || err) }));
  }
});

controlServer.listen(CONTROL_PORT, "127.0.0.1", () => {
  console.log(`[MatterBridge] API de contrôle locale active sur http://127.0.0.1:${CONTROL_PORT}`);
  startMatterNode().catch((err) => {
    lastError = String(err?.message || err);
    console.error("[MatterBridge] Échec critique au démarrage:", err);
  });
});

async function gracefulExit() {
  try {
    controlServer.close();
    if (serverNode) {
      await serverNode.close();
    }
  } catch {
    // ignore
  }
  process.exit(0);
}

process.on("SIGINT", gracefulExit);
process.on("SIGTERM", gracefulExit);
