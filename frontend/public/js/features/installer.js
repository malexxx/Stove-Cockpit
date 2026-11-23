// =============================================================================
// FEATURE INSTALLATEUR — AUTHENTIFICATION, EEPROM, RAW BUFFER, SNAPSHOTS & AUDIT
// =============================================================================

function renderHardwareMasks() {
  const grid = document.getElementById("hardware-masks-grid");
  if (!grid) return;
  const m105 = Number(latestData.enable_mask_105 ?? 18479);
  const m107 = Number(latestData.enable_mask_107 ?? 2);
  const features = [
    { name: "Affichage Puissance Réelle", on: (m105 & 2) !== 0, src: "105:bit1" },
    { name: "Sonde Ambiante 1", on: (m105 & 8) !== 0, src: "105:bit3" },
    { name: "Contact Thermostat Principal", on: (m105 & 16) !== 0, src: "105:bit4" },
    { name: "Lecture Ventil. Façade 2", on: (m105 & 32) !== 0, src: "105:bit5" },
    { name: "Sonde T° Canal. DX 2", on: (m105 & 512) !== 0, src: "105:bit9" },
    { name: "Contact Thermostat DX", on: (m105 & 1024) !== 0, src: "105:bit10" },
    { name: "Canalisation Droite DX 2", on: (m105 & 2048) !== 0, src: "105:bit11" },
    { name: "Sonde T° Canal. SX 2", on: (m105 & 4096) !== 0, src: "105:bit12" },
    { name: "Contact Thermostat SX", on: (m105 & 8192) !== 0, src: "105:bit13" },
    { name: "Canalisation Gauche SX 2", on: (m105 & 16384) !== 0, src: "105:bit14" },
    { name: "Sonde Ambiante 2 (Salon)", on: (m107 & 2) !== 0, src: "107:bit1" },
    { name: "Option Mode Silence", on: (m107 & 2048) !== 0, src: "107:bit11" }
  ];
  grid.innerHTML = features.map(f => `
    <div class="p-2 rounded border flex items-center justify-between ${f.on ? 'bg-emerald-950/30 border-emerald-800/70 text-emerald-300' : 'bg-gray-950 border-gray-800 text-gray-500'}">
      <span class="truncate" title="${f.src}">${f.name}</span>
      <strong class="ml-1">${f.on ? "ACTIF" : "OFF"}</strong>
    </div>
  `).join("");
}

let currentOffsetsFilter = "";

function openOffsetsModal() {
  const m = document.getElementById("offsets-modal");
  if (m) {
    m.classList.remove("hidden");
    const input = document.getElementById("offsets-modal-search");
    if (input) {
      input.value = "";
      currentOffsetsFilter = "";
    }
    renderRawBufferInspector();
  }
}

function closeOffsetsModal() {
  const m = document.getElementById("offsets-modal");
  if (m) m.classList.add("hidden");
}

function filterOffsetsModal(query) {
  currentOffsetsFilter = (query || "").toLowerCase().trim();
  renderRawBufferInspector();
}

function renderRawBufferInspector() {
  let rawObj = {};
  try {
    rawObj = JSON.parse(latestData.raw_buffer_json || "{}");
  } catch (e) { }
  const keys = Object.keys(rawObj).sort((a, b) => Number(a) - Number(b));

  // Mise à jour des compteurs
  const countBadge = document.getElementById("raw-buf-count");
  if (countBadge) countBadge.textContent = keys.length;
  const modalBadge = document.getElementById("modal-offsets-badge");
  if (modalBadge) modalBadge.textContent = `${keys.length} offsets`;

  const grid = document.getElementById("modal-offsets-grid");
  if (!grid) return;

  if (keys.length === 0) {
    grid.innerHTML = `<div class="col-span-full py-10 text-center text-gray-500">
      <span class="text-3xl block mb-2">📡</span>
      Aucun buffer brut disponible dans ce mode.<br>
      <button onclick="pollNow(); setTimeout(renderRawBufferInspector, 600);" class="mt-3 px-3 py-1.5 rounded bg-cyan-800 hover:bg-cyan-700 text-cyan-200 text-xs font-semibold cursor-pointer">
        ⟳ Interroger le poêle maintenant
      </button>
    </div>`;
    const countLabel = document.getElementById("modal-offsets-count-label");
    if (countLabel) countLabel.textContent = "0 offset disponible";
    return;
  }

  // Filtrage actif dans la popup
  const q = currentOffsetsFilter;
  const filteredKeys = keys.filter(k => {
    if (!q) return true;
    const desc = (OFFSET_NAMES[Number(k)] || "").toLowerCase();
    const val = String(rawObj[k]).toLowerCase();
    return k.includes(q) || desc.includes(q) || val.includes(q);
  });

  const countLabel = document.getElementById("modal-offsets-count-label");
  if (countLabel) {
    countLabel.textContent = q ? `${filteredKeys.length} / ${keys.length} offsets affichés` : `${keys.length} offsets au total`;
  }

  grid.innerHTML = filteredKeys.map(k => {
    const num = Number(k);
    const desc = OFFSET_NAMES[num] || `Offset #${escapeHtml(k)}`;
    const val = rawObj[k];
    const isSpecial = [8, 34, 103, 115, 232, 33120, 33122, 33124, 33126].includes(num);
    const cardBorder = isSpecial ? "border-cyan-700/80 bg-gray-900/90 ring-1 ring-cyan-500/30" : "border-gray-800/80 bg-gray-950/80";
    const valColor = isSpecial ? "text-cyan-400 font-black" : "text-orange-400 font-bold";

    return `
      <div class="${cardBorder} border rounded-lg p-2.5 flex flex-col justify-between hover:border-cyan-500 transition shadow-sm">
        <div class="flex items-center justify-between gap-1 mb-1 border-b border-gray-800/60 pb-1">
          <span class="text-[11px] font-mono text-cyan-300 font-bold">#${escapeHtml(k)}</span>
          <span class="text-[9px] text-gray-500 font-mono">0x${num.toString(16).toUpperCase()}</span>
        </div>
        <div class="text-[10px] text-gray-300 leading-tight font-medium line-clamp-2 min-h-[26px] mb-1.5" title="${escapeHtml(desc)}">
          ${escapeHtml(desc)}
        </div>
        <div class="text-sm ${valColor} text-right tabular-nums">
          ${escapeHtml(val)}
        </div>
      </div>
    `;
  }).join("");
}

let isCatalogCollapsed = false;
let currentMemoryFilter = "ALL";

function setMemoryFilter(type) {
  currentMemoryFilter = type;
  document.querySelectorAll(".mem-tab-btn").forEach(btn => {
    btn.classList.remove("active", "bg-gray-800", "text-white");
  });
  const activeBtn = document.getElementById("mem-filter-" + type.toLowerCase());
  if (activeBtn) {
    activeBtn.classList.add("active", "bg-gray-800", "text-white");
  }
  const searchInp = document.getElementById("catalog-search");
  filterCatalogTable(searchInp ? searchInp.value : "");
}

function toggleCatalogCollapse() {
  const wrap = document.getElementById("catalog-table-wrap");
  const btn = document.getElementById("btn-toggle-catalog");
  if (!wrap) return;
  isCatalogCollapsed = !isCatalogCollapsed;
  if (isCatalogCollapsed) {
    wrap.classList.remove("max-h-[380px]");
    wrap.classList.add("max-h-[850px]");
    if (btn) btn.innerHTML = "↕️ Réduire";
  } else {
    wrap.classList.remove("max-h-[850px]");
    wrap.classList.add("max-h-[380px]");
    if (btn) btn.innerHTML = "↕️ Déplier";
  }
}

function filterCatalogTable(query) {
  const q = (query || "").toLowerCase().trim();
  const rows = document.querySelectorAll("#eeprom-table-body tr");
  let visibleCount = 0;
  rows.forEach(tr => {
    const text = tr.textContent.toLowerCase();
    const rowMemType = tr.dataset.memType || "";
    const typeMatch = (currentMemoryFilter === "ALL") || (rowMemType === currentMemoryFilter);
    const searchMatch = !q || text.includes(q);
    const match = typeMatch && searchMatch;
    tr.style.display = match ? "" : "none";
    if (match) visibleCount++;
  });
  const countEl = document.getElementById("catalog-reg-count");
  if (countEl) {
    countEl.textContent = (q || currentMemoryFilter !== "ALL")
      ? `${visibleCount} / ${rows.length} affichés`
      : `${rows.length} adresses`;
  }
}

function renderEepromTable() {
  const tbody = document.getElementById("eeprom-table-body");
  if (!tbody) return;
  if (document.activeElement && tbody.contains(document.activeElement)) return;
  tbody.innerHTML = "";

  let rawObj = {};
  try {
    rawObj = JSON.parse(latestData.raw_buffer_json || "{}");
  } catch (e) { }

  const combinedMap = new Map();

  // 1. Registres du catalogue officiel (EEPROM et commandes RAM)
  Object.values(registersCatalog).forEach(r => {
    const offNum = Number(r.offset);
    const memType = r.mem_type || (offNum >= 32768 ? "EEPROM" : "RAM");
    const liveVal = (rawObj[offNum] !== undefined) ? rawObj[offNum] : (r.current_val ?? "--");
    combinedMap.set(offNum, {
      offset: offNum,
      mem_type: memType,
      reg_key: r.reg_key,
      label: r.label,
      category: r.category || "CONTROL",
      unit: r.unit || "",
      min_val: r.min_val,
      max_val: r.max_val,
      step: r.step || 1,
      current_val: liveVal,
      is_writable: true
    });
  });

  // 2. Télémétrie brute des 76 offsets (buffer RAM)
  Object.keys(rawObj).forEach(k => {
    const offNum = Number(k);
    if (!combinedMap.has(offNum)) {
      const memType = (offNum >= 32768) ? "EEPROM" : "RAM";
      const rawDesc = OFFSET_NAMES[offNum] || `Offset #${offNum}`;
      let keyName = `offset_${offNum}`;
      let unit = "";
      if (OFFSET_NAMES[offNum]) {
        const parts = OFFSET_NAMES[offNum].split(" ");
        keyName = parts[0];
        if (parts.length > 1 && parts[1].startsWith("(")) {
          unit = parts.slice(1).join(" ").replace(/[()]/g, "");
        }
      }
      let cat = "TÉLÉMÉTRIE";
      if ([0, 2, 103].includes(offNum)) cat = "SONDES T°";
      else if ([8, 34, 40, 115].includes(offNum)) cat = "ÉTAT / SÉCURITÉ";
      else if ([16, 31, 32, 47].includes(offNum)) cat = "VENTILATEURS";
      else if (offNum === 37) cat = "DÉPRESSION";
      else if ([105, 107].includes(offNum)) cat = "MASQUES USINE";
      else if (offNum === 260) cat = "MAINTENANCE";

      combinedMap.set(offNum, {
        offset: offNum,
        mem_type: memType,
        reg_key: keyName,
        label: rawDesc,
        category: cat,
        unit: unit,
        min_val: null,
        max_val: null,
        step: 1,
        current_val: rawObj[k],
        is_writable: false
      });
    }
  });

  // Si rawObj est encore vide, peupler quand même avec les offsets connus
  if (Object.keys(rawObj).length === 0) {
    Object.keys(OFFSET_NAMES).forEach(k => {
      const offNum = Number(k);
      if (!combinedMap.has(offNum)) {
        const memType = (offNum >= 32768) ? "EEPROM" : "RAM";
        combinedMap.set(offNum, {
          offset: offNum,
          mem_type: memType,
          reg_key: OFFSET_NAMES[offNum].split(" ")[0],
          label: OFFSET_NAMES[offNum],
          category: offNum >= 32768 ? "EEPROM" : "TÉLÉMÉTRIE",
          unit: "",
          min_val: null,
          max_val: null,
          step: 1,
          current_val: "--",
          is_writable: false
        });
      }
    });
  }

  const items = Array.from(combinedMap.values()).sort((a, b) => a.offset - b.offset);

  // Mise à jour des compteurs
  const ramCount = items.filter(i => i.mem_type === "RAM").length;
  const eepromCount = items.filter(i => i.mem_type === "EEPROM").length;
  const totalCount = items.length;

  const cAll = document.getElementById("count-mem-all");
  if (cAll) cAll.textContent = totalCount;
  const cRam = document.getElementById("count-mem-ram");
  if (cRam) cRam.textContent = ramCount;
  const cEep = document.getElementById("count-mem-eeprom");
  if (cEep) cEep.textContent = eepromCount;
  const cBadge = document.getElementById("catalog-reg-count");
  if (cBadge) cBadge.textContent = `${totalCount} adresses`;
  const rawBufEl = document.getElementById("raw-buf-count");
  if (rawBufEl) rawBufEl.textContent = Object.keys(rawObj).length || ramCount;

  items.forEach(item => {
    const tr = document.createElement("tr");
    tr.className = "hover:bg-gray-800/40 transition border-b border-gray-800/40";
    tr.dataset.memType = item.mem_type;

    const hexStr = "0x" + item.offset.toString(16).toUpperCase().padStart(2, "0");
    const typeBadge = (item.mem_type === "RAM")
      ? `<span class="px-1.5 py-0.5 rounded font-mono font-bold text-[10px] bg-emerald-950 text-emerald-300 border border-emerald-800/80">🟢 RAM</span>`
      : `<span class="px-1.5 py-0.5 rounded font-mono font-bold text-[10px] bg-purple-950 text-purple-300 border border-purple-800/80">🟣 EEPROM</span>`;

    const rangeStr = (item.min_val !== null && item.max_val !== null)
      ? `[${Number(item.min_val)}..${Number(item.max_val)}] ${escapeHtml(item.unit || "")}`
      : (item.unit ? escapeHtml(item.unit) : `<span class="text-gray-500">-</span>`);

    let valDisplay = item.current_val;
    if (typeof valDisplay === "number") {
      valDisplay = Number.isInteger(valDisplay) ? valDisplay : valDisplay.toFixed(1);
    }

    const editVal = (typeof item.current_val === "number") ? item.current_val : (Number(item.default_val) || 0);

    const actionHtml = item.is_writable
      ? `<div class="flex items-center justify-end gap-1.5">
          <input id="inp-${escapeHtml(item.reg_key)}" type="number" step="${Number(item.step || 1)}" min="${Number(item.min_val ?? 0)}" max="${Number(item.max_val ?? 65535)}" value="${Number(editVal)}"
            class="inst-input bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 w-16 sm:w-20 text-white tabular-nums text-xs focus:border-orange-500 focus:outline-none" />
          <button data-reg="${escapeHtml(item.reg_key)}" onclick="sendCommand(this.dataset.reg, document.getElementById('inp-' + this.dataset.reg).value)"
            class="inst-input px-2.5 py-0.5 rounded bg-orange-600 hover:bg-orange-500 text-white text-[11px] font-semibold cursor-pointer transition shadow">Écrire</button>
        </div>`
      : `<div class="text-right"><span class="text-[10px] text-gray-500 font-mono italic">👁️ Direct (RO)</span></div>`;

    tr.innerHTML = `
      <td class="py-1.5 px-2.5 font-mono text-cyan-300 font-bold whitespace-nowrap">
        <span>#${item.offset}</span>
        <span class="text-[9px] text-gray-500 font-normal ml-1">${hexStr}</span>
      </td>
      <td class="py-1.5 px-2 whitespace-nowrap">${typeBadge}</td>
      <td class="py-1.5 px-2 font-mono text-orange-400 font-semibold whitespace-nowrap">${escapeHtml(item.reg_key)}</td>
      <td class="py-1.5 px-2 whitespace-nowrap"><span class="px-2 py-0.5 rounded bg-gray-800 text-gray-300 text-[10px] font-medium">${escapeHtml(item.category)}</span></td>
      <td class="py-1.5 px-2 text-gray-200 max-w-[200px] sm:max-w-[280px] truncate" title="${escapeHtml(item.label)}">${escapeHtml(item.label)}</td>
      <td class="py-1.5 px-2 text-gray-400 text-[10px] whitespace-nowrap">${rangeStr}</td>
      <td class="py-1.5 px-2 font-bold text-white tabular-nums whitespace-nowrap">${escapeHtml(valDisplay)}</td>
      <td class="py-1.5 px-2.5 whitespace-nowrap">${actionHtml}</td>
    `;
    tbody.appendChild(tr);
  });

  const searchInp = document.getElementById("catalog-search");
  filterCatalogTable(searchInp ? searchInp.value : "");
}

async function loadSnapshots() {
  if (!window.stoveProvider?.isContainerActive?.()) return;
  let snaps;
  try {
    snaps = await window.stoveProvider.getSnapshots(getInstallerHeaders());
  } catch {
    return;
  }
  const tbody = document.getElementById("snapshots-table-body");
  if (!tbody) return;
  if (snaps.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="py-3 text-gray-500">Aucun snapshot enregistré dans cette base. Cliquez sur "📸 Capturer un Snapshot".</td></tr>`;
    return;
  }
  tbody.innerHTML = snaps.map(s => {
    const csvUrl = window.stoveProvider.getContainerDownloadUrl(`/api/snapshots/${Number(s.id)}/export-csv`);
    return `
    <tr>
      <td class="py-2 text-gray-400 font-mono">#${Number(s.id)} — ${escapeHtml(s.timestamp)}</td>
      <td><strong class="text-white">${escapeHtml(s.name)}</strong></td>
      <td class="uppercase text-cyan-400 font-mono">${escapeHtml(s.comm_mode)}</td>
      <td class="text-gray-300">${Number(s.registers_count)} registres / ${Number(s.raw_offsets_count)} offsets bruts</td>
      <td class="flex flex-wrap gap-1.5 py-1.5">
        <a href="${escapeHtml(csvUrl)}" class="px-2.5 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-semibold">
          📥 CSV
        </a>
        <button data-snap-id="${Number(s.id)}" data-snap-name="${escapeHtml(s.name)}" onclick="restoreSnapshot(Number(this.dataset.snapId), this.dataset.snapName)" class="px-2.5 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold">
          ↩ Restaurer (Batch)
        </button>
        <button onclick="deleteSnapshot(${Number(s.id)})" class="px-2 py-1 rounded bg-rose-900/70 hover:bg-rose-700 text-rose-200 text-xs">
          🗑️
        </button>
      </td>
    </tr>
  `;
  }).join("");
}

async function createSnapshot() {
  const nameInp = document.getElementById("snap-name-input");
  const name = nameInp ? nameInp.value : "";
  try {
    await window.stoveProvider.createSnapshot(name, false, getInstallerHeaders());
    if (nameInp) nameInp.value = "";
    await loadSnapshots();
    showToast("Snapshot des registres et paramètres enregistré !");
  } catch (e) {
    showToast("Erreur création snapshot : " + (e?.message || "Échec"), true);
  }
}

function restoreSnapshot(id, name) {
  openActionModal({
    title: "↩ Restauration Groupée (Batch)",
    message: `Confirmez-vous la restauration complète du Snapshot #${id} (${name}) vers les registres du poêle ?`,
    confirmText: "Restaurer",
    onConfirm: async () => {
      try {
        const j = await window.stoveProvider.restoreSnapshot(id, getInstallerHeaders());
        await loadDashboard();
        await loadAudit();
        showToast(`Snapshot restauré (${j.restored_registers} registres réécrits en batch).`);
      } catch (e) {
        showToast("Erreur restauration : " + (e?.message || "Échec"), true);
      }
    }
  });
}

function deleteSnapshot(id) {
  openActionModal({
    title: "🗑️ Supprimer le Snapshot",
    message: `Supprimer définitivement le Snapshot #${id} de la base SQLite ?`,
    confirmText: "Supprimer",
    onConfirm: async () => {
      try {
        await window.stoveProvider.deleteSnapshot(id, getInstallerHeaders());
        await loadSnapshots();
        showToast(`Snapshot #${id} supprimé.`);
      } catch (e) {
        showToast("Erreur suppression : " + (e?.message || "Échec"), true);
      }
    }
  });
}

// =============================================================================
// AUTHENTIFICATION SÉCURISÉE MENU INSTALLATEUR (CLOUD AGUA PASSWORD)
// =============================================================================

async function checkInstallerAuthStatus(forceRefresh = false) {
  const lockScreen = document.getElementById("installer-lock-screen");
  const unlockedContent = document.getElementById("installer-unlocked-content");
  const noPwdAlert = document.getElementById("installer-no-pwd-alert");
  const errBox = document.getElementById("installer-auth-error");
  const authPill = document.getElementById("installer-auth-pill");
  const authPillText = document.getElementById("installer-auth-pill-text");
  const lockIcon = document.getElementById("subtab-expert-lock-icon");

  if (!lockScreen || !unlockedContent) return;

  try {
    const headers = {};
    if (installerAuthToken) {
      headers["X-Installer-Token"] = installerAuthToken;
    }
    const data = await window.stoveProvider.getInstallerStatus(headers);

    if (data.authenticated) {
      lockScreen.classList.add("hidden");
      unlockedContent.classList.remove("hidden");
      if (authPill) authPill.className = "text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-950 text-emerald-300 border border-emerald-600 flex items-center gap-1";
      if (authPillText) authPillText.textContent = "Expert Déverrouillé";
      if (lockIcon) lockIcon.textContent = "🔓";
      if (errBox) errBox.classList.add("hidden");
      document.querySelectorAll(".inst-input").forEach(el => { el.disabled = false; });
      loadSnapshots();
    } else {
      if (installerAuthToken) {
        installerAuthToken = "";
        sessionStorage.removeItem("nobis_installer_token");
      }
      lockScreen.classList.remove("hidden");
      unlockedContent.classList.add("hidden");
      if (authPill) authPill.className = "text-[10px] font-semibold px-2 py-0.5 rounded-full bg-gray-800 text-gray-400 border border-gray-700 flex items-center gap-1";
      if (authPillText) authPillText.textContent = "Expert Verrouillé";
      if (lockIcon) lockIcon.textContent = "🔒";

      if (noPwdAlert) {
        noPwdAlert.classList.toggle("hidden", !!data.has_password_configured);
      }
      const pwdInput = document.getElementById("installer-password-input");
      if (pwdInput) {
        pwdInput.disabled = !data.has_password_configured;
        if (data.has_password_configured) {
          setTimeout(() => pwdInput.focus(), 100);
        }
      }
    }
  } catch (err) {
    console.error("Erreur vérification statut installateur:", err);
  }
}

async function submitInstallerAuth(event) {
  if (event) event.preventDefault();
  const pwdInput = document.getElementById("installer-password-input");
  const errBox = document.getElementById("installer-auth-error");
  const btn = document.getElementById("installer-auth-submit-btn");
  if (!pwdInput) return;

  const password = pwdInput.value;
  if (!password) {
    if (errBox) {
      errBox.textContent = "Veuillez saisir votre mot de passe Agua Cloud.";
      errBox.classList.remove("hidden");
    }
    return;
  }

  if (errBox) errBox.classList.add("hidden");
  if (btn) {
    btn.disabled = true;
    btn.classList.add("opacity-60", "cursor-wait");
  }

  try {
    const data = await window.stoveProvider.verifyInstaller(password);

    if ((data.authenticated || data.success || data.status === "ok") && data.token) {
      installerAuthToken = data.token;
      sessionStorage.setItem("nobis_installer_token", installerAuthToken);
      pwdInput.value = "";
      if (errBox) errBox.classList.add("hidden");
      showToast("Accès Installateur déverrouillé !");
      await checkInstallerAuthStatus();
    } else {
      let errMsg = data.detail || "Mot de passe Cloud incorrect.";
      if (errBox) {
        errBox.textContent = errMsg;
        errBox.classList.remove("hidden");
      }
      pwdInput.focus();
      pwdInput.select();
    }
  } catch (err) {
    console.error("Erreur authentification installateur:", err);
    if (errBox) {
      errBox.textContent = err?.status === 429
        ? "Trop de tentatives échouées. Veuillez patienter 60 secondes."
        : (err?.message || "Erreur de communication avec le serveur.");
      errBox.classList.remove("hidden");
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove("opacity-60", "cursor-wait");
    }
  }
}

async function lockInstallerMenu() {
  try {
    if (installerAuthToken) {
      await window.stoveProvider.lockInstaller({ "X-Installer-Token": installerAuthToken });
    }
  } catch (err) {
    console.warn("Erreur lock installer:", err);
  } finally {
    installerAuthToken = "";
    sessionStorage.removeItem("nobis_installer_token");
    showToast("Menu installateur reverrouillé.");
    await checkInstallerAuthStatus();
  }
}

function toggleInstallerPasswordVisibility() {
  const inp = document.getElementById("installer-password-input");
  const icon = document.getElementById("installer-pwd-toggle-icon");
  if (!inp) return;
  if (inp.type === "password") {
    inp.type = "text";
    if (icon) icon.textContent = "🙈";
  } else {
    inp.type = "password";
    if (icon) icon.textContent = "👁️";
  }
}

async function loadAudit() {
  if (!window.stoveProvider?.isContainerActive?.()) return;
  let rows;
  try {
    rows = await window.stoveProvider.getAudit();
  } catch {
    return;
  }
  const tbody = document.getElementById("audit-table-body");
  if (!tbody) return;
  if (!rows || rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="py-8 text-center text-gray-500 text-xs">🛡️ Aucune écriture de registre enregistrée pour le mode actif.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td class="py-2 text-gray-400">${escapeHtml(r.timestamp)}</td>
      <td><strong class="text-white">${escapeHtml(r.label)}</strong> <span class="text-gray-500">(#${Number(r.offset)})</span></td>
      <td class="font-mono text-amber-400">${Number(r.old_value)}</td>
      <td class="font-mono text-emerald-400">${Number(r.new_value)}</td>
      <td class="uppercase text-cyan-400 font-mono">${escapeHtml(r.comm_mode)}</td>
      <td><span class="px-2 py-0.5 rounded ${r.status === 'SUCCESS' ? 'bg-emerald-950 text-emerald-300' : 'bg-rose-950 text-rose-300'}">${escapeHtml(r.status)}</span></td>
      <td>
        <button onclick="rollbackAudit(${Number(r.id)}, ${Number(r.old_value)})" class="px-2.5 py-1 rounded bg-amber-700 hover:bg-amber-600 text-white text-xs">
          ↩ Rollback (${Number(r.old_value)})
        </button>
      </td>
    </tr>
  `).join("");
}

function rollbackAudit(id, oldVal) {
  openActionModal({
    title: "↩ Rollback Registre",
    message: `Restaurer immédiatement l'ancienne valeur (${oldVal}) dans le registre ?`,
    confirmText: "Restaurer",
    onConfirm: async () => {
      try {
        await window.stoveProvider.rollbackAudit(id, getInstallerHeaders());
        await refreshLatestOnly();
        await loadAudit();
        showToast("Rollback effectué !");
      } catch (e) {
        showToast("Erreur rollback : " + (e?.message || "Échec"), true);
      }
    }
  });
}
