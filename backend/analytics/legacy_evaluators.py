"""Évaluateurs instantanés historiques (isolés pour rétro-compatibilité avec la suite de tests)."""
from typing import Any


def evaluate_pellet_quality(
    status_code: int,
    power_actual: int,
    temp_probe_k: float,
    temp_fumes: float,
    current_trim: int,
    flame_delta_avg: float | None = None,
    stable_minutes: int | None = None,
    power_level: int | None = None,
    fans_active: bool = True,
) -> dict[str, Any]:
    """Évalue la qualité du combustible granulé sur l'écart thermique moyenné sur 30 minutes."""
    if status_code != 5 or power_actual <= 0:
        trim_str = f"{current_trim:+d}%" if current_trim != 0 else "0%"
        if status_code == 5 and power_actual == 0:
            return {
                "status": "modulating",
                "quality_score": None,
                "quality_label": "Modulation P0 (Éco)",
                "quality_color": "sky",
                "target_flame_temp": None,
                "flame_delta": None,
                "flame_delta_avg": None,
                "stable_minutes": 0,
                "current_trim": current_trim,
                "suggested_trim": current_trim,
                "explanation": (
                    f"Poêle en modulation P0 (Ralenti / Consigne atteinte). "
                    f"L'apport de granulés est réduit au strict minimum de maintien de braise. "
                    f"L'analyse IA de calibrage requiert un régime de travail nominal P1 à P7. "
                    f"Tarage granulés en mémoire : {trim_str}."
                ),
                "action_needed": False,
            }
        return {
            "status": "idle",
            "quality_score": None,
            "quality_label": "En attente combustion",
            "quality_color": "gray",
            "target_flame_temp": None,
            "flame_delta": None,
            "flame_delta_avg": None,
            "stable_minutes": 0,
            "current_trim": current_trim,
            "suggested_trim": current_trim,
            "explanation": f"L'évaluation thermique requiert que le poêle soit en phase active de travail (P1 à P7). Tarage granulés en mémoire : {trim_str}.",
            "action_needed": False,
        }

    target_flame = 430.0 + (power_actual * 40.0)
    instant_delta = round(temp_probe_k - target_flame, 1)

    if not fans_active:
        return {
            "status": "natural_convection",
            "quality_score": None,
            "quality_label": "Ventilation coupée (Convection)",
            "quality_color": "amber",
            "target_flame_temp": round(target_flame, 1),
            "flame_delta": instant_delta,
            "flame_delta_avg": None,
            "stable_minutes": stable_minutes or 0,
            "current_trim": current_trim,
            "suggested_trim": current_trim,
            "explanation": (
                f"Ventilateurs de convection frontale et canalisations coupés (offsets 16, 31, 32 à 0). "
                f"En convection naturelle, l'absence d'échange forcé élève la température du foyer (sonde K {temp_probe_k:g}°C vs cible {target_flame:g}°C) sans refléter la qualité réelle du combustible. "
                f"L'ajustement automatique du tarage est verrouillé par sécurité."
            ),
            "action_needed": False,
        }

    if flame_delta_avg is None:
        mins_txt = f"{stable_minutes}/30 min" if stable_minutes else "en cours"
        p_txt = f"P{power_actual}"
        return {
            "status": "stabilizing",
            "quality_score": None,
            "quality_label": f"Stabilisation {p_txt} ({mins_txt})",
            "quality_color": "sky",
            "target_flame_temp": round(target_flame, 1),
            "flame_delta": instant_delta,
            "flame_delta_avg": None,
            "stable_minutes": stable_minutes or 0,
            "current_trim": current_trim,
            "suggested_trim": current_trim,
            "explanation": (
                f"Consigne {p_txt} active depuis {stable_minutes or 1} min. "
                f"Le lissage sur 30 minutes requiert une consigne de puissance et une ventilation stables "
                f"pour atteindre le régime thermique établi avant d'évaluer la qualité du granulé."
            ),
            "action_needed": False,
        }

    delta = round(flame_delta_avg, 1)

    if delta > 30.0:
        suggested = max(-5, current_trim - (2 if delta > 50.0 else 1))
        score = max(60, round(100 - abs(delta) * 0.5))
        label = "Haute Énergie (Très sec / PCI élevé)"
        color = "amber"
        action_needed = suggested != current_trim
        explanation = (
            f"Combustion vive (+{delta:+.1f}°C vs cible P{power_actual}, moyenne 30 min stables). Granulé très dense et sec (fort pouvoir calorifique). "
            f"Conseil : reporter le tarage granulés à {suggested:+d}% sur votre radiocommande (MENU ▸ PROGRAMMATION UTILISATEUR ▸ MÉLANGE G/A) pour préserver le creuset."
        )
    elif delta < -25.0:
        suggested = min(5, current_trim + (2 if delta < -45.0 else 1))
        score = max(50, round(100 - abs(delta) * 0.7))
        label = "Qualité Dégradée (Humide / Faible PCI)"
        color = "rose"
        action_needed = suggested != current_trim
        explanation = (
            f"Rendement thermique en retrait ({delta:+.1f}°C vs cible P{power_actual}, moyenne 30 min stables). Granulé potentiellement humide (>10%) ou poussiéreux. "
            f"Conseil : reporter le tarage granulés à {suggested:+d}% sur votre radiocommande (MENU ▸ PROGRAMMATION UTILISATEUR ▸ MÉLANGE G/A) pour compenser la perte calorifique."
        )
    else:
        suggested = current_trim
        score = min(100, round(96 - abs(delta) * 0.3))
        label = "Optimale (Standard DIN+ / ENplus)"
        color = "emerald"
        action_needed = False
        explanation = (
            f"Combustion équilibrée et propre (écart thermique moyen de {delta:+.1f}°C en P{power_actual} sur 30 min stables). "
            f"Pouvoir calorifique conforme aux spécifications Nobis. Aucun ajustement de tarage requis."
        )

    return {
        "status": "active",
        "quality_score": score,
        "quality_label": label,
        "quality_color": color,
        "target_flame_temp": round(target_flame, 1),
        "flame_delta": instant_delta,
        "flame_delta_avg": delta,
        "stable_minutes": stable_minutes or 30,
        "current_trim": current_trim,
        "suggested_trim": suggested,
        "explanation": explanation,
        "action_needed": action_needed,
    }


def evaluate_exhaust_quality(
    status_code: int,
    power_actual: int,
    depression_pa: float,
    exhaust_rpm: int,
    current_trim: int,
    dep_delta_avg: float | None = None,
    stable_minutes: int | None = None,
    power_level: int | None = None,
    fans_active: bool = True,
) -> dict[str, Any]:
    """Évalue la qualité du tirage du conduit sur l'écart de dépression Pascal moyenné sur 30 minutes."""
    if status_code != 5 or power_actual <= 0:
        trim_str = f"{current_trim:+d}%" if current_trim != 0 else "0%"
        if status_code == 5 and power_actual == 0:
            return {
                "status": "modulating",
                "quality_score": None,
                "quality_label": "Modulation P0 (Éco)",
                "quality_color": "sky",
                "target_depression_pa": None,
                "depression_pa": round(depression_pa, 1) if depression_pa else 0.0,
                "dep_delta": None,
                "dep_delta_avg": None,
                "stable_minutes": 0,
                "exhaust_rpm": exhaust_rpm,
                "current_trim": current_trim,
                "suggested_trim": current_trim,
                "explanation": (
                    f"Poêle en modulation P0 (Ralenti / Consigne atteinte). "
                    f"L'extracteur de fumées tourne au régime réduit de maintien ({exhaust_rpm} RPM). "
                    f"L'analyse aéraulique de calibrage requiert un régime nominal P1 à P7. "
                    f"Tarage extracteur en mémoire : {trim_str}."
                ),
                "action_needed": False,
            }
        return {
            "status": "idle",
            "quality_score": None,
            "quality_label": "En attente tirage actif",
            "quality_color": "gray",
            "target_depression_pa": None,
            "depression_pa": round(depression_pa, 1) if depression_pa else 0.0,
            "dep_delta": None,
            "dep_delta_avg": None,
            "stable_minutes": 0,
            "exhaust_rpm": exhaust_rpm,
            "current_trim": current_trim,
            "suggested_trim": current_trim,
            "explanation": f"L'analyse aéraulique requiert que le poêle soit en phase active de travail (P1 à P7). Tarage extracteur fumées en mémoire : {trim_str}.",
            "action_needed": False,
        }

    target_dep = round(2.0 + (power_actual * 0.25), 1)
    instant_delta = round(depression_pa - target_dep, 1)

    if dep_delta_avg is None:
        mins_txt = f"{stable_minutes}/30 min" if stable_minutes else "en cours"
        p_txt = f"P{power_actual}"
        return {
            "status": "stabilizing",
            "quality_score": None,
            "quality_label": f"Stabilisation {p_txt} ({mins_txt})",
            "quality_color": "sky",
            "target_depression_pa": target_dep,
            "depression_pa": round(depression_pa, 1),
            "dep_delta": instant_delta,
            "dep_delta_avg": None,
            "stable_minutes": stable_minutes or 0,
            "exhaust_rpm": exhaust_rpm,
            "current_trim": current_trim,
            "suggested_trim": current_trim,
            "explanation": (
                f"Consigne {p_txt} active depuis {stable_minutes or 1} min. "
                f"Le lissage sur 30 minutes requiert une consigne de puissance et une ventilation stables "
                f"pour stabiliser le débit d'air comburant mesuré par le capteur embarqué avant d'évaluer le tirage."
            ),
            "action_needed": False,
        }

    delta = round(dep_delta_avg, 1)

    if delta < -1.0 or depression_pa < 1.2:
        suggested = min(5, current_trim + (2 if delta < -2.0 else 1))
        score = max(50, round(100 - abs(delta) * 20.0))
        label = "Débit d'Air Insuffisant (Pertes de charge)"
        color = "rose"
        action_needed = suggested != current_trim
        explanation = (
            f"Dépression dynamique comburant inférieure à la consigne ({delta:+.1f} Pa vs cible {target_dep} Pa, moyenne 30 min stables). "
            f"Mesure capteur embarqué (offset 37) à {depression_pa:g} Pa (seuil d'alerte AL11 à 1,0 Pa). Évacuation ralentie ou pertes de charge. "
            f"Conseil : reporter le tarage extracteur à {suggested:+d}% sur votre radiocommande (MENU ▸ PROGRAMMATION UTILISATEUR ▸ MÉLANGE G/A) ou vérifier l'encrassement du conduit/coaxial."
        )
    elif delta > 1.5 or depression_pa > 6.0:
        suggested = max(-5, current_trim - (2 if delta > 2.5 else 1))
        score = max(55, round(100 - abs(delta) * 15.0))
        label = "Débit d'Air Élevé (Sur-tirage dynamique)"
        color = "amber"
        action_needed = suggested != current_trim
        explanation = (
            f"Dépression dynamique comburant élevée ({delta:+.1f} Pa vs cible {target_dep} Pa, moyenne 30 min stables). "
            f"Sur-tirage dynamique ou vent soutenu évacuant trop vite les calories ({depression_pa:g} Pa). "
            f"Conseil : réduire le tarage extracteur à {suggested:+d}% sur votre radiocommande (MENU ▸ PROGRAMMATION UTILISATEUR ▸ MÉLANGE G/A) pour optimiser le rendement."
        )
    else:
        suggested = current_trim
        score = min(100, round(98 - abs(delta) * 10.0))
        label = "Aéraulique Optimale (Débit Conforme)"
        color = "emerald"
        action_needed = False
        explanation = (
            f"Dépression dynamique et débit comburant parfaitement équilibrés ({depression_pa:g} Pa, écart moyen de {delta:+.1f} Pa en P{power_actual} sur 30 min stables). "
            f"Écoulement d'air comburant (capteur embarqué offset 37) conforme aux spécifications Nobis. Aucun ajustement de tarage requis."
        )

    return {
        "status": "active",
        "quality_score": score,
        "quality_label": label,
        "quality_color": color,
        "target_depression_pa": target_dep,
        "depression_pa": round(depression_pa, 1),
        "dep_delta": instant_delta,
        "dep_delta_avg": delta,
        "stable_minutes": stable_minutes or 30,
        "exhaust_rpm": exhaust_rpm,
        "current_trim": current_trim,
        "suggested_trim": suggested,
        "explanation": explanation,
        "action_needed": action_needed,
    }
