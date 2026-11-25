// =============================================================================
// FEATURE TRI-ARC V10 — RENDU SVG JAUGES, EN-TÊTE, FRISE CHRONO & BULLE FLOTTANTE
// =============================================================================

function nobisStovePaths() {
  return `
    <path fill-rule="evenodd" d="M 43 4 H 57 Q 59 4 59 6 V 19 Q 64 19 66 22 L 67.5 27 Q 69 31 73 31 Q 81 31 84 35 Q 86 39 86 48 V 104 V 112 Q 86 114 83 114 H 74 Q 71.5 114 70 111 L 66 105 H 34 L 30 111 Q 28.5 114 26 114 H 17 Q 14 114 14 112 V 104 V 48 Q 14 39 16 35 Q 19 31 27 31 Q 31 31 32.5 27 L 34 22 Q 36 19 41 19 V 6 Q 41 4 43 4 Z M 29 42 H 71 Q 73 42 73 44 V 78 Q 73 80 71 80 H 29 Q 27 80 27 78 V 44 Q 27 42 29 42 Z M 25 88 H 75 Q 77 88 77 90.5 Q 77 93 75 93 H 25 Q 23 93 23 90.5 Q 23 88 25 88 Z M 33 80 C 32 72 34 65 37 60 C 40 66 43 68 45 67 C 46 58 48 45 52 44 C 55 52 56 61 58 63 C 60 59 63 54 65 56 C 68 62 69 71 67 80 Z" />
  `;
}

function svgNobisStoveIcon(cls = "w-5 h-5 inline-block", color = "currentColor") {
  return `<svg viewBox="10 0 80 120" class="${cls}" fill="${color}">${nobisStovePaths()}</svg>`;
}

function formatPhaseTwoLines(phaseLabel, meta) {
  if (!phaseLabel) return { line1: "ÉTAT", line2: "Inconnu" };
  const raw = String(phaseLabel).trim();
  const parenMatch = raw.match(/^([^(]+)\s*\(([^)]+)\)$/);
  if (parenMatch) {
    return {
      line1: parenMatch[1].trim(),
      line2: parenMatch[2].trim()
    };
  }
  const parts = raw.split(/\s+/);
  if (parts.length >= 2) {
    return {
      line1: parts[0],
      line2: parts.slice(1).join(" ")
    };
  }
  return {
    line1: raw,
    line2: meta ? (meta.short || "") : ""
  };
}

function svgPropellerFanIcon(cls = "w-4 h-4 inline-block", color = "currentColor") {
  return `<svg viewBox="0 0 24 24" class="${cls}" fill="${color}">
    <circle cx="12" cy="12" r="2.3"/>
    <path d="M12 9.2c-1.6-2.5-1.2-6.2 1.8-6.7 2.4-.4 4.1 1.8 3.1 4.3-.7 1.7-2.4 2.3-4.9 2.4z"/>
    <path d="M14.4 13.4c2.9.2 5.9 2.4 4.9 5.2-.9 2.3-3.6 2.7-5.3.6-1.1-1.4-.8-3.2.4-5.8z"/>
    <path d="M9.6 13.4c-1.3 2.6-2.6 4.5-4.7 3.8-2.3-.7-2.6-3.5-.6-5.2 1.5-1.3 3.4-1 5.3 1.4z"/>
  </svg>`;
}

function _getTriArcCaps() {
  return typeof getActiveCapabilities === "function" ? getActiveCapabilities() : {
    stove_type: "air", temp_min: 7, temp_max: 41, power_min: 1, power_max: 7,
    has_fan_front: true, fan_min: 0, fan_max: 8,
    ducts: [{ id: "SX" }, { id: "DX" }],
    has_auto: true, has_boost: true, has_eco: true,
  };
}

function fmtTriArcTempSp(val) {
  const caps = _getTriArcCaps();
  const v = Math.round(Number(val));
  if (caps.stove_type !== "hydro") {
    if (v <= (caps.temp_min ?? 7)) return "❄️";
    if (v >= (caps.temp_max ?? 41)) return "MAX";
  }
  return `${v}°`;
}

function fmtTriArcFan(val) {
  const caps = _getTriArcCaps();
  const fanMax = Number(caps.fan_max ?? 8);
  const v = Math.round(Number(val));
  if (v <= 0) return "OFF";
  if (fanMax >= 8 && v >= 8) return "AUTO";
  return String(v);
}

// Échelle non-linéaire dilatée autour de 19° (pour 7..41°C) ou linéaire sur [temp_min..temp_max]
function triArcTempToAngle(t) {
  const caps = _getTriArcCaps();
  const tMin = Number(caps.temp_min ?? 7);
  const tMax = Number(caps.temp_max ?? 41);
  const num = Number(t);
  const mid = Math.round((tMin + tMax) / 2);
  const val = isNaN(num) ? (tMin === 7 ? 19 : mid) : num;
  const v = Math.max(tMin, Math.min(tMax, val));
  if (tMin !== 7 || tMax !== 41) {
    return 135 + ((v - tMin) / Math.max(1, tMax - tMin)) * 270;
  }
  if (v <= 17) {
    return 135 + ((v - 7) / 10) * 75; // 7°->135°, 17°->210°
  } else if (v <= 19) {
    return 210 + ((v - 17) / 2) * 60; // 17°->210°, 19°->270° (apogée)
  } else if (v <= 23) {
    return 270 + ((v - 19) / 4) * 70; // 19°->270°, 23°->340°
  } else {
    return 340 + ((v - 23) / 18) * 65; // 23°->340°, 41°->405°
  }
}

function triArcAngleToTemp(angleDeg) {
  const caps = _getTriArcCaps();
  const tMin = Number(caps.temp_min ?? 7);
  const tMax = Number(caps.temp_max ?? 41);
  const a = Math.max(135, Math.min(405, Number(angleDeg)));
  if (tMin !== 7 || tMax !== 41) {
    return Math.round(tMin + ((a - 135) / 270) * (tMax - tMin));
  }
  if (a <= 210) {
    return Math.round(7 + ((a - 135) / 75) * 10);
  } else if (a <= 270) {
    return Math.round(17 + ((a - 210) / 60) * 2);
  } else if (a <= 340) {
    return Math.round(19 + ((a - 270) / 70) * 4);
  } else {
    const raw = 23 + ((a - 340) / 65) * 18;
    return raw >= 40.5 ? 41 : Math.round(raw);
  }
}

function triArcPtOnCircle(cx, cy, r, deg) {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function triArcPath(cx, cy, r, startDeg, endDeg, ccw = false) {
  if (Math.abs(endDeg - startDeg) < 0.3) return "";
  const s = triArcPtOnCircle(cx, cy, r, startDeg);
  const e = triArcPtOnCircle(cx, cy, r, endDeg);
  const diff = ccw ? (startDeg - endDeg) : (endDeg - startDeg);
  const largeArc = Math.abs(diff) > 180 ? 1 : 0;
  const sweep = ccw ? 0 : 1;
  return `M ${s.x.toFixed(1)} ${s.y.toFixed(1)} A ${r} ${r} 0 ${largeArc} ${sweep} ${e.x.toFixed(1)} ${e.y.toFixed(1)}`;
}

function getTriArcTelemetryState() {
  const st = Number(latestData.status_code ?? 0);
  const alarm = Number(latestData.alarm_code ?? 0);
  const blackout = Number(latestData.blackout_popup ?? 0);
  const isAlarm = (st === 10 || st === 11 || alarm > 0 || blackout > 0);
  const meta = typeof getPhaseMeta === "function" ? getPhaseMeta(isAlarm ? (st === 11 ? 11 : 10) : st) : null;
  const phaseLabelRaw = latestData.status_label || (meta ? meta.label : (st === 0 ? "Éteint" : `Phase #${st}`));
  const phaseIcon = meta ? meta.icon : (st === 0 ? "⚫" : "🔥");
  const phaseColor = meta ? meta.hex : (st === 5 ? "#ea580c" : "#94a3b8");

  const realAmb = formatMeasuredTemp(latestData.temp_ambient, 20);
  const realSx = formatMeasuredTemp(latestData.duct_left_temp, 19);
  const realDx = formatMeasuredTemp(latestData.duct_right_temp, 19);

  let spAmb = getTriArcLiveOrOpt("temp_amb_setpoint", getRegVal("temp_amb_setpoint", 20));
  let spSx = getTriArcLiveOrOpt("duct_left_setpoint", getRegVal("duct_left_setpoint", 20));
  let spDx = getTriArcLiveOrOpt("duct_right_setpoint", getRegVal("duct_right_setpoint", 20));

  let fanAmb = getTriArcLiveOrOpt("fan_front_speed", getRegVal("fan_front_speed", 3));
  let fanSx = getTriArcLiveOrOpt("duct_left_speed", getRegVal("duct_left_speed", 0));
  let fanDx = getTriArcLiveOrOpt("duct_right_speed", getRegVal("duct_right_speed", 0));

  const realFanAmb = getActualFanButtonVal(latestData.vent_front_actual, fanAmb);
  const realFanSx = getActualFanButtonVal(latestData.duct_left_actual, fanSx);
  const realFanDx = getActualFanButtonVal(latestData.duct_right_actual, fanDx);

  const rawLivePwf = (latestData.fun_pwf_set !== undefined && latestData.fun_pwf_set !== null)
    ? latestData.fun_pwf_set
    : getRegVal("fun_pwf_set", 0);
  const pwfVal = Math.max(0, Math.round(Number(getTriArcLiveOrOpt("fun_pwf_set", rawLivePwf))));
  const pwrSetVal = getTriArcLiveOrOpt("power_level", getRegVal("power_level", 4));
  // L'activation du mode Boost (POWERFUL) ne passe pas la consigne de puissance à 8 (celle-ci reste celle choisie par l'utilisateur)
  let pwrSp = pwrSetVal;
  const realPwr = Number(latestData.power_actual ?? pwrSp);

  // Surcharge en direct pendant le glisser tactile
  if (triArcDragging) {
    if (triArcDragging.arcType === "temp") {
      if (triArcDragging.zone === "AMB") spAmb = triArcDragging.value;
      else if (triArcDragging.zone === "SX") spSx = triArcDragging.value;
      else if (triArcDragging.zone === "DX") spDx = triArcDragging.value;
    } else if (triArcDragging.arcType === "fan") {
      if (triArcDragging.zone === "AMB") fanAmb = triArcDragging.value;
      else if (triArcDragging.zone === "SX") fanSx = triArcDragging.value;
      else if (triArcDragging.zone === "DX") fanDx = triArcDragging.value;
    } else if (triArcDragging.arcType === "pwr") {
      pwrSp = triArcDragging.value;
    }
  }

  const caps = _getTriArcCaps();
  const rawLiveAuto = (latestData.fun_auto_set !== undefined && latestData.fun_auto_set !== null)
    ? latestData.fun_auto_set
    : getRegVal("fun_auto_set", 0);
  const autoPwr = (caps.has_auto !== false && Number(getTriArcLiveOrOpt("fun_auto_set", rawLiveAuto)) > 0) ? 1 : 0;
  const autoIdx = getTriArcZoneAutoIdx("AMB", { fanAmb, fanSx, fanDx, autoPwr });

  const isContainerSil = Boolean(window.stoveProvider?.isContainerActive?.());
  const containerSilFlag = Boolean(silenceModeState && silenceModeState.active);
  const rawRemSec = silenceModeState ? Math.max(0, Math.round(silenceModeState.end_epoch - Date.now() / 1000)) : 0;
  const ducts = Array.isArray(caps.ducts) ? caps.ducts : [];
  const tMin = Number(caps.temp_min ?? 7);
  const frostThresh = tMin + 0.5;
  const hasSxCap = ducts.some(d => d.id === "SX");
  const hasDxCap = ducts.some(d => d.id === "DX");
  const isAmbFrost = Number(spAmb) <= frostThresh;
  const isAllFrost = isAmbFrost && (!hasSxCap || Number(spSx) <= frostThresh) && (!hasDxCap || Number(spDx) <= frostThresh);
  const isStandaloneSilActive = (st === 0)
    ? isAllFrost
    : (st > 0 && isAmbFrost && pwfVal === 0 && (caps.has_auto === false || autoPwr === 1));
  const isSilActive = isContainerSil ? containerSilFlag : isStandaloneSilActive;
  const remSec = isContainerSil ? rawRemSec : 0;
  const isDemoMode = window.stoveProvider?.getMode?.() === "demo";
  const canWriteEco = Boolean(caps.can_write_eco) || getActiveCommMode() === "simulation" || getActiveCommMode() === "local_gateway" || isDemoMode;
  const rawLiveEco = (latestData.standby_enabled !== undefined && latestData.standby_enabled !== null)
    ? latestData.standby_enabled
    : (canWriteEco ? getRegVal("standby_set", 0) : 0);
  const ecoRegVal = canWriteEco
    ? Number(getTriArcLiveOrOpt("standby_set", rawLiveEco))
    : Number(rawLiveEco);
  const isEco = (st === 8 || st === 9 || ecoRegVal > 0);

  return {
    st, isAlarm, phaseIcon, phaseLabel: phaseLabelRaw, phaseColor,
    realAmb, spAmb, fanAmb, realFanAmb,
    realSx, spSx, fanSx, realFanSx,
    realDx, spDx, fanDx, realFanDx,
    pwrSp, realPwr, pwfVal, autoPwr, autoIdx, isContainerSil, isSilActive, remSec, isEco, canWriteEco
  };
}

function renderTriArcTopHeader(zone, T) {
  // Chevron SVG Gauche (pointe à gauche ◄) avec contours doux et arrondis
  const svgChevronLeftBg = (borderColor, fillColor = "#0b1222") => `
    <svg class="absolute inset-0 w-full h-full pointer-events-none" preserveAspectRatio="none" viewBox="0 0 100 50">
      <path d="M 22 2 L 88 2 Q 97 2 97 10 L 97 40 Q 97 48 88 48 L 22 48 Q 14 48 9.5 41.5 L 3.5 28.5 Q 1.5 25 3.5 21.5 L 9.5 8.5 Q 14 2 22 2 Z" fill="${fillColor}" fill-opacity="0.94" stroke="${borderColor}" stroke-width="2" stroke-linejoin="round" />
    </svg>
  `;

  // Chevron SVG Droite (pointe à droite ►) avec contours doux et arrondis
  const svgChevronRightBg = (borderColor, fillColor = "#0b1222") => `
    <svg class="absolute inset-0 w-full h-full pointer-events-none" preserveAspectRatio="none" viewBox="0 0 100 50">
      <path d="M 12 2 Q 3 2 3 10 L 3 40 Q 3 48 12 48 L 78 48 Q 86 48 90.5 41.5 L 96.5 28.5 Q 98.5 25 96.5 21.5 L 90.5 8.5 Q 86 2 78 2 Z" fill="${fillColor}" fill-opacity="0.94" stroke="${borderColor}" stroke-width="2" stroke-linejoin="round" />
    </svg>
  `;

  const sxName = escapeHtml(getDuctName("SX"));
  const dxName = escapeHtml(getDuctName("DX"));

  // Écran AMB : Bouton SX (Chevron gauche ◄, hauteur fixe h-14)
  const chevronSX = `
    <button type="button" onclick="goToTriArcZone('SX')" title="Canalisation Gauche (${sxName})"
      class="flex-1 min-w-0 h-14 relative py-1 pl-3.5 pr-2 flex items-center justify-between text-left transition hover:brightness-125 shadow cursor-pointer group">
      ${svgChevronLeftBg("#06b6d4")}
      <div class="relative z-10 flex items-center font-black text-cyan-300 text-xs my-auto pl-1 min-w-0 pr-1">
        <span class="truncate">${sxName}</span>
      </div>
      <div class="relative z-10 flex flex-col items-end gap-0.5 tabular-nums shrink-0">
        <span class="flex items-center gap-1 text-cyan-300 font-black text-[11px]">
          ${svgPropellerFanIcon("w-3.5 h-3.5", "#22d3ee")}
          <span>${fmtTriArcFan(T.fanSx)}</span>
        </span>
        <span class="text-[11px] font-black text-white pt-0.5 border-t border-slate-700/80">
          ${T.realSx}° <span class="text-cyan-400">→</span> <span class="text-cyan-200">${fmtTriArcTempSp(T.spSx)}</span>
        </span>
      </div>
    </button>
  `;

  // Écran AMB : Bouton DX (Chevron droite ►, hauteur fixe h-14)
  const chevronDX = `
    <button type="button" onclick="goToTriArcZone('DX')" title="Canalisation Droite (${dxName})"
      class="flex-1 min-w-0 h-14 relative py-1 pl-2 pr-3.5 flex items-center justify-between text-right transition hover:brightness-125 shadow cursor-pointer group">
      ${svgChevronRightBg("#0284c7")}
      <div class="relative z-10 flex flex-col items-start gap-0.5 tabular-nums shrink-0">
        <span class="flex items-center gap-1 text-sky-300 font-black text-[11px]">
          ${svgPropellerFanIcon("w-3.5 h-3.5", "#38bdf8")}
          <span>${fmtTriArcFan(T.fanDx)}</span>
        </span>
        <span class="text-[11px] font-black text-white pt-0.5 border-t border-slate-700/80">
          ${T.realDx}° <span class="text-sky-400">→</span> <span class="text-sky-200">${fmtTriArcTempSp(T.spDx)}</span>
        </span>
      </div>
      <div class="relative z-10 flex items-center font-black text-sky-300 text-xs my-auto pr-1 min-w-0 pl-1">
        <span class="truncate">${dxName}</span>
      </div>
    </button>
  `;

  // Écran SX : Le bouton SX devient un rectangle élargi (hauteur fixe h-14)
  const expandedRectSX = `
    <div class="flex-1 min-w-0 h-14 py-1.5 px-3 sm:px-3.5 rounded-2xl bg-cyan-950/70 border-2 border-cyan-400 flex items-center justify-between text-left transition shadow box-border">
      <div class="flex items-center gap-1 font-bold text-cyan-300 text-xs my-auto truncate pr-1">
        <span class="truncate">${sxName === "SX" ? "Canal. SX" : sxName}</span>
      </div>
      <div class="flex flex-col items-end gap-0.5 tabular-nums shrink-0">
        <span class="flex items-center gap-1 text-cyan-300 font-black text-xs">
          ${svgPropellerFanIcon("w-3.5 h-3.5", "#22d3ee")}
          <span>${fmtTriArcFan(T.fanSx)}</span>
        </span>
        <span class="text-xs font-black text-white whitespace-nowrap pt-0.5 border-t border-slate-700/80">
          ${T.realSx}° <span class="text-cyan-400">→</span> <span class="text-cyan-200">${fmtTriArcTempSp(T.spSx)}</span>
        </span>
      </div>
    </div>
  `;

  // Écran DX : Le bouton DX devient un rectangle élargi (hauteur fixe h-14)
  const expandedRectDX = `
    <div class="flex-1 min-w-0 h-14 py-1.5 px-3 sm:px-3.5 rounded-2xl bg-sky-950/70 border-2 border-sky-400 flex items-center justify-between text-right transition shadow box-border">
      <div class="flex flex-col items-start gap-0.5 tabular-nums shrink-0">
        <span class="flex items-center gap-1 text-sky-300 font-black text-xs">
          ${svgPropellerFanIcon("w-3.5 h-3.5", "#38bdf8")}
          <span>${fmtTriArcFan(T.fanDx)}</span>
        </span>
        <span class="text-xs font-black text-white whitespace-nowrap pt-0.5 border-t border-slate-700/80">
          ${T.realDx}° <span class="text-sky-400">→</span> <span class="text-sky-200">${fmtTriArcTempSp(T.spDx)}</span>
        </span>
      </div>
      <div class="flex items-center gap-1 font-bold text-sky-300 text-xs my-auto truncate pl-1">
        <span class="truncate">${dxName === "DX" ? "Canal. DX" : dxName}</span>
      </div>
    </div>
  `;

  // Bouton retour Poêle (Colorisé selon l'état du poêle, élargi pour garder T° et consigne sur une seule ligne)
  const chevronStoveReturn = (direction) => {
    const isReturnFromSx = (direction === "right");
    return `
      <button type="button" onclick="goToTriArcZone('AMB')"
        class="flex-1 min-w-0 h-14 relative py-1 ${isReturnFromSx ? 'pl-2.5 pr-4' : 'pl-4 pr-2.5'} flex items-center justify-between transition hover:brightness-125 shadow cursor-pointer group">
        ${isReturnFromSx ? svgChevronRightBg(T.phaseColor, "#0b1222") : svgChevronLeftBg(T.phaseColor, "#0b1222")}
        ${isReturnFromSx ? `
          <div class="relative z-10 flex flex-col items-start gap-0.5 tabular-nums min-w-0 pr-1">
            <span class="flex items-center gap-1 font-black text-[11px]" style="color:${T.phaseColor}">
              ${svgPropellerFanIcon("w-3 h-3", T.phaseColor)}
              <span>${fmtTriArcFan(T.fanAmb)}</span>
            </span>
            <span class="text-xs sm:text-[13px] font-black text-white whitespace-nowrap pt-0.5 border-t border-slate-700/80">
              ${T.realAmb}° <span style="color:${T.phaseColor}">→</span> <span style="color:${T.phaseColor}">${fmtTriArcTempSp(T.spAmb)}</span>
            </span>
          </div>
          <div class="relative z-10 flex items-center justify-center my-auto pr-1 shrink-0" title="Retour Poêle">
            ${svgNobisStoveIcon("w-6 h-6", T.phaseColor)}
          </div>
        ` : `
          <div class="relative z-10 flex items-center justify-center my-auto pl-1 shrink-0" title="Retour Poêle">
            ${svgNobisStoveIcon("w-6 h-6", T.phaseColor)}
          </div>
          <div class="relative z-10 flex flex-col items-end gap-0.5 tabular-nums min-w-0 pl-1">
            <span class="flex items-center gap-1 font-black text-[11px]" style="color:${T.phaseColor}">
              ${svgPropellerFanIcon("w-3 h-3", T.phaseColor)}
              <span>${fmtTriArcFan(T.fanAmb)}</span>
            </span>
            <span class="text-xs sm:text-[13px] font-black text-white whitespace-nowrap pt-0.5 border-t border-slate-700/80">
              ${T.realAmb}° <span style="color:${T.phaseColor}">→</span> <span style="color:${T.phaseColor}">${fmtTriArcTempSp(T.spAmb)}</span>
            </span>
          </div>
        `}
      </button>
    `;
  };

  let pwrBtnCls = "bg-orange-600/90 border-orange-400 text-white shadow-[0_0_14px_rgba(234,88,12,0.5)]";
  if (T.isAlarm) {
    pwrBtnCls = "bg-rose-700 border-rose-300 text-white shadow-[0_0_16px_rgba(244,63,94,0.65)] animate-pulse";
  } else if (T.st === 0) {
    pwrBtnCls = "bg-rose-950/90 border-rose-500 text-rose-200";
  }

  const centerPowerBtn = `
    <button type="button" onclick="handleDynamicPowerAction()"
      title="Bouton Marche / Arrêt Poêle"
      class="h-14 w-14 aspect-square rounded-2xl border-2 flex items-center justify-center shrink-0 transition shadow-lg cursor-pointer ${pwrBtnCls}">
      <svg viewBox="0 0 24 24" class="w-6 h-6 drop-shadow" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2v10" />
        <path d="M18.4 6.6a9 9 0 1 1-12.77.04" />
      </svg>
    </button>
  `;

  const caps = _getTriArcCaps();
  const ducts = Array.isArray(caps.ducts) ? caps.ducts : [];
  const hasSX = ducts.some(d => d.id === "SX");
  const hasDX = ducts.some(d => d.id === "DX");
  const stoveLabel = escapeHtml(latestData?.stove_name || "Stove Cockpit");
  const emptySpacer = `<div class="flex-1 min-w-0 h-14 px-3 rounded-2xl bg-slate-900/60 border border-slate-800/80 flex items-center justify-center text-xs font-bold text-slate-300 truncate">${stoveLabel}</div>`;

  if (zone === "AMB") {
    return `<div class="flex items-stretch justify-between gap-2">${hasSX ? chevronSX : emptySpacer}${centerPowerBtn}${hasDX ? chevronDX : emptySpacer}</div>`;
  } else if (zone === "SX") {
    return `<div class="flex items-stretch justify-between gap-2">${expandedRectSX}${chevronStoveReturn("right")}</div>`;
  } else {
    return `<div class="flex items-stretch justify-between gap-2">${chevronStoveReturn("left")}${expandedRectDX}</div>`;
  }
}

function renderTriArcSvgForZone(zone, T) {
  const caps = _getTriArcCaps();
  const fanMax = Math.max(1, Number(caps.fan_max ?? 8));
  const pwrMax = Math.max(1, Number(caps.power_max ?? 7));
  const pwrArcMax = caps.has_boost ? pwrMax + 1 : pwrMax;
  const showFanArc = (zone !== "AMB") || caps.has_fan_front !== false;

  const isDuct = (zone === "SX" || zone === "DX");
  const realT = zone === "AMB" ? T.realAmb : (zone === "SX" ? T.realSx : T.realDx);
  const spT = zone === "AMB" ? T.spAmb : (zone === "SX" ? T.spSx : T.spDx);
  const fanSp = zone === "AMB" ? T.fanAmb : (zone === "SX" ? T.fanSx : T.fanDx);
  const fanReal = zone === "AMB" ? T.realFanAmb : (zone === "SX" ? T.realFanSx : T.realFanDx);
  const pwrSp = T.pwrSp;
  const pwrReal = T.realPwr;

  const CX = 160, CY = 128;
  const R_TEMP = 74;
  const R_OUTER = 112;

  const angTempSp = triArcTempToAngle(spT);
  const angTempReal = triArcTempToAngle(realT);
  const posTempSp = triArcPtOnCircle(CX, CY, R_TEMP, angTempSp);
  const posTempReal = triArcPtOnCircle(CX, CY, R_TEMP, angTempReal);
  const trackTemp = triArcPath(CX, CY, R_TEMP, 135, 405, false);
  const fillTemp = triArcPath(CX, CY, R_TEMP, 135, angTempSp, false);

  const fanGaugeVal = Math.max(0, Math.min(fanMax, Number(fanReal > 0 ? fanReal : fanSp)));
  const angFanSp = 142 + (Math.max(0, Math.min(fanMax, fanSp)) / fanMax) * 76;
  const angFanReal = 142 + (Math.max(0, Math.min(fanMax, fanReal)) / fanMax) * 76;
  const angFanGauge = 142 + (fanGaugeVal / fanMax) * 76;
  const posFanSp = triArcPtOnCircle(CX, CY, R_OUTER, angFanSp);
  const posFanReal = triArcPtOnCircle(CX, CY, R_OUTER, angFanReal);
  const trackFan = triArcPath(CX, CY, R_OUTER, 142, 218, false);
  const fillFan = triArcPath(CX, CY, R_OUTER, 142, angFanGauge, false);

  const pwrGaugeVal = Math.max(0, Math.min(pwrArcMax, Number(pwrReal > 0 ? pwrReal : pwrSp)));
  const angPwrSp = 38 - (Math.max(0, Math.min(pwrArcMax, pwrSp)) / pwrArcMax) * 76;
  const angPwrReal = 38 - (Math.max(0, Math.min(pwrArcMax, pwrReal)) / pwrArcMax) * 76;
  const angPwrGauge = 38 - (pwrGaugeVal / pwrArcMax) * 76;
  const posPwrSp = triArcPtOnCircle(CX, CY, R_OUTER, angPwrSp);
  const posPwrReal = triArcPtOnCircle(CX, CY, R_OUTER, angPwrReal);
  const trackPwr = triArcPath(CX, CY, R_OUTER, 38, -38, true);
  const fillPwr = triArcPath(CX, CY, R_OUTER, 38, angPwrGauge, true);

  let fanTicks = "";
  for (let i = 0; i <= fanMax; i++) {
    const a = 142 + (i / fanMax) * 76;
    const pLbl = triArcPtOnCircle(CX, CY, R_OUTER + 18, a);
    const lbl = i === 0 ? "OFF" : (fanMax >= 8 && i === 8 ? "AUTO" : String(i));
    const isAct = (i === Math.round(fanGaugeVal)) || (i === Math.round(fanSp));
    fanTicks += `<text x="${pLbl.x.toFixed(1)}" y="${(pLbl.y + 3).toFixed(1)}" text-anchor="middle" font-size="${i === 0 || i === fanMax ? '8.5' : '9'}" font-weight="${isAct ? '900' : '600'}" fill="${isAct ? '#38bdf8' : '#64748b'}">${lbl}</text>`;
  }

  let pwrTicks = "";
  for (let i = 0; i <= pwrArcMax; i++) {
    const a = 38 - (i / pwrArcMax) * 76;
    const pLbl = triArcPtOnCircle(CX, CY, R_OUTER + 20, a);
    const lbl = i === 0 ? "0 Eco" : String(i);
    const isAct = !isDuct && ((i === Math.round(pwrGaugeVal)) || (i === Math.round(pwrSp)));
    pwrTicks += `<text x="${pLbl.x.toFixed(1)}" y="${(pLbl.y + 3).toFixed(1)}" text-anchor="middle" font-size="${i === 0 ? '8.5' : '9'}" font-weight="${isAct ? '900' : '600'}" fill="${isAct ? '#ea580c' : '#64748b'}">${lbl}</text>`;
  }

  const apexLabel = caps.stove_type === "hydro"
    ? `${Math.round((Number(caps.temp_min ?? 40) + Number(caps.temp_max ?? 80)) / 2)}°`
    : "19°";
  const minCornerLabel = caps.stove_type === "hydro" ? `${caps.temp_min ?? 40}°` : "❄️";
  const maxCornerLabel = caps.stove_type === "hydro" ? `${caps.temp_max ?? 80}°` : "MAX";

  const bgAnimClass = T.isAlarm ? "triarc-bg-alarm" : (T.st === 0 ? "" : "triarc-bg-breath");
  const phaseLines = formatPhaseTwoLines(T.phaseLabel, typeof getPhaseMeta === "function" ? getPhaseMeta(T.st) : null);

  return `
    <svg id="tri-arc-svg-${zone}" data-zone="${zone}" viewBox="14 20 292 198" class="tri-arc-svg w-full max-h-full mx-auto overflow-visible">
      <defs>
        <linearGradient id="gradTemp-${zone}" x1="0%" y1="100%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#38bdf8" />
          <stop offset="45%" stop-color="#f59e0b" />
          <stop offset="75%" stop-color="#ea580c" />
          <stop offset="100%" stop-color="#e11d48" />
        </linearGradient>
        <linearGradient id="gradFan-${zone}" x1="0%" y1="100%" x2="0%" y2="0%">
          <stop offset="0%" stop-color="#0284c7" />
          <stop offset="50%" stop-color="#38bdf8" />
          <stop offset="100%" stop-color="#fde047" />
        </linearGradient>
        <linearGradient id="gradPwr-${zone}" x1="0%" y1="100%" x2="0%" y2="0%">
          <stop offset="0%" stop-color="#38bdf8" />
          <stop offset="50%" stop-color="#f97316" />
          <stop offset="100%" stop-color="#ea580c" />
        </linearGradient>
        <radialGradient id="gradPhaseBg-${zone}" cx="50%" cy="50%" r="60%">
          <stop offset="0%" stop-color="${T.phaseColor}" stop-opacity="${T.st === 0 ? '0.12' : '0.42'}" />
          <stop offset="65%" stop-color="${T.phaseColor}" stop-opacity="${T.st === 0 ? '0.04' : '0.16'}" />
          <stop offset="100%" stop-color="#0b101d" stop-opacity="0.95" />
        </radialGradient>
      </defs>

      <!-- Fond du cadran central + Animation de la phase du poêle -->
      <circle cx="${CX}" cy="${CY}" r="68" fill="#0b101d" stroke="#1e293b" stroke-width="1" />
      <circle cx="${CX}" cy="${CY}" r="66" fill="url(#gradPhaseBg-${zone})" class="${bgAnimClass} pointer-events-none" />
      ${T.st !== 0 ? `<circle cx="${CX}" cy="${CY}" r="54" fill="none" stroke="${T.phaseColor}" stroke-width="1.5" class="triarc-bg-ripple pointer-events-none" />` : ""}

      <!-- LOGO EN ARRIÈRE-PLAN : POÊLE SUR AMB, VENTILATEUR EN FILIGRANE GRISÉ SUR SX & DX -->
      ${zone === "AMB" ? `
        <g transform="translate(${CX - 28}, ${CY - 38}) scale(0.56)" fill="${T.phaseColor}" opacity="0.18" class="pointer-events-none">
          ${nobisStovePaths()}
        </g>
      ` : `
        <g transform="translate(${CX - 50.4}, ${CY - 50.4}) scale(4.2)" fill="#94a3b8" opacity="0.14" class="pointer-events-none">
          <circle cx="12" cy="12" r="2.3"/>
          <path d="M12 9.2c-1.6-2.5-1.2-6.2 1.8-6.7 2.4-.4 4.1 1.8 3.1 4.3-.7 1.7-2.4 2.3-4.9 2.4z"/>
          <path d="M14.4 13.4c2.9.2 5.9 2.4 4.9 5.2-.9 2.3-3.6 2.7-5.3.6-1.1-1.4-.8-3.2.4-5.8z"/>
          <path d="M9.6 13.4c-1.3 2.6-2.6 4.5-4.7 3.8-2.3-.7-2.6-3.5-.6-5.2 1.5-1.3 3.4-1 5.3 1.4z"/>
        </g>
      `}

      <!-- 1. CERCLE CENTRAL TRONQUÉ : TEMPÉRATURE (SANS MARQUES 17°/23°) -->
      <path d="${trackTemp}" fill="none" stroke="#1e293b" stroke-width="8" stroke-linecap="round" />
      ${fillTemp ? `<path d="${fillTemp}" fill="none" stroke="url(#gradTemp-${zone})" stroke-width="8" stroke-linecap="round" />` : ""}
      <path d="${trackTemp}" fill="none" stroke="transparent" stroke-width="28" class="arc-hit" data-arc="temp" />

      <!-- Uniquement Min, Apogée et MAX -->
      <text x="105" y="202" text-anchor="middle" font-size="11" fill="#38bdf8" font-weight="bold">${minCornerLabel}</text>
      <text x="${CX}" y="46" text-anchor="middle" font-size="9.5" fill="#f97316" font-weight="bold">${apexLabel}</text>
      <text x="215" y="202" text-anchor="middle" font-size="9" fill="#fb7185" font-weight="bold">${maxCornerLabel}</text>

      <!-- MARQUEUR DU RÉEL SUR L'ARC TEMPÉRATURE -->
      <g transform="translate(${posTempReal.x}, ${posTempReal.y})">
        <circle cx="0" cy="0" r="5.5" fill="#090d16" stroke="#38bdf8" stroke-width="2.2" />
        <circle cx="0" cy="0" r="2" fill="#38bdf8" />
      </g>

      <!-- CURSEUR PICTOGRAMME TEMPÉRATURE (🌡️) -->
      <g transform="translate(${posTempSp.x}, ${posTempSp.y})" class="pointer-events-none">
        <circle cx="0" cy="0" r="11" fill="#0f172a" stroke="#ea580c" stroke-width="2.2" />
        <text x="0" y="1" text-anchor="middle" dominant-baseline="central" font-size="11.5">🌡️</text>
      </g>

      <!-- LIBELLÉ DISCRET DU VOLET / ZONE (CANALISATION SX / DX, SANS SALON) -->
      <text x="${CX}" y="79" text-anchor="middle" font-size="8.5" font-weight="800" fill="${zone === "SX" ? "#22d3ee" : (zone === "DX" ? "#38bdf8" : "#94a3b8")}" letter-spacing="0.5">${zone === "AMB" ? "" : escapeHtml((zone === "SX" ? (getDuctName("SX") === "SX" ? "CANAL. SX" : getDuctName("SX")) : (getDuctName("DX") === "DX" ? "CANAL. DX" : getDuctName("DX"))).toUpperCase().slice(0, 18))}</text>

      <!-- T° RÉELLE REDESCENDUE DANS LE CADRAN CENTRAL + FLÈCHE → CONSIGNE -->
      <text x="${CX}" y="134" text-anchor="middle"><tspan font-size="34" font-weight="900" fill="#ffffff">${realT}°</tspan><tspan dx="3" dy="-10" font-size="12" font-weight="bold" fill="#fb923c">→ ${fmtTriArcTempSp(spT)}</tspan></text>

      <!-- BULLE D'ÉTAT DU POÊLE (UNIQUEMENT SUR L'ÉCRAN CENTRAL AMB, DISPARAÎT SUR SX & DX) -->
      ${zone === "AMB" ? `
        <g onclick="openLifecycleFlowerModal()" class="triarc-phase-hit cursor-pointer" role="button" aria-label="Cycle de vie du poêle">
          <rect x="${CX - 44}" y="148" width="88" height="30" rx="9" fill="#0f172a" fill-opacity="0.88" stroke="${T.phaseColor}" stroke-opacity="0.75" stroke-width="1.2" />
          <text x="${CX}" y="159" text-anchor="middle" font-size="8.5" font-weight="900" fill="${T.phaseColor}">${T.phaseIcon} ${escapeHtml(phaseLines.line1)}</text>
          <text x="${CX}" y="171" text-anchor="middle" font-size="7.5" font-weight="700" fill="#cbd5e1">${escapeHtml(phaseLines.line2)}</text>
        </g>
      ` : ""}

      <!-- 2. ARC GAUCHE : VENTILATION (masqué sur poêle Hydro sans ventilateur frontal) -->
      ${showFanArc ? (() => {
      const isFanAuto = !isDuct && fanMax >= 8 && Number(fanSp) >= 8;
      return `
          <g class="${isFanAuto ? 'pointer-events-none opacity-60' : ''}">
            <path d="${trackFan}" fill="none" stroke="#1e293b" stroke-width="9" stroke-linecap="round" />
            ${fillFan ? `<path d="${fillFan}" fill="none" stroke="url(#gradFan-${zone})" stroke-width="9" stroke-linecap="round" />` : ""}
            ${!isFanAuto ? `<path d="${trackFan}" fill="none" stroke="transparent" stroke-width="28" class="arc-hit cursor-pointer" data-arc="fan" />` : ""}
            ${fanTicks}

            <g transform="translate(${posFanReal.x}, ${posFanReal.y})">
              <circle cx="0" cy="0" r="5.5" fill="#090d16" stroke="#38bdf8" stroke-width="2.2" />
              <circle cx="0" cy="0" r="2" fill="#38bdf8" />
            </g>
            ${!isFanAuto ? `
            <g transform="translate(${posFanSp.x}, ${posFanSp.y})" class="pointer-events-none">
              <circle cx="0" cy="0" r="11" fill="#0f172a" stroke="#38bdf8" stroke-width="2.2" />
              <g transform="translate(-7.5, -7.5) scale(0.625)" fill="#38bdf8">
                <circle cx="12" cy="12" r="2.3"/>
                <path d="M12 9.2c-1.6-2.5-1.2-6.2 1.8-6.7 2.4-.4 4.1 1.8 3.1 4.3-.7 1.7-2.4 2.3-4.9 2.4z"/>
                <path d="M14.4 13.4c2.9.2 5.9 2.4 4.9 5.2-.9 2.3-3.6 2.7-5.3.6-1.1-1.4-.8-3.2.4-5.8z"/>
                <path d="M9.6 13.4c-1.3 2.6-2.6 4.5-4.7 3.8-2.3-.7-2.6-3.5-.6-5.2 1.5-1.3 3.4-1 5.3 1.4z"/>
              </g>
            </g>
            ` : ""}
          </g>
        `;
    })() : ""}

      <!-- 3. ARC DROIT : PUISSANCE (0 Eco ➔ 1..7 ➔ 8, GRISÉ SUR SX/DX, NON CLIQUABLE SI AUTO PUISSANCE ACTIF) -->
      ${(() => {
      const isPwrAuto = Number(T.autoPwr) === 1;
      const isDisabled = isDuct || isPwrAuto;
      return `
          <g opacity="${isDuct ? '0.22' : (isPwrAuto ? '0.60' : '1')}" class="${isDisabled ? 'pointer-events-none' : ''}">
            <path d="${trackPwr}" fill="none" stroke="#1e293b" stroke-width="9" stroke-linecap="round" />
            ${fillPwr ? `<path d="${fillPwr}" fill="none" stroke="${isDuct ? '#475569' : `url(#gradPwr-${zone})`}" stroke-width="9" stroke-linecap="round" />` : ""}
            ${!isDisabled ? `<path d="${trackPwr}" fill="none" stroke="transparent" stroke-width="28" class="arc-hit cursor-pointer" data-arc="pwr" />` : ""}
            ${pwrTicks}

            <g transform="translate(${posPwrReal.x}, ${posPwrReal.y})">
              <circle cx="0" cy="0" r="5.5" fill="#090d16" stroke="${isDuct ? '#64748b' : '#ea580c'}" stroke-width="2.2" />
              <circle cx="0" cy="0" r="2" fill="${isDuct ? '#64748b' : '#ea580c'}" />
            </g>
            ${!isPwrAuto ? `
            <g transform="translate(${posPwrSp.x}, ${posPwrSp.y})" class="pointer-events-none">
              <circle cx="0" cy="0" r="11" fill="#0f172a" stroke="${isDuct ? '#64748b' : '#ea580c'}" stroke-width="2.2" />
              <text x="0" y="1" text-anchor="middle" dominant-baseline="central" font-size="11.5">🔥</text>
            </g>
            ` : ""}
          </g>
        `;
    })()}
    </svg>
  `;
}

function renderTriArcDailyChronoFrise(zone = "AMB") {
  const now = new Date();
  const todayJsDay = now.getDay();
  const nowMin = now.getHours() * 60 + now.getMinutes();

  const isChronoEnabled = Boolean(Number(getRegVal("chrono_week_enable_set", latestData.chrono_week_enable ?? 0)));

  // Couleurs vives pour les 4 programmes (1: Vert, 2: Ambre, 3: Cyan, 4: Violet)
  const progColors = isChronoEnabled ? {
    1: "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.7)]",
    2: "bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.7)]",
    3: "bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.7)]",
    4: "bg-purple-400 shadow-[0_0_6px_rgba(192,132,252,0.7)]"
  } : {
    1: "bg-slate-600",
    2: "bg-slate-600",
    3: "bg-slate-600",
    4: "bg-slate-600"
  };

  const fmtChronoFan = (v) => {
    const n = Number(v);
    if (n <= 0) return "OFF";
    if (n >= 8) return "Auto";
    return String(n);
  };

  // Fenêtre glissante de 24h centrée sur Maintenant (Now - 12h à Now + 12h)
  const HALF_WINDOW = 720; // 12 heures en minutes

  // Segments par programme (1 à 4) sur 4 pistes distinctes pour éviter toute superposition
  const tracksSegments = { 1: "", 2: "", 3: "", 4: "" };

  for (let p = 1; p <= 4; p++) {
    const startSlot = Number(getRegVal(`chrono_p${p}_start_set`, latestData[`chrono_p${p}_start`] ?? 144));
    const stopSlot = Number(getRegVal(`chrono_p${p}_stop_set`, latestData[`chrono_p${p}_stop`] ?? 144));
    const mask = Number(getRegVal(`chrono_p${p}_days_mask`, latestData[`chrono_p${p}_days`] ?? 0));

    if (startSlot >= 144 || stopSlot >= 144 || startSlot === stopSlot) continue;

    let temp = 19;
    let subLabel = "";
    if (zone === "SX") {
      temp = Number(getRegVal(`chrono_p${p}_tcanl_set`, latestData[`chrono_p${p}_tcanl`] ?? latestData[`chrono_p${p}_temp`] ?? 20));
      const ventSx = Number(getRegVal(`chrono_p${p}_canl_set`, latestData[`chrono_p${p}_canl`] ?? 0));
      subLabel = `V${fmtChronoFan(ventSx)}`;
    } else if (zone === "DX") {
      temp = Number(getRegVal(`chrono_p${p}_tcanr_set`, latestData[`chrono_p${p}_tcanr`] ?? latestData[`chrono_p${p}_temp`] ?? 20));
      const ventDx = Number(getRegVal(`chrono_p${p}_canr_set`, latestData[`chrono_p${p}_canr`] ?? 0));
      subLabel = `V${fmtChronoFan(ventDx)}`;
    } else {
      temp = Number(getRegVal(`chrono_p${p}_temperature_set`, latestData[`chrono_p${p}_temp`] ?? 19));
      const pwr = Number(getRegVal(`chrono_p${p}_power_set`, latestData[`chrono_p${p}_power`] ?? 4));
      const ventAmb = Number(getRegVal(`chrono_p${p}_fan_front_set`, latestData[`chrono_p${p}_fan_front`] ?? 0));
      subLabel = `P${pwr} · V${fmtChronoFan(ventAmb)}`;
    }

    // Parcourir hier (-1), aujourd'hui (0) et demain (+1)
    [-1, 0, 1].forEach(dOffset => {
      const targetJsDay = (todayJsDay + dOffset + 7) % 7;
      const dayObj = GANTT_DAYS.find(d => d.jsDay === targetJsDay) || GANTT_DAYS[0];
      const isDayActive = (mask & dayObj.bit) !== 0;
      if (!isDayActive) return;

      const dayBaseMin = dOffset * 1440;
      const subRanges = [];

      if (stopSlot > startSlot) {
        subRanges.push([dayBaseMin + startSlot * 10, dayBaseMin + stopSlot * 10]);
      } else {
        // Traverse minuit
        subRanges.push([dayBaseMin + startSlot * 10, dayBaseMin + 1440]);
        subRanges.push([dayBaseMin + 1440, dayBaseMin + 1440 + stopSlot * 10]);
      }

      subRanges.forEach(([t1, t2]) => {
        const relStart = t1 - nowMin;
        const relStop = t2 - nowMin;
        const cStart = Math.max(-HALF_WINDOW, relStart);
        const cStop = Math.min(HALF_WINDOW, relStop);

        if (cStop > cStart) {
          const leftPct = (50 + (cStart / HALF_WINDOW) * 50).toFixed(2);
          const widthPct = (((cStop - cStart) / HALF_WINDOW) * 50).toFixed(2);
          tracksSegments[p] += `
            <div style="left:${leftPct}%;width:${widthPct}%"
              class="absolute inset-y-0 rounded-full ${progColors[p]}"
              title="Programme ${p} (${zone}) : ${temp}°C | ${subLabel} ${!isChronoEnabled ? '(Chrono désactivé)' : ''}">
            </div>
          `;
        }
      });
    });
  }

  // Graduations d'heures dynamiques glissantes toutes les 3 heures
  let ticksHtml = "";
  [-1, 0, 1].forEach(dOffset => {
    for (let h = 0; h < 24; h += 3) {
      const tMin = dOffset * 1440 + h * 60;
      const rel = tMin - nowMin;
      if (rel >= -HALF_WINDOW + 25 && rel <= HALF_WINDOW - 25) {
        if (Math.abs(rel) > 40) {
          const xPct = (50 + (rel / HALF_WINDOW) * 50).toFixed(1);
          ticksHtml += `<span style="left:${xPct}%;" class="absolute -translate-x-1/2">${String(h).padStart(2, "0")}h</span>`;
        }
      }
    }
  });

  return `
    <button type="button" onclick="switchTab('tab-chrono')"
      title="Ouvrir l'onglet Programmes (🕒 Chrono)"
      class="w-full text-left bg-slate-900/90 hover:bg-slate-800/90 border border-slate-800/90 hover:border-orange-500/60 rounded-2xl px-3 py-1 space-y-1 shadow-md transition cursor-pointer select-none ${!isChronoEnabled ? 'opacity-60' : ''}">
      <!-- 4 pistes distinctes superposées (P1 à P4) : traits de couleur sans superposition -->
      <div class="relative w-full h-8 bg-slate-950 rounded-xl border border-slate-800 overflow-hidden flex flex-col justify-between py-1.5 px-1">
        <div class="relative w-full h-1 bg-slate-900/60 rounded-full overflow-hidden">
          ${tracksSegments[1]}
        </div>
        <div class="relative w-full h-1 bg-slate-900/60 rounded-full overflow-hidden">
          ${tracksSegments[2]}
        </div>
        <div class="relative w-full h-1 bg-slate-900/60 rounded-full overflow-hidden">
          ${tracksSegments[3]}
        </div>
        <div class="relative w-full h-1 bg-slate-900/60 rounded-full overflow-hidden">
          ${tracksSegments[4]}
        </div>
        <!-- Trait rouge fixe au centre (50%) symbolisant Maintenant -->
        <div style="left:50%;" class="absolute inset-y-0 w-0.5 bg-rose-500 z-10 shadow-[0_0_10px_#f43f5e] -translate-x-1/2 pointer-events-none"></div>
      </div>
      <!-- Échelle horaire glissante -->
      <div class="relative w-full h-3.5 text-[9.5px] text-slate-500 font-mono leading-none">
        ${ticksHtml}
      </div>
    </button>
  `;
}

function _triArcZoneSupportsFanAuto(zone, caps) {
  const ducts = Array.isArray(caps?.ducts) ? caps.ducts : [];
  if (zone === "AMB") {
    return caps?.has_fan_front !== false && Number(caps?.fan_max ?? 8) >= 8;
  }
  const meta = ducts.find(d => d.id === zone);
  return Boolean(meta) && Number(meta.speed_max ?? 8) >= 8;
}

function getTriArcZoneAutoIdx(zone, T) {
  const caps = _getTriArcCaps();
  const fanSp = zone === "AMB" ? T.fanAmb : (zone === "SX" ? T.fanSx : T.fanDx);
  const fanIsAuto = _triArcZoneSupportsFanAuto(zone, caps) && Number(fanSp) >= 8;
  const pwrIsAuto = (caps.has_auto !== false) && Number(T.autoPwr) === 1;
  if (pwrIsAuto && fanIsAuto) return 2;
  if (pwrIsAuto && !fanIsAuto) return 3;
  if (!pwrIsAuto && fanIsAuto) return 1;
  return 0;
}

function renderTriArcBottomModes(T, zone = triArcZone) {
  const caps = _getTriArcCaps();
  const ducts = Array.isArray(caps.ducts) ? caps.ducts : [];
  const silTimerActive = Boolean(T.isContainerSil) && T.isSilActive && T.remSec > 0;
  const silBtnActive = T.isContainerSil ? silTimerActive : Boolean(T.isSilActive);
  const silTimerTxt = silTimerActive
    ? `${Math.floor(T.remSec / 3600)}h${String(Math.floor((T.remSec % 3600) / 60)).padStart(2, "0")}`
    : "";
  const silBadge = silTimerActive
    ? `<span id="triarc-silence-btn-timer" class="text-[10px] font-black mt-0.5 tabular-nums text-purple-200">${silTimerTxt}</span>`
    : (silBtnActive ? `<span class="text-[9.5px] font-black uppercase text-purple-200 mt-0.5">Actif</span>` : "");

  const hasAnyAutoFan = _triArcZoneSupportsFanAuto("AMB", caps)
    || ducts.some(d => Number(d.speed_max ?? 8) >= 8);
  const showAutoBtn = caps.has_auto !== false || hasAnyAutoFan;

  const zoneAutoIdx = getTriArcZoneAutoIdx(zone, T);
  let autoBtnCls = "bg-slate-900/90 border-slate-700 text-slate-400 hover:border-cyan-400";
  let autoBadge = "";
  if (zoneAutoIdx === 1) {
    autoBtnCls = "bg-cyan-950/80 border-cyan-400 text-cyan-200 shadow-[0_0_12px_rgba(6,182,212,0.35)]";
    autoBadge = `<span class="text-[9.5px] font-black uppercase text-cyan-300 mt-0.5">Ventil</span>`;
  } else if (zoneAutoIdx === 3) {
    autoBtnCls = "bg-amber-950/80 border-amber-400 text-amber-200 shadow-[0_0_12px_rgba(245,158,11,0.35)]";
    autoBadge = `<span class="text-[9.5px] font-black uppercase text-amber-300 mt-0.5">${hasAnyAutoFan ? "Flamme" : "Auto"}</span>`;
  } else if (zoneAutoIdx === 2) {
    autoBtnCls = "bg-orange-950/80 border-orange-400 text-orange-200 shadow-[0_0_12px_rgba(249,115,22,0.35)]";
    autoBadge = `<span class="text-[9.5px] font-black uppercase text-orange-300 mt-0.5">Auto</span>`;
  }

  const boostButtonHtml = (() => {
    if (caps.has_boost === false) return "";
    const pwrMax = Math.max(1, Number(caps.power_max ?? 7));
    const isBoostRealP8 = T.st === 5 && Number(T.realPwr) > pwrMax;
    let boostBtnCls = "bg-slate-900/90 border-slate-700 text-slate-300 hover:border-rose-400";
    let boostIcon = `<span class="text-2xl leading-none">🚀</span>`;
    let boostBadge = "";
    if (T.pwfVal === 1 || (T.pwfVal === 0 && isBoostRealP8)) {
      boostBtnCls = "bg-rose-950/80 border-rose-400 text-rose-200 shadow-[0_0_14px_rgba(244,63,94,0.45)]";
      boostIcon = `<span class="text-xl leading-none drop-shadow-[0_0_8px_rgba(244,63,94,0.8)]">🚀</span>`;
      boostBadge = `<span class="text-[9.5px] font-black uppercase text-rose-300 mt-0.5">Boost</span>`;
    } else if (T.pwfVal === 2) {
      if (isBoostRealP8) {
        boostBtnCls = "bg-rose-950/80 border-rose-400 text-rose-200 shadow-[0_0_14px_rgba(244,63,94,0.45)]";
        boostBadge = `<span class="text-[9.5px] font-black uppercase text-rose-300 mt-0.5">Actif</span>`;
      } else {
        boostBtnCls = "bg-amber-950/80 border-amber-400 text-amber-200 shadow-[0_0_14px_rgba(245,158,11,0.45)]";
        boostBadge = `<span class="text-[9.5px] font-black uppercase text-amber-300 mt-0.5">Prog</span>`;
      }
      boostIcon = `
          <div class="relative inline-flex items-center justify-center">
            <span class="text-xl leading-none drop-shadow-[0_0_8px_rgba(245,158,11,0.8)]">🚀</span>
            <span class="absolute -bottom-1 -right-1.5 text-[10px] leading-none">⏱️</span>
          </div>
        `;
    }
    return `
        <button type="button" onclick="toggleTriArcOptionBubble('boost')"
          title="Mode Boost / POWERFUL (0=OFF, 1=Actif, 2=Programmé)"
          class="flex-1 h-14 sm:h-15 min-h-[54px] rounded-2xl border-2 flex flex-col items-center justify-center transition cursor-pointer ${boostBtnCls}">
          ${boostIcon}
          ${boostBadge}
        </button>
      `;
  })();

  return `
    <div class="flex items-stretch gap-2 pt-1 pb-1">
      <!-- 1. Silence (🤫 — temporisé avec retour auto via conteneur Mode +, direct sans temporisation en Standalone) -->
      <button type="button" onclick="toggleTriArcOptionBubble('silence')"
        title="${T.isContainerSil ? 'Mode Silence (Timer Conteneur)' : 'Mode Silence (Sans temporisation)'}"
        class="flex-1 h-14 sm:h-15 min-h-[54px] rounded-2xl border-2 flex flex-col items-center justify-center transition cursor-pointer ${silBtnActive ? 'bg-purple-950/75 border-purple-400 text-white shadow-[0_0_12px_rgba(168,85,247,0.35)]' : 'bg-slate-900/90 border-slate-700 text-slate-400 hover:border-purple-400'}">
        <span class="${silBtnActive ? 'text-xl' : 'text-2xl'} leading-none">🤫</span>
        ${silBadge}
      </button>

      <!-- 2. Auto -->
      ${showAutoBtn ? `
      <button type="button" onclick="toggleTriArcOptionBubble('auto')"
        title="Mode Auto (OFF / Flamme / Ventilation / Auto complet)"
        class="flex-1 h-14 sm:h-15 min-h-[54px] rounded-2xl border-2 flex flex-col items-center justify-center transition cursor-pointer ${autoBtnCls}">
        <span class="text-lg leading-none flex items-center justify-center gap-0.5">
          <span>🔥</span><span class="text-base font-bold">+</span>${svgPropellerFanIcon("w-4 h-4", "currentColor")}
        </span>
        ${autoBadge}
      </button>
      ` : ""}

      <!-- 3. Boost -->
      ${boostButtonHtml}
    </div>
  `;
}

function renderTriArcFloatingOptionBubble(T) {
  if (!triArcExpandedMode) return "";

  if (triArcExpandedMode === "auto") {
    const caps = _getTriArcCaps();
    const hasAutoPwrCap = caps.has_auto !== false;
    const hasZoneAutoFan = _triArcZoneSupportsFanAuto(triArcZone, caps);
    const zoneAutoIdx = getTriArcZoneAutoIdx(triArcZone, T);
    let buttonsHtml = "";
    let legendHtml = "";
    if (hasAutoPwrCap && hasZoneAutoFan) {
      buttonsHtml = `
        <div class="grid grid-cols-4 gap-1.5 text-[11px] font-bold">
          <button type="button" onclick="setTriArcAutoOption(0)" class="py-2.5 rounded-2xl border cursor-pointer ${zoneAutoIdx === 0 ? 'bg-slate-700 border-white text-white' : 'bg-slate-950 border-slate-800 text-slate-400'}">OFF</button>
          <button type="button" onclick="setTriArcAutoOption(3)" class="py-2.5 rounded-2xl border flex items-center justify-center gap-1 cursor-pointer ${zoneAutoIdx === 3 ? 'bg-amber-600 border-amber-300 text-white' : 'bg-slate-950 border-slate-800 text-slate-300'}"><span>🔥</span><span>Flamme</span></button>
          <button type="button" onclick="setTriArcAutoOption(1)" class="py-2.5 rounded-2xl border flex items-center justify-center gap-1 cursor-pointer ${zoneAutoIdx === 1 ? 'bg-cyan-600 border-cyan-300 text-white' : 'bg-slate-950 border-slate-800 text-slate-300'}">${svgPropellerFanIcon("w-3.5 h-3.5")}<span>Ventil</span></button>
          <button type="button" onclick="setTriArcAutoOption(2)" class="py-2.5 rounded-2xl border flex items-center justify-center gap-1 cursor-pointer ${zoneAutoIdx === 2 ? 'bg-orange-600 border-orange-300 text-white' : 'bg-slate-950 border-slate-800 text-slate-300'}"><span>🔥+</span>${svgPropellerFanIcon("w-3.5 h-3.5")}</button>
        </div>
      `;
      legendHtml = `
        <ul class="space-y-1.5 list-disc list-inside text-slate-300">
          <li><strong>OFF</strong> : Manuel intégral (flamme et ventilation réglées manuellement).</li>
          <li><strong>Flamme (🔥)</strong> : Modulation automatique de la puissance par le poêle, ventilation libre en manuel.</li>
          <li><strong>Ventil (${svgPropellerFanIcon("w-3.5 h-3.5 inline text-cyan-400")})</strong> : Ventilation automatique selon la consigne, puissance manuelle.</li>
          <li><strong>Auto Total (🔥+Ventil)</strong> : Régulation automatique conjointe de la flamme et de la ventilation.</li>
        </ul>
      `;
    } else if (hasAutoPwrCap) {
      buttonsHtml = `
        <div class="grid grid-cols-2 gap-2 text-xs font-bold">
          <button type="button" onclick="setTriArcAutoOption(0)" class="py-2.5 rounded-2xl border cursor-pointer ${zoneAutoIdx === 0 ? 'bg-slate-700 border-white text-white' : 'bg-slate-950 border-slate-800 text-slate-400'}">OFF</button>
          <button type="button" onclick="setTriArcAutoOption(3)" class="py-2.5 rounded-2xl border flex items-center justify-center gap-1 cursor-pointer ${zoneAutoIdx === 3 || zoneAutoIdx === 2 ? 'bg-amber-600 border-amber-300 text-white' : 'bg-slate-950 border-slate-800 text-slate-300'}"><span>🔥</span><span>Auto</span></button>
        </div>
      `;
      legendHtml = `
        <ul class="space-y-1.5 list-disc list-inside text-slate-300">
          <li><strong>OFF</strong> : Puissance réglée manuellement.</li>
          <li><strong>Auto (🔥)</strong> : Modulation automatique de la puissance par le poêle selon votre température cible.</li>
        </ul>
      `;
    } else {
      buttonsHtml = `
        <div class="grid grid-cols-2 gap-2 text-xs font-bold">
          <button type="button" onclick="setTriArcAutoOption(0)" class="py-2.5 rounded-2xl border cursor-pointer ${zoneAutoIdx === 0 ? 'bg-slate-700 border-white text-white' : 'bg-slate-950 border-slate-800 text-slate-400'}">OFF</button>
          <button type="button" onclick="setTriArcAutoOption(1)" class="py-2.5 rounded-2xl border flex items-center justify-center gap-1 cursor-pointer ${zoneAutoIdx === 1 || zoneAutoIdx === 2 ? 'bg-cyan-600 border-cyan-300 text-white' : 'bg-slate-950 border-slate-800 text-slate-300'}">${svgPropellerFanIcon("w-4 h-4")}<span>Ventil</span></button>
        </div>
      `;
      legendHtml = `
        <ul class="space-y-1.5 list-disc list-inside text-slate-300">
          <li><strong>OFF</strong> : Ventilation réglée manuellement.</li>
          <li><strong>Ventil (${svgPropellerFanIcon("w-3.5 h-3.5 inline text-cyan-400")})</strong> : Ventilation modulée automatiquement selon la consigne.</li>
        </ul>
      `;
    }
    return `
      <div class="bg-slate-900 border-2 border-cyan-400 rounded-3xl p-3.5 space-y-2.5 shadow-[0_10px_40px_rgba(0,0,0,0.9)]">
        <div class="flex items-center justify-between text-xs border-b border-slate-800 pb-2">
          <span class="font-bold text-cyan-300 flex items-center gap-1.5">🔥+${svgPropellerFanIcon("w-4 h-4", "#22d3ee")} Mode Auto (État réel du poêle)</span>
          <button type="button" onclick="closeTriArcOptionBubble()" class="w-6 h-6 rounded-full bg-slate-800 text-slate-300 font-bold cursor-pointer">✕</button>
        </div>
        ${buttonsHtml}
        <div class="space-y-1.5 text-[11px] leading-tight text-slate-300 bg-slate-950/70 border border-slate-800 rounded-xl p-2.5">
          <p class="font-semibold text-cyan-300">Fonctionnement du mode Auto</p>
          ${legendHtml}
        </div>
      </div>
    `;
  }

  if (triArcExpandedMode === "boost") {
    const caps = _getTriArcCaps();
    const pwrMax = Math.max(1, Number(caps.power_max ?? 7));
    const isBoostRealP8 = T.st === 5 && Number(T.realPwr) > pwrMax;
    const isBoostOffActive = T.pwfVal === 0 && !isBoostRealP8;
    const isBoostOnActive = T.pwfVal === 1 || (T.pwfVal === 0 && isBoostRealP8);
    return `
      <div class="bg-slate-900 border-2 border-rose-400 rounded-3xl p-3.5 space-y-2.5 shadow-[0_10px_40px_rgba(0,0,0,0.9)]">
        <div class="flex items-center justify-between text-xs border-b border-slate-800 pb-2">
          <span class="font-bold text-rose-300 flex items-center gap-1.5"><span class="text-base">🚀</span> Mode Boost (POWERFUL Nobis)</span>
          <button type="button" onclick="closeTriArcOptionBubble()" class="w-6 h-6 rounded-full bg-slate-800 text-slate-300 font-bold cursor-pointer">✕</button>
        </div>
        <div class="grid grid-cols-3 gap-2 text-xs font-bold">
          <button type="button" onclick="setTriArcBoostOption(0)" class="py-2.5 rounded-2xl border cursor-pointer ${isBoostOffActive ? 'bg-slate-700 border-white text-white' : 'bg-slate-950 border-slate-800 text-slate-400'}">OFF</button>
          <button type="button" onclick="setTriArcBoostOption(1)" class="py-2.5 rounded-2xl border flex items-center justify-center gap-1 cursor-pointer ${isBoostOnActive ? 'bg-rose-600 border-rose-300 text-white' : 'bg-slate-950 border-slate-800 text-slate-300'}"><span class="text-sm">🚀</span><span>ACTIF</span></button>
          <button type="button" onclick="setTriArcBoostOption(2)" class="py-2.5 rounded-2xl border flex items-center justify-center gap-1 cursor-pointer ${T.pwfVal === 2 ? 'bg-amber-600 border-amber-300 text-white' : 'bg-slate-950 border-slate-800 text-slate-300'}"><span class="text-sm">⏱️</span><span>PROG</span></button>
        </div>
        ${T.pwfVal === 2 && isBoostRealP8 ? `<p class="text-[11px] font-semibold text-rose-300 bg-rose-950/40 border border-rose-500/40 rounded-xl px-2.5 py-1.5">🚀 Créneau POWERFUL actuellement actif en combustion (P8).</p>` : ""}
        <div class="space-y-1.5 text-[11px] leading-tight text-slate-300 bg-slate-950/70 border border-slate-800 rounded-xl p-2.5">
          <p class="font-semibold text-rose-300">Fonctionnement du mode Powerful</p>
          <p>Dans l'environnement Nobis, cette fonction s'appelle <strong>POWERFUL</strong>. Elle enclenche temporairement la ventilation et la puissance de chauffe à leur niveau maximum pour réchauffer très rapidement la pièce, tout en conservant votre consigne habituelle de puissance (qui ne passe pas à 8).</p>
        </div>
        <div class="text-[11px] leading-tight text-amber-300/90 bg-amber-950/40 border border-amber-500/30 rounded-xl p-2 flex items-start gap-1.5">
          <span class="text-sm leading-none shrink-0">⚠️</span>
          <div>
            <p class="font-bold text-amber-200 mb-0.5">Chemin de programmation sur la télécommande :</p>
            <p><strong>Menu &gt; Réglages / Set Poêle &gt; Powerful &gt; Programmation horaire</strong></p>
            <p class="mt-1 text-[10px] text-amber-300/80">La programmation horaire ne peut pas être effectuée depuis l'application : elle doit obligatoirement être configurée depuis la télécommande physique. Merci Nobis !</p>
          </div>
        </div>
      </div>
    `;
  }

  if (triArcExpandedMode === "eco") {
    const phaseBadgeHtml = T.st === 8
      ? `<div class="py-2.5 px-3 rounded-2xl bg-cyan-950/80 border border-cyan-500 text-cyan-300 text-xs font-bold flex items-center justify-center gap-2 shadow">
          <span>⏳</span><span>PHASE ACTIVE : 8 = ECO STOP</span>
         </div>`
      : (T.st === 9
        ? `<div class="py-2.5 px-3 rounded-2xl bg-cyan-950/80 border border-cyan-500 text-cyan-300 text-xs font-bold flex items-center justify-center gap-2 shadow">
            <span>🌙</span><span>PHASE ACTIVE : 9 = STAND BY</span>
           </div>`
        : (T.isEco
          ? `<div class="py-2.5 px-3 rounded-2xl bg-emerald-950/70 border border-emerald-500 text-emerald-300 text-xs font-bold flex items-center justify-center gap-2 shadow">
              <span>💤</span><span>CONFORT CLIMA ACTIF (${escapeHtml(T.phaseLabel)})</span>
             </div>`
          : `<div class="py-2.5 px-3 rounded-2xl bg-slate-950 border border-slate-700 text-slate-300 text-xs font-bold flex items-center justify-center gap-2">
              <span class="text-slate-400">💤</span><span>ÉTAT POÊLE : VEILLE INACTIVE (${escapeHtml(T.phaseLabel)})</span>
             </div>`));

    const ecoControlsHtml = T.canWriteEco
      ? `
        <div class="grid grid-cols-2 gap-2 text-xs font-bold pt-1">
          <button type="button" onclick="setTriArcEcoOption(0)" class="py-2.5 rounded-2xl border cursor-pointer ${!T.isEco ? 'bg-slate-700 border-white text-white' : 'bg-slate-950 border-slate-800 text-slate-400'}">OFF</button>
          <button type="button" onclick="setTriArcEcoOption(1)" class="py-2.5 rounded-2xl border flex items-center justify-center gap-1.5 cursor-pointer ${T.isEco ? 'bg-emerald-600 border-emerald-300 text-white' : 'bg-slate-950 border-slate-800 text-slate-300'}"><span class="text-sm">💤</span><span>ACTIF</span></button>
        </div>
      `
      : "";

    const ecoNoticeHtml = !T.canWriteEco
      ? `
        <div class="text-[11px] leading-tight text-amber-300/90 bg-amber-950/40 border border-amber-500/30 rounded-xl p-2.5 flex items-start gap-2">
          <span class="text-base leading-none shrink-0">ℹ️</span>
          <div>
            <p class="font-bold text-amber-200 mb-1">Activation et réglages sur la radiocommande Nobis :</p>
            <p class="text-white font-mono text-[11px] bg-black/40 px-2 py-1 rounded border border-amber-500/20 mb-1.5">
              MENU ▸ UTILISATEUR ▸ COMFORT CLIMA (ON / OFF)
            </p>
            <p class="text-[10px] text-amber-200/90 leading-normal">
              L'activation/désactivation de Comfort Clima ainsi que ses réglages (temporisation d'extinction et écart thermique Delta T°) se configurent <strong>exclusivement sur la radiocommande physique Nobis</strong>. Le protocole Cloud Agua IOT ne dispose d'aucun registre de commande à distance pour cette fonction. L'application supervise fidèlement l'état et détecte automatiquement vos phases réelles <strong>ECO STOP (8)</strong> et <strong>STAND BY (9)</strong>.
            </p>
          </div>
        </div>
      `
      : "";

    return `
      <div class="bg-slate-900 border-2 border-emerald-400 rounded-3xl p-3.5 space-y-2.5 shadow-[0_10px_40px_rgba(0,0,0,0.9)]">
        <div class="flex items-center justify-between text-xs border-b border-slate-800 pb-2">
          <span class="font-bold text-emerald-300 flex items-center gap-1.5"><span class="text-base">💤</span> Mode Éco (CONFORT CLIMA Nobis)</span>
          <button type="button" onclick="closeTriArcOptionBubble()" class="w-6 h-6 rounded-full bg-slate-800 text-slate-300 font-bold cursor-pointer">✕</button>
        </div>

        ${phaseBadgeHtml}
        ${ecoControlsHtml}

        <div class="space-y-1.5 text-[11px] leading-tight text-slate-300 bg-slate-950/70 border border-slate-800 rounded-xl p-2.5">
          <p class="font-semibold text-emerald-300">Fonctionnement Confort Clima (Eco-Stop)</p>
          <p>Le mode Éco correspond au <strong>Confort Clima</strong> de Nobis. Lorsque la température ambiante mesurée dépasse votre consigne cible, le poêle passe automatiquement en extinction thermique (<strong>ECO STOP</strong>) pour ne pas surchauffer et économiser les granulés. Dès que la température redescend sous la consigne (moins le delta configuré), le poêle redémarre tout seul (<strong>STAND BY</strong>).</p>
        </div>

        ${ecoNoticeHtml}
      </div>
    `;
  }

  if (triArcExpandedMode === "silence") {
    const caps = _getTriArcCaps();
    if (!T.isContainerSil) {
      const silDirectActive = Boolean(T.isSilActive);
      const tMin = Math.round(Number(caps.temp_min ?? 7));
      return `
        <div class="bg-slate-900 border-2 border-purple-400 rounded-3xl p-3.5 space-y-2.5 shadow-[0_10px_40px_rgba(0,0,0,0.9)]">
          <div class="flex items-center justify-between text-xs border-b border-slate-800 pb-2">
            <span class="font-bold text-purple-300">🤫 Mode Silence (Sans temporisation)</span>
            <button type="button" onclick="closeTriArcOptionBubble()" class="w-6 h-6 rounded-full bg-slate-800 text-slate-300 font-bold cursor-pointer">✕</button>
          </div>
          ${silDirectActive ? `
            <div class="py-2.5 px-3 rounded-2xl bg-purple-950/70 border border-purple-400 text-purple-200 text-xs font-bold text-center space-y-1">
              <div>🤫 Mode Silence actif sur le poêle</div>
              <div class="text-[10.5px] font-normal text-purple-200/80">Remontez simplement la consigne de température ou changez de mode pour en sortir.</div>
            </div>
          ` : `
            <button type="button" onclick="activateStandaloneSilence()"
              class="w-full py-2.5 px-3 rounded-2xl border border-purple-400 bg-purple-700/80 hover:bg-purple-600 text-white text-xs font-bold flex items-center justify-center gap-2 cursor-pointer transition">
              <span>🤫</span><span>Activer Silence maintenant (${tMin}°C / ralenti)</span>
            </button>
          `}
          <div class="space-y-1.5 text-[11px] leading-tight text-slate-300 bg-slate-950/70 border border-slate-800 rounded-xl p-2.5">
            <p class="font-semibold text-purple-300">Fonctionnement en mode Standalone</p>
            <p>Passe les consignes en <strong>hors gel (${tMin}°C)</strong>${T.st !== 0 ? " et règle le poêle en <strong>Auto</strong> (Boost et Chrono coupés) pour un ralenti silencieux immédiat" : ""}.</p>
          </div>
          ${!T.canWriteEco ? `
          <div class="text-[11px] leading-tight text-amber-200 bg-amber-950/40 border border-amber-500/40 rounded-xl p-2.5">
            ℹ️ Si <strong>Comfort Clima</strong> est actif sur la télécommande physique, la consigne à ${tMin}°C mettra le poêle en veille <strong>ECO STOP</strong> au lieu du ralenti continu P0.
          </div>
          ` : ""}
          <div class="text-[11px] leading-tight text-indigo-200 bg-indigo-950/40 border border-indigo-500/40 rounded-xl p-2.5 flex items-start gap-2">
            <span class="text-sm leading-none shrink-0">⏱️</span>
            <p><strong>Temporisation &amp; retour automatique :</strong> la minuterie (1h à 4h) et la restauration automatique de l'état initial sont gérées uniquement lorsque vous êtes connecté au conteneur (<strong>Mode « + »</strong>).</p>
          </div>
        </div>
      `;
    }
    const silActive = T.isSilActive && T.remSec > 0;
    const activeSilHours = silActive ? Math.round(Number(silenceModeState?.duration_hours ?? 0)) : 0;
    const silHourBtnCls = (h) => (
      activeSilHours === h
        ? "bg-purple-700/80 border-purple-300 text-white"
        : "bg-slate-950 border-slate-800 hover:border-purple-400 text-purple-200"
    );
    const remStr = silActive ? formatSilenceCountdown(T.remSec) : "OFF";
    return `
      <div class="bg-slate-900 border-2 border-purple-400 rounded-3xl p-3.5 space-y-2.5 shadow-[0_10px_40px_rgba(0,0,0,0.9)]">
        <div class="flex items-center justify-between text-xs border-b border-slate-800 pb-2">
          <span id="triarc-silence-bubble-timer" class="font-bold text-purple-300">🤫 Timer Silence (${remStr})</span>
          <button type="button" onclick="closeTriArcOptionBubble()" class="w-6 h-6 rounded-full bg-slate-800 text-slate-300 font-bold cursor-pointer">✕</button>
        </div>
        <div class="grid grid-cols-5 gap-1.5 text-xs font-bold">
          <button type="button" onclick="setTriArcSilenceHours(0)" class="py-2.5 rounded-2xl border cursor-pointer ${!silActive ? 'bg-slate-700 border-white text-white' : 'bg-slate-950 border-slate-800 text-slate-400'}">OFF</button>
          <button type="button" onclick="setTriArcSilenceHours(1)" class="py-2.5 rounded-2xl border cursor-pointer ${silHourBtnCls(1)}">1h</button>
          <button type="button" onclick="setTriArcSilenceHours(2)" class="py-2.5 rounded-2xl border cursor-pointer ${silHourBtnCls(2)}">2h</button>
          <button type="button" onclick="setTriArcSilenceHours(3)" class="py-2.5 rounded-2xl border cursor-pointer ${silHourBtnCls(3)}">3h</button>
          <button type="button" onclick="setTriArcSilenceHours(4)" class="py-2.5 rounded-2xl border cursor-pointer ${silHourBtnCls(4)}">4h</button>
        </div>
        <div class="space-y-1.5 text-[11px] leading-tight text-slate-300 bg-slate-950/70 border border-slate-800 rounded-xl p-2.5">
          <p class="font-semibold text-purple-300">Fonctionnement intelligent du mode Silence</p>
          <p>• <strong>Si poêle éteint :</strong> toutes les consignes passent immédiatement en <strong>hors gel (7°C)</strong>.</p>
          <p>• <strong>Si poêle allumé :</strong> ${T.canWriteEco ? "désactivation du <strong>Boost</strong>, du <strong>Mode Éco</strong> et de la <strong>programmation (Chrono)</strong>" : "désactivation du <strong>Boost</strong> et de la <strong>programmation (Chrono)</strong>"}, activation du <strong>Mode Auto total</strong> et passage des consignes en <strong>hors gel (7°C)</strong>. Le poêle bascule ainsi automatiquement en puissance minimale <strong>P0</strong> et ventilation <strong>Ventil 0</strong> (convection 100% silencieuse) <strong>sans s'éteindre</strong>.</p>
          ${!T.canWriteEco ? `<p class="text-amber-300/90">ℹ️ Si <strong>Comfort Clima</strong> est activé sur la télécommande physique, la consigne à 7°C déclenchera une veille thermique (<strong>ECO STOP</strong>) au lieu du ralenti continu P0, puis rallumera le poêle à la restauration.</p>` : ""}
          <p class="text-slate-400">À la fin du décompte programmé ou lors d'une modification manuelle, les consignes et réglages d'origine sont automatiquement restaurés.</p>
        </div>
      </div>
    `;
  }
  return "";
}

function renderTriArcCockpit() {
  const track = document.getElementById("triarc-carousel-track");
  const triarcCard = document.getElementById("triarc-cockpit-card");
  const altRoot = document.getElementById("cockpit-alt-root");
  if (!track && !altRoot) return;

  const caps = _getTriArcCaps();
  const ducts = Array.isArray(caps.ducts) ? caps.ducts : [];
  const hasSX = ducts.some(d => d.id === "SX");
  const hasDX = ducts.some(d => d.id === "DX");
  if (triArcZone === "SX" && !hasSX) triArcZone = "AMB";
  if (triArcZone === "DX" && !hasDX) triArcZone = "AMB";

  const T = getTriArcTelemetryState();
  const uiMode = typeof getActiveCockpitUiMode === "function" ? getActiveCockpitUiMode() : "triarc";
  if (typeof syncCockpitUiControlClasses === "function") {
    syncCockpitUiControlClasses(uiMode);
  }

  if (uiMode !== "triarc" && altRoot) {
    if (triarcCard) triarcCard.classList.add("hidden");
    ["SX", "AMB", "DX"].forEach(z => {
      const slideEl = document.getElementById(`triarc-slide-${z}`);
      if (slideEl) slideEl.innerHTML = "";
    });
    altRoot.classList.remove("hidden");
    altRoot.innerHTML = typeof renderAlternativeCockpit === "function" ? renderAlternativeCockpit(uiMode, T, caps) : "";
  } else {
    if (triarcCard) triarcCard.classList.remove("hidden");
    if (altRoot) {
      altRoot.classList.add("hidden");
      altRoot.innerHTML = "";
    }

    const targetZones = triArcDragging ? [triArcDragging.zone] : ["SX", "AMB", "DX"];

    targetZones.forEach(z => {
      const slideEl = document.getElementById(`triarc-slide-${z}`);
      if (slideEl) {
        slideEl.innerHTML = `
          <div class="shrink-0 w-full">
            ${renderTriArcTopHeader(z, T)}
          </div>
          <div class="flex-1 min-h-0 flex flex-col justify-start items-center gap-1 sm:gap-2 w-full">
            <div class="w-full flex-1 min-h-0 max-h-[300px] sm:max-h-[350px] flex items-start justify-center">
              ${renderTriArcSvgForZone(z, T)}
            </div>
            <div class="w-full shrink-0">
              ${renderTriArcDailyChronoFrise(z)}
            </div>
          </div>
          ${z === "AMB" ? `
          <div class="shrink-0 w-full pb-0.5">
            ${renderTriArcBottomModes(T, z)}
          </div>
          ` : ""}
        `;
      }
    });
  }

  const overlay = document.getElementById("triarc-floating-overlay");
  const bubble = document.getElementById("triarc-floating-bubble");
  if (overlay && bubble) {
    if (triArcExpandedMode) {
      overlay.classList.remove("hidden");
      bubble.innerHTML = renderTriArcFloatingOptionBubble(T);
    } else {
      overlay.classList.add("hidden");
      bubble.innerHTML = "";
    }
  }

  if (track && uiMode === "triarc") {
    const offset = triArcZone === "SX" ? "0%" : (triArcZone === "AMB" ? "-100%" : "-200%");
    track.style.transform = `translateX(${offset})`;
  }

  const dSx = document.getElementById("triarc-dot-sx");
  const dAmb = document.getElementById("triarc-dot-amb");
  const dDx = document.getElementById("triarc-dot-dx");
  if (dSx && dAmb && dDx) {
    dSx.classList.toggle("hidden", !hasSX);
    dDx.classList.toggle("hidden", !hasDX);
    if (hasSX) dSx.className = triArcZone === "SX" ? "w-4 h-2 rounded-full bg-cyan-400 transition-all cursor-pointer" : "w-2 h-2 rounded-full bg-slate-700 transition-all cursor-pointer";
    dAmb.className = triArcZone === "AMB" ? "w-4 h-2 rounded-full bg-orange-500 transition-all cursor-pointer" : "w-2 h-2 rounded-full bg-slate-700 transition-all cursor-pointer";
    if (hasDX) dDx.className = triArcZone === "DX" ? "w-4 h-2 rounded-full bg-sky-400 transition-all cursor-pointer" : "w-2 h-2 rounded-full bg-slate-700 transition-all cursor-pointer";
  }
}
