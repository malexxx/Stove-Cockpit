// =============================================================================
// FEATURE GRANULÉS & IA — TRÉMIE 35 KG, QUALITÉ COMBUSTIBLE & TARAGES MÉLANGE P/A
// =============================================================================

function refillHopper(bagsAdded = 2) {
  const isOneBag = Number(bagsAdded) === 1;
  openActionModal({
    title: isOneBag ? "🌾 Ajout +1 Sac (15 kg / +43%)" : "🌾 Trémie Pleine 100% (35 kg / ~2.3 sacs)",
    message: isOneBag
      ? "Ajouter 1 sac de 15 kg (+42.9% dans la trémie de 35 kg) et décrémenter le stock de granulés de 1 sac ?"
      : "Remplir la trémie à 100 % (capacité certifiée 35 kg) et mettre à jour le stock de sacs de 15 kg ?",
    confirmText: isOneBag ? "+1 Sac (15 kg)" : "Trémie Pleine (35 kg)",
    onConfirm: async () => {
      const addedPct = (15.0 / HOPPER_CAPACITY_KG) * 100.0;
      const targetPct = isOneBag
        ? Math.min(100.0, Number(latestData.pellet_hopper_pct ?? 50) + addedPct)
        : 100.0;
      const payload = isOneBag
        ? { target_pct: targetPct, level_pct: targetPct, bags_added: 1 }
        : { target_pct: 100.0, level_pct: 100.0, bags_added: 2.33 };
      try {
        const j = await window.stoveProvider.refillHopper(payload);
        await refreshLatestOnly();
        const capKg = j.hopper_capacity_kg ?? HOPPER_CAPACITY_KG;
        const stockBags = j.pellet_bags_stock ?? j.bags_stock ?? "--";
        showToast(`Trémie à ${j.pellet_hopper_pct}% (${capKg} kg max) — Stock restant : ${stockBags} sacs`);
      } catch (e) {
        showToast("Erreur recharge trémie : " + (e?.message || "Échec"), true);
      }
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
