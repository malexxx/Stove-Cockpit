"""Moteur générique de décodage et détection de capacités Micronova Agua IOT (/deviceGetRegistersMap)."""
import logging
import re
from typing import Any

from config import MICRONOVA_SCHEMA
from telemetry.formula_eval import evaluate_micronova_formula

logger = logging.getLogger("nobis.dynamic_engine")

READING_ERROR_VALUE = int(MICRONOVA_SCHEMA.get("reading_error_value", 32768))
CANONICAL_ALIASES: dict[str, list[str]] = dict(MICRONOVA_SCHEMA.get("canonical_key_aliases") or {})
STATUS_OFF_KEYWORDS = {s.upper() for s in (MICRONOVA_SCHEMA.get("status_off_keywords") or [])}
STATUS_IDLE_KEYWORDS = {s.upper() for s in (MICRONOVA_SCHEMA.get("status_idle_keywords") or [])}
_CANALIZATION_REGEXES = [re.compile(p) for p in (MICRONOVA_SCHEMA.get("canalization_patterns") or [])]


def parse_registers_map(raw_map_json: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Extrait la carte des registres indexée par `reg_key` depuis la réponse /deviceGetRegistersMap."""
    if not isinstance(raw_map_json, dict):
        return {}
    maps_list = (
        raw_map_json.get("device_registers_map", {}).get("registers_map", [])
        or raw_map_json.get("registers_map", [])
        or raw_map_json.get("registersMap", [])
    )
    if not isinstance(maps_list, list):
        return {}

    out: dict[str, dict[str, Any]] = {}
    for entry in maps_list:
        if not isinstance(entry, dict):
            continue
        sub_list = entry.get("registers") if isinstance(entry.get("registers"), list) else [entry]
        for reg in sub_list:
            if not isinstance(reg, dict):
                continue
            rk = str(reg.get("reg_key") or reg.get("key") or "").strip()
            if rk and "offset" in reg and reg["offset"] is not None:
                out[rk] = dict(reg)
    return out


def get_enc_val_options(reg_meta: dict[str, Any], lang: str = "FRA") -> dict[int, str]:
    """Extrait les paires {valeur: libellé} depuis `enc_val` (préférence FRA puis ENG)."""
    enc_list = reg_meta.get("enc_val")
    if not isinstance(enc_list, list) or not enc_list:
        return {}
    langs_avail = {str(item.get("lang") or "").upper() for item in enc_list if isinstance(item, dict)}
    target_lang = lang.upper() if lang.upper() in langs_avail else ("ENG" if "ENG" in langs_avail else next(iter(langs_avail), ""))
    options: dict[int, str] = {}
    for item in enc_list:
        if not isinstance(item, dict):
            continue
        if target_lang and str(item.get("lang") or "").upper() != target_lang:
            continue
        val = item.get("value")
        desc = item.get("description")
        if val is not None and desc is not None:
            try:
                options[int(val)] = str(desc).strip()
            except (ValueError, TypeError):
                pass
    return options


def evaluate_buffer(
    raw_buf: dict[int, float],
    register_map: dict[str, dict[str, Any]],
    lang: str = "FRA",
) -> dict[str, dict[str, Any]]:
    """Évalue tous les registres de `register_map` à partir du buffer brut (masques, formules, 0x8000, enc_val)."""
    evaluated: dict[str, dict[str, Any]] = {}
    for key, reg in register_map.items():
        if "offset" not in reg or reg["offset"] is None:
            continue
        entry = dict(reg)
        try:
            offset = int(reg["offset"])
        except (ValueError, TypeError):
            continue

        raw_val = raw_buf.get(offset)
        if raw_val is None:
            entry["value_raw"] = None
            entry["value"] = None
            evaluated[key] = entry
            continue

        try:
            raw_int = int(round(float(raw_val)))
        except (ValueError, TypeError):
            entry["value_raw"] = None
            entry["value"] = None
            evaluated[key] = entry
            continue

        if raw_int == READING_ERROR_VALUE:
            entry["value_raw"] = None
            entry["value"] = None
            evaluated[key] = entry
            continue

        mask = int(reg.get("mask") or reg.get("Mask") or 65535)
        masked_val = raw_int & mask
        entry["value_raw"] = masked_val
        formula = reg.get("formula") or "#"
        try:
            val = evaluate_micronova_formula(str(formula), masked_val)
            entry["value"] = val
        except Exception as exc:
            logger.debug("Erreur évaluation formule %s (%r): %s", key, formula, exc)
            entry["value"] = masked_val

        opts = get_enc_val_options(reg, lang=lang)
        if opts and entry["value"] is not None:
            try:
                entry["description"] = opts.get(int(round(float(entry["value"]))), str(entry["value"]))
            except (ValueError, TypeError):
                pass
        evaluated[key] = entry
    return evaluated


def resolve_canonical(
    canonical_key: str,
    evaluated: dict[str, dict[str, Any]],
    register_map: dict[str, dict[str, Any]] | None = None,
) -> tuple[str | None, dict[str, Any] | None]:
    """Trouve le premier registre présent correspondant à une clé canonique."""
    candidates = CANONICAL_ALIASES.get(canonical_key, [canonical_key])
    for rk in candidates:
        if rk in evaluated:
            return rk, evaluated[rk]
        if register_map and rk in register_map:
            return rk, register_map[rk]
    return None, None


def _is_register_enabled(key: str, evaluated: dict[str, dict[str, Any]]) -> bool:
    base = key.rsplit("_", 1)[0]
    enable_key = f"{base}_enable"
    if enable_key not in evaluated:
        return True
    meta = evaluated[enable_key]
    if str(meta.get("reg_type") or "").upper() != "ENABLE":
        return True
    val = meta.get("value")
    if val is None:
        return True
    enable_vals = meta.get("enable_val")
    if isinstance(enable_vals, list) and enable_vals:
        allowed = {d.get("value") for d in enable_vals if isinstance(d, dict)}
        return val in allowed
    return int(round(float(val))) == 1


def _detect_ducts(
    register_map: dict[str, dict[str, Any]],
    evaluated: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    ducts: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    def _add_duct(duct_id: str, label: str, speed_set_key: str, speed_get_key: str | None, temp_set_key: str | None, temp_get_key: str | None):
        norm_id = duct_id.upper()
        if norm_id in seen_ids:
            return
        if not _is_register_enabled(speed_set_key, evaluated):
            return
        seen_ids.add(norm_id)
        sp_meta = register_map.get(speed_set_key) or {}
        t_meta = register_map.get(temp_set_key) if temp_set_key else {}
        ducts.append({
            "id": norm_id,
            "label": label,
            "speed_set_key": speed_set_key,
            "speed_get_key": speed_get_key if speed_get_key in register_map else None,
            "temp_set_key": temp_set_key if temp_set_key and temp_set_key in register_map else None,
            "temp_get_key": temp_get_key if temp_get_key and temp_get_key in register_map else None,
            "speed_min": int(sp_meta.get("set_min", 0)),
            "speed_max": int(sp_meta.get("set_max", 8)),
            "temp_min": float((t_meta or {}).get("set_min", 7.0)),
            "temp_max": float((t_meta or {}).get("set_max", 41.0)),
        })

    # Priorité explicite aux clés SX/DX Nobis et génériques pour conserver l'ordre gauche/droite
    for side, def_label, spd_cands, spd_get_cands, t_set_cands, t_get_cands in (
        (
            "SX",
            "Canalisation Gauche",
            CANONICAL_ALIASES.get("duct_left_speed", []),
            CANONICAL_ALIASES.get("duct_left_actual", []),
            CANONICAL_ALIASES.get("duct_left_setpoint", []),
            CANONICAL_ALIASES.get("duct_left_temp", []),
        ),
        (
            "DX",
            "Canalisation Droite",
            CANONICAL_ALIASES.get("duct_right_speed", []),
            CANONICAL_ALIASES.get("duct_right_actual", []),
            CANONICAL_ALIASES.get("duct_right_setpoint", []),
            CANONICAL_ALIASES.get("duct_right_temp", []),
        ),
    ):
        spd_k = next((k for k in spd_cands if k in register_map), None)
        if spd_k:
            _add_duct(
                side,
                def_label,
                spd_k,
                next((k for k in spd_get_cands if k in register_map), None),
                next((k for k in t_set_cands if k in register_map), None),
                next((k for k in t_get_cands if k in register_map), None),
            )

    # Détection générique pour d'autres marques (multifire_1_set, sweetair_1_set, canalization_3_set, etc.)
    for rk in sorted(register_map.keys()):
        if any(rk == d["speed_set_key"] for d in ducts):
            continue
        for pat in _CANALIZATION_REGEXES:
            m = pat.match(rk)
            if m:
                raw_id = m.group(1) if m.groups() else rk
                norm = raw_id.upper()
                if norm in ("SX", "1"):
                    norm = "SX"
                elif norm in ("DX", "2", "REAR"):
                    norm = "DX"
                _add_duct(
                    norm,
                    f"Zone {raw_id.upper()}",
                    rk,
                    f"{rk.rsplit('_set', 1)[0]}_get",
                    f"canalization_{raw_id}_temp_air_set",
                    f"canalization_{raw_id}_temp_air_get",
                )
                break

    return ducts


def detect_capabilities(
    register_map: dict[str, dict[str, Any]],
    evaluated: dict[str, dict[str, Any]] | None = None,
    settings: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Détecte automatiquement les capacités du poêle à partir de /deviceGetRegistersMap."""
    ev = evaluated or {}
    if not register_map:
        # Repli Nobis A10 complet (Simulation / Passerelle locale sans registers_map Cloud)
        return {
            "stove_type": "air",
            "temp_unit": "°C",
            "temp_label": "Ambiance",
            "temp_min": 7.0,
            "temp_max": 41.0,
            "power_min": 1,
            "power_max": 7,
            "has_fan_front": True,
            "fan_min": 0,
            "fan_max": 8,
            "ducts": [
                {"id": "SX", "label": "Canalisation Gauche", "speed_min": 0, "speed_max": 8, "temp_min": 7.0, "temp_max": 41.0},
                {"id": "DX", "label": "Canalisation Droite", "speed_min": 0, "speed_max": 8, "temp_min": 7.0, "temp_max": 41.0},
            ],
            "has_auto": True,
            "has_boost": True,
            "has_eco": True,
            "has_chrono": True,
            "has_pellet_level_sensor": False,
            "has_flue_temp": True,
            "has_flame_k": True,
            "has_pressure_pa": True,
            "has_exhaust_rpm": True,
            "has_water_pressure": False,
            "is_nobis_a10_profile": True,
        }

    air_get_k, _ = resolve_canonical("temp_amb_get", ev, register_map)
    air_set_k, air_set_meta = resolve_canonical("temp_amb_setpoint", ev, register_map)
    water_get_k, _ = resolve_canonical("temp_water_get", ev, register_map)
    water_set_k, water_set_meta = resolve_canonical("temp_water_setpoint", ev, register_map)

    if water_set_k and not air_set_k:
        stove_type = "hydro"
        primary_set_meta = water_set_meta or {}
        temp_label = "Eau / Chaudière"
    elif water_get_k and air_get_k:
        stove_type = "hybrid"
        primary_set_meta = air_set_meta or water_set_meta or {}
        temp_label = "Ambiance & Eau"
    else:
        stove_type = "air"
        primary_set_meta = air_set_meta or {}
        temp_label = "Ambiance"

    temp_min = float(primary_set_meta.get("set_min") if primary_set_meta.get("set_min") is not None else (40.0 if stove_type == "hydro" else 7.0))
    temp_max = float(primary_set_meta.get("set_max") if primary_set_meta.get("set_max") is not None else (80.0 if stove_type == "hydro" else 41.0))

    pwr_k, pwr_meta = resolve_canonical("power_level", ev, register_map)
    power_min = int((pwr_meta or {}).get("set_min") if (pwr_meta or {}).get("set_min") is not None else 1)
    power_max = int((pwr_meta or {}).get("set_max") if (pwr_meta or {}).get("set_max") is not None else 7)

    fan_k, fan_meta = resolve_canonical("fan_front_speed", ev, register_map)
    has_fan_front = bool(fan_k)
    fan_min = int((fan_meta or {}).get("set_min") if (fan_meta or {}).get("set_min") is not None else 0)
    fan_max = int((fan_meta or {}).get("set_max") if (fan_meta or {}).get("set_max") is not None else 8)

    ducts = _detect_ducts(register_map, ev)
    has_auto = resolve_canonical("fun_auto_set", ev, register_map)[0] is not None
    has_boost = resolve_canonical("fun_pwf_set", ev, register_map)[0] is not None
    has_eco = resolve_canonical("standby_set", ev, register_map)[0] is not None
    has_chrono = resolve_canonical("chrono_week_enable_set", ev, register_map)[0] is not None

    brand_id = str((settings or {}).get("agua_brand") or "").strip().lower()
    is_nobis = brand_id == "nobis" or ("canalization_sx_set" in register_map and "canalization_dx_set" in register_map and power_max == 7)

    return {
        "stove_type": stove_type,
        "temp_unit": "°C",
        "temp_label": temp_label,
        "temp_min": temp_min,
        "temp_max": temp_max,
        "power_min": power_min,
        "power_max": power_max,
        "has_fan_front": has_fan_front,
        "fan_min": fan_min,
        "fan_max": fan_max,
        "ducts": ducts,
        "has_auto": has_auto,
        "has_boost": has_boost,
        "has_eco": has_eco,
        "has_chrono": has_chrono,
        "has_pellet_level_sensor": resolve_canonical("pellet_level_pct", ev, register_map)[0] is not None,
        "has_flue_temp": resolve_canonical("temp_fumes", ev, register_map)[0] is not None,
        "has_flame_k": resolve_canonical("temp_probe_k", ev, register_map)[0] is not None,
        "has_pressure_pa": resolve_canonical("depression_pa", ev, register_map)[0] is not None,
        "has_exhaust_rpm": resolve_canonical("exhaust_rpm", ev, register_map)[0] is not None,
        "has_water_pressure": resolve_canonical("water_pressure_bar", ev, register_map)[0] is not None,
        "is_nobis_a10_profile": is_nobis,
    }


def prepare_write_value(reg_meta: dict[str, Any] | None, value: float) -> int:
    """Applique bornes, `formula_inverse` et `is_hex` pour préparer une écriture RWMSmaster."""
    if not reg_meta:
        return int(round(float(value)))

    val = float(value)
    set_min = reg_meta.get("set_min")
    set_max = reg_meta.get("set_max")
    if set_min is not None and val < float(set_min):
        raise ValueError(f"Valeur {val} inférieure au minimum ({set_min})")
    if set_max is not None and val > float(set_max):
        raise ValueError(f"Valeur {val} supérieure au maximum ({set_max})")

    formula_inv = reg_meta.get("formula_inverse") or "#"
    evaluated = evaluate_micronova_formula(str(formula_inv), val)
    int_val = int(round(float(evaluated)))

    if reg_meta.get("is_hex"):
        int_val = int(f"0x{int_val}", 16)
    return int_val


def infer_normalized_status_code(status_desc: str | None, raw_status: int | None) -> int:
    """Normalise un code d'état Micronova hétérogène vers les phases cockpit (-1..11) si besoin."""
    if status_desc:
        up = status_desc.strip().upper()
        if "ALARM" in up or "ALLARM" in up:
            return 11 if ("MEM" in up) else 10
        if any(k in up for k in STATUS_OFF_KEYWORDS):
            return 0
        if "ECO" in up:
            return 8
        if "STAND" in up:
            return 9
        if "COOL" in up or "SPEGN" in up or "ARRET" in up or "ARRÊT" in up:
            return 7
        if "CLEAN" in up or "PULIZ" in up or "NETTOY" in up:
            return 6
        if "WORK" in up or "LAVOR" in up or "TRAVAIL" in up or "ON" == up:
            return 5
        if "IGNIT" in up or "ACCENS" in up or "ALLUM" in up or "START" in up:
            return 4
        if "LOAD" in up or "CARIC" in up:
            return 3
        if "PREHEAT" in up or "RISCALD" in up:
            return 2
        if "CHECK" in up or "WAIT" in up or "ATTEND" in up:
            return 1
    return int(raw_status) if raw_status is not None else 0
