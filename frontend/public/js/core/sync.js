// =============================================================================
// CORE SYNC — APPLICATION ÉTAT TABLEAU DE BORD, CHARGEMENT API & FLUX SSE
// =============================================================================

/** Drapeaux de rendu différé (lazy) pour les onglets masqués afin d'éviter le DOM thrashing. */
const _nobisTabDirty = {
  "tab-chrono": true,
  "tab-dashboard": true,
  "tab-installer": true,
};

/**
 * Indique si un onglet principal est actuellement visible à l'écran.
 * @param {string} tabId Identifiant DOM de la section onglet (ex: "tab-dashboard").
 * @returns {boolean} True si la section existe et n'est pas masquée.
 */
function isTabVisible(tabId) {
  const el = document.getElementById(tabId);
  return Boolean(el && !el.classList.contains("hidden") && el.style.display !== "none");
}

/**
 * Applique un snapshot télémétrique complet ou incrémental sur l'interface utilisateur.
 * Les onglets masqués (Chrono, Supervision, Paramètres/EEPROM) sont marqués sales et rendus à l'ouverture.
 * @param {Object} data Charge utile retournée par `/api/dashboard`, `/api/latest` ou SSE.
 * @param {boolean} [updateSeries=true] Si true, met à jour la série temporelle des graphiques.
 */
function applyDashboardState(data, updateSeries = true) {
  const prevWeatherDetails = latestData?.weather_details;
  latestData = data.latest || latestData || {};
  if (!latestData.weather_details && data.weather_data) {
    latestData.weather_details = data.weather_data;
  } else if (!latestData.weather_details && prevWeatherDetails) {
    latestData.weather_details = prevWeatherDetails;
  }
  if (data.comm_status) {
    connectionState.commStatus = data.comm_status;
  }
  if (data.consumption_stats) {
    if (data.consumption_stats.conso_week_kg !== undefined) {
      latestData.conso_week_kg = data.consumption_stats.conso_week_kg;
    }
    if (data.consumption_stats.conso_month_kg !== undefined) {
      latestData.conso_month_kg = data.consumption_stats.conso_month_kg;
    }
  }
  if (data.registers) {
    registersCatalog = data.registers;
  } else if (data.latest && registersCatalog) {
    const latestToRegMap = {
      fun_auto_set: "fun_auto_set",
      fun_pwf_set: "fun_pwf_set",
      temp_amb_setpoint: "temp_amb_setpoint",
      duct_left_setpoint: "duct_left_setpoint",
      duct_right_setpoint: "duct_right_setpoint",
      fan_front_speed: "fan_front_speed",
      duct_left_speed: "duct_left_speed",
      duct_right_speed: "duct_right_speed",
      power_level: "power_level",
      power_cmd: "power_level",
    };
    Object.entries(latestToRegMap).forEach(([srcKey, regKey]) => {
      if (data.latest[srcKey] !== undefined && data.latest[srcKey] !== null && registersCatalog[regKey]) {
        registersCatalog[regKey].current_val = data.latest[srcKey];
      }
    });
  }
  if (data.settings) {
    currentSettings = data.settings;
    if (data.settings.hopper_capacity_kg) {
      const cap = Number(data.settings.hopper_capacity_kg);
      if (cap >= 5 && cap <= 500) HOPPER_CAPACITY_KG = cap;
    }
  }
  if (data.capabilities) {
    window.currentCapabilities = data.capabilities;
  }
  if (window.stoveProvider?.isContainerActive?.()) {
    if (data.silence_mode) {
      silenceModeState = data.silence_mode;
    }
  } else {
    silenceModeState = { active: false, remaining_seconds: 0, end_epoch: 0, duration_hours: 2.0 };
  }
  if (data.pellet_quality) {
    latestData.pellet_quality = data.pellet_quality;
  }
  if (data.exhaust_quality) {
    latestData.exhaust_quality = data.exhaust_quality;
  }
  if (updateSeries && Array.isArray(data.series)) {
    cachedSeriesRows = typeof normalizeSeriesWithGaps === "function"
      ? normalizeSeriesWithGaps(data.series)
      : data.series;
  }

  const activeMode = data.active_mode || (currentSettings && currentSettings.comm_mode) || latestData.comm_mode || "agua_cloud";
  currentCommMode = activeMode;
  const activeDbFile = data.active_db_file || `stove_${activeMode}.db`;

  const dbEl = document.getElementById("hdr-db");
  if (dbEl) dbEl.textContent = activeDbFile;
  const rawBackendVer = window.stoveProvider?.isContainerActive?.()
    ? (data.backend_version || data.docker_version || data.version || (currentSettings && (currentSettings.backend_version || currentSettings.docker_version)) || null)
    : null;
  if (typeof syncVersionBadges === "function") {
    syncVersionBadges(rawBackendVer);
  }
  if (typeof applyModeVisibility === "function") applyModeVisibility();
  document.getElementById("hdr-state").textContent = latestData.status_label || "--";
  updateStatusIndicatorAndAlerts();

  let clockStr = latestData.stove_clock_str;
  if (!clockStr) {
    const wdayVal = Math.round(getRegVal("calendar_day_week_set", 1));
    const daysFr = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
    const wdayStr = (wdayVal >= 1 && wdayVal <= 7) ? daysFr[wdayVal - 1] : "---";
    const hh = String(Math.round(getRegVal("clock_hour_set", 17))).padStart(2, "0");
    const mm = String(Math.round(getRegVal("clock_minute_set", 42))).padStart(2, "0");
    const dd = String(Math.round(getRegVal("calendar_day_set", 1))).padStart(2, "0");
    const mo = String(Math.round(getRegVal("calendar_month_set", 11))).padStart(2, "0");
    const yy = Math.round(getRegVal("calendar_year_set", 26)) + 2000;
    clockStr = `${wdayStr} ${hh}:${mm} ${dd}/${mo}/${yy}`;
  }
  const instClockEl = document.getElementById("inst-clock-val");
  if (instClockEl) instClockEl.textContent = clockStr;

  const pwfVal = Number(latestData.fun_pwf_set ?? getRegVal("fun_pwf_set", 0));
  const autoVal = Number(getRegVal("fun_auto_set", latestData.fun_auto_set ?? 0));
  const stCode = Number(latestData.status_code ?? 0);
  const climVal = (stCode === 8 || stCode === 9 || Number(latestData.standby_enabled ?? 0) === 1) ? 1 : 0;
  // Registre EEPROM #33250 inactif sur Nobis A10 (#107 bit 2048 = 0) : état lu depuis le mode Silence applicatif
  const silVal = (silenceModeState && silenceModeState.active) ? 1 : 0;
  const chrVal = Number(getRegVal("chrono_week_enable_set", latestData.chrono_week_enable ?? 0));
  const pwrSetVal = Number(getRegVal("power_level", 4));
  const fanSetVal = Number(getRegVal("fan_front_speed", 3));
  const dlSpdVal = Number(getRegVal("duct_left_speed", 0));
  const drSpdVal = Number(getRegVal("duct_right_speed", 0));
  if (typeof rememberManualFanSpeed === "function") {
    rememberManualFanSpeed("fan_front_speed", fanSetVal);
    rememberManualFanSpeed("duct_left_speed", dlSpdVal);
    rememberManualFanSpeed("duct_right_speed", drSpdVal);
  }

  // Carte 1 : Ambiance Salon
  const ambSp = Number(getRegVal("temp_amb_setpoint", 19));
  document.getElementById("kpi-amb").textContent = latestData.temp_ambient != null ? formatMeasuredTemp(latestData.temp_ambient) : "--";
  document.getElementById("kpi-amb-sp").textContent = formatTempSetpoint(ambSp);

  const deltaBadge = document.getElementById("kpi-amb-delta");
  if (deltaBadge) {
    deltaBadge.className = "hidden";
  }

  // Cartes 3 à 7
  document.getElementById("kpi-dl-t").textContent = latestData.duct_left_temp != null ? formatMeasuredTemp(latestData.duct_left_temp) : "--";
  document.getElementById("kpi-dl-sp").textContent = formatTempSetpoint(getRegVal("duct_left_setpoint", 20));
  document.getElementById("kpi-dl-v").textContent = formatFanSpeed(dlSpdVal);
  document.getElementById("kpi-dl-act").textContent = formatRealFan(latestData.duct_left_actual ?? 0);

  document.getElementById("kpi-dr-t").textContent = latestData.duct_right_temp != null ? formatMeasuredTemp(latestData.duct_right_temp) : "--";
  document.getElementById("kpi-dr-sp").textContent = formatTempSetpoint(getRegVal("duct_right_setpoint", 20));
  document.getElementById("kpi-dr-v").textContent = formatFanSpeed(drSpdVal);
  document.getElementById("kpi-dr-act").textContent = formatRealFan(latestData.duct_right_actual ?? 0);

  document.getElementById("kpi-w-t").textContent = latestData.weather_temp_ext ?? "--";
  document.getElementById("kpi-w-h").textContent = latestData.weather_humidity ?? "--";
  document.getElementById("kpi-w-w").textContent = latestData.weather_wind_kmh ?? "--";
  if (typeof renderWeatherModalData === "function") {
    renderWeatherModalData();
  }

  document.getElementById("kpi-pwr").textContent = formatRealPower(latestData.power_actual ?? pwrSetVal);
  document.getElementById("kpi-fan").textContent = formatFanSpeed(fanSetVal);
  document.getElementById("kpi-auto").textContent = autoVal ? "ON" : "OFF";
  const kpiClimEl = document.getElementById("kpi-clim");
  if (kpiClimEl) kpiClimEl.textContent = climVal ? "ON" : "OFF";
  document.getElementById("kpi-pwf").textContent = pwfVal === 2 ? "CRONO" : (pwfVal === 1 ? "ON" : "OFF");
  document.getElementById("kpi-sil").textContent = silVal ? "ON" : "OFF";

  // Carte 4 : Pellets - Jauge visuelle, Consommations (Jour, Semaine 7j, Mois 30j) & Stock
  const rawHopPct = latestData.pellet_hopper_pct;
  const parsedHopPct = (rawHopPct === null || rawHopPct === undefined || rawHopPct === "") ? NaN : Number(rawHopPct);
  const isHopUnknown = !Number.isFinite(parsedHopPct) || parsedHopPct < 0;
  const hopPct = isHopUnknown ? 0 : parsedHopPct;
  const rateKgh = Number(latestData.pellet_rate_kgh ?? 0);
  const dailyKg = Number(latestData.pellet_daily_kg ?? 0);
  const weeklyKg = Math.max(dailyKg, Number(latestData.conso_week_kg ?? (latestData.consumption_stats?.conso_week_kg ?? 0)));
  const monthlyKg = Math.max(weeklyKg, Number(latestData.conso_month_kg ?? (latestData.consumption_stats?.conso_month_kg ?? 0)));

  const bagPriceEur = Number((currentSettings && currentSettings.pellet_bag_price_eur) || 5.80);
  const bagsStock = Number((currentSettings && currentSettings.pellet_bags_stock) ?? 40);
  const kgPriceEur = bagPriceEur / BAG_WEIGHT_KG;
  const dailyCostEur = (dailyKg * kgPriceEur).toFixed(2);
  const weeklyCostEur = (weeklyKg * kgPriceEur).toFixed(2);
  const monthlyCostEur = (monthlyKg * kgPriceEur).toFixed(2);

  const kpiHopEl = document.getElementById("kpi-hop");
  const kpiHopUnitEl = document.getElementById("kpi-hop-unit");
  const refillBannerEl = document.getElementById("pellet-refill-confirm-banner");
  if (kpiHopEl) {
    kpiHopEl.textContent = isHopUnknown ? "?" : Math.round(hopPct);
    kpiHopEl.className = isHopUnknown ? "text-amber-400 animate-pulse" : "";
  }
  if (kpiHopUnitEl) kpiHopUnitEl.classList.toggle("hidden", isHopUnknown);
  if (refillBannerEl) refillBannerEl.classList.toggle("hidden", !isHopUnknown);

  document.getElementById("kpi-kgh").textContent = rateKgh;
  document.getElementById("kpi-daily-kg").textContent = dailyKg.toFixed(1);
  const costEl = document.getElementById("kpi-daily-cost");
  if (costEl) costEl.textContent = `${dailyCostEur}€`;

  const weeklyKgEl = document.getElementById("kpi-weekly-kg");
  if (weeklyKgEl) weeklyKgEl.textContent = weeklyKg.toFixed(1);
  const weeklyCostEl = document.getElementById("kpi-weekly-cost");
  if (weeklyCostEl) weeklyCostEl.textContent = `${weeklyCostEur}€`;

  const monthlyKgEl = document.getElementById("kpi-monthly-kg");
  if (monthlyKgEl) monthlyKgEl.textContent = monthlyKg.toFixed(1);
  const monthlyCostEl = document.getElementById("kpi-monthly-cost");
  if (monthlyCostEl) monthlyCostEl.textContent = `${monthlyCostEur}€`;

  const stockEl = document.getElementById("kpi-bags-stock");
  if (stockEl) stockEl.textContent = `${bagsStock} sacs`;
  const chrEl = document.getElementById("kpi-chr");
  if (chrEl) chrEl.textContent = chrVal ? "ON" : "OFF";

  const hopBar = document.getElementById("kpi-hop-bar");
  hopBar.style.width = isHopUnknown ? "0%" : `${Math.max(0, Math.min(100, hopPct))}%`;
  hopBar.className = "h-full transition-all duration-500 " + (isHopUnknown ? "bg-amber-500" : (hopPct <= 15 ? "bg-rose-500" : (hopPct <= 35 ? "bg-amber-500" : "bg-[#96562c]")));

  const kgRemaining = (hopPct / 100.0) * HOPPER_CAPACITY_KG;
  const effectiveRate = rateKgh > 0.1 ? rateKgh : 0.95;
  const hoursLeft = Math.round(kgRemaining / effectiveRate);
  document.getElementById("kpi-hop-autonomy").textContent = isHopUnknown
    ? "En attente de confirmation"
    : `~${hoursLeft}h (${kgRemaining.toFixed(1)}kg)`;

  // Mise à jour de l'autonomie dans la bulle Météo/Pellets du Header principal
  const hdrHopperEl = document.getElementById("hdr-pellet-hopper");
  if (hdrHopperEl) {
    const baseHopCls = "font-bold text-xs sm:text-sm tabular-nums";
    if (isHopUnknown) {
      hdrHopperEl.textContent = "?";
      hdrHopperEl.className = `${baseHopCls} text-amber-400 animate-pulse`;
    } else if (parsedHopPct > 50) {
      hdrHopperEl.textContent = `${Math.round(parsedHopPct)}%`;
      hdrHopperEl.className = `${baseHopCls} text-emerald-400`;
    } else if (parsedHopPct >= 25) {
      hdrHopperEl.textContent = `${Math.round(parsedHopPct)}%`;
      hdrHopperEl.className = `${baseHopCls} text-amber-400`;
    } else {
      hdrHopperEl.textContent = `${Math.round(parsedHopPct)}%`;
      hdrHopperEl.className = `${baseHopCls} text-rose-400`;
    }
  }

  if (isHopUnknown) {
    if (typeof maybePromptHopperRefillConfirm === "function") {
      maybePromptHopperRefillConfirm();
    }
  } else if (typeof resetHopperRefillPromptFlag === "function") {
    resetHopperRefillPromptFlag();
  }

  // Prédiction Runway Stock (DJU & Météo)
  const runwayDays = Number(latestData.runway_days_est ?? 15.0);
  const runwayDaysEl = document.getElementById("kpi-pellet-runway-days");
  const runwayDateEl = document.getElementById("kpi-pellet-runway-date");
  if (runwayDaysEl && runwayDateEl) {
    runwayDaysEl.textContent = `~${runwayDays.toFixed(0)} jours`;
    if (runwayDays <= 5) {
      runwayDaysEl.className = "text-xs font-bold text-rose-400 tabular-nums animate-pulse";
    } else if (runwayDays <= 12) {
      runwayDaysEl.className = "text-xs font-bold text-amber-400 tabular-nums";
    } else {
      runwayDaysEl.className = "text-xs font-semibold text-emerald-400 tabular-nums";
    }
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + Math.round(runwayDays));
    const dayNames = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];
    const monthNames = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
    runwayDateEl.textContent = `${dayNames[targetDate.getDay()]} ${targetDate.getDate()} ${monthNames[targetDate.getMonth()]}`;
  }

  // Diagnostics Optimisation Tarages IA (Granulés & Fumées)
  renderPelletQuality(latestData);
  renderExhaustQuality(latestData);

  // Onglet Pilotage Direct
  document.getElementById("ctl-amb-val").textContent = formatTempSetpoint(ambSp);
  document.getElementById("ctl-amb-slider").value = ambSp;
  const pActualVal = latestData.power_actual ?? pwrSetVal;
  document.getElementById("ctl-real-pwr").textContent = formatRealPower(pActualVal);
  const fanEl = document.getElementById("ctl-real-fan");
  if (fanEl) fanEl.textContent = formatRealFan(latestData.vent_front_actual ?? 0);

  const pwrModeDescEl = document.getElementById("ctl-power-mode-desc");
  if (pwrModeDescEl) {
    const stCode = Number(latestData.status_code ?? 0);
    const pActualNum = Number(pActualVal);
    const sbEnabled = (stCode === 8 || stCode === 9 || Number(latestData.standby_enabled ?? 0) === 1);

    if (stCode === 5) {
      if (pActualNum === 0) {
        pwrModeDescEl.className = "text-sky-300 text-[10px] font-medium";
        pwrModeDescEl.textContent = sbEnabled ? "⏳ Stand-by" : "🌱 Modulation P0";
      } else if (pActualNum === 8) {
        pwrModeDescEl.className = "text-rose-400 text-[10px] font-medium";
        pwrModeDescEl.textContent = "⚡ BOOST";
      } else {
        pwrModeDescEl.textContent = "";
      }
    } else {
      pwrModeDescEl.textContent = "";
    }
  }

  document.getElementById("ctl-dl-meas").textContent = latestData.duct_left_temp != null ? formatMeasuredTemp(latestData.duct_left_temp) : "--";
  document.getElementById("ctl-dl-sp").textContent = formatTempSetpoint(getRegVal("duct_left_setpoint", 20));
  document.getElementById("ctl-dl-slider").value = getRegVal("duct_left_setpoint", 20);

  document.getElementById("ctl-dr-meas").textContent = latestData.duct_right_temp != null ? formatMeasuredTemp(latestData.duct_right_temp) : "--";
  document.getElementById("ctl-dr-sp").textContent = formatTempSetpoint(getRegVal("duct_right_setpoint", 20));
  document.getElementById("ctl-dr-slider").value = getRegVal("duct_right_setpoint", 20);

  if (typeof renderTriArcCockpit === "function") {
    renderTriArcCockpit();
  }

  const chrBtn = document.getElementById("ctl-chrono-enable-btn");
  if (chrBtn) {
    chrBtn.textContent = chrVal ? "ON" : "OFF";
    chrBtn.title = `Chrono Général : ${chrVal ? "Actif (ON)" : "Inactif (OFF)"} (offset 33162) - Cliquer pour basculer`;
    chrBtn.className = `min-h-[36px] min-w-[72px] px-4 py-1.5 rounded-lg font-bold text-xs transition-all cursor-pointer text-center shadow-sm ${chrVal
      ? "bg-emerald-600 hover:bg-emerald-500 text-white border border-emerald-500 shadow-emerald-950/40"
      : "bg-gray-800 hover:bg-gray-700 text-gray-400 border border-gray-700"
      }`;
  }

  const pwfStat = document.getElementById("ctl-pwf-status-label");
  if (pwfStat) {
    const pwfLabels = { 0: "0", 1: "1", 2: "2" };
    pwfStat.textContent = "Actuel : " + (pwfLabels[pwfVal] || "0");
  }

  // Badges de sécurité complets Volet 4 (Foyer, Sécurités, Thermostats & Trémie)
  if (typeof renderSecurityBadges === "function") {
    renderSecurityBadges(latestData, false);
  }

  // Badges sondes spécifiques Trémie / Pellets (déplacés dans la carte Pellets)
  const pelletSecBox = document.getElementById("pellet-security-badges");
  if (pelletSecBox) {
    const itemsPelletSec = [
      { label: "Trappe pellet", fault: latestData.popup_pellet_open, okTxt: "Fermée", errTxt: "OUVERTE !" },
      { label: "Trémie", fault: latestData.popup_pellet_empty, okTxt: "Niveau OK", errTxt: "VIDE !" }
    ];
    pelletSecBox.innerHTML = itemsPelletSec.map(i => `
      <div class="px-2 py-1 rounded border flex justify-between items-center min-w-0 gap-1 ${i.fault ? 'bg-rose-950/60 border-rose-600 text-rose-300 font-bold' : 'bg-gray-950/90 border-[#6e3b1f]/60 text-gray-300'}">
        <span class="truncate">${i.label} :</span>
        <span class="shrink-0 ${i.fault ? 'text-rose-400 font-bold' : 'text-[#d4976a] font-semibold'}">${i.fault ? i.errTxt : i.okTxt}</span>
      </div>
    `).join("");
  }

  if (isTabVisible("tab-chrono")) {
    renderChronoPrograms();
    _nobisTabDirty["tab-chrono"] = false;
  } else {
    _nobisTabDirty["tab-chrono"] = true;
  }

  // Onglet Paramètres (Menu Installateur) : rendu différé si masqué
  const trimPelletInp = document.getElementById("inst-trim-pellet");
  if (trimPelletInp && document.activeElement !== trimPelletInp) {
    trimPelletInp.value = getRegVal("trim_pellet_pct", 0);
  }
  const trimExhaustInp = document.getElementById("inst-trim-exhaust");
  if (trimExhaustInp && document.activeElement !== trimExhaustInp) {
    trimExhaustInp.value = getRegVal("trim_exhaust_pct", 0);
  }

  if (isTabVisible("tab-installer")) {
    renderHardwareMasks();
    renderRawBufferInspector();
    renderEepromTable();
    _nobisTabDirty["tab-installer"] = false;
  } else {
    _nobisTabDirty["tab-installer"] = true;
  }

  // Synchronisation des réglages système (ne pas écraser si l'utilisateur est en train d'éditer ou a modifié le formulaire)
  const isEditingSettings = document.activeElement && document.activeElement.id && document.activeElement.id.startsWith("cfg-");
  if (currentSettings && !isEditingSettings && !isSettingsFormDirty) {
    const modeEl = document.getElementById("cfg-mode");
    if (modeEl) modeEl.value = currentSettings.comm_mode || "agua_cloud";
    const intEl = document.getElementById("cfg-interval");
    if (intEl) intEl.value = currentSettings.poll_interval_s || "120";
    const cityEl = document.getElementById("cfg-city");
    if (cityEl) cityEl.value = currentSettings.weather_city || "";
    const latEl = document.getElementById("cfg-lat");
    if (latEl) latEl.value = currentSettings.weather_lat || "";
    const lonEl = document.getElementById("cfg-lon");
    if (lonEl) lonEl.value = currentSettings.weather_lon || "";
    const emailEl = document.getElementById("cfg-email");
    if (emailEl) emailEl.value = currentSettings.agua_email || "";
    const gwEl = document.getElementById("cfg-gw");
    if (gwEl) gwEl.value = currentSettings.local_gateway_url || "";
    const bagPriceInp = document.getElementById("cfg-bag-price");
    if (bagPriceInp) bagPriceInp.value = currentSettings.pellet_bag_price_eur || "5.80";
    const bagsStockInp = document.getElementById("cfg-bags-stock");
    if (bagsStockInp) bagsStockInp.value = currentSettings.pellet_bags_stock ?? "40";
    const webhookInp = document.getElementById("cfg-webhook");
    if (webhookInp) webhookInp.value = currentSettings.webhook_url || "";
    const matterEnInp = document.getElementById("cfg-matter-enabled");
    if (matterEnInp) matterEnInp.value = currentSettings.matter_enabled ?? "1";
    const matterNameInp = document.getElementById("cfg-matter-name");
    if (matterNameInp) matterNameInp.value = currentSettings.matter_device_name || "Stove Cockpit";
    const matterPortInp = document.getElementById("cfg-matter-port");
    if (matterPortInp) matterPortInp.value = currentSettings.matter_port || "5540";
    const ductLeftInp = document.getElementById("cfg-duct-left-name");
    if (ductLeftInp) ductLeftInp.value = currentSettings.duct_left_name || "SX";
    const ductRightInp = document.getElementById("cfg-duct-right-name");
    if (ductRightInp) ductRightInp.value = currentSettings.duct_right_name || "DX";
    const uiModeInp = document.getElementById("cfg-cockpit-ui-mode");
    const effectiveUiMode = (typeof getActiveCockpitUiMode === "function") ? getActiveCockpitUiMode() : (currentSettings.cockpit_ui_mode || "triarc");
    if (uiModeInp) uiModeInp.value = effectiveUiMode;
    if (typeof syncCockpitUiControlClasses === "function") syncCockpitUiControlClasses(effectiveUiMode);
    if (typeof renderCockpitUiSettingsGrid === "function") renderCockpitUiSettingsGrid();
    if (typeof populatePlusAndBrandSettings === "function") {
      populatePlusAndBrandSettings(currentSettings);
    }
    updateConfigModalFields();
  }

  applyDuctNamesAcrossUI();
  updateSettingsAccordionSummaries();

  if (isTabVisible("tab-dashboard")) {
    renderSeriesToggles();
    if (updateSeries) {
      updateChartDatasets();
    }
    _nobisTabDirty["tab-dashboard"] = false;
  } else if (updateSeries || _nobisTabDirty["tab-dashboard"]) {
    _nobisTabDirty["tab-dashboard"] = true;
  }
}

/**
 * Charge l'état complet du tableau de bord et la série temporelle correspondant à `currentRange`.
 * @returns {Promise<void>}
 */
async function loadDashboard() {
  if (!window.stoveProvider) return;
  let data;
  try {
    data = await window.stoveProvider.loadDashboard(currentRange);
    connectionState.isServerConnected = true;
  } catch (e) {
    connectionState.isServerConnected = false;
    updateConnectionIndicator("disconnected", e?.message || "Réseau KO");
    return;
  }

  try {
    applyDashboardState(data, true);
  } catch (e) {
    console.error("[Dashboard] Erreur application état UI:", e);
  }
}

async function refreshLatestOnly() {
  if (!window.stoveProvider) return;
  let data;
  try {
    data = await window.stoveProvider.getLatest();
    connectionState.isServerConnected = true;
  } catch (e) {
    connectionState.isServerConnected = false;
    updateConnectionIndicator("disconnected", e?.message || "Réseau KO");
    return;
  }

  try {
    // Si un nouveau point temporel est arrivé, on l'ajoute en fin de courbe et on recalcule les espaces de perte de connexion
    if (data.latest && data.latest.timestamp) {
      const rawOnly = cachedSeriesRows.filter(r => !r._gapDurationMin);
      const lastCached = rawOnly[rawOnly.length - 1];
      if (!lastCached || lastCached.timestamp !== data.latest.timestamp) {
        rawOnly.push(data.latest);
        if (rawOnly.length > 600) rawOnly.shift();
        data.series = rawOnly;
        applyDashboardState(data, true);
        return;
      }
    }
    applyDashboardState(data, false);
  } catch (e) {
    console.error("[Dashboard] Erreur mise à jour télémétrie:", e);
  }
}

// Connexion live (SSE en Mode + Conteneur, polling adaptatif en Mode Autonome / Démo)
function applyLiveTelemetryPayload(data) {
  if (!data) return;
  if (data.latest && data.latest.timestamp) {
    const rawOnly = cachedSeriesRows.filter(r => !r._gapDurationMin);
    const lastCached = rawOnly[rawOnly.length - 1];
    if (!lastCached || lastCached.timestamp !== data.latest.timestamp) {
      rawOnly.push(data.latest);
      if (rawOnly.length > 600) rawOnly.shift();
      data.series = rawOnly;
      applyDashboardState(data, true);
      return;
    }
  }
  applyDashboardState(data, false);
}

function initSSEStream() {
  if (!window.stoveProvider) return;
  window.stoveProvider.startLiveUpdates((msg) => {
    connectionState.isServerConnected = true;
    connectionState.isSSEConnected = window.stoveProvider.isContainerActive();
    connectionState.lastMessageAt = Date.now();
    if (msg.comm_status) {
      connectionState.commStatus = msg.comm_status;
    }
    updateConnectionIndicator();
    if (msg.latest) {
      applyLiveTelemetryPayload(msg);
    } else if (msg.event === "telemetry" || msg.type === "telemetry_update" || msg.type === "register_update") {
      refreshLatestOnly();
    }
  });
}

function setRange(r) {
  currentRange = r;
  document.querySelectorAll("#timeline-btns button").forEach(b => {
    const active = b.getAttribute("data-range") === r;
    b.className = active
      ? "px-2.5 sm:px-3 py-1 text-xs rounded bg-orange-600 text-white font-semibold"
      : "px-2.5 sm:px-3 py-1 text-xs rounded text-gray-300";
  });
  loadDashboard();
}

function exportCSV() {
  if (!window.stoveProvider?.isContainerActive?.()) {
    showToast("L'export CSV historique nécessite le Mode « + » (Conteneur).", true);
    return;
  }
  window.location.href = window.stoveProvider.getContainerDownloadUrl(`/api/export-csv?range_key=${currentRange}`);
}

function exportLogsCSV() {
  if (!window.stoveProvider?.isContainerActive?.()) {
    showToast("L'export CSV des logs nécessite le Mode « + » (Conteneur).", true);
    return;
  }
  window.location.href = window.stoveProvider.getContainerDownloadUrl(`/api/export-logs-csv?severity=${currentLogSeverity}`);
}

async function pollNow() {
  if (!window.stoveProvider) return;
  const btn = document.getElementById("btn-poll-now");
  if (btn) btn.textContent = "⏳ Lecture...";
  updateCloudConnectionIndicator("connecting", "Sync Cloud...");
  try {
    const data = await window.stoveProvider.pollNow();
    if (data?.comm_status) {
      connectionState.commStatus = data.comm_status;
    }
    await refreshLatestOnly();
    showToast("☁️ Données du poêle actualisées en direct !");
  } catch (e) {
    updateCloudConnectionIndicator("disconnected", e?.message || "Échec Cloud");
    showToast("⚠️ Échec d'interrogation : " + (e?.message || "Connexion indisponible"), true);
  } finally {
    if (btn) btn.textContent = "⟳ Actualiser";
    updateCloudConnectionIndicator();
  }
}
