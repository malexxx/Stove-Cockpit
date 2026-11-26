// =============================================================================
// FEATURE GRANULÉS & IA — TRÉMIE 35 KG, QUALITÉ COMBUSTIBLE & TARAGES MÉLANGE P/A
// =============================================================================

let _hopperConfirmPromptShown = false;

function _buildRefillPayload(bagsOrFull) {
  const capKg = Number(HOPPER_CAPACITY_KG || 35);
  const rawCur = Number(latestData?.pellet_hopper_pct);
  const basePct = Number.isFinite(rawCur) && rawCur >= 0 ? rawCur : 0;
  const bagWeight = Number(typeof BAG_WEIGHT_KG !== "undefined" ? BAG_WEIGHT_KG : 15);
  if (bagsOrFull === "full") {
    const fullBags = Math.round((capKg / bagWeight) * 100) / 100;
    return { target_pct: 100.0, level_pct: 100.0, bags_added: fullBags };
  }
  const bagsNum = Number(bagsOrFull) === 1 ? 1 : 2;
  const addedPct = ((bagsNum * bagWeight) / Math.max(1, capKg)) * 100.0;
  const targetPct = Math.min(100.0, Math.round((basePct + addedPct) * 10) / 10);
  return { target_pct: targetPct, level_pct: targetPct, bags_added: bagsNum };
}

async function confirmHopperRefillChoice(bagsOrFull) {
  if (typeof closeActionModal === "function") closeActionModal();
  const payload = _buildRefillPayload(bagsOrFull);
  try {
    const j = await window.stoveProvider.refillHopper(payload);
    _hopperConfirmPromptShown = false;
    await refreshLatestOnly();
    const capKg = j.hopper_capacity_kg ?? HOPPER_CAPACITY_KG;
    const stockBags = j.pellet_bags_stock ?? j.bags_stock ?? "--";
    showToast(`Trémie confirmée à ${j.pellet_hopper_pct}% (${capKg} kg max) — Stock restant : ${stockBags} sacs`);
  } catch (e) {
    showToast("Erreur confirmation trémie : " + (e?.message || "Échec"), true);
  }
}

function openHopperRefillConfirmModal(reason = "") {
  const capKg = Number(HOPPER_CAPACITY_KG || 35);
  const bagWeight = Number(typeof BAG_WEIGHT_KG !== "undefined" ? BAG_WEIGHT_KG : 15);
  const pct1 = Math.min(100, Math.round((bagWeight / Math.max(1, capKg)) * 100));
  const pct2 = Math.min(100, Math.round(((bagWeight * 2) / Math.max(1, capKg)) * 100));
  const reasonHtml = reason
    ? `<p class="text-[11px] text-amber-300/90">${escapeHtml(reason)}</p>`
    : `<p class="text-[11px] text-gray-300">Une ouverture de trappe ou une alarme granulés (AL02/AL03) a été détectée. Confirmez la quantité rechargée pour recalibrer la jauge :</p>`;

  openActionModal({
    title: "🪵 Confirmer le rechargement de la trémie",
    htmlContent: `
      <div class="space-y-3 text-xs">
        ${reasonHtml}
        <div class="grid grid-cols-1 gap-2">
          <button type="button" onclick="confirmHopperRefillChoice(1)"
            class="w-full px-3 py-2.5 rounded-xl bg-[#3b2014] hover:bg-[#4d2c1c] text-[#f5d0b5] border border-[#854726] font-bold flex items-center justify-between transition cursor-pointer">
            <span>🌾 +1 Sac (${bagWeight} kg)</span>
            <span class="text-[11px] text-amber-300">+${pct1}%</span>
          </button>
          <button type="button" onclick="confirmHopperRefillChoice(2)"
            class="w-full px-3 py-2.5 rounded-xl bg-[#4d2c1c] hover:bg-[#5f3622] text-[#fde2cc] border border-[#96562c] font-bold flex items-center justify-between transition cursor-pointer">
            <span>🌾🌾 +2 Sacs (${bagWeight * 2} kg)</span>
            <span class="text-[11px] text-amber-300">+${pct2}%</span>
          </button>
          <button type="button" onclick="confirmHopperRefillChoice('full')"
            class="w-full px-3 py-2.5 rounded-xl bg-emerald-900/60 hover:bg-emerald-800/70 text-emerald-100 border border-emerald-600/70 font-bold flex items-center justify-between transition cursor-pointer">
            <span>🪵 Plein à ras bord (${capKg} kg)</span>
            <span class="text-[11px] text-emerald-300">100%</span>
          </button>
        </div>
      </div>
    `,
    confirmText: "Laisser en ? (Plus tard)",
    showCancel: false,
    onConfirm: () => { },
  });
}

function maybePromptHopperRefillConfirm() {
  if (_hopperConfirmPromptShown) return;
  if (!window.stoveProvider?.isContainerActive?.()) return;
  const modal = document.getElementById("action-modal");
  if (modal && !modal.classList.contains("hidden")) return;
  _hopperConfirmPromptShown = true;
  const stAlarm = Number(latestData?.alarm_code ?? 0);
  const lidOpen = Boolean(latestData?.popup_pellet_open);
  let reason = "";
  if (lidOpen) {
    reason = "Ouverture de la trappe à granulés détectée. Quelle quantité avez-vous ajoutée ?";
  } else if (stAlarm === 2 || stAlarm === 3) {
    reason = `Alarme AL0${stAlarm} détectée. Confirmez la quantité rechargée pour réinitialiser la jauge :`;
  }
  openHopperRefillConfirmModal(reason);
}

function resetHopperRefillPromptFlag() {
  _hopperConfirmPromptShown = false;
}

function handleHeaderHopperClick() {
  const rawPct = latestData?.pellet_hopper_pct;
  const parsed = (rawPct === null || rawPct === undefined || rawPct === "") ? NaN : Number(rawPct);
  if (window.stoveProvider?.isContainerActive?.() && (!Number.isFinite(parsed) || parsed < 0)) {
    openHopperRefillConfirmModal();
    return;
  }
  switchTab("tab-pellets");
}

function refillHopper(bagsAdded = "full") {
  const isOneBag = Number(bagsAdded) === 1;
  const isTwoBags = Number(bagsAdded) === 2;
  const capKg = Number(HOPPER_CAPACITY_KG || 35);
  const bagWeight = Number(typeof BAG_WEIGHT_KG !== "undefined" ? BAG_WEIGHT_KG : 15);
  const choice = isOneBag ? 1 : (isTwoBags ? 2 : "full");
  let title = `🌾 Trémie Pleine 100% (${capKg} kg)`;
  let message = `Remplir la trémie à 100 % (capacité ${capKg} kg) et mettre à jour le stock de sacs de ${bagWeight} kg ?`;
  let confirmText = `Trémie Pleine (${capKg} kg)`;
  if (isOneBag) {
    title = `🌾 Ajout +1 Sac (${bagWeight} kg)`;
    message = `Ajouter 1 sac de ${bagWeight} kg dans la trémie de ${capKg} kg et décrémenter le stock de 1 sac ?`;
    confirmText = `+1 Sac (${bagWeight} kg)`;
  } else if (isTwoBags) {
    title = `🌾🌾 Ajout +2 Sacs (${bagWeight * 2} kg)`;
    message = `Ajouter 2 sacs (${bagWeight * 2} kg) dans la trémie de ${capKg} kg et décrémenter le stock de 2 sacs ?`;
    confirmText = `+2 Sacs (${bagWeight * 2} kg)`;
  }
  openActionModal({
    title,
    message,
    confirmText,
    onConfirm: async () => {
      await confirmHopperRefillChoice(choice);
    }
  });
}

let currentPelletAiDiagnosis = null;

function renderPelletQuality(data) {
  const latest = data?.latest || latestData || {};
  let q = data?.pellet_quality || latest.pellet_quality;

  // Fallback neutre aligné sur l'évaluation batch serveur si le point n'est pas encore enrichi
  if (!q) {
    const curTrim = Number(latest.trim_pellet_pct ?? getRegVal("trim_pellet_pct", 0));
    q = {
      status: "idle",
      quality_score: null,
      quality_label: "En attente d'évaluation lot",
      quality_color: "gray",
      target_flame_temp: null,
      flame_delta: null,
      current_trim: curTrim,
      suggested_trim: curTrim,
      explanation: `Analyse multi-cycles par lot de granulés en attente de synchronisation serveur (tarage actuel : ${curTrim > 0 ? "+" + curTrim : curTrim}%).`,
      action_needed: false
    };
  }

  currentPelletAiDiagnosis = q;

  // Mise à jour du badge d'état
  const badgeEl = document.getElementById("pellet-quality-badge");
  if (badgeEl) {
    badgeEl.textContent = q.quality_label;
    if (q.quality_color === "emerald") {
      badgeEl.className = "text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-950/80 text-emerald-400 border border-emerald-700/50";
    } else if (q.quality_color === "amber") {
      badgeEl.className = "text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-950/80 text-amber-400 border border-amber-700/50";
    } else if (q.quality_color === "rose") {
      badgeEl.className = "text-[10px] font-semibold px-2 py-0.5 rounded-full bg-rose-950/80 text-rose-400 border border-rose-700/50";
    } else if (q.quality_color === "sky") {
      badgeEl.className = "text-[10px] font-semibold px-2 py-0.5 rounded-full bg-sky-950/80 text-sky-400 border border-sky-700/50";
    } else {
      badgeEl.className = "text-[10px] font-semibold px-2 py-0.5 rounded-full bg-gray-800 text-gray-300 border border-gray-700";
    }
  }

  // Métriques thermiques
  const flameEl = document.getElementById("pellet-flame-val");
  if (flameEl) {
    if ((q.status === "active" || q.status === "stabilizing" || q.status === "natural_convection") && q.target_flame_temp) {
      flameEl.textContent = `${Math.round(latest.temp_probe_k || 0)} / ${Math.round(q.target_flame_temp)}`;
    } else {
      flameEl.textContent = `${Math.round(latest.temp_probe_k || 0)} / --`;
    }
  }

  const deltaEl = document.getElementById("pellet-delta-val");
  if (deltaEl) {
    if (q.status === "stabilizing") {
      deltaEl.textContent = q.stable_minutes ? `${q.stable_minutes}/30m` : "En cours";
      deltaEl.className = "font-bold text-sky-400 text-xs";
    } else if (q.status === "natural_convection") {
      deltaEl.textContent = "Conv. Nat.";
      deltaEl.className = "font-bold text-amber-400 text-xs";
    } else if (q.status === "active" && q.flame_delta_avg !== null && q.flame_delta_avg !== undefined) {
      const dVal = q.flame_delta_avg;
      deltaEl.textContent = `${dVal >= 0 ? "+" : ""}${Number(dVal).toFixed(1)}°C`;
      deltaEl.className = "font-bold text-xs " + (q.quality_color === "emerald" ? "text-emerald-400" : (q.quality_color === "amber" ? "text-amber-400" : "text-rose-400"));
    } else {
      deltaEl.textContent = "--";
      deltaEl.className = "font-bold text-gray-400 text-xs";
    }
  }

  const curTrimEl = document.getElementById("pellet-cur-trim");
  if (curTrimEl) {
    const curVal = q.current_trim ?? 0;
    curTrimEl.textContent = curVal > 0 ? `+${curVal}` : `${curVal}`;
  }

  // Diagnostic explicatif IA
  const expEl = document.getElementById("pellet-ai-explanation");
  if (expEl) {
    expEl.textContent = q.explanation;
  }

  // Proposition & Action de tarage IA
  const propEl = document.getElementById("pellet-ai-trim-proposal");
  const applyBtn = document.getElementById("pellet-ai-apply-btn");
  if (propEl) {
    if (q.action_needed) {
      const sign = q.suggested_trim > 0 ? "+" : "";
      propEl.textContent = `Tarage recommandé : ${sign}${q.suggested_trim}% (Actuel : ${q.current_trim}%)`;
      if (applyBtn) {
        applyBtn.classList.remove("hidden");
        applyBtn.textContent = `Appliquer (${sign}${q.suggested_trim}%)`;
      }
    } else if (q.status === "stabilizing") {
      propEl.textContent = `Stabilisation thermique en cours (${q.stable_minutes || 0}/30 min sans variation)`;
      if (applyBtn) {
        applyBtn.classList.add("hidden");
      }
    } else if (q.status === "natural_convection") {
      propEl.textContent = "Tarage verrouillé : ventilateurs à l'arrêt (convection naturelle)";
      if (applyBtn) {
        applyBtn.classList.add("hidden");
      }
    } else {
      propEl.textContent = q.status === "active" ? "Tarage optimal (aucun ajustement requis)" : "Tarage en attente de combustion active";
      if (applyBtn) {
        applyBtn.classList.add("hidden");
      }
    }
  }
}

function applyAiPelletTrim() {
  if (!currentPelletAiDiagnosis || !currentPelletAiDiagnosis.action_needed) {
    showToast("Aucun ajustement de tarage requis actuellement.");
    return;
  }
  const targetVal = Number(currentPelletAiDiagnosis.suggested_trim);
  const sign = targetVal > 0 ? "+" : "";
  const activeMode = latestData.comm_mode || (currentSettings && currentSettings.comm_mode) || "agua_cloud";
  const isAgua = (activeMode === "agua_cloud");
  const remoteNote = isAgua
    ? `\n\n⚠️ IMPORTANT (Mode Cloud Agua) :\nLes offsets 70 et 71 ne figurent pas dans la table Cloud Agua IOT. L'application enregistre cette valeur en mémoire locale, mais vous devez la valider sur votre radiocommande :\nMENU ▸ PROGRAMMATION UTILISATEUR ▸ MÉLANGE G/A.`
    : "";

  openActionModal({
    title: "✨ Tarage Granulés Optimisé par IA",
    message: `Appliquer la recommandation IA sur le tarage d'alimentation en granulés ?\n\n• Nouveau tarage recommandé : ${sign}${targetVal} %\n• Tarage actuel : ${currentPelletAiDiagnosis.current_trim} %\n\nMotif : ${currentPelletAiDiagnosis.explanation}${remoteNote}`,
    confirmText: isAgua ? `Mémoriser (${sign}${targetVal}%)` : `Appliquer (${sign}${targetVal}%)`,
    onConfirm: async () => {
      await sendCommand("trim_pellet_pct", targetVal);
      showToast(`Tarage granulés ${sign}${targetVal}% enregistré.${isAgua ? " Validez sur votre radiocommande (MÉLANGE G/A)." : ""}`);
      await refreshLatestOnly();
    }
  });
}

let currentExhaustAiDiagnosis = null;

function renderExhaustQuality(data) {
  const latest = data?.latest || latestData || {};
  let q = data?.exhaust_quality || latest.exhaust_quality;

  // Calcul dynamique côté client si non fourni directement
  if (!q) {
    const state = Number(latest.status_code ?? 0);
    const pwr = Number(latest.power_actual ?? latest.power_level ?? 0);
    const dep = Number(latest.depression_pa ?? 0);
    const rpm = Number(latest.exhaust_rpm ?? 0);
    const curTrim = Number(latest.trim_exhaust_pct ?? getRegVal("trim_exhaust_pct", 0));

    if (state !== 5 || pwr <= 0) {
      if (state === 5 && pwr === 0) {
        q = {
          status: "modulating",
          quality_score: null,
          quality_label: "Modulation P0 (Éco)",
          quality_color: "sky",
          target_depression_pa: null,
          depression_pa: dep,
          dep_delta: null,
          dep_delta_avg: null,
          exhaust_rpm: rpm,
          current_trim: curTrim,
          suggested_trim: curTrim,
          explanation: `Poêle en modulation P0 (Ralenti / Consigne atteinte). L'extracteur tourne à vitesse réduite de maintien (${rpm} RPM). L'analyse aéraulique de calibrage requiert un régime nominal P1 à P7.`,
          action_needed: false
        };
      } else {
        q = {
          status: "idle",
          quality_score: null,
          quality_label: "En attente tirage actif",
          quality_color: "gray",
          target_depression_pa: null,
          depression_pa: dep,
          dep_delta: null,
          dep_delta_avg: null,
          exhaust_rpm: rpm,
          current_trim: curTrim,
          suggested_trim: curTrim,
          explanation: curTrim !== 0
            ? `L'analyse aéraulique requiert que le poêle soit en phase active de travail (P1 à P7). Tarage extracteur fumées en mémoire : ${curTrim > 0 ? "+" + curTrim : curTrim}%.`
            : "L'analyse aéraulique requiert que le poêle soit en phase active de travail (P1 à P7). Tarage extracteur : 0%.",
          action_needed: false
        };
      }
    } else if (latest.dep_delta_avg === null || latest.dep_delta_avg === undefined) {
      q = {
        status: "stabilizing",
        quality_score: null,
        quality_label: `Stabilisation P${pwr}`,
        quality_color: "sky",
        target_depression_pa: Math.round((2.0 + (pwr * 0.25)) * 10) / 10,
        depression_pa: dep,
        dep_delta: Math.round((dep - (2.0 + (pwr * 0.25))) * 10) / 10,
        dep_delta_avg: null,
        exhaust_rpm: rpm,
        current_trim: curTrim,
        suggested_trim: curTrim,
        explanation: `Consigne P${pwr} en cours de stabilisation aéraulique. Le lissage sur 30 minutes requiert une consigne de puissance et une ventilation stables avant d'évaluer le tirage.`,
        action_needed: false
      };
    } else {
      const targetDep = Math.round((2.0 + (pwr * 0.25)) * 10) / 10;
      const instantDelta = Math.round((dep - targetDep) * 10) / 10;
      const delta = Math.round(Number(latest.dep_delta_avg) * 10) / 10;
      if (delta < -1.0 || dep < 1.2) {
        const suggested = Math.min(5, curTrim + (delta < -2.0 ? 2 : 1));
        q = {
          status: "active",
          quality_score: Math.max(50, Math.round(100 - Math.abs(delta) * 20.0)),
          quality_label: "Débit d'Air Insuffisant (Pertes de charge)",
          quality_color: "rose",
          target_depression_pa: targetDep,
          depression_pa: dep,
          dep_delta: instantDelta,
          dep_delta_avg: delta,
          exhaust_rpm: rpm,
          current_trim: curTrim,
          suggested_trim: suggested,
          explanation: `Dépression comburant inférieure à la consigne (${delta >= 0 ? "+" + delta : delta} Pa vs cible ${targetDep} Pa, moyenne 30 min). Mesure capteur d'entrée à ${dep.toFixed(1)} Pa (seuil d'alerte AL11 à 1,0 Pa). Conseil : reporter le tarage extracteur à ${suggested > 0 ? "+" + suggested : suggested}% sur la radiocommande (MENU ▸ PROGRAMMATION UTILISATEUR ▸ MÉLANGE G/A).`,
          action_needed: suggested !== curTrim
        };
      } else if (delta > 1.5 || dep > 6.0) {
        const suggested = Math.max(-5, curTrim - (delta > 2.5 ? 2 : 1));
        q = {
          status: "active",
          quality_score: Math.max(55, Math.round(100 - Math.abs(delta) * 15.0)),
          quality_label: "Débit d'Air Élevé (Sur-tirage dynamique)",
          quality_color: "amber",
          target_depression_pa: targetDep,
          depression_pa: dep,
          dep_delta: instantDelta,
          dep_delta_avg: delta,
          exhaust_rpm: rpm,
          current_trim: curTrim,
          suggested_trim: suggested,
          explanation: `Dépression comburant élevée (${delta >= 0 ? "+" + delta : delta} Pa vs cible ${targetDep} Pa, moyenne 30 min). Sur-tirage ou vent fort évacuant trop vite les calories. Conseil : réduire l'extracteur à ${suggested > 0 ? "+" + suggested : suggested}% sur la radiocommande (MENU ▸ PROGRAMMATION UTILISATEUR ▸ MÉLANGE G/A).`,
          action_needed: suggested !== curTrim
        };
      } else {
        q = {
          status: "active",
          quality_score: Math.min(100, Math.round(98 - Math.abs(delta) * 10.0)),
          quality_label: "Aéraulique Optimale (Débit Conforme)",
          quality_color: "emerald",
          target_depression_pa: targetDep,
          depression_pa: dep,
          dep_delta: instantDelta,
          dep_delta_avg: delta,
          exhaust_rpm: rpm,
          current_trim: curTrim,
          suggested_trim: curTrim,
          explanation: `Dépression dynamique et débit comburant parfaitement équilibrés (${dep.toFixed(1)} Pa, écart moyen de ${delta >= 0 ? "+" + delta : delta} Pa en P${pwr} sur 30 min stables). Conforme aux spécifications Nobis. Aucun ajustement requis.`,
          action_needed: false
        };
      }
    }
  }

  currentExhaustAiDiagnosis = q;

  // Mise à jour du badge d'état
  const badgeEl = document.getElementById("exhaust-quality-badge");
  if (badgeEl) {
    badgeEl.textContent = q.quality_label;
    if (q.quality_color === "emerald") {
      badgeEl.className = "text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-950/80 text-emerald-400 border border-emerald-700/50";
    } else if (q.quality_color === "amber") {
      badgeEl.className = "text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-950/80 text-amber-400 border border-amber-700/50";
    } else if (q.quality_color === "rose") {
      badgeEl.className = "text-[10px] font-semibold px-2 py-0.5 rounded-full bg-rose-950/80 text-rose-400 border border-rose-700/50";
    } else if (q.quality_color === "sky") {
      badgeEl.className = "text-[10px] font-semibold px-2 py-0.5 rounded-full bg-sky-950/80 text-sky-400 border border-sky-700/50";
    } else {
      badgeEl.className = "text-[10px] font-semibold px-2 py-0.5 rounded-full bg-gray-800 text-gray-300 border border-gray-700";
    }
  }

  // Métriques dépression
  const depEl = document.getElementById("exhaust-dep-val");
  if (depEl) {
    if ((q.status === "active" || q.status === "stabilizing") && q.target_depression_pa !== null && q.target_depression_pa !== undefined) {
      depEl.textContent = `${Number(latest.depression_pa || 0).toFixed(1)} / ${Number(q.target_depression_pa).toFixed(1)}`;
    } else {
      depEl.textContent = `${Number(latest.depression_pa || 0).toFixed(1)} / --`;
    }
  }

  const deltaEl = document.getElementById("exhaust-delta-val");
  if (deltaEl) {
    if (q.status === "stabilizing") {
      deltaEl.textContent = q.stable_minutes ? `${q.stable_minutes}/30m` : "En cours";
      deltaEl.className = "font-bold text-sky-400 text-xs";
    } else if (q.status === "active" && q.dep_delta_avg !== null && q.dep_delta_avg !== undefined) {
      const dVal = q.dep_delta_avg;
      deltaEl.textContent = `${dVal >= 0 ? "+" : ""}${Number(dVal).toFixed(1)} Pa`;
      deltaEl.className = "font-bold text-xs " + (q.quality_color === "emerald" ? "text-emerald-400" : (q.quality_color === "amber" ? "text-amber-400" : "text-rose-400"));
    } else {
      deltaEl.textContent = "--";
      deltaEl.className = "font-bold text-gray-400 text-xs";
    }
  }

  const curTrimEl = document.getElementById("exhaust-cur-trim");
  if (curTrimEl) {
    const curVal = q.current_trim ?? 0;
    curTrimEl.textContent = curVal > 0 ? `+${curVal}` : `${curVal}`;
  }

  // Diagnostic explicatif IA
  const expEl = document.getElementById("exhaust-ai-explanation");
  if (expEl) {
    expEl.textContent = q.explanation;
  }

  // Proposition & Action de tarage IA
  const propEl = document.getElementById("exhaust-ai-trim-proposal");
  const applyBtn = document.getElementById("exhaust-ai-apply-btn");
  if (propEl) {
    if (q.action_needed) {
      const sign = q.suggested_trim > 0 ? "+" : "";
      propEl.textContent = `Tarage recommandé : ${sign}${q.suggested_trim}% (Actuel : ${q.current_trim}%)`;
      if (applyBtn) {
        applyBtn.classList.remove("hidden");
        applyBtn.textContent = `Appliquer (${sign}${q.suggested_trim}%)`;
      }
    } else if (q.status === "stabilizing") {
      propEl.textContent = `Stabilisation aéraulique en cours (${q.stable_minutes || 0}/30 min sans variation)`;
      if (applyBtn) {
        applyBtn.classList.add("hidden");
      }
    } else {
      propEl.textContent = q.status === "active" ? "Tarage optimal (aucun ajustement requis)" : "Tarage en attente de combustion active";
      if (applyBtn) {
        applyBtn.classList.add("hidden");
      }
    }
  }
}

function applyAiExhaustTrim() {
  if (!currentExhaustAiDiagnosis || !currentExhaustAiDiagnosis.action_needed) {
    showToast("Aucun ajustement de tarage extracteur requis actuellement.");
    return;
  }
  const targetVal = Number(currentExhaustAiDiagnosis.suggested_trim);
  const sign = targetVal > 0 ? "+" : "";
  const activeMode = latestData.comm_mode || (currentSettings && currentSettings.comm_mode) || "agua_cloud";
  const isAgua = (activeMode === "agua_cloud");
  const remoteNote = isAgua
    ? `\n\n⚠️ IMPORTANT (Mode Cloud Agua) :\nLes offsets 70 et 71 ne figurent pas dans la table Cloud Agua IOT. L'application enregistre cette valeur en mémoire locale, mais vous devez la valider sur votre radiocommande :\nMENU ▸ PROGRAMMATION UTILISATEUR ▸ MÉLANGE G/A.`
    : "";

  openActionModal({
    title: "✨ Tarage Extracteur Fumées Optimisé par IA",
    message: `Appliquer la recommandation IA sur la vitesse de l'extracteur de fumées ?\n\n• Nouveau tarage recommandé : ${sign}${targetVal} %\n• Tarage actuel : ${currentExhaustAiDiagnosis.current_trim} %\n\nMotif : ${currentExhaustAiDiagnosis.explanation}${remoteNote}`,
    confirmText: isAgua ? `Mémoriser (${sign}${targetVal}%)` : `Appliquer (${sign}${targetVal}%)`,
    onConfirm: async () => {
      await sendCommand("trim_exhaust_pct", targetVal);
      showToast(`Tarage extracteur fumées ${sign}${targetVal}% enregistré.${isAgua ? " Validez sur votre radiocommande (MÉLANGE G/A)." : ""}`);
      await refreshLatestOnly();
    }
  });
}

function promptResetPelletBatch() {
  openActionModal({
    title: "🔄 RAZ Changement de Marque de Granulés",
    message: "Avant de confirmer la remise à zéro :\n" +
      "1. Aspirez le fond de la trémie (35 kg), le brasero et derrière le coupe-flamme (poêle froid et débranché).\n" +
      "2. Sur la télécommande Nobis, remettez MENU ▸ MÉLANGE G/A sur PELLET = 00 et PRISE D'AIR = 00.\n\n" +
      "Indiquez le nom ou la certification du nouveau lot de granulés (ENplus A1 / DINplus) :",
    showInput: true,
    defaultValue: "Lot DINplus / ENplus A1 - " + new Date().toLocaleDateString("fr-FR"),
    confirmText: "Lancer RAZ (0% & 180 min)",
    onConfirm: async (brandName) => {
      try {
        showToast("Remise à zéro de l'évaluation Mélange P/A en cours...");
        await window.stoveProvider.pelletBatchRaz({ pellet_brand: brandName });
        await loadDashboard();
        showToast(`RAZ effectué pour « ${brandName} » : évaluation de 180 min démarrée !`);
      } catch (e) {
        showToast("Erreur RAZ : " + (e?.message || "Échec"), true);
      }
    }
  });
}
