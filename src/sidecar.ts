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

import { join } from "path";
import { getUvPath } from "./utils.js";
import {
  type Lang,
  ALL_LANGS,
  LANGUAGES,
  getEffectiveConfigPath,
  getModelDir,
  isLanguageAvailable,
  languageUnavailableError,
  getTemp,
  getQuantize,
  getPostprocessDefault,
  getSidecarPort,
  getDefaultLang,
} from "./config.js";

interface SidecarState {
  child: ReturnType<typeof Bun.spawn> | null;
  ready: boolean;
}

// One Python sidecar process per language. Each process loads its own model
// (its own KV caches, generation lock, voice-state cache), so languages never
// touch each other's model state and switching between them is pure routing
// in the Bun server, instant, and both models stay warm in memory.
const sidecars: Record<Lang, SidecarState> = {
  de: { child: null, ready: false },
  en: { child: null, ready: false },
};

export function sidecarUrl(lang: Lang, path: string): string {
  return `http://127.0.0.1:${getSidecarPort(lang)}${path}`;
}

export function isSidecarReady(lang: Lang = getDefaultLang()): boolean {
  return sidecars[lang].ready;
}

async function pipeStream(stream: ReadableStream<Uint8Array> | null, lang: Lang, isError = false) {
  if (!stream) return;

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let idx;

      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();

        buffer = buffer.slice(idx + 1);

        if (line) {
          if (isError) console.error(`[sidecar:${lang}] ${line}`);
          else console.log(`[sidecar:${lang}] ${line}`);
        }
      }
    }
  } catch {}
}

async function startSidecar(lang: Lang): Promise<void> {
  const sc = sidecars[lang];
  const lc = LANGUAGES[lang];
  const port = getSidecarPort(lang);
  const configPath = await getEffectiveConfigPath(lang);
  const modelDir = getModelDir(lang);
  const mode = modelDir ? `local (${lc.modelDirEnv}=${modelDir})` : "huggingface";

  console.log(`[sidecar:${lang}] Starting PocketTTS sidecar on port ${port} (mode: ${mode})...`);
  console.log(`[sidecar:${lang}] config: ${configPath}, temp: ${getTemp()}, quantize: ${getQuantize()}`);

  const uvBin = getUvPath();
  const wrapperPath = join(import.meta.dir, "..", "scripts", "sidecar_wrapper.py");

  // The wrapper always reads its port from SIDECAR_PORT (one process per
  // language, each with its own port).
  sc.child = Bun.spawn(
    [uvBin, "run", "python", wrapperPath],
    {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        SIDECAR_PORT: String(port),
        CONFIG_PATH: configPath,
        TEMP: String(getTemp()),
        QUANTIZE: getQuantize() ? "1" : "0",
      },
    },
  );

  const out = sc.child.stdout;
  const err = sc.child.stderr;

  if (out && typeof out !== "number") pipeStream(out, lang);
  if (err && typeof err !== "number") pipeStream(err, lang, true);

  sc.child.exited.then((code: number | null) => {
    if (sc.ready) {
      console.error(`[sidecar:${lang}] Process exited with code ${code}`);
      sc.ready = false;
    }
  });

  await waitForReady(lang);

  await warmupModel(lang);

  sc.ready = true;

  console.log(`[sidecar:${lang}] Ready at http://127.0.0.1:${port}`);
}

// Starts every language. BOTH sidecars are required: the server only accepts
// traffic once every language's model is loaded and warm. A failed (or
// missing) sidecar for ANY language is fatal, index.ts exits with the
// collected errors. Both languages start in parallel, so the total startup
// time is the slowest sidecar, not the sum.
export async function startSidecars(): Promise<void> {
  const errors: string[] = [];

  await Promise.all(
    ALL_LANGS.map(async (lang) => {
      if (!isLanguageAvailable(lang)) {
        errors.push(languageUnavailableError(lang));
        return;
      }

      try {
        await startSidecar(lang);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`Failed to start ${lang} sidecar: ${message}`);
      }
    }),
  );

  if (errors.length > 0) {
    throw new Error(errors.join(" | "));
  }
}

// The model's first generation after startup is the worst case for artifacts
// (leading clicks, low level, noise tails). Run one throwaway generation per
// language before the server accepts requests so the first *real* request
// benefits from a warm model. Best-effort: a failure here never blocks startup.
async function warmupModel(lang: Lang): Promise<void> {
  try {
    // Dynamic import: routes/tts.js imports sidecar.js (would be a cycle if static).
    const { resolveVoice } = await import("./routes/tts.js");

    const formData = new FormData();

    formData.append("text", LANGUAGES[lang].warmupText);

    const { url, file } = resolveVoice(undefined, lang);

    if (url) {
      formData.append("voice_url", url);
    } else if (file) {
      // Local .safetensors voice state: send the path (the sidecar imports and
      // caches it); the warmup also primes that cache for the first real request.
      formData.append("voice_path", file.path);
    } else {
      throw new Error("default voice could not be resolved");
    }

    formData.append("postprocess", getPostprocessDefault());

    console.log(`[sidecar:${lang}] Warming up model (first generation)...`);

    const t0 = Date.now();

    const res = await fetch(sidecarUrl(lang, "/tts"), {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      throw new Error(`warmup request failed: ${res.status} ${await res.text()}`);
    }

    await res.arrayBuffer();

    console.log(`[sidecar:${lang}] Model warmup done in ${Date.now() - t0}ms`);
  } catch (error) {
    console.warn(`[sidecar:${lang}] Warmup failed (continuing anyway): ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function waitForReady(lang: Lang): Promise<void> {
  const timeout = 180_000;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(sidecarUrl(lang, "/health"));

      if (res.ok) return;
    } catch {
      await new Promise((response) => setTimeout(response, 1000));
    }
  }

  throw new Error(`Sidecar (${lang}) did not become ready within ${timeout / 1000}s`);
}

export function stopSidecars(): void {
  for (const lang of ALL_LANGS) {
    const sc = sidecars[lang];

    if (sc.child) {
      console.log(`[sidecar:${lang}] Stopping...`);
      sc.child.kill();
      sc.child = null;
      sc.ready = false;
    }
  }
}
