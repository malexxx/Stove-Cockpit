# 🔥 Stove Cockpit

> **Cockpit universel Tri-Arc et supervision domotique pour tous les poêles et chaudières compatibles Micronova Agua IOT (35+ marques).**

**Stove Cockpit** sépare clairement :
1. **L'application Frontend (`frontend/`)** — utilisable **immédiatement sans serveur** sur smartphone (Android `.aab`/`.apk` via Google Play / GitHub Releases, iOS `.ipa` sideloadable) ou navigateur en interrogeant directement le Cloud Agua IOT de votre marque, avec **Mode Démo** intégré.
2. **Le Conteneur Compagnon « Mode + » (`backend/`)** — serveur Docker léger en **HTTP pur** (sans complexité TLS/certificats intégrée) qui débloque la supervision 24/7, l'historique SQLite, les graphiques 4 volets, le suivi trémie & coûts DJU, le pont **Matter** (Apple Home, Google Home, Alexa, Home Assistant), la passerelle UART locale, le mode Silence temporisé 24/7 et les alertes Push.

---

## ✨ Fonctionnalités par Mode

| Fonctionnalité | App Autonome (Cloud direct) | Conteneur « Mode + » |
| :--- | :---: | :---: |
| Compatibilité **35+ marques Micronova Agua IOT** + Serveur personnalisé | ✅ | ✅ |
| Détection dynamique `/deviceGetRegistersMap` (Air / Hydro, P1..Pn, 0..N canalisations) | ✅ | ✅ |
| **Cockpit Tri-Arc** adaptatif, modes Auto / Boost / Eco, alarme & sécurités | ✅ | ✅ |
| **Programmation Chrono** hebdomadaire (P1..P4) & Sync horloge RTC | ✅ | ✅ |
| **Météo locale** (Open-Meteo sans clé API) & **Mode Démo** sans poêle | ✅ | ✅ |
| **Repli Cloud automatique** si le conteneur local est hors portée (4G/5G) | — | ✅ |
| **Onglet Pellets** (jauge trémie configurable, conso J/7J/30J, coûts, autonomie DJU) | — *(Invitation Mode +)* | ✅ |
| **Onglet Supervision** (graphiques 4 volets synchronisés `3h` → `3M`, export CSV) | — | ✅ |
| **Pont Matter local** (port UDP `5540`) & **Webhooks Push** (`ntfy.sh`, Discord, HA) | — | ✅ |
| **Mode Silence !** temporisé et restauré 24/7 par le serveur | ⚠️ *Manuel* | ✅ |
| **Passerelle locale UART/RS485**, Simulation, Calibration, Snapshots & Logs | — | ✅ |

---

## 🏭 Marques Compatibles (Agua IOT)

Nobis-Fi, MCZ (`Easy Connect` / `Plus` / `Poêle`), TurboFonte, MyPiazzetta, MySuperior, EvaCalòr / PuntoFuoco, Jolly Mec, Klover, Ravelli Wi-Fi, Bronpi, Extraflame (`Total Control 3.0`), LAMINOX, Lorflam, Moretti Design, Nordic Fire 2.0, Alfaplam, Boreal, Darwin Evolution (Cola), Elcofire, Elfire, EOSS, Fontana Forni, Fonte Flamme, Globe-fire, GO HEAT, Karmek, My Corisit, Nina, Stufe a pellet Italia, Thermoflux, TS Smart, Wi-Phire, APP-O BIOEN (Unical), ainsi que tout serveur **Agua IOT personnalisé**.

---

## 🚀 Déploiement du Conteneur Compagnon (« Mode + »)

Le conteneur fonctionne en **HTTP pur** (port `8080`) pour une installation immédiate sur NAS / Raspberry Pi / serveur Linux. Pour un accès distant depuis Internet, placez-le derrière votre reverse-proxy HTTPS habituel (Nginx Proxy Manager, Traefik, Synology DSM, Caddy) ou un VPN (Tailscale / WireGuard).

```bash
cd backend
docker compose up -d
```

- Interface Web LAN : `http://<ip-serveur>:8080/`
- Pont Matter local : port UDP `5540`
- Appairage mobile (« Option + ») : ouvrez **Paramètres → Option + / Appairage** sur l'interface web du conteneur pour copier l'URL HTTP et le **Jeton API (`X-API-Key`)**.

---

## 🛠️ Développement Local

### Frontend (`frontend/`)
```bash
cd frontend
npm install
npm test
npm run build
npx cap sync
```

### Backend (`backend/`)
```bash
cd backend
pip install -r requirements-dev.txt
pytest -v tests
python server.py --host 0.0.0.0 --port 8080
```

---

## ⚖️ Avertissement & Licence

- **Avertissement** : projet communautaire indépendant, **non affilié à Nobis S.r.l., Micronova S.r.l. ou tout autre constructeur cité**. Les marques citées restent la propriété de leurs détenteurs respectifs.
- **Licence** : MIT.
