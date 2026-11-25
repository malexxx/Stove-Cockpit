// =============================================================================
// FEATURE SILENCE — MODE SILENCE INTELLIGENT, COMPTE À REBOURS & MODALE
// =============================================================================

let selectedSilenceHours = 2.0;
let lastSilenceRemaining = null;

/**
 * Formate une durée en secondes au format horloge "HH:MM:SS".
 * @param {number} seconds Durée restante en secondes.
 * @returns {string} Chaîne formatée HH:MM:SS.
 */
function formatSilenceCountdown(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/**
 * Force une mise à jour complète du cockpit Tri-Arc lors d'une transition d'état du mode Silence.
 */
function updateSilenceButtonState() {
  if (typeof renderTriArcCockpit === "function") {
    renderTriArcCockpit();
  }
}

/**
 * Met à jour le compte à rebours du mode Silence à 1 Hz de façon ciblée (nœuds texte uniquement)
 * sans reconstruire le SVG Tri-Arc complet chaque seconde.
 */
function updateSilenceCountdownDisplay() {
  if (!window.stoveProvider?.isContainerActive?.()) {
    lastSilenceRemaining = 0;
    return;
  }
  if (!silenceModeState) return;
  if (silenceModeState.active) {
    const remSec = Math.max(0, Math.round(silenceModeState.end_epoch - Date.now() / 1000));
    silenceModeState.remaining_seconds = remSec;

    if (remSec <= 0 && lastSilenceRemaining > 0) {
      silenceModeState.active = false;
      updateSilenceButtonState();
      showToast("Compte à rebours Silence ! terminé : valeurs initiales restaurées.");
      if (typeof refreshLatestOnly === "function") refreshLatestOnly();
    } else if (remSec > 0) {
      const btnTimerEl = document.getElementById("triarc-silence-btn-timer");
      const bubbleTimerEl = document.getElementById("triarc-silence-bubble-timer");
      if (!btnTimerEl) {
        updateSilenceButtonState();
      } else {
        const shortTxt = `${Math.floor(remSec / 3600)}h${String(Math.floor((remSec % 3600) / 60)).padStart(2, "0")}`;
        if (btnTimerEl.textContent !== shortTxt) {
          btnTimerEl.textContent = shortTxt;
        }
        if (bubbleTimerEl) {
          bubbleTimerEl.textContent = `🤫 Timer Silence (${formatSilenceCountdown(remSec)})`;
        }
      }
    }
    lastSilenceRemaining = remSec;
  } else {
    lastSilenceRemaining = 0;
  }
}

function openSilenceModal() {
  if (!window.stoveProvider?.isContainerActive?.()) {
    showToast("Le mode Silence est géré uniquement par le conteneur (Mode « + »).", true);
    return;
  }
  const modal = document.getElementById("silence-modal");
  if (!modal) return;
  setSilenceDurationPreset(2);
  modal.classList.remove("hidden");
}

function closeSilenceModal() {
  const modal = document.getElementById("silence-modal");
  if (modal) modal.classList.add("hidden");
}

function setSilenceDurationPreset(hours) {
  selectedSilenceHours = Number(hours);
  const inp = document.getElementById("silence-hours-input");
  if (inp) inp.value = hours;

  document.querySelectorAll(".sil-preset-btn").forEach((btn, idx) => {
    const btnHours = [1, 2, 3, 4][idx];
    if (btnHours === hours) {
      btn.className = "sil-preset-btn py-2 px-2 text-xs font-bold rounded-lg border border-purple-500 bg-purple-900/50 text-purple-200 shadow hover:border-purple-400 transition";
    } else {
      btn.className = "sil-preset-btn py-2 px-2 text-xs font-bold rounded-lg border border-gray-800 bg-gray-900 text-gray-300 hover:border-purple-600 transition";
    }
  });

  const confirmBtn = document.getElementById("silence-modal-confirm-btn");
  if (confirmBtn) {
    confirmBtn.innerHTML = `<span>Activer Silence ! (${hours}H)</span>`;
  }
}

function handleSilenceDurationInput() {
  const inp = document.getElementById("silence-hours-input");
  if (!inp) return;
  let val = parseFloat(inp.value);
  if (isNaN(val) || val <= 0) val = 1;
  selectedSilenceHours = val;

  document.querySelectorAll(".sil-preset-btn").forEach((btn, idx) => {
    const btnHours = [1, 2, 3, 4][idx];
    if (btnHours === val) {
      btn.className = "sil-preset-btn py-2 px-2 text-xs font-bold rounded-lg border border-purple-500 bg-purple-900/50 text-purple-200 shadow hover:border-purple-400 transition";
    } else {
      btn.className = "sil-preset-btn py-2 px-2 text-xs font-bold rounded-lg border border-gray-800 bg-gray-900 text-gray-300 hover:border-purple-600 transition";
    }
  });

  const confirmBtn = document.getElementById("silence-modal-confirm-btn");
  if (confirmBtn) {
    confirmBtn.innerHTML = `<span>Activer Silence ! (${val}H)</span>`;
  }
}

async function confirmActivateSilence() {
  closeSilenceModal();
  if (!window.stoveProvider?.isContainerActive?.()) {
    showToast("Le mode Silence est géré uniquement par le conteneur (Mode « + »).", true);
    return;
  }
  const hours = selectedSilenceHours || 2.0;
  try {
    showToast(`Activation du mode Silence ! pour ${hours}H en cours...`);
    const data = await window.stoveProvider.activateSilence(hours);
    if (data.silence_mode) {
      silenceModeState = data.silence_mode;
    } else {
      silenceModeState = {
        active: true,
        duration_hours: hours,
        end_epoch: Date.now() / 1000 + hours * 3600,
        remaining_seconds: hours * 3600
      };
    }
    updateSilenceButtonState();
    if (typeof refreshLatestOnly === "function") await refreshLatestOnly();
    if (typeof loadAudit === "function") await loadAudit();
    const isStoveOn = data.silence_mode && typeof data.silence_mode.is_stove_on === "boolean" ? data.silence_mode.is_stove_on : (Number(latestData.status_code ?? 0) !== 0);
    if (isStoveOn) {
      const canWriteEco = Boolean(typeof getActiveCapabilities === "function" && getActiveCapabilities()?.can_write_eco);
      showToast(`Mode Silence ! intelligent actif (${hours}H) : ${canWriteEco ? "Boost/Éco/Chrono coupés" : "Boost/Chrono coupés"}, Auto total actif, consignes en hors gel 7°C.`);
    } else {
      showToast(`Mode Silence ! intelligent actif (${hours}H) : poêle éteint, consignes passées en hors gel (7°C).`);
    }
  } catch (e) {
    showToast("Erreur activation Silence ! : " + (e?.message || "Échec"), true);
  }
}

async function deactivateSilenceMode(overrideCommands = null) {
  if (!window.stoveProvider?.isContainerActive?.()) return;
  try {
    showToast(overrideCommands ? "Désactivation du mode Silence ! et application de la consigne..." : "Restauration des valeurs initiales en cours...");
    const data = await window.stoveProvider.deactivateSilence(overrideCommands);
    silenceModeState = data.silence_mode || { active: false, remaining_seconds: 0, end_epoch: 0 };
    updateSilenceButtonState();
    if (typeof refreshLatestOnly === "function") await refreshLatestOnly();
    if (window.stoveProvider?.isContainerActive?.() && typeof loadAudit === "function") await loadAudit();
    showToast(overrideCommands ? "Mode Silence ! désactivé : nouvelle consigne appliquée." : "Mode Silence ! désactivé : consignes et réglages d'origine restaurés.");
  } catch (e) {
    showToast("Erreur désactivation Silence ! : " + (e?.message || "Échec"), true);
  }
}
