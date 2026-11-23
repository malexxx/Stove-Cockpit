// Contrôleur client de l'assistant d'étalonnage couplé Nobis A10
let currentStep = 1;
let pollTimer = null;
let statusPollInFlight = false;

function getWizardInstallerHeaders(extra = {}) {
  const headers = { ...extra };
  const token = sessionStorage.getItem("nobis_installer_token") || "";
  if (token) {
    headers["X-Installer-Token"] = token;
  }
  return headers;
}

async function wizardPostJson(url, bodyObj = null) {
  const opts = {
    method: "POST",
    headers: getWizardInstallerHeaders(bodyObj !== null ? { "Content-Type": "application/json" } : {}),
  };
  if (bodyObj !== null) {
    opts.body = JSON.stringify(bodyObj);
  }
  const res = window.stoveProvider?.container
    ? await window.stoveProvider.container.request(url, { method: "POST", headers: opts.headers, body: bodyObj })
    : await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.detail || data.message || `Erreur HTTP ${res.status}`;
    if (res.status === 403) {
      throw new Error(`${detail} (Déverrouillez d'abord le mode Expert dans Paramètres & Logs du Cockpit).`);
    }
    throw new Error(detail);
  }
  return data;
}

    // Navigation d'onglets visuelle
    function goToStep(step) {
      currentStep = step;
      for (let i = 1; i <= 5; i++) {
        const view = document.getElementById(`step-view-${i}`);
        const nav = document.getElementById(`step-nav-${i}`);
        if (!view || !nav) continue;

        if (i === step) {
          view.classList.remove('hidden');
          nav.className = "card p-3 border step-active flex items-center gap-2 transition-all";
        } else if (i < step) {
          view.classList.add('hidden');
          nav.className = "card p-3 border step-done flex items-center gap-2 transition-all";
        } else {
          view.classList.add('hidden');
          nav.className = "card p-3 border border-gray-800 text-gray-500 flex items-center gap-2 transition-all";
        }
      }
    }

    // Récupération de l'état persistant depuis le backend
    async function fetchCalibrationStatus() {
      if (statusPollInFlight || document.hidden) return;
      statusPollInFlight = true;
      try {
        const res = window.stoveProvider?.container
          ? await window.stoveProvider.container.request('/api/calibration/status')
          : await fetch('/api/calibration/status');
        if (!res.ok) return;
        const data = await res.json();
        updateUIWithState(data);
      } catch (e) {
        console.warn("Échec récupération statut calibration:", e);
      } finally {
        statusPollInFlight = false;
      }
    }

    function updateUIWithState(data) {
      if (!data) return;

      const badge = document.getElementById('global-badge-status');
      if (data.state === "IDLE") {
        badge.textContent = "État : PRÊT (IDLE)";
        badge.className = "px-3 py-1 text-xs font-bold rounded-full bg-gray-800 text-gray-300 border border-gray-700";
      } else if (data.state === "WAITING_INITIAL_AL03") {
        badge.textContent = "État : ATTENTE CUVE VIDE (AL-03)";
        badge.className = "px-3 py-1 text-xs font-bold rounded-full bg-amber-950 text-amber-400 border border-amber-800";
      } else if (data.state === "RUNNING_ACQUISITION") {
        badge.textContent = "État : ACQUISITION ARRIÈRE-PLAN";
        badge.className = "px-3 py-1 text-xs font-bold rounded-full bg-emerald-950 text-emerald-400 border border-emerald-800";
      } else if (data.state === "COMPLETED_LOCKED") {
        badge.textContent = "État : CLÔTURÉ (AL-03)";
        badge.className = "px-3 py-1 text-xs font-bold rounded-full bg-sky-950 text-sky-400 border border-sky-800";
      }

      // Synchronisation de l'étape active
      if (data.step && data.step !== currentStep) {
        goToStep(data.step);
      }

      // Étape 4 : Métriques d'acquisition
      if (data.step === 4 || data.state === "RUNNING_ACQUISITION") {
        document.getElementById('st4-progress-pct').textContent = `${data.progress_pct}%`;
        document.getElementById('st4-progress-bar').style.width = `${Math.min(100, Math.max(0, data.progress_pct))}%`;
        document.getElementById('st4-consumed-kg').textContent = data.estimated_consumed_kg.toFixed(3);
        document.getElementById('st4-remaining-kg').textContent = data.estimated_remaining_kg.toFixed(3);

        const phaseBadge = document.getElementById('st4-phase-badge');
        phaseBadge.textContent = `${data.current_phase || 'TRAVAIL'} ${data.current_power_tier || ''}`;

        if (data.phase_breakdown) {
          document.getElementById('st4-ign-count').textContent = data.phase_breakdown.ignition_cycles_count || 0;
          document.getElementById('st4-ign-mass').textContent = (data.phase_breakdown.startup_estimated_mass_kg || 0).toFixed(3);
          document.getElementById('st4-warmup-samples').textContent = data.phase_breakdown.warmup_filtered_combustion_samples || 0;
          document.getElementById('st4-starve-min').textContent = (data.phase_breakdown.starvation_pre_al03_ignored_min || 0).toFixed(1);
        }
        document.getElementById('st4-valid-samples').textContent = data.valid_combustion_samples_count || 0;

        renderTierHours(data.hours_per_tier || {});
      }

      // Étape 5 : Résultats
      if (data.result && (data.step === 5 || data.state === "COMPLETED_LOCKED")) {
        const r = data.result;
        document.getElementById('res-k-factor').textContent = r.intrinsic_k_factor.toFixed(4);
        const deltaPct = ((r.intrinsic_k_factor - 1.0) * 100.0);
        document.getElementById('res-k-delta').textContent = `(${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)} %)`;
        document.getElementById('res-smoke-delta').textContent = `${r.mean_smoke_temp_delta_c >= 0 ? '+' : ''}${r.mean_smoke_temp_delta_c.toFixed(1)} °C`;
        document.getElementById('res-prs-delta').textContent = `${r.mean_pressure_error_pct >= 0 ? '+' : ''}${r.mean_pressure_error_pct.toFixed(1)} %`;

        document.getElementById('res-cur-70').textContent = `${r.current_offset_70 >= 0 ? '+' : ''}${r.current_offset_70} %`;
        document.getElementById('res-rec-70').textContent = `${r.recommended_offset_70 >= 0 ? '+' : ''}${r.recommended_offset_70} %`;
        document.getElementById('res-cur-71').textContent = `${r.current_offset_71 >= 0 ? '+' : ''}${r.current_offset_71} %`;
        document.getElementById('res-rec-71').textContent = `${r.recommended_offset_71 >= 0 ? '+' : ''}${r.recommended_offset_71} %`;

        renderFlowsTable(r.before_flows_kgh, r.measured_raw_flows_kgh, r.coupled_effective_flows_kgh);
      }
    }

    function renderTierHours(hoursMap) {
      const container = document.getElementById('st4-tier-hours');
      container.innerHTML = "";
      for (let k = 0; k <= 8; k++) {
        const key = `P${k}`;
        const h = hoursMap[key] || 0.0;
        const div = document.createElement('div');
        div.className = "card p-2 bg-gray-950/70 border border-gray-800";
        div.innerHTML = `<span class="text-[9px] text-gray-500 block">P${k}</span><b class="text-gray-200">${h.toFixed(1)}h</b>`;
        container.appendChild(div);
      }
    }

    function renderFlowsTable(beforeMap, rawMap, coupledMap) {
      const tbody = document.getElementById('res-flows-table');
      tbody.innerHTML = "";
      for (let k = 0; k <= 8; k++) {
        const label = k === 0 ? "P0 (RIS)" : (k === 8 ? "P8 (PWF)" : `P${k}`);
        const nom = (beforeMap[k] || 0).toFixed(3);
        const raw = (rawMap[k] || 0).toFixed(3);
        const eff = (coupledMap[k] || 0).toFixed(3);

        const tr = document.createElement('tr');
        tr.className = "hover:bg-gray-800/40 transition";
        tr.innerHTML = `
          <td class="py-1.5 font-bold text-white">${label}</td>
          <td class="py-1.5 text-gray-400">${nom} kg/h</td>
          <td class="py-1.5 text-orange-300">${raw} kg/h</td>
          <td class="py-1.5 font-bold text-emerald-400">${eff} kg/h</td>
        `;
        tbody.appendChild(tr);
      }
    }

    async function executeStep1() {
      const modeRadio = document.querySelector('input[name="calib_mode"]:checked');
      const mode = modeRadio ? modeRadio.value : "COMBINED_BOTH";
      const btn = document.getElementById('btn-step1');
      btn.disabled = true;
      btn.textContent = "Pré-contrôle en cours...";

      try {
        const data = await wizardPostJson('/api/calibration/step1-start', { mode });
        if (data.success) {
          await fetchCalibrationStatus();
        } else {
          alert("Erreur pré-contrôle: " + (data.message || "Échec"));
        }
      } catch (e) {
        alert("Erreur pré-contrôle : " + (e.message || e));
      } finally {
        btn.disabled = false;
        btn.textContent = "Lancer le Pré-contrôle ➔";
      }
    }

    async function executeStep2() {
      const btn = document.getElementById('btn-step2');
      btn.disabled = true;
      btn.textContent = "Vérification AL-03...";

      try {
        const data = await wizardPostJson('/api/calibration/step2-confirm-al03');
        if (data.success) {
          await fetchCalibrationStatus();
        } else {
          alert("Vérification AL-03 : " + (data.message || "Alarme non confirmée"));
        }
      } catch (e) {
        alert("Erreur vérification AL-03 : " + (e.message || e));
      } finally {
        btn.disabled = false;
        btn.textContent = "Confirmer AL-03 & Réarmer ➔";
      }
    }

    async function executeStep3() {
      const bagKg = parseFloat(document.getElementById('input-bag-kg').value) || 15.0;
      const aspG = parseFloat(document.getElementById('input-aspirated-g').value) || 0;
      const btn = document.getElementById('btn-step3');
      btn.disabled = true;
      btn.textContent = "Verrouillage de la charge...";

      try {
        const data = await wizardPostJson('/api/calibration/step3-load-charge', {
          weighed_bag_kg: bagKg,
          aspirated_priming_grams: aspG
        });
        if (data.success) {
          await fetchCalibrationStatus();
        } else {
          alert("Erreur charge étalon : " + (data.message || "Échec"));
        }
      } catch (e) {
        alert("Erreur charge étalon : " + (e.message || e));
      } finally {
        btn.disabled = false;
        btn.textContent = "Verrouiller la Charge & Démarrer l'Acquisition ➔";
      }
    }

    async function executeStep5() {
      const btn = document.getElementById('btn-apply-offsets');
      const feedback = document.getElementById('res-apply-feedback');
      btn.disabled = true;
      btn.textContent = "Écriture EEPROM Micronova en cours...";

      try {
        const data = await wizardPostJson('/api/calibration/step5-apply');
        if (data.success) {
          btn.textContent = "✓ Offsets 70 & 71 appliqués avec succès !";
          btn.className = "px-6 py-2.5 rounded-lg bg-gray-800 text-emerald-400 text-xs font-bold border border-emerald-700/60";
          feedback.textContent = data.message || "Vérification Read-After-Write réussie dans la carte mère.";
          await fetchCalibrationStatus();
        } else {
          btn.disabled = false;
          btn.textContent = "Réessayer l'application";
          feedback.textContent = data.message || "Échec d'application.";
        }
      } catch (e) {
        btn.disabled = false;
        btn.textContent = "Erreur d'application";
        feedback.textContent = e.message || String(e);
      }
    }

    async function confirmResetCalibration() {
      if (!confirm("Voulez-vous vraiment réinitialiser la calibration en cours ? Toute l'acquisition enregistrée sera remise à zéro.")) {
        return;
      }
      try {
        await wizardPostJson('/api/calibration/reset');
        await fetchCalibrationStatus();
        goToStep(1);
      } catch (e) {
        alert("Erreur réinitialisation : " + (e.message || e));
      }
    }

    // Polling régulier pour rafraîchir les métriques d'arrière-plan (mis en pause onglet masqué)
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) fetchCalibrationStatus();
    });
    document.addEventListener("DOMContentLoaded", () => {
      fetchCalibrationStatus();
      pollTimer = setInterval(fetchCalibrationStatus, 3000);
    });
