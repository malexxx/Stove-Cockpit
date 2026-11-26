// Moteur dynamique universel de décodage et détection de capacités Micronova Agua IOT (parité backend).
import schema from "@shared/micronova_schema.json";
import { evaluateMicronovaFormula } from "./formula_eval.js";

const READING_ERROR_VALUE = Number(schema.reading_error_value ?? 32768);
const CANONICAL_ALIASES = schema.canonical_key_aliases || {};
const STATUS_OFF_KEYWORDS = new Set((schema.status_off_keywords || []).map((s) => s.toUpperCase()));
const STATUS_IDLE_KEYWORDS = new Set((schema.status_idle_keywords || []).map((s) => s.toUpperCase()));
const CANALIZATION_REGEXES = (schema.canalization_patterns || []).map((p) => new RegExp(p));

export function parseRegistersMap(rawMapJson) {
  if (!rawMapJson || typeof rawMapJson !== "object") return {};
  const mapsList =
    rawMapJson?.device_registers_map?.registers_map ||
    rawMapJson?.registers_map ||
    rawMapJson?.registersMap ||
    [];
  if (!Array.isArray(mapsList)) return {};

  const out = {};
  for (const entry of mapsList) {
    if (!entry || typeof entry !== "object") continue;
    const subList = Array.isArray(entry.registers) ? entry.registers : [entry];
    for (const reg of subList) {
      if (!reg || typeof reg !== "object") continue;
      const rk = String(reg.reg_key || reg.key || "").trim();
      if (rk && reg.offset !== undefined && reg.offset !== null) {
        out[rk] = { ...reg };
      }
    }
  }
  return out;
}

export function getEncValOptions(regMeta, lang = "FRA") {
  const encList = regMeta?.enc_val;
  if (!Array.isArray(encList) || encList.length === 0) return {};
  const langsAvail = new Set(encList.map((i) => String(i?.lang || "").toUpperCase()).filter(Boolean));
  const targetLang = langsAvail.has(lang.toUpperCase())
    ? lang.toUpperCase()
    : langsAvail.has("ENG")
      ? "ENG"
      : langsAvail.values().next().value || "";

  const options = {};
  for (const item of encList) {
    if (!item || typeof item !== "object") continue;
    if (targetLang && String(item.lang || "").toUpperCase() !== targetLang) continue;
    if (item.value !== undefined && item.value !== null && item.description !== undefined) {
      const iv = Number(item.value);
      if (Number.isFinite(iv)) options[iv] = String(item.description).trim();
    }
  }
  return options;
}

export function evaluateBuffer(rawBuf, registerMap, lang = "FRA") {
  const evaluated = {};
  for (const [key, reg] of Object.entries(registerMap || {})) {
    if (reg.offset === undefined || reg.offset === null) continue;
    const offset = Number(reg.offset);
    if (!Number.isFinite(offset)) continue;
    const entry = { ...reg };
    const rawVal = rawBuf[offset] ?? rawBuf[String(offset)];

    if (rawVal === undefined || rawVal === null) {
      entry.value_raw = null;
      entry.value = null;
      evaluated[key] = entry;
      continue;
    }

    const rawInt = Math.round(Number(rawVal));
    if (!Number.isFinite(rawInt) || rawInt === READING_ERROR_VALUE) {
      entry.value_raw = null;
      entry.value = null;
      evaluated[key] = entry;
      continue;
    }

    const mask = Number(reg.mask ?? reg.Mask ?? 65535);
    const masked = rawInt & mask;
    entry.value_raw = masked;
    const formula = reg.formula || "#";
    try {
      entry.value = evaluateMicronovaFormula(formula, masked);
    } catch {
      entry.value = masked;
    }

    const opts = getEncValOptions(reg, lang);
    if (Object.keys(opts).length > 0 && entry.value !== null) {
      const kInt = Math.round(Number(entry.value));
      entry.description = opts[kInt] ?? String(entry.value);
    }
    evaluated[key] = entry;
  }
  return evaluated;
}

export function resolveCanonical(canonicalKey, evaluated, registerMap = null) {
  const candidates = CANONICAL_ALIASES[canonicalKey] || [canonicalKey];
  for (const rk of candidates) {
    if (evaluated && rk in evaluated) return [rk, evaluated[rk]];
    if (registerMap && rk in registerMap) return [rk, registerMap[rk]];
  }
  return [null, null];
}

function isRegisterEnabled(key, evaluated) {
  const idx = key.lastIndexOf("_");
  const base = idx > 0 ? key.slice(0, idx) : key;
  const enableKey = `${base}_enable`;
  if (!(enableKey in evaluated)) return true;
  const meta = evaluated[enableKey];
  if (String(meta.reg_type || "").toUpperCase() !== "ENABLE") return true;
  if (meta.value === undefined || meta.value === null) return true;
  if (Array.isArray(meta.enable_val) && meta.enable_val.length > 0) {
    const allowed = new Set(meta.enable_val.map((d) => d?.value));
    return allowed.has(meta.value);
  }
  return Math.round(Number(meta.value)) === 1;
}

export function detectDucts(registerMap, evaluated = {}) {
  const ducts = [];
  const seen = new Set();

  const addDuct = (ductId, label, speedSetKey, speedGetKey, tempSetKey, tempGetKey) => {
    const norm = ductId.toUpperCase();
    if (seen.has(norm)) return;
    if (!isRegisterEnabled(speedSetKey, evaluated)) return;
    seen.add(norm);
    const spMeta = registerMap[speedSetKey] || {};
    const tMeta = tempSetKey ? registerMap[tempSetKey] || {} : {};
    ducts.push({
      id: norm,
      label,
      speed_set_key: speedSetKey,
      speed_get_key: speedGetKey && speedGetKey in registerMap ? speedGetKey : null,
      temp_set_key: tempSetKey && tempSetKey in registerMap ? tempSetKey : null,
      temp_get_key: tempGetKey && tempGetKey in registerMap ? tempGetKey : null,
      speed_min: Number(spMeta.set_min ?? 0),
      speed_max: Number(spMeta.set_max ?? 8),
      temp_min: Number(tMeta.set_min ?? 7),
      temp_max: Number(tMeta.set_max ?? 41),
    });
  };

  const pairs = [
    ["SX", "Canalisation Gauche", "duct_left_speed", "duct_left_actual", "duct_left_setpoint", "duct_left_temp"],
    ["DX", "Canalisation Droite", "duct_right_speed", "duct_right_actual", "duct_right_setpoint", "duct_right_temp"],
  ];

  for (const [side, label, spdKey, spdGetKey, tSetKey, tGetKey] of pairs) {
    const spdK = (CANONICAL_ALIASES[spdKey] || []).find((k) => k in registerMap);
    if (spdK) {
      addDuct(
        side,
        label,
        spdK,
        (CANONICAL_ALIASES[spdGetKey] || []).find((k) => k in registerMap) || null,
        (CANONICAL_ALIASES[tSetKey] || []).find((k) => k in registerMap) || null,
        (CANONICAL_ALIASES[tGetKey] || []).find((k) => k in registerMap) || null,
      );
    }
  }

  for (const rk of Object.keys(registerMap || {}).sort()) {
    if (ducts.some((d) => d.speed_set_key === rk)) continue;
    for (const pat of CANALIZATION_REGEXES) {
      const m = pat.exec(rk);
      if (m) {
        const rawId = m[1] || rk;
        let norm = rawId.toUpperCase();
        if (norm === "1") norm = "SX";
        else if (norm === "2" || norm === "REAR") norm = "DX";
        addDuct(
          norm,
          `Zone ${rawId.toUpperCase()}`,
          rk,
          `${rk.replace(/_set$/, "")}_get`,
          `canalization_${rawId}_temp_air_set`,
          `canalization_${rawId}_temp_air_get`,
        );
        break;
      }
    }
  }
  return ducts;
}

export function detectCapabilities(registerMap, evaluated = {}, settings = {}) {
  if (!registerMap || Object.keys(registerMap).length === 0) {
    return {
      stove_type: "air",
      temp_unit: "°C",
      temp_label: "Ambiance",
      temp_min: 7,
      temp_max: 41,
      power_min: 1,
      power_max: 7,
      has_fan_front: true,
      fan_min: 0,
      fan_max: 8,
      ducts: [
        { id: "SX", label: "Canalisation Gauche", speed_min: 0, speed_max: 8, temp_min: 7, temp_max: 41 },
        { id: "DX", label: "Canalisation Droite", speed_min: 0, speed_max: 8, temp_min: 7, temp_max: 41 },
      ],
      has_auto: true,
      has_boost: true,
      has_eco: true,
      can_write_eco: false,
      has_chrono: true,
      has_pellet_level_sensor: false,
      has_flue_temp: true,
      has_flame_k: true,
      has_pressure_pa: true,
      has_exhaust_rpm: true,
      has_water_pressure: false,
      is_nobis_a10_profile: true,
    };
  }

  const [airGetK] = resolveCanonical("temp_amb_get", evaluated, registerMap);
  const [airSetK, airSetMeta] = resolveCanonical("temp_amb_setpoint", evaluated, registerMap);
  const [waterGetK] = resolveCanonical("temp_water_get", evaluated, registerMap);
  const [waterSetK, waterSetMeta] = resolveCanonical("temp_water_setpoint", evaluated, registerMap);

  let stoveType = "air";
  let primaryMeta = airSetMeta || {};
  let tempLabel = "Ambiance";
  if (waterSetK && !airSetK) {
    stoveType = "hydro";
    primaryMeta = waterSetMeta || {};
    tempLabel = "Eau / Chaudière";
  } else if (waterGetK && airGetK) {
    stoveType = "hybrid";
    primaryMeta = airSetMeta || waterSetMeta || {};
    tempLabel = "Ambiance & Eau";
  }

  const tempMin = Number(primaryMeta.set_min ?? (stoveType === "hydro" ? 40 : 7));
  const tempMax = Number(primaryMeta.set_max ?? (stoveType === "hydro" ? 80 : 41));
  const [, pwrMeta] = resolveCanonical("power_level", evaluated, registerMap);
  const powerMin = Number(pwrMeta?.set_min ?? 1);
  const powerMax = Number(pwrMeta?.set_max ?? 7);
  const [fanK, fanMeta] = resolveCanonical("fan_front_speed", evaluated, registerMap);
  const ducts = detectDucts(registerMap, evaluated);
  const brandId = String(settings?.brand_id || settings?.agua_brand || "").toLowerCase();
  const isNobis =
    brandId === "nobis" || ("canalization_sx_set" in registerMap && "canalization_dx_set" in registerMap && powerMax === 7);
  const canWriteEco = Boolean(resolveCanonical("standby_set", evaluated, registerMap)[0]);
  const [, statusMeta] = resolveCanonical("status_get", evaluated, registerMap);
  const statusOpts = statusMeta ? getEncValOptions(statusMeta) : {};
  const hasIdlePhase = Object.values(statusOpts).some((desc) => {
    const up = String(desc || "").toUpperCase();
    for (const kw of STATUS_IDLE_KEYWORDS) {
      if (up.includes(kw)) return true;
    }
    return false;
  });

  return {
    stove_type: stoveType,
    temp_unit: "°C",
    temp_label: tempLabel,
    temp_min: tempMin,
    temp_max: tempMax,
    power_min: powerMin,
    power_max: powerMax,
    has_fan_front: Boolean(fanK),
    fan_min: Number(fanMeta?.set_min ?? 0),
    fan_max: Number(fanMeta?.set_max ?? 8),
    ducts,
    has_auto: Boolean(
      resolveCanonical("fun_auto_set", evaluated, registerMap)[0]
      || resolveCanonical("fun_auto_get", evaluated, registerMap)[0]
    ),
    has_boost: Boolean(
      resolveCanonical("fun_pwf_set", evaluated, registerMap)[0]
      || resolveCanonical("fun_pwf_get", evaluated, registerMap)[0]
    ),
    has_eco: Boolean(canWriteEco || resolveCanonical("standby_get", evaluated, registerMap)[0] || isNobis || hasIdlePhase),
    can_write_eco: canWriteEco,
    has_chrono: Boolean(resolveCanonical("chrono_week_enable_set", evaluated, registerMap)[0]),
    has_pellet_level_sensor: Boolean(resolveCanonical("pellet_level_pct", evaluated, registerMap)[0]),
    has_flue_temp: Boolean(resolveCanonical("temp_fumes", evaluated, registerMap)[0]),
    has_flame_k: Boolean(resolveCanonical("temp_probe_k", evaluated, registerMap)[0]),
    has_pressure_pa: Boolean(resolveCanonical("depression_pa", evaluated, registerMap)[0]),
    has_exhaust_rpm: Boolean(resolveCanonical("exhaust_rpm", evaluated, registerMap)[0]),
    has_water_pressure: Boolean(resolveCanonical("water_pressure_bar", evaluated, registerMap)[0]),
    is_nobis_a10_profile: isNobis,
  };
}

export function prepareWriteValue(regMeta, value) {
  if (!regMeta) return Math.round(Number(value));
  const val = Number(value);
  if (regMeta.set_min !== undefined && regMeta.set_min !== null && val < Number(regMeta.set_min)) {
    throw new Error(`Valeur ${val} inférieure au minimum (${regMeta.set_min})`);
  }
  if (regMeta.set_max !== undefined && regMeta.set_max !== null && val > Number(regMeta.set_max)) {
    throw new Error(`Valeur ${val} supérieure au maximum (${regMeta.set_max})`);
  }
  const fInv = regMeta.formula_inverse || "#";
  let intVal = Math.round(Number(evaluateMicronovaFormula(fInv, val)));
  if (regMeta.is_hex) {
    intVal = Number.parseInt(`0x${intVal}`, 16);
  }
  return intVal;
}

const STATUS_KEYWORD_RULES = [
  [["ECO"], 8],
  [["STAND"], 9],
  [["COOL", "SPEGN", "ARRET", "ARRÊT"], 7],
  [["CLEAN", "PULIZ", "NETTOY"], 6],
  [["WORK", "LAVOR", "TRAVAIL"], 5],
  [["IGNIT", "ACCENS", "ALLUM", "START"], 4],
  [["LOAD", "CARIC"], 3],
  [["PREHEAT", "RISCALD"], 2],
  [["CHECK", "WAIT", "ATTEND"], 1],
];

export function inferNormalizedStatusCode(statusDesc, rawStatus) {
  if (statusDesc) {
    const up = String(statusDesc).trim().toUpperCase();
    if (up.includes("ALARM") || up.includes("ALLARM")) return up.includes("MEM") ? 11 : 10;
    if (up === "ON") return 5;
    if (up.includes("ECO STOP") || up.includes("ECO-STOP")) return 8;
    for (const kw of STATUS_OFF_KEYWORDS) {
      if (up.includes(kw)) return 0;
    }
    for (const [keywords, normalized] of STATUS_KEYWORD_RULES) {
      if (keywords.some((kw) => up.includes(kw))) return normalized;
    }
  }
  return rawStatus !== undefined && rawStatus !== null ? Number(rawStatus) : 0;
}

export function decodeBufferToTelemetry(rawBuf, registerMap, settings = {}, weather = {}, stoveName = "") {
  const ev = evaluateBuffer(rawBuf, registerMap || {});
  const caps = detectCapabilities(registerMap || {}, ev, settings);
  const dyn = (canon, fallback = null) => {
    const [, entry] = resolveCanonical(canon, ev, registerMap);
    return entry && entry.value !== undefined && entry.value !== null ? entry.value : fallback;
  };
  const dynDesc = (canon) => {
    const [, entry] = resolveCanonical(canon, ev, registerMap);
    return entry?.description || null;
  };

  let statusCode = Number(rawBuf[8] ?? rawBuf["8"] ?? 0);
  let statusLabel = schema.stove_states?.[String(statusCode)] || `Code ${statusCode}`;
  const dynStRaw = dyn("status_get");
  const dynStDesc = dynDesc("status_get");
  if (dynStRaw !== null || dynStDesc) {
    statusCode = inferNormalizedStatusCode(dynStDesc, dynStRaw !== null ? Math.round(Number(dynStRaw)) : statusCode);
    if (dynStDesc) statusLabel = dynStDesc;
  }

  let alarmCode = Number(dyn("alarms_get", rawBuf[34] ?? rawBuf["34"] ?? 0));
  let alarmLabel = schema.nobis_alarms?.[String(alarmCode)] || `AL${alarmCode}`;
  const dynAlDesc = dynDesc("alarms_get");
  if (alarmCode > 0 && dynAlDesc) {
    alarmLabel = dynAlDesc;
    statusLabel = `${statusLabel} [${alarmLabel}]`;
  }

  const popupFlags = Number(rawBuf[115] ?? rawBuf["115"] ?? 0);
  const dynPelletLow = dyn("pellet_reserve_low");
  const pelletEmpty = (popupFlags & 64) !== 0 || (dynPelletLow !== null && Math.round(Number(dynPelletLow)) === 1) ? 1 : 0;

  const tempAmbient = caps.stove_type === "hydro"
    ? Number(dyn("temp_water_get", rawBuf[1] ?? 19))
    : Number(dyn("temp_amb_get", rawBuf[103] ?? rawBuf[1] ?? 19));
  const tempAmbSp = caps.stove_type === "hydro"
    ? Number(dyn("temp_water_setpoint", rawBuf[33122] ?? 55))
    : Number(dyn("temp_amb_setpoint", rawBuf[33122] ?? 19));

  const pCmd = Math.round(Number(dyn("power_level", rawBuf[33120] ?? 4)));
  const pActual = Math.round(Number(dyn("real_power", rawBuf[11] ?? pCmd)));
  const tFlags = Number(rawBuf[22] ?? 0);
  const now = new Date();
  const days = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
  const hr = Number(rawBuf[34048] ?? now.getHours());
  const mn = Number(rawBuf[34049] ?? now.getMinutes());
  const dy = Number(rawBuf[34050] ?? now.getDate());
  const mo = Number(rawBuf[34051] ?? now.getMonth() + 1);
  const yr = Number(rawBuf[34052] ?? (now.getFullYear() - 2000)) + 2000;
  const wd = Number(rawBuf[34053] ?? ((now.getDay() + 6) % 7 + 1));
  const clockStr = `${days[wd - 1] || "---"} ${String(hr).padStart(2, "0")}:${String(mn).padStart(2, "0")} ${String(dy).padStart(2, "0")}/${String(mo).padStart(2, "0")}/${yr}`;

  const chrono = {
    chrono_week_enable: Math.round(Number(dyn("chrono_week_enable_set", rawBuf[33162] ?? 0))),
  };
  const chronoDefs = [
    [1, 33164, 48, 63, 127, 7, 19],
    [2, 33184, 126, 138, 127, 7, 19],
    [3, 33204, 144, 144, 0, 7, 20],
    [4, 33224, 144, 144, 0, 7, 20],
  ];
  for (const [idx, baseOff, dStart, dStop, dDays, dPwr, dTemp] of chronoDefs) {
    chrono[`chrono_p${idx}_start`] = Number(rawBuf[baseOff] ?? dStart);
    chrono[`chrono_p${idx}_stop`] = Number(rawBuf[baseOff + 2] ?? dStop);
    chrono[`chrono_p${idx}_days`] = Number(rawBuf[baseOff + 4] ?? dDays);
    chrono[`chrono_p${idx}_power`] = Number(rawBuf[baseOff + 6] ?? dPwr);
    chrono[`chrono_p${idx}_temp`] = Number(rawBuf[baseOff + 8] ?? dTemp);
  }

  const rawAuto = dyn("fun_auto_get", dyn("fun_auto_set", rawBuf[33128]));
  const funAutoVal = rawAuto !== undefined && rawAuto !== null
    ? (Math.round(Number(rawAuto)) > 0 ? 1 : 0)
    : 0;
  const rawPwf = dyn("fun_pwf_get", dyn("fun_pwf_set", rawBuf[33154]));
  const funPwfVal = rawPwf !== undefined && rawPwf !== null
    ? Math.max(0, Math.round(Number(rawPwf)))
    : 0;
  const rawSb = dyn("standby_get", dyn("standby_set", rawBuf[33148] ?? rawBuf[33130]));
  const comfortClimaAbility = dyn("standby_set", rawBuf[33148] ?? rawBuf[33130]);
  const standbyVal = statusCode === 8 || statusCode === 9
    ? 1
    : (rawSb !== undefined && rawSb !== null ? (Math.round(Number(rawSb)) > 0 ? 1 : 0) : 0);

  const latest = {
    timestamp: now.toISOString().slice(0, 19).replace("T", " "),
    epoch: Math.floor(now.getTime() / 1000),
    comm_mode: "agua_cloud",
    stove_name: stoveName || settings?.stove_name || "Poêle Micronova",
    status_code: statusCode,
    status_label: statusLabel,
    status_managed: Number(rawBuf[232] ?? 0),
    alarm_code: alarmCode,
    alarm_label: alarmLabel,
    blackout_popup: Number(rawBuf[40] ?? 0),
    popup_flags: popupFlags,
    popup_door_open: (popupFlags & 16) !== 0 ? 1 : 0,
    popup_pellet_empty: pelletEmpty,
    popup_pellet_open: (popupFlags & 8) !== 0 ? 1 : 0,
    popup_pa_fault: (popupFlags & 4) !== 0 ? 1 : 0,
    popup_tcj_fault: (popupFlags & 2) !== 0 ? 1 : 0,
    popup_tck_fault: (popupFlags & 1) !== 0 ? 1 : 0,
    temp_ambient: tempAmbient,
    temp_amb_setpoint: tempAmbSp,
    temp_fumes: Number(dyn("temp_fumes", rawBuf[2] ?? 25)),
    temp_probe_k: Number(dyn("temp_probe_k", rawBuf[0] ?? 25)),
    exhaust_rpm: Math.round(Number(dyn("exhaust_rpm", Number(rawBuf[47] ?? 0) * 10))),
    depression_pa: Number(dyn("depression_pa", Math.round(Number(rawBuf[37] ?? 0) / 10 * 10) / 10)),
    power_level: pCmd,
    power_actual: pActual,
    fun_auto_set: funAutoVal,
    standby_enabled: standbyVal,
    comfortclima_ability_set: comfortClimaAbility !== undefined && comfortClimaAbility !== null
      ? Math.round(Number(comfortClimaAbility))
      : null,
    comfortclima_time_set: dyn("comfortclima_time_set", rawBuf[33150]),
    comfortclima_restart_set: dyn("comfortclima_restart_set", rawBuf[33152]),
    fun_pwf_set: funPwfVal,
    set_silece_set: 0,
    fan_front_speed: Math.round(Number(dyn("fan_front_speed", rawBuf[33132] ?? 3))),
    vent_front_actual: Math.round(Number(dyn("vent_front_actual", rawBuf[16] ?? 0))),
    duct_left_temp: Number(dyn("duct_left_temp", Math.round((Number(rawBuf[29] ?? 0) / 2) * 10) / 10)),
    duct_left_setpoint: Number(dyn("duct_left_setpoint", rawBuf[33126] ?? 20)),
    duct_left_speed: Math.round(Number(dyn("duct_left_speed", rawBuf[33136] ?? 0))),
    duct_left_actual: Math.round(Number(dyn("duct_left_actual", rawBuf[32] ?? 0))),
    duct_right_temp: Number(dyn("duct_right_temp", Math.round((Number(rawBuf[28] ?? 0) / 2) * 10) / 10)),
    duct_right_setpoint: Number(dyn("duct_right_setpoint", rawBuf[33124] ?? 20)),
    duct_right_speed: Math.round(Number(dyn("duct_right_speed", rawBuf[33134] ?? 0))),
    duct_right_actual: Math.round(Number(dyn("duct_right_actual", rawBuf[31] ?? 0))),
    thermostat_flags: tFlags,
    thermostat_main: (tFlags & 128) !== 0 ? 1 : 0,
    thermostat_dx: (tFlags & 32) !== 0 ? 1 : 0,
    thermostat_sx: (tFlags & 16) !== 0 ? 1 : 0,
    enable_mask_105: Number(rawBuf[105] ?? 18479),
    enable_mask_107: Number(rawBuf[107] ?? 2),
    ...chrono,
    stove_clock_str: clockStr,
    pellet_rate_kgh: [2, 3, 4, 5, 6].includes(statusCode) && pActual > 0 ? Number((0.6 + pActual * 0.22).toFixed(2)) : 0,
    pellet_hopper_pct: Number(dyn("pellet_level_pct", 0)),
    weather_temp_ext: weather?.weather_temp_ext ?? null,
    weather_humidity: weather?.weather_humidity ?? null,
    weather_wind_kmh: weather?.weather_wind_kmh ?? null,
    weather_details: weather && typeof weather === "object" ? weather : null,
    raw_buffer_json: JSON.stringify(rawBuf),
  };

  // Remplissage du catalogue compatible UI (getRegVal)
  const registers = {};
  for (const reg of schema.default_registers_catalog || []) {
    registers[reg.reg_key] = { ...reg, current_val: reg.default_val };
  }
  const syncKeys = [
    ["status_code", latest.status_managed],
    ["power_level", latest.power_level],
    ["fun_auto_set", latest.fun_auto_set],
    ["standby_set", latest.standby_enabled],
    ["comfortclima_time_set", latest.comfortclima_time_set],
    ["comfortclima_restart_set", latest.comfortclima_restart_set],
    ["fun_pwf_set", latest.fun_pwf_set],
    ["temp_amb_setpoint", latest.temp_amb_setpoint],
    ["fan_front_speed", latest.fan_front_speed],
    ["duct_left_setpoint", latest.duct_left_setpoint],
    ["duct_left_speed", latest.duct_left_speed],
    ["duct_right_setpoint", latest.duct_right_setpoint],
    ["duct_right_speed", latest.duct_right_speed],
    ["chrono_week_enable_set", latest.chrono_week_enable],
  ];
  for (const [k, v] of syncKeys) {
    if (registers[k]) registers[k].current_val = v;
  }

  return { latest, registers, capabilities: caps, evaluated: ev };
}
