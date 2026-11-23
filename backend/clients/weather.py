"""Service météo Open-Meteo (modèle AROME Météo-France, cache TTL 10 min)."""
import time
from typing import Any

from database import db_log


class WeatherService:
    """Client météo Open-Meteo (modèle AROME Météo-France) avec cache TTL 10 min et prévisions 14 jours."""

    CACHE_TTL_S = 600.0  # 10 minutes (Open-Meteo se rafraîchit toutes les 15 min)

    def __init__(self):
        self.last_weather: dict[str, Any] = {
            "weather_temp_ext": 10.7,
            "weather_humidity": 66.0,
            "weather_wind_kmh": 13.7,
            "forecast_daily_means": [7.0, 6.0, 8.0, 6.5, 6.5, 7.0, 7.5, 7.0, 6.8, 6.5, 7.0, 7.2, 7.0, 6.8],
            "forecast_daily_mins": [3.5, 2.8, 4.2, 3.0, 3.1, 3.8, 4.0, 3.5, 3.2, 3.0, 3.5, 3.8, 3.5, 3.2],
            "forecast_daily_maxs": [10.5, 9.2, 11.8, 10.0, 9.9, 10.2, 11.0, 10.5, 10.4, 10.0, 10.5, 10.6, 10.5, 10.4],
            "forecast_daily_dates": [],
            "last_update_epoch": 0,
        }
        self.last_fetch_ts: float = 0.0
        self.last_coords: tuple = ("", "")

    async def fetch_current(self, lat: str, lon: str, force: bool = False) -> dict[str, Any]:
        """Récupère les observations et prévisions météo Open-Meteo pour les coordonnées spécifiées (avec cache TTL 10 min)."""
        import clients as _clients_pkg

        now = time.time()
        coords = (str(lat).strip(), str(lon).strip())
        if not force and coords == self.last_coords and (now - self.last_fetch_ts) < self.CACHE_TTL_S:
            return self.last_weather

        try:
            f_lat = float(coords[0])
            f_lon = float(coords[1])
            if not (-90.0 <= f_lat <= 90.0 and -180.0 <= f_lon <= 180.0):
                return self.last_weather
        except (ValueError, TypeError):
            return self.last_weather

        url = (
            f"https://api.open-meteo.com/v1/forecast"
            f"?latitude={f_lat}&longitude={f_lon}"
            f"&current=temperature_2m,relative_humidity_2m,wind_speed_10m"
            f"&daily=temperature_2m_mean,temperature_2m_min,temperature_2m_max"
            f"&forecast_days=14"
            f"&timezone=Europe%2FParis"
        )
        try:
            async with _clients_pkg.borrow_http_client(timeout=3.0) as client:
                resp = await client.get(url, timeout=3.0)
                resp.raise_for_status()
                payload = resp.json()
                data = payload.get("current", {})
                daily = payload.get("daily", {})
                means = [float(x) for x in daily.get("temperature_2m_mean", []) if x is not None]
                mins = [float(x) for x in daily.get("temperature_2m_min", []) if x is not None]
                maxs = [float(x) for x in daily.get("temperature_2m_max", []) if x is not None]
                dates = [str(x) for x in daily.get("time", [])]
                self.last_weather = {
                    "weather_temp_ext": float(data.get("temperature_2m", self.last_weather["weather_temp_ext"])),
                    "weather_humidity": float(data.get("relative_humidity_2m", self.last_weather["weather_humidity"])),
                    "weather_wind_kmh": float(data.get("wind_speed_10m", self.last_weather["weather_wind_kmh"])),
                    "forecast_daily_means": means if means else self.last_weather.get("forecast_daily_means", []),
                    "forecast_daily_mins": mins if mins else self.last_weather.get("forecast_daily_mins", []),
                    "forecast_daily_maxs": maxs if maxs else self.last_weather.get("forecast_daily_maxs", []),
                    "forecast_daily_dates": dates if dates else self.last_weather.get("forecast_daily_dates", []),
                    "last_update_epoch": int(now),
                }
                self.last_fetch_ts = now
                self.last_coords = coords
        except Exception as e:
            self.last_fetch_ts = now - (self.CACHE_TTL_S - 60.0)
            db_log("WARNING", "OPEN_METEO", f"Repli sur cache météo ({str(e)})")
        return self.last_weather


weather_service = WeatherService()
