// =============================================================================
// STOVE COCKPIT — POINT D'ENTRÉE BOOTSTRAP SPA (DOMContentLoaded)
// =============================================================================

window.addEventListener("DOMContentLoaded", async () => {
  try { initThreePaneCockpit(); } catch (e) { console.error("[Init] ThreePaneCockpit:", e); }
  try { initTriArcInteractions(); } catch (e) { console.error("[Init] TriArcInteractions:", e); }
  try { if (typeof initCockpitAltInteractions === "function") initCockpitAltInteractions(); } catch (e) { console.error("[Init] CockpitAltInteractions:", e); }
  try { renderTriArcCockpit(); } catch (e) { console.error("[Init] RenderTriArc:", e); }
  try { switchTab("tab-control"); } catch (e) { console.error("[Init] SwitchTab:", e); }

  try {
    if (window.__stoveProviderReady) {
      await window.__stoveProviderReady;
    }
  } catch (e) {
    console.error("[Init] ProviderReady:", e);
  }

  try { if (typeof renderCockpitUiSettingsGrid === "function") renderCockpitUiSettingsGrid(); } catch (e) { console.error("[Init] CockpitUiGrid:", e); }
  try { if (typeof updateSettingsAccordionSummaries === "function") updateSettingsAccordionSummaries(); } catch (e) { console.error("[Init] SettingsSummaries:", e); }
  try { if (typeof renderTriArcCockpit === "function") renderTriArcCockpit(); } catch (e) { console.error("[Init] RenderTriArcPostReady:", e); }

  try { if (typeof populateBrandSelects === "function") populateBrandSelects(); } catch (e) { console.error("[Init] Brands:", e); }
  try { if (typeof syncVersionBadges === "function") syncVersionBadges(); } catch (e) { console.error("[Init] Versions:", e); }
  try { if (typeof applyModeVisibility === "function") applyModeVisibility(); } catch (e) { console.error("[Init] ModeVisibility:", e); }

  const settingsPane = document.getElementById("subtab-pane-settings");
  if (settingsPane) {
    const markSettingsDirty = (ev) => {
      if (ev.target && ev.target.id && ev.target.id.startsWith("cfg-")) {
        isSettingsFormDirty = true;
      }
    };
    settingsPane.addEventListener("input", markSettingsDirty);
    settingsPane.addEventListener("change", markSettingsDirty);
  }

  if (window.stoveProvider && typeof window.stoveProvider.needsOnboarding === "function" && window.stoveProvider.needsOnboarding()) {
    if (typeof openOnboardingModal === "function") openOnboardingModal(true);
  } else {
    loadDashboard();
    initSSEStream();
  }

  if (window.stoveProvider && window.stoveProvider.isContainerActive()) {
    try { refreshMatterStatus(false); } catch (e) { console.error("[Init] MatterStatus:", e); }
    try { if (typeof loadStorageStatus === "function") loadStorageStatus(); } catch (e) { console.error("[Init] StorageStatus:", e); }
    try { if (typeof loadUpdateStatus === "function") loadUpdateStatus(); } catch (e) { console.error("[Init] UpdateStatus:", e); }
    try { if (typeof loadPairingInfo === "function") loadPairingInfo(); } catch (e) { console.error("[Init] PairingInfo:", e); }
  }

  // Filet de sécurité adaptatif (60s) : inactif en arrière-plan ou lorsque le flux SSE est frais (< 150s)
  setInterval(() => {
    if (document.hidden) return;
    if (window.stoveProvider && window.stoveProvider.needsOnboarding()) return;
    const sseFresh = Boolean(
      connectionState &&
      connectionState.isSSEConnected &&
      connectionState.lastMessageAt > 0 &&
      (Date.now() - connectionState.lastMessageAt) < 150000
    );
    if (!sseFresh) {
      refreshLatestOnly();
    }
  }, 60000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      const stale = !connectionState || !connectionState.lastMessageAt || (Date.now() - connectionState.lastMessageAt) > 30000;
      if (stale) refreshLatestOnly();
    }
  });
  // Rafraîchissement ciblé 1 Hz du compte à rebours Mode Silence ! (sans rebuild SVG complet)
  setInterval(() => {
    if (!document.hidden) updateSilenceCountdownDisplay();
  }, 1000);
});

if ("serviceWorker" in navigator && !(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())) {
  window.addEventListener("load", () => {
    if (window.stoveProvider && window.stoveProvider.servedByContainer) {
      navigator.serviceWorker.register("/sw.js", { scope: "/" })
        .then((reg) => console.debug("[PWA] Service Worker actif, scope:", reg.scope))
        .catch((err) => console.warn("[PWA] Enregistrement SW ignoré:", err));
    }
  });
}
