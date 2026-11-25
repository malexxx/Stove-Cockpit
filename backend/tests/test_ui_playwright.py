"""Tests End-to-End (E2E) de l'interface utilisateur web et mobile (PWA) via Playwright."""
import mimetypes
import os

import pytest

_pw = pytest.importorskip("playwright.sync_api")
Page = _pw.Page
sync_playwright = _pw.sync_playwright

from config import STATIC_DIR
from routers.dashboard import render_spa_html

APP_ORIGIN = "http://nobis.local"


_STATIC_PREFIXES = (
    f"{APP_ORIGIN}/static/",
    f"{APP_ORIGIN}/css/",
    f"{APP_ORIGIN}/js/",
    f"{APP_ORIGIN}/vendor/",
    f"{APP_ORIGIN}/assets/",
)
_MOCK_API_RESPONSES = {
    "/api/latest": '''{
        "latest": {
            "status_code": 5, "status_label": "TRAVAIL (Normal)",
            "temp_ambient": 20.5, "temp_amb_setpoint": 21.0,
            "temp_fumes": 165.0, "pellet_hopper_pct": 82.0, "pellet_daily_kg": 4.5
        },
        "comm_status": {"connected": true, "comm_mode": "simulation"}
    }''',
    "/api/silence/status": '{"active": false}',
    "/api/dashboard": '{"series": [], "latest": {"status_code": 5}}',
}


def _fulfill_api_route(route, url: str) -> None:
    if "/api/events" in url:
        route.abort()
        return
    body = next((payload for key, payload in _MOCK_API_RESPONSES.items() if key in url), '{"status": "ok"}')
    route.fulfill(status=200, content_type="application/json", body=body)


def _fulfill_static_route(route, url: str) -> None:
    rel_path = url.split(APP_ORIGIN + "/", 1)[1].split("?", 1)[0]
    if rel_path.startswith("static/"):
        rel_path = rel_path.split("static/", 1)[1]
    disk_path = os.path.realpath(os.path.join(STATIC_DIR, rel_path))
    static_root = os.path.realpath(STATIC_DIR)
    if disk_path.startswith(static_root + os.sep) and os.path.isfile(disk_path):
        ctype, _ = mimetypes.guess_type(disk_path)
        with open(disk_path, "rb") as fh:
            route.fulfill(status=200, content_type=ctype or "application/octet-stream", body=fh.read())
        return
    route.fulfill(status=404, body="Not Found")


def _attach_app_routes(page: Page, backend_version: str = "0.0.5") -> None:
    """Sert la SPA assemblée, les fichiers statiques depuis le disque et mocke les endpoints /api/*."""
    assembled_html = render_spa_html()

    def handle_route(route):
        url = route.request.url
        if url == f"{APP_ORIGIN}/health":
            route.fulfill(
                status=200,
                content_type="application/json",
                body=f'{{"status": "healthy", "version": "{backend_version}", "backend_version": "{backend_version}", "docker_version": "v{backend_version}"}}',
            )
        elif url.startswith(f"{APP_ORIGIN}/api/"):
            _fulfill_api_route(route, url)
        elif url.startswith(_STATIC_PREFIXES):
            _fulfill_static_route(route, url)
        elif url in (APP_ORIGIN, f"{APP_ORIGIN}/"):
            route.fulfill(status=200, content_type="text/html; charset=utf-8", body=assembled_html)
        else:
            route.abort()

    page.route("**/*", handle_route)


@pytest.fixture(scope="module")
def browser_instance():
    """Lance une instance de navigateur Chromium headless pour les tests E2E."""
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(headless=True)
        except Exception as e:
            pytest.skip(f"Navigateur Chromium Playwright non disponible : {e}")
        try:
            yield browser
        finally:
            browser.close()


@pytest.fixture
def page(browser_instance):
    """Crée une nouvelle page / onglet isolé avec intercepteur SPA/Static/API."""
    context = browser_instance.new_context(viewport={"width": 1280, "height": 800})
    page = context.new_page()
    _attach_app_routes(page)
    yield page
    context.close()


def test_ui_page_title_and_main_structure(page: Page):
    """Vérifie le chargement 100 % hors-ligne (0 CDN externe), Tailwind statique, Chart.js local et 0 erreur JS."""
    page_errors = []
    external_urls = []
    page.on("pageerror", lambda err: page_errors.append(str(err)))
    page.on("request", lambda req: external_urls.append(req.url) if not req.url.startswith(APP_ORIGIN) and not req.url.startswith("data:") else None)
    page.goto(f"{APP_ORIGIN}/", wait_until="load")
    assert "Stove Cockpit" in page.title()

    main = page.locator("main")
    assert main.is_visible()
    tab_control = page.locator("#tab-control")
    assert tab_control.is_visible()

    # Aucune requête vers des CDN tiers (Tailwind / jsDelivr) — PWA 100 % autonome
    assert external_urls == [], f"Requêtes externes détectées : {external_urls}"
    # Chart.js local chargé et styles Tailwind pré-compilés effectivement appliqués
    assert page.evaluate("() => typeof window.Chart === 'function'")
    assert page.evaluate("() => getComputedStyle(document.querySelector('#tab-pellets')).display") == "none"
    assert page.evaluate("() => getComputedStyle(document.querySelector('header')).display") == "flex"
    assert page_errors == [], f"Erreurs JS au chargement modulaire : {page_errors}"


def test_ui_tab_navigation(page: Page):
    """Vérifie le basculement fonctionnel entre les différents onglets de l'application."""
    page.goto(f"{APP_ORIGIN}/", wait_until="domcontentloaded")

    assert page.locator("#tab-control").count() > 0
    assert page.locator("#tab-pellets").count() > 0
    assert page.locator("#tab-chrono").count() > 0
    assert page.locator("#tab-dashboard").count() > 0
    assert page.locator("#tab-installer").count() > 0

    pellet_btn = page.locator("button[data-tab='tab-pellets']").first
    if pellet_btn.is_visible():
        pellet_btn.click()
        assert page.locator("#tab-pellets").is_visible()


def test_ui_modals_presence(page: Page):
    """Vérifie la présence des fenêtres modales (Silence, Matter, Actions)."""
    page.goto(f"{APP_ORIGIN}/", wait_until="domcontentloaded")
    assert page.locator("#silence-modal").count() > 0
    assert page.locator("#matter-modal").count() > 0
    assert page.locator("#action-modal").count() > 0


def test_ui_mobile_viewport_and_bottom_nav(browser_instance):
    """Vérifie la disposition responsive sur smartphone (iPhone/Pixel 375x667)."""
    context = browser_instance.new_context(viewport={"width": 375, "height": 667})
    page = context.new_page()
    _attach_app_routes(page)
    page.goto(f"{APP_ORIGIN}/", wait_until="domcontentloaded")

    bottom_nav = page.locator("nav.fixed.bottom-0")
    assert bottom_nav.is_visible()
    context.close()


def test_ui_measured_temp_formatting_omits_trailing_zero(page: Page):
    """Vérifie que formatMeasuredTemp masque .0 pour les valeurs entières et conserve les décimales réelles."""
    page.goto(f"{APP_ORIGIN}/", wait_until="load")

    # Vérification unitaire de l'utilitaire JS et du rendu Tri-Arc (entiers vs décimales)
    results = page.evaluate("""() => {
        const unit = {
            int22: formatMeasuredTemp(22.0),
            int17: formatMeasuredTemp(17),
            frac205: formatMeasuredTemp(20.5),
            zero: formatMeasuredTemp(0),
            fallback: formatMeasuredTemp(null, 19),
        };
        applyDashboardState({
            latest: {
                status_code: 5,
                status_label: "TRAVAIL (Normal)",
                temp_ambient: 22.0,
                temp_amb_setpoint: 19.0,
                duct_left_temp: 17.0,
                duct_left_setpoint: 20.0,
                duct_right_temp: 18.0,
                duct_right_setpoint: 20.0,
            }
        }, false);
        const ambHtmlInt = document.getElementById("triarc-slide-AMB").textContent;
        const sxHtmlInt = document.getElementById("triarc-slide-SX").textContent;

        applyDashboardState({
            latest: {
                status_code: 5,
                status_label: "TRAVAIL (Normal)",
                temp_ambient: 20.5,
                temp_amb_setpoint: 21.0,
                duct_left_temp: 17.5,
                duct_left_setpoint: 20.0,
                duct_right_temp: 18.0,
                duct_right_setpoint: 20.0,
            }
        }, false);
        const ambHtmlFrac = document.getElementById("triarc-slide-AMB").textContent;
        return { unit, ambHtmlInt, sxHtmlInt, ambHtmlFrac };
    }""")

    assert results["unit"] == {
        "int22": "22",
        "int17": "17",
        "frac205": "20.5",
        "zero": "0",
        "fallback": "19",
    }
    assert "22°" in results["ambHtmlInt"]
    assert "22.0°" not in results["ambHtmlInt"]
    assert "17°" in results["ambHtmlInt"]
    assert "17.0°" not in results["ambHtmlInt"]
    assert "18°" in results["ambHtmlInt"]
    assert "18.0°" not in results["ambHtmlInt"]
    assert "17°" in results["sxHtmlInt"]
    assert "17.0°" not in results["sxHtmlInt"]
    assert "20.5°" in results["ambHtmlFrac"]
    assert "17.5°" in results["ambHtmlFrac"]


def test_ui_supervision_chart_dates_dd_mm(page: Page):
    """Vérifie que l'axe temporel des graphiques de Supervision et la barre pointeur affichent JJ/MM."""
    page.goto(f"{APP_ORIGIN}/", wait_until="load")
    page.wait_for_function("() => window.stoveProvider && window.stoveProvider.servedByContainer === true")

    res = page.evaluate("""() => {
        switchTab("tab-dashboard");
        applyDashboardState({
            latest: {
                status_code: 5,
                status_label: "TRAVAIL (Normal)",
                temp_ambient: 20.5,
                temp_fumes: 165.0
            },
            series: [
                { timestamp: "2026-11-23 08:15:00", status_code: 5, temp_ambient: 19.5, temp_fumes: 150 },
                { timestamp: "2026-11-23 18:35:00", status_code: 5, temp_ambient: 20.5, temp_fumes: 165 },
                { timestamp: "2026-12-05 09:00:00", status_code: 5, temp_ambient: 21.0, temp_fumes: 170 }
            ]
        }, true);
        setSynchronizedHoverIndex(1, 50);
        return {
            pane1Labels: chartPane1.data.labels.slice(),
            pane2Labels: chartPane2.data.labels.slice(),
            hoverText: document.getElementById("hover-timestamp").textContent
        };
    }""")

    expected_labels = ["23/11 08:15", "23/11 18:35", "05/12 09:00"]
    assert res["pane1Labels"] == expected_labels
    assert res["pane2Labels"] == expected_labels
    assert res["hoverText"] == "23/11/2026 18:35:00"


def test_ui_pellets_tab_no_scrollbars_on_smartphone(browser_instance):
    """Vérifie l'absence totale d'ascenseur horizontal/vertical dans l'onglet Pellets sur smartphone."""
    for width, height in ((360, 640), (375, 667), (390, 844)):
        context = browser_instance.new_context(viewport={"width": width, "height": height})
        page = context.new_page()
        _attach_app_routes(page)
        page.goto(f"{APP_ORIGIN}/", wait_until="load")
        page.wait_for_function("() => window.stoveProvider && window.stoveProvider.servedByContainer === true")
        metrics = page.evaluate("""() => {
            applyDashboardState({
                latest: {
                    status_code: 5,
                    status_label: "TRAVAIL (Normal)",
                    pellet_hopper_pct: 78,
                    pellet_rate_kgh: 1.15,
                    pellet_daily_kg: 12.4,
                    conso_week_kg: 78.5,
                    conso_month_kg: 312.0,
                    runway_days_est: 24,
                    popup_pellet_open: 0,
                    popup_pellet_empty: 0
                },
                settings: { pellet_bags_stock: 42, pellet_bag_price_eur: 5.8 }
            }, false);
            switchTab("tab-pellets");
            const doc = document.documentElement;
            const card = document.querySelector("#tab-pellets .card");
            const bottomNav = document.querySelector("nav.fixed.bottom-0");
            return {
                scrollWidth: doc.scrollWidth,
                clientWidth: doc.clientWidth,
                scrollHeight: doc.scrollHeight,
                clientHeight: doc.clientHeight,
                cardBottom: card.getBoundingClientRect().bottom,
                navTop: bottomNav.getBoundingClientRect().top
            };
        }""")

        assert metrics["scrollWidth"] <= metrics["clientWidth"], f"Ascenseur horizontal sur {width}x{height}: {metrics}"
        assert metrics["scrollHeight"] <= metrics["clientHeight"], f"Ascenseur vertical sur {width}x{height}: {metrics}"
        assert metrics["cardBottom"] <= metrics["navTop"], f"Chevauchement barre basse sur {width}x{height}: {metrics}"

        page.locator("#tab-pellets button[aria-label='Explication DJU']").click()
        assert page.locator("#action-modal").is_visible()
        context.close()


def test_ui_brand_selector_populated_and_shows_api(page: Page):
    """Vérifie que la liste des marques est remplie, affiche l'API correspondante et gère custom."""
    page.goto(f"{APP_ORIGIN}/", wait_until="load")
    page.wait_for_function("() => window.stoveProvider && document.querySelectorAll('#cfg-agua-brand option').length === 36")

    res = page.evaluate("""() => {
        switchTab("tab-installer");
        toggleSettingsAccordion("conn", true);
        const opts = Array.from(document.querySelectorAll("#cfg-agua-brand option")).map(o => ({ v: o.value, t: o.textContent.trim() }));
        const sel = document.getElementById("cfg-agua-brand");

        sel.value = "mypiazzetta";
        onSettingsBrandChange();
        const piazzettaPreview = document.getElementById("cfg-brand-api-preview").textContent;
        const piazzettaCustomHidden = document.getElementById("cfg-custom-brand-box").classList.contains("hidden");

        sel.value = "custom";
        onSettingsBrandChange();
        const customPreviewHidden = document.getElementById("cfg-brand-api-preview").classList.contains("hidden");
        const customBoxVisible = !document.getElementById("cfg-custom-brand-box").classList.contains("hidden");

        return { count: opts.length, allNonEmpty: opts.every(o => o.t.length > 0), piazzettaPreview, piazzettaCustomHidden, customPreviewHidden, customBoxVisible };
    }""")

    assert res["count"] == 36
    assert res["allNonEmpty"] is True
    assert "https://piazzetta.agua-iot.com" in res["piazzettaPreview"]
    assert "458632" in res["piazzettaPreview"]
    assert res["piazzettaCustomHidden"] is True
    assert res["customPreviewHidden"] is True
    assert res["customBoxVisible"] is True


def test_ui_tab_active_visual_indicators(browser_instance):
    """Vérifie l'indication visuelle des onglets sélectionnés sur desktop et mobile (y compris Mode +)."""
    for viewport, btn_prefix, active_cls in (
        ({"width": 1280, "height": 800}, "btn-", "tab-active"),
        ({"width": 375, "height": 667}, "mob-btn-", "mob-tab-active"),
    ):
        context = browser_instance.new_context(viewport=viewport)
        page = context.new_page()
        _attach_app_routes(page)
        page.goto(f"{APP_ORIGIN}/", wait_until="load")
        page.wait_for_function("() => window.stoveProvider && window.stoveProvider.servedByContainer === true")

        res = page.evaluate("""({ btnPrefix, activeCls }) => {
            switchTab("tab-chrono");
            const chronoBtn = document.getElementById(btnPrefix + "tab-chrono");
            const ctrlBtn = document.getElementById(btnPrefix + "tab-control");
            const chronoActive = chronoBtn.classList.contains(activeCls);
            const chronoAria = chronoBtn.getAttribute("aria-current");
            const ctrlRemoved = !ctrlBtn.classList.contains(activeCls) && !ctrlBtn.hasAttribute("aria-current");

            // Test de tab-plus-teaser (visible hors conteneur)
            window.stoveProvider.mode = "standalone";
            applyModeVisibility();
            switchTab("tab-plus-teaser");
            const plusBtn = document.getElementById(btnPrefix + "tab-plus-teaser");
            const plusVisible = !document.getElementById("tab-plus-teaser").classList.contains("hidden");
            return {
                chronoActive,
                chronoAria,
                ctrlRemoved,
                chronoCleared: !chronoBtn.classList.contains(activeCls) && !chronoBtn.hasAttribute("aria-current"),
                plusActive: plusBtn.classList.contains(activeCls),
                plusAria: plusBtn.getAttribute("aria-current"),
                plusVisible,
            };
        }""", {"btnPrefix": btn_prefix, "activeCls": active_cls})

        assert res["chronoActive"] is True
        assert res["chronoAria"] == "page"
        assert res["ctrlRemoved"] is True
        assert res["chronoCleared"] is True
        assert res["plusVisible"] is True
        assert res["plusActive"] is True
        assert res["plusAria"] == "page"
        context.close()


def test_ui_silence_container_only(page: Page):
    """Vérifie que le mode Silence propose le minuteur en Conteneur et l'activation directe sans timer en Autonome/Démo."""
    page.goto(f"{APP_ORIGIN}/", wait_until="load")
    page.wait_for_function("() => window.stoveProvider && window.stoveProvider.servedByContainer === true")

    res = page.evaluate("""() => {
        const checkSilenceBubble = () => {
            const btn = document.querySelector("#triarc-slide-AMB button[onclick*=\\"silence\\"]");
            toggleTriArcOptionBubble("silence");
            const bubbleHtml = document.getElementById("triarc-floating-bubble")?.innerHTML || "";
            const hasTimerBubble = Boolean(document.getElementById("triarc-silence-bubble-timer"));
            const hasHoursFn = bubbleHtml.includes("setTriArcSilenceHours");
            const hasDirectBtn = bubbleHtml.includes("activateStandaloneSilence");
            const hasNoTimerLabel = bubbleHtml.includes("Sans temporisation");
            closeTriArcOptionBubble();
            return { hasBtn: Boolean(btn), hasTimerBubble, hasHoursFn, hasDirectBtn, hasNoTimerLabel };
        };

        const container = checkSilenceBubble();
        window.stoveProvider.mode = "standalone";
        applyModeVisibility();
        const standalone = checkSilenceBubble();
        window.stoveProvider.mode = "demo";
        applyModeVisibility();
        const demo = checkSilenceBubble();
        return { container, standalone, demo };
    }""")

    assert res["container"]["hasBtn"] is True
    assert res["container"]["hasTimerBubble"] is True
    assert res["container"]["hasHoursFn"] is True
    assert res["container"]["hasDirectBtn"] is False

    assert res["standalone"]["hasBtn"] is True
    assert res["standalone"]["hasTimerBubble"] is False
    assert res["standalone"]["hasDirectBtn"] is True
    assert res["standalone"]["hasNoTimerLabel"] is True

    assert res["demo"]["hasBtn"] is True
    assert res["demo"]["hasTimerBubble"] is False
    assert res["demo"]["hasDirectBtn"] is True
    assert res["demo"]["hasNoTimerLabel"] is True


def test_ui_independent_frontend_backend_versions(browser_instance):
    """Vérifie l'affichage distinct des versions Frontend et Backend lorsqu'elles diffèrent."""
    context = browser_instance.new_context(viewport={"width": 1280, "height": 800})
    page = context.new_page()
    _attach_app_routes(page, backend_version="9.8.7")
    page.goto(f"{APP_ORIGIN}/", wait_until="load")
    page.wait_for_function("() => window.stoveProvider && window.stoveProvider.servedByContainer === true")

    res = page.evaluate("""() => {
        switchTab("tab-installer");
        return {
            hdrFront: document.getElementById("hdr-frontend-version-badge").textContent.trim(),
            hdrBack: document.getElementById("hdr-docker-version-badge").textContent.trim(),
            cfgFront: document.getElementById("cfg-frontend-version").textContent.trim(),
            cfgBack: document.getElementById("cfg-docker-version").textContent.trim(),
            diffVisible: !document.getElementById("hdr-version-diff-badge").classList.contains("hidden"),
        };
    }""")

    assert res["hdrFront"] == "📱 Front v0.0.5"
    assert res["hdrBack"] == "🐳 Back v9.8.7"
    assert res["cfgFront"] == "v0.0.5"
    assert res["cfgBack"] == "v9.8.7"
    assert res["diffVisible"] is True
    context.close()


def test_ui_cockpit_11_modes_settings_and_hydro_safety(browser_instance):
    """Vérifie le sélecteur d'interfaces dans Paramètres, les 11 vues (desktop+mobile), la barre batch et le mode Hydro."""
    modes = [
        "triarc",
        "thermostat",
        "bento",
        "faders",
        "thumb_zone",
        "cards_accordion",
        "intentions",
        "context_hmi",
        "spatial_flow",
        "vernier",
        "ambient_glass",
    ]
    for viewport in ({"width": 1280, "height": 800}, {"width": 375, "height": 667}):
        context = browser_instance.new_context(viewport=viewport)
        page = context.new_page()
        page_errors = []
        page.on("pageerror", lambda err: page_errors.append(str(err)))
        _attach_app_routes(page)
        page.goto(f"{APP_ORIGIN}/", wait_until="load")
        page.wait_for_function("() => window.stoveProvider && window.stoveProvider.servedByContainer === true")

        res = page.evaluate("""async (modesList) => {
            switchTab("tab-installer");
            toggleSettingsAccordion("cockpit_ui", true);
            const cardCount = document.querySelectorAll("#cockpit-ui-picker-grid [data-ui-mode-card]").length;

            const rendered = {};
            for (const m of modesList) {
                await setActiveCockpitUiMode(m, { persist: false, silent: true });
                switchTab("tab-control");
                applyDashboardState({
                    latest: {
                        status_code: 5,
                        status_label: "TRAVAIL (Normal)",
                        temp_ambient: 20.4,
                        temp_amb_setpoint: 21,
                        duct_left_temp: 19.0,
                        duct_left_setpoint: 20,
                        duct_right_temp: 18.0,
                        duct_right_setpoint: 18,
                        power_actual: 3,
                        power_level: 4,
                        fan_front_speed: 3,
                        duct_left_speed: 2,
                        duct_right_speed: 0
                    }
                }, false);
                const altRoot = document.getElementById("cockpit-alt-root");
                const triCard = document.getElementById("triarc-cockpit-card");
                rendered[m] = m === "triarc"
                    ? (!triCard.classList.contains("hidden") && altRoot.classList.contains("hidden"))
                    : (triCard.classList.contains("hidden") && !altRoot.classList.contains("hidden") && altRoot.textContent.trim().length > 0);
            }

            // Test barre de validation non-bloquante sur une nouvelle vue
            await setActiveCockpitUiMode("thermostat", { persist: false, silent: true });
            cockpitStepTemp("AMB", 1);
            const pendingVisible = Boolean(document.getElementById("cockpit-pending-bar"));
            cancelTriArcPendingChanges();
            const pendingCleared = !document.getElementById("cockpit-pending-bar");

            // Test profil Hydro sans canalisation et sans ventilateur frontal
            window.currentCapabilities = {
                stove_type: "hydro",
                temp_unit: "°C",
                temp_label: "Eau",
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
                has_eco: true,
            };
            const hydroOk = {};
            for (const m of modesList) {
                await setActiveCockpitUiMode(m, { persist: false, silent: true });
                hydroOk[m] = m === "triarc"
                    ? document.getElementById("triarc-slide-AMB").textContent.trim().length > 0
                    : document.getElementById("cockpit-alt-root").textContent.trim().length > 0;
            }
            return { cardCount, rendered, pendingVisible, pendingCleared, hydroOk };
        }""", modes)

        assert res["cardCount"] == 11
        assert all(res["rendered"].values()), f"Rendu incomplet sur {viewport}: {res['rendered']}"
        assert res["pendingVisible"] is True
        assert res["pendingCleared"] is True
        assert all(res["hydroOk"].values()), f"Erreur profil Hydro sur {viewport}: {res['hydroOk']}"
        assert page_errors == [], f"Erreurs JS sur {viewport}: {page_errors}"
        context.close()
