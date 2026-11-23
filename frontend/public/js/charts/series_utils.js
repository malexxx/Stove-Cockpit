// =============================================================================
// CHARTS — NORMALISATION SÉRIES, COUPURES & GESTION DES VUES DE PHASES
// =============================================================================

/**
 * Formate un horodatage UNIX (en secondes) en chaîne locale "YYYY-MM-DD HH:MM:SS".
 * @param {number} epochSec Horodatage UNIX en secondes.
 * @returns {string} Date formatée en heure locale.
 */
function formatEpochToLocalStr(epochSec) {
  const d = new Date(Number(epochSec) * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Formate un horodatage "YYYY-MM-DD HH:MM:SS" (ou ISO) en libellé court d'axe "JJ/MM HH:MM".
 * @param {string} ts Horodatage brut.
 * @returns {string} Date formatée "JJ/MM HH:MM".
 */
function formatChartAxisLabel(ts) {
  const raw = String(ts || "").trim();
  if (!raw) return "";
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}:\d{2}))?/);
  if (m) {
    const datePart = `${m[3]}/${m[2]}`;
    return m[4] ? `${datePart} ${m[4]}` : datePart;
  }
  return raw.slice(5, 16);
}

/**
 * Formate un horodatage "YYYY-MM-DD HH:MM:SS" (ou ISO) en format français "JJ/MM/AAAA HH:MM:SS".
 * @param {string} ts Horodatage brut.
 * @returns {string} Horodatage formaté en JJ/MM/AAAA.
 */
function formatTimestampFR(ts) {
  const raw = String(ts || "").trim();
  if (!raw) return "--";
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?/);
  if (m) {
    const datePart = `${m[3]}/${m[2]}/${m[1]}`;
    return m[4] ? `${datePart} ${m[4]}` : datePart;
  }
  return raw;
}

/**
 * Détecte si une ligne de télémétrie correspond à une perte de connexion ou un buffer matériel vide.
 * Compatible à la fois avec la projection légère (`has_raw_buffer`) et les lignes complètes (`raw_buffer_json`).
 * @param {Object} r Enregistrement de télémétrie.
 * @returns {boolean} True si le point représente une coupure.
 */
function isConnectionLostRow(r) {
  if (!r) return true;
  if (r._isGap) return true;
  if (Number(r.status_code) === -1) return true;
  if (r.temp_ambient === null && r.temp_fumes === null) return true;
  if (r.comm_mode && r.comm_mode !== "simulation") {
    if (r.has_raw_buffer !== undefined) {
      return Number(r.has_raw_buffer) === 0;
    }
    if (!r.raw_buffer_json || r.raw_buffer_json === "{}") {
      return true;
    }
  }
  return false;
}

/**
 * Insère des points de rupture (`_isGap = true`) lors des coupures télémétriques et calcule
 * la moyenne glissante d'écart thermique de flamme lorsque absente.
 * @param {Array<Object>} rawRows Série brute chronologique retournée par `/api/dashboard`.
 * @returns {Array<Object>} Série normalisée prête pour Chart.js et les rubans.
 */
function normalizeSeriesWithGaps(rawRows) {
  if (!Array.isArray(rawRows) || !rawRows.length) return [];

  const pollSec = Math.max(30, Number((currentSettings && currentSettings.poll_interval_s) || 120));
  const rangeDurations = {
    "3h": 3 * 3600,
    "6h": 6 * 3600,
    "24h": 24 * 3600,
    "7j": 7 * 86400,
    "30j": 30 * 86400,
    "3M": 90 * 86400
  };
  const bucketSec = Math.max(1, Math.floor((rangeDurations[currentRange] || 86400) / 360));
  const expectedStepSec = Math.max(pollSec, bucketSec);
  const gapThresholdSec = Math.max(expectedStepSec * 2.5, 300);

  const out = [];
  for (let i = 0; i < rawRows.length; i++) {
    const curr = { ...rawRows[i] };
    if (isConnectionLostRow(curr)) {
      curr._isGap = true;
    }

    if (out.length > 0) {
      const prev = out[out.length - 1];
      const prevEpoch = Number(prev.epoch || 0);
      const currEpoch = Number(curr.epoch || 0);
      const dt = currEpoch - prevEpoch;

      if (prevEpoch > 0 && currEpoch > 0 && dt > gapThresholdSec) {
        const gapMin = Math.round(dt / 60);
        // Nombre de crans vides proportionnel à la durée de coupure (borné entre 2 et 10 pour garder une échelle lisible)
        const numSlots = Math.min(10, Math.max(2, Math.round(dt / expectedStepSec) - 1));
        for (let k = 1; k <= numSlots; k++) {
          const interpEpoch = Math.round(prevEpoch + (dt * k) / (numSlots + 1));
          out.push({
            _isGap: true,
            _gapDurationMin: gapMin,
            epoch: interpEpoch,
            timestamp: formatEpochToLocalStr(interpEpoch),
            status_code: -1,
            status_label: `Perte de connexion (${gapMin} min)`
          });
        }
      }
    }
    out.push(curr);
  }

  // Lissage de l'écart thermique sur les points de combustion active (moyenne glissante)
  const windowSize = 8;
  for (let i = 0; i < out.length; i++) {
    const r = out[i];
    if (r._isGap || Number(r.status_code) !== 5) {
      if (r.flame_delta_avg === undefined) r.flame_delta_avg = null;
      continue;
    }
    if (r.flame_delta_avg === undefined || r.flame_delta_avg === null || r.flame_delta_avg === 0) {
      const pwr = Number(r.power_actual ?? r.power_level ?? 4);
      const cmd = Number(r.power_level ?? pwr);
      const targetFlame = 430.0 + (pwr * 40.0);
      const instantDelta = Number(r.temp_probe_k ?? targetFlame) - targetFlame;
      let sum = instantDelta;
      let count = 1;
      let powerChanged = false;
      for (let j = i - 1; j >= Math.max(0, i - windowSize); j--) {
        const pj = out[j];
        if (pj._isGap || Number(pj.status_code) !== 5) {
          powerChanged = true;
          break;
        }
        const pwrJ = Number(pj.power_actual ?? pj.power_level ?? 4);
        const cmdJ = Number(pj.power_level ?? pwrJ);
        if (pwrJ !== pwr || cmdJ !== cmd) {
          powerChanged = true;
          break;
        }
        if (pj.temp_probe_k) {
          sum += (Number(pj.temp_probe_k) - targetFlame);
          count++;
        }
      }
      if (!powerChanged && count >= windowSize) {
        r.flame_delta_avg = Math.round((sum / count) * 10) / 10;
      } else {
        r.flame_delta_avg = null;
      }
    }
  }

  return out;
}

// Formate une durée en minutes en "Xh YYm" ou "X min"
function formatDurationMin(totalMin) {
  const m = Math.max(0, Math.round(totalMin));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h${String(rem).padStart(2, "0")}` : `${h}h`;
}

// Calcule le pas moyen en secondes entre deux points de la série courante
function getAverageStepSeconds() {
  if (!cachedSeriesRows || cachedSeriesRows.length < 2) return 120;
  const firstEpoch = Number(cachedSeriesRows[0].epoch || 0);
  const lastEpoch = Number(cachedSeriesRows[cachedSeriesRows.length - 1].epoch || 0);
  if (lastEpoch > firstEpoch) {
    return Math.max(10, (lastEpoch - firstEpoch) / (cachedSeriesRows.length - 1));
  }
  return 120;
}

// Active / désactive indépendamment chacune des 4 vues de phases (1, 2, 3, 4) avec superposition libre
function togglePhaseView(propKey) {
  if (!activePhaseViews || typeof activePhaseViews !== "object") {
    activePhaseViews = { prop1: true, prop2: true, prop3: true, prop4: true };
  }
  activePhaseViews[propKey] = !activePhaseViews[propKey];
  try {
    localStorage.setItem("nobis_active_phase_views", JSON.stringify(activePhaseViews));
  } catch (e) {}
  applyPhaseViewsVisibility();
}

function applyPhaseViewsVisibility() {
  const show1 = !!activePhaseViews.prop1;
  const show2 = !!activePhaseViews.prop2;
  const show3 = !!activePhaseViews.prop3;
  const show4 = !!activePhaseViews.prop4;

  document.querySelectorAll("#phase-prop-tabs button").forEach(btn => {
    const k = btn.getAttribute("data-prop");
    const isAct = !!activePhaseViews[k];
    const checkEl = btn.querySelector(".prop-check");
    if (checkEl) checkEl.textContent = isAct ? "●" : "○";
    btn.className = isAct
      ? "px-3 py-1.5 rounded-lg text-xs font-bold border transition flex items-center gap-1.5 bg-orange-600 border-orange-400 text-white shadow"
      : "px-3 py-1.5 rounded-lg text-xs font-semibold border transition flex items-center gap-1.5 bg-gray-950 border-gray-800 text-gray-400 hover:text-white";
  });

  const rowPhase = document.getElementById("ribbon-row-phase");
  const foot1 = document.getElementById("prop1-summary-footer");
  if (rowPhase) rowPhase.classList.toggle("hidden", !show1);
  if (foot1) foot1.classList.toggle("hidden", !show1);

  const tb2 = document.getElementById("phase-prop2-toolbar");
  if (tb2) tb2.classList.toggle("hidden", !show2);

  const badge3 = document.getElementById("hover-phase-badge");
  const insp3 = document.getElementById("phase-prop3-inspector");
  if (badge3) badge3.classList.toggle("hidden", !show3);
  if (insp3) insp3.classList.toggle("hidden", !show3);

  const box4 = document.getElementById("phase-prop4-container");
  if (box4) box4.classList.toggle("hidden", !show4);

  if (activeHoverIdx >= 0 && activeHoverIdx < cachedSeriesRows.length) {
    updatePhaseHoverViews(activeHoverIdx, true);
  } else if (cachedSeriesRows.length) {
    updatePhaseHoverViews(cachedSeriesRows.length - 1, false);
  }
  if (chartPane1) chartPane1.draw();
  if (chartPane2) chartPane2.draw();
}

function setPhaseBgOpacity(val) {
  phaseBgOpacity = Number(val) || 0.12;
  document.querySelectorAll(".prop2-op-btn").forEach(btn => {
    const isAct = Math.abs(Number(btn.getAttribute("data-op")) - phaseBgOpacity) < 0.005;
    btn.className = isAct
      ? "prop2-op-btn px-2 py-0.5 rounded bg-amber-600 text-white font-bold border border-amber-400"
      : "prop2-op-btn px-2 py-0.5 rounded bg-gray-800 text-gray-300 border border-gray-700";
  });
  if (chartPane1) chartPane1.draw();
  if (chartPane2) chartPane2.draw();
}
