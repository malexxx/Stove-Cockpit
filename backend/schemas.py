"""Schémas Pydantic v2 de validation stricte pour les requêtes HTTP de l'API Stove Cockpit Server."""
from typing import Annotated, Any, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, StrictBool, StrictInt, StrictStr, field_validator


def _reject_bool(value: Any) -> Any:
    """Refuse les booléens Python sur les champs numériques (bool hérite de int en Python)."""
    if isinstance(value, bool):
        raise ValueError("Les valeurs booléennes ne sont pas autorisées pour les champs numériques.")
    return value


def _validate_integer_offset(value: Any) -> Any:
    """Valide un offset entier strict (refuse booléens et flottants non entiers)."""
    if isinstance(value, bool):
        raise ValueError("Les valeurs booléennes ne sont pas autorisées pour les champs entiers.")
    if isinstance(value, float):
        if not value.is_integer():
            raise ValueError("La valeur décimale doit représenter un entier.")
        return int(value)
    return value


NoBoolFloat = Annotated[float, BeforeValidator(_reject_bool)]
NoBoolOptionalFloat = Annotated[float | None, BeforeValidator(_reject_bool)]
NoBoolNumericOrStr = Annotated[StrictInt | float | StrictStr | None, BeforeValidator(_reject_bool)]
NoBoolIntOrStr = Annotated[StrictInt | StrictStr | None, BeforeValidator(_reject_bool)]
StrictOptionalOffset = Annotated[int | None, BeforeValidator(_validate_integer_offset)]


class CommandPayload(BaseModel):
    """Commande unitaire d'écriture sur un registre RAM ou EEPROM Micronova."""

    model_config = ConfigDict(extra="ignore")

    reg_key: str = Field(..., min_length=1, pattern=r"^[a-zA-Z0-9_.-]+$", description="Clé du registre Micronova ou RAW_<offset>")
    value: NoBoolFloat = Field(..., ge=-1e12, le=1e12, allow_inf_nan=False, description="Valeur numérique à écrire")
    offset: StrictOptionalOffset = Field(default=None, ge=0, le=65535, description="Offset mémoire personnalisé optionnel")

    @field_validator("reg_key")
    @classmethod
    def validate_reg_key(cls, v: str) -> str:
        """Nettoie et vérifie que la clé de registre n'est pas vide."""
        s = v.strip()
        if not s:
            raise ValueError("Paramètre reg_key ne peut pas être vide")
        return s


class BatchCommandPayload(BaseModel):
    """Lot de 1 à 64 écritures de registres exécutées de façon atomique."""

    model_config = ConfigDict(extra="ignore")
    commands: list[CommandPayload] = Field(..., min_length=1, max_length=64, description="Liste des écritures à exécuter en batch")


class RefillHopperPayload(BaseModel):
    """Charge utile de remplissage de la trémie à granulés."""

    model_config = ConfigDict(extra="ignore")
    bags_added: NoBoolFloat = Field(default=2.0, ge=0.0, le=10.0, description="Nombre de sacs de 15 kg ajoutés")
    target_pct: NoBoolFloat = Field(default=100.0, ge=0.0, le=100.0, description="Niveau cible de la trémie en %")
    level_pct: NoBoolOptionalFloat = Field(default=None, ge=0.0, le=100.0, description="Alias optionnel du niveau cible en %")


class SnapshotCreatePayload(BaseModel):
    """Paramètres de création d'un cliché mémoire des registres du poêle."""

    model_config = ConfigDict(extra="ignore")
    name: StrictStr | None = Field(default="", description="Nom descriptif du snapshot")
    refresh_live: StrictBool = Field(default=False, description="Forcer une lecture temps réel avant capture")


class SettingsPayload(BaseModel):
    """Mise à jour partielle de la configuration système (liaison, marque, météo, stock, Matter, canalisations)."""

    model_config = ConfigDict(extra="ignore")

    comm_mode: Literal["simulation", "agua_cloud", "local_gateway"] | None = None
    poll_interval_s: NoBoolNumericOrStr = None
    agua_brand: StrictStr | None = None
    agua_api_url: StrictStr | None = None
    agua_customer_code: StrictStr | None = None
    agua_brand_id: StrictStr | None = None
    agua_brand_header: StrictStr | None = None
    agua_login_api_url: StrictStr | None = None
    agua_email: StrictStr | None = None
    agua_password: StrictStr | None = None
    agua_id_device: StrictStr | None = None
    agua_id_product: StrictStr | None = None
    stove_name: StrictStr | None = None
    hopper_capacity_kg: NoBoolNumericOrStr = None
    local_gateway_url: StrictStr | None = None
    weather_city: StrictStr | None = None
    weather_lat: StrictStr | None = None
    weather_lon: StrictStr | None = None
    pellet_bag_price_eur: NoBoolNumericOrStr = None
    pellet_bags_stock: NoBoolNumericOrStr = None
    pellet_bags_used_season: NoBoolNumericOrStr = None
    webhook_url: StrictStr | None = None
    matter_enabled: bool | StrictInt | StrictStr | None = None
    matter_device_name: StrictStr | None = None
    matter_port: NoBoolIntOrStr = None
    duct_left_name: StrictStr | None = None
    duct_right_name: StrictStr | None = None
    cockpit_ui_mode: StrictStr | None = None


class TestConnectionPayload(BaseModel):
    """Paramètres de test de connectivité (Agua Cloud multi-marques, passerelle UART LAN ou simulation)."""

    __test__ = False
    model_config = ConfigDict(extra="ignore")

    comm_mode: Literal["simulation", "agua_cloud", "local_gateway"] = "agua_cloud"
    agua_brand: StrictStr | None = None
    agua_api_url: StrictStr | None = None
    agua_customer_code: StrictStr | None = None
    agua_brand_id: StrictStr | None = None
    agua_brand_header: StrictStr | None = None
    agua_login_api_url: StrictStr | None = None
    agua_email: StrictStr | None = None
    agua_password: StrictStr | None = None
    agua_id_device: StrictStr | None = None
    agua_id_product: StrictStr | None = None
    local_gateway_url: StrictStr | None = None


class SilenceActivatePayload(BaseModel):
    """Paramètres d'activation temporisée du mode Silence intelligent."""

    model_config = ConfigDict(extra="ignore")
    duration_hours: NoBoolFloat = Field(default=2.0, ge=0.1, le=24.0, description="Durée limitée du mode Silence ! en heures (défaut 2H)")


class SilenceDeactivatePayload(BaseModel):
    """Paramètres de désactivation du mode Silence avec éventuelles commandes de substitution."""

    model_config = ConfigDict(extra="ignore")
    override_commands: list[CommandPayload] | None = Field(
        default=None,
        description="Commandes optionnelles à appliquer lors de la désactivation (ex: nouvelle puissance ou ventilation)",
    )


class MatterWebhookPayload(BaseModel):
    """Commande interne transmise par le pont local Matter vers le backend FastAPI."""

    model_config = ConfigDict(extra="ignore")
    action: Literal["set_power", "set_temperature"] = Field(..., description="Action commandée: set_power ou set_temperature")
    state: Literal["ON", "OFF", "on", "off"] | None = Field(default=None, description="État cible: ON ou OFF")
    temperature: NoBoolOptionalFloat = Field(default=None, ge=7.0, le=80.0, description="Consigne de température en °C")


class TestWebhookPayload(BaseModel):
    """URL cible pour l'envoi d'une notification push/webhook de test."""

    __test__ = False
    model_config = ConfigDict(extra="ignore")
    webhook_url: str = Field(..., pattern=r"^https?://[a-zA-Z0-9_.-]+\.[a-zA-Z0-9_.-]+", description="URL de destination webhook / ntfy")


class ClientErrorPayload(BaseModel):
    """Rapport d'erreur JavaScript remonté par l'interface frontend."""

    model_config = ConfigDict(extra="ignore")
    severity: StrictStr = Field(default="ERROR", description="Niveau de sévérité du log")
    source: StrictStr = Field(default="FRONTEND", description="Composant émetteur de l'erreur")
    message: StrictStr = Field(default="Erreur interface", description="Détail du message d'erreur")


class InstallerVerifyPayload(BaseModel):
    """Authentification du mode Expert / Installateur par mot de passe Agua Cloud."""

    model_config = ConfigDict(extra="ignore")
    password: str = Field(..., min_length=1, description="Mot de passe Agua Cloud pour déverrouillage installateur")


class StoveSetPayload(BaseModel):
    """Consigne simplifiée de pilotage direct (puissance, température ou ventilation par zone)."""

    model_config = ConfigDict(extra="ignore")
    type: Literal["power", "temp", "fan"] = Field(..., description="Type de consigne: power, temp ou fan")
    zone: Literal["salon", "front", "sx", "dx"] | None = Field(default=None, description="Zone cible pour temp/fan: salon, front, sx ou dx")
    value: NoBoolFloat = Field(..., ge=-1e12, le=1e12, description="Valeur de consigne à appliquer")
    label: StrictStr | None = Field(default=None, description="Libellé optionnel (ex: OFF, PS)")


class PelletBatchRazPayload(BaseModel):
    """Réinitialisation du lot de granulés suivi par l'évaluateur de combustion."""

    model_config = ConfigDict(extra="ignore")
    pellet_brand: StrictStr | None = Field(
        default="Nouveau Lot Certifié A1",
        max_length=120,
        description="Nom ou certification du nouveau lot de granulés",
    )


class CalibrationStep1Payload(BaseModel):
    """Démarrage de l'assistant de calibration couplée (étape 1)."""

    model_config = ConfigDict(extra="ignore")
    mode: Literal["COMBINED_BOTH", "CONSUMPTION_ONLY", "COMBUSTION_ONLY"] = Field(
        default="COMBINED_BOTH",
        description="Mode de calibration couplée",
    )


class CalibrationStep3Payload(BaseModel):
    """Déclaration de la charge pesée étalon (étape 3 du wizard de calibration)."""

    model_config = ConfigDict(extra="ignore")
    weighed_bag_kg: NoBoolFloat = Field(
        default=15.0,
        ge=0.5,
        le=100.0,
        allow_inf_nan=False,
        description="Masse pesée du sac étalon en kg (0.5 à 100 kg)",
    )
    aspirated_priming_grams: NoBoolFloat = Field(
        default=0.0,
        ge=0.0,
        le=5000.0,
        allow_inf_nan=False,
        description="Masse de granulés aspirés lors de l'amorçage en grammes (0 à 5000 g)",
    )
