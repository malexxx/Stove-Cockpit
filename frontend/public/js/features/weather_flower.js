// =============================================================================
// FEATURE MÉTÉO & FLEUR — PRÉVISIONS OPEN-METEO, DJU & CYCLE DE VIE 11 PHASES
// =============================================================================

let hoveredFlowerPetal = 0;
let flowerPreviewResetTimer = null;

// Colorise dynamiquement le bandeau sous la couronne selon la phase active ou survolée
function applyFlowerBannerTheme(phaseCode) {
  const banner = document.getElementById("flower-status-banner");
  const meta = getPhaseMeta(phaseCode);
  if (!banner || !meta) return;

  const isOff = (Number(phaseCode) === 0);
  const bgAlphaStart = isOff ? 0.22 : 0.28;
  const bgAlphaEnd = isOff ? 0.10 : 0.12;
  const borderAlpha = isOff ? 0.55 : 0.75;

  banner.style.background = `linear-gradient(135deg, rgba(${meta.rgb}, ${bgAlphaStart}) 0%, rgba(15, 23, 42, 0.92) 65%, rgba(${meta.rgb}, ${bgAlphaEnd}) 100%)`;
  banner.style.borderColor = `rgba(${meta.rgb}, ${borderAlpha})`;
  banner.style.borderLeftColor = meta.hex;
  banner.style.boxShadow = isOff
    ? "inset 0 1px 2px rgba(0,0,0,0.4)"
    : `0 0 16px rgba(${meta.rgb}, 0.22), inset 0 1px 2px rgba(255,255,255,0.06)`;
}

function svgDjuDeltaDegreeIcon(cls = "w-4 h-4 text-orange-400 inline-block align-middle shrink-0") {
  return `<svg viewBox="0 0 24 24" class="${cls}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="9.5,6.5 17,20 2,20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" /><circle cx="18.5" cy="6" r="2.2" fill="none" stroke="currentColor" stroke-width="2" /></svg>`;
}

function showDjuInfoModal(event) {
  if (event) {
    if (typeof event.stopPropagation === "function") event.stopPropagation();
    if (typeof event.preventDefault === "function") event.preventDefault();
  }
  showActionModal({
    title: `<span class="flex items-center gap-2">${svgDjuDeltaDegreeIcon("w-4 h-4 text-orange-400")}<span>Degré Jour Unifié (DJU) — Qu'est-ce que c'est ?</span></span>`,
    htmlContent: `
      <div class="space-y-3 text-xs text-gray-200">
        <p class="leading-relaxed">
          Le <b class="text-orange-400">DJU (Degré Jour Unifié)</b> est un indicateur thermique et météorologique standardisé qui mesure la <b>rigueur du froid extérieur</b> par rapport au besoin de chauffage du logement.
        </p>

        <div class="bg-gray-900/90 border border-orange-500/30 rounded-xl p-3 space-y-2">
          <div class="text-orange-300 font-semibold text-xs flex items-center gap-1.5">
            <span>🌡️</span><span>Méthode de calcul (Base 19°C)</span>
          </div>
          <p class="text-gray-300 text-[11px] leading-relaxed">
            Il mesure l'écart entre la température extérieure moyenne d'une journée et la consigne de confort intérieur (fixée à <b>19 °C</b>) :
          </p>
          <div class="bg-black/50 rounded-lg p-2 text-center font-mono text-orange-200 text-xs border border-orange-900/40">
            DJU = 19°C − Température extérieure moyenne
          </div>
          <ul class="text-[11px] text-gray-400 space-y-1 list-disc list-inside">
            <li>Si T°ext = 7°C ➔ 19 − 7 = <b class="text-orange-300">12 DJU</b> nécessaires.</li>
            <li>Si T°ext &ge; 19°C ➔ <b class="text-emerald-400">0 DJU</b> (aucun besoin de chauffage).</li>
          </ul>
        </div>

        <div class="bg-gray-900/90 border border-sky-800/40 rounded-xl p-3 space-y-1.5">
          <div class="text-sky-300 font-semibold text-xs flex items-center gap-1.5">
            ${svgDjuDeltaDegreeIcon("w-3.5 h-3.5 text-sky-400")}<span>Son rôle dans Nobis.Supervisor</span>
          </div>
          <ul class="text-[11px] text-gray-300 space-y-2 leading-relaxed">
            <li class="flex items-start gap-1.5">
              <span class="text-orange-400 font-bold">•</span>
              <span><b>Consommation prédictive :</b> Chaque DJU correspond à environ <b>~0,78 kg de granulés</b> brûlés pour maintenir la maison à température.</span>
            </li>
            <li class="flex items-start gap-1.5">
              <span class="text-emerald-400 font-bold">•</span>
              <span><b>Autonomie du stock (14 jours) :</b> En croisant les DJU prévus par Open-Meteo avec votre stock de sacs, Nobis anticipe le jour exact d'épuisement des pellets.</span>
            </li>
          </ul>
        </div>
      </div>
    `,
    confirmText: "Compris",
    showCancel: false,
    onConfirm: () => { }
  });
}

function openWeatherModal() {
  const modal = document.getElementById("weather-modal");
  if (!modal) return;
  renderWeatherModalData();
  modal.classList.remove("hidden");
}

function closeWeatherModal() {
  const modal = document.getElementById("weather-modal");
  if (modal) modal.classList.add("hidden");
}

function renderWeatherModalData() {
  const city = (currentSettings && currentSettings.weather_city) || "Paris (75000)";
  const lat = (currentSettings && currentSettings.weather_lat) || "48.8566";
  const lon = (currentSettings && currentSettings.weather_lon) || "2.3522";

  const wDetails = latestData.weather_details || {};
  const tempExt = latestData.weather_temp_ext ?? wDetails.weather_temp_ext;
  const humExt = latestData.weather_humidity ?? wDetails.weather_humidity;
  const windExt = latestData.weather_wind_kmh ?? wDetails.weather_wind_kmh;

  const tNum = tempExt !== undefined && tempExt !== null ? Number(tempExt) : null;
  const djuNow = tNum !== null && !isNaN(tNum) ? Math.max(0, 19.0 - tNum) : null;
  const estKg = djuNow !== null ? Math.max(3.5, djuNow * 0.78) : null;

  const cityEl = document.getElementById("w-modal-city");
  if (cityEl) cityEl.textContent = city;
  const coordsEl = document.getElementById("w-modal-coords");
  if (coordsEl) coordsEl.textContent = `(${lat}, ${lon})`;

  const tempEl = document.getElementById("w-modal-temp");
  if (tempEl) tempEl.textContent = tNum !== null && !isNaN(tNum) ? tNum.toFixed(1) : "--";
  const humEl = document.getElementById("w-modal-hum");
  if (humEl) humEl.textContent = humExt !== undefined && humExt !== null ? Number(humExt).toFixed(0) : "--";
  const windEl = document.getElementById("w-modal-wind");
  if (windEl) windEl.textContent = windExt !== undefined && windExt !== null ? Number(windExt).toFixed(1) : "--";

  const djuEl = document.getElementById("w-modal-dju");
  if (djuEl) djuEl.textContent = djuNow !== null ? djuNow.toFixed(1) : "--";
  const estKgEl = document.getElementById("w-modal-est-kg");
  if (estKgEl) estKgEl.textContent = estKg !== null ? estKg.toFixed(1) : "--";

  const updatedEl = document.getElementById("w-modal-updated");
  if (updatedEl) {
    const ts = latestData.timestamp || "";
    updatedEl.textContent = ts ? `(${ts})` : "";
  }

  const listEl = document.getElementById("w-modal-forecast-list");
  if (!listEl) return;

  const means = Array.isArray(wDetails.forecast_daily_means) ? wDetails.forecast_daily_means : [];
  const mins = Array.isArray(wDetails.forecast_daily_mins) ? wDetails.forecast_daily_mins : [];
  const maxs = Array.isArray(wDetails.forecast_daily_maxs) ? wDetails.forecast_daily_maxs : [];
  const dates = Array.isArray(wDetails.forecast_daily_dates) ? wDetails.forecast_daily_dates : [];

  if (means.length === 0) {
    listEl.innerHTML = `<div class="py-2 text-gray-500 text-center text-[11px]">Aucune prévision journalière en cache.</div>`;
    return;
  }

  const dayNames = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];
  const now = new Date();
  listEl.innerHTML = means.map((mVal, idx) => {
    const dObj = dates[idx] ? new Date(dates[idx] + "T12:00:00") : new Date(now.getTime() + idx * 86400000);
    const dayLbl = idx === 0
      ? "Aujourd'hui"
      : `${dayNames[dObj.getDay()]} ${String(dObj.getDate()).padStart(2, "0")}/${String(dObj.getMonth() + 1).padStart(2, "0")}`;
    const meanT = Number(mVal);
    const minT = mins[idx] !== undefined ? Number(mins[idx]) : (meanT - 3.2);
    const maxT = maxs[idx] !== undefined ? Number(maxs[idx]) : (meanT + 3.2);
    const djuDay = Math.max(0, 19.0 - meanT);
    const kgDay = Math.max(3.5, djuDay * 0.78);

    return `
      <div class="py-1.5 flex items-center justify-between gap-2 tabular-nums">
        <span class="font-medium ${idx === 0 ? 'text-sky-300 font-bold' : 'text-gray-300'} w-24 truncate">${dayLbl}</span>
        <span class="text-[11px] text-gray-400">
          <b class="text-cyan-400">${minT.toFixed(1)}°</b> / <b class="text-white">${meanT.toFixed(1)}°</b> / <b class="text-amber-400">${maxT.toFixed(1)}°</b>
        </span>
        <span class="text-[11px] text-orange-300 font-semibold text-right">Δ° ${djuDay.toFixed(1)} (~${kgDay.toFixed(1)}kg)</span>
      </div>
    `;
  }).join("");
}

function openLifecycleFlowerModal() {
  const modal = document.getElementById("lifecycle-flower-modal");
  if (!modal) return;
  modal.classList.remove("hidden");
  restoreFlowerPetalPreview();
}

function closeLifecycleFlowerModal() {
  const modal = document.getElementById("lifecycle-flower-modal");
  if (modal) modal.classList.add("hidden");
}

function previewFlowerPetal(phaseCode, isExplicitAction = false) {
  if (flowerPreviewResetTimer) {
    clearTimeout(flowerPreviewResetTimer);
    flowerPreviewResetTimer = null;
  }
  hoveredFlowerPetal = Number(phaseCode) || 0;
  const meta = getPhaseMeta(phaseCode);
  const stateEl = document.getElementById("hdr-state");
  if (stateEl && meta) {
    stateEl.textContent = meta.label;
  }
  const descEl = document.getElementById("flower-status-desc");
  if (descEl && meta) {
    descEl.textContent = meta.desc || "";
  }
  applyFlowerBannerTheme(phaseCode);
  const st = Number(latestData.status_code ?? 0);
  const alarm = Number(latestData.alarm_code ?? 0);
  const blackout = Number(latestData.blackout_popup ?? 0);
  const isAlarm = (st === 10 || st === 11 || alarm > 0 || blackout > 0);
  renderLifecycleFlower(st, isAlarm);

  const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0) || (window.matchMedia && window.matchMedia('(pointer: coarse)').matches);

  // Sur smartphone / tactile ou sur clic explicite : désélection automatique après 3 secondes
  if (isExplicitAction || isTouchDevice) {
    flowerPreviewResetTimer = setTimeout(() => {
      restoreFlowerPetalPreview();
    }, 3000);
  } else {
    // Survol souris desktop : filet de sécurité
    flowerPreviewResetTimer = setTimeout(() => {
      const anyHovered = document.querySelector("#lifecycle-flower-petals .flower-petal-group:hover");
      if (!anyHovered) {
        restoreFlowerPetalPreview();
      }
    }, 2500);
  }
}

function scheduleFlowerPetalRestore(delayMs = 900) {
  if (flowerPreviewResetTimer) {
    clearTimeout(flowerPreviewResetTimer);
  }
  flowerPreviewResetTimer = setTimeout(() => {
    restoreFlowerPetalPreview();
  }, delayMs);
}

function restoreFlowerPetalPreview() {
  if (flowerPreviewResetTimer) {
    clearTimeout(flowerPreviewResetTimer);
    flowerPreviewResetTimer = null;
  }
  hoveredFlowerPetal = 0;
  if (document.activeElement && typeof document.activeElement.blur === "function") {
    document.activeElement.blur();
  }
  const st = Number(latestData.status_code ?? 0);
  const alarm = Number(latestData.alarm_code ?? 0);
  const blackout = Number(latestData.blackout_popup ?? 0);
  const isAlarm = (st === 10 || st === 11 || alarm > 0 || blackout > 0);
  const bannerThemeCode = isAlarm ? (st === 11 ? 11 : 10) : st;
  const curMeta = getPhaseMeta(bannerThemeCode);
  const stateEl = document.getElementById("hdr-state");
  if (stateEl) {
    stateEl.textContent = latestData.status_label || (curMeta ? curMeta.label : "--");
  }
  const descEl = document.getElementById("flower-status-desc");
  if (descEl) {
    descEl.textContent = curMeta ? (curMeta.desc || "") : "";
  }
  applyFlowerBannerTheme(bannerThemeCode);
  renderLifecycleFlower(st, isAlarm);
}

function polarToXY(r, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  return [
    Number((r * Math.sin(rad)).toFixed(2)),
    Number((-r * Math.cos(rad)).toFixed(2))
  ];
}

function buildChevronPath(theta1, theta2, rIn, rMid, rOut, tipDeltaDeg) {
  const [x1, y1] = polarToXY(rIn, theta1);
  const [x2, y2] = polarToXY(rMid, theta1 + tipDeltaDeg);
  const [x3, y3] = polarToXY(rOut, theta1);
  const [x4, y4] = polarToXY(rOut, theta2);
  const [x5, y5] = polarToXY(rMid, theta2 + tipDeltaDeg);
  const [x6, y6] = polarToXY(rIn, theta2);
  return `M ${x1} ${y1} L ${x2} ${y2} L ${x3} ${y3} A ${rOut} ${rOut} 0 0 1 ${x4} ${y4} L ${x5} ${y5} L ${x6} ${y6} A ${rIn} ${rIn} 0 0 0 ${x1} ${y1} Z`;
}

// Génère et met à jour la couronne des 11 chevrons (#1 à #11) sans détruire les nœuds DOM au survol
function renderLifecycleFlower(st, isAlarm) {
  const petalsGroup = document.getElementById("lifecycle-flower-petals");
  if (!petalsGroup) return;

  const liveActiveCode = isAlarm ? (st === 11 ? 11 : 10) : (st >= 1 && st <= 11 ? st : 0);
  const totalPetals = 11;
  const stepDeg = 360 / totalPetals;

  // Création initiale unique des 11 groupes SVG si pas encore présents
  if (petalsGroup.children.length !== totalPetals) {
    let initHtml = "";
    for (let p = 1; p <= totalPetals; p++) {
      const meta = getPhaseMeta(p);
      initHtml += `
        <g class="flower-petal-group"
           data-petal="${p}"
           style="--petal-glow: ${meta.hex};"
           onmouseenter="previewFlowerPetal(${p})"
           onmouseleave="scheduleFlowerPetalRestore(900)"
           ontouchend="previewFlowerPetal(${p}, true)"
           onclick="previewFlowerPetal(${p}, true)">
          <title>${escapeHtml(meta.label)} : ${escapeHtml(meta.desc)}</title>
          <path class="flower-petal-path" stroke-linejoin="round" />
          <text text-anchor="middle" dominant-baseline="central" class="pointer-events-none select-none">${meta.icon}</text>
        </g>
      `;
    }
    petalsGroup.innerHTML = initHtml;
  }

  for (let p = 1; p <= totalPetals; p++) {
    const meta = getPhaseMeta(p);
    const angleDeg = (p - 1) * stepDeg;
    const isLiveActive = (p === liveActiveCode);
    const isHovered = (p === hoveredFlowerPetal);
    const isHighlighted = isLiveActive || isHovered;

    const fillStyle = isHighlighted
      ? `rgba(${meta.rgb}, 0.92)`
      : `rgba(${meta.rgb}, 0.18)`;
    const strokeStyle = isHighlighted
      ? "#ffffff"
      : `rgba(${meta.rgb}, 0.58)`;
    const strokeW = isHighlighted ? "2.2" : "1.3";

    const halfSpan = (stepDeg - 2.6) / 2;
    const t1 = angleDeg - halfSpan;
    const t2 = angleDeg + halfSpan;
    const rIn = isHighlighted ? 37 : 38;
    const rOut = isHighlighted ? 97 : 94;
    const rMid = (rIn + rOut) / 2;
    const chevronD = buildChevronPath(t1, t2, rIn, rMid, rOut, 4.2);
    const [cx, cy] = polarToXY(rMid, angleDeg + 2.2);

    const gEl = petalsGroup.children[p - 1];
    if (!gEl) continue;
    gEl.setAttribute("class", `flower-petal-group ${isLiveActive ? "flower-petal-active" : ""}`);

    const pathEl = gEl.querySelector("path");
    if (pathEl) {
      pathEl.setAttribute("d", chevronD);
      pathEl.setAttribute("fill", fillStyle);
      pathEl.setAttribute("stroke", strokeStyle);
      pathEl.setAttribute("stroke-width", strokeW);
    }

    const textEl = gEl.querySelector("text");
    if (textEl) {
      textEl.setAttribute("x", cx);
      textEl.setAttribute("y", cy);
      textEl.setAttribute("font-size", isHighlighted ? "15" : "13");
      textEl.setAttribute("opacity", isHighlighted ? "1" : "0.88");
    }
  }
}
