"""Arbre de décision différé par lot (Mélange P/A) et enrichissement télémétrique avec cache par cycle."""
import copy
from datetime import datetime
import statistics
import threading
from typing import Any

from analytics.forecast import (
    BATCH_MIN_CYCLES,
    BATCH_MIN_EVAL_MINUTES,
    STABILIZATION_WARMUP_S,
    _percentile,
    clamp_nobis_trim,
    get_pellet_batch_state,
)
from clients import weather_service
from database import get_rolling_consumption_stats, get_settings_dict

_enrich_cache_lock = threading.RLock()
_enrich_cache: dict[str, Any] = {"key": None, "payload": None}


def _resolve_conn_cache_identity(conn: Any) -> tuple[str, int] | None:
    """Retourne (chemin_db, count_telemetry) pour le cache d'enrichissement, ou None pour une base :memory:."""
    try:
        db_rows = conn.execute("PRAGMA database_list").fetchall()
        db_file = str(db_rows[0][2] or "") if db_rows else ""
        if not db_file:
            return None
        cnt_row = conn.execute("SELECT COUNT(*) FROM telemetry").fetchone()
        return db_file, int(cnt_row[0]) if cnt_row else 0
    except Exception:
        return None


def _collect_stabilized_batch_samples(
    conn: Any,
    eval_start_epoch: int,
) -> tuple[list[dict[str, Any]], float, int]:
    """Filtre les cycles de TRAVAIL stabilisés (hors 20 min d'inertie et ruptures) depuis eval_start_epoch."""
    try:
        poll_interval_s = max(15.0, min(3600.0, float(get_settings_dict().get("poll_interval_s", "120"))))
    except (ValueError, TypeError):
        poll_interval_s = 120.0
    max_gap_s = max(360.0, poll_interval_s * 2.5)
    max_dt_s = max(180.0, poll_interval_s * 1.5)
    default_first_dt_s = min(60.0, poll_interval_s)

    rows = conn.execute(
        """
        SELECT id, epoch, status_code, alarm_code, popup_flags,
               temp_fumes, temp_probe_k, exhaust_rpm, depression_pa,
               power_actual, vent_front_actual, duct_left_actual, duct_right_actual,
               raw_buffer_json
        FROM telemetry
        WHERE epoch >= ?
          AND status_code != -1
          AND (comm_mode = 'simulation' OR (raw_buffer_json IS NOT NULL AND raw_buffer_json != '{}'))
        ORDER BY epoch ASC
        """,
        (eval_start_epoch,),
    ).fetchall()

    stabilized_samples: list[dict[str, Any]] = []
    cycle_start_epoch: int | None = None
    prev_epoch: int | None = None
    valid_cycles_count = 0
    cycle_counted = False
    accumulated_stable_s = 0.0

    for r in rows:
        ep = int(r["epoch"])
        st = int(r["status_code"] or 0)
        al = int(r["alarm_code"] or 0)
        pop = int(r["popup_flags"] or 0)

        is_break = prev_epoch is not None and (ep - prev_epoch) > max_gap_s
        if st != 5 or al != 0 or pop != 0 or is_break:
            cycle_start_epoch = None
            cycle_counted = False
            prev_epoch = ep
            continue

        if cycle_start_epoch is None:
            cycle_start_epoch = ep

        tf = float(r["temp_fumes"] or 0.0)
        tk = float(r["temp_probe_k"] or 0.0)
        rpm = int(r["exhaust_rpm"] or 0)
        dep = float(r["depression_pa"] or 0.0)
        pwr = int(r["power_actual"] or 0)
        vf = int(r["vent_front_actual"] or 0)
        vdl = int(r["duct_left_actual"] or 0)
        vdr = int(r["duct_right_actual"] or 0)
        is_vented = vf > 0 or vdl > 0 or vdr > 0

        dt = min(max_dt_s, max(1.0, float(ep - prev_epoch))) if prev_epoch else default_first_dt_s
        prev_epoch = ep

        if (ep - cycle_start_epoch) < STABILIZATION_WARMUP_S:
            continue

        if not cycle_counted:
            valid_cycles_count += 1
            cycle_counted = True

        accumulated_stable_s += dt

        if dep > 0.05 and rpm > 100:
            ratio_tf = tk / tf if tf > 10.0 else 3.0
            stabilized_samples.append({
                "epoch": ep,
                "temp_fumes": tf,
                "temp_probe_k": tk,
                "depression_pa": dep,
                "exhaust_rpm": rpm,
                "rpm_per_pa": rpm / dep,
                "ratio_tf": ratio_tf,
                "power_actual": pwr,
                "vent_active": is_vented,
            })

    return stabilized_samples, accumulated_stable_s / 60.0, valid_cycles_count


def _build_accumulating_result(
    brand_name: str,
    stable_minutes: float,
    valid_cycles_count: int,
    cur_p_trim: int,
    cur_e_trim: int,
    cur_dep: float,
    cur_rpm: int,
) -> tuple[dict[str, Any], dict[str, Any]]:
    rem_mins = max(0, int(BATCH_MIN_EVAL_MINUTES - stable_minutes))
    rem_cyc = max(0, BATCH_MIN_CYCLES - valid_cycles_count)
    pellet_q = {
        "status": "accumulating",
        "quality_score": None,
        "quality_label": f"Acquisition Lot ({int(stable_minutes)}/{int(BATCH_MIN_EVAL_MINUTES)} min)",
        "quality_color": "sky",
        "target_flame_temp": None,
        "flame_delta": None,
        "flame_delta_avg": None,
        "stable_minutes": int(stable_minutes),
        "current_trim": cur_p_trim,
        "suggested_trim": cur_p_trim,
        "explanation": (
            f"Lot « {brand_name} » en observation : {int(stable_minutes)} min stabilisées sur {int(BATCH_MIN_EVAL_MINUTES)} min requises, "
            f"{valid_cycles_count}/{BATCH_MIN_CYCLES} cycles. Reste environ {rem_mins} min et {rem_cyc} cycle(s) pour calibrer le dosage PELLET."
        ),
        "action_needed": False,
        "pellet_brand": brand_name,
    }
    exhaust_q = {
        "status": "accumulating",
        "quality_score": None,
        "quality_label": f"Acquisition Coaxial ({int(stable_minutes)}/{int(BATCH_MIN_EVAL_MINUTES)} min)",
        "quality_color": "sky",
        "target_depression_pa": None,
        "depression_pa": round(cur_dep, 1),
        "dep_delta": None,
        "dep_delta_avg": None,
        "stable_minutes": int(stable_minutes),
        "exhaust_rpm": cur_rpm,
        "current_trim": cur_e_trim,
        "suggested_trim": cur_e_trim,
        "explanation": (
            f"L'analyse du tirage dynamique requiert {int(BATCH_MIN_EVAL_MINUTES)} min de régime établi en TRAVAIL (actuellement {int(stable_minutes)} min). "
            f"Tarage extracteur actuel : {cur_e_trim:+d}%."
        ),
        "action_needed": False,
    }
    return pellet_q, exhaust_q


def evaluate_batch_combustion_and_trim(conn: Any, current_record: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """
    Arbre de décision différé pour le Nobis A10 C Light Style Coax :
    - Filtre les trames hors ligne (status_code == -1) et les trames à buffer brut vide hors simulation.
    - Ne conserve que la phase TRAVAIL (OFFSET_8 == 5), sans alarme (OFFSET_34 == 0) ni pop-up (OFFSET_115 == 0).
    - Ignore les 20 premières minutes de chaque cycle de TRAVAIL.
    - Attend 180 minutes cumulées et 4 cycles distincts avant de proposer un réglage.
    """
    batch_state = get_pellet_batch_state()
    eval_start_epoch = max(
        int(batch_state.get("raz_epoch") or 0),
        int(batch_state.get("last_applied_epoch") or 0),
    )
    brand_name = str(batch_state.get("pellet_brand") or "Lot Standard DINplus / ENplus A1")
    baseline_rpm_pa = batch_state.get("baseline_rpm_per_pa")

    cur_p_trim = clamp_nobis_trim(current_record.get("trim_pellet_pct") or 0)
    cur_e_trim = clamp_nobis_trim(current_record.get("trim_exhaust_pct") or 0)
    cur_flame = float(current_record.get("temp_probe_k") or 0.0)
    cur_dep = float(current_record.get("depression_pa") or 0.0)
    cur_rpm = int(current_record.get("exhaust_rpm") or 0)

    stabilized_samples, stable_minutes, valid_cycles_count = _collect_stabilized_batch_samples(conn, eval_start_epoch)
    is_eval_ready = stable_minutes >= BATCH_MIN_EVAL_MINUTES and valid_cycles_count >= BATCH_MIN_CYCLES

    if not is_eval_ready or len(stabilized_samples) < 30:
        return _build_accumulating_result(
            brand_name, stable_minutes, valid_cycles_count, cur_p_trim, cur_e_trim, cur_dep, cur_rpm
        )

    fumes_sorted = sorted(s["temp_fumes"] for s in stabilized_samples)
    flame_sorted = sorted(s["temp_probe_k"] for s in stabilized_samples)
    dep_sorted = sorted(s["depression_pa"] for s in stabilized_samples)
    rpm_pa_sorted = sorted(s["rpm_per_pa"] for s in stabilized_samples)
    ratio_tf_sorted = sorted(s["ratio_tf"] for s in stabilized_samples)

    med_fumes = round(float(statistics.median(fumes_sorted)), 1)
    p90_fumes = round(_percentile(fumes_sorted, 0.90), 1)
    med_flame = round(float(statistics.median(flame_sorted)), 1)
    p90_flame = round(_percentile(flame_sorted, 0.90), 1)
    med_dep = round(float(statistics.median(dep_sorted)), 2)
    med_rpm_pa = round(float(statistics.median(rpm_pa_sorted)), 1)
    med_ratio_tf = round(float(statistics.median(ratio_tf_sorted)), 2)

    unvent_high_pwr = [s for s in stabilized_samples if (not s["vent_active"]) and s["power_actual"] >= 3]
    p7_samples = [s for s in stabilized_samples if s["power_actual"] >= 6]
    low_p_samples = [s for s in stabilized_samples if s["power_actual"] <= 2]

    sug_p = cur_p_trim
    sug_e = cur_e_trim
    p_label = "Combustion Optimale (ENplus A1)"
    e_label = "Aéraulique Coaxiale Optimale"
    p_color = "emerald"
    e_color = "emerald"
    p_action = False
    e_action = False

    if len(unvent_high_pwr) >= 10 and statistics.median([s["temp_fumes"] for s in unvent_high_pwr]) > 170.0:
        med_unvent = round(float(statistics.median([s["temp_fumes"] for s in unvent_high_pwr])), 1)
        p_label = "VETO : Ventilation Coupée (Surchauffe)"
        e_label = "VETO : Défaut Échange Thermique"
        p_color = "rose"
        e_color = "rose"
        p_exp = (
            f"VETO SÉCURITÉ ({len(unvent_high_pwr)} pts à P3..P8 sans ventilation) : les fumées montent à {med_unvent}°C "
            f"(max certifié : 168°C). Ne modifiez pas le tarage granulés : réglez la ventilation frontale et les canalisations sur PS (Auto)."
        )
        e_exp = (
            "La chaleur n'est pas évacuée de l'échangeur car les ventilateurs sont à 0 (OFF). "
            "Activez le mode PS (offset 33132/33134/33136 = 8) et ramenez tout tarage excessif entre -5% et +5%."
        )

    elif med_dep < 2.0 or (baseline_rpm_pa and med_rpm_pa > baseline_rpm_pa * 1.15):
        p_label = "VETO : Entretien Foyer Requis"
        e_label = "Alerte Encrassement / Coaxial (< 2 Pa)"
        p_color = "rose"
        e_color = "rose"
        p_exp = (
            f"VETO MAINTENANCE : La dépression médiane ({med_dep} Pa) ou l'effort de l'extracteur ({med_rpm_pa} RPM/Pa "
            f"vs réf. {baseline_rpm_pa} RPM/Pa) signale un encrassement. Tarage granulés verrouillé."
        )
        e_exp = (
            "Interdiction d'augmenter PRISE D'AIR pour masquer un colmatage (risque Alarme 11/13). "
            "À froid et débranché : aspirez le brasero, le compartiment derrière le coupe-flamme et vérifiez le conduit coaxial Ø 80/130."
        )

    elif (p7_samples and statistics.median([s["temp_fumes"] for s in p7_samples]) > 168.0) or p90_flame > 630.0:
        sug_p = clamp_nobis_trim(cur_p_trim - 2)
        sug_e = clamp_nobis_trim(cur_e_trim + 2)
        p_action = sug_p != cur_p_trim
        e_action = sug_e != cur_e_trim
        p_label = "Surcharge / Petit Calibre (< 2 cm)"
        e_label = "Manque d'O₂ Comburant"
        p_color = "amber"
        e_color = "amber"
        p_exp = (
            f"Sur {stable_minutes:.0f} min ({len(stabilized_samples)} pts), P90 Flamme = {p90_flame}°C (> 630°C) et P90 Fumées = {p90_fumes}°C. "
            f"Granulés denses ou courts (< 2 cm) : selon la notice Nobis (Mélange P/A), réduisez PELLET à {sug_p:+d}%."
        )
        e_exp = (
            f"Pour oxygéner ce chargement dense et stabiliser les fumées sous 168°C, "
            f"augmentez PRISE D'AIR à {sug_e:+d}% dans le menu MÉLANGE P/A (plage -5% à +5%)."
        )

    elif med_fumes > 160.0 and med_ratio_tf < 2.7 and med_dep > 3.8:
        sug_p = cur_p_trim
        sug_e = clamp_nobis_trim(cur_e_trim - 2)
        e_action = sug_e != cur_e_trim
        p_label = "Charge Granulés Correcte"
        e_label = "Excès d'Aspiration (Pertes Fumées)"
        p_color = "emerald"
        e_color = "amber"
        p_exp = f"Ratio Flamme/Fumées bas ({med_ratio_tf}) avec fumées à {med_fumes}°C : le dosage granulés ({cur_p_trim:+d}%) est correct."
        e_exp = (
            f"Dépression soutenue ({med_dep} Pa) évacuant trop vite les gaz chauds dans le conduit coaxial. "
            f"Proposition : abaisser PRISE D'AIR à {sug_e:+d}%."
        )

    elif low_p_samples and statistics.median([s["temp_fumes"] for s in low_p_samples]) < 105.0 and med_flame < 330.0:
        sug_p = clamp_nobis_trim(cur_p_trim + 2)
        sug_e = cur_e_trim
        p_action = sug_p != cur_p_trim
        p_label = "Faible PCI / Risque Condensation"
        e_label = "Aspiration Nominale"
        p_color = "amber"
        e_color = "emerald"
        p_exp = (
            f"Température des fumées proche du minimum certifié (101°C) et flamme basse ({med_flame}°C). "
            f"Proposition : augmenter PELLET à {sug_p:+d}% et activer la fonction ANTICONDENSATION."
        )
        e_exp = f"Tirage coaxial stable (médiane {med_dep} Pa). Conservez PRISE D'AIR à {cur_e_trim:+d}%."

    else:
        p_exp = (
            f"Lot « {brand_name} » évalué sur {stable_minutes:.0f} min ({valid_cycles_count} cycles) : "
            f"Fumées médiane = {med_fumes}°C (plage certifiée 101–168°C), Flamme médiane = {med_flame}°C, Ratio = {med_ratio_tf}. "
            f"Réglage PELLET ({cur_p_trim:+d}%) optimal."
        )
        e_exp = (
            f"Équilibre aéraulique coaxial conforme : Dépression médiane = {med_dep} Pa ({med_rpm_pa} RPM/Pa). "
            f"Réglage PRISE D'AIR ({cur_e_trim:+d}%) optimal."
        )

    med_pwr = float(statistics.median(s["power_actual"] for s in stabilized_samples))
    target_flame = round(430.0 + med_pwr * 40.0, 1)
    flame_deltas = [float(s["temp_probe_k"]) - (430.0 + float(s["power_actual"]) * 40.0) for s in stabilized_samples]
    flame_delta_avg = round(sum(flame_deltas) / len(flame_deltas), 1)

    pellet_quality = {
        "status": "active",
        "quality_score": 95 if p_color == "emerald" else (75 if p_color == "amber" else 55),
        "quality_label": p_label,
        "quality_color": p_color,
        "target_flame_temp": target_flame,
        "flame_delta": round(cur_flame - target_flame, 1),
        "flame_delta_avg": flame_delta_avg,
        "stable_minutes": int(stable_minutes),
        "current_trim": cur_p_trim,
        "suggested_trim": sug_p,
        "explanation": p_exp,
        "action_needed": p_action,
        "pellet_brand": brand_name,
    }

    exhaust_quality = {
        "status": "active",
        "quality_score": 95 if e_color == "emerald" else (75 if e_color == "amber" else 55),
        "quality_label": e_label,
        "quality_color": e_color,
        "target_depression_pa": 3.0,
        "depression_pa": round(cur_dep, 1),
        "dep_delta": round(cur_dep - med_dep, 1),
        "dep_delta_avg": round(med_dep - 3.0, 1),
        "stable_minutes": int(stable_minutes),
        "exhaust_rpm": cur_rpm,
        "current_trim": cur_e_trim,
        "suggested_trim": sug_e,
        "explanation": e_exp,
        "action_needed": e_action,
    }

    return pellet_quality, exhaust_quality


def enrich_telemetry_record(conn: Any, record: dict[str, Any]) -> dict[str, Any]:
    """Enrichit un enregistrement télémétrique avec conso glissante 7j/30j, qualité combustion et météo (avec cache par cycle)."""
    ref_epoch = int(record.get("epoch") or int(datetime.now().timestamp()))
    conn_ident = _resolve_conn_cache_identity(conn)
    cache_key = None
    if conn_ident is not None:
        batch_state = get_pellet_batch_state()
        cache_key = (
            conn_ident[0],
            conn_ident[1],
            ref_epoch,
            int(batch_state.get("raz_epoch") or 0),
            int(batch_state.get("last_applied_epoch") or 0),
            str(batch_state.get("pellet_brand") or ""),
            batch_state.get("baseline_rpm_per_pa"),
            clamp_nobis_trim(record.get("trim_pellet_pct") or 0),
            clamp_nobis_trim(record.get("trim_exhaust_pct") or 0),
            round(float(record.get("temp_probe_k") or 0.0), 1),
            round(float(record.get("depression_pa") or 0.0), 1),
            int(record.get("exhaust_rpm") or 0),
        )
        with _enrich_cache_lock:
            if _enrich_cache["key"] == cache_key and _enrich_cache["payload"] is not None:
                cached = copy.deepcopy(_enrich_cache["payload"])
                record["conso_week_kg"] = cached["conso_week_kg"]
                record["conso_month_kg"] = cached["conso_month_kg"]
                record["pellet_quality"] = cached["pellet_quality"]
                record["exhaust_quality"] = cached["exhaust_quality"]
                record["weather_details"] = weather_service.last_weather
                return record

    stats = get_rolling_consumption_stats(conn, ref_epoch)
    pellet_q, exhaust_q = evaluate_batch_combustion_and_trim(conn, record)
    record["conso_week_kg"] = stats["conso_week_kg"]
    record["conso_month_kg"] = stats["conso_month_kg"]
    record["pellet_quality"] = pellet_q
    record["exhaust_quality"] = exhaust_q
    record["weather_details"] = weather_service.last_weather

    if cache_key is not None:
        with _enrich_cache_lock:
            _enrich_cache["key"] = cache_key
            _enrich_cache["payload"] = copy.deepcopy({
                "conso_week_kg": stats["conso_week_kg"],
                "conso_month_kg": stats["conso_month_kg"],
                "pellet_quality": pellet_q,
                "exhaust_quality": exhaust_q,
            })
    return record
