// =============================================================================
// FEATURE PARAMÈTRES — ACCORDÉONS, CANALISATIONS, LOGS & ADMINISTRATION SYSTÈME
// =============================================================================

let currentInstallerSubTab = null;
let openSettingsAccId = null;
let currentStorageStatus = null;
let currentUpdateStatus = null;

function collapseAllSettingsAccordions() {
  document.querySelectorAll(".settings-acc-body").forEach((el) => {
    el.classList.add("hidden");
    el.style.display = "none";
  });
  document.querySelectorAll(".settings-acc-arrow").forEach((el) => el.classList.remove("rotate-180"));
  document.querySelectorAll(".settings-acc-item > button").forEach((btn) => {
    btn.setAttribute("aria-expanded", "false");
  });
  openSettingsAccId = null;
}

function toggleSettingsAccordion(accId, forceOpen = false) {
  const targetBody = document.getElementById("acc-body-" + accId);
  if (!targetBody) return;

  const isAlreadyOpen = !targetBody.classList.contains("hidden") && targetBody.style.display !== "none";
  collapseAllSettingsAccordions();

  if (isAlreadyOpen && !forceOpen) {
    return;
  }

  targetBody.classList.remove("hidden");
  targetBody.style.display = "";
  const arrow = document.getElementById("acc-arrow-" + accId);
  if (arrow) arrow.classList.add("rotate-180");
  const headerBtn = targetBody.closest(".settings-acc-item")?.querySelector(":scope > button");
  if (headerBtn) headerBtn.setAttribute("aria-expanded", "true");
  openSettingsAccId = accId;
  currentInstallerSubTab = accId;

  if (accId === "expert") {
    renderEepromTable();
    loadSnapshots();
    renderHardwareMasks();
  } else if (accId === "logs") {
    loadLogs(currentLogSeverity);
    loadAudit();
  } else if (accId === "tuning") {
    const trimPelletInp = document.getElementById("inst-trim-pellet");
    if (trimPelletInp && document.activeElement !== trimPelletInp) {
      trimPelletInp.value = getRegVal("trim_pellet_pct", 0);
    }
    const trimExhaustInp = document.getElementById("inst-trim-exhaust");
    if (trimExhaustInp && document.activeElement !== trimExhaustInp) {
      trimExhaustInp.value = getRegVal("trim_exhaust_pct", 0);
    }
  } else if (accId === "conn") {
    updateConfigModalFields();
  } else if (accId === "zones") {
    updateDuctChevronPreview();
  } else if (accId === "cockpit_ui") {
    if (typeof renderCockpitUiSettingsGrid === "function") renderCockpitUiSettingsGrid();
  } else if (accId === "system") {
    loadStorageStatus();
    loadUpdateStatus();
  } else if (accId === "pairing" && typeof loadPairingInfo === "function") {
    loadPairingInfo();
  }
}

function _isSettingsAccordionAllowedInMode(item) {
  const appMode = window.stoveProvider ? window.stoveProvider.getMode() : "standalone";
  const isContainer = appMode === "container";
  const servedByContainer = Boolean(window.stoveProvider?.isServedByContainer?.());
  const req = item.dataset.requires || "";
  if (req === "container" && !isContainer) return false;
  if (req === "container-host" && !servedByContainer) return false;
  if (req === "standalone-only" && isContainer) return false;
  if (req === "client-app" && servedByContainer) return false;
  if (item.dataset.accId === "zones") {
    const caps = typeof getActiveCapabilities === "function" ? getActiveCapabilities() : null;
    if (caps && Array.isArray(caps.ducts) && caps.ducts.length === 0) return false;
  }
  return true;
}

function filterSettingsAccordions(query) {
  const q = String(query || "").trim().toLowerCase();
  const clearBtn = document.getElementById("settings-acc-search-clear");
  if (clearBtn) clearBtn.classList.toggle("hidden", !q);

  const items = Array.from(document.querySelectorAll(".settings-acc-item"));
  let visibleCount = 0;
  let firstVisibleId = null;

  items.forEach((item) => {
    const allowed = _isSettingsAccordionAllowedInMode(item);
    const kw = (item.dataset.keywords || "").toLowerCase();
    const txt = (item.textContent || "").toLowerCase();
    const match = !q || kw.includes(q) || txt.includes(q);
    const visible = allowed && match;
    item.classList.toggle("hidden", !visible);
    if (visible) {
      visibleCount++;
      if (!firstVisibleId) firstVisibleId = item.dataset.accId;
    }
  });

  const emptyEl = document.getElementById("settings-acc-empty");
  if (emptyEl) emptyEl.classList.toggle("hidden", visibleCount > 0);

  if (q && firstVisibleId) {
    toggleSettingsAccordion(firstVisibleId, true);
  } else {
    collapseAllSettingsAccordions();
  }
}

function updateDuctChevronPreview() {
  const leftInp = document.getElementById("cfg-duct-left-name");
  const rightInp = document.getElementById("cfg-duct-right-name");
  const sx = (leftInp && leftInp.value.trim()) ? leftInp.value.trim() : getDuctName("SX");
  const dx = (rightInp && rightInp.value.trim()) ? rightInp.value.trim() : getDuctName("DX");

  const prevSx = document.getElementById("preview-chevron-sx-name");
  const prevDx = document.getElementById("preview-chevron-dx-name");
  if (prevSx) prevSx.textContent = sx;
  if (prevDx) prevDx.textContent = dx;

  const sumZones = document.getElementById("acc-sum-zones");
  if (sumZones) sumZones.textContent = `${sx} • ${dx}`;

  // Hydrate les valeurs télémétriques des chevrons simulés avec les données réelles du poêle
  const realSx = latestData && latestData.duct_left_temp != null ? formatMeasuredTemp(latestData.duct_left_temp, 17) : "17";
  const spSx = getRegVal("duct_left_setpoint", 20);
  const fanSx = getRegVal("duct_left_speed", 8);
  const realDx = latestData && latestData.duct_right_temp != null ? formatMeasuredTemp(latestData.duct_right_temp, 17) : "17";
  const spDx = getRegVal("duct_right_setpoint", 20);
  const fanDx = getRegVal("duct_right_speed", 8);

  const fmtFan = (v) => (Number(v) === 0 ? "OFF" : Number(v) >= 8 ? "AUTO" : `V${v}`);
  const fmtSp = (v) => (Number(v) >= 41 ? "MAX" : `${v}°`);

  const sxFanEl = document.getElementById("preview-chevron-sx-fan");
  const sxTempEl = document.getElementById("preview-chevron-sx-temp");
  const dxFanEl = document.getElementById("preview-chevron-dx-fan");
  const dxTempEl = document.getElementById("preview-chevron-dx-temp");

  if (sxFanEl) sxFanEl.textContent = fmtFan(fanSx);
  if (sxTempEl) sxTempEl.innerHTML = `${escapeHtml(realSx)}° <span class="text-cyan-400">→</span> <span class="text-cyan-200">${escapeHtml(fmtSp(spSx))}</span>`;
  if (dxFanEl) dxFanEl.textContent = fmtFan(fanDx);
  if (dxTempEl) dxTempEl.innerHTML = `${escapeHtml(realDx)}° <span class="text-sky-400">→</span> <span class="text-sky-200">${escapeHtml(fmtSp(spDx))}</span>`;
}

function resetDuctNamesDefault() {
  const leftInp = document.getElementById("cfg-duct-left-name");
  const rightInp = document.getElementById("cfg-duct-right-name");
  if (leftInp) leftInp.value = "SX";
  if (rightInp) rightInp.value = "DX";
  isSettingsFormDirty = true;
  updateDuctChevronPreview();
}

async function locateWeatherFromBrowser() {
  const btn = document.getElementById("btn-geolocate-weather");
  const origHtml = btn ? btn.innerHTML : "";
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = "<span>⏳</span><span>Localisation...</span>";
  }

  const restoreBtn = () => {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origHtml || "<span>📍</span><span>Me localiser</span>";
    }
  };

  try {
    let coords;
    if (window.stoveProvider && typeof window.stoveProvider.getCurrentPosition === "function") {
      coords = await window.stoveProvider.getCurrentPosition();
    } else if (navigator.geolocation) {
      const pos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: false,
          timeout: 10000,
          maximumAge: 300000,
        });
      });
      coords = { lat: pos.coords.latitude, lon: pos.coords.longitude, source: "gps" };
    } else {
      showToast("La géolocalisation n'est pas supportée par ce navigateur.", true);
      restoreBtn();
      return;
    }

    const lat = Number(coords.lat);
    const lon = Number(coords.lon);
    const latEl = document.getElementById("cfg-lat");
    const lonEl = document.getElementById("cfg-lon");
    const cityEl = document.getElementById("cfg-city");

    if (latEl) latEl.value = lat.toFixed(4);
    if (lonEl) lonEl.value = lon.toFixed(4);
    isSettingsFormDirty = true;

    let resolvedCity = String(coords.city || "").trim();
    try {
      if (window.stoveProvider && typeof window.stoveProvider.reverseGeocode === "function") {
        const data = await window.stoveProvider.reverseGeocode(lat, lon);
        if (data && data.city) {
          resolvedCity = data.city;
        }
      }
    } catch (e) {
      // Repli silencieux : coordonnées GPS déjà renseignées
    }
    if (resolvedCity && cityEl) cityEl.value = resolvedCity;

    updateSettingsAccordionSummaries();
    restoreBtn();
    const prefix = coords.source === "ip" ? "📍 Position approximative (IP)" : "📍 Position détectée";
    if (resolvedCity) {
      showToast(`${prefix} : ${resolvedCity} — cliquez sur Enregistrer.`);
    } else {
      showToast(`${prefix} (${lat.toFixed(4)}, ${lon.toFixed(4)}) — cliquez sur Enregistrer.`);
    }
  } catch (err) {
    restoreBtn();
    let msg = "Impossible d'obtenir votre position.";
    if (err && err.code === 1) {
      msg = "Permission de géolocalisation refusée (autorisez la localisation dans les réglages).";
    } else if (err && err.code === 2) {
      msg = "Position GPS indisponible pour le moment.";
    } else if (err && err.code === 3) {
      msg = "Délai d'attente dépassé pour la géolocalisation.";
    }
    showToast(msg, true);
  }
}

function updateSettingsAccordionSummaries() {
  // 0. Interface de Pilotage
  const sumCockpitUi = document.getElementById("acc-sum-cockpit-ui");
  if (sumCockpitUi && typeof getActiveCockpitUiMode === "function" && typeof getCockpitUiMeta === "function") {
    const uiMeta = getCockpitUiMeta(getActiveCockpitUiMode());
    sumCockpitUi.textContent = `${uiMeta.num === 0 ? "★" : `#${uiMeta.num}`} ${uiMeta.name} • ${uiMeta.badge}`;
  }

  // 1. Zones SX / DX
  updateDuctChevronPreview();

  // 2. Liaison Poêle (conditionné au mode actif)
  const appMode = window.stoveProvider ? window.stoveProvider.getMode() : "standalone";
  const modeEl = document.getElementById("cfg-mode");
  const intEl = document.getElementById("cfg-interval");
  const intVal = intEl && intEl.value ? intEl.value : (currentSettings.poll_interval_s || "120");
  let modeTxt = "☁️ Agua Cloud";
  if (appMode === "demo") {
    modeTxt = "🧪 Mode Démo";
  } else if (appMode === "container") {
    const modeVal = modeEl ? modeEl.value : (currentSettings.comm_mode || "agua_cloud");
    modeTxt = modeVal === "local_gateway" ? "🔌 UART ESP32" : (modeVal === "simulation" ? "🧪 Simulation" : "☁️ Agua Cloud");
  } else if (appMode === "fallback") {
    modeTxt = "📶 Repli Cloud";
  }
  const sumConn = document.getElementById("acc-sum-conn");
  if (sumConn) sumConn.textContent = `${modeTxt} • ${intVal}s`;

  // 3. Matter & Webhook (Mode +)
  const mEnEl = document.getElementById("cfg-matter-enabled");
  const mPortEl = document.getElementById("cfg-matter-port");
  const whEl = document.getElementById("cfg-webhook");
  const mEn = mEnEl ? mEnEl.value === "1" : String(currentSettings.matter_enabled ?? "1") === "1";
  const mPort = (mPortEl && mPortEl.value) || currentSettings.matter_port || "5540";
  const hasWh = Boolean((whEl ? whEl.value : currentSettings.webhook_url || "").trim());
  const sumDom = document.getElementById("acc-sum-domotic");
  if (sumDom) sumDom.textContent = `${mEn ? `✅ Matter Actif (${mPort})` : "❌ Matter OFF"} • ${hasWh ? "🔔 Webhook actif" : "🔕 Sans webhook"}`;

  // 4. Gestion des Granulés (Mode + uniquement)
  const bagsEl = document.getElementById("cfg-bags-stock");
  const priceEl = document.getElementById("cfg-bag-price");
  const hopperEl = document.getElementById("cfg-hopper-capacity");
  const bags = (bagsEl && bagsEl.value !== "") ? bagsEl.value : (currentSettings.pellet_bags_stock ?? "40");
  const price = (priceEl && priceEl.value !== "") ? priceEl.value : (currentSettings.pellet_bag_price_eur || "4.80");
  const hopper = (hopperEl && hopperEl.value !== "") ? hopperEl.value : (currentSettings.hopper_capacity_kg || "30");
  const sumPellets = document.getElementById("acc-sum-pellets");
  if (sumPellets) sumPellets.textContent = `${bags} sacs (${price} €) • Trémie ${hopper} kg`;

  // 4B. Station Météo Extérieure (tous modes)
  const cityEl = document.getElementById("cfg-city");
  const latEl = document.getElementById("cfg-lat");
  const lonEl = document.getElementById("cfg-lon");
  const city = ((cityEl && cityEl.value) || currentSettings.weather_city || "--").split("(")[0].trim();
  const lat = (latEl && latEl.value) ? latEl.value.trim() : "";
  const lon = (lonEl && lonEl.value) ? lonEl.value.trim() : "";
  const sumWeather = document.getElementById("acc-sum-weather");
  if (sumWeather) {
    sumWeather.textContent = (lat && lon)
      ? `${city} (${lat}, ${lon}) • Open-Meteo Arome`
      : `${city} • Open-Meteo Arome`;
  }

  // 5. Tarages IA
  const tPel = getRegVal("trim_pellet_pct", 0);
  const tExh = getRegVal("trim_exhaust_pct", 0);
  const sumTuning = document.getElementById("acc-sum-tuning");
  if (sumTuning) sumTuning.textContent = `Vis ${tPel}% • Fumées ${tExh}%`;

  // 6. Système
  const rtcEl = document.getElementById("inst-clock-val");
  const appVer = typeof getUnifiedVersionLabel === "function" ? getUnifiedVersionLabel() : "v0.0.9";
  const rtc = rtcEl ? rtcEl.textContent.trim() : "--:--";
  const sumSys = document.getElementById("acc-sum-system");
  if (sumSys) {
    const warnSuffix = (currentStorageStatus && currentStorageStatus.persistent === false)
      ? " • ⚠️ Volume non persistant"
      : "";
    const updSuffix = (currentUpdateStatus && currentUpdateStatus.last_check && currentUpdateStatus.last_check.update_available)
      ? " • ⬆️ MAJ dispo"
      : "";
    sumSys.textContent = `RTC ${rtc} • ${appVer}${warnSuffix}${updSuffix}`;
  }

  // 7. Expert
  const sumExp = document.getElementById("acc-sum-expert");
  if (sumExp) {
    sumExp.textContent = "Snapshots, RAM/EEPROM, Injecteur";
  }
}

function applyDuctNamesAcrossUI() {
  syncSeriesDuctLabels();
  const sx = getDuctName("SX");
  const dx = getDuctName("DX");

  const dotSx = document.getElementById("triarc-dot-sx");
  const dotDx = document.getElementById("triarc-dot-dx");
  if (dotSx) dotSx.title = `Canalisation Gauche (${sx})`;
  if (dotDx) dotDx.title = `Canalisation Droite (${dx})`;

  const silDucts = document.getElementById("silence-modal-ducts-label");
  if (silDucts) silDucts.textContent = `Canalisations ${sx} & ${dx}`;
}

function switchLogView(viewName) {
  const sysView = document.getElementById("logs-view-system");
  const auditView = document.getElementById("logs-view-audit");
  const sysBtn = document.getElementById("logview-btn-system");
  const auditBtn = document.getElementById("logview-btn-audit");

  if (viewName === "audit") {
    if (sysView) sysView.classList.add("hidden");
    if (auditView) auditView.classList.remove("hidden");
    if (sysBtn) {
      sysBtn.className = "px-3.5 py-1.5 rounded-lg font-semibold transition text-gray-400 hover:text-white hover:bg-gray-900 cursor-pointer flex items-center gap-1.5";
    }
    if (auditBtn) {
      auditBtn.className = "px-3.5 py-1.5 rounded-lg font-bold transition bg-orange-600 text-white shadow-sm cursor-pointer flex items-center gap-1.5";
    }
    loadAudit();
  } else {
    if (sysView) sysView.classList.remove("hidden");
    if (auditView) auditView.classList.add("hidden");
    if (sysBtn) {
      sysBtn.className = "px-3.5 py-1.5 rounded-lg font-bold transition bg-orange-600 text-white shadow-sm cursor-pointer flex items-center gap-1.5";
    }
    if (auditBtn) {
      auditBtn.className = "px-3.5 py-1.5 rounded-lg font-semibold transition text-gray-400 hover:text-white hover:bg-gray-900 cursor-pointer flex items-center gap-1.5";
    }
    loadLogs(currentLogSeverity);
  }
}

// Gestion de la Configuration avec ouverture automatique du bon accordéon si un champ précis est ciblé
function openConfigModal(highlightFieldId = null) {
  switchTab("tab-installer");

  if (highlightFieldId) {
    let targetAcc = "zones";
    if (["cfg-city", "cfg-lat", "cfg-lon"].includes(highlightFieldId)) {
      targetAcc = "weather";
    } else if (["cfg-bags-stock", "cfg-bag-price", "cfg-hopper-capacity"].includes(highlightFieldId)) {
      targetAcc = "pellets";
    } else if (["cfg-pass", "cfg-email", "cfg-mode", "cfg-gw", "cfg-interval", "cfg-agua-brand"].includes(highlightFieldId)) {
      targetAcc = "conn";
    } else if (["cfg-app-mode", "cfg-plus-url", "cfg-plus-token"].includes(highlightFieldId)) {
      targetAcc = "plus";
    } else if (["cfg-matter-enabled", "cfg-matter-name", "cfg-matter-port", "cfg-webhook"].includes(highlightFieldId)) {
      targetAcc = "domotic";
    } else if (["cfg-duct-left-name", "cfg-duct-right-name"].includes(highlightFieldId)) {
      targetAcc = "zones";
    } else if (highlightFieldId === "cfg-cockpit-ui-mode") {
      targetAcc = "cockpit_ui";
    }
    toggleSettingsAccordion(targetAcc, true);
  }

  updateConfigModalFields();
  const modal = document.getElementById("config-modal");
  if (modal) modal.classList.add("hidden");

  if (highlightFieldId) {
    setTimeout(() => {
      const el = document.getElementById(highlightFieldId);
      if (el) {
        el.focus();
        if (el.select) el.select();
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("ring-2", "ring-amber-400", "border-amber-400", "bg-amber-950/80", "shadow-[0_0_15px_rgba(245,158,11,0.5)]");
        setTimeout(() => {
          el.classList.remove("ring-2", "ring-amber-400", "border-amber-400", "bg-amber-950/80", "shadow-[0_0_15px_rgba(245,158,11,0.5)]");
        }, 3000);
      }
    }, 150);
  }
}

function closeConfigModal() {
  const modal = document.getElementById("config-modal");
  if (modal) modal.classList.add("hidden");
}

function updateConfigModalFields() {
  const modeEl = document.getElementById("cfg-mode");
  if (!modeEl) return;
  const mode = modeEl.value;
  const aguaFields = document.getElementById("cfg-fields-agua");
  const gwFields = document.getElementById("cfg-fields-gateway");
  const simFields = document.getElementById("cfg-fields-sim");
  if (aguaFields) aguaFields.classList.toggle("hidden", mode !== "agua_cloud");
  if (gwFields) gwFields.classList.toggle("hidden", mode !== "local_gateway");
  if (simFields) simFields.classList.toggle("hidden", mode !== "simulation");
}

async function saveSettings() {
  const modeEl = document.getElementById("cfg-mode");
  const isContainer = window.stoveProvider?.isContainerActive?.();
  const mode = isContainer && modeEl ? modeEl.value : "agua_cloud";
  const brand = document.getElementById("cfg-agua-brand")?.value || "nobis";
  const preset = window.stoveProvider?.getBrandPreset?.(brand) || {};
  const isCustomBrand = brand === "custom";
  const hopperCap = document.getElementById("cfg-hopper-capacity")?.value || "35";

  const payload = {
    comm_mode: mode,
    poll_interval_s: document.getElementById("cfg-interval").value,
    weather_city: document.getElementById("cfg-city").value,
    weather_lat: document.getElementById("cfg-lat").value,
    weather_lon: document.getElementById("cfg-lon").value,
    hopper_capacity_kg: hopperCap,
    pellet_bag_price_eur: document.getElementById("cfg-bag-price") ? document.getElementById("cfg-bag-price").value : "5.80",
    pellet_bags_stock: document.getElementById("cfg-bags-stock") ? document.getElementById("cfg-bags-stock").value : "40",
    webhook_url: document.getElementById("cfg-webhook") ? document.getElementById("cfg-webhook").value : "",
    matter_enabled: document.getElementById("cfg-matter-enabled") ? document.getElementById("cfg-matter-enabled").value : "1",
    matter_device_name: document.getElementById("cfg-matter-name") ? document.getElementById("cfg-matter-name").value : "Stove Cockpit",
    matter_port: document.getElementById("cfg-matter-port") ? document.getElementById("cfg-matter-port").value : "5540",
    duct_left_name: document.getElementById("cfg-duct-left-name") ? (document.getElementById("cfg-duct-left-name").value.trim() || "SX") : "SX",
    duct_right_name: document.getElementById("cfg-duct-right-name") ? (document.getElementById("cfg-duct-right-name").value.trim() || "DX") : "DX",
    cockpit_ui_mode: typeof getActiveCockpitUiMode === "function" ? getActiveCockpitUiMode() : "triarc"
  };
  if (mode === "agua_cloud") {
    payload.agua_brand = brand;
    payload.agua_api_url = isCustomBrand ? (document.getElementById("cfg-agua-api-url")?.value?.trim() || "") : (preset.api_url || "");
    payload.agua_customer_code = isCustomBrand ? (document.getElementById("cfg-agua-customer-code")?.value?.trim() || "") : (preset.customer_code || "");
    payload.agua_brand_id = isCustomBrand ? (document.getElementById("cfg-agua-brand-id")?.value?.trim() || "1") : (preset.brand_id || "1");
    payload.agua_brand_header = isCustomBrand ? (document.getElementById("cfg-agua-brand-header")?.value?.trim() || "") : (preset.brand || "");
    payload.agua_login_api_url = isCustomBrand ? (document.getElementById("cfg-agua-login-api-url")?.value?.trim() || "") : (preset.login_api_url || "");
    payload.agua_email = document.getElementById("cfg-email").value;
    payload.agua_password = document.getElementById("cfg-pass").value;
  } else if (mode === "local_gateway") {
    payload.local_gateway_url = document.getElementById("cfg-gw").value;
  }

  let j;
  try {
    j = await window.stoveProvider.saveSettings(payload);
  } catch (err) {
    const msg = err?.message || "";
    showToast("Erreur : " + (msg || "Échec de l'enregistrement"), true);
    return;
  }

  isSettingsFormDirty = false;
  if (j.settings) {
    currentSettings = j.settings;
  }
  const capNum = Number(hopperCap);
  if (capNum >= 5 && capNum <= 500) HOPPER_CAPACITY_KG = capNum;
  applyDuctNamesAcrossUI();
  updateSettingsAccordionSummaries();
  if (connectionState && connectionState.commStatus) {
    connectionState.commStatus.comm_mode = mode;
  }
  currentCommMode = mode;
  closeConfigModal();
  await loadDashboard();
  if (typeof renderTriArcCockpit === "function") renderTriArcCockpit();
  if (typeof renderChronoCards === "function") renderChronoCards();
  showToast("Configuration enregistrée !" + (j.active_db ? ` Base active : ${j.active_db}` : ""));
}

async function testConnection() {
  const diag = document.getElementById("cfg-diag");
  diag.classList.remove("hidden");
  diag.textContent = "Test de communication en cours...";
  const isContainer = window.stoveProvider?.isContainerActive?.();
  const mode = isContainer ? document.getElementById("cfg-mode").value : "agua_cloud";
  const brand = document.getElementById("cfg-agua-brand")?.value || "nobis";
  const preset = window.stoveProvider?.getBrandPreset?.(brand) || {};
  const isCustomBrand = brand === "custom";
  const payload = { comm_mode: mode };
  if (mode === "agua_cloud") {
    payload.agua_brand = brand;
    payload.agua_api_url = isCustomBrand ? (document.getElementById("cfg-agua-api-url")?.value?.trim() || "") : (preset.api_url || "");
    payload.agua_customer_code = isCustomBrand ? (document.getElementById("cfg-agua-customer-code")?.value?.trim() || "") : (preset.customer_code || "");
    payload.agua_brand_id = isCustomBrand ? (document.getElementById("cfg-agua-brand-id")?.value?.trim() || "1") : (preset.brand_id || "1");
    payload.agua_brand_header = isCustomBrand ? (document.getElementById("cfg-agua-brand-header")?.value?.trim() || "") : (preset.brand || "");
    payload.agua_login_api_url = isCustomBrand ? (document.getElementById("cfg-agua-login-api-url")?.value?.trim() || "") : (preset.login_api_url || "");
    payload.agua_email = document.getElementById("cfg-email").value;
    payload.agua_password = document.getElementById("cfg-pass").value;
  } else if (mode === "local_gateway") {
    payload.local_gateway_url = document.getElementById("cfg-gw").value;
  }
  try {
    let j;
    if (isContainer) {
      const res = await window.stoveProvider.container.request("/api/test-connection", {
        method: "POST",
        body: payload
      });
      j = await res.json();
    } else {
      j = await window.stoveProvider.testCloudDirect(payload);
    }
    diag.textContent = JSON.stringify(j, null, 2);
  } catch (e) {
    diag.textContent = JSON.stringify({ connected: false, error: e?.message || "Erreur réseau" }, null, 2);
  }
}

async function testWebhook() {
  if (!window.stoveProvider?.isContainerActive?.()) {
    showToast("Les alertes Webhook nécessitent le Mode « + » (Conteneur).", true);
    return;
  }
  const webhookInp = document.getElementById("cfg-webhook");
  const url = webhookInp ? webhookInp.value.trim() : "";
  if (!url) {
    showToast("Renseignez une URL Webhook / ntfy.sh avant de tester.", true);
    return;
  }
  try {
    await window.stoveProvider.saveSettings({ webhook_url: url });
    const j = await window.stoveProvider.testWebhook();
    showToast(j.message || "Notification de test envoyée avec succès !");
  } catch (e) {
    showToast(e?.message || "Échec de l'envoi Webhook (vérifiez l'URL).", true);
  }
}

let lastLoadedLogs = [];

function renderLogsList(logs) {
  const box = document.getElementById("logs-container");
  if (!box) return;

  if (!logs || logs.length === 0) {
    box.innerHTML = `<div class="py-12 text-center text-gray-500">
      <span class="text-3xl block mb-2">📜</span>
      Aucun événement ne correspond à ce filtre.
    </div>`;
    return;
  }

  box.innerHTML = logs.map(l => {
    const s = (l.severity || "INFO").toUpperCase();
    let sevBadge = "text-sky-400";
    let bgBadge = "bg-sky-950/70 border-sky-800/80";
    if (s === "ERROR") {
      sevBadge = "text-rose-400 font-black";
      bgBadge = "bg-rose-950/80 border-rose-700/80";
    } else if (s === "WARNING" || s === "WARN") {
      sevBadge = "text-amber-400 font-bold";
      bgBadge = "bg-amber-950/80 border-amber-700/80";
    } else if (s === "COMMAND") {
      sevBadge = "text-emerald-400 font-bold";
      bgBadge = "bg-emerald-950/80 border-emerald-700/80";
    }

    return `
      <div class="flex items-start gap-2.5 border-b border-gray-900/80 py-1.5 hover:bg-gray-900/40 px-1 rounded transition text-xs font-mono">
        <span class="text-gray-500 tabular-nums shrink-0 text-[11px] mt-0.5">${escapeHtml(l.timestamp || "")}</span>
        <span class="px-1.5 py-0.5 rounded text-[10px] border ${bgBadge} ${sevBadge} shrink-0 w-20 text-center">[${escapeHtml(s)}]</span>
        <span class="text-gray-400 shrink-0 w-28 text-[11px] font-semibold truncate" title="${escapeHtml(l.source || "")}">${escapeHtml(l.source || "")}</span>
        <span class="text-gray-200 flex-1 break-words leading-relaxed">${escapeHtml(l.message || "")}</span>
      </div>
    `;
  }).join("");
}

function filterLogsClientSide(query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) {
    renderLogsList(lastLoadedLogs);
    return;
  }
  const filtered = (lastLoadedLogs || []).filter(l => {
    const msg = (l.message || "").toLowerCase();
    const src = (l.source || "").toLowerCase();
    const sev = (l.severity || "").toLowerCase();
    const ts = (l.timestamp || "").toLowerCase();
    return msg.includes(q) || src.includes(q) || sev.includes(q) || ts.includes(q);
  });
  renderLogsList(filtered);
}

function copyLogsToClipboard() {
  if (!lastLoadedLogs || lastLoadedLogs.length === 0) {
    showToast("Aucun log à copier.", true);
    return;
  }
  const searchInp = document.getElementById("log-search-input");
  const q = searchInp ? searchInp.value.trim().toLowerCase() : "";
  const logsToCopy = q ? lastLoadedLogs.filter(l => {
    const msg = (l.message || "").toLowerCase();
    const src = (l.source || "").toLowerCase();
    return msg.includes(q) || src.includes(q);
  }) : lastLoadedLogs;

  const text = logsToCopy.map(l => `${l.timestamp || ""} [${(l.severity || "INFO").toUpperCase()}] [${l.source || ""}] ${l.message || ""}`).join("\n");
  navigator.clipboard.writeText(text).then(() => {
    showToast(`📋 ${logsToCopy.length} logs copiés dans le presse-papier !`);
  }).catch(() => {
    showToast("Impossible de copier dans le presse-papier", true);
  });
}

async function loadLogs(sev) {
  currentLogSeverity = sev || "ALL";

  // Highlight active filter buttons
  ["all", "info", "command", "warning", "error", "container"].forEach(s => {
    const btn = document.getElementById("log-btn-" + s);
    if (btn) {
      if (s.toUpperCase() === currentLogSeverity.toUpperCase()) {
        btn.classList.add("active");
        btn.style.outline = "2px solid #f97316";
      } else {
        btn.classList.remove("active");
        btn.style.outline = "none";
      }
    }
  });

  if (!window.stoveProvider?.isContainerActive?.()) return;
  let logs;
  try {
    logs = await window.stoveProvider.getLogs(currentLogSeverity);
  } catch {
    return;
  }
  lastLoadedLogs = Array.isArray(logs) ? logs : [];

  const searchInp = document.getElementById("log-search-input");
  if (searchInp && searchInp.value.trim()) {
    filterLogsClientSide(searchInp.value);
  } else {
    renderLogsList(lastLoadedLogs);
  }
}

async function restartBackend() {
  if (!confirm("Voulez-vous vraiment redémarrer le serveur backend Stove Cockpit ?")) {
    return;
  }
  try {
    const data = await window.stoveProvider.restartBackend();
    showToast(data.message || "🔄 Redémarrage du backend en cours...");
    const startedAt = Date.now();
    const waitReboot = async () => {
      await new Promise(r => setTimeout(r, 1500));
      while (Date.now() - startedAt < 30000) {
        try {
          const hr = await window.stoveProvider.pingContainerHealth();
          if (hr.ok) {
            showToast("✅ Backend redémarré et opérationnel !");
            if (typeof loadDashboard === "function") await loadDashboard();
            return;
          }
        } catch (_) {
          // Serveur en cours de redémarrage
        }
        await new Promise(r => setTimeout(r, 1500));
      }
      showToast("⚠️ Le backend met du temps à répondre, rechargez la page.", true);
    };
    waitReboot();
  } catch (err) {
    showToast(err?.message || "Erreur réseau lors de la demande de redémarrage.", true);
  }
}

async function waitForInternalUpdateReload(previousReleaseId, successMessage) {
  const startedAt = Date.now();
  await new Promise(r => setTimeout(r, 1800));
  while (Date.now() - startedAt < 45000) {
    try {
      const hr = await window.stoveProvider.pingContainerHealth();
      if (hr.ok) {
        const hdata = hr.data || {};
        if (!previousReleaseId || hdata.active_release_id !== previousReleaseId || (Date.now() - startedAt) > 3500) {
          showToast(successMessage);
          if ("serviceWorker" in navigator) {
            navigator.serviceWorker.getRegistration().then((reg) => {
              if (reg) reg.update();
            }).catch(() => { });
          }
          setTimeout(() => window.location.reload(), 900);
          return;
        }
      }
    } catch (_) {
      // Serveur en cours de redémarrage interne
    }
    await new Promise(r => setTimeout(r, 1200));
  }
  showToast("⚠️ Le redémarrage prend du temps, rechargez manuellement la page.", true);
}

/**
 * Met à jour la carte d'état du système de mise à jour interne et ses boutons d'action.
 * @param {Object|null} info Charge utile retournée par `/api/system/update/status`.
 */
function renderUpdateStatus(info) {
  if (!info || typeof info.current_version !== "string") return;
  currentUpdateStatus = info;

  const badgeEl = document.getElementById("update-status-badge");
  const detailsEl = document.getElementById("update-details-text");
  const applyBtn = document.getElementById("btn-apply-internal-update");
  const rollbackBtn = document.getElementById("btn-rollback-internal-update");
  const chanEl = document.getElementById("cfg-update-channel");
  const autoApplyEl = document.getElementById("cfg-update-auto-apply");

  if (chanEl && info.channel) chanEl.value = info.channel;
  if (autoApplyEl && typeof info.auto_apply === "boolean") autoApplyEl.checked = info.auto_apply;

  const lastCheck = info.last_check || null;
  const hasUpdate = Boolean(lastCheck && lastCheck.update_available);

  if (badgeEl) {
    if (!info.self_update_supported) {
      badgeEl.textContent = info.in_docker ? "Superviseur inactif" : "Mode local";
      badgeEl.className = "px-2 py-0.5 rounded-full text-[10px] font-semibold bg-gray-800 text-gray-300 border border-gray-700 shrink-0";
    } else if (hasUpdate) {
      badgeEl.textContent = `⬆️ MAJ disponible (v${lastCheck.remote_version || "?"})`;
      badgeEl.className = "px-2 py-0.5 rounded-full text-[10px] font-semibold bg-teal-950/80 text-teal-300 border border-teal-600/70 shrink-0";
    } else if (info.is_override && info.active_release) {
      badgeEl.textContent = `✅ Interne ${info.active_release.display_version || info.docker_version}`;
      badgeEl.className = "px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-950/80 text-emerald-300 border border-emerald-600/70 shrink-0";
    } else if (lastCheck) {
      badgeEl.textContent = "✅ À jour";
      badgeEl.className = "px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-950/80 text-emerald-300 border border-emerald-600/70 shrink-0";
    } else {
      badgeEl.textContent = `Prêt (${info.docker_version || ("v" + info.current_version)})`;
      badgeEl.className = "px-2 py-0.5 rounded-full text-[10px] font-semibold bg-indigo-950/80 text-indigo-300 border border-indigo-700/70 shrink-0";
    }
  }

  if (detailsEl) {
    const parts = [];
    const shaShort = info.current_commit ? ` (${info.current_commit.slice(0, 7)})` : "";
    parts.push(`Actif : ${info.docker_version || ("v" + info.current_version)}${shaShort} • Base image : v${info.image_version || info.current_version}`);
    if (lastCheck && lastCheck.message) {
      parts.push(lastCheck.message);
    }
    if (info.last_error) {
      parts.push(`⚠️ ${info.last_error}`);
    } else if (info.last_rollback && info.last_rollback.reason === "docker_image_newer") {
      parts.push("ℹ️ Image Docker plus récente détectée au démarrage : l'image officielle a pris le relais.");
    } else if (info.active_release && info.active_release.matter_deps_changed) {
      parts.push("⚠️ Dépendances Node/Matter modifiées en amont : une MAJ d'image Docker est recommandée.");
    }
    detailsEl.textContent = parts.join(" — ");
  }

  if (applyBtn) {
    applyBtn.classList.toggle("hidden", !(hasUpdate && info.self_update_supported));
  }
  if (rollbackBtn) {
    rollbackBtn.classList.toggle("hidden", !info.can_rollback);
  }

  updateSettingsAccordionSummaries();
}

/** Charge l'état complet du système de mise à jour interne via `stoveProvider`. */
async function loadUpdateStatus() {
  if (!window.stoveProvider?.isContainerActive?.()) return;
  try {
    const data = await window.stoveProvider.getUpdateStatus();
    renderUpdateStatus(data);
  } catch (err) {
    // Repli silencieux si hors-ligne
  }
}

/** Sauvegarde la configuration du canal et de l'installation automatique des mises à jour. */
async function saveUpdateConfig() {
  const chanEl = document.getElementById("cfg-update-channel");
  const autoApplyEl = document.getElementById("cfg-update-auto-apply");
  const payload = {
    channel: chanEl ? chanEl.value : "main",
    auto_apply: autoApplyEl ? Boolean(autoApplyEl.checked) : false,
  };
  try {
    const data = await window.stoveProvider.setUpdateConfig(payload);
    renderUpdateStatus(data);
    showToast("✅ Préférences de mise à jour enregistrées.");
  } catch (err) {
    showToast(err?.message || "Impossible d'enregistrer les options de mise à jour.", true);
    loadUpdateStatus();
  }
}

/** Vérifie la disponibilité d'une mise à jour GitHub. */
async function checkInternalUpdate() {
  try {
    const chanEl = document.getElementById("cfg-update-channel");
    const channel = chanEl ? chanEl.value : undefined;
    showToast("⬆️ Vérification de mise à jour en cours...");
    const res = await window.stoveProvider.container.request("/api/system/update/check", {
      method: "POST",
      body: channel ? { channel } : {},
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(data.detail || "Erreur lors de la vérification de mise à jour.", true);
      return;
    }
    await loadUpdateStatus();
    if (data.update_available) {
      showToast(`⬆️ ${data.message || "Mise à jour disponible !"}`);
    } else {
      showToast(`✅ ${data.message || "Stove Cockpit est déjà à jour."}`);
    }
  } catch (err) {
    showToast("Erreur réseau lors de la vérification de mise à jour.", true);
  }
}

/** Télécharge et applique une mise à jour interne au conteneur sans perte de données /app/data. */
async function applyInternalUpdate() {
  const chanEl = document.getElementById("cfg-update-channel");
  const channel = chanEl ? chanEl.value : undefined;
  const prevReleaseId = (currentUpdateStatus && currentUpdateStatus.active_release && currentUpdateStatus.active_release.id) || "";
  if (!confirm("Installer la mise à jour à l'intérieur du conteneur ? Une sauvegarde ZIP automatique sera créée et le serveur redémarrera quelques secondes sans perdre /app/data.")) {
    return;
  }
  try {
    showToast("🚀 Téléchargement et installation de la mise à jour en cours...");
    const res = await window.stoveProvider.container.request("/api/system/update/apply", {
      method: "POST",
      body: { channel },
      timeoutMs: 60000,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(data.detail || "Échec de l'installation de la mise à jour interne.", true);
      loadUpdateStatus();
      return;
    }
    if (data.status === "up_to_date") {
      showToast(`✅ ${data.message || "Application déjà à jour."}`);
      loadUpdateStatus();
      return;
    }
    if (data.matter_deps_changed) {
      showToast("⚠️ Dépendances Matter modifiées : redémarrez/mettez à jour l'image Docker plus tard si besoin.", true);
    }
    showToast(`🔄 ${data.message || "Mise à jour installée, rechargement en cours..."}`);
    waitForInternalUpdateReload(prevReleaseId, "✅ Mise à jour interne active ! Rechargement de l'interface...");
  } catch (err) {
    showToast("Erreur réseau lors de l'application de la mise à jour.", true);
  }
}

/** Annule la mise à jour interne active et revient à la version précédente ou l'image Docker. */
async function rollbackInternalUpdate() {
  const prevReleaseId = (currentUpdateStatus && currentUpdateStatus.active_release && currentUpdateStatus.active_release.id) || "";
  if (!confirm("Revenir à la version précédente (ou à l'image Docker d'origine) ? Vos données dans /app/data resteront intactes.")) {
    return;
  }
  try {
    showToast("⏪ Rollback vers la version précédente en cours...");
    const data = await window.stoveProvider.rollbackUpdate();
    showToast(`🔄 ${data.message || "Rollback déclenché, rechargement..."}`);
    waitForInternalUpdateReload(prevReleaseId, "✅ Rollback terminé ! Rechargement de l'interface...");
  } catch (err) {
    showToast(err?.message || "Erreur réseau lors du rollback interne.", true);
  }
}

function checkWatchtowerUpdate() {
  return checkInternalUpdate();
}

/**
 * Met à jour l'indicateur de persistance du stockage et la bannière d'alerte volume Docker.
 * @param {Object|null} info Charge utile de `/api/system/storage`.
 */
function renderStorageStatus(info) {
  if (!info || typeof info.persistent !== "boolean") return;
  currentStorageStatus = info;

  const badgeEl = document.getElementById("cfg-storage-status");
  const bannerEl = document.getElementById("storage-persistence-banner");
  const labels = {
    bind_mount: "✅ Persistant (bind)",
    named_volume: "✅ Volume nommé",
    host_fs: "✅ Disque local",
    anonymous_volume: "⚠️ Volume anonyme",
    container_layer: "🚨 Éphémère",
  };
  const label = labels[info.mount_type] || (info.persistent ? "✅ Persistant" : "⚠️ Non persistant");

  if (badgeEl) {
    badgeEl.textContent = label;
    badgeEl.title = info.data_dir ? `${label} — ${info.data_dir}` : label;
    badgeEl.className = info.persistent
      ? "text-emerald-400 font-semibold text-xs truncate block mt-0.5"
      : "text-amber-400 font-bold text-xs truncate block mt-0.5";
  }

  if (bannerEl) {
    if (!info.persistent && info.warning) {
      bannerEl.textContent = `⚠️ ${info.warning}`;
      bannerEl.classList.remove("hidden");
    } else {
      bannerEl.textContent = "";
      bannerEl.classList.add("hidden");
    }
  }

  updateSettingsAccordionSummaries();
}

/** Charge le diagnostic de persistance du dossier de données via `stoveProvider`. */
async function loadStorageStatus() {
  if (!window.stoveProvider?.isContainerActive?.()) return;
  try {
    const data = await window.stoveProvider.getStorageStatus();
    renderStorageStatus(data);
  } catch (err) {
    // Repli silencieux si hors-ligne
  }
}

/** Télécharge une archive ZIP atomique complète (bases SQLite, clé Fernet, Matter). */
async function downloadSystemBackup() {
  try {
    showToast("💾 Génération de la sauvegarde complète en cours...");
    const res = await window.stoveProvider.container.request("/api/system/backup", {
      method: "GET",
      timeoutMs: 60000,
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      showToast(errData.detail || "Échec de la génération de la sauvegarde.", true);
      return;
    }
    const blob = await res.blob();
    const disp = res.headers?.get?.("content-disposition") || "";
    const match = disp.match(/filename="?([^"]+)"?/i);
    const filename = (match && match[1]) ? match[1] : "stove_cockpit_backup.zip";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    showToast(`✅ Sauvegarde téléchargée (${filename}).`);
  } catch (err) {
    showToast("Erreur lors du téléchargement de la sauvegarde : " + (err?.message || ""), true);
  }
}

/** Ouvre le sélecteur de fichier ZIP pour restaurer une sauvegarde complète. */
function triggerSystemBackupRestore() {
  const inputEl = document.getElementById("system-backup-file-input");
  if (!inputEl) return;
  inputEl.value = "";
  inputEl.click();
}

/** Envoie une archive ZIP sélectionnée vers `/api/system/backup/restore` et recharge l'état. */
async function restoreSystemBackupFile(inputEl) {
  const file = inputEl && inputEl.files && inputEl.files[0];
  if (!file) return;
  if (!confirm(`Restaurer la sauvegarde « ${file.name} » ? Les bases SQLite et réglages actuels seront remplacés.`)) {
    inputEl.value = "";
    return;
  }
  try {
    showToast("📥 Restauration de la sauvegarde en cours...");
    const data = await window.stoveProvider.restoreBackupFile(file);
    showToast(`✅ ${data.message || "Sauvegarde restaurée avec succès !"}`);
    if (typeof loadDashboard === "function") await loadDashboard();
    loadStorageStatus();
  } catch (err) {
    showToast(err?.message || "Échec de la restauration de la sauvegarde.", true);
  } finally {
    inputEl.value = "";
  }
}
