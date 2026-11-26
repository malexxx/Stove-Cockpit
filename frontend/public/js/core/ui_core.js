// =============================================================================
// CORE UI — TOASTS, MODALES GÉNÉRIQUES, NAVIGATION, INDICATEURS & ERREURS CLIENT
// =============================================================================

function showToast(msg, isError = false) {
  const box = document.getElementById("toast-box");
  if (!box) return;
  box.classList.remove("hidden");
  box.className = "fixed bottom-20 md:bottom-5 right-4 z-50 px-4 py-2.5 rounded-xl shadow-2xl border text-xs font-semibold flex items-center gap-2 transition-all " +
    (isError ? "bg-rose-700 border-rose-400 text-white" : "bg-emerald-700 border-emerald-400 text-white");
  box.innerHTML = `<span>${isError ? "⚠️" : "✅"}</span><span>${escapeHtml(msg)}</span>`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.add("hidden"), 4000);
}

// Gestionnaire de modale non-bloquante (remplace confirm / prompt / alert)
function openActionModal({
  title,
  message,
  htmlContent = null,
  showInput = false,
  inputType = "text",
  defaultValue = "",
  confirmText = "Confirmer",
  cancelText = "Annuler",
  showCancel = true,
  onConfirm,
  onCancel
}) {
  const titleEl = document.getElementById("action-modal-title");
  if (titleEl) {
    titleEl.innerHTML = title || "Confirmation";
  }
  const msgEl = document.getElementById("action-modal-message");
  if (htmlContent) {
    msgEl.innerHTML = htmlContent;
  } else {
    msgEl.textContent = message || "";
  }
  const inpWrap = document.getElementById("action-modal-input-wrap");
  const inp = document.getElementById("action-modal-input");
  if (showInput) {
    inpWrap.classList.remove("hidden");
    inp.type = inputType || "text";
    inp.value = defaultValue;
  } else {
    inpWrap.classList.add("hidden");
    inp.type = "text";
  }

  const cancelBtn = document.getElementById("action-modal-cancel-btn");
  if (cancelBtn) {
    cancelBtn.textContent = cancelText;
    if (showCancel) {
      cancelBtn.classList.remove("hidden");
      cancelBtn.onclick = () => {
        closeActionModal();
        if (onCancel) onCancel();
      };
    } else {
      cancelBtn.classList.add("hidden");
    }
  }

  const btn = document.getElementById("action-modal-confirm-btn");
  btn.textContent = confirmText;
  actionModalCallback = () => {
    const val = showInput ? inp.value : true;
    closeActionModal();
    if (onConfirm) onConfirm(val);
  };
  btn.onclick = actionModalCallback;
  document.getElementById("action-modal").classList.remove("hidden");
  if (showInput) setTimeout(() => inp.focus(), 50);
}

function closeActionModal() {
  document.getElementById("action-modal").classList.add("hidden");
  actionModalCallback = null;
}

const showActionModal = openActionModal;

// Mode de communication actif (Cloud / Passerelle / Simulation)
let currentCommMode = "agua_cloud";
let isSettingsFormDirty = false;

function getActiveCommMode() {
  return (typeof connectionState !== "undefined" && connectionState && connectionState.commStatus && connectionState.commStatus.comm_mode) ||
    (typeof latestData !== "undefined" && latestData && latestData.comm_mode) ||
    (typeof currentSettings !== "undefined" && currentSettings && currentSettings.comm_mode) ||
    currentCommMode ||
    "agua_cloud";
}

function toggleMobileSeriesDrawer() {
  const drawer = document.getElementById("series-filter-drawer");
  const icon = document.getElementById("mob-series-drawer-icon");
  const isHidden = drawer.classList.contains("hidden");
  drawer.classList.toggle("hidden", !isHidden);
  icon.textContent = isHidden ? "▲" : "▼";
}

function switchTab(tabId) {
  if (tabId === "tab-logs") {
    tabId = "tab-installer";
  }

  // Verrouillage du scroll vertical sur l'écran Pilotage Tri-Arc sur smartphone
  const isTriArcUi = typeof getActiveCockpitUiMode !== "function" || getActiveCockpitUiMode() === "triarc";
  if (tabId === "tab-control" && window.innerWidth < 768 && isTriArcUi) {
    document.documentElement.classList.add("overflow-y-hidden");
    document.body.classList.add("overflow-y-hidden");
  } else {
    document.documentElement.classList.remove("overflow-y-hidden");
    document.body.classList.remove("overflow-y-hidden");
  }

  // Remet l'ascenseur tout en haut de page lors du changement d'onglet
  window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
  const mainEl = document.querySelector("main");
  if (mainEl) mainEl.scrollTop = 0;

  ["tab-control", "tab-pellets", "tab-chrono", "tab-dashboard", "tab-plus-teaser", "tab-installer"].forEach(id => {
    const el = document.getElementById(id);
    const isTarget = (id === tabId);
    if (el) {
      el.classList.toggle("hidden", !isTarget);
      el.style.display = isTarget ? "" : "none";
    }
    const inactiveTextCls = id === "tab-plus-teaser" ? "text-indigo-300" : "text-gray-400";
    const btn = document.getElementById("btn-" + id);
    if (btn) {
      if (isTarget) {
        btn.classList.add("tab-active");
        btn.classList.remove("text-gray-400", "text-indigo-300");
        btn.setAttribute("aria-current", "page");
      } else {
        btn.classList.remove("tab-active");
        btn.classList.add(inactiveTextCls);
        btn.removeAttribute("aria-current");
      }
    }
    const mobBtn = document.getElementById("mob-btn-" + id);
    if (mobBtn) {
      if (isTarget) {
        mobBtn.classList.add("mob-tab-active");
        mobBtn.classList.remove("text-gray-400", "text-indigo-300");
        mobBtn.setAttribute("aria-current", "page");
      } else {
        mobBtn.classList.remove("mob-tab-active");
        mobBtn.classList.add(inactiveTextCls);
        mobBtn.removeAttribute("aria-current");
      }
    }
  });
  if (tabId === "tab-chrono") {
    renderChronoPrograms();
    if (typeof _nobisTabDirty !== "undefined") _nobisTabDirty["tab-chrono"] = false;
  }
  if (tabId === "tab-dashboard") {
    if (typeof _nobisTabDirty !== "undefined" && _nobisTabDirty["tab-dashboard"]) {
      if (typeof renderSeriesToggles === "function") renderSeriesToggles();
      if (typeof updateChartDatasets === "function") updateChartDatasets();
      _nobisTabDirty["tab-dashboard"] = false;
    }
    setTimeout(() => {
      if (chartPane1) chartPane1.resize();
      if (chartPane2) chartPane2.resize();
    }, 40);
  }
  if (tabId === "tab-installer") {
    if (typeof _nobisTabDirty !== "undefined" && _nobisTabDirty["tab-installer"]) {
      if (typeof renderHardwareMasks === "function") renderHardwareMasks();
      if (typeof renderRawBufferInspector === "function") renderRawBufferInspector();
      if (typeof renderEepromTable === "function") renderEepromTable();
      _nobisTabDirty["tab-installer"] = false;
    }
    if (typeof collapseAllSettingsAccordions === "function") {
      collapseAllSettingsAccordions();
    }
    updateSettingsAccordionSummaries();
    if (window.stoveProvider?.isServedByContainer?.() && typeof loadPairingInfo === "function") {
      loadPairingInfo();
    }
  }
}

// États de connexion dissociés :
// 1) Conteneur (Navigateur <-> Conteneur Nobis.Supervisor / Serveur Web & Flux SSE)
// 2) Cloud Nobis (Conteneur <-> Cloud Agua IOT / Poêle physique Micronova)
const connectionState = {
  isServerConnected: true,
  isSSEConnected: false,
  lastMessageAt: 0,
  containerStatus: "connected",
  cloudStatus: "connected",
  commStatus: null,
  containerLatencyMs: null,
};

function _formatVerTag(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  return s.startsWith("v") ? s : `v${s}`;
}

function getFrontendVersionLabel() {
  return (
    window.stoveProvider?.getFrontendVersion?.() ||
    window.STOVE_FRONTEND_VERSION ||
    window.StoveCore?.frontendVersionTag ||
    "v0.0.9"
  );
}

function getBackendVersionLabel(rawBackendVer = null) {
  if (!window.stoveProvider?.isContainerActive?.()) return "";
  const raw =
    rawBackendVer ||
    window.stoveProvider?.getBackendVersion?.() ||
    (typeof currentSettings !== "undefined" && currentSettings && (currentSettings.backend_version || currentSettings.docker_version));
  return _formatVerTag(raw);
}

function getUnifiedVersionLabel(rawBackendVer = null) {
  const backVer = getBackendVersionLabel(rawBackendVer);
  return backVer || getFrontendVersionLabel();
}

function syncVersionBadges(rawBackendVer = null) {
  const appVer = getUnifiedVersionLabel(rawBackendVer);

  const hdrVer = document.getElementById("hdr-app-version-badge");
  if (hdrVer) hdrVer.textContent = appVer;
  const cfgVer = document.getElementById("cfg-app-version");
  if (cfgVer) cfgVer.textContent = appVer;
}

// Met à jour la couleur du rectangle global et la chaîne directionnelle dans la pilule d'état
function updateStatusPillBorder() {
  const pillEl = document.getElementById("hdr-status-pill");
  if (!pillEl) return;

  const pm = window.stoveProvider;
  const appMode = pm ? pm.getMode() : "container";
  const servedByContainer = Boolean(pm?.isServedByContainer?.());
  const showPhone = !servedByContainer;
  const showContainerNode = servedByContainer || appMode === "container";
  const showBypass = !servedByContainer && appMode === "fallback";
  const showArrow1 = showPhone && !showBypass;
  const showArrow2 = showContainerNode;

  const phoneEl = document.getElementById("hdr-conn-phone");
  const arrow1El = document.getElementById("hdr-conn-arrow-1");
  const bypassEl = document.getElementById("hdr-conn-bypass");
  const verEl = document.getElementById("hdr-container-version");
  const arrow2El = document.getElementById("hdr-conn-arrow-2");
  const modeBtn = document.getElementById("hdr-mode-conn-btn");
  const bypassArrowEl = bypassEl ? bypassEl.querySelector(".hdr-bypass-arrow") : null;

  if (phoneEl) phoneEl.classList.toggle("hidden", !showPhone);
  if (arrow1El) arrow1El.classList.toggle("hidden", !showArrow1);
  if (bypassEl) bypassEl.classList.toggle("hidden", !showBypass);
  if (verEl) verEl.classList.toggle("hidden", !showContainerNode);
  if (arrow2El) arrow2El.classList.toggle("hidden", !showArrow2);

  const verLabel = getUnifiedVersionLabel();
  const cState = connectionState.containerStatus;
  const mState = connectionState.cloudStatus;
  const activeMode = getActiveCommMode();

  let targetName = "Cloud Micronova";
  if (appMode === "demo" || activeMode === "simulation") {
    targetName = appMode === "demo" ? "Démo" : "Simulation";
  } else if (appMode === "container" && activeMode === "local_gateway") {
    targetName = "ESP32";
  }

  const basePill = "flex items-center gap-1 px-2.5 py-1 sm:py-1.5 rounded-xl border cursor-pointer transition-all duration-200 hover:brightness-110";
  const iconCls = "flex items-center justify-center w-4 h-4 sm:w-[18px] sm:h-[18px]";
  const arrowCls = "flex items-center justify-center w-3 h-3";
  const btnCls = "flex items-center justify-center hover:scale-110 transition-transform cursor-pointer";

  const setColor = (el, base, color) => {
    if (el) el.className = `${base} ${color}`;
  };
  const setBypassArrowColor = (color) => {
    if (bypassArrowEl) bypassArrowEl.setAttribute("class", `hdr-bypass-arrow ${color}`);
  };

  if (showContainerNode && cState === "disconnected") {
    pillEl.className = `${basePill} bg-rose-950/75 border-rose-500/80 shadow-[0_0_12px_rgba(244,63,94,0.35)] animate-pulse`;
    pillEl.title = `Conteneur injoignable (${verLabel}) • Cliquer pour ouvrir les réglages`;
    if (showPhone) setColor(phoneEl, iconCls, "text-gray-300");
    if (showArrow1) setColor(arrow1El, arrowCls, "text-rose-400 animate-pulse");
    if (showArrow2) setColor(arrow2El, arrowCls, "text-gray-500/60");
    if (modeBtn) modeBtn.className = `${btnCls} text-gray-500`;
    return;
  }

  if (mState === "disconnected") {
    pillEl.className = `${basePill} bg-rose-950/75 border-rose-500/80 shadow-[0_0_12px_rgba(244,63,94,0.35)] animate-pulse`;
    pillEl.title = `Anomalie de connexion ${targetName} (${verLabel}) • Cliquer pour ouvrir les réglages`;
    if (showPhone) setColor(phoneEl, iconCls, showContainerNode ? "text-emerald-400" : "text-rose-400");
    if (showArrow1) setColor(arrow1El, arrowCls, showContainerNode ? "text-emerald-400/90" : "text-rose-400 animate-pulse");
    if (showBypass) setBypassArrowColor("text-rose-400 animate-pulse");
    if (showArrow2) setColor(arrow2El, arrowCls, "text-rose-400 animate-pulse");
    if (modeBtn) modeBtn.className = `${btnCls} text-rose-400 animate-pulse`;
    return;
  }

  if ((showContainerNode && cState === "connecting") || mState === "connecting") {
    pillEl.className = `${basePill} bg-amber-950/70 border-amber-500/80 shadow-[0_0_12px_rgba(245,158,11,0.35)]`;
    pillEl.title = `Synchronisation en cours (${verLabel}) • Cliquer pour ouvrir les réglages`;
    const cConnecting = showContainerNode && cState === "connecting";
    const mConnecting = mState === "connecting";
    if (showPhone) setColor(phoneEl, iconCls, (cConnecting || (!showContainerNode && mConnecting)) ? "text-amber-400 animate-pulse" : "text-emerald-400");
    if (showArrow1) setColor(arrow1El, arrowCls, (cConnecting || (!showContainerNode && mConnecting)) ? "text-amber-400 animate-pulse" : "text-emerald-400/90");
    if (showBypass) setBypassArrowColor(mConnecting ? "text-amber-400 animate-pulse" : "text-sky-400");
    if (showArrow2) setColor(arrow2El, arrowCls, mConnecting ? "text-amber-400 animate-pulse" : "text-emerald-400/90");
    if (modeBtn) modeBtn.className = `${btnCls} ${mConnecting ? "text-amber-400 animate-pulse" : "text-emerald-400"}`;
    return;
  }

  if (showBypass && mState === "connected") {
    pillEl.className = `${basePill} bg-sky-950/65 border-sky-500/75 shadow-[0_0_10px_rgba(56,189,248,0.28)]`;
    pillEl.title = `Repli Cloud actif (Conteneur hors portée • ${verLabel}) • Cliquer pour ouvrir les réglages`;
    if (showPhone) setColor(phoneEl, iconCls, "text-sky-400");
    setBypassArrowColor("text-sky-400");
    if (modeBtn) modeBtn.className = `${btnCls} text-sky-400`;
    return;
  }

  if (appMode === "demo" || mState === "simulation") {
    pillEl.className = `${basePill} bg-amber-950/70 border-amber-500/80 shadow-[0_0_12px_rgba(245,158,11,0.35)]`;
    pillEl.title = `Mode ${targetName} actif (${verLabel}) • Cliquer pour ouvrir les réglages`;
    if (showPhone) setColor(phoneEl, iconCls, (showContainerNode && cState === "connected") ? "text-emerald-400" : "text-amber-400");
    if (showArrow1) setColor(arrow1El, arrowCls, showContainerNode ? "text-emerald-400/90" : "text-amber-400");
    if (showArrow2) setColor(arrow2El, arrowCls, "text-amber-400");
    if (modeBtn) modeBtn.className = `${btnCls} text-amber-400`;
    return;
  }

  pillEl.className = `${basePill} bg-emerald-950/60 border-emerald-500/70 shadow-[0_0_10px_rgba(16,185,129,0.25)]`;
  if (appMode === "standalone") {
    pillEl.title = `Mode Autonome Cloud (${verLabel}) • Cliquer pour ouvrir les réglages`;
  } else if (servedByContainer) {
    pillEl.title = `Conteneur → ${targetName} (${verLabel}) • Cliquer pour ouvrir les réglages`;
  } else {
    pillEl.title = `Mode « + » Conteneur → ${targetName} (${verLabel}) • Cliquer pour ouvrir les réglages`;
  }
  if (showPhone) setColor(phoneEl, iconCls, "text-emerald-400");
  if (showArrow1) setColor(arrow1El, arrowCls, "text-emerald-400/90");
  if (showArrow2) setColor(arrow2El, arrowCls, "text-emerald-400/90");
  if (modeBtn) modeBtn.className = `${btnCls} text-emerald-400`;
}

// Met à jour l'indicateur visuel de connexion au conteneur Docker Stove Cockpit (picto Docker)
function updateContainerConnectionIndicator(overrideStatus, message) {
  const verEl = document.getElementById("hdr-container-version");
  const cfgDiagContainer = document.getElementById("cfg-diag-container");

  const appMode = window.stoveProvider ? window.stoveProvider.getMode() : "container";
  const servedByContainer = Boolean(window.stoveProvider?.isServedByContainer?.());
  const dockerVer = getBackendVersionLabel() || "Backend";

  if (appMode !== "container" && !servedByContainer) {
    connectionState.containerStatus = "connected";
    if (verEl) verEl.classList.add("hidden");
    updateStatusPillBorder();
    return;
  }

  const effectiveStatus = overrideStatus || (connectionState.isServerConnected ? "connected" : "disconnected");
  connectionState.containerStatus = effectiveStatus;

  // Cas 1 : Conteneur ou réseau injoignable -> Picto Docker Rouge
  if (effectiveStatus === "disconnected" || !connectionState.isServerConnected) {
    connectionState.containerStatus = "disconnected";
    if (verEl) {
      verEl.className = "flex items-center justify-center w-4 h-4 sm:w-[18px] sm:h-[18px] text-rose-400 animate-pulse";
      verEl.title = `Conteneur Stove Cockpit (${dockerVer}) injoignable`;
    }
    if (cfgDiagContainer) {
      cfgDiagContainer.className = "text-[11px] font-semibold text-rose-400 flex items-center gap-1.5";
      cfgDiagContainer.innerHTML = `<span class="w-2 h-2 rounded-full bg-rose-500 animate-ping"></span>${escapeHtml(message || "Injoignable")}`;
    }
    updateStatusPillBorder();
    return;
  }

  // Cas 2 : Reconnexion / négociation en cours -> Picto Docker Orange
  if (effectiveStatus === "connecting") {
    if (verEl) {
      verEl.className = "flex items-center justify-center w-4 h-4 sm:w-[18px] sm:h-[18px] text-amber-400 animate-pulse";
      verEl.title = `Connexion au conteneur Stove Cockpit (${dockerVer}) en cours...`;
    }
    if (cfgDiagContainer) {
      cfgDiagContainer.className = "text-[11px] font-semibold text-sky-400 flex items-center gap-1.5";
      cfgDiagContainer.innerHTML = `<span class="w-2 h-2 rounded-full bg-sky-400 animate-pulse"></span>Connexion...`;
    }
    updateStatusPillBorder();
    return;
  }

  // Cas 3 : Conteneur connecté et opérationnel -> Picto Docker Vert
  const sseTxt = connectionState.isSSEConnected ? " • Flux SSE actif" : " • HTTP actif";
  const latTxt = connectionState.containerLatencyMs ? ` • Ping ${connectionState.containerLatencyMs}ms` : "";
  if (verEl) {
    verEl.className = "flex items-center justify-center w-4 h-4 sm:w-[18px] sm:h-[18px] text-emerald-400";
    verEl.title = `Conteneur Stove Cockpit (${dockerVer}) en ligne${sseTxt}${latTxt}`;
  }
  if (cfgDiagContainer) {
    cfgDiagContainer.className = "text-[11px] font-semibold text-emerald-400 flex items-center gap-1.5";
    cfgDiagContainer.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_#34d399]"></span>En ligne (${connectionState.isSSEConnected ? 'SSE actif' : 'HTTP'})`;
  }
  updateStatusPillBorder();
}

const MODE_CONN_ICONS = {
  agua_cloud: `<svg viewBox="0 0 24 24" class="w-4 h-4 sm:w-[18px] sm:h-[18px]" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" /></svg>`,
  local_gateway: `<svg viewBox="0 0 24 24" class="w-4 h-4 sm:w-[18px] sm:h-[18px]" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="3" width="12" height="17" rx="1.6" /><path d="M8.5 7.2V5.4h1.7v1.8h1.7V5.4h1.7v1.8h1.9" /><rect x="8.5" y="9.8" width="7" height="5.4" rx="0.6" /><rect x="10" y="17.6" width="4" height="2.4" rx="0.4" /><path d="M4.2 10.5H6M4.2 13.5H6M4.2 16.5H6M18 10.5h1.8M18 13.5h1.8M18 16.5h1.8" /></svg>`,
  simulation: `<svg viewBox="0 0 24 24" class="w-4 h-4 sm:w-[18px] sm:h-[18px]" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6M10 3v5.5L5.2 17.6A2 2 0 0 0 7 20.5h10a2 2 0 0 0 1.8-2.9L14 8.5V3" /><path d="M7.5 15h9" /></svg>`,
};

// Met à jour le pictogramme cible (Cloud / ESP32 / Simulation) et reflète son état dans la pilule
function updateCloudConnectionIndicator(overrideStatus, message) {
  const modeBtn = document.getElementById("hdr-mode-conn-btn");
  const modeIcon = document.getElementById("hdr-mode-conn-icon");
  const cfgDiagCloud = document.getElementById("cfg-diag-cloud");

  const pm = window.stoveProvider;
  const appMode = pm ? pm.getMode() : "container";
  const st = Number(latestData.status_code ?? 0);
  const activeMode = (connectionState.commStatus && connectionState.commStatus.comm_mode) ||
    latestData.comm_mode ||
    (currentSettings && currentSettings.comm_mode) ||
    "agua_cloud";
  currentCommMode = activeMode;

  let targetIconKey = activeMode;
  let modeName = "Cloud Micronova";
  if (appMode === "demo") {
    targetIconKey = "simulation";
    modeName = "Démo";
  } else if (appMode === "standalone") {
    targetIconKey = "agua_cloud";
    modeName = "Cloud Micronova";
  } else if (appMode === "fallback") {
    targetIconKey = "agua_cloud";
    modeName = "Repli Cloud";
  } else if (activeMode === "local_gateway") {
    modeName = "ESP32 / Passerelle UART";
  } else if (activeMode === "simulation") {
    modeName = "Simulation";
  }

  if (modeIcon) {
    modeIcon.innerHTML = MODE_CONN_ICONS[targetIconKey] || MODE_CONN_ICONS.agua_cloud;
  }

  // Cas 1 : Si le conteneur lui-même est inaccessible (hors repli/standalone) -> Pictogramme grisé/rouge
  if (appMode === "container" && !connectionState.isServerConnected) {
    connectionState.cloudStatus = "disconnected";
    if (modeBtn) {
      modeBtn.title = `Mode ${modeName} • Liaison indisponible (conteneur déconnecté)`;
    }
    if (cfgDiagCloud) {
      cfgDiagCloud.className = "text-[11px] font-semibold text-gray-400 flex items-center gap-1.5";
      cfgDiagCloud.innerHTML = `<span class="w-2 h-2 rounded-full bg-gray-500"></span>Inaccessible`;
    }
    updateStatusPillBorder();
    return;
  }

  // Cas 2 : Reconnexion / Actualisation en cours -> Pictogramme Ambre
  if (overrideStatus === "connecting") {
    connectionState.cloudStatus = "connecting";
    if (modeBtn) {
      modeBtn.title = `Mode ${modeName} • Synchronisation en cours...`;
    }
    if (cfgDiagCloud) {
      cfgDiagCloud.className = "text-[11px] font-semibold text-sky-400 flex items-center gap-1.5";
      cfgDiagCloud.innerHTML = `<span class="w-2 h-2 rounded-full bg-sky-400 animate-pulse"></span>Synchronisation...`;
    }
    updateStatusPillBorder();
    return;
  }

  const commStatus = connectionState.commStatus;
  const isCloudOffline = overrideStatus === "disconnected" ||
    (commStatus && commStatus.connected === false) ||
    (st === -1);

  // Cas 3 : Communication perdue -> Pictogramme Rouge
  if (isCloudOffline) {
    connectionState.cloudStatus = "disconnected";
    const reason = (commStatus && commStatus.last_error) || "Rupture de communication ou poêle éteint";
    if (modeBtn) {
      modeBtn.title = `Mode ${modeName} • Perte de communication (${reason}) • Cliquer pour actualiser`;
    }
    if (cfgDiagCloud) {
      cfgDiagCloud.className = "text-[11px] font-semibold text-rose-400 flex items-center gap-1.5";
      cfgDiagCloud.innerHTML = `<span class="w-2 h-2 rounded-full bg-rose-400 animate-pulse"></span>Hors ligne`;
    }
    updateStatusPillBorder();
    return;
  }

  // Cas 4 : Mode Simulation ou Démo actif (virtuel) -> Pictogramme Ambre
  if (appMode === "demo" || activeMode === "simulation") {
    connectionState.cloudStatus = "simulation";
    if (modeBtn) {
      modeBtn.title = `Mode ${modeName} actif (données virtuelles) • Cliquer pour actualiser`;
    }
    if (cfgDiagCloud) {
      cfgDiagCloud.className = "text-[11px] font-semibold text-amber-400 flex items-center gap-1.5";
      cfgDiagCloud.innerHTML = `<span class="w-2 h-2 rounded-full bg-amber-400"></span>${escapeHtml(modeName)} (${escapeHtml(activeMode)})`;
    }
    updateStatusPillBorder();
    return;
  }

  // Cas 5 : Tout est connecté et synchronisé -> Pictogramme Vert (ou Sky en Repli Cloud)
  connectionState.cloudStatus = "connected";
  const lastTime = (commStatus && commStatus.last_sync_time) || latestData.timestamp || "";
  const lastSyncStr = lastTime ? ` • Synchro : ${lastTime.slice(11, 19)}` : "";

  if (modeBtn) {
    modeBtn.title = `Mode ${modeName} • Liaison active${lastSyncStr} • Cliquer pour forcer l'actualisation`;
  }
  if (cfgDiagCloud) {
    cfgDiagCloud.className = "text-[11px] font-semibold text-emerald-400 flex items-center gap-1.5";
    cfgDiagCloud.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_#34d399]"></span>Connecté (${escapeHtml(activeMode)})`;
  }
  updateStatusPillBorder();
}

// Met à jour les deux indicateurs dissociés (Conteneur & Cloud Nobis)
function updateConnectionIndicator(overrideStatus, message) {
  updateContainerConnectionIndicator(overrideStatus, message);
  updateCloudConnectionIndicator(overrideStatus, message);
}


// Mise à jour dynamique du voyant d'état (#hdr-dot avec pictos de la phase en cours à gauche du titre), de la carte État du Poêle et du bandeau d'alerte critique
function updateStatusIndicatorAndAlerts() {
  const dot = document.getElementById("hdr-dot");
  const dotIcon = document.getElementById("hdr-dot-icon");
  const kpiDot = document.getElementById("kpi-state-dot");
  const stateEl = document.getElementById("hdr-state");
  const codeEl = document.getElementById("kpi-status-code");
  const banner = document.getElementById("critical-alert-banner");
  const bannerBtn = document.getElementById("critical-alert-btn");
  const bannerText = document.getElementById("critical-alert-text");
  const bannerBtnText = document.getElementById("critical-alert-btn-text");

  const st = Number(latestData.status_code ?? 0);
  const alarm = Number(latestData.alarm_code ?? 0);
  const popups = Number(latestData.popup_flags ?? 0);
  const blackout = Number(latestData.blackout_popup ?? 0);
  const isPelletEmpty = Boolean(latestData.popup_pellet_empty);
  const hasOtherCritical = (
    alarm > 0 || st === 10 || st === 11 || blackout > 0 ||
    Boolean(latestData.popup_pellet_open) || Boolean(latestData.popup_door_open) ||
    Boolean(latestData.popup_pa_fault) || Boolean(latestData.popup_tck_fault) ||
    Boolean(latestData.popup_tcj_fault) || ((popups & ~64) !== 0)
  );
  const isOnlyPelletEmpty = isPelletEmpty && !hasOtherCritical;
  const isCriticalAlarm = hasOtherCritical;
  const effectivePhase = isCriticalAlarm ? (st === 11 ? 11 : 10) : st;
  const meta = getPhaseMeta(effectivePhase);

  // Mise à jour du pictogramme du chevron correspondant à la phase active
  if (dotIcon) {
    dotIcon.textContent = meta.icon;
  } else if (dot) {
    dot.innerHTML = `<span id="hdr-dot-icon" class="select-none leading-none">${meta.icon}</span>`;
  }
  if (dot) {
    dot.title = `Voyant d'état : ${meta.label} (#${st === -1 ? 'Hors ligne' : st}) - ${meta.desc}`;
  }

  if (codeEl) codeEl.textContent = st === -1 ? "HORS LIGNE" : st;

  if (isCriticalAlarm) {
    if (dot) dot.className = "w-7 h-7 sm:w-8 sm:h-8 rounded-full flex items-center justify-center text-sm sm:text-base bg-rose-600 text-white shadow-[0_0_12px_#f43f5e] animate-pulse flex-shrink-0 cursor-help border border-rose-300";
    if (kpiDot) kpiDot.className = "w-2.5 h-2.5 rounded-full bg-rose-500 animate-ping shrink-0";
    if (stateEl) stateEl.className = "text-sm sm:text-base font-bold text-rose-400 leading-tight truncate";
    if (banner) {
      banner.className = "bg-rose-950/95 border-b border-rose-600 px-4 py-2.5 text-xs text-rose-100 flex flex-wrap items-center justify-between gap-2 animate-pulse";
    }
    if (bannerBtn) {
      bannerBtn.className = "px-3 py-1 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-bold border border-rose-400 transition flex items-center gap-1.5 shadow";
    }
    const reasons = [];
    let customBtn = "Guide Réarmement (P3)";
    const tf = Number(latestData.temp_fumes ?? 0);

    if (latestData.popup_pellet_open || alarm === 16) {
      reasons.push("Trappe granulés ouverte");
      customBtn = "Fermer la Trappe";
    }
    if (latestData.popup_door_open || alarm === 15) {
      reasons.push("Porte foyer ouverte");
      customBtn = "Fermer la Porte";
    }
    if (alarm === 3) {
      reasons.push("AL03 - PELLET FINI");
      customBtn = (st === 10 && tf > 65) ? `Refroidissement (${tf}°C)` : "Guide Réarmement AL03 (P3)";
    } else if (alarm > 0 && alarm !== 15 && alarm !== 16) {
      reasons.push(latestData.alarm_label || `Alarme AL${alarm}`);
      customBtn = `Guide Alarme AL${alarm < 10 ? '0' + alarm : alarm}`;
    }
    if (isPelletEmpty) reasons.push("Trémie granulés vide");
    if (latestData.popup_pa_fault) reasons.push("Défaut Pressostat Pa");
    if (latestData.popup_tck_fault) reasons.push("Défaut Sonde Flamme K");
    if (latestData.popup_tcj_fault) reasons.push("Défaut Sonde Fumées");
    if (blackout > 0) reasons.push("Coupure secteur détectée (AL01)");

    const baseText = reasons.length ? `ALERTE SÉCURITÉ : ${reasons.join(" • ")}` : "ALERTE SÉCURITÉ ACTIVE SUR LE POÊLE";
    if (bannerText) {
      if (st === 10 && tf > 65) {
        bannerText.textContent = `${baseText} • ⏳ Refroidissement en cours (${tf}°C, extracteur actif)`;
      } else if (st === 11) {
        bannerText.textContent = `${baseText} • ❄️ Poêle refroidi (Mémoire Alarme) : Réarmement P3 requis`;
      } else {
        bannerText.textContent = baseText;
      }
    }
    if (bannerBtnText) bannerBtnText.textContent = customBtn;
  } else {
    if (isOnlyPelletEmpty) {
      if (banner) {
        banner.className = "bg-amber-950/95 border-b border-amber-500 px-4 py-2.5 text-xs text-amber-100 flex flex-wrap items-center justify-between gap-2";
      }
      if (bannerBtn) {
        bannerBtn.className = "px-3 py-1 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-bold border border-amber-400 transition flex items-center gap-1.5 shadow";
      }
      if (bannerText) {
        bannerText.textContent = "TRÉMIE GRANULÉS VIDE • Pas besoin d'acquitter l'alarme, il suffit de remettre du pellet";
      }
      if (bannerBtnText) {
        bannerBtnText.textContent = "Remettre du pellet";
      }
    } else if (banner) {
      banner.classList.add("hidden");
    }
    if (st === -1) {
      if (dot) dot.className = "w-7 h-7 sm:w-8 sm:h-8 rounded-full flex items-center justify-center text-sm sm:text-base bg-amber-600/90 text-white shadow-[0_0_10px_#f59e0b] animate-pulse flex-shrink-0 cursor-help border border-amber-400";
      if (kpiDot) kpiDot.className = "w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse shrink-0";
      stateEl.className = "text-sm sm:text-base font-bold text-amber-400 leading-tight truncate";
    } else if (st === 0) {
      if (dot) dot.className = "w-7 h-7 sm:w-8 sm:h-8 rounded-full flex items-center justify-center text-sm sm:text-base bg-slate-800 text-slate-300 border border-slate-700 shadow-inner flex-shrink-0 cursor-help";
      if (kpiDot) kpiDot.className = "w-2.5 h-2.5 rounded-full bg-gray-500 shrink-0";
      stateEl.className = "text-sm sm:text-base font-bold text-gray-300 leading-tight truncate";
    } else if (st >= 1 && st <= 4) {
      if (dot) dot.className = "w-7 h-7 sm:w-8 sm:h-8 rounded-full flex items-center justify-center text-sm sm:text-base bg-amber-500 text-gray-950 font-bold shadow-[0_0_12px_#f59e0b] animate-pulse flex-shrink-0 cursor-help border border-amber-300";
      if (kpiDot) kpiDot.className = "w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse shrink-0";
      stateEl.className = "text-sm sm:text-base font-bold text-amber-400 leading-tight truncate";
    } else if (st === 5) {
      if (dot) dot.className = "w-7 h-7 sm:w-8 sm:h-8 rounded-full flex items-center justify-center text-sm sm:text-base bg-orange-600 text-white shadow-[0_0_12px_#ea580c] flex-shrink-0 cursor-pointer border border-orange-400";
      if (kpiDot) kpiDot.className = "w-2.5 h-2.5 rounded-full bg-orange-500 animate-pulse shrink-0";
      if (stateEl) stateEl.className = "text-sm sm:text-base font-bold text-orange-400 leading-tight truncate";
    } else if (st === 6) {
      if (dot) dot.className = "w-7 h-7 sm:w-8 sm:h-8 rounded-full flex items-center justify-center text-sm sm:text-base bg-purple-600 text-white shadow-[0_0_12px_#a855f7] animate-pulse flex-shrink-0 cursor-help border border-purple-400";
      if (kpiDot) kpiDot.className = "w-2.5 h-2.5 rounded-full bg-purple-500 animate-pulse shrink-0";
      stateEl.className = "text-sm sm:text-base font-bold text-purple-400 leading-tight truncate";
    } else if (st === 7) {
      if (dot) dot.className = "w-7 h-7 sm:w-8 sm:h-8 rounded-full flex items-center justify-center text-sm sm:text-base bg-sky-600 text-white shadow-[0_0_10px_#0ea5e9] flex-shrink-0 cursor-help border border-sky-400";
      if (kpiDot) kpiDot.className = "w-2.5 h-2.5 rounded-full bg-sky-400 shrink-0";
      stateEl.className = "text-sm sm:text-base font-bold text-sky-400 leading-tight truncate";
    } else if (st === 8 || st === 9) {
      if (dot) dot.className = "w-7 h-7 sm:w-8 sm:h-8 rounded-full flex items-center justify-center text-sm sm:text-base bg-cyan-700 text-white shadow-[0_0_10px_#06b6d4] flex-shrink-0 cursor-help border border-cyan-400";
      if (kpiDot) kpiDot.className = "w-2.5 h-2.5 rounded-full bg-cyan-400 shrink-0";
      stateEl.className = "text-sm sm:text-base font-bold text-cyan-400 leading-tight truncate";
    } else {
      if (dot) dot.className = "w-7 h-7 sm:w-8 sm:h-8 rounded-full flex items-center justify-center text-sm sm:text-base bg-orange-500 text-white shadow-[0_0_10px_#f97316] flex-shrink-0 cursor-help border border-orange-400";
      if (kpiDot) kpiDot.className = "w-2.5 h-2.5 rounded-full bg-orange-400 shrink-0";
      stateEl.className = "text-sm sm:text-base font-bold text-orange-400 leading-tight truncate";
    }
  }
  updateConnectionIndicator();
}

async function reportClientError(source, message, severity = "ERROR") {
  try {
    if (window.stoveProvider && typeof window.stoveProvider.reportClientError === "function") {
      await window.stoveProvider.reportClientError(severity, source, message);
    }
    const logsTab = document.getElementById("tab-logs");
    if (logsTab && !logsTab.classList.contains("hidden") && typeof loadLogs === "function") {
      loadLogs(currentLogSeverity);
    }
  } catch (e) { }
}

window.addEventListener("error", (e) => {
  reportClientError("JS_ERROR", `${e.message} (${e.filename}:${e.lineno})`);
});
window.addEventListener("unhandledrejection", (e) => {
  reportClientError("PROMISE", e.reason?.message || String(e.reason));
});
