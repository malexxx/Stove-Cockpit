// =============================================================================
// INTERFACES ALTERNATIVES UX/UI — PROPOSITIONS 6 À 10 + DISPATCHEUR
// 6. Intentions | 7. Context HMI | 8. Spatial Flux | 9. Vernier | 10. Calm Glass
// =============================================================================

// #6 — PILOTAGE PAR INTENTIONS & SCÉNARIOS (Philips Hue / Sonos / Modèle Mental)
function renderCockpitView_intentions(T, caps) {
  const zone = getCockpitActiveZone(caps);
  const Z = getCockpitZoneValues(zone, T, caps);
  const isContainerSil = Boolean(T.isContainerSil);
  const silTimerActive = isContainerSil && T.isSilActive && T.remSec > 0;
  const silBtnActive = isContainerSil ? silTimerActive : Boolean(T.isSilActive);
  const silBadgeTxt = silTimerActive
    ? `${Math.floor(T.remSec / 3600)}h${String(Math.floor((T.remSec % 3600) / 60)).padStart(2, "0")}`
    : (silBtnActive ? "Actif" : "OFF");
  const isAutoActive = T.autoIdx > 0;
  const isBoostActive = T.pwfVal > 0;

  const intentCards = [];
  if (caps.has_auto !== false) {
    intentCards.push(`
        <button type="button" onclick="setTriArcAutoOption(${T.autoIdx === 2 ? 0 : 2})"
          class="rounded-3xl border-2 p-3.5 text-left transition cursor-pointer space-y-1 ${isAutoActive
            ? "bg-orange-950/60 border-orange-400 text-white shadow-[0_0_15px_rgba(249,115,22,0.25)]"
            : "bg-slate-900/90 border-slate-800 hover:border-cyan-500/60 text-slate-200"}">
          <div class="flex items-center justify-between">
            <span class="text-xl">✨</span>
            <span class="text-[10px] font-black uppercase px-2 py-0.5 rounded-full ${isAutoActive ? "bg-orange-600 text-white" : "bg-slate-800 text-slate-400"}">${T.autoIdx === 2 ? "Auto" : (T.autoIdx === 1 ? "Ventil" : "OFF")}</span>
          </div>
          <div class="text-xs font-extrabold">Confort Auto</div>
          <div class="text-[11px] text-slate-400 leading-tight">Le poêle dose flamme et air tout seul.</div>
        </button>
    `);
  }
  if (caps.has_boost !== false) {
    intentCards.push(`
        <button type="button" onclick="toggleTriArcOptionBubble('boost')"
          class="rounded-3xl border-2 p-3.5 text-left transition cursor-pointer space-y-1 ${isBoostActive
            ? "bg-rose-950/60 border-rose-400 text-white shadow-[0_0_15px_rgba(244,63,94,0.25)]"
            : "bg-slate-900/90 border-slate-800 hover:border-rose-500/60 text-slate-200"}">
          <div class="flex items-center justify-between">
            <span class="text-xl">🚀</span>
            <span class="text-[10px] font-black uppercase px-2 py-0.5 rounded-full ${isBoostActive ? "bg-rose-600 text-white" : "bg-slate-800 text-slate-400"}">${T.pwfVal === 1 ? "Actif" : (T.pwfVal === 2 ? "Prog" : "OFF")}</span>
          </div>
          <div class="text-xs font-extrabold">Coup de chaud</div>
          <div class="text-[11px] text-slate-400 leading-tight">Chauffe maximale temporaire (Powerful).</div>
        </button>
    `);
  }
  const silenceSpanCls = intentCards.length === 2 ? "col-span-2 " : "";
  intentCards.push(`
        <button type="button" onclick="toggleTriArcOptionBubble('silence')"
          class="${silenceSpanCls}rounded-3xl border-2 p-3.5 text-left transition cursor-pointer space-y-1 ${silBtnActive
            ? "bg-purple-950/65 border-purple-400 text-white shadow-[0_0_15px_rgba(168,85,247,0.25)]"
            : "bg-slate-900/90 border-slate-800 hover:border-purple-500/60 text-slate-200"}">
          <div class="flex items-center justify-between">
            <span class="text-xl">🤫</span>
            <span ${silTimerActive ? 'id="triarc-silence-btn-timer"' : ""} class="text-[10px] font-black uppercase px-2 py-0.5 rounded-full tabular-nums ${silBtnActive ? "bg-purple-600 text-white" : "bg-slate-800 text-slate-400"}">${silBadgeTxt}</span>
          </div>
          <div class="text-xs font-extrabold">Soirée calme</div>
          <div class="text-[11px] text-slate-400 leading-tight">${isContainerSil ? "Convection douce minutée." : "Ralenti silencieux immédiat."}</div>
        </button>
  `);

  return `
    <div class="space-y-2.5">
      <div class="rounded-3xl bg-slate-900/90 border border-slate-800 p-4 space-y-3 shadow-lg">
        <div class="flex items-center justify-between gap-2">
          ${renderCockpitPhasePill(T)}
          ${renderCockpitPowerBtn(T, "h-11 w-11 rounded-2xl")}
        </div>

        ${renderCockpitZoneTabs(zone, T, caps)}

        <div class="flex items-center justify-between gap-2 pt-1">
          <div>
            <div class="text-xs font-bold text-slate-400">Température souhaitée (${escapeHtml(Z.label)})</div>
            <div class="flex items-baseline gap-2">
              <span class="text-4xl font-black text-white tabular-nums">${Z.realT}°</span>
              <span class="text-sm font-extrabold text-orange-300">→ ${fmtTriArcTempSp(Z.spT)}</span>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <button type="button" onclick="cockpitStepTemp('${zone}', -1)" class="w-12 h-12 rounded-2xl bg-slate-800 hover:bg-slate-700 text-white font-black text-xl border border-slate-700 cursor-pointer">−</button>
            <button type="button" onclick="cockpitStepTemp('${zone}', 1)" class="w-12 h-12 rounded-2xl bg-orange-600 hover:bg-orange-500 text-white font-black text-xl border border-orange-400 cursor-pointer">+</button>
          </div>
        </div>
      </div>

      <!-- Grille d'intentions humaines -->
      <div class="grid grid-cols-2 gap-2.5">
        ${intentCards.join("")}
      </div>

      <button type="button" onclick="cockpitOpenSheet('manual')"
        class="w-full py-2.5 px-3 rounded-2xl bg-slate-900/90 hover:bg-slate-800 border border-slate-800 text-xs font-bold text-slate-300 flex items-center justify-between cursor-pointer">
        <span>⚙️ Réglage manuel avancé</span>
        <span class="font-mono text-orange-300">P${Math.round(T.pwrSp)} · 🌀 ${fmtTriArcFan(Z.fanSp)} ▸</span>
      </button>

      ${renderTriArcDailyChronoFrise(zone)}
      ${renderCockpitPendingBar()}
      ${renderCockpitBottomSheet(T, zone, caps)}
    </div>
  `;
}

// #7 — INTERFACE CONTEXTUELLE PILOTÉE PAR L'ÉTAT (Automotive HMI Tesla / Rivian)
function renderCockpitView_context_hmi(T, caps) {
  const zone = getCockpitActiveZone(caps);
  const Z = getCockpitZoneValues(zone, T, caps);
  const isIgnition = T.st >= 1 && T.st <= 4;
  const isCooling = T.st === 7;
  const isOff = T.st === 0;
  const isAutoFull = T.autoIdx === 2 && !isOff && !T.isAlarm;
  const isFanAuto = (zone === "AMB") && (T.autoIdx === 1 || T.autoIdx === 2 || Z.fanSp === 8);

  let contextCardHtml = "";

  if (T.isAlarm) {
    const alarmLabel = escapeHtml(latestData?.alarm_label || T.phaseLabel || "Alarme active");
    contextCardHtml = `
      <div class="rounded-3xl bg-rose-950/70 border-2 border-rose-500 p-4 space-y-3 shadow-[0_0_24px_rgba(244,63,94,0.3)]">
        <div class="flex items-center justify-between gap-2">
          <span class="text-sm font-black text-rose-200">🚨 Sécurité Active</span>
          <span class="text-xs font-mono font-bold text-white">${T.realAmb}°</span>
        </div>
        <div class="text-xs text-rose-100 bg-black/30 rounded-2xl p-3 border border-rose-500/40">${alarmLabel}</div>
        <button type="button" onclick="handleDynamicPowerAction()"
          class="w-full py-3 rounded-2xl bg-rose-600 hover:bg-rose-500 text-white font-extrabold text-sm shadow cursor-pointer">
          🛡️ Procédure &amp; Acquittement
        </button>
      </div>
    `;
  } else if (isOff) {
    contextCardHtml = `
      <div class="rounded-3xl bg-slate-900/90 border border-slate-800 p-5 text-center space-y-4">
        <div class="flex items-center justify-between">
          ${renderCockpitPhasePill(T)}
          <span class="text-xs font-mono text-slate-400">Ambiance ${T.realAmb}°</span>
        </div>
        <button type="button" onclick="handleDynamicPowerAction()"
          class="w-full py-4 rounded-3xl bg-gradient-to-r from-orange-600 to-amber-600 hover:from-orange-500 hover:to-amber-500 text-white font-black text-base shadow-[0_0_24px_rgba(234,88,12,0.45)] flex items-center justify-center gap-2 cursor-pointer">
          <span>🔥</span><span>Allumer le poêle</span>
        </button>
        <div class="flex items-center justify-between bg-slate-950/80 border border-slate-800 rounded-2xl px-3.5 py-2.5">
          <span class="text-xs text-slate-300 font-bold">Pré-régler consigne</span>
          <div class="flex items-center gap-2">
            <button type="button" onclick="cockpitStepTemp('AMB', -1)" class="w-9 h-9 rounded-xl bg-slate-800 text-white font-black cursor-pointer">−</button>
            <span class="font-mono font-black text-orange-300 w-10 text-center">${fmtTriArcTempSp(T.spAmb)}</span>
            <button type="button" onclick="cockpitStepTemp('AMB', 1)" class="w-9 h-9 rounded-xl bg-slate-800 text-white font-black cursor-pointer">+</button>
          </div>
        </div>
      </div>
    `;
  } else if (isIgnition || isCooling) {
    const steps = isIgnition
      ? [{ c: 1, l: "Check" }, { c: 2, l: "Bougie" }, { c: 3, l: "Pellet" }, { c: 4, l: "Flamme" }]
      : [{ c: 7, l: "Refroidissement" }, { c: 0, l: "Arrêt" }];
    contextCardHtml = `
      <div class="rounded-3xl bg-slate-900/90 border border-amber-500/50 p-4 space-y-3.5">
        <div class="flex items-center justify-between gap-2">
          ${renderCockpitPhasePill(T)}
          ${renderCockpitPowerBtn(T, "h-11 w-11 rounded-2xl")}
        </div>
        <div class="grid gap-1.5" style="grid-template-columns: repeat(${steps.length}, minmax(0, 1fr));">
          ${steps.map(s => {
            const active = s.c === T.st;
            const passed = isIgnition && s.c < T.st;
            return `
              <div class="rounded-xl px-2 py-2 text-center border text-[11px] font-bold ${active
                ? "bg-orange-600/30 border-orange-400 text-white"
                : (passed ? "bg-emerald-950/50 border-emerald-600/50 text-emerald-300" : "bg-slate-950 border-slate-800 text-slate-500")}">
                ${passed ? "✓ " : ""}${s.l}
              </div>
            `;
          }).join("")}
        </div>
        <div class="flex items-center justify-between bg-slate-950/80 border border-slate-800 rounded-2xl px-3.5 py-2.5">
          <div>
            <div class="text-[11px] text-slate-400">Température · Cible</div>
            <div class="text-xl font-black text-white">${Z.realT}° <span class="text-orange-300 text-sm">→ ${fmtTriArcTempSp(Z.spT)}</span></div>
          </div>
          <div class="flex items-center gap-1.5">
            <button type="button" onclick="cockpitStepTemp('${zone}', -1)" class="w-10 h-10 rounded-xl bg-slate-800 text-white font-black cursor-pointer">−</button>
            <button type="button" onclick="cockpitStepTemp('${zone}', 1)" class="w-10 h-10 rounded-xl bg-orange-600 text-white font-black cursor-pointer">+</button>
          </div>
        </div>
      </div>
    `;
  } else if (isAutoFull) {
    contextCardHtml = `
      <div class="rounded-3xl bg-slate-900/90 border border-orange-500/50 p-4 space-y-3">
        <div class="flex items-center justify-between gap-2">
          ${renderCockpitPhasePill(T)}
          ${renderCockpitPowerBtn(T, "h-11 w-11 rounded-2xl")}
        </div>
        ${renderCockpitZoneTabs(zone, T, caps)}
        <div class="flex items-center justify-between py-1">
          <div>
            <div class="text-[11px] text-orange-300 font-bold uppercase">Régulation Auto Active</div>
            <div class="text-4xl font-black text-white tabular-nums">${Z.realT}° <span class="text-base text-orange-300">→ ${fmtTriArcTempSp(Z.spT)}</span></div>
          </div>
          <div class="flex items-center gap-1.5">
            <button type="button" onclick="cockpitStepTemp('${zone}', -1)" class="w-11 h-11 rounded-2xl bg-slate-800 text-white font-black text-xl cursor-pointer">−</button>
            <button type="button" onclick="cockpitStepTemp('${zone}', 1)" class="w-11 h-11 rounded-2xl bg-orange-600 text-white font-black text-xl cursor-pointer">+</button>
          </div>
        </div>
        <div class="flex items-center justify-between rounded-2xl bg-slate-950/85 border border-slate-800 px-3 py-2 text-xs">
          <span class="font-mono text-slate-300">🔥 Flamme P${Math.round(T.realPwr)} · 🌀 Air ${fmtTriArcFan(Z.fanReal)}</span>
          <button type="button" onclick="setTriArcAutoOption(0)" class="px-2.5 py-1 rounded-xl bg-slate-800 hover:bg-slate-700 text-orange-200 font-bold cursor-pointer">Prendre la main</button>
        </div>
      </div>
    `;
  } else {
    contextCardHtml = `
      <div class="rounded-3xl bg-slate-900/90 border border-slate-800 p-4 space-y-3">
        <div class="flex items-center justify-between gap-2">
          ${renderCockpitPhasePill(T)}
          ${renderCockpitPowerBtn(T, "h-11 w-11 rounded-2xl")}
        </div>
        ${renderCockpitManualPanel(T, zone, caps)}
      </div>
    `;
  }

  return `
    <div class="space-y-2.5">
      ${contextCardHtml}
      ${renderCockpitModeBar(T, zone, true)}
      ${renderTriArcDailyChronoFrise(zone)}
      ${renderCockpitPendingBar()}
    </div>
  `;
}

// #8 — VUE SPATIALE & FLUX D'AIR (Daikin Onecta / Natural Mapping Don Norman)
function renderCockpitView_spatial_flow(T, caps) {
  const zone = getCockpitActiveZone(caps);
  const Z = getCockpitZoneValues(zone, T, caps);
  const ducts = Array.isArray(caps.ducts) ? caps.ducts : [];
  const hasSX = ducts.some(d => d.id === "SX");
  const hasDX = ducts.some(d => d.id === "DX");
  const isFanAuto = (zone === "AMB") && (T.autoIdx === 1 || T.autoIdx === 2 || Z.fanSp === 8);
  const isAutoTotal = T.autoIdx === 2;
  const sxFlowActive = T.st !== 0 && T.realFanSx > 0;
  const dxFlowActive = T.st !== 0 && T.realFanDx > 0;

  return `
    <div class="space-y-2.5">
      <div class="flex items-center justify-between gap-2">
        ${renderCockpitPhasePill(T)}
        ${renderCockpitPowerBtn(T, "h-11 w-11 rounded-2xl")}
      </div>

      <!-- Schéma spatial flux d'air -->
      <div class="rounded-3xl bg-slate-900/90 border border-slate-800 p-3 space-y-2">
        <div class="relative flex items-center justify-center gap-2">
          ${hasSX ? `
            <button type="button" onclick="cockpitSelectZone('SX')"
              class="flex-1 rounded-2xl border-2 p-2.5 text-center transition cursor-pointer ${zone === "SX"
                ? "bg-cyan-950/60 border-cyan-400 shadow-[0_0_16px_rgba(34,211,238,0.25)]"
                : "bg-slate-950/85 border-slate-800 hover:border-cyan-600/60"}">
              <div class="text-[10px] font-extrabold text-cyan-300 truncate">${escapeHtml(getDuctName("SX"))}</div>
              <div class="text-lg font-black text-white tabular-nums">${T.realSx}°</div>
              <div class="text-[10px] font-mono text-cyan-200">→ ${fmtTriArcTempSp(T.spSx)} · V${fmtTriArcFan(T.fanSx)}</div>
            </button>
            <svg viewBox="0 0 28 16" class="w-6 h-4 shrink-0">
              <line x1="26" y1="8" x2="4" y2="8" stroke="${sxFlowActive ? "#22d3ee" : "#334155"}" stroke-width="2.2" class="${sxFlowActive ? "cockpit-flow-dash" : ""}" />
              <polygon points="2,8 7,5 7,11" fill="${sxFlowActive ? "#22d3ee" : "#334155"}" />
            </svg>
          ` : ""}

          <button type="button" onclick="cockpitSelectZone('AMB')"
            class="flex-1 max-w-[155px] rounded-2xl border-2 p-2.5 text-center transition cursor-pointer ${zone === "AMB"
              ? "bg-orange-950/55 border-orange-400 shadow-[0_0_16px_rgba(249,115,22,0.28)]"
              : "bg-slate-950/85 border-slate-800 hover:border-orange-500/60"}">
            <div class="flex items-center justify-center gap-1 text-[10px] font-extrabold text-orange-300">
              ${svgNobisStoveIcon("w-3.5 h-3.5", T.phaseColor)}
              <span>${caps.stove_type === "hydro" ? "Chaudière" : "Poêle"}</span>
            </div>
            <div class="text-2xl font-black text-white tabular-nums">${T.realAmb}°</div>
            <div class="text-[10px] font-mono text-orange-200">→ ${fmtTriArcTempSp(T.spAmb)} · P${Math.round(T.realPwr)}</div>
          </button>

          ${hasDX ? `
            <svg viewBox="0 0 28 16" class="w-6 h-4 shrink-0">
              <line x1="2" y1="8" x2="24" y2="8" stroke="${dxFlowActive ? "#38bdf8" : "#334155"}" stroke-width="2.2" class="${dxFlowActive ? "cockpit-flow-dash" : ""}" />
              <polygon points="26,8 21,5 21,11" fill="${dxFlowActive ? "#38bdf8" : "#334155"}" />
            </svg>
            <button type="button" onclick="cockpitSelectZone('DX')"
              class="flex-1 rounded-2xl border-2 p-2.5 text-center transition cursor-pointer ${zone === "DX"
                ? "bg-sky-950/60 border-sky-400 shadow-[0_0_16px_rgba(56,189,248,0.25)]"
                : "bg-slate-950/85 border-slate-800 hover:border-sky-600/60"}">
              <div class="text-[10px] font-extrabold text-sky-300 truncate">${escapeHtml(getDuctName("DX"))}</div>
              <div class="text-lg font-black text-white tabular-nums">${T.realDx}°</div>
              <div class="text-[10px] font-mono text-sky-200">→ ${fmtTriArcTempSp(T.spDx)} · V${fmtTriArcFan(T.fanDx)}</div>
            </button>
          ` : ""}
        </div>
      </div>

      <!-- Éditeur unique de la zone sélectionnée -->
      <div class="rounded-3xl bg-slate-900/90 border border-slate-800 p-3.5 space-y-3">
        <div class="flex items-center justify-between">
          <div>
            <div class="text-[11px] font-bold text-slate-400">Zone active : <span class="text-white">${escapeHtml(Z.label)}</span></div>
            <div class="text-xl font-black text-white tabular-nums">${Z.realT}° <span class="text-orange-300 text-sm">→ ${fmtTriArcTempSp(Z.spT)}</span></div>
          </div>
          <div class="flex items-center gap-2">
            <button type="button" onclick="cockpitStepTemp('${zone}', -1)" class="w-11 h-11 rounded-2xl bg-slate-800 text-white font-black text-xl cursor-pointer">−</button>
            <button type="button" onclick="cockpitStepTemp('${zone}', 1)" class="w-11 h-11 rounded-2xl bg-orange-600 text-white font-black text-xl cursor-pointer">+</button>
          </div>
        </div>
        ${Z.showFan ? renderCockpitSegmentedFan(zone, Z.fanSp, Z.fanReal, caps, isFanAuto) : ""}
        ${Z.showPwr ? renderCockpitSegmentedPower(T.pwrSp, T.realPwr, caps, isAutoTotal) : ""}
      </div>

      ${renderCockpitModeBar(T, zone, true)}
      ${renderTriArcDailyChronoFrise(zone)}
      ${renderCockpitPendingBar()}
    </div>
  `;
}

// #9 — RÈGLE GRADUÉE HAPTIQUE « VERNIER » (Dieter Rams / Braun / Molette iOS)
function renderCockpitView_vernier(T, caps) {
  const zone = getCockpitActiveZone(caps);
  const Z = getCockpitZoneValues(zone, T, caps);
  const tMin = Number(caps.temp_min ?? 7);
  const tMax = Number(caps.temp_max ?? 41);
  const fanMax = Math.max(1, Number(caps.fan_max ?? 8));
  const pMin = Math.max(1, Number(caps.power_min ?? 1));
  const pMax = Math.max(pMin, Number(caps.power_max ?? 7));

  let axis = cockpitAltState.vernierAxis || "temp";
  if (axis === "fan" && !Z.showFan) axis = "temp";
  if (axis === "pwr" && !Z.showPwr) axis = "temp";
  cockpitAltState.vernierAxis = axis;

  let curVal = Math.round(Z.spT);
  let minVal = tMin;
  let maxVal = tMax;
  let displayVal = fmtTriArcTempSp(Z.spT);
  let subInfo = `Mesuré ${Z.realT}°`;
  let lockedMsg = "";
  let stepFnNeg = `cockpitStepTemp('${zone}', -1)`;
  let stepFnPos = `cockpitStepTemp('${zone}', 1)`;

  if (axis === "fan") {
    curVal = Math.round(Z.fanSp);
    minVal = 0;
    maxVal = fanMax;
    displayVal = fmtTriArcFan(Z.fanSp);
    subInfo = `Ventilation réelle : ${fmtTriArcFan(Z.fanReal)}`;
    if (zone === "AMB" && (T.autoIdx === 1 || T.autoIdx === 2 || Z.fanSp === 8)) {
      lockedMsg = "Verrouillé par le mode Auto";
    }
    stepFnNeg = `cockpitStepFan('${zone}', -1)`;
    stepFnPos = `cockpitStepFan('${zone}', 1)`;
  } else if (axis === "pwr") {
    curVal = Math.round(T.pwrSp);
    minVal = pMin;
    maxVal = pMax;
    displayVal = `P${curVal}`;
    subInfo = `Puissance réelle : P${Math.round(T.realPwr)}`;
    if (T.autoIdx === 2) lockedMsg = "Verrouillé par Auto Total";
    stepFnNeg = "cockpitStepPower(-1)";
    stepFnPos = "cockpitStepPower(1)";
  }

  const ticks = [];
  for (let d = -4; d <= 4; d++) {
    const v = curVal + d;
    const inRange = v >= minVal && v <= maxVal;
    const isCenter = d === 0;
    const lbl = !inRange ? "" : (axis === "temp" ? `${v}°` : (axis === "fan" ? fmtTriArcFan(v) : `P${v}`));
    ticks.push(`
      <div class="flex flex-col items-center justify-end w-9 shrink-0">
        <div class="${isCenter ? "h-6 w-0.5 bg-orange-400" : (d % 2 === 0 ? "h-4 w-px bg-slate-400" : "h-2.5 w-px bg-slate-600")} rounded-full"></div>
        <span class="text-[10px] font-mono mt-1 ${isCenter ? "text-orange-300 font-black" : "text-slate-500"}">${lbl}</span>
      </div>
    `);
  }

  return `
    <div class="space-y-2.5">
      <div class="flex items-center justify-between gap-2">
        ${renderCockpitPhasePill(T)}
        ${renderCockpitPowerBtn(T, "h-11 w-11 rounded-2xl")}
      </div>

      ${renderCockpitZoneTabs(zone, T, caps)}

      <div class="rounded-3xl bg-slate-900/95 border border-slate-800 p-4 space-y-3 text-center shadow-xl">
        <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400">${escapeHtml(Z.label)} · ${subInfo}</div>
        <div class="text-5xl font-black font-mono text-white tabular-nums">${displayVal}</div>

        ${lockedMsg ? `
          <div class="py-3 px-4 rounded-2xl bg-slate-950 border border-slate-800 text-xs text-cyan-300 font-bold flex items-center justify-center gap-2">
            <span>${lockedMsg}</span>
            <button type="button" onclick="setTriArcAutoOption(0)" class="px-2 py-1 rounded-lg bg-slate-800 text-white text-[11px] cursor-pointer">Manuel</button>
          </div>
        ` : `
          <div class="flex items-center gap-2">
            <button type="button" onclick="${stepFnNeg}" class="w-11 h-14 rounded-2xl bg-slate-800 hover:bg-slate-700 text-white font-black text-lg shrink-0 cursor-pointer">◀</button>
            <div data-vernier-track="1" data-zone="${zone}" data-vernier-axis="${axis}" data-current="${curVal}" data-min="${minVal}" data-max="${maxVal}"
              class="cockpit-vernier-track relative flex-1 h-14 rounded-2xl bg-slate-950 border border-slate-800 flex items-center justify-center overflow-hidden">
              <div class="flex items-end justify-center pointer-events-none">${ticks.join("")}</div>
              <div class="absolute inset-y-1 left-1/2 -translate-x-1/2 w-0.5 bg-orange-500/40 pointer-events-none"></div>
            </div>
            <button type="button" onclick="${stepFnPos}" class="w-11 h-14 rounded-2xl bg-slate-800 hover:bg-slate-700 text-white font-black text-lg shrink-0 cursor-pointer">▶</button>
          </div>
          <div class="text-[10px] text-slate-500">Glisser horizontalement sur la règle ou utiliser ◀ / ▶</div>
        `}

        <!-- Sélecteur d'axe -->
        <div class="flex items-center gap-1.5 bg-slate-950 p-1 rounded-2xl border border-slate-800">
          <button type="button" onclick="cockpitSetVernierAxis('temp')"
            class="flex-1 py-2 rounded-xl text-xs font-extrabold cursor-pointer ${axis === "temp" ? "bg-orange-600 text-white" : "text-slate-400 hover:text-white"}">
            🌡️ ${fmtTriArcTempSp(Z.spT)}
          </button>
          ${Z.showFan ? `
          <button type="button" onclick="cockpitSetVernierAxis('fan')"
            class="flex-1 py-2 rounded-xl text-xs font-extrabold cursor-pointer ${axis === "fan" ? "bg-sky-600 text-white" : "text-slate-400 hover:text-white"}">
            🌀 ${fmtTriArcFan(Z.fanSp)}
          </button>
          ` : ""}
          ${Z.showPwr ? `
          <button type="button" onclick="cockpitSetVernierAxis('pwr')"
            class="flex-1 py-2 rounded-xl text-xs font-extrabold cursor-pointer ${axis === "pwr" ? "bg-amber-600 text-white" : "text-slate-400 hover:text-white"}">
            🔥 P${Math.round(T.pwrSp)}
          </button>
          ` : ""}
        </div>
      </div>

      ${renderCockpitModeBar(T, zone, true)}
      ${renderTriArcDailyChronoFrise(zone)}
      ${renderCockpitPendingBar()}
    </div>
  `;
}

// #10 — AMBIENT CALM GLASS + DOCK FLOTTANT & BOTTOM SHEETS (Apple Météo / Liquid Glass)
function renderCockpitView_ambient_glass(T, caps) {
  const zone = getCockpitActiveZone(caps);
  const Z = getCockpitZoneValues(zone, T, caps);
  const ducts = Array.isArray(caps.ducts) ? caps.ducts : [];
  const hasSX = ducts.some(d => d.id === "SX");
  const hasDX = ducts.some(d => d.id === "DX");

  const silTimerActive = Boolean(T.isContainerSil) && T.isSilActive && T.remSec > 0;
  let haloColor = T.phaseColor || "#ea580c";
  if (T.isSilActive) haloColor = "#a855f7";
  else if (T.pwfVal === 1) haloColor = "#e11d48";
  else if (T.st === 0) haloColor = "#38bdf8";

  return `
    <div class="relative rounded-3xl overflow-hidden border border-white/10 bg-slate-950/80 p-4 space-y-4 shadow-2xl">
      <!-- Halo ambiant -->
      <div class="cockpit-ambient-halo pointer-events-none absolute -top-16 left-1/2 -translate-x-1/2 w-72 h-72 rounded-full blur-3xl"
        style="background: radial-gradient(circle, ${haloColor}55 0%, transparent 70%);"></div>

      <div class="relative z-10 flex items-center justify-between gap-2">
        ${renderCockpitPhasePill(T, true)}
        <span class="text-xs font-mono font-bold text-slate-300 bg-white/5 border border-white/10 px-2.5 py-1 rounded-full">
          🔥 P${Math.round(T.realPwr)}${Z.showFan ? ` · 🌀 ${fmtTriArcFan(Z.fanReal)}` : ""}
        </span>
      </div>

      <div class="relative z-10 py-3 text-center space-y-3">
        <div class="text-xs font-bold uppercase tracking-widest text-slate-300">${escapeHtml(Z.label)}</div>
        <div class="text-6xl font-black text-white tabular-nums tracking-tight drop-shadow">${Z.realT}°</div>

        <div class="inline-flex items-center gap-3 rounded-full bg-white/10 backdrop-blur-md border border-white/15 px-2.5 py-1.5">
          <button type="button" onclick="cockpitStepTemp('${zone}', -1)" class="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white font-black text-xl cursor-pointer">−</button>
          <span class="min-w-[54px] text-lg font-black text-orange-200 font-mono">${fmtTriArcTempSp(Z.spT)}</span>
          <button type="button" onclick="cockpitStepTemp('${zone}', 1)" class="w-10 h-10 rounded-full bg-orange-500/80 hover:bg-orange-500 text-white font-black text-xl cursor-pointer">+</button>
        </div>

        ${(hasSX || hasDX) ? `
          <div class="flex items-center justify-center gap-2 pt-1">
            <button type="button" onclick="cockpitSelectZone('AMB')"
              class="px-3 py-1 rounded-full text-[11px] font-bold border cursor-pointer ${zone === "AMB" ? "bg-white/20 border-white/40 text-white" : "bg-white/5 border-white/10 text-slate-300"}">
              Salon ${T.realAmb}°
            </button>
            ${hasSX ? `
              <button type="button" onclick="cockpitSelectZone('SX')"
                class="px-3 py-1 rounded-full text-[11px] font-bold border cursor-pointer ${zone === "SX" ? "bg-cyan-500/30 border-cyan-300/60 text-white" : "bg-white/5 border-white/10 text-slate-300"}">
                ${escapeHtml(getDuctName("SX"))} ${T.realSx}°
              </button>
            ` : ""}
            ${hasDX ? `
              <button type="button" onclick="cockpitSelectZone('DX')"
                class="px-3 py-1 rounded-full text-[11px] font-bold border cursor-pointer ${zone === "DX" ? "bg-sky-500/30 border-sky-300/60 text-white" : "bg-white/5 border-white/10 text-slate-300"}">
                ${escapeHtml(getDuctName("DX"))} ${T.realDx}°
              </button>
            ` : ""}
          </div>
        ` : ""}
      </div>

      <div class="relative z-10">
        ${renderTriArcDailyChronoFrise(zone)}
      </div>

      <!-- Dock Flottant Glass -->
      <div class="relative z-10 flex items-center justify-between gap-2 rounded-full bg-slate-900/85 backdrop-blur-xl border border-white/15 p-1.5 shadow-2xl">
        ${renderCockpitPowerBtn(T, "h-11 w-14 rounded-full")}
        <button type="button" onclick="cockpitOpenSheet('modes')"
          class="flex-1 h-11 rounded-full bg-white/5 hover:bg-white/10 text-xs font-extrabold text-white flex items-center justify-center gap-1.5 cursor-pointer">
          <span>✨</span><span>Modes${silTimerActive ? ` (<span id="triarc-silence-btn-timer">${Math.floor(T.remSec / 3600)}h${String(Math.floor((T.remSec % 3600) / 60)).padStart(2, "0")}</span>)` : (T.isSilActive ? " (🤫)" : "")}</span>
        </button>
        <button type="button" onclick="cockpitOpenSheet('manual')"
          class="flex-1 h-11 rounded-full bg-white/5 hover:bg-white/10 text-xs font-extrabold text-slate-200 flex items-center justify-center gap-1.5 cursor-pointer">
          <span>🎚</span><span>Réglages</span>
        </button>
      </div>

      ${renderCockpitPendingBar()}
      ${renderCockpitBottomSheet(T, zone, caps)}
    </div>
  `;
}

function renderAlternativeCockpit(modeId, T, caps) {
  const renderers = {
    thermostat: renderCockpitView_thermostat,
    bento: renderCockpitView_bento,
    faders: renderCockpitView_faders,
    thumb_zone: renderCockpitView_thumb_zone,
    cards_accordion: renderCockpitView_cards_accordion,
    intentions: renderCockpitView_intentions,
    context_hmi: renderCockpitView_context_hmi,
    spatial_flow: renderCockpitView_spatial_flow,
    vernier: renderCockpitView_vernier,
    ambient_glass: renderCockpitView_ambient_glass,
  };
  const fn = renderers[modeId] || renderCockpitView_thermostat;
  return fn(T, caps);
}
