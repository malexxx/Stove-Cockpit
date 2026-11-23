// =============================================================================
// CHARTS — COCKPIT GRAPHIQUE VOLETS 1, 2 & 3 SYNCHRONISÉS (60 FPS)
// =============================================================================

// Plugin Chart.js dessinant les zones de perte de connexion + le fond coloré par phase (Prop. 2) + la ligne verticale synchronisée
const syncCrosshairPlugin = {
  id: "syncCrosshairPlugin",
  beforeDatasetsDraw(chart) {
    if (!cachedSeriesRows.length || !chart.scales.x || !chart.chartArea) return;
    const xScale = chart.scales.x;
    const { top, bottom, left, right } = chart.chartArea;
    const ctx = chart.ctx;
    const stepPx = cachedSeriesRows.length > 1
      ? Math.abs(xScale.getPixelForValue(1) - xScale.getPixelForValue(0))
      : 6;

    // PROPOSITION 2 : Zones verticales colorées selon la phase du poêle
    if (activePhaseViews && activePhaseViews.prop2) {
      let runStart = 0;
      let runMeta = getPhaseMeta(cachedSeriesRows[0]);
      const drawPhaseBox = (sIdx, eIdx, meta) => {
        if (!meta || meta.code === -1) return;
        const x1 = Math.max(left, xScale.getPixelForValue(sIdx) - stepPx * 0.5);
        const x2 = Math.min(right, xScale.getPixelForValue(eIdx) + stepPx * 0.5);
        if (x2 <= x1) return;
        ctx.save();
        // Fond teinté subtil (plus léger pour OFF = 0)
        const op = meta.code === 0 ? phaseBgOpacity * 0.45 : phaseBgOpacity;
        ctx.fillStyle = `rgba(${meta.rgb}, ${op})`;
        ctx.fillRect(x1, top, x2 - x1, bottom - top);
        // Liseré supérieur coloré de 3px pour repérer la phase d'un coup d'œil
        ctx.fillStyle = `rgba(${meta.rgb}, 0.85)`;
        ctx.fillRect(x1, top, x2 - x1, 3);
        ctx.restore();
      };

      for (let i = 1; i < cachedSeriesRows.length; i++) {
        const m = getPhaseMeta(cachedSeriesRows[i]);
        if (m.code !== runMeta.code) {
          drawPhaseBox(runStart, i - 1, runMeta);
          runStart = i;
          runMeta = m;
        }
      }
      drawPhaseBox(runStart, cachedSeriesRows.length - 1, runMeta);
    }

    let gapStartIdx = -1;
    const drawGapBox = (startIdx, endIdx) => {
      const x1 = Math.max(left, xScale.getPixelForValue(startIdx) - stepPx * 0.45);
      const x2 = Math.min(right, xScale.getPixelForValue(endIdx) + stepPx * 0.45);
      if (x2 <= x1) return;
      ctx.save();
      ctx.fillStyle = "rgba(244, 63, 94, 0.08)";
      ctx.fillRect(x1, top, x2 - x1, bottom - top);
      ctx.strokeStyle = "rgba(244, 63, 94, 0.35)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x1, top);
      ctx.lineTo(x1, bottom);
      ctx.moveTo(x2, top);
      ctx.lineTo(x2, bottom);
      ctx.stroke();
      ctx.restore();
    };

    for (let i = 0; i < cachedSeriesRows.length; i++) {
      if (cachedSeriesRows[i]._isGap) {
        if (gapStartIdx < 0) gapStartIdx = i;
      } else if (gapStartIdx >= 0) {
        drawGapBox(gapStartIdx, i - 1);
        gapStartIdx = -1;
      }
    }
    if (gapStartIdx >= 0) {
      drawGapBox(gapStartIdx, cachedSeriesRows.length - 1);
    }
  },
  afterDraw(chart) {
    if (activeHoverIdx < 0 || !chart.data.labels || activeHoverIdx >= chart.data.labels.length) return;
    const xScale = chart.scales.x;
    if (!xScale) return;
    const xPos = xScale.getPixelForValue(activeHoverIdx);
    if (xPos < chart.chartArea.left || xPos > chart.chartArea.right) return;
    const ctx = chart.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(xPos, chart.chartArea.top);
    ctx.lineTo(xPos, chart.chartArea.bottom);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
    ctx.stroke();
    ctx.restore();
  }
};

function getFixedAxisWidth() {
  return window.innerWidth < 640 ? 42 : 64;
}

function initThreePaneCockpit() {
  const fixWidth = (axis) => { axis.width = getFixedAxisWidth(); };

  const ctx1 = document.getElementById("chartPane1").getContext("2d");
  chartPane1 = new Chart(ctx1, {
    type: "line",
    data: { labels: [], datasets: [] },
    plugins: [syncCrosshairPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: { padding: { left: 0, right: 0, top: 4, bottom: 0 } },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { backgroundColor: "#0f172a", borderColor: "#334155", borderWidth: 1 }
      },
      scales: {
        x: { ticks: { color: "#94a3b8", maxTicksLimit: 8, font: { size: 10 } }, grid: { color: "#1e293b" } },
        yTemp: {
          type: "linear",
          position: "left",
          afterFit: fixWidth,
          ticks: { color: "#10b981", font: { size: 10 } },
          grid: { color: "#1e293b" }
        },
        yFume: {
          type: "linear",
          position: "right",
          afterFit: fixWidth,
          ticks: { color: "#f97316", font: { size: 10 } },
          grid: { drawOnChartArea: false }
        }
      }
    }
  });

  const ctx2 = document.getElementById("chartPane2").getContext("2d");
  chartPane2 = new Chart(ctx2, {
    type: "line",
    data: { labels: [], datasets: [] },
    plugins: [syncCrosshairPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: { padding: { left: 0, right: 0, top: 4, bottom: 0 } },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { backgroundColor: "#0f172a", borderColor: "#334155", borderWidth: 1 }
      },
      scales: {
        x: { ticks: { color: "#94a3b8", maxTicksLimit: 8, font: { size: 10 } }, grid: { color: "#1e293b" } },
        yPct: {
          type: "linear",
          position: "left",
          afterFit: fixWidth,
          ticks: { color: "#eab308", font: { size: 10 } },
          grid: { color: "#1e293b" }
        },
        yRpm: {
          type: "linear",
          position: "right",
          afterFit: fixWidth,
          ticks: { color: "#a855f7", font: { size: 10 } },
          grid: { drawOnChartArea: false }
        }
      }
    }
  });

  // Écouteurs souris & tactiles unifiés sur les 4 volets (coalescés via rAF pour un vrai 60 FPS sans reflow inutile)
  const container = document.getElementById("three-panes-container");
  let _hoverRafId = null;
  let _pendingHoverX = 0;
  let _pendingHoverTarget = null;

  const flushPointerMove = () => {
    _hoverRafId = null;
    if (!cachedSeriesRows.length) return;
    const secPlot = document.getElementById("security-ribbons-plot-area");
    const ribPlot = document.getElementById("ribbons-plot-area");
    let plotEl = ribPlot;
    if (_pendingHoverTarget && _pendingHoverTarget.closest && _pendingHoverTarget.closest("#security-ribbons-plot-area")) {
      plotEl = secPlot || ribPlot;
    } else if (!plotEl) {
      plotEl = secPlot;
    }
    if (!plotEl) return;
    const rect = plotEl.getBoundingClientRect();
    if (rect.width <= 0) return;
    const relX = Math.max(0, Math.min(rect.width, _pendingHoverX - rect.left));
    const ratio = relX / rect.width;
    const idx = Math.min(cachedSeriesRows.length - 1, Math.max(0, Math.round(ratio * (cachedSeriesRows.length - 1))));
    setSynchronizedHoverIndex(idx, (idx / Math.max(1, cachedSeriesRows.length - 1)) * 100);
  };

  const handlePointerMove = (clientX, targetEl) => {
    if (!cachedSeriesRows.length) return;
    _pendingHoverX = clientX;
    _pendingHoverTarget = targetEl;
    if (_hoverRafId === null) {
      _hoverRafId = window.requestAnimationFrame(flushPointerMove);
    }
  };

  const attachPointerListeners = (el) => {
    if (!el) return;
    el.addEventListener("mousemove", (e) => handlePointerMove(e.clientX, e.target));
    el.addEventListener("touchstart", (e) => {
      if (e.touches && e.touches[0]) handlePointerMove(e.touches[0].clientX, e.target);
    }, { passive: true });
    el.addEventListener("touchmove", (e) => {
      if (e.touches && e.touches[0]) handlePointerMove(e.touches[0].clientX, e.target);
    }, { passive: true });
  };

  attachPointerListeners(container);
  const secRibArea = document.getElementById("security-ribbons-plot-area");
  if (secRibArea) attachPointerListeners(secRibArea);

  if (container) {
    container.addEventListener("mouseleave", () => clearSynchronizedHover());
  }

  window.addEventListener("resize", () => {
    if (chartPane1) chartPane1.update("none");
    if (chartPane2) chartPane2.update("none");
  });
}

// Trouve les bornes (début/fin/durée) du segment de phase contenant l'index idx
function getPhaseSegmentBounds(idx) {
  if (!cachedSeriesRows.length || idx < 0 || idx >= cachedSeriesRows.length) return null;
  const targetMeta = getPhaseMeta(cachedSeriesRows[idx]);
  let s = idx;
  let e = idx;
  while (s > 0 && getPhaseMeta(cachedSeriesRows[s - 1]).code === targetMeta.code) s--;
  while (e < cachedSeriesRows.length - 1 && getPhaseMeta(cachedSeriesRows[e + 1]).code === targetMeta.code) e++;
  const stepSec = getAverageStepSeconds();
  const sRow = cachedSeriesRows[s];
  const eRow = cachedSeriesRows[e];
  let durMin = Math.round(((e - s + 1) * stepSec) / 60);
  if (sRow.epoch && eRow.epoch && e > s) {
    durMin = Math.max(1, Math.round((Number(eRow.epoch) - Number(sRow.epoch) + stepSec) / 60));
  }
  const tStart = (sRow.timestamp || "").slice(11, 16) || "--:--";
  const tEnd = (eRow.timestamp || "").slice(11, 16) || "--:--";
  return { startIdx: s, endIdx: e, durationMin: durMin, tStart, tEnd, meta: targetMeta };
}

let _lastProp4PhaseCode = null;

/**
 * Met à jour les éléments visuels des Propositions 1, 3 et 4 pour un index donné (survol ou temps réel).
 * Évite la reconstruction du stepper 6 étapes (`stepGrid.innerHTML`) lorsque le code de phase reste inchangé.
 * @param {number} idx Index dans `cachedSeriesRows`.
 * @param {boolean} isHovering True si déclenché par le pointeur utilisateur.
 */
function updatePhaseHoverViews(idx, isHovering) {
  const row = cachedSeriesRows[idx];
  if (!row) return;
  const meta = getPhaseMeta(row);
  const seg = getPhaseSegmentBounds(idx);

  // Proposition 1 : Valeur texte dans le Ruban Maître
  const rValPhase = document.getElementById("ribbon-val-phase");
  if (rValPhase) {
    rValPhase.textContent = meta.code === -1
      ? "HORS LIGNE"
      : `${meta.icon} #${meta.code} ${meta.label}${seg ? ` (${formatDurationMin(seg.durationMin)})` : ""}`;
  }

  // Proposition 3 : Badge dans la barre de pointeur + Carte Inspecteur de Phase
  const hoverBadge = document.getElementById("hover-phase-badge");
  if (hoverBadge) {
    hoverBadge.textContent = meta.code === -1 ? "📡 HORS LIGNE" : `${meta.icon} #${meta.code} ${meta.label}`;
    hoverBadge.className = `${(activePhaseViews && activePhaseViews.prop3) ? "" : "hidden "}px-2.5 py-0.5 rounded-full text-[11px] font-bold border transition-all ${meta.badgeClass}`;
  }

  const p3Icon = document.getElementById("prop3-phase-icon");
  const p3Title = document.getElementById("prop3-phase-title");
  const p3Dur = document.getElementById("prop3-segment-duration");
  const p3Desc = document.getElementById("prop3-phase-desc");
  const p3Glow = document.getElementById("prop3-m-glow");
  const p3Auger = document.getElementById("prop3-m-auger");
  const p3Pwr = document.getElementById("prop3-m-pwr");

  if (p3Title) {
    if (p3Icon) {
      p3Icon.textContent = meta.icon;
      p3Icon.style.borderColor = meta.hex;
    }
    p3Title.textContent = meta.code === -1
      ? "Perte de connexion télémétrique"
      : `Phase #${meta.code} — ${meta.label}`;
    p3Title.style.color = meta.hex;
    if (p3Dur && seg) {
      p3Dur.textContent = `Segment : ${seg.tStart} ➔ ${seg.tEnd} (${formatDurationMin(seg.durationMin)})`;
    }
    if (p3Desc) p3Desc.textContent = meta.desc;
    if (p3Glow) {
      const glowOn = Number(row.glow_plug_on ?? (meta.code === 2 || meta.code === 3 ? 1 : 0)) > 0;
      p3Glow.textContent = row._isGap ? "--" : (glowOn ? "⚡ ON" : "OFF");
      p3Glow.className = glowOn ? "text-amber-400 font-bold" : "text-gray-400";
    }
    if (p3Auger) {
      if (row._isGap) {
        p3Auger.textContent = "--";
      } else if (row.auger_on_time_s != null) {
        const augerS = Number(row.auger_on_time_s);
        p3Auger.textContent = `${augerS.toFixed(1)}s (${Number(row.pellet_rate_kgh ?? 0).toFixed(2)} kg/h)`;
      } else {
        const rate = Number(row.pellet_rate_kgh ?? 0);
        p3Auger.textContent = `${rate.toFixed(2)} kg/h (P${row.power_actual ?? 0})`;
      }
    }
    if (p3Pwr) {
      p3Pwr.textContent = row._isGap ? "--" : formatRealPower(row.power_actual ?? row.power_level ?? 0);
    }
  }

  // Proposition 4 : Stepper visuel du cycle (6 étapes)
  const stepGrid = document.getElementById("prop4-stepper-grid");
  const modeInd = document.getElementById("prop4-mode-indicator");
  if (modeInd) {
    modeInd.textContent = isHovering
      ? `Pointeur : ${(row.timestamp || "").slice(11, 16)}`
      : "Temps réel (Dernier point)";
  }
  if (stepGrid && (_lastProp4PhaseCode !== meta.code || !stepGrid.childElementCount)) {
    _lastProp4PhaseCode = meta.code;
    const stages = [
      { id: "OFF", title: "0. Éteint", icon: "⚫", codes: [0], color: "#64748b", sub: "Arrêt complet" },
      {
        id: "IGNITION", title: "1–4. Allumage", icon: "🔥", codes: [1, 2, 3, 4], color: "#f59e0b",
        subSteps: [
          { c: 1, l: "1.Check" },
          { c: 2, l: "2.Préch." },
          { c: 3, l: "3.Pellet" },
          { c: 4, l: "4.Flamme" }
        ]
      },
      { id: "WORK", title: "5. Travail", icon: "🟢", codes: [5], color: "#10b981", sub: "Combustion nominale" },
      { id: "CLEAN", title: "6. Nettoyage", icon: "🧹", codes: [6], color: "#a855f7", sub: "Soufflage brasier" },
      {
        id: "STANDBY", title: "7–9. Arrêt / Veille", icon: "❄️", codes: [7, 8, 9], color: "#06b6d4",
        subSteps: [
          { c: 7, l: "7.Refroid." },
          { c: 8, l: "8.Eco-Stop" },
          { c: 9, l: "9.Stand-By" }
        ]
      },
      { id: "ALARM", title: "10–11. Alarme", icon: "🚨", codes: [10, 11], color: "#ef4444", sub: "Sécurité / Défaut" }
    ];

    stepGrid.innerHTML = stages.map(st => {
      const active = st.codes.includes(meta.code);
      const borderStyle = active ? `border-color:${st.color}; box-shadow: 0 0 12px ${st.color}44;` : "";
      const bgCls = active ? "bg-gray-900 text-white" : "bg-gray-950/60 border-gray-800/80 text-gray-500 opacity-65";
      let subHtml = "";
      if (st.subSteps) {
        subHtml = `<div class="grid grid-cols-2 gap-1 mt-1.5">` + st.subSteps.map(ss => {
          const subAct = meta.code === ss.c;
          return `<span class="text-[9px] px-1 py-0.5 rounded text-center font-bold border ${
            subAct ? "bg-amber-500 text-gray-950 border-amber-300 shadow" : "bg-gray-900/80 text-gray-500 border-gray-800"
          }">${ss.l}</span>`;
        }).join("") + `</div>`;
      } else {
        subHtml = `<div class="text-[10px] mt-1 truncate ${active ? "text-gray-200 font-semibold" : "text-gray-500"}">${st.sub}</div>`;
      }
      return `
        <div class="rounded-xl border p-2.5 transition-all ${bgCls}" style="${borderStyle}">
          <div class="flex items-center justify-between text-xs font-bold">
            <span class="flex items-center gap-1.5">
              <span>${st.icon}</span>
              <span style="${active ? `color:${st.color}` : ""}">${st.title}</span>
            </span>
            ${active ? `<span class="w-2 h-2 rounded-full animate-ping" style="background:${st.color}"></span>` : ""}
          </div>
          ${subHtml}
        </div>
      `;
    }).join("");
  }
}

/**
 * Synchronise la ligne de curseur et les volets d'inspection sur l'index télémétrique ciblé.
 * Court-circuite immédiatement si l'index n'a pas changé pour préserver le 60 FPS.
 * @param {number} idx Index cible dans `cachedSeriesRows`.
 * @param {number} pctLeft Position horizontale en pourcentage [0..100].
 */
function setSynchronizedHoverIndex(idx, pctLeft) {
  if (idx === activeHoverIdx) return;
  activeHoverIdx = idx;
  const cursorLine = document.getElementById("ribbons-cursor-line");
  if (cursorLine) {
    cursorLine.classList.remove("hidden");
    cursorLine.style.left = `${pctLeft}%`;
  }
  const secCursorLine = document.getElementById("sec-cursor-line");
  if (secCursorLine) {
    secCursorLine.classList.remove("hidden");
    secCursorLine.style.left = `${pctLeft}%`;
  }
  if (chartPane1) chartPane1.draw();
  if (chartPane2) chartPane2.draw();

  const row = cachedSeriesRows[idx];
  if (!row) return;
  updatePhaseHoverViews(idx, true);
  updateSecurityHoverViews(idx, true);

  if (row._isGap) {
    const gapLbl = row._gapDurationMin ? `Perte de connexion (~${row._gapDurationMin} min)` : "Perte de connexion";
    document.getElementById("hover-timestamp").textContent = `${formatTimestampFR(row.timestamp)} — ⚠️ ${gapLbl}`;
    document.getElementById("hover-values-summary").innerHTML = `
      <span class="text-rose-400 font-semibold">⚠️ Aucune donnée télémétrique reçue durant cet intervalle</span>
    `;
    document.getElementById("ribbon-val-auto").textContent = "HORS LIGNE";
    const climValEl = document.getElementById("ribbon-val-clim");
    if (climValEl) climValEl.textContent = "HORS LIGNE";
    document.getElementById("ribbon-val-pwf").textContent = "HORS LIGNE";
    document.getElementById("ribbon-val-sil").textContent = "HORS LIGNE";
    document.getElementById("ribbon-hover-state").textContent = row.timestamp ? row.timestamp.slice(11, 16) : "";
    return;
  }

  document.getElementById("hover-timestamp").textContent = formatTimestampFR(row.timestamp);
  const deltaVal = row.flame_delta_avg;
  const hasDelta = deltaVal !== undefined && deltaVal !== null && Number(row.status_code) === 5;
  const deltaTxt = hasDelta ? `${deltaVal >= 0 ? "+" : ""}${Number(deltaVal).toFixed(1)}°C` : "--";
  const deltaClass = hasDelta ? (deltaVal > 30 ? "text-amber-400" : (deltaVal < -25 ? "text-rose-400" : "text-emerald-400")) : "text-gray-400";
  document.getElementById("hover-values-summary").innerHTML = `
    <span>🏠 Salon: <b class="text-emerald-400">${escapeHtml(row.temp_ambient != null ? formatMeasuredTemp(row.temp_ambient) : "--")}°C</b></span>
    <span>🔥 Fumées: <b class="text-orange-400">${escapeHtml(row.temp_fumes ?? "--")}°C</b></span>
    <span>⚡ Puiss.: <b class="text-amber-400">${escapeHtml(row.power_actual !== undefined && row.power_actual !== null ? formatRealPower(row.power_actual) : "--")}</b></span>
    <span>⚖️ Écart Moy: <b class="${deltaClass}">${deltaTxt}</b></span>
    <span>🌀 RPM: <b class="text-purple-400">${escapeHtml(row.exhaust_rpm ?? "--")}</b></span>
  `;
  const autoOn = Number(row.fun_auto_set ?? 0) > 0;
  const stCode = Number(row.status_code ?? 0);
  const climOn = stCode === 8 || stCode === 9 || Number(row.standby_enabled ?? 0) > 0;
  const pwfMode = Number(row.fun_pwf_set ?? 0);
  const silOn = Number(row.set_silece_set ?? 0) > 0;
  document.getElementById("ribbon-val-auto").textContent = autoOn ? "ON (Modulation)" : "OFF";
  const climValEl = document.getElementById("ribbon-val-clim");
  if (climValEl) climValEl.textContent = climOn ? (stCode === 8 ? "ECO STOP (8)" : (stCode === 9 ? "STAND BY (9)" : "ACTIF")) : "OFF";
  document.getElementById("ribbon-val-pwf").textContent = pwfMode === 2 ? "CRONO (2)" : (pwfMode === 1 ? "ON (Boost)" : "OFF");
  document.getElementById("ribbon-val-sil").textContent = silOn ? "ON (Silence)" : "OFF";
  document.getElementById("ribbon-hover-state").textContent = row.timestamp ? row.timestamp.slice(11, 16) : "";
}

function clearSynchronizedHover() {
  activeHoverIdx = -1;
  const cursorLine = document.getElementById("ribbons-cursor-line");
  if (cursorLine) {
    cursorLine.classList.add("hidden");
  }
  const secCursorLine = document.getElementById("sec-cursor-line");
  if (secCursorLine) {
    secCursorLine.classList.add("hidden");
  }
  if (chartPane1) chartPane1.draw();
  if (chartPane2) chartPane2.draw();
  document.getElementById("hover-timestamp").textContent = "Temps réel (Dernier point)";
  if (cachedSeriesRows.length) {
    updatePhaseHoverViews(cachedSeriesRows.length - 1, false);
  }
  if (activeHoverIdx >= 0 && activeHoverIdx < cachedSeriesRows.length) {
    updateSecurityHoverViews(activeHoverIdx, true);
  } else {
    updateSecurityHoverViews(cachedSeriesRows.length - 1, false);
  }
}

function renderBooleanRibbons() {
  const trackPhase = document.getElementById("ribbon-track-phase");
  const trackAuto = document.getElementById("ribbon-track-auto");
  const trackClim = document.getElementById("ribbon-track-clim");
  const trackPwf = document.getElementById("ribbon-track-pwf");
  const trackSil = document.getElementById("ribbon-track-sil");
  if (!trackAuto || !trackPwf || !trackSil) return;

  if (!cachedSeriesRows.length) {
    if (trackPhase) trackPhase.innerHTML = "";
    trackAuto.innerHTML = "";
    if (trackClim) trackClim.innerHTML = "";
    trackPwf.innerHTML = "";
    trackSil.innerHTML = "";
    return;
  }

  // Regroupement par segments contigus (Run-Length Encoding) pour un rendu DOM ultra-léger
  const buildRuns = (extractor) => {
    const runs = [];
    for (let i = 0; i < cachedSeriesRows.length; i++) {
      const v = extractor(cachedSeriesRows[i]);
      if (!runs.length || runs[runs.length - 1].val !== v) {
        runs.push({ val: v, count: 1, startIdx: i, endIdx: i });
      } else {
        runs[runs.length - 1].count++;
        runs[runs.length - 1].endIdx = i;
      }
    }
    return runs;
  };

  const total = cachedSeriesRows.length;
  const stepSec = getAverageStepSeconds();
  const phaseRuns = buildRuns(r => getPhaseMeta(r).code);
  const autoRuns = buildRuns(r => r._isGap ? -1 : (Number(r.fun_auto_set ?? 0) > 0 ? 1 : 0));
  const climRuns = buildRuns(r => r._isGap ? -1 : ((Number(r.status_code) === 8 || Number(r.status_code) === 9 || Number(r.standby_enabled ?? 0) > 0) ? 1 : 0));
  const pwfRuns = buildRuns(r => r._isGap ? -1 : Number(r.fun_pwf_set ?? 0));
  const silRuns = buildRuns(r => r._isGap ? -1 : (Number(r.set_silece_set ?? 0) > 0 ? 1 : 0));

  const gapStyle = "bg-rose-950/30 border-x border-dashed border-rose-800/50";

  // PROPOSITION 1 : Ruban Maître des Phases + Étiquettes intégrées + Bilan des durées
  if (trackPhase) {
    trackPhase.innerHTML = phaseRuns.map(seg => {
      const pct = (seg.count / total) * 100;
      const w = pct.toFixed(3);
      const m = getPhaseMeta(seg.val);
      // Afficher le libellé court directement dans le ruban si le segment est assez large (> 8%)
      const innerTxt = pct >= 8.5
        ? `<span class="truncate px-1 text-[10px] font-extrabold tracking-tight drop-shadow">${m.icon} ${m.short}</span>`
        : (pct >= 4.0 ? `<span class="text-[10px]">${m.icon}</span>` : "");
      return `<div style="width:${w}%" class="h-full ${m.bgClass} border-r border-gray-950/40 flex items-center justify-center overflow-hidden select-none" title="${m.label}">${innerTxt}</div>`;
    }).join("");
  }

  // Calcul des durées cumulées par phase pour la barre de répartition (Prop. 1)
  const distBar = document.getElementById("prop1-distribution-bar");
  const durBadges = document.getElementById("prop1-duration-badges");
  const spanLbl = document.getElementById("prop1-total-span");
  if (distBar && durBadges) {
    const totalsByCode = {};
    phaseRuns.forEach(seg => {
      totalsByCode[seg.val] = (totalsByCode[seg.val] || 0) + seg.count;
    });
    const sortedCodes = Object.keys(totalsByCode)
      .map(Number)
      .sort((a, b) => totalsByCode[b] - totalsByCode[a]);

    const totalMinAll = Math.max(1, Math.round((total * stepSec) / 60));
    if (spanLbl) {
      const t0 = (cachedSeriesRows[0].timestamp || "").slice(11, 16);
      const t1 = (cachedSeriesRows[total - 1].timestamp || "").slice(11, 16);
      spanLbl.textContent = `Fenêtre : ${t0} ➔ ${t1} (~${formatDurationMin(totalMinAll)})`;
    }

    distBar.innerHTML = sortedCodes.map(code => {
      const cnt = totalsByCode[code];
      const pct = ((cnt / total) * 100).toFixed(2);
      const m = getPhaseMeta(code);
      return `<div style="width:${pct}%; background:${m.hex}" class="h-full" title="${m.label}: ${pct}%"></div>`;
    }).join("");

    durBadges.innerHTML = sortedCodes.map(code => {
      const cnt = totalsByCode[code];
      const pct = Math.round((cnt / total) * 100);
      const min = Math.round((cnt * stepSec) / 60);
      const m = getPhaseMeta(code);
      return `
        <span class="px-2.5 py-1 rounded-lg border text-[11px] font-semibold flex items-center gap-1.5 ${m.badgeClass}">
          <span>${m.icon}</span>
          <span>${escapeHtml(m.label)} :</span>
          <strong class="text-white">${formatDurationMin(min)}</strong>
          <span class="opacity-75 text-[10px]">(${pct}%)</span>
        </span>
      `;
    }).join("");
  }

  // PROPOSITION 4 : Frise chronologique des transitions de phases (cliquable pour inspecter)
  const transList = document.getElementById("prop4-transitions-list");
  if (transList) {
    transList.innerHTML = phaseRuns.map((seg, idxRun) => {
      const m = getPhaseMeta(seg.val);
      const tStart = (cachedSeriesRows[seg.startIdx].timestamp || "").slice(11, 16);
      const durMin = Math.max(1, Math.round((seg.count * stepSec) / 60));
      const midIdx = Math.floor((seg.startIdx + seg.endIdx) / 2);
      const pctMid = ((midIdx / Math.max(1, total - 1)) * 100).toFixed(2);
      const arrow = idxRun < phaseRuns.length - 1 ? `<span class="text-gray-600 font-bold">➔</span>` : "";
      return `
        <button onclick="setSynchronizedHoverIndex(${midIdx}, ${pctMid})"
          class="px-2.5 py-1 rounded-lg border text-left shrink-0 transition hover:scale-105 ${m.badgeClass}"
          title="Cliquer pour pointer sur cette phase (${tStart})">
          <div class="font-bold flex items-center gap-1">
            <span>${m.icon}</span>
            <span>${escapeHtml(m.short)}</span>
            <span class="text-[10px] opacity-80">(#${m.code})</span>
          </div>
          <div class="text-[10px] opacity-85 font-mono">${tStart} • ${formatDurationMin(durMin)}</div>
        </button>
        ${arrow}
      `;
    }).join("");
  }

  trackAuto.innerHTML = autoRuns.map(seg => {
    const w = ((seg.count / total) * 100).toFixed(3);
    const cls = seg.val === -1 ? gapStyle : (seg.val ? "bg-teal-500/80" : "bg-gray-900");
    return `<div style="width:${w}%" class="h-full ${cls}"></div>`;
  }).join("");

  if (trackClim) {
    trackClim.innerHTML = climRuns.map(seg => {
      const w = ((seg.count / total) * 100).toFixed(3);
      const cls = seg.val === -1 ? gapStyle : (seg.val ? "bg-cyan-500/85" : "bg-gray-900");
      return `<div style="width:${w}%" class="h-full ${cls}"></div>`;
    }).join("");
  }

  trackPwf.innerHTML = pwfRuns.map(seg => {
    const w = ((seg.count / total) * 100).toFixed(3);
    const cls = seg.val === -1 ? gapStyle : (seg.val === 1 ? "bg-orange-500/85" : (seg.val === 2 ? "bg-amber-500/75" : "bg-gray-900"));
    return `<div style="width:${w}%" class="h-full ${cls}"></div>`;
  }).join("");

  trackSil.innerHTML = silRuns.map(seg => {
    const w = ((seg.count / total) * 100).toFixed(3);
    const cls = seg.val === -1 ? gapStyle : (seg.val ? "bg-indigo-500/85" : "bg-gray-900");
    return `<div style="width:${w}%" class="h-full ${cls}"></div>`;
  }).join("");

  // Valeurs par défaut (dernier point)
  const last = cachedSeriesRows[cachedSeriesRows.length - 1] || {};
  document.getElementById("ribbon-val-auto").textContent = Number(last.fun_auto_set ?? 1) ? "ON" : "OFF";
  const climValEl = document.getElementById("ribbon-val-clim");
  const lastSt = Number(last.status_code ?? 0);
  if (climValEl) climValEl.textContent = (lastSt === 8 || lastSt === 9 || Number(last.standby_enabled ?? 0)) ? "ON" : "OFF";
  const pwfLast = Number(last.fun_pwf_set ?? 0);
  document.getElementById("ribbon-val-pwf").textContent = pwfLast === 2 ? "CRONO" : (pwfLast === 1 ? "ON" : "OFF");
  document.getElementById("ribbon-val-sil").textContent = Number(last.set_silece_set ?? 0) ? "ON" : "OFF";

  if (activeHoverIdx >= 0 && activeHoverIdx < cachedSeriesRows.length) {
    updatePhaseHoverViews(activeHoverIdx, true);
  } else {
    updatePhaseHoverViews(cachedSeriesRows.length - 1, false);
  }
  applyPhaseViewsVisibility();
}

function renderSeriesToggles() {
  const container = document.getElementById("series-toggles");
  if (!container) return;
  container.innerHTML = "";
  let activeCount = 0;
  SERIES_CONFIG.forEach(s => {
    if (s.visible) activeCount++;
    const val = latestData[s.key] !== undefined ? latestData[s.key] : getRegVal(s.key, "--");
    const btn = document.createElement("button");
    btn.onclick = () => {
      s.visible = !s.visible;
      updateChartDatasets();
      renderSeriesToggles();
    };
    btn.className = `px-2.5 py-1 rounded-full text-xs flex items-center gap-1.5 border transition tabular-nums ${s.visible ? "bg-gray-800 border-gray-600 text-white" : "bg-gray-950 border-gray-800 text-gray-500"
      }`;
    btn.innerHTML = `
      <span style="color:${s.color}" class="font-bold">${s.visible ? "●" : "○"}</span>
      <span>${escapeHtml(s.label)}</span>
      <strong class="ml-1 text-[11px] px-1.5 py-0.2 rounded bg-gray-900" style="color:${s.color}">${escapeHtml(val)} ${escapeHtml(s.unit)}</strong>
    `;
    container.appendChild(btn);
  });
  const mobLbl = document.getElementById("mob-series-drawer-label");
  if (mobLbl) mobLbl.textContent = `🎛️ Filtrer les courbes & Présélections (${activeCount} actives)`;
}

function applyPreset(preset) {
  SERIES_CONFIG.forEach(s => {
    if (preset === "ALL") s.visible = true;
    else if (preset === "NONE") s.visible = false;
    else if (preset === "SAFETY") s.visible = (s.key === "temp_probe_k" || s.key === "temp_fumes" || s.key === "depression_pa");
    else s.visible = (s.group === preset);
  });
  updateChartDatasets();
  renderSeriesToggles();
}

function updateChartDatasets() {
  if (!chartPane1 || !chartPane2) return;
  const labels = cachedSeriesRows.map(r => formatChartAxisLabel(r.timestamp));
  const buildDs = (paneNum) => SERIES_CONFIG.filter(s => s.visible && s.pane === paneNum).map(s => {
    const pts = cachedSeriesRows.map(r => {
      if (r._isGap) return null;
      const v = r[s.key];
      return (v !== undefined && v !== null) ? v : null;
    });
    return {
      label: `${s.label} (${s.unit})`,
      data: pts,
      spanGaps: false,
      borderColor: s.color,
      backgroundColor: s.color + "22",
      yAxisID: s.yAxisID,
      borderDash: s.dashed ? [5, 5] : [],
      borderWidth: 2,
      pointRadius: (ctx) => {
        const i = ctx.dataIndex;
        if (pts[i] === null) return 0;
        if (pts.length <= 5) return 3;
        const prevNull = i === 0 || pts[i - 1] === null;
        const nextNull = i === pts.length - 1 || pts[i + 1] === null;
        return (prevNull && nextNull) ? 2.5 : 0;
      },
      tension: 0.25
    };
  });

  chartPane1.data.labels = labels;
  chartPane1.data.datasets = buildDs(1);
  chartPane1.update("none");

  chartPane2.data.labels = labels;
  chartPane2.data.datasets = buildDs(2);
  chartPane2.update("none");

  renderBooleanRibbons();
  renderSecurityRibbons();
}
