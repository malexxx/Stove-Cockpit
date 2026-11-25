// =============================================================================
// FEATURE PILOTAGE — COMMANDES POÊLE, ALARME, HORLOGE & OFFSET BRUT
// =============================================================================

function getActualFanButtonVal(rawActual, setpoint) {
  const raw = Number(rawActual ?? 0);
  const sp = Number(setpoint ?? 0);
  if (sp !== 8) {
    if (raw === 0 && sp === 0) return 0;
    if (raw >= 2 && raw <= 8) return raw - 1;
    return sp;
  }
  // En mode PS (consigne = 8) : la vitesse réelle varie de 0 (OFF) ou 1 à 7
  if (raw === 0) return 0;
  if (raw === 1) return 1;
  if (raw >= 2 && raw <= 8) return raw - 1;
  return raw;
}

const SILENCE_OVERRIDABLE_KEYS = {
  "power_level": "la puissance de chauffe",
  "fan_front_speed": "la ventilation frontale",
  "duct_left_speed": "la canalisation gauche",
  "duct_right_speed": "la canalisation droite",
  "fun_auto_set": "le mode Auto",
  "standby_set": "le mode ECO",
  "fun_pwf_set": "le mode BOOST",
  "temp_amb_setpoint": "la consigne de température ambiante",
  "duct_left_setpoint": "la consigne canalisation gauche",
  "duct_right_setpoint": "la consigne canalisation droite",
  "chrono_week_enable_set": "la programmation horaire (Chrono)",
};

async function sendCommand(reg_key, value, forceOverride = false) {
  if (!forceOverride && silenceModeState && silenceModeState.active && SILENCE_OVERRIDABLE_KEYS[reg_key]) {
    let targetLabel = "";
    if (reg_key === "power_level") {
      targetLabel = `la puissance de combustion sur P${value}`;
    } else if (reg_key.includes("speed")) {
      const spdText = Number(value) === 0 ? "OFF" : (Number(value) === 8 ? "PS Auto" : `vitesse ${value}`);
      targetLabel = `${SILENCE_OVERRIDABLE_KEYS[reg_key]} sur ${spdText}`;
    } else if (reg_key.includes("setpoint")) {
      targetLabel = `${SILENCE_OVERRIDABLE_KEYS[reg_key]} sur ${value} °C`;
    } else if (reg_key === "chrono_week_enable_set") {
      targetLabel = Number(value) === 1 ? "l'activation du Chrono hebdomadaire" : "la désactivation du Chrono hebdomadaire";
    } else if (reg_key === "fun_auto_set") {
      targetLabel = Number(value) === 1 ? "l'activation du mode Auto" : "la désactivation du mode Auto";
    } else if (reg_key === "standby_set") {
      targetLabel = Number(value) === 1 ? "l'activation du mode ECO" : "la désactivation du mode ECO";
    } else if (reg_key === "fun_pwf_set") {
      targetLabel = Number(value) > 0 ? "l'activation du mode BOOST" : "la désactivation du mode BOOST";
    } else {
      targetLabel = `${SILENCE_OVERRIDABLE_KEYS[reg_key]} sur ${value}`;
    }

    openActionModal({
      title: "🤫 Mode Silence ! en cours",
      message: `Le mode Silence ! intelligent est actuellement actif (temporisé).\n\nPour appliquer manuellement ${targetLabel}, le mode Silence ! doit être désactivé.\n\nConfirmez-vous la désactivation du mode Silence ! et l'application de cette consigne ?`,
      confirmText: "Désactiver et Appliquer",
      onConfirm: async () => {
        await deactivateSilenceMode([{ reg_key, value: Number(value) }]);
      }
    });
    return;
  }

  showToast(`Envoi commande ${reg_key} = ${value}...`);
  try {
    await window.stoveProvider.sendCommand(reg_key, Number(value), null);
    showToast(`Commande ${reg_key} (${value}) appliquée avec succès !`);
  } catch (e) {
    const msg = e?.message || "Commande refusée";
    showToast("Erreur : " + msg, true);
    reportClientError("PILOTAGE", `Échec commande ${reg_key}=${value} : ${msg}`);
  }
  await refreshLatestOnly();
  if (typeof clearTriArcOptimistic === "function") {
    clearTriArcOptimistic([reg_key]);
    if (typeof renderTriArcCockpit === "function") renderTriArcCockpit();
  }
  const installerTab = document.getElementById("tab-installer");
  if (installerTab && !installerTab.classList.contains("hidden") && window.stoveProvider?.isContainerActive?.()) loadAudit();
}

function syncStoveClock() {
  openActionModal({
    title: "⌚ Synchronisation RTC Batch",
    message: "Synchroniser l'horloge interne RTC et le calendrier du poêle (6 registres en une seule écriture groupée) avec l'heure actuelle ?",
    confirmText: "Synchroniser",
    onConfirm: async () => {
      showToast("Synchronisation de l'horloge RTC en cours...");
      try {
        const j = await window.stoveProvider.syncClock();
        await refreshLatestOnly();
        showToast("Horloge synchronisée sur : " + (j.synced_to || "OK"));
      } catch (e) {
        showToast("Erreur sync horloge : " + (e?.message || "Échec"), true);
        reportClientError("RESEAU", `Erreur réseau sync horloge : ${e?.message || "Échec"}`);
      }
    }
  });
}

function resetStoveAlarm() {
  const st = Number(latestData.status_code ?? 0);
  const tf = Number(latestData.temp_fumes ?? 0);
  const rpm = Number(latestData.exhaust_rpm ?? 0);
  const alarm = Number(latestData.alarm_code ?? 0);
  const isPelletOpen = Boolean(latestData.popup_pellet_open || alarm === 16);
  const isDoorOpen = Boolean(latestData.popup_door_open || alarm === 15);
  const isPelletEmpty = Boolean(latestData.popup_pellet_empty);

  // CAS 1 : Sécurité mécanique - Trappe granulés ouverte
  if (isPelletOpen) {
    openActionModal({
      title: "🔒 Sécurité Mécanique : Trappe Granulés Ouverte",
      htmlContent: `
        <div class="space-y-3 text-xs leading-relaxed">
          <div class="p-2.5 rounded-lg bg-amber-950/50 border border-amber-600/60 text-amber-200">
            <strong>⚠️ Contacteur de sécurité réservoir ouvert :</strong> La trappe du réservoir à granulés est ouverte ou son capteur n'est pas engagé.
          </div>
          <div class="text-gray-300 space-y-1.5 text-[11px]">
            <p>• Cette sécurité matérielle <strong>coupe immédiatement le moteur de la vis sans fin</strong> pour prévenir tout risque mécanique.</p>
            <p>• <span class="text-rose-400 font-bold">Cette sécurité ne s'acquitte pas à distance ni via un bouton logiciel.</span></p>
            <p>• <strong>Action requise :</strong> Refermez simplement et fermement la trappe du réservoir à granulés sur le poêle.</p>
            <p class="text-emerald-400">Dès fermeture physique, le contacteur se réenclenche et l'alerte s'efface automatiquement.</p>
          </div>
        </div>
      `,
      confirmText: "Compris, je referme la trappe",
      showCancel: false,
      onConfirm: () => { }
    });
    return;
  }

  // CAS 2 : Sécurité mécanique - Porte foyer ouverte
  if (isDoorOpen) {
    openActionModal({
      title: "🚪 Sécurité Mécanique : Porte Foyer Ouverte",
      htmlContent: `
        <div class="space-y-3 text-xs leading-relaxed">
          <div class="p-2.5 rounded-lg bg-amber-950/50 border border-amber-600/60 text-amber-200">
            <strong>⚠️ Contacteur de porte ouvert :</strong> La porte vitrée du foyer de combustion est ouverte.
          </div>
          <div class="text-gray-300 space-y-1.5 text-[11px]">
            <p>• Cette sécurité matérielle coupe la vis sans fin et interdit l'allumage.</p>
            <p>• <span class="text-rose-400 font-bold">Elle ne s'acquitte pas à distance.</span></p>
            <p>• <strong>Action requise :</strong> Refermez physiquement la porte du foyer et verrouillez la poignée.</p>
          </div>
        </div>
      `,
      confirmText: "Compris, je ferme la porte",
      showCancel: false,
      onConfirm: () => { }
    });
    return;
  }

  // CAS 3 : Alerte Réserve - Trémie granulés vide (aucun acquittement requis)
  if (isPelletEmpty && alarm === 0 && st !== 10 && st !== 11) {
    openActionModal({
      title: "🌾 Alerte Réserve : Trémie Granulés Vide",
      htmlContent: `
        <div class="space-y-3 text-xs leading-relaxed">
          <div class="p-2.5 rounded-lg bg-amber-950/50 border border-amber-600/60 text-amber-200">
            <strong>⚠️ Niveau bas dans la trémie :</strong> La sonde de réserve indique que le réservoir à granulés est presque vide.
          </div>
          <div class="text-gray-300 space-y-1.5 text-[11px]">
            <p>• <span class="text-emerald-400 font-bold">Pas besoin d'acquitter l'alarme</span> (ni à distance, ni via la télécommande P3).</p>
            <p>• <strong>Action requise :</strong> Il suffit simplement de remettre des granulés dans la trémie et de refermer la trappe.</p>
            <p class="text-emerald-400">Dès que les granulés recouvrent la sonde de réserve, l'alerte s'efface automatiquement.</p>
          </div>
        </div>
      `,
      confirmText: "Compris, je remets du pellet",
      showCancel: false,
      onConfirm: () => { }
    });
    return;
  }

  // CAS 4 : Alarme AL03 - PELLET FINI (Réservoir vide / Vis désamorcée)
  if (alarm === 3) {
    const isCooling = (st === 10 && tf > 65);
    openActionModal({
      title: "🛡️ Procédure Constructeur : Alarme AL03 (Pellet Fini)",
      htmlContent: `
        <div class="space-y-3 text-xs leading-relaxed">
          <div class="p-2.5 rounded-lg bg-rose-950/50 border border-rose-600/60 text-rose-200">
            <strong>⚠️ L'alarme AL03 ne s'acquitte JAMAIS à distance</strong>, même poêle froid (sécurité matérielle constructeur Nobis & norme EN 14785).
          </div>

          ${isCooling ? `
          <div class="p-2.5 rounded-lg bg-amber-950/40 border border-amber-600/50 text-amber-200">
            <strong>⏳ Phase de refroidissement actif en cours :</strong>
            <div class="mt-1 flex items-center justify-between text-[11px] tabular-nums">
              <span>Température fumées : <b>${tf}°C</b></span>
              <span>Extracteur fumées : <b>${rpm} tr/min</b></span>
            </div>
            <p class="mt-1 text-[11px] text-gray-300">La carte électronique verrouille tout acquittement tant que les fumées ne sont pas descendues sous ~65°C.</p>
          </div>
          ` : `
          <div class="p-2 rounded-lg bg-emerald-950/40 border border-emerald-600/50 text-emerald-300 text-[11px]">
            ❄️ <strong>Poêle refroidi (${tf}°C) :</strong> Le réarmement physique sur la télécommande est possible.
          </div>
          `}

          <div class="bg-gray-900/80 p-3 rounded-lg border border-gray-800 space-y-2">
            <div class="font-bold text-orange-400 text-[11px] uppercase tracking-wide">Procédure obligatoire sur le poêle Nobis :</div>
            <ol class="list-decimal pl-4 space-y-1.5 text-gray-200 text-[11px]">
              <li><strong>Remplir la trémie :</strong> Verser les granulés dans le réservoir et refermer la trappe (l'alerte trappe s'efface automatiquement).</li>
              <li><strong>Acquitter l'alarme :</strong> Sur la <strong>télécommande physique Nobis</strong>, maintenir la touche <strong>Marche/Arrêt (P3)</strong> enfoncée pendant <strong>3 à 5 secondes</strong> jusqu'au signal sonore d'acquittement.</li>
              <li><strong>Recharger la vis sans fin :</strong> En cas de panne sèche, la vis sans fin est totalement vide. Il faut lancer la fonction de <strong>chargement initial de la vis</strong> via le menu de la télécommande pour amener les pellets au brasier avant tout allumage (évite un nouvel échec d'allumage).</li>
              <li><strong>Vérifier le brasier :</strong> Vider et nettoyer le creuset avant de relancer l'allumage.</li>
            </ol>
          </div>
        </div>
      `,
      confirmText: "Compris (Effectuer sur télécommande)",
      cancelText: "Envoyer OFF bus (170)",
      showCancel: true,
      onConfirm: () => { },
      onCancel: async () => {
        await sendCommand("status_code", 170);
      }
    });
    return;
  }

  // CAS 4 : Autre alarme ou sécurité Nobis
  const alarmDesc = (latestData.alarm_label && !latestData.alarm_label.startsWith("Aucune"))
    ? latestData.alarm_label
    : (alarm > 0 ? `AL${alarm < 10 ? '0' + alarm : alarm}` : (st === 11 ? "Mémoire Alarme" : "Alarme de sécurité"));
  const safeAlarmDesc = escapeHtml(alarmDesc);
  const isCooling = (st === 10 && tf > 65);

  openActionModal({
    title: `🛡️ Procédure Constructeur : ${alarmDesc}`,
    htmlContent: `
      <div class="space-y-3 text-xs leading-relaxed">
        <div class="p-2.5 rounded-lg bg-rose-950/50 border border-rose-600/60 text-rose-200">
          <strong>⚠️ Alarme active : ${safeAlarmDesc}</strong>
          <p class="mt-1 text-[11px] text-gray-300">Conformément aux normes constructeur Nobis, les alarmes de sécurité critiques ne s'acquittent pas à distance.</p>
        </div>

        ${isCooling ? `
        <div class="p-2.5 rounded-lg bg-amber-950/40 border border-amber-600/50 text-amber-200">
          <strong>⏳ Refroidissement sécurité en cours :</strong> Fumées à <b>${tf}°C</b> (${rpm} tr/min). Tout redémarrage est verrouillé par la carte mère jusqu'à refroidissement complet (< 65°C).
        </div>
        ` : `
        <div class="p-2 rounded-lg bg-emerald-950/40 border border-emerald-600/50 text-emerald-300 text-[11px]">
          ❄️ Poêle refroidi (${tf}°C). L'acquittement physique est possible.
        </div>
        `}

        <div class="bg-gray-900/80 p-3 rounded-lg border border-gray-800 space-y-1.5 text-[11px] text-gray-200">
          <div class="font-bold text-orange-400 uppercase tracking-wide">Procédure de déblocage :</div>
          <p>1. Attendre l'arrêt complet de la ventilation.</p>
          <p>2. Résoudre la cause physique du défaut.</p>
          <p>3. Effectuer un <strong>appui long (3 à 5 secondes)</strong> sur la touche <strong>Marche/Arrêt (P3)</strong> de la télécommande physique Nobis.</p>
          <p class="text-gray-400 text-[10px] italic">* Si alarme AL14 (sécurité thermique) : dévisser le bouchon à l'arrière du poêle pour réarmer le bouton poussoir mécanique bilame.</p>
        </div>
      </div>
    `,
    confirmText: "Compris (Effectuer sur télécommande)",
    cancelText: "Envoyer OFF bus (170)",
    showCancel: true,
    onConfirm: () => { },
    onCancel: async () => {
      await sendCommand("status_code", 170);
    }
  });
}

function confirmPower(turnOn) {
  openActionModal({
    title: turnOn ? "🔥 Allumage du Poêle" : "🛑 Extinction du Poêle",
    message: turnOn
      ? "Confirmer l'ALLUMAGE du poêle Nobis A10 C Light Style Coax (Code 85 sur offset 232) ?"
      : "Confirmer l'EXTINCTION du poêle (Code 170 sur offset 232) ?",
    confirmText: turnOn ? "Allumer (85)" : "Éteindre (170)",
    onConfirm: () => sendCommand("status_code", turnOn ? 85 : 170)
  });
}

// Actionneur contextuel unique : déclenche l'action appropriée (Allumage, Extinction ou Reset)
function handleDynamicPowerAction() {
  const st = Number(latestData.status_code ?? 0);
  const alarm = Number(latestData.alarm_code ?? 0);
  const blackout = Number(latestData.blackout_popup ?? 0);
  const isAlarm = (st === 10 || st === 11 || alarm > 0 || blackout > 0);

  if (isAlarm) {
    resetStoveAlarm();
    return;
  }

  if (st === 0) {
    const stoveLabel = latestData?.stove_name || "votre poêle";
    openActionModal({
      title: "🔥 Allumage du Poêle",
      message: `Confirmer l'ALLUMAGE de ${stoveLabel} (Code 85 sur offset 232) ?`,
      confirmText: "Allumer (85)",
      onConfirm: () => sendCommand("status_code", 85)
    });
    return;
  }

  if (st >= 1 && st <= 4) {
    const label = latestData.status_label || "Allumage en cours";
    openActionModal({
      title: "🛑 Arrêt de la séquence d'allumage",
      message: `Le poêle est actuellement en phase de démarrage (${label}).\nConfirmer l'interruption et l'extinction (Code 170 sur offset 232) ?`,
      confirmText: "Éteindre (170)",
      onConfirm: () => sendCommand("status_code", 170)
    });
    return;
  }

  if (st === 7) {
    openActionModal({
      title: "⏳ Poêle en cours d'extinction",
      message: "Le poêle effectue déjà son cycle de refroidissement et d'évacuation (ARRÊT).\nSouhaitez-vous forcer un nouvel ordre d'extinction (Code 170 sur offset 232) ?",
      confirmText: "Forcer extinction (170)",
      onConfirm: () => sendCommand("status_code", 170)
    });
    return;
  }

  if (st === 8 || st === 9) {
    const label = latestData.status_label || "Veille Stand-by";
    openActionModal({
      title: "🛑 Sortie de veille et extinction",
      message: `Le poêle est actuellement en mode veille (${label}).\nConfirmer l'extinction complète (Code 170 sur offset 232) ?`,
      confirmText: "Éteindre (170)",
      onConfirm: () => sendCommand("status_code", 170)
    });
    return;
  }

  if (st === -1) {
    openActionModal({
      title: "⚠️ Poêle Hors Ligne",
      message: "La communication avec le poêle est indisponible. Tenter d'envoyer l'ordre d'extinction (Code 170) ?",
      confirmText: "Envoyer OFF (170)",
      onConfirm: () => sendCommand("status_code", 170)
    });
    return;
  }

  // Par défaut : état de chauffe (TRAVAIL, NETTOYAGE BRASIER...)
  confirmPower(false);
}

async function sendRawOffset() {
  const offsetVal = document.getElementById("raw-offset").value;
  const valStr = document.getElementById("raw-value").value;
  if (offsetVal === "" || valStr === "") {
    showToast("Veuillez renseigner un Offset et une Valeur.", true);
    return;
  }
  const offset = Number(offsetVal);
  const value = Number(valStr);
  try {
    await window.stoveProvider.sendCommand(`RAW_${offset}`, value, offset);
    showToast(`Offset brut #${offset} = ${value} écrit !`);
  } catch (e) {
    showToast("Erreur offset brut : " + (e?.message || "Échec"), true);
    reportClientError("RESEAU", `Erreur réseau offset brut #${offset} : ${e?.message || "Échec"}`);
  }
  await refreshLatestOnly();
  if (window.stoveProvider?.isContainerActive?.() && typeof loadAudit === "function") loadAudit();
}
