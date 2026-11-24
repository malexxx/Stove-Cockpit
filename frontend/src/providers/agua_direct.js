// Client Cloud Agua IOT universel (35+ marques + Custom) via CapacitorHttp (natif) ou fetch.
import { Capacitor, CapacitorHttp } from "@capacitor/core";
import brandsCatalog from "@shared/brands.json";
import schema from "@shared/micronova_schema.json";
import { parseRegistersMap, prepareWriteValue, resolveCanonical } from "../micronova/register_engine.js";

const BYTE_OFFSETS = new Set(schema.byte_offsets || []);
const CANONICAL_ALIASES = schema.canonical_key_aliases || {};

export function getBrandPreset(brandId) {
  const list = brandsCatalog.brands || [];
  return list.find((b) => b.id === brandId) || list.find((b) => b.id === "nobis") || {};
}

export function getAllBrands() {
  return brandsCatalog.brands || [];
}

export class AguaDirectProvider {
  constructor(httpTransport = null) {
    this.tokenJwt = null;
    this.refreshToken = null;
    this.idDevice = "";
    this.idProduct = "";
    this.stoveName = "";
    this.devicesList = [];
    this.registeredUuids = new Set();
    this.rawRegistersMap = {};
    this.registersMapByOffset = new Map();
    this.registersMapByKey = new Map();
    this.workingWriteEndpoint = null;
    this._ioQueue = Promise.resolve();
    this._httpTransport = httpTransport;
  }

  _enqueue(fn) {
    const run = this._ioQueue.then(fn, fn);
    this._ioQueue = run.catch(() => {});
    return run;
  }

  async _httpRequest({ url, method = "GET", headers = {}, data = undefined, timeoutMs = 10000 }) {
    if (this._httpTransport) {
      return this._httpTransport({ url, method, headers, data, timeoutMs });
    }
    const isNative = typeof Capacitor !== "undefined" && typeof Capacitor.isNativePlatform === "function" && Capacitor.isNativePlatform();
    if (isNative) {
      const res = await CapacitorHttp.request({
        url,
        method,
        headers,
        data,
        connectTimeout: timeoutMs,
        readTimeout: timeoutMs,
      });
      return {
        status: res.status,
        ok: res.status >= 200 && res.status < 300,
        data: typeof res.data === "string" ? JSON.parse(res.data || "{}") : res.data,
        text: typeof res.data === "string" ? res.data : JSON.stringify(res.data ?? {}),
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        method,
        headers,
        body: data !== undefined ? JSON.stringify(data) : undefined,
        signal: controller.signal,
      });
      const text = await resp.text();
      let parsed = {};
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = { raw: text };
      }
      return { status: resp.status, ok: resp.ok, data: parsed, text };
    } finally {
      clearTimeout(timer);
    }
  }

  resolveBrandConfig(settings = {}) {
    const brandKey = String(settings.agua_brand || "nobis").trim() || "nobis";
    const preset = getBrandPreset(brandKey);
    const isCustom = brandKey === "custom";
    const usePreset = !isCustom && Boolean(preset && preset.api_url);
    const apiUrl = (usePreset ? preset.api_url : String(settings.agua_api_url || preset.api_url || "https://nobis.agua-iot.com"))
      .trim()
      .replace(/\/+$/, "");
    const customerCode = (usePreset ? preset.customer_code : String(settings.agua_customer_code || preset.customer_code || "700700")).trim();
    const brandId = (usePreset ? (preset.brand_id || "1") : String(settings.agua_brand_id || preset.brand_id || "1")).trim();
    const brandHeader = (usePreset ? (preset.brand || "") : String(settings.agua_brand_header || preset.brand || "")).trim();
    const loginApiUrl = (usePreset ? (preset.login_api_url || "") : String(settings.agua_login_api_url || preset.login_api_url || "")).trim();
    return { brandKey, apiUrl, customerCode, brandId, brandHeader, loginApiUrl };
  }

  _baseHeaders(brandCfg) {
    const h = {
      Accept: "application/json, text/javascript, */*; q=0.01",
      "Content-Type": "application/json",
      Origin: "file://",
      "User-Agent": "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/88.0.4324.181 Mobile Safari/537.36",
      id_brand: brandCfg.brandId || "1",
      customer_code: brandCfg.customerCode || "700700",
    };
    if (brandCfg.brandHeader) {
      h.brand = brandCfg.brandHeader;
    }
    return h;
  }

  _headersForLogin(appUuid, brandCfg) {
    const h = {
      ...this._baseHeaders(brandCfg),
      local: "true",
      Authorization: appUuid,
    };
    if (brandCfg.loginApiUrl) {
      h.applicationversion = "1.9.7";
      h.url = "userLogin";
      h.userid = "null";
      h.aguaid = "null";
    }
    return h;
  }

  _headersForApi(brandCfg, localFlag = "false") {
    return {
      ...this._baseHeaders(brandCfg),
      local: localFlag,
      Authorization: String(this.tokenJwt || ""),
    };
  }

  _cacheRegistersMap(rawMapJson) {
    this.rawRegistersMap = parseRegistersMap(rawMapJson);
    this.registersMapByOffset.clear();
    this.registersMapByKey.clear();
    for (const [rk, reg] of Object.entries(this.rawRegistersMap)) {
      this.registersMapByKey.set(rk, reg);
      const off = Number(reg.offset);
      if (Number.isFinite(off)) {
        if (!this.registersMapByOffset.has(off) || reg.reg_type === "SET") {
          const copy = { ...reg };
          const rawMask = copy.mask ?? copy.Mask;
          if (rawMask !== undefined && rawMask !== null && ![255, 65535].includes(Number(rawMask))) {
            copy.mask = copy.is_word !== false ? 65535 : 255;
          }
          this.registersMapByOffset.set(off, copy);
        }
      }
    }
  }

  async _ensureAppSignup(appUuid, brandCfg) {
    const sigKey = `${brandCfg.apiUrl}|${brandCfg.customerCode}|${appUuid}`;
    if (this.registeredUuids.has(sigKey)) return;
    const headers = this._headersForLogin(appUuid, brandCfg);
    delete headers.Authorization;
    const res = await this._httpRequest({
      url: `${brandCfg.apiUrl}/appSignup`,
      method: "POST",
      headers,
      data: {
        phone_type: "Android",
        phone_id: appUuid,
        phone_version: "1.0",
        language: "fr",
        id_app: appUuid,
        push_notification_token: appUuid,
        push_notification_active: false,
      },
      timeoutMs: 8000,
    });
    if (res.status === 200 || res.status === 201) {
      this.registeredUuids.add(sigKey);
    }
  }

  async loginAndDiscover(settings = {}) {
    return this._enqueue(async () => this._loginAndDiscoverUnlocked(settings));
  }

  async _loginAndDiscoverUnlocked(settings = {}) {
    const email = String(settings.agua_email || "").trim();
    const password = String(settings.agua_password || "").trim();
    const appUuid = String(settings.agua_uuid || "").trim();
    if (!email || !password || password === "********" || !email.includes("@")) {
      throw new Error("Veuillez saisir votre email et votre mot de passe Agua IOT.");
    }
    const brandCfg = this.resolveBrandConfig(settings);
    await this._ensureAppSignup(appUuid, brandCfg);

    const loginUrl = brandCfg.loginApiUrl || `${brandCfg.apiUrl}/userLogin`;
    const rLogin = await this._httpRequest({
      url: loginUrl,
      method: "POST",
      headers: this._headersForLogin(appUuid, brandCfg),
      data: { email, password },
      timeoutMs: 10000,
    });
    if (!rLogin.ok) {
      throw new Error(`HTTP ${rLogin.status} sur /userLogin: ${rLogin.text?.slice(0, 140)}`);
    }
    this.tokenJwt = rLogin.data?.token || null;
    this.refreshToken = rLogin.data?.refresh_token || null;
    if (!this.tokenJwt) {
      throw new Error("Jeton JWT absent de la réponse /userLogin.");
    }

    const rDev = await this._httpRequest({
      url: `${brandCfg.apiUrl}/deviceList`,
      method: "POST",
      headers: this._headersForApi(brandCfg),
      data: {},
      timeoutMs: 15000,
    });
    const devices = Array.isArray(rDev.data?.device) ? rDev.data.device : [];
    this.devicesList = devices;
    if (devices.length === 0) {
      throw new Error("Aucun poêle détecté sur ce compte Agua IOT.");
    }
    const preferredId = String(settings.agua_id_device || "").trim();
    const chosen = devices.find((d) => String(d.id_device) === preferredId) || devices[0];
    this.idDevice = String(chosen.id_device || "");
    this.idProduct = String(chosen.id_product || "");
    this.stoveName = String(chosen.name || chosen.name_product || "").trim();

    try {
      const rMap = await this._httpRequest({
        url: `${brandCfg.apiUrl}/deviceGetRegistersMap`,
        method: "POST",
        headers: this._headersForApi(brandCfg),
        data: { id_device: this.idDevice, id_product: this.idProduct, last_update: "2018-06-03T08:59:54.043" },
        timeoutMs: 20000,
      });
      if (rMap.ok) {
        this._cacheRegistersMap(rMap.data);
      }
    } catch {
      // best effort
    }

    return {
      token_ok: true,
      brand: brandCfg.brandKey,
      id_device: this.idDevice,
      id_product: this.idProduct,
      stove_name: this.stoveName,
      devices: this.devicesList,
      registers_map_cached: Object.keys(this.rawRegistersMap).length,
    };
  }

  async _refreshOrRelogin(settings, brandCfg) {
    if (this.refreshToken) {
      try {
        const rRef = await this._httpRequest({
          url: `${brandCfg.apiUrl}/refreshToken`,
          method: "POST",
          headers: this._baseHeaders(brandCfg),
          data: { refresh_token: this.refreshToken },
          timeoutMs: 8000,
        });
        if (rRef.ok && rRef.data?.token) {
          this.tokenJwt = rRef.data.token;
          if (rRef.data.refresh_token) this.refreshToken = rRef.data.refresh_token;
          return;
        }
      } catch {
        // fall through to full login
      }
    }
    await this._loginAndDiscoverUnlocked(settings);
  }

  async _waitJobAnswer(idRequest, brandCfg) {
    let lastStatus = "pending";
    for (let i = 0; i < 15; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      const rJob = await this._httpRequest({
        url: `${brandCfg.apiUrl}/deviceJobStatus/${idRequest}`,
        method: "GET",
        headers: this._headersForApi(brandCfg),
        timeoutMs: 12000,
      });
      if (rJob.ok) {
        lastStatus = rJob.data?.jobAnswerStatus;
        if (lastStatus === "completed") return rJob.data?.jobAnswerData || {};
        if (["error", "failed", "timeout"].includes(lastStatus)) {
          throw new Error(rJob.data?.jobAnswerData?.message || `Erreur job Agua IOT: ${lastStatus}`);
        }
      }
    }
    throw new Error(`Délai dépassé sur job Agua IOT #${idRequest} (${lastStatus})`);
  }

  async readBuffer(settings = {}) {
    return this._enqueue(async () => {
      const brandCfg = this.resolveBrandConfig(settings);
      if (!this.tokenJwt) {
        await this._loginAndDiscoverUnlocked(settings);
      }
      const idDev = String(settings.agua_id_device || this.idDevice || "").trim();
      const idProd = String(settings.agua_id_product || this.idProduct || "").trim();
      const payload = { id_device: idDev, id_product: idProd, BufferId: 1 };

      let resp = await this._httpRequest({
        url: `${brandCfg.apiUrl}/deviceGetBufferReading`,
        method: "POST",
        headers: this._headersForApi(brandCfg),
        data: payload,
        timeoutMs: 10000,
      });
      if (resp.status === 401) {
        await this._refreshOrRelogin(settings, brandCfg);
        payload.id_device = String(settings.agua_id_device || this.idDevice || "").trim();
        payload.id_product = String(settings.agua_id_product || this.idProduct || "").trim();
        resp = await this._httpRequest({
          url: `${brandCfg.apiUrl}/deviceGetBufferReading`,
          method: "POST",
          headers: this._headersForApi(brandCfg),
          data: payload,
          timeoutMs: 10000,
        });
      }
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} sur /deviceGetBufferReading`);
      }
      let items = resp.data?.Items || [];
      let values = resp.data?.Values || [];
      if (resp.data?.idRequest) {
        const ans = await this._waitJobAnswer(String(resp.data.idRequest), brandCfg);
        items = ans.Items || [];
        values = ans.Values || [];
      }

      const cleanBuf = {};
      const len = Math.min(items.length, values.length);
      for (let i = 0; i < len; i += 1) {
        const k = items[i];
        const v = values[i];
        if (k === null || k === undefined || v === null || v === undefined) continue;
        const ik = Number(k);
        let fv = Number(v);
        if (!Number.isFinite(ik) || !Number.isFinite(fv)) continue;
        if ((ik === 70 || ik === 71) && fv >= 128 && fv <= 255) {
          fv -= 256;
        }
        cleanBuf[ik] = fv;
      }
      return cleanBuf;
    });
  }

  _findRegisterMeta(offset, regKey) {
    if (regKey) {
      const candidates = [regKey, ...(CANONICAL_ALIASES[regKey] || [])];
      for (const alias of candidates) {
        if (this.registersMapByKey.has(alias)) {
          return { meta: this.registersMapByKey.get(alias), byKey: true };
        }
      }
    }
    return { meta: this.registersMapByOffset.get(Number(offset)) || null, byKey: false };
  }

  _buildRwmsPayload(idDev, idProd, itemsSpec) {
    const bitData = [];
    const endianess = [];
    const items = [];
    const masks = [];
    const values = [];

    for (const { offset, value, regKey } of itemsSpec) {
      const { meta, byKey } = this._findRegisterMeta(offset, regKey);
      const defBit = BYTE_OFFSETS.has(Number(offset)) ? 8 : 16;
      const realOffset = meta && meta.offset !== undefined ? Number(meta.offset) : Number(offset);
      const bitLen = meta?.bit_data ?? meta?.BitData ?? (meta?.is_word !== undefined ? (meta.is_word ? 16 : 8) : defBit);
      const endian = String(meta?.endianess || meta?.Endianess || (meta?.big_endian ? "B" : "L"));
      const fullMask = Number(bitLen) === 8 ? 255 : 65535;
      const rawMetaMask = Number(meta?.mask ?? meta?.Mask ?? fullMask);
      const maskVal = meta ? (byKey ? rawMetaMask : (rawMetaMask === 65535 ? 65535 : fullMask)) : fullMask;

      let rawInt = meta && meta.formula_inverse && meta.formula_inverse !== "#"
        ? prepareWriteValue(meta, value)
        : Math.round(Number(value));
      if (rawInt < 0) {
        rawInt = (1 << Number(bitLen)) + rawInt;
      }
      bitData.push(Number(bitLen));
      endianess.push(endian);
      items.push(realOffset);
      masks.push(maskVal);
      values.push(rawInt);
    }

    return {
      id_device: idDev,
      id_product: idProd,
      Protocol: "RWMSmaster",
      BitData: bitData,
      Endianess: endianess,
      Items: items,
      Masks: masks,
      Values: values,
    };
  }

  async writeRegistersBatch(settings = {}, commands = []) {
    return this._enqueue(async () => {
      const brandCfg = this.resolveBrandConfig(settings);
      if (!this.tokenJwt) {
        await this._loginAndDiscoverUnlocked(settings);
      }

      const itemsSpec = [];
      for (const cmd of commands) {
        const rk = String(cmd.reg_key || "").trim();
        let val = Number(cmd.value);
        if (rk === "status_code" && (val === 6 || val === 9)) {
          val = val === 6 ? 85 : 170;
        }
        const [, dynMeta] = resolveCanonical(rk, null, this.rawRegistersMap);
        const defReg = (schema.default_registers_catalog || []).find((r) => r.reg_key === rk);
        const off = Number(cmd.offset ?? dynMeta?.offset ?? defReg?.offset ?? 0);
        if (off === 70 || off === 71 || rk === "trim_pellet_pct" || rk === "trim_exhaust_pct") {
          continue;
        }
        if (off === 33130 || rk === "standby_set") {
          continue;
        }
        itemsSpec.push({ offset: off, value: val, regKey: rk });
      }
      if (itemsSpec.length === 0) {
        return { status: "ok", message: "Paramètre à valider sur la radiocommande physique." };
      }

      const idDev = String(settings.agua_id_device || this.idDevice || "").trim();
      const idProd = String(settings.agua_id_product || this.idProduct || "").trim();
      const payload = this._buildRwmsPayload(idDev, idProd, itemsSpec);
      const endpoints = this.workingWriteEndpoint
        ? [this.workingWriteEndpoint]
        : ["/deviceRequestWriting", "/deviceWriting", "/deviceGetBufferWriting", "/deviceDataWriting"];

      const errors = [];
      for (const ep of endpoints) {
        let resp = await this._httpRequest({
          url: `${brandCfg.apiUrl}${ep}`,
          method: "POST",
          headers: this._headersForApi(brandCfg),
          data: payload,
          timeoutMs: 10000,
        });
        if (resp.status === 401) {
          await this._refreshOrRelogin(settings, brandCfg);
          resp = await this._httpRequest({
            url: `${brandCfg.apiUrl}${ep}`,
            method: "POST",
            headers: this._headersForApi(brandCfg),
            data: payload,
            timeoutMs: 10000,
          });
        }
        if ([200, 201, 202].includes(resp.status)) {
          this.workingWriteEndpoint = ep;
          if (resp.data?.idRequest) {
            await this._waitJobAnswer(String(resp.data.idRequest), brandCfg);
          }
          return { status: "ok", endpoint: ep, response: resp.data };
        }
        errors.push(`${ep}->${resp.status}`);
        if ([401, 403].includes(resp.status)) break;
      }
      throw new Error(`Échec écriture Agua IOT (${errors.join(", ")})`);
    });
  }
}
