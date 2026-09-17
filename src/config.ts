/*
Copyright 2026 zeront4e (https://github.com/zeront4e)

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
   http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { join, resolve } from "path";

// Languages supported at runtime. Each language has its OWN sidecar process
// (its own model, port, lock, voice-state cache), switching languages is pure
// routing in the Bun server, with no model reload.
export type Lang = "de" | "en";

export const MODELS = {
  repo: "lunahr/pocket-tts-ungated",
};

export interface LanguageInfo {
  code: Lang;
  label: string;
  // Directory of the language model inside the (HF) repo.
  languageDir: string;
  // Built-in voice used when a request does not name one.
  defaultVoice: string;
  // Throwaway generation text used for the startup warm-up.
  warmupText: string;
  configEnv: string;
  configDefault: string;
  portEnv: string;
  portDefault: number;
  modelDirEnv: string;
  // Subdir of VOICES_DIR where custom (cloned) voices for this language are
  // stored (German: voices/de/, English: voices/en/).
  customVoiceSubdir: string;
}

export const LANGUAGES: Record<Lang, LanguageInfo> = {
  de: {
    code: "de",
    label: "German",
    languageDir: "languages/german_24l",
    defaultVoice: "juergen",
    warmupText: "Hallo, ich bin bereit und kann loslegen.",
    configEnv: "CONFIG_PATH",
    configDefault: "./config/german_24l.yaml",
    portEnv: "SIDECAR_PORT",
    portDefault: 8081,
    modelDirEnv: "MODEL_DIR",
    customVoiceSubdir: "de",
  },
  en: {
    code: "en",
    label: "English",
    languageDir: "languages/english",
    defaultVoice: "alba",
    warmupText: "Hello, I am ready and can start talking.",
    configEnv: "CONFIG_PATH_EN",
    configDefault: "./config/english.yaml",
    portEnv: "SIDECAR_PORT_EN",
    portDefault: 8082,
    modelDirEnv: "MODEL_DIR_EN",
    customVoiceSubdir: "en",
  },
};

export const ALL_LANGS: Lang[] = ["de", "en"];

export interface BuiltinVoice {
  name: string;
  // The persona's native language (informational; every built-in voice exists
  // as an embedding in EVERY language directory and works with each language).
  language: string;
}

export const BUILTIN_VOICES: BuiltinVoice[] = [
  { name: "juergen", language: "german" },
  { name: "alba", language: "english" },
  { name: "estelle", language: "french" },
  { name: "giovanni", language: "italian" },
  { name: "lola", language: "spanish" },
  { name: "rafael", language: "portuguese" },
];

const GENERATED_CONFIG_FILE = "pocket-tts-local-config.yaml";

const effectiveConfigPaths: Partial<Record<Lang, string>> = {};

export function getConfigPath(lang: Lang = "de"): string {
  const lc = LANGUAGES[lang];
  return resolve(Bun.env[lc.configEnv] ?? lc.configDefault);
}

export function getModelDir(lang: Lang = "de"): string | null {
  const raw = Bun.env[LANGUAGES[lang].modelDirEnv];
  return raw ? resolve(raw) : null;
}

// True when the language's model files are read from disk (no HF downloads).
// Called without a lang it reports the DEFAULT language (mixed setups, e.g.
// DE local + EN from HF, are possible).
export function isLocalMode(lang: Lang = getDefaultLang()): boolean {
  return getModelDir(lang) !== null;
}

export function getSidecarPort(lang: Lang): number {
  const lc = LANGUAGES[lang];
  const p = parseInt(Bun.env[lc.portEnv] ?? String(lc.portDefault), 10);
  return Number.isFinite(p) && p > 0 ? p : lc.portDefault;
}

export function getTemp(): number {
  const t = parseFloat(Bun.env.TEMP ?? "0.7");
  return Number.isFinite(t) && t >= 0 ? t : 0.7;
}

export function getQuantize(): boolean {
  return (Bun.env.QUANTIZE ?? "1") !== "0" && (Bun.env.QUANTIZE ?? "1") !== "false";
}

// Server-wide default for the `postprocess` request param (POSTPROCESS env var).
export function getPostprocessDefault(): string {
  const v = (Bun.env.POSTPROCESS ?? "auto").trim().toLowerCase();
  return v === "full" || v === "off" ? v : "auto";
}

// Output containers. All are 24 kHz mono, encoded in the sidecar at the model's
// native rate (no resampling). `pcm` is raw 16-bit little-endian mono samples
// (no container, Content-Type application/octet-stream).
export const OUTPUT_FORMATS = ["wav", "opus", "mp3", "aac", "flac", "pcm"] as const;

export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

// Server-wide default output container (OUTPUT_FORMAT env var, "wav" default).
// A request-level `format` field always wins.
export function getOutputFormat(): OutputFormat {
  const v = (Bun.env.OUTPUT_FORMAT ?? "wav").trim().toLowerCase();
  return (OUTPUT_FORMATS as readonly string[]).includes(v) ? (v as OutputFormat) : "wav";
}

// Default Opus bitrate in kbps (OPUS_BITRATE env var), clamped to libopus's
// [6, 510] kbps range. A request-level `bitrate` field always wins.
export function getOpusBitrate(): number {
  const b = parseFloat(Bun.env.OPUS_BITRATE ?? "32");
  const n = Number.isFinite(b) ? Math.round(b) : 32;
  return Math.min(510, Math.max(6, n));
}

// Optional bearer key guarding the MCP endpoint (MCP_API_KEY env var). Unset
// (or empty) means the endpoint is open; when set, requests to POST /mcp and
// GET /mcp/audio/* must carry `Authorization: Bearer <key>`.
export function getMcpApiKey(): string | null {
  const v = (Bun.env.MCP_API_KEY ?? "").trim();
  return v || null;
}

// Voice-cloning feature flag (VOICE_CLONING env var). OFF by default (opt-in):
// the public image ships TTS-only, and the clone endpoint returns 451
// (Unavailable For Legal Reasons) until this is set. Enabled when the value is
// "1", "true", or "on" (case-insensitive).
export function isVoiceCloningEnabled(): boolean {
  const v = (Bun.env.VOICE_CLONING ?? "0").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

// Synthesis language for requests that do not carry a `lang` field
// (DEFAULT_LANGUAGE env var, default "de").
export function getDefaultLang(): Lang {
  return normalizeLang(Bun.env.DEFAULT_LANGUAGE) ?? "de";
}

// Accepts "de"/"german"/"deutsch" and "en"/"english" (case-insensitive).
export function normalizeLang(value: string | null | undefined): Lang | null {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "de" || v === "german" || v === "deutsch") return "de";
  if (v === "en" || v === "english") return "en";
  return null;
}

// A language is usable when its model files are in place: HF mode is always
// fine (files download on first use); local mode requires the model dir to
// contain model.safetensors.
export function isLanguageAvailable(lang: Lang): boolean {
  const dir = getModelDir(lang);
  if (!dir) return true;
  return Bun.file(join(dir, "model.safetensors")).size > 0;
}

export function languageUnavailableError(lang: Lang): string {
  const lc = LANGUAGES[lang];
  return (
    `Language "${lang}" (${lc.label}) is not configured on this server. ` +
    `In local mode set ${lc.modelDirEnv} to a directory containing the ${lc.label} ` +
    `model files (model.safetensors, tokenizer.model, embeddings/), or run in Hugging Face mode.`
  );
}

export function getVoicesDir(): string {
  return resolve(Bun.env.VOICES_DIR ?? "./voices");
}

export function defaultVoiceFor(lang: Lang = "de"): string {
  return LANGUAGES[lang].defaultVoice;
}

export function builtinVoiceUrl(name: string, lang: Lang = "de"): string {
  return `hf://${MODELS.repo}/${LANGUAGES[lang].languageDir}/embeddings/${name}.safetensors`;
}

export function builtinVoiceLocalPath(name: string, lang: Lang = "de"): string {
  const dir = getModelDir(lang);
  if (!dir) throw new Error(`${LANGUAGES[lang].modelDirEnv} is not set`);
  return join(dir, "embeddings", `${name}.safetensors`);
}

export function isBuiltinVoice(name: string): boolean {
  return BUILTIN_VOICES.some((v) => v.name === name);
}

// Directory holding custom (cloned/imported) voices for one language.
export function customVoiceDir(lang: Lang): string {
  const sub = LANGUAGES[lang].customVoiceSubdir;
  return sub ? join(getVoicesDir(), sub) : getVoicesDir();
}

export function customVoicePath(name: string, lang: Lang): string {
  return join(customVoiceDir(lang), `${name}.safetensors`);
}

// Resolves the config YAML a language's sidecar should load.
// HF mode: the config as-is (hf:// URLs inside).
// Local mode (the language's MODEL_DIR* set): copies the base config, points
// weights_path and the tokenizer at the model dir, and writes the result to
// <cwd>/.cache/pocket-tts/ (note: NOT os.tmpdir(), Bun's tmpdir() honors the
// TEMP env var, which is ours).
export async function getEffectiveConfigPath(lang: Lang = "de"): Promise<string> {
  const cached = effectiveConfigPaths[lang];
  if (cached) return cached;

  const modelDir = getModelDir(lang);

  if (!modelDir) {
    const p = getConfigPath(lang);
    effectiveConfigPaths[lang] = p;
    return p;
  }

  const baseText = await Bun.file(getConfigPath(lang)).text().catch(() => {
    throw new Error(`Base config not found: ${getConfigPath(lang)}`);
  });

  const cfg = Bun.YAML.parse(baseText) as Record<string, unknown>;

  cfg.weights_path = join(modelDir, "model.safetensors");

  const flowLm = cfg.flow_lm as { lookup_table?: { tokenizer_path?: unknown } } | undefined;

  if (flowLm?.lookup_table) {
    flowLm.lookup_table.tokenizer_path = join(modelDir, "tokenizer.model");
  }

  const file = lang === "de" ? GENERATED_CONFIG_FILE : `pocket-tts-local-config-${lang}.yaml`;
  const out = join(process.cwd(), ".cache", "pocket-tts", file);

  await Bun.write(out, Bun.YAML.stringify(cfg));

  console.log(`[config] Local mode (${lang}): generated config at ${out} (${LANGUAGES[lang].modelDirEnv}=${modelDir})`);

  effectiveConfigPaths[lang] = out;

  return out;
}
