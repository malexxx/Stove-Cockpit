# -*- coding: utf-8 -*-
"""Modèles de données (Enums et Dataclasses) pour l'étalonnage couplé Nobis A10."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class CalibrationMode(str, Enum):
    """Mode opératoire de la session d'étalonnage (débit, combustion ou couplé)."""

    CONSUMPTION_ONLY = "CONSUMPTION_ONLY"   # Étalonnage débit (kg/h) seul
    COMBUSTION_ONLY = "COMBUSTION_ONLY"     # Tarage combustion (Offsets 70/71) seul
    COMBINED_BOTH = "COMBINED_BOTH"         # « Lancer les deux » (Protocole complet AL-03 -> AL-03)


class CalibrationState(str, Enum):
    """États de la machine à états du protocole de calibration couplée Nobis A10."""

    IDLE = "IDLE"
    PREFLIGHT_CHECK = "PREFLIGHT_CHECK"             # Vérification et désactivation P8 (Powerful)
    WAITING_INITIAL_AL03 = "WAITING_INITIAL_AL03"   # Attente cuve 100% vide confirmée par AL-03
    WAITING_COOLING_OFF = "WAITING_COOLING_OFF"     # Réarmement AL-03 et attente état ÉTEINT (OFF)
    WAITING_CHARGE_WEIGHT = "WAITING_CHARGE_WEIGHT" # Pesée du sac étalon et amorçage vis sans fin
    RUNNING_ACQUISITION = "RUNNING_ACQUISITION"     # Enregistrement télémétrique multi-phases P0..P8
    COMPLETED_LOCKED = "COMPLETED_LOCKED"           # Clôture figée sur AL-03 final
    ABORTED_ERROR = "ABORTED_ERROR"


class StoveOperationalPhase(str, Enum):
    """Phases opérationnelles normalisées du poêle Nobis A10 (carte Micronova)."""

    OFF = "ETEINT"
    STARTING = "MISE_EN_MARCHE"                     # Préchauffage bougie + pré-charge granulés
    WAITING_FLAME = "ATTENTE_FLAMME"                # Vis à 0 RPM, développement flamme sur air chaud
    FLAME_PHASE = "PHASE_FLAMME"                    # Reprise vis sans fin et stabilisation brasero
    WORK = "TRAVAIL"                                # Régime modulé P1 à P7 (Offsets 70/71 actifs)
    ECONOMY_RIS = "ECONOMIE"                        # P0 : Modulation basse / RIS (consigne atteinte)
    POWERFUL_BOOST = "POWERFUL"                     # P8 : Boost ventilation max + surcharge
    BRAZIER_CLEANING = "NETTOYAGE_BRASERO"          # Nettoyage périodique en marche (extracteur poussé)
    ACTIVE_CLEANER_CYCLE = "DISPOSITIF_NETTOYAGE_ACTIF"  # Extinction auto + raclage mécanique + rallumage
    REIGNITION = "RALLUMAGE"                        # Attente refroidissement avant redémarrage auto
    COOLING_FINAL = "NETTOYAGE_FINAL"               # Extinction : vis à 0 RPM, refroidissement échangeur
    CLIMATE_COMFORT_STANDBY = "CONFORT_CLIMAT_ECO"  # Veille thermique ECO (poêle arrêté)
    ALARM = "ALARME"                                # Arrêt sécurité (AL-01 à AL-29)


@dataclass
class TelemetrySample:
    """Échantillon télémétrique instantané injecté dans le moteur de calibration."""

    timestamp: float
    phase: StoveOperationalPhase
    power_level: int                  # 0 (P0/RIS), 1..7 (P1..P7), 8 (P8/Powerful)
    alarm_code: str | None            # ex: "AL-03", "AL-02", "AL-16", None
    auger_rpm_actual: float           # VIS S. FIN (RPM réel lu sur encodeur BLDC 24V)
    auger_rpm_set: float              # SET V.S.F. (RPM consigne)
    auger_current_ma: float           # AMP. V.S.F. (mA - chute < 65 mA si vis tourne à vide)
    flue_pressure_pa: float           # PRS (Pa)
    flue_pressure_set_pa: float       # SET PRS (Pa)
    smoke_extractor_rpm: float        # EXT. FUMEES (RPM)
    flame_temp_c: float               # T. FLAMME (°C - Sonde K foyer)
    smoke_temp_c: float               # T. HOT FUM (°C - Sonde fumées)
    room_temp_c: float                # T. PALMAR (°C)
    offset_70_pellet: int             # MELANGE P/A -> PELLET (-5 à +5 %)
    offset_71_air: int                # MELANGE P/A -> PRISE D AIR (-5 à +5 %)
    powerful_enabled_mode: str        # "OFF", "ON", "CHRONO"
    optima_flame_active: bool = False
    anticondensation_active: bool = False
    excessive_load_flag: bool = False
    hot_fumes_flag: bool = False
    hopper_lid_open: bool = False
    door_or_ashtray_open: bool = False


@dataclass
class PhaseBreakdownStats:
    """Statistiques de répartition des durées et masses filtrées par phase au cours d'une calibration."""

    ignition_cycles_count: int = 0
    startup_phases_duration_min: float = 0.0
    startup_estimated_mass_kg: float = 0.0
    brazier_cleaning_duration_min: float = 0.0
    cooling_extinction_ignored_min: float = 0.0
    starvation_pre_al03_ignored_min: float = 0.0
    purged_pre_al03_combustion_samples: int = 0
    warmup_filtered_combustion_samples: int = 0


@dataclass
class CalibrationResult:
    """Bilan final d'étalonnage couplé : débits calibrés par palier et tarages EEPROM 70/71 recommandés."""

    mode: CalibrationMode
    weighed_bag_kg: float
    intrinsic_k_factor: float
    before_flows_kgh: dict[int, float]
    measured_raw_flows_kgh: dict[int, float]
    coupled_effective_flows_kgh: dict[int, float]
    recommended_offset_70: int
    recommended_offset_71: int
    current_offset_70: int
    current_offset_71: int
    time_per_power_hours: dict[int, float]
    phase_stats: PhaseBreakdownStats
    mean_smoke_temp_delta_c: float
    mean_pressure_error_pct: float
    diagnostic_summary: str
    closed_by_al03: bool
