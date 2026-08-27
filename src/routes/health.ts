import { isSidecarReady } from "../sidecar.js";
import {
  ALL_LANGS,
  getVoicesDir,
  getTemp,
  getQuantize,
  isLocalMode,
  getModelDir,
  getDefaultLang,
  isLanguageAvailable,
} from "../config.js";

export async function healthHandler(_req: Request): Promise<Response> {
  const defaultLang = getDefaultLang();

  const languages: Record<string, { available: boolean; ready: boolean; model_dir: string | null }> = {};

  for (const lang of ALL_LANGS) {
    languages[lang] = {
      available: isLanguageAvailable(lang),
      ready: isSidecarReady(lang),
      model_dir: getModelDir(lang),
    };
  }

  // Both sidecars are required (startSidecars is fatal if any is missing), so
  // "healthy" means every language can generate right now.
  const allReady = ALL_LANGS.every((lang) => isSidecarReady(lang));

  return Response.json({
    status: allReady ? "healthy" : "degraded",
    // Backwards-compatible: true once every language can generate.
    sidecar: allReady,
    mode: isLocalMode() ? "local" : "huggingface",
    model_dir: getModelDir("de"),
    model_dir_en: getModelDir("en"),
    voices_dir: getVoicesDir(),
    temperature: getTemp(),
    quantized: getQuantize(),
    default_language: defaultLang,
    languages,
    timestamp: new Date().toISOString(),
  });
}
