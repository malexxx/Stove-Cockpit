// =============================================================================
// FEATURE CHRONO — PROGRAMMATION HEBDOMADAIRE P1..P4 & FRISE GANTT
// =============================================================================

// Configuration des jours de la semaine pour la frise Gantt
const GANTT_DAYS = [
  { bit: 1, name: "Lun", full: "Lundi", jsDay: 1 },
  { bit: 2, name: "Mar", full: "Mardi", jsDay: 2 },
  { bit: 4, name: "Mer", full: "Mercredi", jsDay: 3 },
  { bit: 8, name: "Jeu", full: "Jeudi", jsDay: 4 },
  { bit: 16, name: "Ven", full: "Vendredi", jsDay: 5 },
  { bit: 32, name: "Sam", full: "Samedi", jsDay: 6 },
  { bit: 64, name: "Dim", full: "Dimanche", jsDay: 0 },
];
let selectedGanttDayBit = null;

function setGanttDay(bit) {
  selectedGanttDayBit = Number(bit);
  renderChronoPrograms();
}

let currentOpenProgramModal = null;
let programDraft = null; // { p, initial: {...}, current: {...} }

function openProgramModal(p) {
  const pNum = Number(p);
  currentOpenProgramModal = pNum;

  const initial = {
    startSlot: Number(getRegVal(`chrono_p${pNum}_start_set`, latestData[`chrono_p${pNum}_start`] ?? 144)),
    stopSlot: Number(getRegVal(`chrono_p${pNum}_stop_set`, latestData[`chrono_p${pNum}_stop`] ?? 144)),
    mask: Number(getRegVal(`chrono_p${pNum}_days_mask`, latestData[`chrono_p${pNum}_days`] ?? 0)),
    power: Number(getRegVal(`chrono_p${pNum}_power_set`, latestData[`chrono_p${pNum}_power`] ?? 7)),
    temperature: Number(getRegVal(`chrono_p${pNum}_temperature_set`, latestData[`chrono_p${pNum}_temp`] ?? 20)),
    fanFront: Number(getRegVal(`chrono_p${pNum}_fan_front_set`, 0)),
    tCanL: Number(getRegVal(`chrono_p${pNum}_tcanl_set`, 20)),
    vCanL: Number(getRegVal(`chrono_p${pNum}_canl_set`, 0)),
    tCanR: Number(getRegVal(`chrono_p${pNum}_tcanr_set`, 20)),
    vCanR: Number(getRegVal(`chrono_p${pNum}_canr_set`, 0))
  };

  programDraft = {
    p: pNum,
    initial: { ...initial },
    current: { ...initial }
  };

  renderProgramModalContent(currentOpenProgramModal);
  const modal = document.getElementById("program-modal");
  if (modal) modal.classList.remove("hidden");
}

function forceCloseProgramModal() {
  currentOpenProgramModal = null;
  programDraft = null;
  const modal = document.getElementById("program-modal");
  if (modal) modal.classList.add("hidden");
}

function closeProgramModal() {
  if (!programDraft || programDraft.p !== currentOpenProgramModal) {
    forceCloseProgramModal();
    return;
  }

  const p = programDraft.p;
  const changes = getProgramChangesSummary(p, programDraft.initial, programDraft.current);

  if (changes.length === 0) {
    forceCloseProgramModal();
    return;
  }

  showProgramConfirmationModal(p, changes);
}

function timeToSlot(timeStr) {
  if (!timeStr) return 144;
  const parts = timeStr.split(":");
  if (parts.length < 2) return 144;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return 144;
  // Tranches de 10 min (0..143)
  return Math.min(143, Math.max(0, h * 6 + Math.round(m / 10)));
}

function updateProgramDraftTime(type, timeStr) {
  if (!programDraft) return;
  const slot = timeToSlot(timeStr);
  if (type === "start") {
    programDraft.current.startSlot = slot;
    if (programDraft.current.stopSlot >= 144 || programDraft.current.stopSlot === slot) {
      const defStop = (slot + 12) % 144;
      let savedStop = Number(localStorage.getItem(`nobis_p${programDraft.p}_last_stop`));
      if (isNaN(savedStop) || savedStop >= 144 || savedStop === slot) savedStop = defStop;
      programDraft.current.stopSlot = savedStop;
    }
  } else if (type === "stop") {
    programDraft.current.stopSlot = slot;
    if (programDraft.current.startSlot >= 144 || programDraft.current.startSlot === slot) {
      const defStart = (slot - 12 + 144) % 144;
      let savedStart = Number(localStorage.getItem(`nobis_p${programDraft.p}_last_start`));
      if (isNaN(savedStart) || savedStart >= 144 || savedStart === slot) savedStart = defStart;
      programDraft.current.startSlot = savedStart;
    }
  }

  if (programDraft.current.mask === 0) {
    programDraft.current.mask = 127;
  }

  renderProgramModalContent(programDraft.p);
}

function updateProgramDraft(field, value) {
  if (!programDraft) return;
  programDraft.current[field] = Number(value);
  renderProgramModalContent(programDraft.p);
}

function getProgramChangesSummary(p, initial, current) {
  const changes = [];
  const dayNames = [
    { bit: 1, name: "Lun" }, { bit: 2, name: "Mar" }, { bit: 4, name: "Mer" },
    { bit: 8, name: "Jeu" }, { bit: 16, name: "Ven" }, { bit: 32, name: "Sam" },
    { bit: 64, name: "Dim" }
  ];

  const formatDays = (mask) => {
    if (mask === 127) return "Tous les jours";
    if (mask === 0) return "Aucun jour";
    return dayNames.filter(d => (mask & d.bit) !== 0).map(d => d.name).join(", ");
  };

  const formatFan = (v) => {
    const n = Number(v);
    return n === 8 ? "AUTO" : (n === 0 ? "OFF" : String(n));
  };

  // 1. Plage horaire
  if (initial.startSlot !== current.startSlot || initial.stopSlot !== current.stopSlot) {
    const oldTime = (initial.startSlot < 144 && initial.stopSlot < 144 && initial.startSlot !== initial.stopSlot)
      ? `${slotToTime(initial.startSlot)} - ${slotToTime(initial.stopSlot)}`
      : "Inactif";
    const newTime = (current.startSlot < 144 && current.stopSlot < 144 && current.startSlot !== current.stopSlot)
      ? `${slotToTime(current.startSlot)} - ${slotToTime(current.stopSlot)}`
      : "Inactif";

    changes.push({
      icon: "⏰",
      label: "Plage horaire",
      oldText: oldTime,
      newText: newTime,
      commands: [
        { reg_key: `chrono_p${p}_start_set`, value: current.startSlot },
        { reg_key: `chrono_p${p}_stop_set`, value: current.stopSlot }
      ]
    });
  }

  // 2. Puissance
  if (initial.power !== current.power) {
    changes.push({
      icon: "🔥",
      label: "Puissance",
      oldText: `${initial.power}`,
      newText: `${current.power}`,
      commands: [
        { reg_key: `chrono_p${p}_power_set`, value: current.power }
      ]
    });
  }

  // 3. Température Salon
  if (initial.temperature !== current.temperature) {
    changes.push({
      icon: "🌡️",
      label: "Température",
      oldText: `${initial.temperature}°C`,
      newText: `${current.temperature}°C`,
      commands: [
        { reg_key: `chrono_p${p}_temperature_set`, value: current.temperature }
      ]
    });
  }

  // 4. Ventilation Façade
  if (initial.fanFront !== current.fanFront) {
    changes.push({
      icon: "💨",
      label: "Ventilation façade",
      oldText: formatFan(initial.fanFront),
      newText: formatFan(current.fanFront),
      commands: [
        { reg_key: `chrono_p${p}_fan_front_set`, value: current.fanFront }
      ]
    });
  }

  // 5. Canalisation Gauche
  if (initial.tCanL !== current.tCanL) {
    changes.push({
      icon: "⬅️🌡️",
      label: "T° Consigne Gauche",
      oldText: `${initial.tCanL}°C`,
      newText: `${current.tCanL}°C`,
      commands: [
        { reg_key: `chrono_p${p}_tcanl_set`, value: current.tCanL }
      ]
    });
  }
  if (initial.vCanL !== current.vCanL) {
    changes.push({
      icon: "⬅️💨",
      label: "Soufflerie Gauche",
      oldText: formatFan(initial.vCanL),
      newText: formatFan(current.vCanL),
      commands: [
        { reg_key: `chrono_p${p}_canl_set`, value: current.vCanL }
      ]
    });
  }

  // 6. Canalisation Droite
  if (initial.tCanR !== current.tCanR) {
    changes.push({
      icon: "➡️🌡️",
      label: "T° Consigne Droite",
      oldText: `${initial.tCanR}°C`,
      newText: `${current.tCanR}°C`,
      commands: [
        { reg_key: `chrono_p${p}_tcanr_set`, value: current.tCanR }
      ]
    });
  }
  if (initial.vCanR !== current.vCanR) {
    changes.push({
      icon: "➡️💨",
      label: "Soufflerie Droite",
      oldText: formatFan(initial.vCanR),
      newText: formatFan(current.vCanR),
      commands: [
        { reg_key: `chrono_p${p}_canr_set`, value: current.vCanR }
      ]
    });
  }

  // 7. Jours d'activation
  if (initial.mask !== current.mask) {
    changes.push({
      icon: "📅",
      label: "Jours d'activation",
      oldText: formatDays(initial.mask),
      newText: formatDays(current.mask),
      commands: [
        { reg_key: `chrono_p${p}_days_mask`, value: current.mask }
      ]
    });
  }

  return changes;
}

function showProgramConfirmationModal(p, changes) {
  const rowsHtml = changes.map(c => `
    <div class="flex items-center justify-between py-2 px-3 rounded-lg bg-gray-900 border border-gray-800 text-xs">
      <div class="flex items-center gap-2 text-gray-200 font-medium">
        <span class="text-sm">${c.icon}</span>
        <span>${c.label}</span>
      </div>
      <div class="flex items-center gap-1.5 font-mono text-xs">
        <span class="text-gray-400 line-through">${c.oldText}</span>
        <span class="text-orange-400 font-bold">➔</span>
        <span class="text-emerald-400 font-bold">${c.newText}</span>
      </div>
    </div>
  `).join("");

  const htmlContent = `
    <div class="space-y-3">
      <p class="text-xs text-gray-300 leading-relaxed">
        Vous avez modifié la configuration du <strong>Programme ${p}</strong>.
        Souhaitez-vous transmettre ces <strong>${changes.length} modification${changes.length > 1 ? "s" : ""}</strong> au poêle ?
      </p>
      <div class="space-y-1.5 max-h-60 overflow-y-auto pr-0.5">
        ${rowsHtml}
      </div>
    </div>
  `;

  openActionModal({
    title: `⚙️ Confirmation — Programme ${p}`,
    htmlContent,
    confirmText: "Appliquer au poêle",
    cancelText: "Abandonner",
    showCancel: true,
    onConfirm: async () => {
      await applyProgramChanges(p, changes);
    },
    onCancel: () => {
      forceCloseProgramModal();
      showToast("Modifications abandonnées");
    }
  });
}

async function applyProgramChanges(p, changes) {
  const toSend = [];
  changes.forEach(c => {
    c.commands.forEach(cmd => {
      toSend.push({ reg_key: cmd.reg_key, value: Number(cmd.value) });
    });
  });

  if (toSend.length === 0) return;

  if (programDraft && programDraft.current) {
    if (programDraft.current.startSlot < 144) localStorage.setItem(`nobis_p${p}_last_start`, programDraft.current.startSlot);
    if (programDraft.current.stopSlot < 144) localStorage.setItem(`nobis_p${p}_last_stop`, programDraft.current.stopSlot);
    if (programDraft.current.mask > 0) localStorage.setItem(`nobis_p${p}_last_mask`, programDraft.current.mask);
  }

  forceCloseProgramModal();

  if (silenceModeState && silenceModeState.active && toSend.some(c => SILENCE_OVERRIDABLE_KEYS[c.reg_key])) {
    await deactivateSilenceMode(toSend);
    return;
  }

  showToast(`Envoi de ${toSend.length} réglage(s) au poêle...`);

  try {
    if (toSend.length === 1) {
      await sendCommand(toSend[0].reg_key, toSend[0].value);
    } else {
      await window.stoveProvider.sendCommandBatch(toSend, getInstallerHeaders());
      showToast(`Programme ${p} mis à jour avec succès (${toSend.length} réglages) !`);
      await refreshLatestOnly();
    }
  } catch (err) {
    showToast("Erreur réseau : " + (err?.message || "Échec"), true);
    reportClientError("RESEAU", `Erreur réseau maj programme P${p} : ${err?.message || "Échec"}`);
  }
}

// Rendu du contenu complet d'un programme dans la Popup modale
function renderProgramModalContent(p) {
  const modalContainer = document.getElementById("program-modal-container");
  if (!modalContainer) return;

  const cur = (programDraft && programDraft.p === p) ? programDraft.current : null;

  const startSlot = cur ? cur.startSlot : Number(getRegVal(`chrono_p${p}_start_set`, latestData[`chrono_p${p}_start`] ?? 144));
  const stopSlot = cur ? cur.stopSlot : Number(getRegVal(`chrono_p${p}_stop_set`, latestData[`chrono_p${p}_stop`] ?? 144));
  const mask = cur ? cur.mask : Number(getRegVal(`chrono_p${p}_days_mask`, latestData[`chrono_p${p}_days`] ?? 0));
  const pwr = cur ? cur.power : Number(getRegVal(`chrono_p${p}_power_set`, latestData[`chrono_p${p}_power`] ?? 7));
  const temp = cur ? cur.temperature : Number(getRegVal(`chrono_p${p}_temperature_set`, latestData[`chrono_p${p}_temp`] ?? 20));

  const fanFront = cur ? cur.fanFront : Number(getRegVal(`chrono_p${p}_fan_front_set`, 0));
  const tCanL = cur ? cur.tCanL : Number(getRegVal(`chrono_p${p}_tcanl_set`, 20));
  const vCanL = cur ? cur.vCanL : Number(getRegVal(`chrono_p${p}_canl_set`, 0));
  const tCanR = cur ? cur.tCanR : Number(getRegVal(`chrono_p${p}_tcanr_set`, 20));
  const vCanR = cur ? cur.vCanR : Number(getRegVal(`chrono_p${p}_canr_set`, 0));

  const dayLabels = [
    { bit: 1, name: "Lun", full: "Lundi" },
    { bit: 2, name: "Mar", full: "Mardi" },
    { bit: 4, name: "Mer", full: "Mercredi" },
    { bit: 8, name: "Jeu", full: "Jeudi" },
    { bit: 16, name: "Ven", full: "Vendredi" },
    { bit: 32, name: "Sam", full: "Samedi" },
    { bit: 64, name: "Dim", full: "Dimanche" }
  ];

  const progTheme = {
    1: {
      border: "border-emerald-600/70",
      badge: "bg-emerald-500 text-gray-950",
      text: "text-emerald-400",
      dayActive: "bg-emerald-600 text-white font-bold border-emerald-500 shadow-sm"
    },
    2: {
      border: "border-orange-600/70",
      badge: "bg-orange-500 text-gray-950",
      text: "text-orange-400",
      dayActive: "bg-orange-600 text-white font-bold border-orange-500 shadow-sm"
    },
    3: {
      border: "border-cyan-600/70",
      badge: "bg-cyan-500 text-gray-950",
      text: "text-cyan-400",
      dayActive: "bg-cyan-600 text-white font-bold border-cyan-500 shadow-sm"
    },
    4: {
      border: "border-purple-600/70",
      badge: "bg-purple-500 text-white",
      text: "text-purple-400",
      dayActive: "bg-purple-600 text-white font-bold border-purple-500 shadow-sm"
    }
  }[p];

  const isConfigured = (startSlot < 144 && stopSlot < 144 && startSlot !== stopSlot);

  if (startSlot < 144) localStorage.setItem(`nobis_p${p}_last_start`, startSlot);
  if (stopSlot < 144) localStorage.setItem(`nobis_p${p}_last_stop`, stopSlot);
  if (mask > 0) localStorage.setItem(`nobis_p${p}_last_mask`, mask);

  const defStart = p === 1 ? 48 : (p === 2 ? 126 : 42);
  const defStop = p === 1 ? 63 : (p === 2 ? 138 : 54);
  let savedStart = Number(localStorage.getItem(`nobis_p${p}_last_start`));
  let savedStop = Number(localStorage.getItem(`nobis_p${p}_last_stop`));
  if (isNaN(savedStart) || savedStart >= 144) savedStart = defStart;
  if (isNaN(savedStop) || savedStop >= 144 || savedStop === savedStart) savedStop = defStop;

  const startTimeVal = startSlot < 144 ? slotToTime(startSlot) : slotToTime(savedStart);
  const stopTimeVal = stopSlot < 144 ? slotToTime(stopSlot) : slotToTime(savedStop);

  // Choix de la puissance : uniquement des chiffres (1..7)
  let powerOptions = "";
  for (let lvl = 1; lvl <= 7; lvl++) {
    powerOptions += `<option value="${lvl}" ${pwr === lvl ? 'selected' : ''}>${lvl}</option>`;
  }

  // Choix de la T° : uniquement la température, sans MAX ni Hors-gel
  let tempOptions = "";
  for (let t = 7; t <= 41; t++) {
    tempOptions += `<option value="${t}" ${temp === t ? 'selected' : ''}>${t}°C</option>`;
  }

  let tCanLOptions = "";
  let tCanROptions = "";
  for (let t = 7; t <= 41; t++) {
    tCanLOptions += `<option value="${t}" ${tCanL === t ? 'selected' : ''}>${t}°C</option>`;
    tCanROptions += `<option value="${t}" ${tCanR === t ? 'selected' : ''}>${t}°C</option>`;
  }

  // Choix de la ventilation : uniquement des chiffres ou OFF/AUTO
  const fanDuctOptions = (curVal) => [
    { val: 0, label: "OFF" },
    { val: 1, label: "1" },
    { val: 2, label: "2" },
    { val: 3, label: "3" },
    { val: 4, label: "4" },
    { val: 5, label: "5" },
    { val: 6, label: "6" },
    { val: 7, label: "7" },
    { val: 8, label: "AUTO" }
  ].map(o => `<option value="${o.val}" ${curVal === o.val ? 'selected' : ''}>${o.label}</option>`).join("");

  const fanFrontOptions = [
    { val: 0, label: "OFF" },
    { val: 1, label: "1" },
    { val: 2, label: "2" },
    { val: 3, label: "3" },
    { val: 4, label: "4" },
    { val: 5, label: "5" },
    { val: 6, label: "6" },
    { val: 7, label: "7" },
    { val: 8, label: "AUTO" }
  ].map(o => `<option value="${o.val}" ${fanFront === o.val ? 'selected' : ''}>${o.label}</option>`).join("");

  // Jours d'activation
  const dayBtns = dayLabels.map(d => {
    const isOn = (mask & d.bit) !== 0;
    const nextMask = isOn ? (mask & ~d.bit) : (mask | d.bit);
    return `<button type="button" onclick="updateProgramDraft('mask', ${nextMask})"
      class="min-h-[34px] py-1 px-1.5 rounded-lg text-xs font-bold transition-all border cursor-pointer ${isOn ? progTheme.dayActive : 'bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700 border-gray-700'}"
      title="${d.full}">
      ${d.name}
    </button>`;
  }).join("");

  modalContainer.className = `bg-gray-900 border ${progTheme.border} rounded-2xl max-w-lg w-full max-h-[90vh] flex flex-col shadow-2xl overflow-hidden my-auto`;

  modalContainer.innerHTML = `
    <!-- En-tête de la Popup : Titre "Configuration" sans sous-titre -->
    <div class="p-4 bg-gray-950/90 border-b border-gray-800 flex items-center justify-between">
      <div class="flex items-center gap-2.5">
        <span class="px-2.5 py-1 rounded-md text-xs font-black ${progTheme.badge} shadow-sm">P${p}</span>
        <h3 class="text-base font-bold text-white">Configuration</h3>
      </div>
      <button type="button" onclick="closeProgramModal()"
        class="w-8 h-8 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white font-bold flex items-center justify-center transition cursor-pointer"
        title="Fermer">
        ✕
      </button>
    </div>

    <!-- Contenu du Programme (Scrollable) -->
    <div class="p-4 sm:p-5 overflow-y-auto space-y-4 text-xs tabular-nums flex-1 pb-6">
      <!-- Bulle fusionnée : Plages Horaires & Consignes de Chauffe (sans titres) -->
      <div class="bg-gray-950/70 p-3.5 rounded-xl border border-gray-800 space-y-3.5">
        <!-- 1. Plage Horaire (horloge smartphone native) -->
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="text-[11px] text-gray-400 block mb-1">Début</label>
            <input type="time" step="600"
              style="color-scheme: dark"
              value="${startTimeVal}"
              onchange="updateProgramDraftTime('start', this.value)"
              class="w-full bg-gray-800 border ${isConfigured ? 'border-gray-700 text-white' : 'border-gray-800 text-gray-400'} rounded-lg px-2.5 py-1.5 font-mono text-xs focus:outline-none focus:border-orange-500 cursor-pointer">
          </div>
          <div>
            <label class="text-[11px] text-gray-400 block mb-1">Fin</label>
            <input type="time" step="600"
              style="color-scheme: dark"
              value="${stopTimeVal}"
              onchange="updateProgramDraftTime('stop', this.value)"
              class="w-full bg-gray-800 border ${isConfigured ? 'border-gray-700 text-white' : 'border-gray-800 text-gray-400'} rounded-lg px-2.5 py-1.5 font-mono text-xs focus:outline-none focus:border-orange-500 cursor-pointer">
          </div>
        </div>

        <!-- 2. Consignes de Chauffe (Flamme, T°, Ventilation) avec pictogrammes -->
        <div class="pt-3 border-t border-gray-800/80">
          <div class="grid grid-cols-3 gap-2.5">
            <div>
              <label class="text-base block mb-1 text-center" title="Puissance de chauffe (1 à 7)">🔥</label>
              <select onchange="updateProgramDraft('power', this.value)"
                class="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs text-center focus:outline-none focus:border-orange-500 cursor-pointer">
                ${powerOptions}
              </select>
            </div>
            <div>
              <label class="text-base block mb-1 text-center" title="Température Salon (7 à 41°C)">🌡️</label>
              <select onchange="updateProgramDraft('temperature', this.value)"
                class="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs text-center focus:outline-none focus:border-orange-500 cursor-pointer">
                ${tempOptions}
              </select>
            </div>
            <div>
              <label class="text-base block mb-1 text-center" title="Ventilation façade (OFF, 1..7, AUTO)">💨</label>
              <select onchange="updateProgramDraft('fanFront', this.value)"
                class="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs text-center focus:outline-none focus:border-orange-500 cursor-pointer">
                ${fanFrontOptions}
              </select>
            </div>
          </div>
        </div>
      </div>

      <!-- Canalisations d'air chaud Gauche & Droite (sans SX/DX, sans Cons/Vit) -->
      <div class="bg-gray-950/70 p-3.5 rounded-xl border border-gray-800 space-y-2.5">
        <span class="font-bold text-gray-200 text-xs block">💨 Canalisations d'Air Chaud</span>
        <div class="grid grid-cols-2 gap-3">
          <!-- Canalisation Gauche -->
          <div class="bg-gray-900/90 p-2.5 rounded-lg border border-gray-800 space-y-2">
            <div class="text-[11px] text-cyan-400 font-semibold flex items-center justify-between">
              <span class="truncate">⬅️ ${escapeHtml(getDuctName("SX"))}</span>
            </div>
            <div class="space-y-1.5">
              <div>
                <label class="text-[10px] text-gray-400 block mb-0.5">T° Consigne</label>
                <select onchange="updateProgramDraft('tCanL', this.value)"
                  class="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs text-center focus:outline-none focus:border-cyan-500 cursor-pointer">
                  ${tCanLOptions}
                </select>
              </div>
              <div>
                <label class="text-[10px] text-gray-400 block mb-0.5">Vitesse Soufflerie</label>
                <select onchange="updateProgramDraft('vCanL', this.value)"
                  class="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs text-center focus:outline-none focus:border-cyan-500 cursor-pointer">
                  ${fanDuctOptions(vCanL)}
                </select>
              </div>
            </div>
          </div>

          <!-- Canalisation Droite -->
          <div class="bg-gray-900/90 p-2.5 rounded-lg border border-gray-800 space-y-2">
            <div class="text-[11px] text-sky-400 font-semibold flex items-center justify-between">
              <span class="truncate">➡️ ${escapeHtml(getDuctName("DX"))}</span>
            </div>
            <div class="space-y-1.5">
              <div>
                <label class="text-[10px] text-gray-400 block mb-0.5">T° Consigne</label>
                <select onchange="updateProgramDraft('tCanR', this.value)"
                  class="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs text-center focus:outline-none focus:border-sky-500 cursor-pointer">
                  ${tCanROptions}
                </select>
              </div>
              <div>
                <label class="text-[10px] text-gray-400 block mb-0.5">Vitesse Soufflerie</label>
                <select onchange="updateProgramDraft('vCanR', this.value)"
                  class="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs text-center focus:outline-none focus:border-sky-500 cursor-pointer">
                  ${fanDuctOptions(vCanR)}
                </select>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Jours actifs de la semaine -->
      <div class="bg-gray-950/70 p-3.5 rounded-xl border border-gray-800 space-y-2">
        <span class="font-bold text-gray-200 text-xs block">📅 Jours d'Activation</span>
        <div class="grid grid-cols-7 gap-1.5 pt-1">
          ${dayBtns}
        </div>
      </div>

      <!-- Bouton Enregistrer / Valider pour sortir de la bulle -->
      <div class="pt-1">
        <button type="button" onclick="closeProgramModal()"
          class="w-full py-2.5 px-4 rounded-xl font-bold text-xs bg-orange-600 hover:bg-orange-500 text-white shadow-lg transition cursor-pointer flex items-center justify-center gap-2">
          <span>Enregistrer les modifications</span>
        </button>
      </div>
    </div>
  `;
}

// Rendu de la Frise Gantt 24h et des 4 boutons Programmes Chrono P1..P4
function renderChronoPrograms() {
  const container = document.getElementById("chrono-programs-grid");
  const ganttTracks = document.getElementById("chrono-gantt-tracks");
  if (!container) return;

  const dayLabels = [
    { bit: 1, name: "Lun" }, { bit: 2, name: "Mar" }, { bit: 4, name: "Mer" },
    { bit: 8, name: "Jeu" }, { bit: 16, name: "Ven" }, { bit: 32, name: "Sam" }, { bit: 64, name: "Dim" }
  ];
  const progColors = {
    1: "bg-emerald-500/85 border-emerald-400",
    2: "bg-orange-500/85 border-orange-400",
    3: "bg-cyan-500/85 border-cyan-400",
    4: "bg-purple-500/85 border-purple-400"
  };

  // Badges colorés pour le libellé P1..P4 dans la frise
  const progTrackBadges = {
    1: "bg-emerald-950/80 border-emerald-500/70 text-emerald-300 hover:border-emerald-400",
    2: "bg-orange-950/80 border-orange-500/70 text-orange-300 hover:border-orange-400",
    3: "bg-cyan-950/80 border-cyan-500/70 text-cyan-300 hover:border-cyan-400",
    4: "bg-purple-950/80 border-purple-500/70 text-purple-300 hover:border-purple-400"
  };

  // Styles des 4 boutons de cartes programmes
  const progBorderColors = {
    1: "border-emerald-500/50 hover:border-emerald-400 bg-gradient-to-br from-emerald-950/60 to-gray-900/90 hover:from-emerald-900/60 hover:to-gray-800/90 shadow-emerald-950/30",
    2: "border-orange-500/50 hover:border-orange-400 bg-gradient-to-br from-orange-950/60 to-gray-900/90 hover:from-orange-900/60 hover:to-gray-800/90 shadow-orange-950/30",
    3: "border-cyan-500/50 hover:border-cyan-400 bg-gradient-to-br from-cyan-950/60 to-gray-900/90 hover:from-cyan-900/60 hover:to-gray-800/90 shadow-cyan-950/30",
    4: "border-purple-500/50 hover:border-purple-400 bg-gradient-to-br from-purple-950/60 to-gray-900/90 hover:from-purple-900/60 hover:to-gray-800/90 shadow-purple-950/30"
  };
  const progBadgeStyles = {
    1: "bg-emerald-500 text-gray-950 font-black",
    2: "bg-orange-500 text-gray-950 font-black",
    3: "bg-cyan-500 text-gray-950 font-black",
    4: "bg-purple-500 text-white font-black"
  };
  const progTextColors = {
    1: "text-emerald-300",
    2: "text-orange-300",
    3: "text-cyan-300",
    4: "text-purple-300"
  };
  const progPillColors = {
    1: "bg-emerald-950/80 text-emerald-300 border-emerald-700/60",
    2: "bg-orange-950/80 text-orange-300 border-orange-700/60",
    3: "bg-cyan-950/80 text-cyan-300 border-cyan-700/60",
    4: "bg-purple-950/80 text-purple-300 border-purple-700/60"
  };

  // Détermination du jour courant (par défaut) et du jour sélectionné
  const now = new Date();
  const todayJsDay = now.getDay();
  const todayDayObj = GANTT_DAYS.find(d => d.jsDay === todayJsDay) || GANTT_DAYS[0];

  if (selectedGanttDayBit === null) {
    selectedGanttDayBit = todayDayObj.bit;
  }
  const selectedDayIdx = GANTT_DAYS.findIndex(d => d.bit === selectedGanttDayBit);
  const selectedDayObj = (selectedDayIdx >= 0) ? GANTT_DAYS[selectedDayIdx] : todayDayObj;
  const isTodaySelected = (selectedDayObj.bit === todayDayObj.bit);

  // Jour précédent pour continuité des créneaux chevauchant minuit
  const prevDayIdx = (selectedDayIdx >= 0 ? selectedDayIdx + 6 : 6) % 7;
  const prevDayObj = GANTT_DAYS[prevDayIdx];

  // Rendu du sélecteur de jour dans l'en-tête de la frise (étendu dynamiquement, texte tronqué)
  const daySelector = document.getElementById("chrono-day-selector");
  if (daySelector) {
    daySelector.innerHTML = GANTT_DAYS.map(d => {
      const isSel = (d.bit === selectedDayObj.bit);
      return `<button type="button" onclick="setGanttDay(${d.bit})"
        class="min-h-[30px] sm:min-h-[32px] px-1 py-1 rounded-md text-xs font-semibold flex items-center justify-center transition-all cursor-pointer min-w-0 w-full overflow-hidden ${isSel
          ? 'bg-orange-600 text-white font-bold shadow-md shadow-orange-950/50 border border-orange-500'
          : 'bg-gray-900 text-gray-400 hover:text-white hover:bg-gray-800 border border-gray-800'
        }"
        title="${d.full}">
        <span class="truncate block w-full text-center">${d.full}</span>
      </button>`;
    }).join("");
  }

  // Position du marqueur de l'heure actuelle sur la frise 24h
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const nowPct = ((nowMin / 1440) * 100).toFixed(2);
  const nowStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  const nowLine = document.getElementById("gantt-now-line");
  if (nowLine) {
    if (isTodaySelected) {
      nowLine.style.display = "block";
      nowLine.style.left = `${nowPct}%`;
    } else {
      nowLine.style.display = "none";
    }
  }

  let buttonsHtml = "";
  let ganttHtml = "";

  for (let p = 1; p <= 4; p++) {
    const startSlot = Number(getRegVal(`chrono_p${p}_start_set`, latestData[`chrono_p${p}_start`] ?? 144));
    const stopSlot = Number(getRegVal(`chrono_p${p}_stop_set`, latestData[`chrono_p${p}_stop`] ?? 144));
    const mask = Number(getRegVal(`chrono_p${p}_days_mask`, latestData[`chrono_p${p}_days`] ?? 0));
    const pwr = Number(getRegVal(`chrono_p${p}_power_set`, latestData[`chrono_p${p}_power`] ?? 7));
    const temp = Number(getRegVal(`chrono_p${p}_temperature_set`, latestData[`chrono_p${p}_temp`] ?? 20));

    const fanFront = Number(getRegVal(`chrono_p${p}_fan_front_set`, 0));
    const tCanL = Number(getRegVal(`chrono_p${p}_tcanl_set`, latestData[`chrono_p${p}_tcanl`] ?? latestData[`chrono_p${p}_temp`] ?? 20));
    const vCanL = Number(getRegVal(`chrono_p${p}_canl_set`, latestData[`chrono_p${p}_canl`] ?? 0));
    const tCanR = Number(getRegVal(`chrono_p${p}_tcanr_set`, latestData[`chrono_p${p}_tcanr`] ?? latestData[`chrono_p${p}_temp`] ?? 20));
    const vCanR = Number(getRegVal(`chrono_p${p}_canr_set`, latestData[`chrono_p${p}_canr`] ?? 0));

    const isDayActive = (mask & selectedDayObj.bit) !== 0;
    const wasPrevDayActive = (mask & prevDayObj.bit) !== 0;

    // Calcul du segment Gantt filtré sur le jour sélectionné (sur 144 pas de 10 min) sans contenu textuel intérieur
    let barSegments = "";
    if (startSlot < 144 && stopSlot < 144 && startSlot !== stopSlot) {
      if (stopSlot > startSlot) {
        if (isDayActive) {
          const leftPct = ((startSlot / 144) * 100).toFixed(2);
          const widthPct = (((stopSlot - startSlot) / 144) * 100).toFixed(2);
          barSegments = `<div style="left:${leftPct}%;width:${widthPct}%" class="absolute inset-y-0.5 rounded border ${progColors[p]} shadow-sm cursor-pointer" title="P${p}: ${slotToTime(startSlot)}-${slotToTime(stopSlot)} (${temp}°C / P${pwr})" onclick="openProgramModal(${p})"></div>`;
        }
      } else {
        // Créneau chevauchant minuit (ex: 22h00 -> 06h00)
        // 1. Matinée (00h00 -> stopSlot), suite du démarrage de la veille
        if (wasPrevDayActive) {
          const wMorning = ((stopSlot / 144) * 100).toFixed(2);
          barSegments += `<div style="left:0%;width:${wMorning}%" class="absolute inset-y-0.5 rounded-r border ${progColors[p]} shadow-sm cursor-pointer" title="P${p}: 00h-${slotToTime(stopSlot)} (${temp}°C) - Suite veille (${prevDayObj.name})" onclick="openProgramModal(${p})"></div>`;
        }
        // 2. Soirée (startSlot -> 24h00), démarrage du créneau aujourd'hui
        if (isDayActive) {
          const lEvening = ((startSlot / 144) * 100).toFixed(2);
          const wEvening = (((144 - startSlot) / 144) * 100).toFixed(2);
          barSegments += `<div style="left:${lEvening}%;width:${wEvening}%" class="absolute inset-y-0.5 rounded-l border ${progColors[p]} shadow-sm cursor-pointer" title="P${p}: ${slotToTime(startSlot)}-24h (${temp}°C / P${pwr})" onclick="openProgramModal(${p})"></div>`;
        }
      }
    }

    // Libellé P1..P4 coloré dans la frise
    ganttHtml += `
      <div class="flex items-center gap-2">
        <button type="button" onclick="openProgramModal(${p})"
          class="w-8 text-center py-0.5 rounded text-[11px] font-extrabold border cursor-pointer hover:brightness-125 transition shadow-sm ${progTrackBadges[p]}"
          title="Ouvrir le Programme P${p}">P${p}</button>
        <div class="relative flex-1 h-5 bg-gray-900 rounded border border-gray-800 overflow-hidden">
          ${barSegments}
        </div>
      </div>
    `;

    // Calcul du résumé pour le bouton de carte programme compacte (grille 2x2 sans titre, avec canalisations)
    const isConfigured = (startSlot < 144 && stopSlot < 144 && startSlot !== stopSlot);
    const activeDays = dayLabels.filter(d => (mask & d.bit) !== 0).map(d => d.name);
    let activeDaysSummary = "Aucun jour";
    if (activeDays.length === 7) activeDaysSummary = "Tous les jours";
    else if (activeDays.length > 0) activeDaysSummary = activeDays.join(", ");

    const fanDisplay = fanFront === 8 ? "AUTO" : (fanFront === 0 ? "OFF" : String(fanFront));
    const fanLDisplay = vCanL === 8 ? "AUTO" : (vCanL === 0 ? "OFF" : String(vCanL));
    const fanRDisplay = vCanR === 8 ? "AUTO" : (vCanR === 0 ? "OFF" : String(vCanR));

    buttonsHtml += `
      <button type="button" onclick="openProgramModal(${p})"
        class="w-full text-left p-2.5 sm:p-3 rounded-xl border transition-all duration-200 cursor-pointer shadow-md hover:shadow-lg hover:scale-[1.01] flex flex-col justify-between gap-1.5 sm:gap-2 ${progBorderColors[p]} group">
        <div class="flex items-center justify-between gap-1">
          <span class="px-2 py-0.5 rounded text-[11px] sm:text-xs font-black ${progBadgeStyles[p]} shadow-sm">P${p}</span>
        </div>

        <div class="space-y-1 text-[11px] sm:text-xs">
          ${isConfigured ? `
            <div class="flex items-center gap-2 text-gray-200 font-medium truncate">
              <span class="flex items-center gap-1" title="Consigne T° Salon">🌡️ ${temp}°C</span>
              <span class="flex items-center gap-1 text-amber-300" title="Puissance de chauffe (1..7)">🔥 ${pwr}</span>
              <span class="flex items-center gap-1 text-emerald-300" title="Ventilation Façade">💨 ${fanDisplay}</span>
            </div>

            <div class="grid grid-cols-2 gap-1 text-[10px] sm:text-[11px] pt-0.5 border-t border-gray-800/60">
              <span class="text-cyan-400 truncate flex items-center gap-1" title="${escapeHtml(getDuctName("SX"))} : ${tCanL}°C, Vitesse ${fanLDisplay}">
                <span>⬅️</span>
                <span class="truncate max-w-[48px] text-[10px] text-cyan-300/90">${escapeHtml(getDuctName("SX"))}</span>
                <span>${tCanL}°C</span>
                <span class="text-cyan-300 font-mono">💨${fanLDisplay}</span>
              </span>
              <span class="text-sky-400 truncate flex items-center gap-1" title="${escapeHtml(getDuctName("DX"))} : ${tCanR}°C, Vitesse ${fanRDisplay}">
                <span>➡️</span>
                <span class="truncate max-w-[48px] text-[10px] text-sky-300/90">${escapeHtml(getDuctName("DX"))}</span>
                <span>${tCanR}°C</span>
                <span class="text-sky-300 font-mono">💨${fanRDisplay}</span>
              </span>
            </div>
          ` : `
            <div class="text-gray-500 italic py-0.5 flex items-center gap-1.5">
              <span>⏹️</span><span>Programme inactif</span>
            </div>
          `}

          <div class="text-[10px] sm:text-[11px] text-gray-400 truncate pt-0.5 flex items-center gap-1">
            <span>📅</span>
            <span class="truncate">${activeDaysSummary}</span>
          </div>
        </div>
      </button>
    `;
  }

  if (ganttTracks) ganttTracks.innerHTML = ganttHtml;
  container.innerHTML = buttonsHtml;

  // Rafraîchir la modale ouverte sans perturber la saisie si l'utilisateur est en train d'écrire
  if (currentOpenProgramModal !== null) {
    const activeEl = document.activeElement;
    const isEditing = activeEl && activeEl.closest && activeEl.closest("#program-modal") && (activeEl.tagName === "INPUT" || activeEl.tagName === "SELECT");
    if (!isEditing) {
      renderProgramModalContent(currentOpenProgramModal);
    }
  }
}

// Écouteur d'échappement pour fermer la popup
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && currentOpenProgramModal !== null) {
    closeProgramModal();
  }
});

function toggleChronoWeek() {
  const cur = Number(getRegVal("chrono_week_enable_set", latestData.chrono_week_enable ?? 0));
  sendCommand("chrono_week_enable_set", cur ? 0 : 1);
}
