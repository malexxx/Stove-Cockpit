// Simulateur autonome léger (Mode Démo sans poêle physique / Validation Google Play Store).
import schema from "@shared/micronova_schema.json";
import { FRONTEND_VERSION } from "../version.js";

const DEMO_PROFILES = {
  nobis_2ducts: {
    stove_name: "Démo Poêle Air Canalisé (P1-P7)",
    capabilities: {
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
      has_chrono: true,
      has_flue_temp: true,
      has_flame_k: true,
      has_pressure_pa: true,
      has_exhaust_rpm: true,
    },
  },
  simple_air: {
    stove_name: "Démo Poêle Air Simple (P1-P5)",
    capabilities: {
      stove_type: "air",
      temp_unit: "°C",
      temp_label: "Ambiance",
      temp_min: 10,
      temp_max: 35,
      power_min: 1,
      power_max: 5,
      has_fan_front: true,
      fan_min: 0,
      fan_max: 5,
      ducts: [],
      has_auto: true,
      has_boost: false,
      has_eco: true,
      has_chrono: true,
      has_flue_temp: true,
      has_flame_k: false,
      has_pressure_pa: false,
      has_exhaust_rpm: true,
    },
  },
  air_1duct: {
    stove_name: "Démo Poêle Air Canalisé — 1 Zone (SX)",
    capabilities: {
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
      ],
      has_auto: true,
      has_boost: true,
      has_eco: true,
      has_chrono: true,
      has_flue_temp: true,
      has_flame_k: true,
      has_pressure_pa: true,
      has_exhaust_rpm: true,
    },
  },
  hydro: {
    stove_name: "Démo Chaudière Hydro (Eau)",
    capabilities: {
      stove_type: "hydro",
      temp_unit: "°C",
      temp_label: "Eau / Chaudière",
      temp_min: 40,
      temp_max: 80,
      power_min: 1,
      power_max: 5,
      has_fan_front: false,
      fan_min: 0,
      fan_max: 0,
      ducts: [],
      has_auto: true,
      has_boost: false,
      has_eco: false,
      has_chrono: true,
      has_flue_temp: true,
      has_flame_k: false,
      has_pressure_pa: false,
      has_exhaust_rpm: true,
      has_water_pressure: true,
    },
  },
};

export class DemoProvider {
  constructor(profileId = "nobis_2ducts") {
    this.profileId = DEMO_PROFILES[profileId] ? profileId : "nobis_2ducts";
    this.state = {
      status_code: 5,
      status_managed: 85,
      temp_ambient: 20.4,
      temp_amb_setpoint: 21,
      power_level: 4,
      power_actual: 4,
      fan_front_speed: 3,
      vent_front_actual: 4,
      duct_left_temp: 22.1,
      duct_left_setpoint: 21,
      duct_left_speed: 8,
      duct_left_actual: 3,
      duct_right_temp: 19.8,
      duct_right_setpoint: 20,
      duct_right_speed: 2,
      duct_right_actual: 3,
      fun_auto_set: 1,
      fun_pwf_set: 0,
      standby_set: 0,
      chrono_week_enable_set: 0,
      temp_fumes: 148,
      temp_probe_k: 512,
      depression_pa: 3.2,
      exhaust_rpm: 1750,
    };
    this.chrono = {
      chrono_p1_start_set: 42,
      chrono_p1_stop_set: 54,
      chrono_p1_days_mask: 127,
      chrono_p1_power_set: 5,
      chrono_p1_temperature_set: 21,
      chrono_p2_start_set: 108,
      chrono_p2_stop_set: 132,
      chrono_p2_days_mask: 127,
      chrono_p2_power_set: 4,
      chrono_p2_temperature_set: 20,
      chrono_p3_start_set: 144,
      chrono_p3_stop_set: 144,
      chrono_p3_days_mask: 0,
      chrono_p3_power_set: 4,
      chrono_p3_temperature_set: 20,
      chrono_p4_start_set: 144,
      chrono_p4_stop_set: 144,
      chrono_p4_days_mask: 0,
      chrono_p4_power_set: 4,
      chrono_p4_temperature_set: 20,
    };
  }

  setProfile(profileId) {
    if (DEMO_PROFILES[profileId]) {
      this.profileId = profileId;
      if (profileId === "hydro") {
        this.state.temp_ambient = 61.5;
        this.state.temp_amb_setpoint = 65;
      } else {
        this.state.temp_ambient = 20.4;
        this.state.temp_amb_setpoint = 21;
      }
    }
  }

  buildPayload(settings = {}, weather = {}) {
    const prof = DEMO_PROFILES[this.profileId];
    const now = new Date();
    const stCode = this.state.status_code;
    const isHeating = stCode === 5;
    const registers = {};
    for (const r of schema.default_registers_catalog || []) {
      registers[r.reg_key] = { ...r, current_val: this.state[r.reg_key] ?? this.chrono[r.reg_key] ?? r.default_val };
    }
    registers.status_code.current_val = this.state.status_managed;
    registers.standby_set.current_val = this.state.standby_set;

    const latest = {
      timestamp: now.toISOString().slice(0, 19).replace("T", " "),
      epoch: Math.floor(now.getTime() / 1000),
      comm_mode: "demo",
      stove_name: prof.stove_name,
      status_code: stCode,
      status_label: schema.stove_states[String(stCode)] || "TRAVAIL (Normal)",
      status_managed: this.state.status_managed,
      alarm_code: 0,
      alarm_label: "Aucune (____)",
      blackout_popup: 0,
      popup_flags: 0,
      popup_door_open: 0,
      popup_pellet_empty: 0,
      popup_pellet_open: 0,
      popup_pa_fault: 0,
      popup_tcj_fault: 0,
      popup_tck_fault: 0,
      temp_ambient: this.state.temp_ambient,
      temp_amb_setpoint: this.state.temp_amb_setpoint,
      temp_fumes: isHeating ? this.state.temp_fumes : 28,
      temp_probe_k: isHeating ? this.state.temp_probe_k : 26,
      exhaust_rpm: isHeating ? this.state.exhaust_rpm : 0,
      depression_pa: isHeating ? this.state.depression_pa : 0,
      power_level: this.state.power_level,
      power_actual: isHeating ? (this.state.fun_pwf_set === 1 ? 8 : this.state.power_level) : 0,
      fun_auto_set: this.state.fun_auto_set,
      standby_enabled: this.state.standby_set,
      fun_pwf_set: this.state.fun_pwf_set,
      set_silece_set: 0,
      fan_front_speed: this.state.fan_front_speed,
      vent_front_actual: isHeating ? this.state.vent_front_actual : 0,
      duct_left_temp: this.state.duct_left_temp,
      duct_left_setpoint: this.state.duct_left_setpoint,
      duct_left_speed: this.state.duct_left_speed,
      duct_left_actual: isHeating ? this.state.duct_left_actual : 0,
      duct_right_temp: this.state.duct_right_temp,
      duct_right_setpoint: this.state.duct_right_setpoint,
      duct_right_speed: this.state.duct_right_speed,
      duct_right_actual: isHeating ? this.state.duct_right_actual : 0,
      chrono_week_enable: this.state.chrono_week_enable_set,
      chrono_p1_start: this.chrono.chrono_p1_start_set,
      chrono_p1_stop: this.chrono.chrono_p1_stop_set,
      chrono_p1_days: this.chrono.chrono_p1_days_mask,
      chrono_p1_power: this.chrono.chrono_p1_power_set,
      chrono_p1_temp: this.chrono.chrono_p1_temperature_set,
      chrono_p2_start: this.chrono.chrono_p2_start_set,
      chrono_p2_stop: this.chrono.chrono_p2_stop_set,
      chrono_p2_days: this.chrono.chrono_p2_days_mask,
      chrono_p2_power: this.chrono.chrono_p2_power_set,
      chrono_p2_temp: this.chrono.chrono_p2_temperature_set,
      chrono_p3_start: this.chrono.chrono_p3_start_set,
      chrono_p3_stop: this.chrono.chrono_p3_stop_set,
      chrono_p3_days: this.chrono.chrono_p3_days_mask,
      chrono_p3_power: this.chrono.chrono_p3_power_set,
      chrono_p3_temp: this.chrono.chrono_p3_temperature_set,
      chrono_p4_start: this.chrono.chrono_p4_start_set,
      chrono_p4_stop: this.chrono.chrono_p4_stop_set,
      chrono_p4_days: this.chrono.chrono_p4_days_mask,
      chrono_p4_power: this.chrono.chrono_p4_power_set,
      chrono_p4_temp: this.chrono.chrono_p4_temperature_set,
      stove_clock_str: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")} ${String(now.getDate()).padStart(2, "0")}/${String(now.getMonth() + 1).padStart(2, "0")}/${now.getFullYear()}`,
      pellet_rate_kgh: isHeating ? Number((0.6 + this.state.power_level * 0.22).toFixed(2)) : 0,
      weather_temp_ext: weather?.weather_temp_ext ?? 9.5,
      weather_humidity: weather?.weather_humidity ?? 68,
      weather_wind_kmh: weather?.weather_wind_kmh ?? 12,
      weather_details: (weather && Array.isArray(weather.forecast_daily_means) && weather.forecast_daily_means.length > 0)
        ? weather
        : {
          weather_temp_ext: weather?.weather_temp_ext ?? 9.5,
          weather_humidity: weather?.weather_humidity ?? 68,
          weather_wind_kmh: weather?.weather_wind_kmh ?? 12,
          forecast_daily_means: [9.5, 8.4, 7.9, 9.1, 10.2, 8.8, 7.6],
          forecast_daily_mins: [5.2, 4.1, 3.8, 5.0, 6.1, 4.7, 3.5],
          forecast_daily_maxs: [13.4, 12.2, 11.6, 13.0, 14.1, 12.6, 11.4],
          forecast_daily_dates: [],
        },
      raw_buffer_json: JSON.stringify({ 8: stCode, 11: this.state.power_actual, 103: this.state.temp_ambient }),
    };

    return {
      frontend_version: FRONTEND_VERSION,
      active_mode: "demo",
      stove_name: prof.stove_name,
      capabilities: prof.capabilities,
      latest,
      comm_status: { connected: true, comm_mode: "demo", last_sync_time: latest.timestamp },
      settings,
      registers,
      silence_mode: { active: false, remaining_seconds: 0 },
    };
  }

  applyCommands(commands) {
    for (const c of commands || []) {
      const val = Number(c.value);
      if (c.reg_key === "status_code") {
        const isOn = val === 85 || val === 6 || val === 1;
        this.state.status_managed = isOn ? 85 : 170;
        this.state.status_code = isOn ? 5 : 0;
      } else if (c.reg_key in this.state) {
        this.state[c.reg_key] = val;
      } else if (c.reg_key in this.chrono) {
        this.chrono[c.reg_key] = val;
      }
    }
    return { status: "ok", count: (commands || []).length };
  }
}
