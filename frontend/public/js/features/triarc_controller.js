// =============================================================================
// FEATURE TRI-ARC V10 — ÉTAT OPTIMISTE, FILE BATCH, ACTIONS & GESTES TACTILES
// =============================================================================

let triArcZone = "AMB"; // "SX" | "AMB" | "DX"
let triArcExpandedMode = null; // null | "silence" | "auto" | "boost"
let triArcDragging = null; // { zone, arcType, value }
let triArcOptimisticValues = {}; // { key: { val, expires } }
let triArcPendingChanges = {}; // { reg_key: { reg_key, label, oldVal, newVal, fmtFn } }
let triArcBatchTimer = null;
let pendingStandaloneSilenceSnapshot = null;

const MANUAL_FAN_MEMORY_KEY = "stove_manual_fan_memory_v1";
const STANDALONE_SILENCE_STORAGE_KEY = "stove_standalone_silence_snapshot_v1";

let manualFanMemory = (() => {
  try {
    const raw = localStorage.getItem(MANUAL_FAN_MEMORY_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
})();

function rememberManualFanSpeed(regKey, val) {
  const num = Number(val);
  if (!Number.isFinite(num) || num < 0 || num >= 8) return;
  const rounded = Math.round(num);
  if (manualFanMemory[regKey] === rounded) return;
  manualFanMemory[regKey] = rounded;
  try {
    localStorage.setItem(MANUAL_FAN_MEMORY_KEY, JSON.stringify(manualFanMemory));
  } catch {
    // ignore
  }
}

function getRememberedManualFanSpeed(regKey, realFanVal, isFront = false) {
  const saved = manualFanMemory[regKey];
  if (saved !== undefined && saved !== null && Number.isFinite(Number(saved)) && Number(saved) < 8) {
    return Math.max(0, Math.round(Number(saved)));
  }
  const realNum = Number(realFanVal);
  if (Number.isFinite(realNum) && realNum >= 0 && realNum < 8) {
    if (isFront && Number(latestData?.status_code ?? 0) !== 0 && realNum === 0) {
      return 1;
    }
    return Math.round(realNum);
  }
  return isFront ? 1 : 0;
}

function loadStandaloneSilenceSnapshot() {
  try {
    const raw = localStorage.getItem(STANDALONE_SILENCE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function saveStandaloneSilenceSnapshot(snap) {
  try {
    if (!snap) {
      localStorage.removeItem(STANDALONE_SILENCE_STORAGE_KEY);
    } else {
      localStorage.setItem(STANDALONE_SILENCE_STORAGE_KEY, JSON.stringify(snap));
    }
  } catch {
    // ignore
  }
}

function _findActiveStandaloneChronoProgram(nowDate = new Date()) {
  const nowSlot = nowDate.getHours() * 6 + Math.floor(nowDate.getMinutes() / 10);
  const jsDay = nowDate.getDay();
  const todayDay = (typeof GANTT_DAYS !== "undefined" ? GANTT_DAYS : []).find(d => d.jsDay === jsDay);
  const prevJsDay = (jsDay + 6) % 7;
  const prevDay = (typeof GANTT_DAYS !== "undefined" ? GANTT_DAYS : []).find(d => d.jsDay === prevJsDay);
  const todayBit = todayDay ? todayDay.bit : (1 << ((jsDay + 6) % 7));
  const prevBit = prevDay ? prevDay.bit : (1 << ((prevJsDay + 6) % 7));

  for (let p = 1; p <= 4; p++) {
    const startSlot = Number(getRegVal(`chrono_p${p}_start_set`, latestData?.[`chrono_p${p}_start`] ?? 144));
    const stopSlot = Number(getRegVal(`chrono_p${p}_stop_set`, latestData?.[`chrono_p${p}_stop`] ?? 144));
    const mask = Number(getRegVal(`chrono_p${p}_days_mask`, latestData?.[`chrono_p${p}_days`] ?? 0));
    if (startSlot >= 144 || stopSlot >= 144 || startSlot === stopSlot || mask <= 0) continue;

    let isActive = false;
    if (stopSlot > startSlot) {
      isActive = (mask & todayBit) !== 0 && nowSlot >= startSlot && nowSlot < stopSlot;
    } else {
      isActive = ((mask & todayBit) !== 0 && nowSlot >= startSlot) || ((mask & prevBit) !== 0 && nowSlot < stopSlot);
    }
    if (!isActive) continue;

    return {
      program: p,
      values: {
        temp_amb_setpoint: Number(getRegVal(`chrono_p${p}_temperature_set`, latestData?.[`chrono_p${p}_temp`] ?? 20)),
        power_level: Number(getRegVal(`chrono_p${p}_power_set`, latestData?.[`chrono_p${p}_power`] ?? 4)),
        fan_front_speed: Number(getRegVal(`chrono_p${p}_fan_front_set`, latestData?.[`chrono_p${p}_fan_front`] ?? 0)),
        duct_left_setpoint: Number(getRegVal(`chrono_p${p}_tcanl_set`, latestData?.[`chrono_p${p}_tcanl`] ?? 20)),
        duct_left_speed: Number(getRegVal(`chrono_p${p}_canl_set`, latestData?.[`chrono_p${p}_canl`] ?? 0)),
        duct_right_setpoint: Number(getRegVal(`chrono_p${p}_tcanr_set`, latestData?.[`chrono_p${p}_tcanr`] ?? 20)),
        duct_right_speed: Number(getRegVal(`chrono_p${p}_canr_set`, latestData?.[`chrono_p${p}_canr`] ?? 0)),
      },
    };
  }
  return null;
}

function _buildStandaloneSilenceRestoreCommands(snap) {
  if (!snap || typeof snap !== "object") return [];
  const base = { ...snap };
  if (Number(base.chrono_week_enable_set ?? 0) >= 1) {
    const activeProg = _findActiveStandaloneChronoProgram();
    if (activeProg && activeProg.values) {
      Object.assign(base, activeProg.values);
    }
  }
  const restoreKeys = [
    "fun_pwf_set",
    "standby_set",
    "chrono_week_enable_set",
    "fun_auto_set",
    "fan_front_speed",
    "duct_left_speed",
    "duct_right_speed",
    "power_level",
    "temp_amb_setpoint",
    "duct_left_setpoint",
    "duct_right_setpoint",
  ];
  const cmds = [];
  restoreKeys.forEach((rk) => {
    if (base[rk] !== undefined && base[rk] !== null && Number.isFinite(Number(base[rk]))) {
      cmds.push({ reg_key: rk, value: Number(base[rk]) });
    }
  });
  return cmds;
}

const TRIARC_REG_META = {
  temp_amb_setpoint: { label: "🌡️ Consigne T° Poêle ( Principal )", fmt: (v) => fmtTriArcTempSp(v) },
  duct_left_setpoint: { label: "🌡️ Consigne T° Soufflerie SX", fmt: (v) => fmtTriArcTempSp(v) },
  duct_right_setpoint: { label: "🌡️ Consigne T° Soufflerie DX", fmt: (v) => fmtTriArcTempSp(v) },
  fan_front_speed: { label: "🌀 Ventilation Poêle ( Frontale )", fmt: (v) => fmtTriArcFan(v) },
  duct_left_speed: { label: "🌀 Ventilation Soufflerie SX", fmt: (v) => fmtTriArcFan(v) },
  duct_right_speed: { label: "🌀 Ventilation Soufflerie DX", fmt: (v) => fmtTriArcFan(v) },
  power_level: { label: "🔥 Puissance de combustion", fmt: (v) => `P${v}` },
  fun_pwf_set: { label: "🚀 Mode Boost (Puissance)", fmt: (v) => (Number(v) === 1 ? "🚀 ON" : (Number(v) === 2 ? "⏱️ PROG" : "OFF")) },
  fun_auto_set: { label: "🔥 Modulation Auto (Puissance)", fmt: (v) => (Number(v) === 1 ? "ACTIF" : "OFF") },
  standby_set: { label: "💤 Comfort Clima", fmt: (v) => (Number(v) === 1 ? "ACTIF" : "OFF") },
  comfortclima_time_set: { label: "⏱️ Temporisation Comfort Clima", fmt: (v) => `${v} min` },
  comfortclima_restart_set: { label: "🌡️ Delta redémarrage Comfort Clima", fmt: (v) => `${v} °C` },
  chrono_week_enable_set: { label: "⏱️ Chrono Hebdomadaire", fmt: (v) => (Number(v) === 1 ? "ON" : "OFF") }
};

function setTriArcOptimistic(key, val, durationMs = 30000) {
  triArcOptimisticValues[key] = { val: Number(val), expires: Date.now() + durationMs };
}

function clearTriArcOptimistic(keys) {
  (keys || Object.keys(triArcOptimisticValues)).forEach(k => {
    delete triArcOptimisticValues[k];
  });
}

function getTriArcLiveOrOpt(key, fallbackVal) {
  const opt = triArcOptimisticValues[key];
  if (opt && Date.now() < opt.expires) {
    return opt.val;
  }
  return Number(fallbackVal);
}

function getTriArcRawBaseline(reg_key) {
  if (reg_key === "fun_pwf_set") return Number(latestData.fun_pwf_set ?? getRegVal("fun_pwf_set", 0));
  if (reg_key === "fun_auto_set") return Number(latestData.fun_auto_set ?? getRegVal("fun_auto_set", 0));
  if (reg_key === "standby_set") return Number(latestData.comfortclima_ability_set ?? latestData.standby_enabled ?? getRegVal("standby_set", 0));
  if (reg_key === "comfortclima_time_set") return Number(latestData.comfortclima_time_set ?? getRegVal("comfortclima_time_set", 5));
  if (reg_key === "comfortclima_restart_set") return Number(latestData.comfortclima_restart_set ?? getRegVal("comfortclima_restart_set", 2));
  if (reg_key === "power_level") return Number(getRegVal("power_level", latestData.power_level ?? 4));
  return Number(getRegVal(reg_key, 0));
}

function queueTriArcChanges(changesList) {
  if (!Array.isArray(changesList) || changesList.length === 0) return;

  changesList.forEach(({ reg_key, value }) => {
    const newVal = Number(value);
    const existing = triArcPendingChanges[reg_key];
    const oldVal = existing ? existing.oldVal : getTriArcRawBaseline(reg_key);
    const meta = TRIARC_REG_META[reg_key] || { label: reg_key, fmt: (v) => String(v) };

    setTriArcOptimistic(reg_key, newVal, 30000);

    if (newVal === oldVal) {
      delete triArcPendingChanges[reg_key];
      delete triArcOptimisticValues[reg_key];
    } else {
      triArcPendingChanges[reg_key] = {
        reg_key,
        label: meta.label,
        oldVal,
        newVal,
        fmt: meta.fmt
      };
    }
  });

  renderTriArcCockpit();

  if (triArcBatchTimer) {
    clearTimeout(triArcBatchTimer);
    triArcBatchTimer = null;
  }
}

async function applyTriArcPendingChangesNow() {
  if (triArcBatchTimer) {
    clearTimeout(triArcBatchTimer);
    triArcBatchTimer = null;
  }
  const toSend = Object.values(triArcPendingChanges).map(it => ({
    reg_key: it.reg_key,
    value: Number(it.newVal)
  }));
  triArcPendingChanges = {};
  const pendingSnap = pendingStandaloneSilenceSnapshot;
  pendingStandaloneSilenceSnapshot = null;
  if (toSend.length === 0) {
    renderTriArcCockpit();
    return;
  }

  const keysToClear = toSend.map(c => c.reg_key);
  toSend.forEach(c => setTriArcOptimistic(c.reg_key, c.value, 6000));
  renderTriArcCockpit();

  try {
    const hasSilenceOverride = toSend.some(c => typeof SILENCE_OVERRIDABLE_KEYS !== "undefined" && SILENCE_OVERRIDABLE_KEYS[c.reg_key]);
    if (window.stoveProvider?.isContainerActive?.() && silenceModeState && silenceModeState.active && hasSilenceOverride) {
      await deactivateSilenceMode(toSend);
      return;
    }

    if (pendingSnap) {
      saveStandaloneSilenceSnapshot(pendingSnap);
    } else if (!window.stoveProvider?.isContainerActive?.() && hasSilenceOverride) {
      const existingSnap = loadStandaloneSilenceSnapshot();
      if (existingSnap) {
        const restoreCmds = _buildStandaloneSilenceRestoreCommands(existingSnap);
        if (restoreCmds.length > 0) {
          await window.stoveProvider.sendCommandBatch(restoreCmds);
        }
        saveStandaloneSilenceSnapshot(null);
      }
    }

    if (toSend.length === 1) {
      await sendCommand(toSend[0].reg_key, toSend[0].value);
    } else {
      showToast(`Application groupée de ${toSend.length} réglages...`);
      try {
        await window.stoveProvider.sendCommandBatch(toSend);
        showToast(`${toSend.length} réglages appliqués avec succès !`);
      } catch (e) {
        showToast("Erreur : " + (e?.message || "Échec batch"), true);
      }
      await refreshLatestOnly();
    }
  } finally {
    clearTriArcOptimistic(keysToClear);
    renderTriArcCockpit();
  }
}

function cancelTriArcPendingChanges() {
  if (triArcBatchTimer) {
    clearTimeout(triArcBatchTimer);
    triArcBatchTimer = null;
  }
  pendingStandaloneSilenceSnapshot = null;
  const keys = Object.keys(triArcPendingChanges);
  triArcPendingChanges = {};
  clearTriArcOptimistic(keys);
  renderTriArcCockpit();
  showToast("Modifications annulées.");
}

function promptTriArcBatchValidation() {
  if (triArcDragging) {
    triArcBatchTimer = setTimeout(promptTriArcBatchValidation, 600);
    return;
  }
  const items = Object.values(triArcPendingChanges);
  if (items.length === 0) return;

  const rowsHtml = items.map(item => `
    <div class="flex items-center justify-between gap-2 bg-slate-950/90 border border-slate-800 rounded-xl px-3 py-2 text-xs">
      <span class="font-semibold text-slate-200">${escapeHtml(item.label)}</span>
      <span class="font-mono font-bold whitespace-nowrap">
        <span class="text-slate-400">${escapeHtml(item.fmt(item.oldVal))}</span>
        <span class="text-orange-400 mx-1">➔</span>
        <span class="text-emerald-400">${escapeHtml(item.fmt(item.newVal))}</span>
      </span>
    </div>
  `).join("");

  const htmlContent = `
    <div class="space-y-2.5">
      <p class="text-xs text-slate-300">Confirmez-vous l'application ${items.length > 1 ? `de ces <strong>${items.length} modifications</strong>` : "de cette modification"} sur le poêle ?</p>
      <div class="space-y-1.5 max-h-60 overflow-y-auto pr-0.5">${rowsHtml}</div>
    </div>
  `;

  openActionModal({
    title: `✅ Validation (${items.length} réglage${items.length > 1 ? "s" : ""})`,
    htmlContent,
    confirmText: "Valider et Appliquer",
    cancelText: "Annuler",
    onConfirm: applyTriArcPendingChangesNow,
    onCancel: cancelTriArcPendingChanges
  });
}

function goToTriArcZone(z) {
  const caps = typeof getActiveCapabilities === "function" ? getActiveCapabilities() : { ducts: [{ id: "SX" }, { id: "DX" }] };
  const ducts = Array.isArray(caps.ducts) ? caps.ducts : [];
  if (z === "SX" && !ducts.some(d => d.id === "SX")) z = "AMB";
  if (z === "DX" && !ducts.some(d => d.id === "DX")) z = "AMB";
  triArcZone = z;
  triArcExpandedMode = null;
  renderTriArcCockpit();
}

function closeTriArcOptionBubble() {
  triArcExpandedMode = null;
  renderTriArcCockpit();
}

function toggleTriArcOptionBubble(modeName) {
  triArcExpandedMode = (triArcExpandedMode === modeName) ? null : modeName;
  renderTriArcCockpit();
}

function setTriArcEcoOption(val) {
  closeTriArcOptionBubble();
  const caps = typeof getActiveCapabilities === "function" ? getActiveCapabilities() : {};
  const isDemoMode = window.stoveProvider?.getMode?.() === "demo";
  if (getActiveCommMode() === "agua_cloud" && !caps.can_write_eco && !isDemoMode) {
    showToast("Le Cloud Agua IOT ne permet pas de modifier Comfort Clima à distance. Utilisez la radiocommande Nobis (MENU ▸ UTILISATEUR ▸ COMFORT CLIMA).", "warning");
    return;
  }
  queueTriArcChanges([{ reg_key: "standby_set", value: Number(val) }]);
}

function setTriArcComfortClimaSetting(regKey, value) {
  const allowed = {
    comfortclima_time_set: [0, 9],
    comfortclima_restart_set: [2, 5],
  };
  const limits = allowed[regKey];
  const numericValue = Number(value);
  if (!limits || !Number.isInteger(numericValue) || numericValue < limits[0] || numericValue > limits[1]) {
    showToast("Réglage Comfort Clima invalide.", true);
    return;
  }
  queueTriArcChanges([{ reg_key: regKey, value: numericValue }]);
}

function setTriArcAutoOption(idx) {
  closeTriArcOptionBubble();
  const caps = typeof getActiveCapabilities === "function" ? getActiveCapabilities() : { has_auto: true, has_fan_front: true, fan_max: 8, ducts: [{ id: "SX", speed_max: 8 }, { id: "DX", speed_max: 8 }] };
  const hasAuto = caps.has_auto !== false;
  const hasFanFront = caps.has_fan_front !== false && Number(caps.fan_max ?? 8) >= 8;
  const ducts = Array.isArray(caps.ducts) ? caps.ducts : [];
  const hasSx = ducts.some(d => d.id === "SX" && Number(d.speed_max ?? 8) >= 8);
  const hasDx = ducts.some(d => d.id === "DX" && Number(d.speed_max ?? 8) >= 8);

  const T = typeof getTriArcTelemetryState === "function" ? getTriArcTelemetryState() : {};
  const curFanAmb = Number(getTriArcLiveOrOpt("fan_front_speed", getRegVal("fan_front_speed", 3)));
  const curFanSx = Number(getTriArcLiveOrOpt("duct_left_speed", getRegVal("duct_left_speed", 0)));
  const curFanDx = Number(getTriArcLiveOrOpt("duct_right_speed", getRegVal("duct_right_speed", 0)));
  rememberManualFanSpeed("fan_front_speed", curFanAmb);
  rememberManualFanSpeed("duct_left_speed", curFanSx);
  rememberManualFanSpeed("duct_right_speed", curFanDx);
  const changes = [];

  if (idx === 0 || idx === 3) {
    // 0 = OFF complet, 3 = Flamme Auto seule (fun_auto_set = 1, ventilation manuelle)
    if (hasAuto) {
      changes.push({ reg_key: "fun_auto_set", value: idx === 3 ? 1 : 0 });
    }
    if (hasFanFront && curFanAmb >= 8) {
      changes.push({ reg_key: "fan_front_speed", value: getRememberedManualFanSpeed("fan_front_speed", T.realFanAmb, true) });
    }
    if (hasSx && curFanSx >= 8) {
      changes.push({ reg_key: "duct_left_speed", value: getRememberedManualFanSpeed("duct_left_speed", T.realFanSx, false) });
    }
    if (hasDx && curFanDx >= 8) {
      changes.push({ reg_key: "duct_right_speed", value: getRememberedManualFanSpeed("duct_right_speed", T.realFanDx, false) });
    }
  } else if (idx === 1 || idx === 2) {
    // 1 = Ventil Auto seule, 2 = Auto Total (Flamme + Ventil Auto)
    if (hasAuto) {
      changes.push({ reg_key: "fun_auto_set", value: idx === 2 ? 1 : 0 });
    }
    if (triArcZone === "SX") {
      if (hasSx) changes.push({ reg_key: "duct_left_speed", value: 8 });
    } else if (triArcZone === "DX") {
      if (hasDx) changes.push({ reg_key: "duct_right_speed", value: 8 });
    } else {
      if (hasFanFront) changes.push({ reg_key: "fan_front_speed", value: 8 });
      if (hasSx && curFanSx > 0) changes.push({ reg_key: "duct_left_speed", value: 8 });
      if (hasDx && curFanDx > 0) changes.push({ reg_key: "duct_right_speed", value: 8 });
    }
  }
  queueTriArcChanges(changes);
}

async function setTriArcBoostOption(val) {
  closeTriArcOptionBubble();
  const v = Number(val);
  // Ne désactive pas les fonctions auto ; la désactivation éventuelle du mode Silence est gérée à la validation
  queueTriArcChanges([{ reg_key: "fun_pwf_set", value: v }]);
}

async function setTriArcSilenceHours(hours) {
  closeTriArcOptionBubble();
  if (!window.stoveProvider?.isContainerActive?.()) return;
  if (hours <= 0) {
    await deactivateSilenceMode();
  } else {
    selectedSilenceHours = Number(hours);
    await confirmActivateSilence();
  }
}

async function deactivateStandaloneSilence() {
  closeTriArcOptionBubble();
  const snap = loadStandaloneSilenceSnapshot();
  if (!snap) {
    showToast("Remontez une consigne ou changez de mode pour quitter Silence.");
    return;
  }
  const restoreCmds = _buildStandaloneSilenceRestoreCommands(snap);
  saveStandaloneSilenceSnapshot(null);
  if (restoreCmds.length > 0) {
    try {
      await window.stoveProvider.sendCommandBatch(restoreCmds);
      await refreshLatestOnly();
      showToast("🤫 Mode Silence désactivé : réglages précédents restaurés.");
    } catch (e) {
      showToast("Erreur restauration Silence : " + (e?.message || "Échec"), true);
    }
  }
}

function activateStandaloneSilence() {
  closeTriArcOptionBubble();
  const caps = typeof getActiveCapabilities === "function" ? getActiveCapabilities() : {
    temp_min: 7, has_auto: true, has_boost: true, has_chrono: true, has_fan_front: true, fan_max: 8,
    ducts: [{ id: "SX", speed_max: 8 }, { id: "DX", speed_max: 8 }],
  };
  const tMin = Number(caps.temp_min ?? 7);
  const ducts = Array.isArray(caps.ducts) ? caps.ducts : [];
  const hasSx = ducts.some(d => d.id === "SX");
  const hasDx = ducts.some(d => d.id === "DX");
  const st = Number(latestData.status_code ?? 0);
  const isDemoMode = window.stoveProvider?.getMode?.() === "demo";
  const canWriteEco = Boolean(caps.can_write_eco) || getActiveCommMode() === "simulation" || getActiveCommMode() === "local_gateway" || isDemoMode;

  const snap = {
    temp_amb_setpoint: getTriArcRawBaseline("temp_amb_setpoint"),
    ...(hasSx ? { duct_left_setpoint: getTriArcRawBaseline("duct_left_setpoint") } : {}),
    ...(hasDx ? { duct_right_setpoint: getTriArcRawBaseline("duct_right_setpoint") } : {}),
    fun_pwf_set: getTriArcRawBaseline("fun_pwf_set"),
    ...(canWriteEco ? { standby_set: getTriArcRawBaseline("standby_set") } : {}),
    chrono_week_enable_set: getTriArcRawBaseline("chrono_week_enable_set"),
    fun_auto_set: getTriArcRawBaseline("fun_auto_set"),
    fan_front_speed: getTriArcRawBaseline("fan_front_speed"),
    ...(hasSx ? { duct_left_speed: getTriArcRawBaseline("duct_left_speed") } : {}),
    ...(hasDx ? { duct_right_speed: getTriArcRawBaseline("duct_right_speed") } : {}),
    power_level: getTriArcRawBaseline("power_level"),
  };

  const changes = [];
  if (st !== 0) {
    if (caps.has_boost !== false) changes.push({ reg_key: "fun_pwf_set", value: 0 });
    if (canWriteEco) changes.push({ reg_key: "standby_set", value: 0 });
    if (caps.has_chrono !== false) changes.push({ reg_key: "chrono_week_enable_set", value: 0 });
    if (caps.has_auto !== false) changes.push({ reg_key: "fun_auto_set", value: 1 });
    if (caps.has_fan_front !== false) changes.push({ reg_key: "fan_front_speed", value: 0 });
    if (hasSx) changes.push({ reg_key: "duct_left_speed", value: 0 });
    if (hasDx) changes.push({ reg_key: "duct_right_speed", value: 0 });
  }
  changes.push({ reg_key: "temp_amb_setpoint", value: tMin });
  if (hasSx) changes.push({ reg_key: "duct_left_setpoint", value: tMin });
  if (hasDx) changes.push({ reg_key: "duct_right_setpoint", value: tMin });

  const hasDiff = changes.some(c => Number(c.value) !== getTriArcRawBaseline(c.reg_key));
  if (!hasDiff) {
    showToast("Le poêle est déjà en mode Silence.");
    return;
  }
  pendingStandaloneSilenceSnapshot = snap;
  queueTriArcChanges(changes);
}

function updateTriArcValueFromPoint(svgEl, arcType, clientX, clientY) {
  const rect = svgEl.getBoundingClientRect();
  const x = 14 + (clientX - rect.left) * (292 / rect.width);
  const y = 20 + (clientY - rect.top) * (198 / rect.height);
  const dx = x - 160;
  const dy = y - 128;
  let deg = (Math.atan2(dy, dx) * 180) / Math.PI; // -180..180

  const zone = svgEl.dataset.zone || triArcZone;
  const T = getTriArcTelemetryState();
  const fanSp = zone === "AMB" ? T.fanAmb : (zone === "SX" ? T.fanSx : T.fanDx);

  if (arcType === "temp") {
    let a = deg < 0 ? deg + 360 : deg;
    if (a < 90) a += 360;
    a = Math.max(135, Math.min(405, a));
    return triArcAngleToTemp(a);
  } else if (arcType === "fan") {
    const caps = typeof getActiveCapabilities === "function" ? getActiveCapabilities() : { has_fan_front: true, fan_max: 8 };
    if (zone === "AMB" && caps.has_fan_front === false) return null;
    const fanMax = Math.max(1, Number(caps.fan_max ?? 8));
    // Sur le TriArc principal (AMB), si la ventilation est en mode Auto (8), l'arc est verrouillé
    const isFanAuto = (zone === "AMB") && fanMax >= 8 && Number(fanSp) >= 8;
    if (isFanAuto) return null;

    let a = deg < 0 ? deg + 360 : deg;
    a = Math.max(142, Math.min(218, a));
    return Math.round(((a - 142) / 76) * fanMax);
  } else if (arcType === "pwr") {
    const caps = typeof getActiveCapabilities === "function" ? getActiveCapabilities() : { power_min: 1, power_max: 7, has_boost: true };
    const pwrMax = Math.max(1, Number(caps.power_max ?? 7));
    const pwrArcMax = caps.has_boost ? pwrMax + 1 : pwrMax;
    // Si la puissance est en mode Auto ou s'il s'agit d'un écran canalisation, l'arc n'est pas cliquable
    if (zone === "SX" || zone === "DX" || Number(T.autoPwr) === 1) return null;

    let a = Math.max(-38, Math.min(38, deg));
    const rawVal = Math.round(((38 - a) / 76) * pwrArcMax);
    return Math.min(pwrMax, Math.max(0, rawVal));
  }
  return null;
}

function commitTriArcDrag(dragState) {
  if (!dragState) return;
  const { zone, arcType, value } = dragState;
  const v = Number(value);

  if (arcType === "temp") {
    const key = zone === "AMB" ? "temp_amb_setpoint" : (zone === "SX" ? "duct_left_setpoint" : "duct_right_setpoint");
    queueTriArcChanges([{ reg_key: key, value: v }]);
  } else if (arcType === "fan") {
    const key = zone === "AMB" ? "fan_front_speed" : (zone === "SX" ? "duct_left_speed" : "duct_right_speed");
    const changes = [{ reg_key: key, value: v }];
    queueTriArcChanges(changes);
  } else if (arcType === "pwr" && zone === "AMB") {
    if (v === 8) {
      queueTriArcChanges([{ reg_key: "fun_pwf_set", value: 1 }]);
    } else if (v === 0) {
      renderTriArcCockpit();
      showToast("P0 (Éco) est un ralenti automatique enclenché lorsque la température atteint la consigne.");
    } else {
      const changes = [{ reg_key: "power_level", value: v }];
      const pwfCur = Number(getTriArcLiveOrOpt("fun_pwf_set", latestData.fun_pwf_set ?? getRegVal("fun_pwf_set", 0)));
      if (pwfCur > 0) {
        changes.unshift({ reg_key: "fun_pwf_set", value: 0 });
      }
      // Ne désactive pas les fonctions auto lors du changement de puissance
      queueTriArcChanges(changes);
    }
  }
}

function initTriArcInteractions() {
  const vp = document.getElementById("triarc-carousel-viewport");
  if (!vp) return;

  // Gestion du glisser sur les arcs (consigne température, ventilation, puissance)
  window.addEventListener("pointerdown", (e) => {
    const hit = e.target.closest ? e.target.closest(".arc-hit") : null;
    if (!hit) return;
    const svg = hit.closest("svg");
    if (!svg) return;
    e.preventDefault();
    const arcType = hit.dataset.arc;
    const zone = svg.dataset.zone || triArcZone;
    const val = updateTriArcValueFromPoint(svg, arcType, e.clientX, e.clientY);
    if (val !== null) {
      triArcDragging = { zone, arcType, value: val };
      renderTriArcCockpit();
    }
  });

  window.addEventListener("pointermove", (e) => {
    if (!triArcDragging) return;
    const svg = document.getElementById(`tri-arc-svg-${triArcDragging.zone}`);
    if (!svg) return;
    const val = updateTriArcValueFromPoint(svg, triArcDragging.arcType, e.clientX, e.clientY);
    if (val !== null && val !== triArcDragging.value) {
      triArcDragging.value = val;
      renderTriArcCockpit();
    }
  });

  window.addEventListener("pointerup", () => {
    if (!triArcDragging) return;
    const finished = { ...triArcDragging };
    triArcDragging = null;
    commitTriArcDrag(finished);
  });
}
