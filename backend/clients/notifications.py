"""Service de notifications Push / Webhook (ntfy.sh, Home Assistant, Discord)."""
import asyncio
from email.header import Header
import time
from typing import Any

from clients.security import is_safe_webhook_url
from config import HOPPER_CAPACITY_KG
from database import db_log


def _encode_ntfy_title(title: str) -> str:
    """Encode un titre contenant des caractères non-ASCII/emojis en RFC 2047 pour compatibilité HTTP/1.1 & ntfy.sh."""
    raw = (title or "").replace("\r", " ").replace("\n", " ").strip()
    try:
        raw.encode("ascii")
        return raw
    except UnicodeEncodeError:
        return Header(raw, "utf-8").encode(maxlinelen=1000)


class NotificationService:
    """Gestionnaire d'alertes Push/Webhook (ntfy.sh, Home Assistant, Discord) avec anti-spam et anti-SSRF."""

    def __init__(self):
        self._last_sent_by_key: dict[str, float] = {}
        self.cooldown_s: float = 3600.0  # 1h anti-spam par type d'alerte

    async def send_webhook(self, webhook_url: str, title: str, message: str, alert_key: str, mode: str) -> bool:
        """Envoie une notification push vers une URL Webhook (ntfy.sh, Home Assistant, etc.) avec cooldown anti-spam."""
        import clients as _clients_pkg

        url = (webhook_url or "").strip()
        if not url:
            return False
        if not await asyncio.to_thread(is_safe_webhook_url, url):
            db_log("WARNING", "WEBHOOK", f"URL Webhook rejetée par le filtre de sécurité anti-SSRF : {url}", mode)
            return False

        now = time.time()
        last_ts = self._last_sent_by_key.get(alert_key, 0.0)
        if now - last_ts < self.cooldown_s:
            return False

        try:
            async with _clients_pkg.borrow_http_client(timeout=8.0) as client:
                if "ntfy.sh" in url:
                    resp = await client.post(
                        url,
                        content=message.encode("utf-8"),
                        headers={
                            "Title": _encode_ntfy_title(title),
                            "Priority": "high",
                            "Tags": "fire,warning",
                        },
                        timeout=8.0,
                    )
                else:
                    payload = {
                        "title": title,
                        "message": message,
                        "content": f"**{title}** — {message}",
                        "alert_key": alert_key,
                        "mode": mode,
                    }
                    resp = await client.post(url, json=payload, timeout=8.0)
                resp.raise_for_status()
            self._last_sent_by_key[alert_key] = now
            db_log("INFO", "WEBHOOK", f"Notification envoyée [{title}] : {message}", mode)
            return True
        except Exception as e:
            db_log("WARNING", "WEBHOOK", f"Échec envoi notification ({str(e)})", mode)
            return False

    async def evaluate_telemetry_alerts(self, record: dict[str, Any], settings: dict[str, str]) -> None:
        """Évalue les alarmes et seuils critiques (trémie vide, alarme AL, blackout) et déclenche les webhooks."""
        webhook_url = (settings.get("webhook_url") or "").strip()
        if not webhook_url:
            return
        mode = str(record.get("comm_mode", "agua_cloud"))

        alarm_code = int(record.get("alarm_code") or 0)
        if alarm_code > 0:
            alarm_lbl = record.get("alarm_label", f"AL{alarm_code}")
            await self.send_webhook(
                webhook_url,
                "🚨 Alarme Poêle Nobis A10",
                f"Alarme active détectée : {alarm_lbl} (Code {alarm_code})",
                f"alarm_{alarm_code}",
                mode,
            )
        else:
            for k in list(self._last_sent_by_key.keys()):
                if k.startswith("alarm_"):
                    self._last_sent_by_key.pop(k, None)

        hopper_pct = float(record.get("pellet_hopper_pct") if record.get("pellet_hopper_pct") is not None else 100.0)
        if hopper_pct <= 20.0:
            kg_left = round((hopper_pct / 100.0) * HOPPER_CAPACITY_KG, 1)
            await self.send_webhook(
                webhook_url,
                "🌾 Réserve Granulés Basse (< 20%)",
                f"Trémie à {hopper_pct}% (~{kg_left} kg restants sur {int(HOPPER_CAPACITY_KG)} kg). Pensez à recharger.",
                "low_hopper",
                mode,
            )
        elif hopper_pct >= 50.0:
            self._last_sent_by_key.pop("low_hopper", None)

        cat_hours = float(record.get("cat_service_hours") if record.get("cat_service_hours") is not None else 1420.0)
        if cat_hours <= 50.0:
            await self.send_webhook(
                webhook_url,
                "🔧 Entretien CAT Nobis A10 Imminent",
                f"Il reste {int(cat_hours)} h avant l'échéance d'entretien programmé CAT.",
                "cat_service",
                mode,
            )


notification_service = NotificationService()
