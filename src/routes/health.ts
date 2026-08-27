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

  return Response.json({
    status: isSidecarReady(defaultLang) ? "healthy" : "degraded",
    // Backwards-compatible: true once the DEFAULT language can generate.
    sidecar: isSidecarReady(defaultLang),
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
