// =============================================================================
// REGISTRE DES INTERFACES DE PILOTAGE (TRI-ARC + 10 ALTERNATIVES UX/UI)
// Helpers partagés, barre de validation non-bloquante & interactions tactiles
// =============================================================================

const COCKPIT_UI_MODES = [
  {
    id: "triarc",
    num: 0,
    name: "Tri-Arc V10 (Original)",
    shortName: "Tri-Arc Original",
    badge: "Original",
    inspiration: "Cockpit circulaire 3 arcs",
    desc: "Cadrans concentriques tactiles avec carrousel SX ⇄ Poêle ⇄ DX et validation modale.",
    previewSvg: `<svg viewBox="0 0 80 48" class="w-full h-12" fill="none">
      <rect x="6" y="4" width="18" height="7" rx="3" stroke="#06b6d4" stroke-width="1.3"/>
      <rect x="34" y="4" width="12" height="7" rx="3" stroke="#f97316" stroke-width="1.3"/>
      <rect x="56" y="4" width="18" height="7" rx="3" stroke="#38bdf8" stroke-width="1.3"/>
      <circle cx="40" cy="27" r="10" stroke="#f97316" stroke-width="2" stroke-dasharray="46 20"/>
      <path d="M22 18 A20 20 0 0 0 22 36" stroke="#38bdf8" stroke-width="2" stroke-linecap="round"/>
      <path d="M58 18 A20 20 0 0 1 58 36" stroke="#ea580c" stroke-width="2" stroke-linecap="round"/>
      <rect x="10" y="41" width="60" height="4" rx="2" fill="#1e293b"/>
    </svg>`
  },
  {
    id: "thermostat",
    num: 1,
    name: "Thermostat + Segmentés",
    shortName: "Thermostat",
    badge: "Nest · Loi de Hick",
    inspiration: "Google Nest / Ecobee",
    desc: "1 cadran unique très lisible avec boutons −/+ et barres segmentées précises.",
    previewSvg: `<svg viewBox="0 0 80 48" class="w-full h-12" fill="none">
      <rect x="14" y="3" width="52" height="6" rx="3" fill="#1e293b"/>
      <rect x="15" y="4" width="16" height="4" rx="2" fill="#f97316"/>
      <circle cx="40" cy="21" r="10" stroke="#f97316" stroke-width="2" stroke-dasharray="48 18"/>
      <circle cx="40" cy="21" r="2.5" fill="#fff"/>
      <rect x="10" y="35" width="60" height="5" rx="2" fill="#0f172a" stroke="#38bdf8" stroke-width="1"/>
      <rect x="10" y="42" width="60" height="4" rx="2" fill="#0f172a" stroke="#ea580c" stroke-width="1"/>
    </svg>`
  },
  {
    id: "bento",
    num: 2,
    name: "Bento Grid Modulaire",
    shortName: "Bento Grid",
    badge: "iOS · Gestalt",
    inspiration: "Apple Widgets / Linear",
    desc: "Tuiles modulaires équilibrées : température héro, puissance, ventilation, SX/DX et modes.",
    previewSvg: `<svg viewBox="0 0 80 48" class="w-full h-12" fill="none">
      <rect x="6" y="4" width="44" height="19" rx="4" fill="#0f172a" stroke="#f97316" stroke-width="1.3"/>
      <rect x="53" y="4" width="21" height="9" rx="3" fill="#0f172a" stroke="#ea580c" stroke-width="1.2"/>
      <rect x="53" y="15" width="21" height="8" rx="3" fill="#0f172a" stroke="#f59e0b" stroke-width="1.2"/>
      <rect x="6" y="26" width="21" height="10" rx="3" fill="#0f172a" stroke="#38bdf8" stroke-width="1.2"/>
      <rect x="30" y="26" width="21" height="10" rx="3" fill="#0f172a" stroke="#06b6d4" stroke-width="1.2"/>
      <rect x="53" y="26" width="21" height="10" rx="3" fill="#0f172a" stroke="#64748b" stroke-width="1.2"/>
      <rect x="6" y="39" width="68" height="6" rx="2.5" fill="#1e293b"/>
    </svg>`
  },
  {
    id: "faders",
    num: 3,
    name: "Faders Verticaux",
    shortName: "Faders",
    badge: "HomeKit · Fitts",
    inspiration: "Apple Control Center",
    desc: "3 colonnes tactiles à glisser verticalement (Ventil, Température, Puissance) sans chevauchement.",
    previewSvg: `<svg viewBox="0 0 80 48" class="w-full h-12" fill="none">
      <rect x="11" y="6" width="14" height="33" rx="5" fill="#0f172a" stroke="#38bdf8" stroke-width="1.3"/>
      <rect x="12" y="21" width="12" height="17" rx="4" fill="#0284c7" fill-opacity="0.7"/>
      <rect x="29" y="4" width="22" height="35" rx="6" fill="#0f172a" stroke="#f97316" stroke-width="1.5"/>
      <rect x="30" y="16" width="20" height="22" rx="5" fill="#ea580c" fill-opacity="0.75"/>
      <rect x="55" y="6" width="14" height="33" rx="5" fill="#0f172a" stroke="#fb923c" stroke-width="1.3"/>
      <rect x="56" y="18" width="12" height="20" rx="4" fill="#f97316" fill-opacity="0.7"/>
      <rect x="11" y="42" width="58" height="4" rx="2" fill="#1e293b"/>
    </svg>`
  },
  {
    id: "thumb_zone",
    num: 4,
    name: "Thumb-Zone (1 Main)",
    shortName: "Thumb-Zone",
    badge: "One UI · Hoober",
    inspiration: "Samsung One UI",
    desc: "Lecture géante dans le haut de l'écran et toutes les commandes regroupées sous le pouce en bas.",
    previewSvg: `<svg viewBox="0 0 80 48" class="w-full h-12" fill="none">
      <text x="40" y="16" text-anchor="middle" fill="#fff" font-size="11" font-weight="bold">21°</text>
      <line x1="12" y1="22" x2="68" y2="22" stroke="#334155" stroke-dasharray="2 2"/>
      <rect x="10" y="25" width="60" height="8" rx="3" fill="#0f172a" stroke="#f97316" stroke-width="1.3"/>
      <rect x="10" y="35" width="18" height="9" rx="3" fill="#1e293b"/>
      <rect x="31" y="35" width="18" height="9" rx="3" fill="#1e293b"/>
      <rect x="52" y="35" width="18" height="9" rx="3" fill="#ea580c"/>
    </svg>`
  },
  {
    id: "cards_accordion",
    num: 5,
    name: "Cartes Empilées",
    shortName: "Cartes",
    badge: "Material 3 · Tado",
    inspiration: "Google Home / Tado",
    desc: "Zéro carrousel : Salon, SX et DX visibles ensemble en accordéons dépliables au tap.",
    previewSvg: `<svg viewBox="0 0 80 48" class="w-full h-12" fill="none">
      <rect x="8" y="4" width="64" height="14" rx="4" fill="#0f172a" stroke="#f97316" stroke-width="1.3"/>
      <rect x="8" y="21" width="64" height="9" rx="3" fill="#0f172a" stroke="#06b6d4" stroke-width="1.2"/>
      <rect x="8" y="32" width="64" height="9" rx="3" fill="#0f172a" stroke="#38bdf8" stroke-width="1.2"/>
      <rect x="8" y="43" width="64" height="3" rx="1.5" fill="#1e293b"/>
    </svg>`
  },
  {
    id: "intentions",
    num: 6,
    name: "Intentions & Scénarios",
    shortName: "Intentions",
    badge: "Hue · Modèle Mental",
    inspiration: "Philips Hue / Sonos",
    desc: "3 cartes d'intention claires (Confort Auto, Coup de chaud, Soirée calme) + tiroir manuel.",
    previewSvg: `<svg viewBox="0 0 80 48" class="w-full h-12" fill="none">
      <rect x="10" y="4" width="60" height="10" rx="3" fill="#0f172a" stroke="#f97316" stroke-width="1.2"/>
      <rect x="10" y="17" width="28" height="11" rx="4" fill="#0f172a" stroke="#06b6d4" stroke-width="1.3"/>
      <rect x="42" y="17" width="28" height="11" rx="4" fill="#0f172a" stroke="#f43f5e" stroke-width="1.3"/>
      <rect x="10" y="30" width="28" height="11" rx="4" fill="#0f172a" stroke="#a855f7" stroke-width="1.3"/>
      <rect x="42" y="30" width="28" height="11" rx="4" fill="#0f172a" stroke="#10b981" stroke-width="1.3"/>
      <rect x="20" y="43" width="40" height="3" rx="1.5" fill="#334155"/>
    </svg>`
  },
  {
    id: "context_hmi",
    num: 7,
    name: "Contextuel par État",
    shortName: "Context HMI",
    badge: "Auto HMI · Tesla",
    inspiration: "Tesla / Rivian",
    desc: "N'affiche que les contrôles utiles selon l'état réel (Éteint, Allumage, Auto, Manuel ou Alarme).",
    previewSvg: `<svg viewBox="0 0 80 48" class="w-full h-12" fill="none">
      <rect x="16" y="4" width="48" height="6" rx="3" fill="#7c2d12" stroke="#f97316" stroke-width="1"/>
      <circle cx="24" cy="22" r="7" fill="#ea580c" fill-opacity="0.25" stroke="#f97316" stroke-width="1.5"/>
      <rect x="35" y="14" width="33" height="16" rx="4" fill="#0f172a" stroke="#334155" stroke-width="1.2"/>
      <rect x="10" y="34" width="60" height="10" rx="3" fill="#0f172a" stroke="#1e293b"/>
    </svg>`
  },
  {
    id: "spatial_flow",
    num: 8,
    name: "Vue Spatiale & Flux",
    shortName: "Spatial Flux",
    badge: "Daikin · Mapping",
    inspiration: "Daikin Onecta / Plans",
    desc: "Schéma animé Poêle ↔ SX / DX : touchez une pièce sur le flux pour l'ajuster en direct.",
    previewSvg: `<svg viewBox="0 0 80 48" class="w-full h-12" fill="none">
      <circle cx="14" cy="17" r="7" fill="#0f172a" stroke="#06b6d4" stroke-width="1.4"/>
      <circle cx="40" cy="17" r="9" fill="#0f172a" stroke="#f97316" stroke-width="1.6"/>
      <circle cx="66" cy="17" r="7" fill="#0f172a" stroke="#38bdf8" stroke-width="1.4"/>
      <line x1="21" y1="17" x2="31" y2="17" stroke="#22d3ee" stroke-dasharray="2 2" stroke-width="1.5"/>
      <line x1="49" y1="17" x2="59" y2="17" stroke="#38bdf8" stroke-dasharray="2 2" stroke-width="1.5"/>
      <rect x="10" y="30" width="60" height="14" rx="4" fill="#0f172a" stroke="#334155"/>
    </svg>`
  },
  {
    id: "vernier",
    num: 9,
    name: "Règle Haptique Vernier",
    shortName: "Vernier",
    badge: "Braun · Précision",
    inspiration: "Dieter Rams / Molette iOS",
    desc: "Règle graduée horizontale glissante à retour haptique pour régler Temp, Ventil ou Puissance.",
    previewSvg: `<svg viewBox="0 0 80 48" class="w-full h-12" fill="none">
      <text x="40" y="15" text-anchor="middle" fill="#fb923c" font-size="11" font-weight="bold">21°</text>
      <rect x="8" y="19" width="64" height="12" rx="4" fill="#0f172a" stroke="#334155"/>
      <line x1="40" y1="19" x2="40" y2="31" stroke="#f97316" stroke-width="2"/>
      <line x1="20" y1="22" x2="20" y2="28" stroke="#64748b"/>
      <line x1="30" y1="21" x2="30" y2="29" stroke="#94a3b8"/>
      <line x1="50" y1="21" x2="50" y2="29" stroke="#94a3b8"/>
      <line x1="60" y1="22" x2="60" y2="28" stroke="#64748b"/>
      <rect x="12" y="35" width="56" height="8" rx="3" fill="#1e293b"/>
    </svg>`
  },
  {
    id: "ambient_glass",
    num: 10,
    name: "Ambient Calm Glass",
    shortName: "Calm Glass",
    badge: "Liquid Glass · Zen",
    inspiration: "Apple Météo / Spotify",
    desc: "Halo lumineux selon l'état du poêle, typographie aérienne et dock flottant avec feuilles basses.",
    previewSvg: `<svg viewBox="0 0 80 48" class="w-full h-12" fill="none">
      <circle cx="40" cy="20" r="16" fill="#ea580c" fill-opacity="0.22"/>
      <text x="40" y="23" text-anchor="middle" fill="#fff" font-size="12" font-weight="bold">20.4°</text>
      <rect x="16" y="34" width="48" height="10" rx="5" fill="#0f172a" stroke="#475569" stroke-width="1.2"/>
      <circle cx="26" cy="39" r="2.5" fill="#ea580c"/>
      <circle cx="40" cy="39" r="2.5" fill="#38bdf8"/>
      <circle cx="54" cy="39" r="2.5" fill="#94a3b8"/>
    </svg>`
  }
];

const COCKPIT_UI_STORAGE_KEY = "stove_cockpit_ui_mode_cache";

const cockpitAltState = {
  zone: "AMB",
  expandedCards: { AMB: false, SX: false, DX: false },
  manualOpen: false,
  vernierAxis: "temp",
  sheet: null // null | "manual" | "modes"
};

let cockpitAltDrag = null;

function isValidCockpitUiMode(modeId) {
  return COCKPIT_UI_MODES.some(m => m.id === modeId);
}

function getCockpitUiMeta(modeId) {
  return COCKPIT_UI_MODES.find(m => m.id === modeId) || COCKPIT_UI_MODES[0];
}

function getActiveCockpitUiMode() {
  const fromSettings = typeof currentSettings !== "undefined" && currentSettings ? currentSettings.cockpit_ui_mode : "";
  if (fromSettings && isValidCockpitUiMode(fromSettings)) return fromSettings;

  const fromPrefs = window.stoveProvider?.prefs?.cockpit_ui_mode || "";
  if (fromPrefs && isValidCockpitUiMode(fromPrefs)) return fromPrefs;

  try {
    const cached = localStorage.getItem(COCKPIT_UI_STORAGE_KEY);
    if (cached && isValidCockpitUiMode(cached)) return cached;
  } catch {
    // ignore storage errors
  }
  return "triarc";
}

function syncCockpitUiControlClasses(modeId) {
  const tabControl = document.getElementById("tab-control");
  const isAlt = modeId !== "triarc";
  if (tabControl) {
    tabControl.classList.toggle("cockpit-alt-active", isAlt);
  }
  const controlVisible = tabControl && !tabControl.classList.contains("hidden");
  if (controlVisible && window.innerWidth < 768 && !isAlt) {
    document.documentElement.classList.add("overflow-y-hidden");
    document.body.classList.add("overflow-y-hidden");
  } else {
    document.documentElement.classList.remove("overflow-y-hidden");
    document.body.classList.remove("overflow-y-hidden");
  }
}

async function setActiveCockpitUiMode(modeId, options = {}) {
  const { persist = true, silent = false } = options;
  const validId = isValidCockpitUiMode(modeId) ? modeId : "triarc";

  try {
    localStorage.setItem(COCKPIT_UI_STORAGE_KEY, validId);
  } catch {
    // ignore
  }

  if (typeof currentSettings !== "undefined" && currentSettings && typeof currentSettings === "object") {
    currentSettings.cockpit_ui_mode = validId;
  }
  if (window.stoveProvider?.prefs && typeof window.stoveProvider.prefs === "object") {
    window.stoveProvider.prefs.cockpit_ui_mode = validId;
  }

  const hiddenInp = document.getElementById("cfg-cockpit-ui-mode");
  if (hiddenInp) hiddenInp.value = validId;

  cockpitAltState.sheet = null;
  if (typeof triArcExpandedMode !== "undefined") {
    triArcExpandedMode = null;
  }

  syncCockpitUiControlClasses(validId);
  renderCockpitUiSettingsGrid();
  if (typeof updateSettingsAccordionSummaries === "function") {
    updateSettingsAccordionSummaries();
  }
  if (typeof renderTriArcCockpit === "function") {
    renderTriArcCockpit();
  }

  if (persist && window.stoveProvider && typeof window.stoveProvider.saveSettings === "function") {
    try {
      await window.stoveProvider.saveSettings({ cockpit_ui_mode: validId });
    } catch {
      // Sauvegarde locale déjà effectuée via localStorage/prefs
    }
  }

  if (!silent && typeof showToast === "function") {
    const meta = getCockpitUiMeta(validId);
    showToast(`🎨 Interface active : ${meta.name}`);
  }
}

function renderCockpitUiSettingsGrid() {
  const grid = document.getElementById("cockpit-ui-picker-grid");
  if (!grid) return;
  const activeId = getActiveCockpitUiMode();

  grid.innerHTML = COCKPIT_UI_MODES.map((m) => {
    const isActive = m.id === activeId;
    return `
      <button type="button" data-ui-mode-card="${m.id}" onclick="setActiveCockpitUiMode('${m.id}')"
        class="text-left rounded-2xl border p-3 transition-all cursor-pointer flex flex-col gap-2 ${isActive
          ? "bg-orange-950/35 border-orange-400 shadow-[0_0_18px_rgba(249,115,22,0.25)] ring-1 ring-orange-400/50"
          : "bg-slate-950/75 border-slate-800 hover:border-slate-600 hover:bg-slate-900/80"}">
        <div class="rounded-xl bg-[#070b14] border border-slate-800/90 p-1.5 overflow-hidden">
          ${m.previewSvg}
        </div>
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="text-xs font-extrabold ${isActive ? "text-orange-300" : "text-white"} truncate">
              ${m.num === 0 ? "★" : `#${m.num}`} ${escapeHtml(m.name)}
            </div>
            <div class="text-[10px] text-slate-400 truncate">${escapeHtml(m.inspiration)}</div>
          </div>
          <span class="text-[9.5px] font-bold px-2 py-0.5 rounded-full shrink-0 border ${isActive
            ? "bg-orange-600 text-white border-orange-300"
            : "bg-slate-900 text-slate-300 border-slate-700"}">
            ${isActive ? "Actif" : escapeHtml(m.badge)}
          </span>
        </div>
        <p class="text-[11px] leading-snug text-slate-300">${escapeHtml(m.desc)}</p>
      </button>
    `;
  }).join("");
}

function triggerCockpitHaptic() {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(8);
    }
  } catch {
    // ignore
  }
}

function getCockpitActiveZone(caps) {
  const ducts = Array.isArray(caps?.ducts) ? caps.ducts : [];
  let z = cockpitAltState.zone || "AMB";
  if (z === "SX" && !ducts.some(d => d.id === "SX")) z = "AMB";
  if (z === "DX" && !ducts.some(d => d.id === "DX")) z = "AMB";
  cockpitAltState.zone = z;
  return z;
}

function cockpitSelectZone(z) {
  const caps = _getTriArcCaps();
  const ducts = Array.isArray(caps.ducts) ? caps.ducts : [];
  if (z === "SX" && !ducts.some(d => d.id === "SX")) z = "AMB";
  if (z === "DX" && !ducts.some(d => d.id === "DX")) z = "AMB";
  cockpitAltState.zone = z;
  if (typeof triArcZone !== "undefined") triArcZone = z;
  if (z !== "AMB" && cockpitAltState.vernierAxis === "pwr") {
    cockpitAltState.vernierAxis = "temp";
  }
  triggerCockpitHaptic();
  renderTriArcCockpit();
}

function getCockpitZoneValues(zone, T, caps) {
  const realT = zone === "AMB" ? T.realAmb : (zone === "SX" ? T.realSx : T.realDx);
  const spT = zone === "AMB" ? T.spAmb : (zone === "SX" ? T.spSx : T.spDx);
  const fanSp = zone === "AMB" ? T.fanAmb : (zone === "SX" ? T.fanSx : T.fanDx);
  const fanReal = zone === "AMB" ? T.realFanAmb : (zone === "SX" ? T.realFanSx : T.realFanDx);
  const showFan = (zone !== "AMB") || caps.has_fan_front !== false;
  const showPwr = zone === "AMB";
  const label = zone === "AMB" ? (caps.stove_type === "hydro" ? "Eau / Chaudière" : "Salon") : getDuctName(zone);
  const tempKey = zone === "AMB" ? "temp_amb_setpoint" : (zone === "SX" ? "duct_left_setpoint" : "duct_right_setpoint");
  const fanKey = zone === "AMB" ? "fan_front_speed" : (zone === "SX" ? "duct_left_speed" : "duct_right_speed");
  return { realT, spT, fanSp, fanReal, showFan, showPwr, label, tempKey, fanKey };
}

function cockpitStepTemp(zone, delta) {
  const caps = _getTriArcCaps();
  const tMin = Number(caps.temp_min ?? 7);
  const tMax = Number(caps.temp_max ?? 41);
  const key = zone === "AMB" ? "temp_amb_setpoint" : (zone === "SX" ? "duct_left_setpoint" : "duct_right_setpoint");
  const cur = Number(getTriArcLiveOrOpt(key, getRegVal(key, 20)));
  const next = Math.max(tMin, Math.min(tMax, Math.round(cur + Number(delta))));
  if (next === cur) return;
  triggerCockpitHaptic();
  queueTriArcChanges([{ reg_key: key, value: next }]);
}

function cockpitSetTemp(zone, val) {
  const caps = _getTriArcCaps();
  const tMin = Number(caps.temp_min ?? 7);
  const tMax = Number(caps.temp_max ?? 41);
  const key = zone === "AMB" ? "temp_amb_setpoint" : (zone === "SX" ? "duct_left_setpoint" : "duct_right_setpoint");
  const next = Math.max(tMin, Math.min(tMax, Math.round(Number(val))));
  triggerCockpitHaptic();
  queueTriArcChanges([{ reg_key: key, value: next }]);
}

function cockpitSetFan(zone, val) {
  const caps = _getTriArcCaps();
  const fanMax = Math.max(1, Number(caps.fan_max ?? 8));
  const v = Math.max(0, Math.min(fanMax, Math.round(Number(val))));
  const key = zone === "AMB" ? "fan_front_speed" : (zone === "SX" ? "duct_left_speed" : "duct_right_speed");
  const changes = [];
  if (zone === "AMB" && v < 8) {
    const autoCur = Number(getTriArcLiveOrOpt("fun_auto_set", getRegVal("fun_auto_set", latestData.fun_auto_set ?? 0)));
    if (autoCur === 1) changes.push({ reg_key: "fun_auto_set", value: 0 });
  }
  changes.push({ reg_key: key, value: v });
  triggerCockpitHaptic();
  queueTriArcChanges(changes);
}

function cockpitStepFan(zone, delta) {
  const caps = _getTriArcCaps();
  const fanMax = Math.max(1, Number(caps.fan_max ?? 8));
  const key = zone === "AMB" ? "fan_front_speed" : (zone === "SX" ? "duct_left_speed" : "duct_right_speed");
  const cur = Number(getTriArcLiveOrOpt(key, getRegVal(key, zone === "AMB" ? 3 : 0)));
  const next = Math.max(0, Math.min(fanMax, Math.round(cur + Number(delta))));
  cockpitSetFan(zone, next);
}

function cockpitSetPower(val) {
  const caps = _getTriArcCaps();
  const pMin = Math.max(1, Number(caps.power_min ?? 1));
  const pMax = Math.max(pMin, Number(caps.power_max ?? 7));
  const v = Math.max(pMin, Math.min(pMax, Math.round(Number(val))));
  const changes = [{ reg_key: "power_level", value: v }];
  const pwfCur = Number(getTriArcLiveOrOpt("fun_pwf_set", getRegVal("fun_pwf_set", latestData.fun_pwf_set ?? 0)));
  if (pwfCur > 0) changes.unshift({ reg_key: "fun_pwf_set", value: 0 });
  const autoCur = Number(getTriArcLiveOrOpt("fun_auto_set", getRegVal("fun_auto_set", latestData.fun_auto_set ?? 0)));
  if (autoCur === 1) changes.unshift({ reg_key: "fun_auto_set", value: 0 });
  triggerCockpitHaptic();
  queueTriArcChanges(changes);
}

function cockpitStepPower(delta) {
  const cur = Number(getTriArcLiveOrOpt("power_level", getRegVal("power_level", 4)));
  cockpitSetPower(cur + Number(delta));
}

function cockpitToggleAccordion(zoneKey) {
  cockpitAltState.expandedCards[zoneKey] = !cockpitAltState.expandedCards[zoneKey];
  renderTriArcCockpit();
}

function cockpitToggleManualDrawer() {
  cockpitAltState.manualOpen = !cockpitAltState.manualOpen;
  renderTriArcCockpit();
}

function cockpitSetVernierAxis(axis) {
  cockpitAltState.vernierAxis = axis;
  triggerCockpitHaptic();
  renderTriArcCockpit();
}

function cockpitOpenSheet(sheetName) {
  cockpitAltState.sheet = cockpitAltState.sheet === sheetName ? null : sheetName;
  renderTriArcCockpit();
}

function cockpitCloseSheet() {
  cockpitAltState.sheet = null;
  renderTriArcCockpit();
}

function renderCockpitPowerBtn(T, extraCls = "h-12 w-12 rounded-2xl") {
  let cls = "bg-orange-600/90 border-orange-400 text-white shadow-[0_0_14px_rgba(234,88,12,0.45)]";
  if (T.isAlarm) {
    cls = "bg-rose-700 border-rose-300 text-white shadow-[0_0_16px_rgba(244,63,94,0.65)] animate-pulse";
  } else if (T.st === 0) {
    cls = "bg-rose-950/90 border-rose-500 text-rose-200";
  }
  return `
    <button type="button" onclick="handleDynamicPowerAction()" title="Bouton Marche / Arrêt Poêle"
      class="${extraCls} border-2 flex items-center justify-center shrink-0 transition hover:brightness-110 active:scale-95 cursor-pointer ${cls}">
      <svg viewBox="0 0 24 24" class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2v10" />
        <path d="M18.4 6.6a9 9 0 1 1-12.77.04" />
      </svg>
    </button>
  `;
}

function renderCockpitPhasePill(T, compact = false) {
  const phaseLines = formatPhaseTwoLines(T.phaseLabel, typeof getPhaseMeta === "function" ? getPhaseMeta(T.st) : null);
  return `
    <button type="button" onclick="openLifecycleFlowerModal()" title="Voir le cycle de vie du poêle"
      class="inline-flex items-center gap-2 rounded-2xl bg-slate-900/90 border px-3 ${compact ? "py-1.5 text-xs" : "py-2 text-xs"} font-bold transition hover:brightness-110 cursor-pointer min-w-0"
      style="border-color:${T.phaseColor}88">
      <span class="w-2.5 h-2.5 rounded-full shrink-0 ${T.st !== 0 ? "animate-pulse" : ""}" style="background:${T.phaseColor}"></span>
      <span class="truncate text-white font-extrabold">${T.phaseIcon} ${escapeHtml(phaseLines.line1)}</span>
      ${!compact && phaseLines.line2 ? `<span class="text-[11px] text-slate-400 truncate hidden sm:inline">(${escapeHtml(phaseLines.line2)})</span>` : ""}
      <span class="text-slate-500 text-[10px]">▸</span>
    </button>
  `;
}

function renderCockpitZoneTabs(zone, T, caps) {
  const ducts = Array.isArray(caps?.ducts) ? caps.ducts : [];
  if (ducts.length === 0) return "";
  const tabs = [
    { id: "AMB", label: caps.stove_type === "hydro" ? "Chaudière" : "Salon", val: `${T.realAmb}°→${fmtTriArcTempSp(T.spAmb)}`, activeCls: "bg-orange-600/25 border-orange-400 text-orange-200" }
  ];
  if (ducts.some(d => d.id === "SX")) {
    tabs.push({ id: "SX", label: getDuctName("SX"), val: `${T.realSx}°→${fmtTriArcTempSp(T.spSx)}`, activeCls: "bg-cyan-600/25 border-cyan-400 text-cyan-200" });
  }
  if (ducts.some(d => d.id === "DX")) {
    tabs.push({ id: "DX", label: getDuctName("DX"), val: `${T.realDx}°→${fmtTriArcTempSp(T.spDx)}`, activeCls: "bg-sky-600/25 border-sky-400 text-sky-200" });
  }
  return `
    <div class="grid gap-1.5 bg-slate-950/90 border border-slate-800 p-1 rounded-2xl" style="grid-template-columns: repeat(${tabs.length}, minmax(0, 1fr));">
      ${tabs.map(t => `
        <button type="button" onclick="cockpitSelectZone('${t.id}')"
          class="rounded-xl px-2 py-1.5 border text-center transition cursor-pointer ${zone === t.id ? t.activeCls + " shadow-sm" : "border-transparent text-slate-400 hover:text-white"}">
          <div class="text-[11px] font-extrabold truncate">${escapeHtml(t.label)}</div>
          <div class="text-[10px] font-mono opacity-90 tabular-nums">${t.val}</div>
        </button>
      `).join("")}
    </div>
  `;
}

function renderCockpitModeBar(T, zone, compact = false) {
  const caps = _getTriArcCaps();
  const isContainerSil = Boolean(T.isContainerSil);
  const silTimerActive = isContainerSil && T.isSilActive && T.remSec > 0;
  const silBtnActive = isContainerSil ? silTimerActive : Boolean(T.isSilActive);
  const silTimerTxt = silTimerActive
    ? `${Math.floor(T.remSec / 3600)}h${String(Math.floor((T.remSec % 3600) / 60)).padStart(2, "0")}`
    : "";
  const silLabel = silTimerActive ? silTimerTxt : (silBtnActive ? "Actif" : "Silence");
  const zoneAutoIdx = getTriArcZoneAutoIdx(zone, T);

  const buttons = [
    `
      <button type="button" onclick="toggleTriArcOptionBubble('silence')"
        title="${isContainerSil ? "Mode Silence (Timer Conteneur)" : "Mode Silence (Sans temporisation)"}"
        class="flex-1 ${compact ? "h-11" : "h-13 py-2"} rounded-2xl border flex flex-col items-center justify-center transition cursor-pointer ${silBtnActive ? "bg-purple-950/75 border-purple-400 text-white" : "bg-slate-900/90 border-slate-700 text-slate-300 hover:border-purple-400"}">
        <span class="text-lg leading-none">🤫</span>
        <span ${silTimerActive ? 'id="triarc-silence-btn-timer"' : ""} class="text-[10px] font-bold mt-0.5 tabular-nums">${silLabel}</span>
      </button>
    `
  ];
  if (caps.has_auto !== false) {
    const autoCls = zoneAutoIdx === 2
      ? "bg-orange-950/80 border-orange-400 text-orange-200"
      : (zoneAutoIdx === 1 ? "bg-cyan-950/80 border-cyan-400 text-cyan-200" : "bg-slate-900/90 border-slate-700 text-slate-300 hover:border-cyan-400");
    const autoTxt = zoneAutoIdx === 2 ? "Auto" : (zoneAutoIdx === 1 ? "Ventil" : "Auto");
    buttons.push(`
      <button type="button" onclick="toggleTriArcOptionBubble('auto')" title="Mode Auto"
        class="flex-1 ${compact ? "h-11" : "h-13 py-2"} rounded-2xl border flex flex-col items-center justify-center transition cursor-pointer ${autoCls}">
        <span class="text-sm leading-none flex items-center gap-0.5"><span>🔥</span>${svgPropellerFanIcon("w-3.5 h-3.5", "currentColor")}</span>
        <span class="text-[10px] font-bold mt-0.5">${autoTxt}</span>
      </button>
    `);
  }
  if (caps.has_boost !== false) {
    const boostCls = T.pwfVal === 1
      ? "bg-rose-950/80 border-rose-400 text-rose-200"
      : (T.pwfVal === 2 ? "bg-amber-950/80 border-amber-400 text-amber-200" : "bg-slate-900/90 border-slate-700 text-slate-300 hover:border-rose-400");
    buttons.push(`
      <button type="button" onclick="toggleTriArcOptionBubble('boost')" title="Mode Boost (Powerful)"
        class="flex-1 ${compact ? "h-11" : "h-13 py-2"} rounded-2xl border flex flex-col items-center justify-center transition cursor-pointer ${boostCls}">
        <span class="text-lg leading-none">🚀</span>
        <span class="text-[10px] font-bold mt-0.5">${T.pwfVal === 1 ? "Actif" : (T.pwfVal === 2 ? "Prog" : "Boost")}</span>
      </button>
    `);
  }
  if (buttons.length === 0) return "";
  return `<div class="flex items-stretch gap-2 w-full">${buttons.join("")}</div>`;
}

function renderCockpitPendingBar() {
  const items = typeof triArcPendingChanges !== "undefined" ? Object.values(triArcPendingChanges) : [];
  if (items.length === 0) return "";
  const summary = items.map(it => `${escapeHtml(it.fmt(it.oldVal))}→${escapeHtml(it.fmt(it.newVal))}`).join(" · ");
  return `
    <div id="cockpit-pending-bar" class="sticky bottom-1 z-30 mt-2 rounded-2xl bg-slate-900/95 backdrop-blur-md border-2 border-orange-500/80 px-3 py-2.5 shadow-[0_8px_30px_rgba(0,0,0,0.75)] flex items-center justify-between gap-2">
      <div class="min-w-0">
        <div class="text-[11px] font-extrabold text-orange-300">${items.length} réglage${items.length > 1 ? "s" : ""} en attente</div>
        <div class="text-[11px] font-mono text-slate-200 truncate">${summary}</div>
      </div>
      <div class="flex items-center gap-1.5 shrink-0">
        <button type="button" onclick="cancelTriArcPendingChanges()"
          class="px-2.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold border border-slate-700 cursor-pointer">
          Annuler
        </button>
        <button type="button" onclick="applyTriArcPendingChangesNow()"
          class="px-3 py-2 rounded-xl bg-orange-600 hover:bg-orange-500 text-white text-xs font-extrabold shadow cursor-pointer">
          ✓ Appliquer (${items.length})
        </button>
      </div>
    </div>
  `;
}

function renderCockpitSegmentedFan(zone, fanSp, fanReal, caps, isAutoLocked) {
  const fanMax = Math.max(1, Number(caps.fan_max ?? 8));
  if (isAutoLocked) {
    return `
      <div class="flex items-center justify-between gap-2 rounded-2xl bg-cyan-950/35 border border-cyan-500/40 px-3 py-2 text-xs">
        <span class="text-cyan-200 font-bold flex items-center gap-1.5">
          ${svgPropellerFanIcon("w-4 h-4", "#22d3ee")}
          <span>Ventilation Auto · Réel ${fmtTriArcFan(fanReal)}</span>
        </span>
        <button type="button" onclick="setTriArcAutoOption(0)"
          class="px-2.5 py-1 rounded-lg bg-slate-900 border border-cyan-500/50 text-cyan-200 text-[11px] font-bold hover:bg-cyan-900/40 cursor-pointer">
          Manuel
        </button>
      </div>
    `;
  }
  const pills = [];
  for (let i = 0; i <= fanMax; i++) {
    const lbl = i === 0 ? "OFF" : (fanMax >= 8 && i === 8 ? "A" : String(i));
    const isSel = Math.round(fanSp) === i;
    const isReal = Math.round(fanReal) === i && fanReal > 0;
    pills.push(`
      <button type="button" onclick="cockpitSetFan('${zone}', ${i})"
        class="flex-1 min-w-0 py-2 rounded-xl text-[11px] font-extrabold border transition cursor-pointer ${isSel
          ? "bg-sky-600 border-sky-300 text-white shadow"
          : (isReal ? "bg-sky-950/70 border-sky-500/60 text-sky-200" : "bg-slate-950 border-slate-800 text-slate-400 hover:text-white")}">
        ${lbl}
      </button>
    `);
  }
  return `
    <div class="space-y-1">
      <div class="flex items-center justify-between text-[11px] px-0.5">
        <span class="font-bold text-sky-300 flex items-center gap-1">${svgPropellerFanIcon("w-3.5 h-3.5", "#38bdf8")} Ventilation</span>
        <span class="font-mono text-slate-300">Réel ${fmtTriArcFan(fanReal)} · Cible ${fmtTriArcFan(fanSp)}</span>
      </div>
      <div class="flex items-center gap-1">${pills.join("")}</div>
    </div>
  `;
}

function renderCockpitSegmentedPower(pwrSp, pwrReal, caps, isAutoTotal) {
  if (isAutoTotal) {
    return `
      <div class="flex items-center justify-between gap-2 rounded-2xl bg-orange-950/35 border border-orange-500/40 px-3 py-2 text-xs">
        <span class="text-orange-200 font-bold">🔥 Puissance Auto · Réel P${Math.round(pwrReal)}</span>
        <button type="button" onclick="setTriArcAutoOption(0)"
          class="px-2.5 py-1 rounded-lg bg-slate-900 border border-orange-500/50 text-orange-200 text-[11px] font-bold hover:bg-orange-900/40 cursor-pointer">
          Manuel
        </button>
      </div>
    `;
  }
  const pMin = Math.max(1, Number(caps.power_min ?? 1));
  const pMax = Math.max(pMin, Number(caps.power_max ?? 7));
  const pills = [];
  for (let i = pMin; i <= pMax; i++) {
    const isSel = Math.round(pwrSp) === i;
    const isReal = Math.round(pwrReal) === i;
    pills.push(`
      <button type="button" onclick="cockpitSetPower(${i})"
        class="flex-1 min-w-0 py-2 rounded-xl text-[11px] font-extrabold border transition cursor-pointer ${isSel
          ? "bg-orange-600 border-orange-300 text-white shadow"
          : (isReal ? "bg-orange-950/70 border-orange-500/60 text-orange-200" : "bg-slate-950 border-slate-800 text-slate-400 hover:text-white")}">
        P${i}
      </button>
    `);
  }
  return `
    <div class="space-y-1">
      <div class="flex items-center justify-between text-[11px] px-0.5">
        <span class="font-bold text-orange-300">🔥 Puissance combustion</span>
        <span class="font-mono text-slate-300">Réel P${Math.round(pwrReal)} · Cible P${Math.round(pwrSp)}</span>
      </div>
      <div class="flex items-center gap-1">${pills.join("")}</div>
    </div>
  `;
}

function renderCockpitManualPanel(T, zone, caps) {
  const Z = getCockpitZoneValues(zone, T, caps);
  const isFanAuto = (zone === "AMB") && (T.autoIdx === 1 || T.autoIdx === 2 || Z.fanSp === 8);
  const isAutoTotal = T.autoIdx === 2;
  return `
    <div class="space-y-3">
      ${renderCockpitZoneTabs(zone, T, caps)}
      <div class="flex items-center justify-between gap-2 bg-slate-950/80 border border-slate-800 rounded-2xl px-3 py-2.5">
        <div>
          <div class="text-[11px] text-slate-400 font-semibold">Consigne ${escapeHtml(Z.label)}</div>
          <div class="text-sm font-black text-white tabular-nums">Réel ${Z.realT}° <span class="text-orange-400">→</span> ${fmtTriArcTempSp(Z.spT)}</div>
        </div>
        <div class="flex items-center gap-2">
          <button type="button" onclick="cockpitStepTemp('${zone}', -1)" class="w-10 h-10 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-black text-lg cursor-pointer">−</button>
          <button type="button" onclick="cockpitStepTemp('${zone}', 1)" class="w-10 h-10 rounded-xl bg-orange-600 hover:bg-orange-500 text-white font-black text-lg cursor-pointer">+</button>
        </div>
      </div>
      ${Z.showFan ? renderCockpitSegmentedFan(zone, Z.fanSp, Z.fanReal, caps, isFanAuto) : ""}
      ${Z.showPwr ? renderCockpitSegmentedPower(T.pwrSp, T.realPwr, caps, isAutoTotal) : ""}
    </div>
  `;
}

function renderCockpitBottomSheet(T, zone, caps) {
  if (!cockpitAltState.sheet) return "";
  const isModes = cockpitAltState.sheet === "modes";
  const title = isModes ? "✨ Modes & Scénarios" : "🎚 Réglages manuels";
  const body = isModes
    ? `<div class="space-y-3">${renderCockpitModeBar(T, zone, false)}<p class="text-[11px] text-slate-400 text-center">Touchez un mode pour ouvrir ses options détaillées.</p></div>`
    : renderCockpitManualPanel(T, zone, caps);
  return `
    <div class="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm flex items-end justify-center p-2 sm:p-4"
      onclick="if(event.target===this){cockpitCloseSheet();}">
      <div class="w-full max-w-[480px] rounded-3xl bg-slate-900 border border-slate-700 p-4 space-y-3 shadow-2xl">
        <div class="flex items-center justify-between border-b border-slate-800 pb-2">
          <span class="text-sm font-extrabold text-white">${title}</span>
          <button type="button" onclick="cockpitCloseSheet()" class="w-8 h-8 rounded-full bg-slate-800 text-slate-300 font-bold cursor-pointer">✕</button>
        </div>
        ${body}
      </div>
    </div>
  `;
}

function initCockpitAltInteractions() {
  const root = document.getElementById("cockpit-alt-root");
  if (!root || root.dataset.altBound === "1") return;
  root.dataset.altBound = "1";

  const computeFaderValue = (track, clientY) => {
    const rect = track.getBoundingClientRect();
    const min = Number(track.dataset.min ?? 0);
    const max = Number(track.dataset.max ?? 10);
    const ratio = Math.max(0, Math.min(1, (rect.bottom - clientY) / Math.max(1, rect.height)));
    return Math.round(min + ratio * (max - min));
  };

  root.addEventListener("pointerdown", (e) => {
    const fader = e.target.closest ? e.target.closest("[data-fader-track]") : null;
    if (fader) {
      e.preventDefault();
      const zone = fader.dataset.zone || "AMB";
      const arcType = fader.dataset.faderType;
      const val = computeFaderValue(fader, e.clientY);
      cockpitAltDrag = { kind: "fader", zone, arcType, value: val };
      triArcDragging = { zone, arcType, value: val };
      triggerCockpitHaptic();
      renderTriArcCockpit();
      return;
    }

    const vernier = e.target.closest ? e.target.closest("[data-vernier-track]") : null;
    if (vernier) {
      e.preventDefault();
      const zone = vernier.dataset.zone || "AMB";
      const arcType = vernier.dataset.vernierAxis || "temp";
      const cur = Number(vernier.dataset.current ?? 20);
      const min = Number(vernier.dataset.min ?? 7);
      const max = Number(vernier.dataset.max ?? 41);
      cockpitAltDrag = {
        kind: "vernier",
        zone,
        arcType,
        startX: e.clientX,
        startVal: cur,
        min,
        max,
        value: cur
      };
    }
  });

  window.addEventListener("pointermove", (e) => {
    if (!cockpitAltDrag) return;
    if (cockpitAltDrag.kind === "fader") {
      const fader = root.querySelector(`[data-fader-track][data-fader-type="${cockpitAltDrag.arcType}"][data-zone="${cockpitAltDrag.zone}"]`);
      if (!fader) return;
      const val = computeFaderValue(fader, e.clientY);
      if (val !== cockpitAltDrag.value) {
        cockpitAltDrag.value = val;
        triArcDragging = { zone: cockpitAltDrag.zone, arcType: cockpitAltDrag.arcType, value: val };
        triggerCockpitHaptic();
        renderTriArcCockpit();
      }
    } else if (cockpitAltDrag.kind === "vernier") {
      const dx = e.clientX - cockpitAltDrag.startX;
      const stepPx = cockpitAltDrag.arcType === "temp" ? 18 : 26;
      const delta = Math.round(dx / stepPx);
      const val = Math.max(cockpitAltDrag.min, Math.min(cockpitAltDrag.max, cockpitAltDrag.startVal - delta));
      if (val !== cockpitAltDrag.value) {
        cockpitAltDrag.value = val;
        triArcDragging = { zone: cockpitAltDrag.zone, arcType: cockpitAltDrag.arcType, value: val };
        triggerCockpitHaptic();
        renderTriArcCockpit();
      }
    }
  });

  const finishAltDrag = () => {
    if (!cockpitAltDrag) return;
    const finished = { zone: cockpitAltDrag.zone, arcType: cockpitAltDrag.arcType, value: cockpitAltDrag.value };
    cockpitAltDrag = null;
    triArcDragging = null;
    commitTriArcDrag(finished);
  };

  window.addEventListener("pointerup", finishAltDrag);
  window.addEventListener("pointercancel", finishAltDrag);
}
