// Client HTTP/SSE vers le conteneur compagnon (« Mode + ») en HTTP pur avec X-API-Key.
import { Capacitor, CapacitorHttp } from "@capacitor/core";

function _normalizeContainerBaseUrl(rawUrl) {
  let u = String(rawUrl || "").trim().replace(/\/+$/, "");
  if (u && !/^https?:\/\//i.test(u)) {
    u = `http://${u}`;
  }
  return u;
}

export class ContainerApiClient {
  constructor() {
    this.baseUrl = "";
    this.apiToken = "";
    this.sseSource = null;
  }

  configure(baseUrl, apiToken) {
    this.baseUrl = _normalizeContainerBaseUrl(baseUrl);
    this.apiToken = String(apiToken || "").trim();
  }

  _headers(extra = {}) {
    const h = { ...extra };
    if (this.apiToken) {
      h["X-API-Key"] = this.apiToken;
    }
    return h;
  }

  async request(path, { method = "GET", headers = {}, body = undefined, timeoutMs = 10000, baseUrlOverride = null, tokenOverride = null } = {}) {
    const targetBase = baseUrlOverride !== null ? _normalizeContainerBaseUrl(baseUrlOverride) : this.baseUrl;
    const tok = tokenOverride !== null ? String(tokenOverride) : this.apiToken;
    const url = targetBase ? `${targetBase}${path}` : path;
    const reqHeaders = { ...headers };
    if (tok) reqHeaders["X-API-Key"] = tok;
    const isFormData = typeof FormData !== "undefined" && body instanceof FormData;
    const isBinary =
      (typeof Blob !== "undefined" && body instanceof Blob) ||
      (typeof ArrayBuffer !== "undefined" && (body instanceof ArrayBuffer || ArrayBuffer.isView(body)));
    if (body !== undefined && !isFormData && !isBinary && !reqHeaders["Content-Type"]) {
      reqHeaders["Content-Type"] = "application/json";
    }

    const isNative = typeof Capacitor !== "undefined" && typeof Capacitor.isNativePlatform === "function" && Capacitor.isNativePlatform();
    if (isNative && targetBase && !isFormData && !isBinary) {
      const capOpts = {
        url,
        method,
        headers: reqHeaders,
        connectTimeout: timeoutMs,
        readTimeout: timeoutMs,
      };
      if (body !== undefined) {
        capOpts.data = body;
      }
      const res = await CapacitorHttp.request(capOpts);
      const ok = res.status >= 200 && res.status < 300;
      const data = typeof res.data === "string" ? JSON.parse(res.data || "{}") : res.data;
      return {
        ok,
        status: res.status,
        json: async () => data,
        text: async () => (typeof res.data === "string" ? res.data : JSON.stringify(data ?? {})),
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const reqBody = body === undefined ? undefined : (isFormData || isBinary || typeof body === "string" ? body : JSON.stringify(body));
      return await fetch(url, {
        method,
        headers: reqHeaders,
        body: reqBody,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  buildUrl(path, withTokenQuery = true) {
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    const base = this.baseUrl ? `${this.baseUrl}${cleanPath}` : cleanPath;
    if (!withTokenQuery || !this.apiToken) return base;
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}token=${encodeURIComponent(this.apiToken)}`;
  }

  async pingHealth(baseUrl = this.baseUrl, apiToken = this.apiToken) {
    try {
      const r = await this.request("/health", {
        method: "GET",
        timeoutMs: 4500,
        baseUrlOverride: baseUrl,
        tokenOverride: apiToken,
      });
      if (!r.ok) return { ok: false, status: r.status };
      const data = await r.json();
      return { ok: data?.status === "healthy", data };
    } catch (err) {
      return { ok: false, error: err?.message || "Injoignable" };
    }
  }

  openSse(onMessage, onError, onOpen) {
    this.closeSse();
    if (typeof EventSource === "undefined") return null;
    const q = this.apiToken ? `?token=${encodeURIComponent(this.apiToken)}` : "";
    const url = `${this.baseUrl}/api/events${q}`;
    this.sseSource = new EventSource(url);
    this.sseSource.onopen = () => onOpen && onOpen();
    this.sseSource.onmessage = (ev) => onMessage && onMessage(ev);
    this.sseSource.onerror = (ev) => onError && onError(ev);
    return this.sseSource;
  }

  closeSse() {
    if (this.sseSource) {
      try {
        this.sseSource.close();
      } catch {
        // ignore
      }
      this.sseSource = null;
    }
  }
}
