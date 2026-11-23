# Politique de confidentialité — Stove Cockpit

*Dernière mise à jour : 2026-11-23*

**Stove Cockpit** est une application communautaire open-source destinée au pilotage et à la supervision de poêles à granulés et chaudières compatibles **Micronova Agua IOT**.

## 1. Collecte de données par l'éditeur
L'éditeur de **Stove Cockpit** ne collecte, ne vend et ne transmet **aucune donnée personnelle, identifiant, télémétrie ou statistique d'usage** vers des serveurs tiers lui appartenant. L'application ne contient aucun SDK publicitaire ni outil de tracking analytique.

## 2. Identifiants et stockage local
- Vos identifiants Agua IOT (adresse e-mail, mot de passe, identifiant d'application UUID) ainsi que l'URL et le jeton API de votre éventuel conteneur compagnon (« Mode + ») sont stockés **uniquement en local sur votre appareil**.
- En Mode Autonome, ces identifiants sont envoyés exclusivement en HTTPS au serveur Cloud du fabricant sélectionné par vos soins (par exemple `*.agua-iot.com`, `remote.mcz.it`, etc.) afin d'authentifier votre poêle et de lire/modifier ses registres.

## 3. Données de localisation (optionnelles)
- Si vous utilisez le bouton **« Me localiser »** dans les réglages météo, l'application demande l'autorisation d'accéder à votre position approximative ou GPS afin de récupérer les coordonnées (latitude/longitude).
- Ces coordonnées sont envoyées uniquement à l'API publique **Open-Meteo** (`https://api.open-meteo.com`) pour afficher la météo locale et les prévisions DJU. Vous pouvez à tout moment saisir une ville ou des coordonnées manuellement sans activer la géolocalisation.

## 4. Connexion au réseau local (Mode « + » Conteneur Compagnon)
- Si vous activez l'option **« Mode + »**, l'application communique directement sur votre réseau local (HTTP) avec votre propre serveur Docker **Stove Cockpit Server** à l'aide du jeton API que vous avez configuré.

## 5. Contact & Suppression des données
Vous pouvez effacer à tout moment l'ensemble des données enregistrées en réinitialisant les paramètres de l'application ou en la désinstallant.
Dépôt du projet : https://github.com/malexxx/Stove-Cockpit
