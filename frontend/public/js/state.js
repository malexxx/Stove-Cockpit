// =============================================================================
// STOVE COCKPIT — ÉTAT PARTAGÉ, CONSTANTES & FORMATAGE
// =============================================================================

let HOPPER_CAPACITY_KG = 35.0; // Capacité configurable de la trémie (kg)
const BAG_WEIGHT_KG = 15.0;

// Catalogue des courbes réparties entre Volet 1 (pane: 1) et Volet 2 (pane: 2)
const SERIES_CONFIG = [
  // VOLET 1 : Thermique, Canalisations, Consignes & Fumées
  { key: "temp_ambient", label: "T° Ambiante Salon", unit: "°C", color: "#10b981", pane: 1, yAxisID: "yTemp", group: "THERMAL", visible: true },
  { key: "temp_amb_setpoint", label: "Cons. T° Amb", unit: "°C", color: "#34d399", pane: 1, yAxisID: "yTemp", group: "CONTROL", visible: true, dashed: true },
  { key: "weather_temp_ext", label: "T° Extérieure", unit: "°C", color: "#3b82f6", pane: 1, yAxisID: "yTemp", group: "THERMAL", visible: true },
  { key: "duct_left_temp", label: "T° Canal. Gauche SX", unit: "°C", color: "#06b6d4", pane: 1, yAxisID: "yTemp", group: "DUCTS", visible: false },
  { key: "duct_left_setpoint", label: "Cons. Canal. SX", unit: "°C", color: "#67e8f9", pane: 1, yAxisID: "yTemp", group: "DUCTS", visible: false, dashed: true },
  { key: "duct_right_temp", label: "T° Canal. Droite DX", unit: "°C", color: "#0ea5e9", pane: 1, yAxisID: "yTemp", group: "DUCTS", visible: false },
  { key: "duct_right_setpoint", label: "Cons. Canal. DX", unit: "°C", color: "#7dd3fc", pane: 1, yAxisID: "yTemp", group: "DUCTS", visible: false, dashed: true },
  { key: "temp_fumes", label: "T° Fumées", unit: "°C", color: "#f97316", pane: 1, yAxisID: "yFume", group: "COMBUSTION", visible: true },
  { key: "temp_probe_k", label: "Sonde Flamme K", unit: "°C", color: "#ef4444", pane: 1, yAxisID: "yFume", group: "COMBUSTION", visible: true },

  // VOLET 2 : Puissance, Ventilation, Dépression, Extracteur RPM, Granulés & Tarages
  { key: "power_actual", label: "Puissance Réelle", unit: "P", color: "#eab308", pane: 2, yAxisID: "yPct", group: "COMBUSTION", visible: true },
  { key: "power_level", label: "Cons. Puiss.", unit: "P", color: "#f59e0b", pane: 2, yAxisID: "yPct", group: "CONTROL", visible: true, dashed: true },
  { key: "depression_pa", label: "Dépression", unit: "Pa", color: "#f43f5e", pane: 2, yAxisID: "yPct", group: "COMBUSTION", visible: true },
  { key: "flame_delta_avg", label: "Écart Thermique (Moy. 30m)", unit: "°C", color: "#fb7185", pane: 2, yAxisID: "yPct", group: "COMBUSTION", visible: true },
  { key: "exhaust_rpm", label: "Extracteur Fumées", unit: "RPM", color: "#a855f7", pane: 2, yAxisID: "yRpm", group: "MECHANICAL", visible: true },
  { key: "fan_front_speed", label: "Ventil. Faç.", unit: "/8", color: "#ec4899", pane: 2, yAxisID: "yPct", group: "CONTROL", visible: false },
  { key: "duct_left_speed", label: "Vit. Canal. SX", unit: "/8", color: "#14b8a6", pane: 2, yAxisID: "yPct", group: "DUCTS", visible: false },
  { key: "duct_right_speed", label: "Vit. Canal. DX", unit: "/8", color: "#6366f1", pane: 2, yAxisID: "yPct", group: "DUCTS", visible: false },
  { key: "trim_pellet_pct", label: "Tarage Granulés", unit: "%", color: "#c084fc", pane: 2, yAxisID: "yPct", group: "TRIM", visible: false, dashed: true },
  { key: "trim_exhaust_pct", label: "Tarage Fumées", unit: "%", color: "#e879f9", pane: 2, yAxisID: "yPct", group: "TRIM", visible: false, dashed: true },
  { key: "pellet_hopper_pct", label: "Niveau Trémie", unit: "%", color: "#84cc16", pane: 2, yAxisID: "yPct", group: "PELLETS", visible: false },
  { key: "pellet_rate_kgh", label: "Débit Granulés", unit: "kg/h", color: "#22c55e", pane: 2, yAxisID: "yPct", group: "PELLETS", visible: false }
];

const OFFSET_NAMES = {
  0: "temp_probe_k_get (°C)", 2: "temp_gas_flue_get (°C)", 8: "status_get", 11: "real_power_get",
  16: "vent_front2_get", 22: "thermostat_contacts", 28: "can_dx_temp_get (x2)", 29: "can_sx_temp_get (x2)",
  31: "can_dx_vent_get", 32: "can_sx_vent_get", 34: "alarms_get", 37: "pascal_get (x10)",
  40: "blackout_popup", 47: "giri_estrattore (/10)", 70: "trim_pellet_pct", 71: "trim_exhaust_pct",
  103: "temp_air2_get (°C)", 105: "enable_mask_105",
  107: "enable_mask_107", 115: "popups_bitmask", 232: "status_managed (85/170)", 260: "cat_service_hours",
  33120: "power_set (1..7)", 33122: "temp_air_set (°C)", 33124: "can_dx_temp_set", 33126: "can_sx_temp_set",
  33128: "fun_auto_set (Auto)", 33148: "comfortclima_ability_set", 33150: "comfortclima_time_set", 33152: "comfortclima_restart_set",
  33132: "vent_front_set", 33134: "can_dx_vent_set", 33136: "can_sx_vent_set",
  33154: "fun_pwf_set (0=OFF,1=ON,2=CRONO)", 33162: "chrono_week_enable",
  33164: "chrono_p1_start", 33166: "chrono_p1_stop", 33168: "chrono_p1_days_mask", 33170: "chrono_p1_power", 33172: "chrono_p1_temp",
  33174: "chrono_p1_tcanr", 33176: "chrono_p1_tcanl", 33178: "chrono_p1_fan_front", 33180: "chrono_p1_canr", 33182: "chrono_p1_canl",
  33184: "chrono_p2_start", 33186: "chrono_p2_stop", 33188: "chrono_p2_days_mask", 33190: "chrono_p2_power", 33192: "chrono_p2_temp",
  33194: "chrono_p2_tcanr", 33196: "chrono_p2_tcanl", 33198: "chrono_p2_fan_front", 33200: "chrono_p2_canr", 33202: "chrono_p2_canl",
  33204: "chrono_p3_start", 33206: "chrono_p3_stop", 33208: "chrono_p3_days_mask", 33210: "chrono_p3_power", 33212: "chrono_p3_temp",
  33214: "chrono_p3_tcanr", 33216: "chrono_p3_tcanl", 33218: "chrono_p3_fan_front", 33220: "chrono_p3_canr", 33222: "chrono_p3_canl",
  33224: "chrono_p4_start", 33226: "chrono_p4_stop", 33228: "chrono_p4_days_mask", 33230: "chrono_p4_power", 33232: "chrono_p4_temp",
  33234: "chrono_p4_tcanr", 33236: "chrono_p4_tcanl", 33238: "chrono_p4_fan_front", 33240: "chrono_p4_canr", 33242: "chrono_p4_canl",
  // #33250 (0x81E2) vérifié inactif sur Nobis A10 (carte T033.NBS.AIR.MB01, enable_mask_107 bit 2048 = 0) :
  // conservé en lecture seule pour documenter l'offset brut remonté par Agua Cloud.
  33250: "set_silece_set (inactif Nobis A10)",
  34048: "clock_hour", 34049: "clock_minute", 34050: "cal_day", 34051: "cal_month", 34052: "cal_year", 34053: "cal_weekday"
};

let currentRange = "24h";
let currentLogSeverity = "ALL";
let activePhaseViews = {
  prop1: true, // 1. Ruban Maître (Volet 3) + Bilan des durées
  prop2: true, // 2. Zones colorées en fond des courbes (Volets 1 & 2)
  prop3: true, // 3. Focus & Badge de phase au survol
  prop4: true  // 4. Stepper Cycle de vie & Chronologie des transitions
};
try {
  const savedViews = localStorage.getItem("nobis_active_phase_views");
  if (savedViews) {
    const parsed = JSON.parse(savedViews);
    if (parsed && typeof parsed === "object") {
      activePhaseViews = { ...activePhaseViews, ...parsed };
    }
  }
} catch (e) {}
let phaseBgOpacity = 0.12;
let chartPane1 = null;
let chartPane2 = null;
let activeHoverIdx = -1;
let latestData = {};
let registersCatalog = {};
let currentSettings = {};
let cachedSeriesRows = [];
let toastTimer = null;
let actionModalCallback = null;
let sseSource = null;
let silenceModeState = { active: false, remaining_seconds: 0, end_epoch: 0, duration_hours: 2.0 };

// Catalogue chromatique et technique des 12 phases officielles Micronova / Nobis A10
const STOVE_PHASE_META = {
  "-1": {
    code: -1, family: "GAP", short: "Hors ligne", label: "Perte de connexion", icon: "📡",
    hex: "#f43f5e", rgb: "244, 63, 94",
    bgClass: "bg-rose-950/40 border-x border-dashed border-rose-700/60 text-rose-300",
    badgeClass: "bg-rose-950/90 border-rose-600 text-rose-300",
    desc: "Aucune télémétrie reçue durant cet intervalle."
  },
  0: {
    code: 0, family: "OFF", short: "Éteint", label: "OFF (Éteint)", icon: "⚫",
    hex: "#475569", rgb: "71, 85, 105",
    bgClass: "bg-slate-800/90 text-slate-300",
    badgeClass: "bg-slate-900 border-slate-600 text-slate-300",
    desc: "Poêle à l'arrêt complet. Extracteur, vis sans fin et bougie coupés."
  },
  1: {
    code: 1, family: "IGNITION", short: "Check-up", label: "ATTENTE (Check-up)", icon: "🔍",
    hex: "#facc15", rgb: "250, 204, 21",
    bgClass: "bg-yellow-500/85 text-gray-950",
    badgeClass: "bg-yellow-950/90 border-yellow-500 text-yellow-300",
    desc: "Phase 1/4 d'allumage : Diagnostic des sondes, pressostat Pa et balayage initial du foyer."
  },
  2: {
    code: 2, family: "IGNITION", short: "Préchauff.", label: "DÉBUT (Préchauffage)", icon: "➰",
    hex: "#fbbf24", rgb: "251, 191, 36",
    bgClass: "bg-amber-400/90 text-gray-950",
    badgeClass: "bg-amber-950/90 border-amber-400 text-amber-200",
    desc: "Phase 2/4 d'allumage : Bougie de préchauffage incandescente active avant chute des granulés."
  },
  3: {
    code: 3, family: "IGNITION", short: "Chargement", label: "DÉBUT (Chargement pellet)", icon: "🪵",
    hex: "#f59e0b", rgb: "245, 158, 11",
    bgClass: "bg-amber-500/90 text-gray-950",
    badgeClass: "bg-amber-950/90 border-amber-500 text-amber-200",
    desc: "Phase 3/4 d'allumage : Remplissage de la dose initiale de granulés dans le brasier sur bougie chaude."
  },
  4: {
    code: 4, family: "IGNITION", short: "Allumage", label: "DÉBUT (Allumage flamme)", icon: "🪔",
    hex: "#f97316", rgb: "249, 115, 22",
    bgClass: "bg-orange-500/90 text-white",
    badgeClass: "bg-orange-950/90 border-orange-400 text-orange-200",
    desc: "Phase 4/4 d'allumage : Apparition de la flamme et montée en température (Sonde K & Fumées)."
  },
  5: {
    code: 5, family: "WORK", short: "Travail", label: "TRAVAIL (Normal)", icon: "🔥",
    hex: "#ea580c", rgb: "234, 88, 12",
    bgClass: "bg-orange-600/90 text-white",
    badgeClass: "bg-orange-950/90 border-orange-500 text-orange-300",
    desc: "Régime nominal stabilisé : Modulation de puissance P1..P7 (ou P0 Éco / Risparmio) et soufflerie active."
  },
  6: {
    code: 6, family: "CLEAN", short: "Nettoyage", label: "NETTOYAGE BRASIER", icon: "🧹",
    hex: "#a855f7", rgb: "168, 85, 247",
    bgClass: "bg-purple-500/90 text-white",
    badgeClass: "bg-purple-950/90 border-purple-400 text-purple-200",
    desc: "Cycle périodique d'auto-nettoyage : Soufflage extracteur accru pour évacuer les cendres du brasier."
  },
  7: {
    code: 7, family: "COOLING", short: "Refroid.", label: "ARRÊT (Refroidissement)", icon: "💨",
    hex: "#0ea5e9", rgb: "14, 165, 233",
    bgClass: "bg-sky-500/90 text-white",
    badgeClass: "bg-sky-950/90 border-sky-400 text-sky-200",
    desc: "Extinction en cours : Vis granulés arrêtée, ventilation forcée jusqu'au refroidissement sécurisé."
  },
  8: {
    code: 8, family: "STANDBY", short: "Eco-Stop", label: "ECO STOP (Stand-by actif)", icon: "⏳",
    hex: "#06b6d4", rgb: "6, 182, 212",
    bgClass: "bg-cyan-500/85 text-gray-950",
    badgeClass: "bg-cyan-950/90 border-cyan-400 text-cyan-200",
    desc: "Pause thermique Confort Climat : Consigne ambiante atteinte, en attente de redémarrage automatique."
  },
  9: {
    code: 9, family: "STANDBY", short: "Stand-By", label: "STAND BY", icon: "🌙",
    hex: "#06b6d4", rgb: "6, 182, 212",
    bgClass: "bg-cyan-600/85 text-white",
    badgeClass: "bg-cyan-950/90 border-cyan-500 text-cyan-200",
    desc: "Veille automatique : En attente d'une demande du thermostat ou d'un créneau Chrono P1..P4."
  },
  10: {
    code: 10, family: "ALARM", short: "Alarme", label: "ALARME SÉCURITÉ", icon: "🚨",
    hex: "#ef4444", rgb: "239, 68, 68",
    bgClass: "bg-rose-600 text-white animate-pulse",
    badgeClass: "bg-rose-950 border-rose-500 text-rose-200 font-black",
    desc: "Mise en sécurité active ! Consultez le code AL et acquittez l'alarme après vérification."
  },
  11: {
    code: 11, family: "ALARM", short: "Mém. Alarme", label: "MÉMOIRE ALARME", icon: "⚠️",
    hex: "#f43f5e", rgb: "244, 63, 94",
    bgClass: "bg-rose-500/90 text-white",
    badgeClass: "bg-rose-950/90 border-rose-400 text-rose-200",
    desc: "Historique d'alarme mémorisé nécessitant un acquittement (Reset 170)."
  }
};

// =============================================================================
// FONCTIONS UTILITAIRES DE CONVERSION & FORMATAGE
// =============================================================================

/**
 * Retourne les métadonnées techniques et chromatiques d'une phase de combustion.
 * @param {Object|number} rowOrCode - Enregistrement de télémétrie ou code de statut brut (-1..11).
 * @returns {Object} Objet décrivant la phase (libellé, icône, code hexadécimal, classes CSS).
 */
function getPhaseMeta(rowOrCode) {
  if (rowOrCode && typeof rowOrCode === "object") {
    if (rowOrCode._isGap || Number(rowOrCode.status_code) === -1) return STOVE_PHASE_META["-1"];
    const c = Number(rowOrCode.status_code ?? 0);
    return STOVE_PHASE_META[c] || STOVE_PHASE_META[0];
  }
  const c = Number(rowOrCode ?? 0);
  return STOVE_PHASE_META[c] || STOVE_PHASE_META[0];
}

/**
 * Échappe les caractères HTML dangereux pour prévenir les failles XSS.
 * @param {string|number} val - Valeur à échapper.
 * @returns {string} Chaîne sécurisée.
 */
function escapeHtml(val) {
  return String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Convertit un créneau d'horloge Chrono (tranche de 10 min, 0..143) en chaîne HH:MM.
 * @param {number} slot - Index de tranche horaire (144 = inactif).
 * @returns {string} Format "HH:MM" ou "OFF (144)".
 */
function slotToTime(slot) {
  const s = Number(slot);
  if (s >= 144) return "OFF (144)";
  const totalMin = s * 10;
  const hh = String(Math.floor(totalMin / 60)).padStart(2, "0");
  const mm = String(totalMin % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * Formate une consigne de température (affiche "MAX" si >= 41°C).
 * @param {number} val - Température en °C.
 * @returns {string} Ex: "21 °C" ou "MAX".
 */
function formatTempSetpoint(val) {
  return Number(val) >= 41 ? "MAX" : `${val} °C`;
}

/**
 * Formate une température mesurée (supprime le ".0" inutile, conserve la décimale si non nulle).
 * @param {number|string|null|undefined} val - Température en °C.
 * @param {number} [fallback=20] - Valeur de repli si absente ou invalide.
 * @returns {string} Ex: "22" pour 22.0, "20.5" pour 20.5.
 */
function formatMeasuredTemp(val, fallback = 20) {
  const raw = (val === null || val === undefined || val === "") ? fallback : val;
  const num = Number(raw);
  if (!Number.isFinite(num)) return String(fallback);
  const rounded = Math.round(num * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * Formate la consigne de vitesse d'un ventilateur (0..8).
 * @param {number} val - Indice de vitesse (0=OFF, 8=Auto/PS).
 * @returns {string} Ex: "OFF", "PS (Auto)" ou "3/7".
 */
function formatFanSpeed(val) {
  const v = Number(val);
  if (v === 0) return "OFF";
  if (v === 8) return "PS (Auto)";
  return `${v}/7`;
}

/**
 * Formate la vitesse physique réelle retournée par la carte de modulation.
 * @param {number} val - Vitesse réelle (0=OFF, 1=Risparmio, 2..8=Vitesse 1..7).
 * @returns {string} Ex: "OFF", "RISPARMIO", "Vit. 2".
 */
function formatRealFan(val) {
  const v = Number(val);
  if (v === 0) return "OFF";
  if (v === 1) return "RISPARMIO";
  return `Vit. ${v - 1}`;
}

/**
 * Formate le niveau de puissance de combustion réel ou consigne.
 * @param {number} val - Niveau de puissance (0=Éco, 8=Boost).
 * @returns {string} Ex: "P0 (Éco)", "P8 (Boost)", "P4".
 */
function formatRealPower(val) {
  const v = Number(val);
  if (v === 0) return "P0 (Éco)";
  if (v === 8) return "P8 (Boost)";
  return `P${v}`;
}

/**
 * Récupère la valeur d'un registre depuis le catalogue EEPROM ou la dernière télémétrie.
 * @param {string} key - Clé du registre (ex: "temp_amb_setpoint").
 * @param {*} fallback - Valeur par défaut si non disponible.
 * @returns {*} Valeur actuelle du registre ou repli.
 */
function getRegVal(key, fallback) {
  if (registersCatalog[key] && registersCatalog[key].current_val !== undefined) {
    return registersCatalog[key].current_val;
  }
  if (latestData[key] !== undefined && latestData[key] !== null) {
    return latestData[key];
  }
  return fallback;
}

/**
 * Retourne le nom personnalisé d'une canalisation ("SX" ou "DX"), avec repli par défaut.
 * @param {"SX"|"DX"} side
 * @returns {string}
 */
function getDuctName(side) {
  const key = side === "SX" ? "duct_left_name" : "duct_right_name";
  const raw = currentSettings && currentSettings[key] ? String(currentSettings[key]).trim() : "";
  return raw || side;
}

/**
 * Met à jour dynamiquement les libellés SX / DX dans SERIES_CONFIG (graphiques Supervision).
 */
function syncSeriesDuctLabels() {
  const sx = getDuctName("SX");
  const dx = getDuctName("DX");
  SERIES_CONFIG.forEach((s) => {
    if (s.key === "duct_left_temp") s.label = `T° ${sx}`;
    else if (s.key === "duct_left_setpoint") s.label = `Cons. ${sx}`;
    else if (s.key === "duct_left_speed") s.label = `Vit. ${sx}`;
    else if (s.key === "duct_right_temp") s.label = `T° ${dx}`;
    else if (s.key === "duct_right_setpoint") s.label = `Cons. ${dx}`;
    else if (s.key === "duct_right_speed") s.label = `Vit. ${dx}`;
  });
}

window.currentCapabilities = window.currentCapabilities || null;

function getActiveCapabilities() {
  return window.currentCapabilities || {
    stove_type: "air",
    temp_unit: "°C",
    temp_label: "Ambiance",
    temp_min: 7,
    temp_max: 41,
    power_min: 1,
    power_max: 7,
    has_fan_front: true,
    fan_min: 0,
    fan_max: 8,
    ducts: [
      { id: "SX", label: "SX", speed_min: 0, speed_max: 8, temp_min: 7, temp_max: 41 },
      { id: "DX", label: "DX", speed_min: 0, speed_max: 8, temp_min: 7, temp_max: 41 },
    ],
    has_auto: true,
    has_boost: true,
    has_eco: true,
    has_chrono: true,
    has_flue_temp: true,
    has_flame_k: true,
    has_pressure_pa: true,
    has_exhaust_rpm: true,
  };
}
