// Source de vérité de la version Frontend (injectée par Vite depuis frontend/package.json).
/* global __FRONTEND_VERSION__ */

export function formatVersionTag(ver) {
  const raw = String(ver ?? "").trim();
  if (!raw) return "";
  return raw.startsWith("v") ? raw : `v${raw}`;
}

export function normalizeVersionCore(ver) {
  return String(ver ?? "").trim().replace(/^v/i, "");
}

export function versionsDiffer(verA, verB) {
  const a = normalizeVersionCore(verA);
  const b = normalizeVersionCore(verB);
  return Boolean(a && b && a !== b);
}

export const FRONTEND_VERSION =
  typeof __FRONTEND_VERSION__ !== "undefined" && __FRONTEND_VERSION__
    ? String(__FRONTEND_VERSION__)
    : "0.0.4";

export const FRONTEND_VERSION_TAG = formatVersionTag(FRONTEND_VERSION);
