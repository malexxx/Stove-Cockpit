// =============================================================================
// CHARTS — VOLET 4 : SÉCURITÉS, SONDES (TCK/TCJ) & CONTACTS HISTORISÉS
// =============================================================================

/**
 * Affiche la grille des 8 badges de sécurité matérielle (porte, pressostat, sondes K/J, blackout, trémie).
 * @param {Object} data Enregistrement télémétrique à afficher (point survolé ou dernier point).
 * @param {boolean} isHovering True si l'affichage correspond au curseur de survol.
 * @param {string} [timestamp] Horodatage du point inspecté.
 */
function renderSecurityBadges(data, isHovering, timestamp) {
  const secBox = document.getElementById("security-badges");
  if (!secBox) return;
  const d = data || latestData || {};
  const isGap = d._isGap;

  const itemsSec = [
    {
      label: "Porte foyer",
      icon: "🚪",
      fault: Number(d.popup_door_open ?? 0),
      okTxt: "Fermée",
      errTxt: "OUVERTE !"
    },
    {
      label: "Pressostat Pa",
      icon: "💨",
      fault: Number(d.popup_pa_fault ?? 0),
      okTxt: "OK",
      errTxt: "DÉFAUT Pa !"
    },
    {
      label: "Sonde K (TCK)",
      icon: "🔥",
      fault: Number(d.popup_tck_fault ?? 0),
      okTxt: "OK",
      errTxt: "DÉFAUT TCK !"
    },
    {
      label: "Sonde Fumées (TCJ)",
      icon: "🌡️",
      fault: Number(d.popup_tcj_fault ?? 0),
      okTxt: "OK",
      errTxt: "DÉFAUT TCJ !"
    },
    {
      label: "Secteur Blackout",
      icon: "⚡",
      fault: Number(d.blackout_popup ?? 0),
      okTxt: "Stable",
      errTxt: "COUPURE AL01 !"
    },
    {
      label: "Thermostats Ext.",
      icon: "🎛️",
      fault: 0,
      okTxt: `M:${Number(d.thermostat_main) ? "1" : "0"} G:${Number(d.thermostat_sx) ? "1" : "0"} D:${Number(d.thermostat_dx) ? "1" : "0"}`,
      isInfo: true
    },
    {
      label: "Trappe pellet",
      icon: "🌾",
      fault: Number(d.popup_pellet_open ?? 0),
      okTxt: "Fermée",
      errTxt: "OUVERTE !"
    },
    {
      label: "Trémie",
      icon: "🪣",
      fault: Number(d.popup_pellet_empty ?? 0),
      okTxt: "Niveau OK",
      errTxt: "VIDE !"
    }
  ];

  if (isGap) {
    secBox.innerHTML = itemsSec.map(i => `
      <div class="px-2 py-1 rounded border bg-rose-950/30 border-rose-800/50 text-rose-300 flex justify-between items-center text-[11px]">
        <span class="flex items-center gap-1 truncate"><span class="text-xs">${i.icon}</span> <span class="truncate">${i.label}</span></span>
        <span class="font-mono text-[10px] text-rose-400 shrink-0 ml-1">HORS LIGNE</span>
      </div>
    `).join("");
    return;
  }

  secBox.innerHTML = itemsSec.map(i => {
    let cls = "bg-gray-950 border-gray-800 text-gray-300";
    let valCls = "text-emerald-400 font-semibold";
    if (i.fault) {
      cls = "bg-rose-950/80 border-rose-600 text-rose-200 font-bold shadow-[0_0_8px_rgba(244,63,94,0.4)] animate-pulse";
      valCls = "text-rose-300 font-black";
    } else if (i.isInfo) {
      cls = "bg-gray-950 border-gray-800 text-gray-300";
      valCls = "text-sky-300 font-mono font-bold";
    }
    return `
      <div class="px-2 py-1 rounded border flex justify-between items-center text-[11px] ${cls}">
        <span class="flex items-center gap-1 truncate">
          <span class="shrink-0 text-xs">${i.icon}</span>
          <span class="truncate">${i.label} :</span>
        </span>
        <span class="tabular-nums shrink-0 ml-1 ${valCls}">${i.fault ? i.errTxt : i.okTxt}</span>
      </div>
    `;
  }).join("");

  const hoverLbl = document.getElementById("sec-hover-state");
  if (hoverLbl) {
    if (isHovering && timestamp) {
      hoverLbl.textContent = `Pointeur : ${timestamp.slice(11, 19) || timestamp}`;
      hoverLbl.className = "text-sky-400 text-[10px] font-mono font-bold";
    } else {
      hoverLbl.textContent = "Temps réel";
      hoverLbl.className = "text-emerald-400 text-[10px] font-mono font-bold";
    }
  }
}

function updateSecurityHoverViews(idx, isHovering) {
  const row = (isHovering && idx >= 0 && idx < cachedSeriesRows.length)
    ? cachedSeriesRows[idx]
    : (cachedSeriesRows[cachedSeriesRows.length - 1] || latestData || {});

  const isGap = row._isGap;

  const setRibbonVal = (id, fault, okTxt, errTxt, isInfo = false) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (isGap) {
      el.textContent = "HORS LIGNE";
      el.className = "ml-1 text-gray-500 font-mono";
      return;
    }
    if (isInfo) {
      el.textContent = okTxt;
      el.className = "ml-1 text-sky-300 font-mono font-bold";
      return;
    }
    if (fault) {
      el.textContent = errTxt;
      el.className = "ml-1 text-rose-300 font-extrabold";
    } else {
      el.textContent = okTxt;
      el.className = "ml-1 text-emerald-300";
    }
  };

  setRibbonVal("ribbon-val-door", Number(row.popup_door_open ?? 0) > 0, "Fermée (OK)", "OUVERTE !");
  setRibbonVal("ribbon-val-pa", Number(row.popup_pa_fault ?? 0) > 0, "OK (Pression nominale)", "DÉFAUT Pa !");
  setRibbonVal("ribbon-val-tck", Number(row.popup_tck_fault ?? 0) > 0, "OK (Thermocouple actif)", "DÉFAUT TCK !");
  setRibbonVal("ribbon-val-tcj", Number(row.popup_tcj_fault ?? 0) > 0, "OK (Sonde fumées active)", "DÉFAUT TCJ !");
  setRibbonVal("ribbon-val-blackout", Number(row.blackout_popup ?? 0) > 0, "Stable (Secteur 230V)", "COUPURE AL01 !");

  const mTh = Number(row.thermostat_main ?? 0) ? "1" : "0";
  const gTh = Number(row.thermostat_sx ?? 0) ? "1" : "0";
  const dTh = Number(row.thermostat_dx ?? 0) ? "1" : "0";
  setRibbonVal("ribbon-val-thermostats", false, `M:${mTh} | G:${gTh} | D:${dTh}`, "", true);

  const trapOpen = Number(row.popup_pellet_open ?? 0) > 0;
  setRibbonVal("ribbon-val-trap", trapOpen, "Fermée (OK)", "OUVERTE !");

  const hopperEmpty = Number(row.popup_pellet_empty ?? 0) > 0;
  setRibbonVal("ribbon-val-hoppersec", hopperEmpty, "Niveau OK", "VIDE !");

  renderSecurityBadges(row, isHovering, row.timestamp);
}

function renderSecurityRibbons() {
  const plotArea = document.getElementById("security-ribbons-plot-area");
  if (!plotArea) return;

  const trackDoor = document.getElementById("ribbon-track-door");
  const trackPa = document.getElementById("ribbon-track-pa");
  const trackTck = document.getElementById("ribbon-track-tck");
  const trackTcj = document.getElementById("ribbon-track-tcj");
  const trackBlackout = document.getElementById("ribbon-track-blackout");
  const trackThermostats = document.getElementById("ribbon-track-thermostats");
  const trackTrap = document.getElementById("ribbon-track-trap");
  const trackHopperSec = document.getElementById("ribbon-track-hoppersec");

  if (!cachedSeriesRows.length) {
    if (trackDoor) trackDoor.innerHTML = "";
    if (trackPa) trackPa.innerHTML = "";
    if (trackTck) trackTck.innerHTML = "";
    if (trackTcj) trackTcj.innerHTML = "";
    if (trackBlackout) trackBlackout.innerHTML = "";
    if (trackThermostats) trackThermostats.innerHTML = "";
    if (trackTrap) trackTrap.innerHTML = "";
    if (trackHopperSec) trackHopperSec.innerHTML = "";
    return;
  }

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
  const gapStyle = "bg-rose-950/30 border-x border-dashed border-rose-800/50";

  const renderBinaryTrack = (trackEl, extractor, okBg, errBg, okBorder = "border-emerald-900/30", errBorder = "border-rose-500/80") => {
    if (!trackEl) return;
    const runs = buildRuns(extractor);
    trackEl.innerHTML = runs.map(seg => {
      const w = ((seg.count / total) * 100).toFixed(3);
      let cls = gapStyle;
      if (seg.val === 0) {
        cls = `${okBg} border-r ${okBorder}`;
      } else if (seg.val > 0) {
        cls = `${errBg} border-r ${errBorder} font-bold shadow-[0_0_8px_rgba(244,63,94,0.6)]`;
      }
      return `<div style="width:${w}%" class="h-full ${cls}"></div>`;
    }).join("");
  };

  // 1. Porte Foyer (0 = Fermée, 1 = OUVERTE)
  renderBinaryTrack(
    trackDoor,
    r => r._isGap ? -1 : (Number(r.popup_door_open ?? 0) ? 1 : 0),
    "bg-emerald-950/70",
    "bg-rose-600 animate-pulse"
  );

  // 2. Pressostat Pa (0 = OK, 1 = DÉFAUT Pa)
  renderBinaryTrack(
    trackPa,
    r => r._isGap ? -1 : (Number(r.popup_pa_fault ?? 0) ? 1 : 0),
    "bg-emerald-950/70",
    "bg-rose-600"
  );

  // 3. Sonde K TCK (0 = OK, 1 = DÉFAUT TCK)
  renderBinaryTrack(
    trackTck,
    r => r._isGap ? -1 : (Number(r.popup_tck_fault ?? 0) ? 1 : 0),
    "bg-emerald-950/70",
    "bg-rose-600"
  );

  // 4. Sonde Fumées TCJ (0 = OK, 1 = DÉFAUT TCJ)
  renderBinaryTrack(
    trackTcj,
    r => r._isGap ? -1 : (Number(r.popup_tcj_fault ?? 0) ? 1 : 0),
    "bg-emerald-950/70",
    "bg-rose-600"
  );

  // 5. Secteur Blackout (0 = Stable, 1 = COUPURE AL01)
  renderBinaryTrack(
    trackBlackout,
    r => r._isGap ? -1 : (Number(r.blackout_popup ?? 0) ? 1 : 0),
    "bg-emerald-950/70",
    "bg-rose-600"
  );

  // 6. Thermostats Externes (M, SX, DX)
  if (trackThermostats) {
    const runsTh = buildRuns(r => {
      if (r._isGap) return -1;
      const m = Number(r.thermostat_main ?? 0) ? 1 : 0;
      const sx = Number(r.thermostat_sx ?? 0) ? 2 : 0;
      const dx = Number(r.thermostat_dx ?? 0) ? 4 : 0;
      return m + sx + dx;
    });
    trackThermostats.innerHTML = runsTh.map(seg => {
      const w = ((seg.count / total) * 100).toFixed(3);
      let cls = gapStyle;
      if (seg.val === 0) {
        cls = "bg-gray-900 border-r border-gray-800";
      } else if (seg.val > 0) {
        cls = "bg-sky-600/80 border-r border-sky-400/50";
      }
      return `<div style="width:${w}%" class="h-full ${cls}"></div>`;
    }).join("");
  }

  // 7. Trappe pellet (0 = Fermée, 1 = OUVERTE)
  renderBinaryTrack(
    trackTrap,
    r => r._isGap ? -1 : (Number(r.popup_pellet_open ?? 0) ? 1 : 0),
    "bg-emerald-950/70",
    "bg-rose-600 animate-pulse font-bold"
  );

  // 8. Trémie (0 = Niveau OK, 1 = VIDE)
  renderBinaryTrack(
    trackHopperSec,
    r => r._isGap ? -1 : (Number(r.popup_pellet_empty ?? 0) ? 1 : 0),
    "bg-[#382013]/80",
    "bg-rose-600 animate-pulse font-bold"
  );

  // Bilan Sécurités sur la période
  let anomaliesCount = 0;
  for (let i = 0; i < cachedSeriesRows.length; i++) {
    const r = cachedSeriesRows[i];
    if (r._isGap) continue;
    if (Number(r.popup_door_open ?? 0) || Number(r.popup_pa_fault ?? 0) ||
        Number(r.popup_tck_fault ?? 0) || Number(r.popup_tcj_fault ?? 0) ||
        Number(r.blackout_popup ?? 0) || Number(r.popup_pellet_open ?? 0) ||
        Number(r.popup_pellet_empty ?? 0)) {
      anomaliesCount++;
    }
  }

  const statEl = document.getElementById("sec-summary-status");
  const countEl = document.getElementById("sec-anomalies-count");
  if (statEl) {
    if (anomaliesCount === 0) {
      statEl.textContent = "100% Sécurisé (0 alerte)";
      statEl.className = "px-2.5 py-0.5 rounded font-bold bg-emerald-950 text-emerald-300 border border-emerald-800 text-xs";
    } else {
      statEl.textContent = `⚠️ ${anomaliesCount} point(s) en alerte détecté(s)`;
      statEl.className = "px-2.5 py-0.5 rounded font-bold bg-rose-950 text-rose-300 border border-rose-800 text-xs animate-pulse";
    }
  }
  if (countEl) {
    countEl.textContent = `${cachedSeriesRows.length} points analysés • ${anomaliesCount} anomalie(s)`;
  }

  if (activeHoverIdx >= 0 && activeHoverIdx < cachedSeriesRows.length) {
    updateSecurityHoverViews(activeHoverIdx, true);
  } else {
    updateSecurityHoverViews(cachedSeriesRows.length - 1, false);
  }
}
