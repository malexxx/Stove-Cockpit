// =============================================================================
// FEATURE TRI-ARC V10 — ÉTAT OPTIMISTE, FILE BATCH, ACTIONS & GESTES TACTILES
// =============================================================================

let triArcZone = "AMB"; // "SX" | "AMB" | "DX"
let triArcExpandedMode = null; // null | "silence" | "auto" | "boost"
let triArcDragging = null; // { zone, arcType, value }
let triArcOptimisticValues = {}; // { key: { val, expires } }
let triArcPendingChanges = {}; // { reg_key: { reg_key, label, oldVal, newVal, fmtFn } }
let triArcBatchTimer = null;

const TRIARC_REG_META = {
  temp_amb_setpoint: { label: "🌡️ Consigne T° Poêle ( Principal )", fmt: (v) => fmtTriArcTempSp(v) },
  duct_left_setpoint: { label: "🌡️ Consigne T° Soufflerie SX", fmt: (v) => fmtTriArcTempSp(v) },
  duct_right_setpoint: { label: "🌡️ Consigne T° Soufflerie DX", fmt: (v) => fmtTriArcTempSp(v) },
  fan_front_speed: { label: "🌀 Ventilation Poêle ( Frontale )", fmt: (v) => fmtTriArcFan(v) },
  duct_left_speed: { label: "🌀 Ventilation Soufflerie SX", fmt: (v) => fmtTriArcFan(v) },
  duct_right_speed: { label: "🌀 Ventilation Soufflerie DX", fmt: (v) => fmtTriArcFan(v) },
  power_level: { label: "🔥 Puissance de combustion", fmt: (v) => `P${v}` },
  fun_pwf_set: { label: "🚀 Mode Boost (Puissance)", fmt: (v) => (Number(v) === 1 ? "🚀 ON" : (Number(v) === 2 ? "⏱️ PROG" : "OFF")) },
  fun_auto_set: { label: "🔥+🌀 Mode Automatique", fmt: (v) => (Number(v) === 1 ? "ACTIF" : "OFF") },
  standby_set: { label: "💤 Mode Éco (Stand-by)", fmt: (v) => (Number(v) === 1 ? "ACTIF" : "OFF") }
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
  if (reg_key === "fun_pwf_set") return Number(getRegVal("fun_pwf_set", latestData.fun_pwf_set ?? 0));
  if (reg_key === "fun_auto_set") return Number(getRegVal("fun_auto_set", latestData.fun_auto_set ?? 0));
  if (reg_key === "standby_set") return Number(getRegVal("standby_set", latestData.standby_set ?? 0));
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

  if (Object.keys(triArcPendingChanges).length > 0) {
    triArcBatchTimer = setTimeout(() => {
      triArcBatchTimer = null;
      promptTriArcBatchValidation();
    }, 1000);
  }
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
    onConfirm: async () => {
      const toSend = Object.values(triArcPendingChanges).map(it => ({
        reg_key: it.reg_key,
        value: Number(it.newVal)
      }));
      triArcPendingChanges = {};
      if (toSend.length === 0) return;

      toSend.forEach(c => setTriArcOptimistic(c.reg_key, c.value, 6000));

      if (silenceModeState && silenceModeState.active && toSend.some(c => SILENCE_OVERRIDABLE_KEYS[c.reg_key])) {
        await deactivateSilenceMode(toSend);
        return;
      }

      if (toSend.length === 1) {
        await sendCommand(toSend[0].reg_key, toSend[0].value);
      } else {
        showToast(`Application groupée de ${toSend.length} réglages...`);
        try {
          await window.stoveProvider.sendCommandBatch(toSend, getInstallerHeaders());
          showToast(`${toSend.length} réglages appliqués avec succès !`);
        } catch (e) {
          showToast("Erreur : " + (e?.message || "Échec batch"), true);
        }
        await refreshLatestOnly();
      }
    },
    onCancel: () => {
      const keys = Object.keys(triArcPendingChanges);
      triArcPendingChanges = {};
      clearTriArcOptimistic(keys);
      renderTriArcCockpit();
      showToast("Modifications annulées.");
    }
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
  if (getActiveCommMode() === "agua_cloud") {
    showToast("Le Cloud Agua IOT ne permet pas de modifier Comfort Clima à distance. Utilisez la radiocommande Nobis (MENU ▸ UTILISATEUR ▸ COMFORT CLIMA).", "warning");
    return;
  }
  queueTriArcChanges([{ reg_key: "standby_set", value: Number(val) }]);
}

function setTriArcAutoOption(idx) {
  closeTriArcOptionBubble();
  if (idx === 0) {
    // Désactivation complète du mode Auto : fun_auto_set = 0 et réinitialisation des vitesses de ventilateurs si elles étaient en Auto (8)
    const changes = [{ reg_key: "fun_auto_set", value: 0 }];
    const curFanAmb = Number(getTriArcLiveOrOpt("fan_front_speed", getRegVal("fan_front_speed", 3)));
    const curFanSx = Number(getTriArcLiveOrOpt("duct_left_speed", getRegVal("duct_left_speed", 0)));
    const curFanDx = Number(getTriArcLiveOrOpt("duct_right_speed", getRegVal("duct_right_speed", 0)));
    if (curFanAmb >= 8) changes.push({ reg_key: "fan_front_speed", value: 3 });
    if (curFanSx >= 8) changes.push({ reg_key: "duct_left_speed", value: 0 });
    if (curFanDx >= 8) changes.push({ reg_key: "duct_right_speed", value: 0 });
    queueTriArcChanges(changes);
  } else if (idx === 1) {
    queueTriArcChanges([
      { reg_key: "fun_auto_set", value: 0 },
      { reg_key: "fan_front_speed", value: 8 },
      { reg_key: "duct_left_speed", value: 8 },
      { reg_key: "duct_right_speed", value: 8 }
    ]);
  } else if (idx === 2) {
    queueTriArcChanges([
      { reg_key: "fun_auto_set", value: 1 },
      { reg_key: "fan_front_speed", value: 8 },
      { reg_key: "duct_left_speed", value: 8 },
      { reg_key: "duct_right_speed", value: 8 }
    ]);
  }
}

async function setTriArcBoostOption(val) {
  closeTriArcOptionBubble();
  const v = Number(val);
  // Le mode Boost désactive le mode silence s'il est actif
  if (v > 0 && silenceModeState && silenceModeState.active) {
    await deactivateSilenceMode();
  }
  // Ne désactive pas les fonctions auto
  queueTriArcChanges([{ reg_key: "fun_pwf_set", value: v }]);
}

async function setTriArcSilenceHours(hours) {
  closeTriArcOptionBubble();
  if (hours <= 0) {
    await deactivateSilenceMode();
  } else {
    selectedSilenceHours = Number(hours);
    await confirmActivateSilence();
  }
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
    // Sur le TriArc principal (AMB), si la ventilation est en mode Auto, l'arc est verrouillé (géré par le bouton Auto)
    const isFanAuto = (zone === "AMB") && (T.autoIdx === 1 || T.autoIdx === 2 || fanSp === 8);
    if (isFanAuto) return null;

    let a = deg < 0 ? deg + 360 : deg;
    a = Math.max(142, Math.min(218, a));
    return Math.round(((a - 142) / 76) * fanMax);
  } else if (arcType === "pwr") {
    const caps = typeof getActiveCapabilities === "function" ? getActiveCapabilities() : { power_min: 1, power_max: 7, has_boost: true };
    const pwrMax = Math.max(1, Number(caps.power_max ?? 7));
    const pwrArcMax = caps.has_boost ? pwrMax + 1 : pwrMax;
    // Si la puissance est en mode Auto complet (2) ou s'il s'agit d'un écran canalisation, l'arc n'est pas cliquable
    if (zone === "SX" || zone === "DX" || T.autoIdx === 2) return null;

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
      const pwfCur = Number(getTriArcLiveOrOpt("fun_pwf_set", getRegVal("fun_pwf_set", latestData.fun_pwf_set ?? 0)));
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
