import { getAllBrands, getBrandPreset } from "./providers/agua_direct.js";
import { ProviderManager } from "./providers/manager.js";
import { decodeBufferToTelemetry, detectCapabilities, evaluateBuffer, parseRegistersMap } from "./micronova/register_engine.js";
import { evaluateMicronovaFormula } from "./micronova/formula_eval.js";
import { clearAllPrefs, loadAllPrefs, savePrefsPatch } from "./storage/secure_prefs.js";

const providerManager = new ProviderManager();

window.StoveCore = {
  getAllBrands,
  getBrandPreset,
  decodeBufferToTelemetry,
  detectCapabilities,
  evaluateBuffer,
  parseRegistersMap,
  evaluateMicronovaFormula,
  loadAllPrefs,
  savePrefsPatch,
  clearAllPrefs,
};

window.stoveProvider = providerManager;

window.__stoveProviderReady = providerManager.init().then((mode) => {
  window.dispatchEvent(new CustomEvent("stove-provider-ready", { detail: { mode } }));
  return mode;
});
