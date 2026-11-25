// =============================================================================
// FEATURE MATTER — PASSERELLE THERMOSTAT LOCALE & APPAIRAGE QR CODE
// =============================================================================

let lastMatterPairingCodeRaw = "";

async function openMatterModal() {
  const modal = document.getElementById("matter-modal");
  if (modal) modal.classList.remove("hidden");
  await refreshMatterStatus(false);
}

function closeMatterModal() {
  const modal = document.getElementById("matter-modal");
  if (modal) modal.classList.add("hidden");
}

async function refreshMatterStatus(showFeedback = false) {
  if (!window.stoveProvider?.isContainerActive?.()) return;
  try {
    const data = await window.stoveProvider.getMatterStatus();
    renderMatterStatus(data);
    if (showFeedback) {
      showToast("État du pont Matter actualisé !");
    }
  } catch (err) {
    const infoEl = document.getElementById("matter-fabrics-info");
    if (infoEl) {
      infoEl.textContent = "Erreur de lecture du pont Matter : " + (err.message || err);
    }
  }
}

function renderMatterStatus(data) {
  const matterBtn = document.getElementById("hdr-matter-btn");
  const dot = document.getElementById("hdr-matter-dot");
  const cfgDot = document.getElementById("cfg-matter-status-dot");
  const badge = document.getElementById("matter-status-badge");
  const qrBox = document.getElementById("matter-qr-box");
  const codeEl = document.getElementById("matter-manual-code");
  const infoEl = document.getElementById("matter-fabrics-info");
  const modeEl = document.getElementById("matter-live-mode");
  const ambEl = document.getElementById("matter-live-amb");
  const spEl = document.getElementById("matter-live-sp");

  const isRunning = Boolean(data && data.running);
  const isCommissioned = Boolean(data && data.commissioned);
  const fabricsCount = Number(data?.fabricsCount || 0);

  if (cfgDot) {
    if (!isRunning) {
      cfgDot.className = "w-2.5 h-2.5 rounded-full bg-rose-500 shadow-[0_0_6px_#f43f5e] inline-block";
      cfgDot.title = "Pont Matter hors ligne";
    } else if (isCommissioned) {
      cfgDot.className = "w-2.5 h-2.5 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399] inline-block";
      cfgDot.title = `Pont Matter actif et appairé (${fabricsCount} hub${fabricsCount > 1 ? "s" : ""})`;
    } else {
      cfgDot.className = "w-2.5 h-2.5 rounded-full bg-cyan-400 animate-pulse shadow-[0_0_8px_#38bdf8] inline-block";
      cfgDot.title = "Pont Matter prêt à appairer";
    }
  }

  if (matterBtn) {
    if (!isRunning) {
      matterBtn.className = "w-8 h-8 sm:w-9 sm:h-9 rounded-full flex items-center justify-center border bg-rose-600/85 border-rose-400 text-white shadow-[0_0_10px_rgba(244,63,94,0.45)] flex-shrink-0 cursor-pointer hover:bg-rose-500 transition-all";
      matterBtn.title = "Pont Matter hors ligne • Cliquer pour configurer";
    } else {
      matterBtn.className = "w-8 h-8 sm:w-9 sm:h-9 rounded-full flex items-center justify-center border bg-emerald-600/85 border-emerald-400 text-white shadow-[0_0_10px_rgba(16,185,129,0.45)] flex-shrink-0 cursor-pointer hover:bg-emerald-500 transition-all";
      matterBtn.title = isCommissioned
        ? `Pont Matter actif et appairé (${fabricsCount} hub${fabricsCount > 1 ? "s" : ""}) • Cliquer pour afficher`
        : "Pont Matter en ligne (prêt à appairer) • Cliquer pour afficher le QR Code";
    }
  }
  if (dot) dot.className = "hidden";

  if (badge) {
    if (!isRunning) {
      badge.textContent = "Hors ligne";
      badge.className = "text-[10px] px-2 py-0.5 rounded-full bg-rose-950 text-rose-300 border border-rose-700 font-semibold";
    } else if (isCommissioned) {
      badge.textContent = `Appairé (${fabricsCount} hub${fabricsCount > 1 ? "s" : ""})`;
      badge.className = "text-[10px] px-2 py-0.5 rounded-full bg-emerald-950 text-emerald-300 border border-emerald-700 font-semibold";
    } else {
      badge.textContent = `Prêt à appairer (UDP ${data.matterPort || 5540})`;
      badge.className = "text-[10px] px-2 py-0.5 rounded-full bg-cyan-950 text-cyan-300 border border-cyan-700 font-semibold";
    }
  }

  const ls = data?.liveState || {};
  if (modeEl) {
    const isHeat = ls.systemMode === "Heat";
    modeEl.textContent = isHeat ? "🔥 Chauffage (ON)" : "⚫ Arrêt (OFF)";
    modeEl.className = "text-sm font-bold mt-0.5 " + (isHeat ? "text-emerald-400" : "text-gray-400");
  }
  if (ambEl) {
    ambEl.textContent = ls.localTemperatureC !== undefined && ls.localTemperatureC !== null
      ? `${formatMeasuredTemp(ls.localTemperatureC)} °C`
      : "-- °C";
  }
  if (spEl) {
    spEl.textContent = ls.setpointC !== undefined ? `${Number(ls.setpointC).toFixed(0)} °C` : "-- °C";
  }

  lastMatterPairingCodeRaw = String(data?.manualPairingCode || "");
  if (codeEl) {
    codeEl.textContent = data?.manualPairingCodeFormatted || lastMatterPairingCodeRaw || "---- --- ----";
  }

  if (qrBox) {
    if (data?.qrSvg && String(data.qrSvg).trim().startsWith("<svg")) {
      // Rendu isolé via data URI <img> (neutralise toute exécution de script éventuel dans le SVG)
      qrBox.innerHTML = "";
      const img = document.createElement("img");
      img.alt = "QR Code d'appairage Matter";
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(String(data.qrSvg));
      img.style.width = "100%";
      img.style.height = "100%";
      qrBox.appendChild(img);
    } else if (isCommissioned) {
      qrBox.innerHTML = `<div class="text-center p-2 space-y-1"><div class="text-3xl">✅</div><div class="text-xs font-bold text-slate-800">Appareil appairé</div><div class="text-[10px] text-slate-600">Actif sur votre Nest Hub Max</div></div>`;
    } else {
      qrBox.innerHTML = `<span class="text-xs text-rose-600 font-semibold text-center px-2">${escapeHtml(data?.error || "Pont Matter indisponible")}</span>`;
    }
  }

  if (infoEl) {
    if (!isRunning) {
      infoEl.innerHTML = `⚠️ <strong>Pont Matter arrêté :</strong> ${escapeHtml(data?.error || "Vérifiez le service Node.js.")}`;
    } else if (isCommissioned) {
      const fabNames = (data.fabrics || []).map(f => escapeHtml(f.label || `Fabric #${f.fabricIndex}`)).join(", ");
      infoEl.innerHTML = `✅ <strong>Connecté en local avec votre écosystème Matter :</strong> ${fabNames || "Google Home / Nest Hub Max"}. Les commandes vocales et l'écran Thermostat sont actifs.`;
    } else {
      const safePort = Number(data?.matterPort) || 5540;
      infoEl.innerHTML = `📡 <strong>En attente d'appairage sur le réseau local (mDNS / UDP ${safePort}) :</strong> Scannez le QR Code ci-dessus dans l'application <strong>Google Home</strong> pour relier le poêle à votre <strong>Nest Hub Max</strong>.`;
    }
  }
}

async function copyMatterPairingCode() {
  if (!lastMatterPairingCodeRaw) {
    showToast("Aucun code d'appairage disponible.", true);
    return;
  }
  try {
    await navigator.clipboard.writeText(lastMatterPairingCodeRaw);
    showToast("Code Matter copié : " + lastMatterPairingCodeRaw);
  } catch {
    showToast("Code Matter : " + lastMatterPairingCodeRaw);
  }
}

function confirmResetMatterPairing() {
  openActionModal({
    title: "Réinitialiser l'appairage Matter ?",
    message: "Cette action dissociera le poêle de Google Home / Nest Hub Max et générera un nouveau QR Code d'appairage vierge.",
    confirmText: "Réinitialiser",
    onConfirm: async () => {
      try {
        showToast("Réinitialisation du pont Matter en cours...");
        const data = await window.stoveProvider.factoryResetMatter();
        renderMatterStatus(data);
        showToast("Nouveau QR Code Matter généré !");
      } catch (err) {
        showToast("Erreur lors de la réinitialisation Matter : " + (err.message || err), true);
      }
    }
  });
}
