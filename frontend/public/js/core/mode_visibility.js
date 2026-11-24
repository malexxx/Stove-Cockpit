// =============================================================================
// MODE VISIBILITY, ONBOARDING & MULTI-MARQUES (AUTONOME vs MODE « + »)
// =============================================================================

function applyModeVisibility() {
  const pm = window.stoveProvider;
  const mode = pm ? pm.getMode() : "standalone";
  const isContainer = mode === "container";

  document.querySelectorAll('[data-requires="container"]').forEach((el) => {
    el.classList.toggle("hidden", !isContainer);
  });
  document.querySelectorAll('[data-requires="standalone-only"]').forEach((el) => {
    el.classList.toggle("hidden", isContainer);
  });

  // Pill badge d'état dans le header
  const pill = document.getElementById("hdr-app-mode-pill");
  if (pill) {
    const badges = {
      container: {
        label: "MODE +",
        cls: "px-2.5 py-1 rounded-lg border border-indigo-500/70 bg-indigo-950/70 text-indigo-300 text-[10px] sm:text-xs font-extrabold tracking-wide cursor-pointer hover:brightness-110 transition",
        title: "Mode « + » actif (Conteneur Compagnon connecté)",
      },
      standalone: {
        label: "AUTONOME",
        cls: "px-2.5 py-1 rounded-lg border border-amber-500/70 bg-amber-950/60 text-amber-300 text-[10px] sm:text-xs font-extrabold tracking-wide cursor-pointer hover:brightness-110 transition",
        title: "Mode Autonome Cloud direct • Cliquer pour activer le Mode « + »",
      },
      fallback: {
        label: "REPLI CLOUD",
        cls: "px-2.5 py-1 rounded-lg border border-sky-500/70 bg-sky-950/60 text-sky-300 text-[10px] sm:text-xs font-extrabold tracking-wide cursor-pointer hover:brightness-110 transition",
        title: "Conteneur hors portée — Repli Cloud automatique (4G/5G)",
      },
      demo: {
        label: "DÉMO",
        cls: "px-2.5 py-1 rounded-lg border border-emerald-500/70 bg-emerald-950/60 text-emerald-300 text-[10px] sm:text-xs font-extrabold tracking-wide cursor-pointer hover:brightness-110 transition",
        title: "Mode Démo virtuel actif",
      },
    };
    const b = badges[mode] || badges.standalone;
    pill.textContent = b.label;
    pill.className = b.cls;
    pill.title = b.title;
  }

  // Adapter l'accordéon Canalisations selon les capacités détectées du poêle
  const caps = typeof getActiveCapabilities === "function" ? getActiveCapabilities() : null;
  const zonesAcc = document.querySelector('.settings-acc-item[data-acc-id="zones"]');
  if (zonesAcc && caps && Array.isArray(caps.ducts)) {
    zonesAcc.classList.toggle("hidden", caps.ducts.length === 0);
  }

  // Rediriger si l'onglet actif n'est pas autorisé dans le mode courant
  const activeSections = ["tab-pellets", "tab-dashboard", "tab-plus-teaser"];
  for (const id of activeSections) {
    const sec = document.getElementById(id);
    const isVisible = sec && !sec.classList.contains("hidden");
    if (!isVisible) continue;
    if ((id === "tab-pellets" || id === "tab-dashboard") && !isContainer) {
      if (typeof switchTab === "function") switchTab("tab-control");
      break;
    }
    if (id === "tab-plus-teaser" && isContainer) {
      if (typeof switchTab === "function") switchTab("tab-control");
      break;
    }
  }

  // Mode Silence géré exclusivement par le conteneur
  if (!isContainer) {
    if (typeof silenceModeState !== "undefined") {
      silenceModeState = { active: false, remaining_seconds: 0, end_epoch: 0, duration_hours: 2.0 };
    }
    if (typeof closeSilenceModal === "function") closeSilenceModal();
    if (typeof triArcExpandedMode !== "undefined" && triArcExpandedMode === "silence") {
      triArcExpandedMode = null;
    }
  }
  if (typeof syncVersionBadges === "function") syncVersionBadges();
  if (typeof renderTriArcCockpit === "function") renderTriArcCockpit();
  if (typeof updateSettingsAccordionSummaries === "function") updateSettingsAccordionSummaries();

  // Résumé accordéon Option +
  const plusSum = document.getElementById("acc-sum-plus");
  if (plusSum) {
    const labels = {
      container: "✨ Mode « + » Actif (Conteneur connecté)",
      standalone: "☁️ Mode Autonome Cloud direct",
      fallback: "📶 Repli Cloud (Conteneur hors LAN)",
      demo: "🧪 Mode Démo actif",
    };
    plusSum.textContent = labels[mode] || labels.standalone;
  }
}

function _renderBrandApiPreview(previewId, brandId) {
  const box = document.getElementById(previewId);
  if (!box) return;
  if (!brandId || brandId === "custom") {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  const preset = window.stoveProvider?.getBrandPreset?.(brandId);
  if (!preset || !preset.api_url) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  const parts = [
    `<span class="text-gray-400">API :</span> <code class="font-mono text-amber-300 break-all">${escapeHtml(preset.api_url)}</code>`,
    `<span class="text-gray-400">Code client :</span> <code class="font-mono text-cyan-300">${escapeHtml(preset.customer_code || "--")}</code>`,
    `<span class="text-gray-400">Brand ID :</span> <code class="font-mono text-gray-200">${escapeHtml(preset.brand_id || "1")}</code>`,
  ];
  if (preset.brand) {
    parts.push(`<span class="text-gray-400">En-tête :</span> <code class="font-mono text-emerald-300">${escapeHtml(preset.brand)}</code>`);
  }
  const loginLine = preset.login_api_url
    ? `<div class="text-[10px] text-gray-400 truncate">Pont Auth : <code class="font-mono text-sky-300">${escapeHtml(preset.login_api_url)}</code></div>`
    : "";
  box.classList.remove("hidden");
  box.innerHTML = `
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">${parts.join("")}</div>
    ${loginLine}
  `;
}

function populateBrandSelects() {
  const pm = window.stoveProvider;
  if (!pm || typeof pm.getBrands !== "function") return;
  const brands = pm.getBrands();
  for (const id of ["onb-brand", "cfg-agua-brand"]) {
    const sel = document.getElementById(id);
    if (!sel) continue;
    const prev = sel.value;
    sel.innerHTML = brands
      .map((b) => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.name || b.label || b.id)}</option>`)
      .join("");
    if (prev && brands.some((b) => b.id === prev)) {
      sel.value = prev;
    } else if (pm.prefs?.agua_brand && brands.some((b) => b.id === pm.prefs.agua_brand)) {
      sel.value = pm.prefs.agua_brand;
    } else if (brands.some((b) => b.id === "nobis")) {
      sel.value = "nobis";
    }
  }
  onOnboardingBrandChange();
  onSettingsBrandChange();
}

function onOnboardingBrandChange() {
  const sel = document.getElementById("onb-brand");
  const customBox = document.getElementById("onb-custom-brand-fields");
  const hopperInp = document.getElementById("onb-hopper");
  if (!sel) return;
  const isCustom = sel.value === "custom";
  if (customBox) customBox.classList.toggle("hidden", !isCustom);
  _renderBrandApiPreview("onb-brand-api-preview", sel.value);
  const preset = window.stoveProvider?.getBrandPreset?.(sel.value);
  if (preset && hopperInp && !hopperInp.dataset.userEdited) {
    hopperInp.value = String(preset.default_hopper_kg || 30);
  }
}

function onSettingsBrandChange() {
  const sel = document.getElementById("cfg-agua-brand");
  const customBox = document.getElementById("cfg-custom-brand-box");
  if (!sel) return;
  const isCustom = sel.value === "custom";
  if (customBox) customBox.classList.toggle("hidden", !isCustom);
  _renderBrandApiPreview("cfg-brand-api-preview", sel.value);
  if (!isCustom) {
    const preset = window.stoveProvider?.getBrandPreset?.(sel.value) || {};
    const apiUrlEl = document.getElementById("cfg-agua-api-url");
    if (apiUrlEl) apiUrlEl.value = preset.api_url || "";
    const custEl = document.getElementById("cfg-agua-customer-code");
    if (custEl) custEl.value = preset.customer_code || "";
    const brandIdEl = document.getElementById("cfg-agua-brand-id");
    if (brandIdEl) brandIdEl.value = preset.brand_id || "1";
    const loginUrlEl = document.getElementById("cfg-agua-login-api-url");
    if (loginUrlEl) loginUrlEl.value = preset.login_api_url || "";
    const brandHdrEl = document.getElementById("cfg-agua-brand-header");
    if (brandHdrEl) brandHdrEl.value = preset.brand || "";
  }
}

function populatePlusAndBrandSettings(s) {
  const pm = window.stoveProvider;
  const prefs = pm?.prefs || {};
  const src = { ...prefs, ...(s || {}) };

  const brandSel = document.getElementById("cfg-agua-brand");
  if (brandSel && brandSel.options.length === 0) {
    populateBrandSelects();
  }
  if (brandSel && src.agua_brand) brandSel.value = src.agua_brand;
  const apiUrlEl = document.getElementById("cfg-agua-api-url");
  if (apiUrlEl && src.agua_api_url !== undefined) apiUrlEl.value = src.agua_api_url || "";
  const custEl = document.getElementById("cfg-agua-customer-code");
  if (custEl && src.agua_customer_code !== undefined) custEl.value = src.agua_customer_code || "";
  const brandIdEl = document.getElementById("cfg-agua-brand-id");
  if (brandIdEl && src.agua_brand_id !== undefined) brandIdEl.value = src.agua_brand_id || "";
  const loginUrlEl = document.getElementById("cfg-agua-login-api-url");
  if (loginUrlEl && src.agua_login_api_url !== undefined) loginUrlEl.value = src.agua_login_api_url || "";
  const brandHdrEl = document.getElementById("cfg-agua-brand-header");
  if (brandHdrEl && src.agua_brand_header !== undefined) brandHdrEl.value = src.agua_brand_header || "";
  const hopEl = document.getElementById("cfg-hopper-capacity");
  if (hopEl && src.hopper_capacity_kg !== undefined) hopEl.value = src.hopper_capacity_kg || 35;

  const appModeEl = document.getElementById("cfg-app-mode");
  if (appModeEl) appModeEl.value = prefs.app_mode || (pm?.isContainerActive?.() ? "container" : "standalone");
  const plusUrlEl = document.getElementById("cfg-plus-url");
  if (plusUrlEl && prefs.container_url !== undefined) plusUrlEl.value = prefs.container_url || "";
  const plusTokEl = document.getElementById("cfg-plus-token");
  if (plusTokEl && prefs.container_api_token) plusTokEl.value = "********";
  const plusFbEl = document.getElementById("cfg-plus-fallback");
  if (plusFbEl) plusFbEl.checked = prefs.fallback_to_cloud !== "0";
  const demoProfEl = document.getElementById("cfg-demo-profile");
  if (demoProfEl && prefs.demo_profile) demoProfEl.value = prefs.demo_profile;

  onSettingsBrandChange();
}

function openOnboardingModal(required = false) {
  populateBrandSelects();
  const modal = document.getElementById("onboarding-modal");
  const closeBtn = document.getElementById("onboarding-close-btn");
  if (modal) modal.classList.remove("hidden");
  if (closeBtn) closeBtn.classList.toggle("hidden", Boolean(required));
  selectOnboardingMode("cloud");
}

function closeOnboardingModal() {
  const modal = document.getElementById("onboarding-modal");
  if (modal) modal.classList.add("hidden");
}

function selectOnboardingMode(tab) {
  const tabs = ["cloud", "container", "demo"];
  for (const t of tabs) {
    const btn = document.getElementById(`onb-tab-${t}`);
    const panel = document.getElementById(`onb-panel-${t}`);
    const active = t === tab;
    if (panel) panel.classList.toggle("hidden", !active);
    if (btn) {
      btn.className = active
        ? "p-3 rounded-xl border-2 border-orange-500 bg-orange-950/30 text-left space-y-1 transition cursor-pointer"
        : "p-3 rounded-xl border border-slate-700 bg-slate-950/60 hover:border-slate-500 text-left space-y-1 transition cursor-pointer";
    }
  }
}

function _buildOnboardingCloudConfig() {
  const brand = document.getElementById("onb-brand")?.value || "nobis";
  const preset = window.stoveProvider?.getBrandPreset?.(brand) || {};
  const isCustom = brand === "custom";
  return {
    agua_brand: brand,
    agua_api_url: isCustom ? (document.getElementById("onb-api-url")?.value?.trim() || "") : (preset.api_url || ""),
    agua_customer_code: isCustom ? (document.getElementById("onb-customer-code")?.value?.trim() || "") : (preset.customer_code || ""),
    agua_brand_id: preset.brand_id || "1",
    agua_brand_header: preset.brand || "",
    agua_login_api_url: preset.login_api_url || "",
    agua_email: document.getElementById("onb-email")?.value?.trim() || "",
    agua_password: document.getElementById("onb-password")?.value || "",
    hopper_capacity_kg: Number(document.getElementById("onb-hopper")?.value || preset.default_hopper_kg || 30),
  };
}

function _setBoxStatus(elId, text, ok) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.classList.remove("hidden");
  el.className = ok
    ? "rounded-lg p-2.5 text-[11px] font-mono bg-emerald-950/60 border border-emerald-700 text-emerald-200"
    : "rounded-lg p-2.5 text-[11px] font-mono bg-rose-950/60 border border-rose-700 text-rose-200";
  el.textContent = text;
}

async function testOnboardingCloud() {
  const cfg = _buildOnboardingCloudConfig();
  if (!cfg.agua_email || !cfg.agua_password) {
    _setBoxStatus("onb-cloud-status", "Renseignez votre email et votre mot de passe.", false);
    return;
  }
  _setBoxStatus("onb-cloud-status", "Connexion au Cloud Agua IOT en cours...", true);
  try {
    const res = await window.stoveProvider.testCloudDirect(cfg);
    if (res.connected || res.token_ok) {
      const regCount = res.registers_count ?? res.registers_map_cached ?? 0;
      _setBoxStatus("onb-cloud-status", `✅ Connecté : ${res.stove_name || "Poêle détecté"} (${regCount} registres)`, true);
    } else {
      _setBoxStatus("onb-cloud-status", `❌ ${res.error || "Connexion impossible"}`, false);
    }
  } catch (e) {
    _setBoxStatus("onb-cloud-status", `❌ ${e.message}`, false);
  }
}

async function saveOnboardingCloud() {
  const cfg = _buildOnboardingCloudConfig();
  if (!cfg.agua_email || !cfg.agua_password) {
    _setBoxStatus("onb-cloud-status", "Email et mot de passe requis.", false);
    return;
  }
  await window.stoveProvider.saveSettings({
    app_mode: "standalone",
    comm_mode: "agua_cloud",
    ...cfg,
  });
  closeOnboardingModal();
  applyModeVisibility();
  if (typeof loadDashboard === "function") await loadDashboard();
  if (typeof initSSEStream === "function") initSSEStream();
  showToast("☁️ Mode Autonome activé !");
}

async function testOnboardingContainer() {
  const url = document.getElementById("onb-plus-url")?.value?.trim() || "";
  const token = document.getElementById("onb-plus-token")?.value?.trim() || "";
  if (!url) {
    _setBoxStatus("onb-container-status", "Entrez l'URL HTTP du conteneur (ex: http://192.168.1.50:8080).", false);
    return;
  }
  _setBoxStatus("onb-container-status", `Ping ${url}/health...`, true);
  const res = await window.stoveProvider.testContainerConnection(url, token);
  if (res.ok) {
    _setBoxStatus("onb-container-status", `✅ Conteneur en ligne (${res.data?.version || "Stove Cockpit"})`, true);
  } else {
    _setBoxStatus("onb-container-status", `❌ Conteneur inaccessible (${res.error || `HTTP ${res.status || "KO"}`})`, false);
  }
}

async function saveOnboardingContainer() {
  const url = document.getElementById("onb-plus-url")?.value?.trim() || "";
  const token = document.getElementById("onb-plus-token")?.value?.trim() || "";
  const fb = document.getElementById("onb-plus-fallback")?.checked ? "1" : "0";
  if (!url) {
    _setBoxStatus("onb-container-status", "URL HTTP du conteneur requise.", false);
    return;
  }
  await window.stoveProvider.saveSettings({
    app_mode: "container",
    container_url: url,
    container_api_token: token,
    fallback_to_cloud: fb,
  });
  closeOnboardingModal();
  applyModeVisibility();
  if (typeof loadDashboard === "function") await loadDashboard();
  if (typeof initSSEStream === "function") initSSEStream();
  showToast("✨ Mode « + » activé !");
}

async function activateOnboardingDemo() {
  const profile = document.getElementById("onb-demo-profile")?.value || "nobis_2ducts";
  await window.stoveProvider.saveSettings({
    app_mode: "demo",
    demo_profile: profile,
  });
  closeOnboardingModal();
  applyModeVisibility();
  if (typeof loadDashboard === "function") await loadDashboard();
  if (typeof initSSEStream === "function") initSSEStream();
  showToast("🧪 Mode Démo activé !");
}

function openPlusSettingsShortcut() {
  if (typeof switchTab === "function") switchTab("tab-installer");
  if (typeof toggleSettingsAccordion === "function") toggleSettingsAccordion("plus", true);
}

async function testPlusContainerFromSettings() {
  const url = document.getElementById("cfg-plus-url")?.value?.trim() || "";
  let token = document.getElementById("cfg-plus-token")?.value?.trim() || "";
  if (token === "********") token = window.stoveProvider?.prefs?.container_api_token || "";
  _setBoxStatus("cfg-plus-diag", `Ping ${url || window.location.origin}/health...`, true);
  const res = await window.stoveProvider.testContainerConnection(url, token);
  if (res.ok) {
    _setBoxStatus("cfg-plus-diag", `✅ Conteneur joignable (v${res.data?.version || "?"})`, true);
  } else {
    _setBoxStatus("cfg-plus-diag", `❌ Échec (${res.error || `HTTP ${res.status || "KO"}`})`, false);
  }
}

async function savePlusModeSettings() {
  const appMode = document.getElementById("cfg-app-mode")?.value || "standalone";
  const url = document.getElementById("cfg-plus-url")?.value?.trim() || "";
  const token = document.getElementById("cfg-plus-token")?.value?.trim() || "";
  const fb = document.getElementById("cfg-plus-fallback")?.checked ? "1" : "0";
  const demoProfile = document.getElementById("cfg-demo-profile")?.value || "nobis_2ducts";

  const patch = {
    app_mode: appMode,
    container_url: url,
    fallback_to_cloud: fb,
    demo_profile: demoProfile,
  };
  if (token && token !== "********") {
    patch.container_api_token = token;
  }
  await window.stoveProvider.saveSettings(patch);
  applyModeVisibility();
  if (typeof loadDashboard === "function") await loadDashboard();
  if (typeof initSSEStream === "function") initSSEStream();
  if (window.stoveProvider.isContainerActive()) {
    try { if (typeof refreshMatterStatus === "function") refreshMatterStatus(false); } catch { }
    try { if (typeof loadStorageStatus === "function") loadStorageStatus(); } catch { }
    try { if (typeof loadUpdateStatus === "function") loadUpdateStatus(); } catch { }
    loadPairingInfo();
  }
  showToast(`✅ Mode mis à jour : ${window.stoveProvider.getMode()}`);
}

/** Charge les informations d'appairage mobile depuis le conteneur Mode « + ». */
async function loadPairingInfo() {
  if (!window.stoveProvider?.isContainerActive?.()) return;
  try {
    const info = await window.stoveProvider.getPairingInfo();
    const urlEl = document.getElementById("pairing-url-hint");
    const tokEl = document.getElementById("pairing-api-token");
    const sumEl = document.getElementById("acc-sum-pairing");
    const token = info.api_token || info.container_api_token || "";
    if (urlEl) urlEl.value = info.url || info.suggested_http_url || window.location.origin;
    if (tokEl) tokEl.value = token;
    if (sumEl) sumEl.textContent = token ? "HTTP LAN pur • Token actif" : "Token non généré";
  } catch (e) {
    console.warn("[Pairing] Chargement impossible:", e);
  }
}

/** Régénère le jeton X-API-Key du conteneur compagnon (nécessite session Installateur). */
async function rotateContainerPairingToken() {
  if (!window.stoveProvider?.isContainerActive?.()) return;
  try {
    const hdr = typeof getInstallerHeaders === "function" ? getInstallerHeaders() : {};
    const res = await window.stoveProvider.rotatePairingToken(hdr);
    const tokEl = document.getElementById("pairing-api-token");
    const newTok = res.api_token || res.container_api_token || "";
    if (tokEl && newTok) tokEl.value = newTok;
    showToast("🔄 Nouveau Token API généré ! Mettez à jour vos appareils mobiles.");
  } catch (e) {
    showToast("Erreur rotation token : " + e.message, true);
  }
}

async function copyPairingField(inputId) {
  const el = document.getElementById(inputId);
  if (!el || !el.value) return;
  try {
    await navigator.clipboard.writeText(el.value);
    showToast("📋 Copié dans le presse-papier !");
  } catch {
    el.select();
    showToast("Sélectionné — utilisez Copier (Ctrl+C).");
  }
}
