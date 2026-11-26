// =============================================================================
// INTERFACES ALTERNATIVES UX/UI — PROPOSITIONS 1 À 5
// 1. Thermostat + Segmentés | 2. Bento Grid | 3. Faders | 4. Thumb-Zone | 5. Cartes
// =============================================================================

// #1 — THERMOSTAT MONO-CADRAN ÉPURÉ + BARRES SEGMENTÉES (Nest / Ecobee / Loi de Hick)
function renderCockpitView_thermostat(T, caps) {
  const zone = getCockpitActiveZone(caps);
  const Z = getCockpitZoneValues(zone, T, caps);
  const tMin = Number(caps.temp_min ?? 7);
  const tMax = Number(caps.temp_max ?? 41);
  const angSp = triArcTempToAngle(Z.spT);
  const angReal = triArcTempToAngle(Z.realT);
  const posSp = triArcPtOnCircle(110, 96, 74, angSp);
  const posReal = triArcPtOnCircle(110, 96, 74, angReal);
  const track = triArcPath(110, 96, 74, 135, 405, false);
  const fill = triArcPath(110, 96, 74, 135, angSp, false);
  const isFanAuto = (zone === "AMB") && (T.autoIdx === 1 || T.autoIdx === 2 || Z.fanSp === 8);
  const isPwrAuto = Number(T.autoPwr) === 1;

  return `
    <div class="space-y-2.5">
      ${renderCockpitZoneTabs(zone, T, caps)}

      <div class="rounded-3xl bg-slate-900/90 border border-slate-800 p-3.5 shadow-xl space-y-2.5">
        <div class="flex items-center justify-between gap-2">
          ${renderCockpitPhasePill(T)}
          ${renderCockpitPowerBtn(T, "h-11 w-11 rounded-2xl")}
        </div>

        <div class="relative flex flex-col items-center">
          <svg viewBox="20 12 180 156" class="w-56 max-w-full mx-auto overflow-visible">
            <defs>
              <linearGradient id="nestGrad-${zone}" x1="0%" y1="100%" x2="100%" y2="0%">
                <stop offset="0%" stop-color="#38bdf8" />
                <stop offset="50%" stop-color="#f59e0b" />
                <stop offset="100%" stop-color="#e11d48" />
              </linearGradient>
            </defs>
            <circle cx="110" cy="96" r="64" fill="#0b101d" stroke="#1e293b" stroke-width="1" />
            <path d="${track}" fill="none" stroke="#1e293b" stroke-width="10" stroke-linecap="round" />
            ${fill ? `<path d="${fill}" fill="none" stroke="url(#nestGrad-${zone})" stroke-width="10" stroke-linecap="round" />` : ""}
            <circle cx="${posReal.x.toFixed(1)}" cy="${posReal.y.toFixed(1)}" r="5" fill="#090d16" stroke="#38bdf8" stroke-width="2.2" />
            <circle cx="${posSp.x.toFixed(1)}" cy="${posSp.y.toFixed(1)}" r="7.5" fill="#0f172a" stroke="#f97316" stroke-width="2.5" />
            <text x="110" y="72" text-anchor="middle" font-size="9" font-weight="800" fill="#94a3b8">${escapeHtml(Z.label.toUpperCase())}</text>
            <text x="110" y="108" text-anchor="middle" font-size="34" font-weight="900" fill="#ffffff">${Z.realT}°</text>
            <text x="110" y="128" text-anchor="middle" font-size="11.5" font-weight="800" fill="#fb923c">Consigne ${fmtTriArcTempSp(Z.spT)}</text>
          </svg>

          <div class="flex items-center justify-center gap-2.5 w-full max-w-[300px] -mt-1">
            ${caps.stove_type !== "hydro" ? `<button type="button" onclick="cockpitSetTemp('${zone}', ${tMin})" title="Hors-gel (${tMin}°C)" class="px-2.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sky-300 text-xs font-bold cursor-pointer">❄️</button>` : ""}
            <button type="button" onclick="cockpitStepTemp('${zone}', -1)" class="w-12 h-11 rounded-2xl bg-slate-800 hover:bg-slate-700 active:scale-95 text-white font-black text-xl border border-slate-700 cursor-pointer">−</button>
            <div class="min-w-[68px] text-center font-mono text-lg font-black text-orange-300 tabular-nums">${fmtTriArcTempSp(Z.spT)}</div>
            <button type="button" onclick="cockpitStepTemp('${zone}', 1)" class="w-12 h-11 rounded-2xl bg-orange-600 hover:bg-orange-500 active:scale-95 text-white font-black text-xl border border-orange-400 cursor-pointer">+</button>
            ${caps.stove_type !== "hydro" ? `<button type="button" onclick="cockpitSetTemp('${zone}', ${tMax})" title="MAX" class="px-2.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-rose-300 text-[10px] font-black cursor-pointer">MAX</button>` : ""}
          </div>
        </div>
      </div>

      ${(Z.showFan || Z.showPwr) ? `
      <div class="rounded-2xl bg-slate-900/90 border border-slate-800 p-3 space-y-2.5">
        ${Z.showFan ? renderCockpitSegmentedFan(zone, Z.fanSp, Z.fanReal, caps, isFanAuto, isPwrAuto) : ""}
        ${Z.showPwr ? renderCockpitSegmentedPower(T.pwrSp, T.realPwr, caps, isPwrAuto, isFanAuto) : ""}
      </div>
      ` : ""}

      ${renderCockpitModeBar(T, zone, true)}
      ${renderTriArcDailyChronoFrise(zone)}
      ${renderCockpitPendingBar()}
    </div>
  `;
}

// #2 — BENTO GRID MODULAIRE (Apple Widgets / Linear / Gestalt)
function renderCockpitView_bento(T, caps) {
  const zone = getCockpitActiveZone(caps);
  const Z = getCockpitZoneValues(zone, T, caps);
  const tMin = Number(caps.temp_min ?? 7);
  const tMax = Number(caps.temp_max ?? 41);
  const pctTemp = Math.max(0, Math.min(100, ((Number(Z.spT) - tMin) / Math.max(1, tMax - tMin)) * 100));
  const pctReal = Math.max(0, Math.min(100, ((Number(Z.realT) - tMin) / Math.max(1, tMax - tMin)) * 100));
  const ducts = Array.isArray(caps.ducts) ? caps.ducts : [];
  const hasSX = ducts.some(d => d.id === "SX");
  const hasDX = ducts.some(d => d.id === "DX");
  const isFanAuto = (zone === "AMB") && (T.autoIdx === 1 || T.autoIdx === 2 || Z.fanSp === 8);
  const isPwrAuto = Number(T.autoPwr) === 1;

  return `
    <div class="space-y-2.5">
      ${renderCockpitZoneTabs(zone, T, caps)}

      <div class="grid grid-cols-3 gap-2">
        <!-- Tuile Héro 2x1 Température -->
        <div class="col-span-2 rounded-3xl bg-gradient-to-br from-slate-900 to-slate-950 border border-slate-800 p-3.5 flex flex-col justify-between gap-2 shadow-lg">
          <div class="flex items-center justify-between gap-1">
            ${renderCockpitPhasePill(T, true)}
            <span class="text-[10px] font-bold uppercase tracking-wider text-slate-400 truncate">${escapeHtml(Z.label)}</span>
          </div>
          <div class="flex items-end justify-between gap-2">
            <div>
              <div class="text-4xl font-black text-white leading-none tabular-nums">${Z.realT}°</div>
              <div class="text-[11px] font-bold text-orange-300 mt-1">Cible ${fmtTriArcTempSp(Z.spT)}</div>
            </div>
            <div class="flex items-center gap-1.5">
              <button type="button" onclick="cockpitStepTemp('${zone}', -1)" class="w-10 h-10 rounded-2xl bg-slate-800 hover:bg-slate-700 text-white font-black text-lg border border-slate-700 cursor-pointer">−</button>
              <button type="button" onclick="cockpitStepTemp('${zone}', 1)" class="w-10 h-10 rounded-2xl bg-orange-600 hover:bg-orange-500 text-white font-black text-lg border border-orange-400 cursor-pointer">+</button>
            </div>
          </div>
          <div class="relative h-2 rounded-full bg-slate-800 overflow-visible">
            <div class="h-full rounded-full bg-gradient-to-r from-sky-400 via-amber-400 to-orange-500" style="width:${pctTemp.toFixed(1)}%"></div>
            <div class="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-sky-300 border-2 border-slate-950" style="left:${pctReal.toFixed(1)}%"></div>
          </div>
        </div>

        <!-- Colonne droite : Power + Puissance -->
        <div class="flex flex-col gap-2">
          <button type="button" onclick="handleDynamicPowerAction()"
            class="flex-1 rounded-3xl border-2 p-2.5 flex flex-col items-center justify-center gap-1 transition cursor-pointer ${T.isAlarm
              ? "bg-rose-900/90 border-rose-400 text-white animate-pulse"
              : (T.st === 0 ? "bg-emerald-600/85 hover:bg-emerald-500/90 border-emerald-400 text-white" : "bg-rose-600/85 hover:bg-rose-500/90 border-rose-400 text-white")}">
            <svg viewBox="0 0 24 24" class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/></svg>
            <span class="text-[11px] font-extrabold">${T.isAlarm ? "Alarme" : (T.st === 0 ? "Allumer" : "Éteindre")}</span>
          </button>

          <div class="rounded-3xl bg-slate-900/90 border border-slate-800 p-2.5 flex flex-col justify-between gap-1">
            <div class="flex items-center justify-between text-[10px] text-orange-300 font-bold">
              <span>🔥 Puiss</span>
              <span class="font-mono text-slate-400">R:P${Math.round(T.realPwr)}</span>
            </div>
            ${isPwrAuto ? `
              <div class="flex items-center justify-between gap-1">
                <span class="text-xs font-extrabold text-orange-200">Auto P${Math.round(T.realPwr)}</span>
                <button type="button" onclick="setTriArcAutoOption(${isFanAuto ? 1 : 0})" class="px-1.5 py-0.5 rounded-lg bg-slate-800 text-[10px] font-bold text-orange-200 cursor-pointer">Manuel</button>
              </div>
            ` : `
              <div class="flex items-center justify-between gap-1">
                <button type="button" onclick="cockpitStepPower(-1)" class="w-7 h-7 rounded-xl bg-slate-800 text-white font-black text-sm cursor-pointer">−</button>
                <span class="text-sm font-black text-white font-mono">P${Math.round(T.pwrSp)}</span>
                <button type="button" onclick="cockpitStepPower(1)" class="w-7 h-7 rounded-xl bg-orange-600 text-white font-black text-sm cursor-pointer">+</button>
              </div>
            `}
          </div>
        </div>
      </div>

      <!-- Ligne intermédiaire : Ventilation -->
      ${Z.showFan ? `
      <div class="rounded-3xl bg-slate-900/90 border border-slate-800 p-3 flex items-center justify-between gap-2">
        <div class="text-xs">
          <div class="font-bold text-sky-300 flex items-center gap-1">${svgPropellerFanIcon("w-3.5 h-3.5", "#38bdf8")} Ventilation · ${escapeHtml(Z.label)}</div>
          <div class="font-mono text-[11px] text-slate-400">Réel ${fmtTriArcFan(Z.fanReal)}</div>
        </div>
        ${isFanAuto ? `
          <div class="flex items-center gap-2">
            <span class="text-sm font-black text-cyan-300">AUTO</span>
            <button type="button" onclick="setTriArcAutoOption(${isPwrAuto ? 3 : 0})" class="px-2.5 py-1 rounded-lg bg-slate-800 text-[10px] font-bold text-cyan-200 cursor-pointer">Manuel</button>
          </div>
        ` : `
          <div class="flex items-center gap-2">
            <button type="button" onclick="cockpitStepFan('${zone}', -1)" class="w-9 h-8 rounded-xl bg-slate-800 text-white font-black cursor-pointer">−</button>
            <span class="text-base font-black text-white font-mono min-w-[36px] text-center">${fmtTriArcFan(Z.fanSp)}</span>
            <button type="button" onclick="cockpitStepFan('${zone}', 1)" class="w-9 h-8 rounded-xl bg-sky-600 text-white font-black cursor-pointer">+</button>
          </div>
        `}
      </div>
      ` : ""}

      ${renderCockpitModeBar(T, zone, true)}
      ${renderTriArcDailyChronoFrise(zone)}
      ${renderCockpitPendingBar()}
    </div>
  `;
}

// #3 — FADERS VERTICAUX TACTILES (Apple Control Center / HomeKit / Loi de Fitts)
function renderCockpitView_faders(T, caps) {
  const zone = getCockpitActiveZone(caps);
  const Z = getCockpitZoneValues(zone, T, caps);
  const tMin = Number(caps.temp_min ?? 7);
  const tMax = Number(caps.temp_max ?? 41);
  const fanMax = Math.max(1, Number(caps.fan_max ?? 8));
  const pMin = Math.max(1, Number(caps.power_min ?? 1));
  const pMax = Math.max(pMin, Number(caps.power_max ?? 7));

  const isFanAuto = (zone === "AMB") && (T.autoIdx === 1 || T.autoIdx === 2 || Z.fanSp === 8);
  const isPwrAuto = Number(T.autoPwr) === 1;

  const pctTempSp = Math.max(0, Math.min(100, ((Number(Z.spT) - tMin) / Math.max(1, tMax - tMin)) * 100));
  const pctTempReal = Math.max(0, Math.min(100, ((Number(Z.realT) - tMin) / Math.max(1, tMax - tMin)) * 100));
  const pctFanSp = Math.max(0, Math.min(100, (Number(Z.fanSp) / fanMax) * 100));
  const pctFanReal = Math.max(0, Math.min(100, (Number(Z.fanReal) / fanMax) * 100));
  const pctPwrSp = Math.max(0, Math.min(100, ((Number(T.pwrSp) - pMin) / Math.max(1, pMax - pMin)) * 100));
  const pctPwrReal = Math.max(0, Math.min(100, ((Number(T.realPwr) - pMin) / Math.max(1, pMax - pMin)) * 100));

  const cols = (Z.showFan ? 1 : 0) + 1 + (Z.showPwr ? 1 : 0);

  return `
    <div class="space-y-2.5">
      <div class="flex items-center justify-between gap-2">
        ${renderCockpitPhasePill(T)}
        ${renderCockpitPowerBtn(T, "h-11 w-11 rounded-2xl")}
      </div>

      ${renderCockpitZoneTabs(zone, T, caps)}

      <div class="grid gap-2.5" style="grid-template-columns: ${cols === 3 ? "1fr 1.35fr 1fr" : (cols === 2 ? "1.35fr 1fr" : "1fr")};">
        ${Z.showFan ? `
        <div class="rounded-3xl bg-slate-900/90 border border-slate-800 p-2 flex flex-col items-center gap-1.5">
          <div class="text-[11px] font-bold text-sky-300 flex items-center gap-1">${svgPropellerFanIcon("w-3.5 h-3.5", "#38bdf8")} Ventil</div>
          <div ${!isFanAuto ? `data-fader-track="1" data-fader-type="fan" data-zone="${zone}" data-min="0" data-max="${fanMax}"` : ""}
            class="cockpit-fader-track relative w-full h-48 rounded-2xl bg-slate-950 border ${isFanAuto ? "border-cyan-500/40 opacity-75 pointer-events-none" : "border-slate-800"} overflow-hidden flex flex-col justify-between items-center py-2">
            <div class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-sky-700/80 to-cyan-400/75 pointer-events-none" style="height:${pctFanSp.toFixed(1)}%"></div>
            <div class="absolute inset-x-2 h-0.5 bg-white shadow-[0_0_8px_#fff] pointer-events-none" style="bottom:${pctFanReal.toFixed(1)}%"></div>
            <span class="relative z-10 text-[10px] font-bold text-slate-300 pointer-events-none">${isFanAuto ? "AUTO" : "MAX"}</span>
            <div class="relative z-10 text-center pointer-events-none">
              <div class="text-lg font-black text-white drop-shadow font-mono">${fmtTriArcFan(Z.fanSp)}</div>
              <div class="text-[10px] text-sky-200 font-semibold">R:${fmtTriArcFan(Z.fanReal)}</div>
            </div>
            <span class="relative z-10 text-[10px] font-bold text-slate-400 pointer-events-none">OFF</span>
          </div>
          <div class="flex items-center gap-1 w-full">
            <button type="button" onclick="cockpitStepFan('${zone}', -1)" ${isFanAuto ? "disabled" : ""} class="flex-1 py-1.5 rounded-xl bg-slate-800 text-white font-black text-xs disabled:opacity-40 cursor-pointer">−</button>
            <button type="button" onclick="cockpitStepFan('${zone}', 1)" ${isFanAuto ? "disabled" : ""} class="flex-1 py-1.5 rounded-xl bg-sky-700 text-white font-black text-xs disabled:opacity-40 cursor-pointer">+</button>
          </div>
        </div>
        ` : ""}

        <!-- Fader Central Température -->
        <div class="rounded-3xl bg-slate-900/90 border border-slate-800 p-2 flex flex-col items-center gap-1.5">
          <div class="text-[11px] font-bold text-orange-300 truncate max-w-full">🌡️ ${escapeHtml(Z.label)}</div>
          <div data-fader-track="1" data-fader-type="temp" data-zone="${zone}" data-min="${tMin}" data-max="${tMax}"
            class="cockpit-fader-track relative w-full h-48 rounded-2xl bg-slate-950 border border-orange-500/40 overflow-hidden flex flex-col justify-between items-center py-2">
            <div class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-sky-700/65 via-amber-500/70 to-orange-500/80 pointer-events-none" style="height:${pctTempSp.toFixed(1)}%"></div>
            <div class="absolute inset-x-2 h-0.5 bg-sky-200 shadow-[0_0_8px_#38bdf8] pointer-events-none" style="bottom:${pctTempReal.toFixed(1)}%"></div>
            <span class="relative z-10 text-[10px] font-bold text-rose-200 pointer-events-none">${tMax}°</span>
            <div class="relative z-10 text-center pointer-events-none">
              <div class="text-3xl font-black text-white drop-shadow tabular-nums">${Z.realT}°</div>
              <div class="text-xs font-extrabold text-orange-200 bg-black/45 px-2 py-0.5 rounded-full mt-0.5">→ ${fmtTriArcTempSp(Z.spT)}</div>
            </div>
            <span class="relative z-10 text-[10px] font-bold text-sky-200 pointer-events-none">${tMin}°</span>
          </div>
          <div class="flex items-center gap-1.5 w-full">
            <button type="button" onclick="cockpitStepTemp('${zone}', -1)" class="flex-1 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-black text-sm cursor-pointer">−</button>
            <button type="button" onclick="cockpitStepTemp('${zone}', 1)" class="flex-1 py-1.5 rounded-xl bg-orange-600 hover:bg-orange-500 text-white font-black text-sm cursor-pointer">+</button>
          </div>
        </div>

        ${Z.showPwr ? `
        <div class="rounded-3xl bg-slate-900/90 border border-slate-800 p-2 flex flex-col items-center gap-1.5">
          <div class="text-[11px] font-bold text-amber-300">🔥 Puiss</div>
          <div ${!isPwrAuto ? `data-fader-track="1" data-fader-type="pwr" data-zone="AMB" data-min="${pMin}" data-max="${pMax}"` : ""}
            class="cockpit-fader-track relative w-full h-48 rounded-2xl bg-slate-950 border ${isPwrAuto ? "border-orange-500/40 opacity-75 pointer-events-none" : "border-slate-800"} overflow-hidden flex flex-col justify-between items-center py-2">
            <div class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-amber-700/80 to-orange-500/85 pointer-events-none" style="height:${pctPwrSp.toFixed(1)}%"></div>
            <div class="absolute inset-x-2 h-0.5 bg-white shadow-[0_0_8px_#fff] pointer-events-none" style="bottom:${pctPwrReal.toFixed(1)}%"></div>
            <span class="relative z-10 text-[10px] font-bold text-slate-300 pointer-events-none">${isPwrAuto ? "AUTO" : `P${pMax}`}</span>
            <div class="relative z-10 text-center pointer-events-none">
              <div class="text-lg font-black text-white drop-shadow font-mono">P${Math.round(T.pwrSp)}</div>
              <div class="text-[10px] text-amber-200 font-semibold">R:P${Math.round(T.realPwr)}</div>
            </div>
            <span class="relative z-10 text-[10px] font-bold text-slate-400 pointer-events-none">P${pMin}</span>
          </div>
          <div class="flex items-center gap-1 w-full">
            <button type="button" onclick="cockpitStepPower(-1)" ${isPwrAuto ? "disabled" : ""} class="flex-1 py-1.5 rounded-xl bg-slate-800 text-white font-black text-xs disabled:opacity-40 cursor-pointer">−</button>
            <button type="button" onclick="cockpitStepPower(1)" ${isPwrAuto ? "disabled" : ""} class="flex-1 py-1.5 rounded-xl bg-orange-600 text-white font-black text-xs disabled:opacity-40 cursor-pointer">+</button>
          </div>
        </div>
        ` : ""}
      </div>

      ${renderCockpitModeBar(T, zone, true)}
      ${renderTriArcDailyChronoFrise(zone)}
      ${renderCockpitPendingBar()}
    </div>
  `;
}

// #4 — ERGONOMIE THUMB-ZONE ONE-HANDED (Samsung One UI / Safari iOS / Hoober)
function renderCockpitView_thumb_zone(T, caps) {
  const zone = getCockpitActiveZone(caps);
  const Z = getCockpitZoneValues(zone, T, caps);
  const ducts = Array.isArray(caps.ducts) ? caps.ducts : [];
  const hasSX = ducts.some(d => d.id === "SX");
  const hasDX = ducts.some(d => d.id === "DX");

  return `
    <div class="flex flex-col justify-between gap-3">
      <!-- TIERS HAUT : 100 % LECTURE PASSIVE -->
      <div class="rounded-3xl bg-slate-900/75 border border-slate-800/90 p-4 text-center space-y-2.5">
        <div class="flex items-center justify-center">
          ${renderCockpitPhasePill(T)}
        </div>
        <div class="py-1">
          <div class="text-[11px] uppercase tracking-widest text-slate-400 font-bold">${escapeHtml(Z.label)}</div>
          <div class="text-5xl font-black text-white tabular-nums tracking-tight mt-0.5">${Z.realT}°</div>
          <div class="text-sm font-extrabold text-orange-300 mt-1">Consigne ${fmtTriArcTempSp(Z.spT)}</div>
        </div>
        <div class="flex flex-wrap items-center justify-center gap-2 text-[11px] font-mono text-slate-300">
          ${hasSX ? `<span class="px-2 py-1 rounded-lg bg-slate-950 border border-slate-800 text-cyan-300">${escapeHtml(getDuctName("SX"))} ${T.realSx}°</span>` : ""}
          <span class="px-2 py-1 rounded-lg bg-slate-950 border border-slate-800">🔥 P${Math.round(T.realPwr)}</span>
          ${Z.showFan ? `<span class="px-2 py-1 rounded-lg bg-slate-950 border border-slate-800">🌀 ${fmtTriArcFan(Z.fanReal)}</span>` : ""}
          ${hasDX ? `<span class="px-2 py-1 rounded-lg bg-slate-950 border border-slate-800 text-sky-300">${escapeHtml(getDuctName("DX"))} ${T.realDx}°</span>` : ""}
        </div>
        ${renderTriArcDailyChronoFrise(zone)}
      </div>

      <!-- TIERS BAS : 100 % PORTÉE DU POUCE -->
      <div class="rounded-3xl bg-slate-900/95 border border-slate-700/80 p-3 space-y-2.5 shadow-2xl">
        ${renderCockpitZoneTabs(zone, T, caps)}

        <div class="grid grid-cols-3 gap-2 items-center">
          <button type="button" onclick="cockpitStepTemp('${zone}', -1)"
            class="h-14 rounded-2xl bg-slate-800 hover:bg-slate-700 active:scale-95 text-white text-2xl font-black border border-slate-700 cursor-pointer">−</button>
          <div class="h-14 rounded-2xl bg-slate-950 border border-orange-500/50 flex flex-col items-center justify-center">
            <span class="text-[10px] text-slate-400 font-bold">CIBLE</span>
            <span class="text-xl font-black text-orange-300 font-mono">${fmtTriArcTempSp(Z.spT)}</span>
          </div>
          <button type="button" onclick="cockpitStepTemp('${zone}', 1)"
            class="h-14 rounded-2xl bg-orange-600 hover:bg-orange-500 active:scale-95 text-white text-2xl font-black border border-orange-400 cursor-pointer">+</button>
        </div>

        <div class="grid grid-cols-3 gap-2">
          <button type="button" onclick="cockpitOpenSheet('manual')"
            class="col-span-2 h-12 rounded-2xl bg-slate-950 hover:bg-slate-800 border border-slate-700 text-slate-200 text-xs font-extrabold flex items-center justify-center gap-2 cursor-pointer">
            <span>🎚</span><span>Ventil ${fmtTriArcFan(Z.fanSp)} · Puiss P${Math.round(T.pwrSp)}</span>
          </button>
          ${renderCockpitPowerBtn(T, "h-12 w-full rounded-2xl")}
        </div>

        ${renderCockpitModeBar(T, zone, true)}
      </div>

      ${renderCockpitPendingBar()}
      ${renderCockpitBottomSheet(T, zone, caps)}
    </div>
  `;
}

// #5 — CARTES EMPILÉES MULTI-ZONES EN ACCORDÉON (Material 3 / Google Home / Tado)
function renderCockpitView_cards_accordion(T, caps) {
  const ducts = Array.isArray(caps.ducts) ? caps.ducts : [];
  const hasSX = ducts.some(d => d.id === "SX");
  const hasDX = ducts.some(d => d.id === "DX");
  const ambOpen = Boolean(cockpitAltState.expandedCards.AMB);
  const isAmbFanAuto = T.autoIdx === 1 || T.autoIdx === 2 || T.fanAmb === 8;
  const isPwrAuto = Number(T.autoPwr) === 1;

  const renderDuctCard = (ductId, accentBorder, accentText, realT, spT, fanSp, fanReal) => {
    const isOpen = Boolean(cockpitAltState.expandedCards[ductId]);
    const name = escapeHtml(getDuctName(ductId));
    return `
      <div class="rounded-3xl bg-slate-900/90 border ${isOpen ? accentBorder : "border-slate-800"} overflow-hidden transition">
        <div class="p-3 flex items-center justify-between gap-1.5">
          <button type="button" onclick="cockpitToggleAccordion('${ductId}')" class="flex-1 min-w-0 text-left flex flex-col gap-0.5 cursor-pointer">
            <span class="text-xs font-extrabold ${accentText} truncate">${name}</span>
            <span class="text-xs font-mono font-black text-white tabular-nums">${realT}° → ${fmtTriArcTempSp(spT)}</span>
            <span class="text-[10.5px] font-mono text-slate-400">🌀 ${fmtTriArcFan(fanSp)}</span>
          </button>
          <div class="flex items-center gap-1 shrink-0">
            <button type="button" onclick="cockpitStepTemp('${ductId}', -1)" class="w-8 h-8 rounded-xl bg-slate-800 text-white font-black cursor-pointer">−</button>
            <button type="button" onclick="cockpitStepTemp('${ductId}', 1)" class="w-8 h-8 rounded-xl bg-slate-800 text-white font-black cursor-pointer">+</button>
            <button type="button" onclick="cockpitToggleAccordion('${ductId}')" class="w-7 h-8 rounded-xl bg-slate-950 border border-slate-800 text-slate-300 text-[10px] cursor-pointer">${isOpen ? "▲" : "▼"}</button>
          </div>
        </div>
        ${isOpen ? `
          <div class="px-3 pb-3 pt-2 border-t border-slate-800/80 space-y-2.5">
            ${renderCockpitSegmentedFan(ductId, fanSp, fanReal, caps, false, isPwrAuto)}
            ${renderTriArcDailyChronoFrise(ductId)}
          </div>
        ` : ""}
      </div>
    `;
  };

  return `
    <div class="space-y-2.5">
      <!-- Carte principale Poêle / Salon -->
      <div class="rounded-3xl bg-slate-900/95 border border-orange-500/45 p-3.5 space-y-3 shadow-lg">
        <div class="flex items-center justify-between gap-2">
          ${renderCockpitPhasePill(T)}
          ${renderCockpitPowerBtn(T, "h-11 w-11 rounded-2xl")}
        </div>

        <div class="flex items-center justify-between gap-2">
          <div>
            <div class="text-[11px] font-bold text-slate-400 uppercase">${caps.stove_type === "hydro" ? "Chaudière" : "Poêle / Salon"}</div>
            <div class="flex items-baseline gap-2">
              <span class="text-4xl font-black text-white tabular-nums">${T.realAmb}°</span>
              <span class="text-sm font-extrabold text-orange-300">→ ${fmtTriArcTempSp(T.spAmb)}</span>
            </div>
          </div>
          <div class="flex items-center gap-1.5">
            <button type="button" onclick="cockpitStepTemp('AMB', -1)" class="w-11 h-11 rounded-2xl bg-slate-800 hover:bg-slate-700 text-white font-black text-xl border border-slate-700 cursor-pointer">−</button>
            <button type="button" onclick="cockpitStepTemp('AMB', 1)" class="w-11 h-11 rounded-2xl bg-orange-600 hover:bg-orange-500 text-white font-black text-xl border border-orange-400 cursor-pointer">+</button>
          </div>
        </div>

        <button type="button" onclick="cockpitToggleAccordion('AMB')"
          class="w-full flex items-center justify-between px-3 py-2 rounded-2xl bg-slate-950/80 border border-slate-800 text-xs text-slate-300 cursor-pointer">
          <span class="font-mono font-bold">🔥 P${Math.round(T.realPwr)} (Cible P${Math.round(T.pwrSp)}) ${caps.has_fan_front !== false ? `· 🌀 ${fmtTriArcFan(T.fanAmb)}` : ""}</span>
          <span class="text-orange-300 font-bold">${ambOpen ? "Masquer ▲" : "Ajuster ▼"}</span>
        </button>

        ${ambOpen ? `
          <div class="space-y-2.5 pt-1 border-t border-slate-800/80">
            ${caps.has_fan_front !== false ? renderCockpitSegmentedFan("AMB", T.fanAmb, T.realFanAmb, caps, isAmbFanAuto, isPwrAuto) : ""}
            ${renderCockpitSegmentedPower(T.pwrSp, T.realPwr, caps, isPwrAuto, isAmbFanAuto)}
          </div>
        ` : ""}
      </div>

      ${(hasSX || hasDX) ? `
      <div class="grid ${hasSX && hasDX ? "grid-cols-2" : "grid-cols-1"} gap-2 items-start">
        ${hasSX ? renderDuctCard("SX", "border-cyan-400/70", "text-cyan-300", T.realSx, T.spSx, T.fanSx, T.realFanSx) : ""}
        ${hasDX ? renderDuctCard("DX", "border-sky-400/70", "text-sky-300", T.realDx, T.spDx, T.fanDx, T.realFanDx) : ""}
      </div>
      ` : ""}

      ${renderCockpitModeBar(T, "AMB", true)}
      ${renderTriArcDailyChronoFrise("AMB")}
      ${renderCockpitPendingBar()}
    </div>
  `;
}
