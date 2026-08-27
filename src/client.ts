// PocketTTS HTTP client.
//
// A single self-contained client for the PocketTTS server. It hides every HTTP
// detail (paths, JSON/multipart shapes, error envelopes, abort wiring, WAV
// header quirks) behind a small typed API:
//
//   const tts = createTtsClient();            // defaults to http://localhost:3001
//
//   // 1. One-shot synthesis (full WAV bytes):
//   const wav = await tts.synthesize({ text: "Hallo Welt", voice: "juergen" });
//
//   // 2. Streaming synthesis (first bytes arrive while the model is still
//   //    generating; cancel at any time with stream.cancel()):
//   const stream = tts.synthesizeStream({ text: "Eine etwas laengere Passage ..." });
//   //    post-processing runs per generated chunk on the server (options
//   //    `postprocess` and `effects`, see SynthesizeOptions).
//   for await (const chunk of stream.chunks()) {
//     sendOverWebSocket(chunk);               // chunk is a Uint8Array of raw WAV bytes
//   }
//
//   // 3. Voices (per language, pass "de"/"en", default is the server's):
//   const { voices } = await tts.listVoices("en");
//   await tts.cloneVoice("my_colleague", { lang: "en", audio: referenceWavBytes });
//   const file = await tts.downloadVoice("my_colleague", "en");  // .safetensors bytes
//   await tts.importVoice("my_colleague", { lang: "en", file }); // e.g. on another server
//   await tts.deleteVoice("my_colleague", "en");
//
//   // 4. Server / model state:
//   const health = await tts.health();        // { status, sidecar, mode, ... }
//   await tts.waitForReady();                 // poll until the model is loaded (startup takes ~20-60 s)
//
// Typical use in a websocket service: start your websocket server immediately,
// call `tts.waitForReady()` in the background, and when a "generate" message
// arrives, run `synthesizeStream()` and forward each chunk to the client.
// Call `stream.cancel()` when the websocket closes, that aborts the HTTP
// request, and the server stops generation at the next chunk boundary.
//
// No dependencies: plain fetch/FormData/Blob/ReadableStream (Bun and browser).

const DEFAULT_BASE_URL = "http://localhost:3001";

/** Language for synthesis: German (default) or English. */
export type Lang = "de" | "en";

export interface TtsClientOptions {
  /** Server base URL. Defaults to `http://localhost:3001`. */
  baseUrl?: string;
  /** Custom fetch implementation (defaults to globalThis.fetch). */
  fetch?: typeof fetch;
}

/** Options for generating speech (`synthesize`, `synthesizeStream`). */
export interface SynthesizeOptions {
  /** Text to synthesize, in the language selected via `lang`. Required. */
  text: string;
  /**
   * Language: `de` (German, default) or `en` (English). Determines which
   * sidecar/model and which voice set are used. Custom voice names only
   * exist in the language they were cloned in, call `listVoices(lang)`.
   */
  lang?: Lang;
  /**
   * Built-in voice name or name of a clone (see `listVoices`).
   * Defaults to the server's default voice for `lang` (juergen for de, alba for en).
   */
  voice?: string;
  /**
   * Output post-processing, applied to the generated chunks in the sidecar.
   * `auto` (server default): removes the leading cold-start click, denoises
   * and gates noise tails when detected, keeps loudness consistent.
   * `full`: always denoise + tail-gate. `off`: raw model output.
   */
  postprocess?: "auto" | "full" | "off";
  /**
   * Optional intentional effects (preset name or JSON array), e.g.
   * `"cathedral"` or `[{ type: "reverb", wet: 0.4 }]`.
   * Presets: `cathedral`, `broadcast`, `phone`, `robot`.
   */
   effects?: string | Array<Record<string, unknown>>;
   /**
    * Output container. `wav` (default) is 16-bit PCM WAV at 24 kHz. `opus` is
    * Ogg/Opus (encoded in the sidecar at the native 24 kHz rate, decodes to
    * 48 kHz). The server-wide default can be set via the OUTPUT_FORMAT env
    * var; an explicit value here always wins.
    */
   format?: "wav" | "opus";
   /**
    * Opus bitrate in kbps, only used when `format` is `opus` (ignored for
    * wav). Range 6–510, default 32. The server-wide default can be set via
    * the OPUS_BITRATE env var; an explicit value here always wins.
    */
   bitrate?: number;
   /** Aborts the request (and server-side generation) when the signal fires. */
   signal?: AbortSignal;
}

/** Options for `cloneVoice`. */
export interface CloneVoiceOptions {
  /** Name for the new voice: alphanumeric, hyphen, underscore. */
  name: string;
  /**
   * Language the clone belongs to (and will speak): `de` (default) or `en`.
   * German and English clones are NOT interchangeable, pass the matching
   * `lang` to `synthesize`.
   */
  lang?: Lang;
  /** Reference recording bytes (WAV or MP3, 5-30 s of clean solo speech). Sent as multipart upload, works from any client. */
  audio: Uint8Array;
  /** Aborts the request when the signal fires. Cloning takes ~30-60 s. */
  signal?: AbortSignal;
}

/** A voice as returned by `listVoices`. */
export interface Voice {
  name: string;
  type: "builtin" | "custom";
  /**
   * Built-in voices: the persona's native language (informational, e.g. "german").
   * Custom voices: the language they were cloned in ("de"/"en").
   */
  language: string;
  /** Only for custom voices. */
  path?: string;
}

/** Response of `listVoices`. */
export interface VoicesList {
  mode: "huggingface" | "local";
  /** The language this list belongs to (the `lang` argument, or the server default). */
  language: Lang;
  voices: Voice[];
}

/** Readiness of one language's sidecar (see `Health.languages`). */
export interface LanguageStatus {
  /** True when the language's model files are configured (always true in HF mode). */
  available: boolean;
  /** True once this language's sidecar has loaded its model and is warm. */
  ready: boolean;
  model_dir: string | null;
}

/** Response of `health`. */
export interface Health {
  status: "healthy" | "degraded";
  /** True once the DEFAULT language's sidecar is ready (backwards-compatible). */
  sidecar: boolean;
  mode: "huggingface" | "local";
  model_dir: string | null;
  model_dir_en: string | null;
  voices_dir: string;
  temperature: number;
  quantized: boolean;
  /** Language used when a request omits `lang` (DEFAULT_LANGUAGE env var). */
  default_language: Lang;
  /** Per-language sidecar status. */
  languages: Record<Lang, LanguageStatus>;
  timestamp: string;
}

/** Response of `cloneVoice`. */
export interface CloneResult {
  voice_name: string;
  /** Language the clone belongs to. */
  language: Lang;
  path: string;
  message: string;
}

/** Response of `importVoice`. */
export type ImportResult = CloneResult;

/** Response of `deleteVoice`. */
export interface DeleteResult {
  voice_name: string;
  /** Language the voice belonged to. */
  language: Lang;
  deleted: boolean;
  message: string;
}

/** Options for `waitForReady`. */
export interface WaitReadyOptions {
  /** Give up after this long. Default 120 s (model load takes ~20-60 s). */
  timeoutMs?: number;
  /** Polling interval. Default 1000 ms. */
  intervalMs?: number;
  /** Aborts the wait when the signal fires. */
  signal?: AbortSignal;
}

/**
 * Error thrown for any API failure: non-2xx responses, network errors, or a
 * cancelled/aborted stream. The server's error message is in `.message`.
 */
export class TtsApiError extends Error {
  /** HTTP status code, or 0 for network-level failures / aborts. */
  readonly status: number;
  /** True if the failure was a local abort (cancel() / AbortSignal), not a server error. */
  readonly aborted: boolean;

  constructor(status: number, message: string, aborted = false) {
    super(message);
    this.name = "TtsApiError";
    this.status = status;
    this.aborted = aborted;
  }
}

/**
 * A running streaming synthesis (returned by `synthesizeStream`).
 *
 * Consume `chunks()` with `for await`, each chunk is a `Uint8Array` of raw
 * WAV bytes (the very first chunk starts with the 44-byte WAV header) when the
 * output format is `wav`, or Ogg/Opus bytes when `format: "opus"` (the Opus
 * header pages come first, then the encoder flushes in ~1 s bursts). Stop at
 * any time with `cancel()`, or simply break out of the loop: breaking early
 * also cancels the request, and the server stops generation at the next chunk
 * boundary.
 *
 * Note: the streamed WAV header carries a placeholder data size (unknown while
 * streaming). Do not rely on the RIFF/data chunk sizes in the header when
 * forwarding chunks. Use `toWav()` if you need a complete, playable file.
 */
export interface TtsStream {
  /** Raw audio chunks as they are generated. Auto-cancels the request if iteration stops early. */
  chunks(): AsyncIterable<Uint8Array>;
  /** True after `cancel()` was called (or the consumer aborted via the passed signal). */
  readonly cancelled: boolean;
  /**
   * Stops generation: aborts the HTTP request. The server stops at the next
   * chunk boundary (a sentence whose audio is already being computed finishes).
   * Safe to call multiple times.
   */
  cancel(): void;
   /**
    * Consumes the whole stream and returns the complete audio as one
    * `Uint8Array`: for `wav` output a WAV file with a CORRECTED header
    * (patched sizes), for `opus` output the complete Ogg/Opus stream, ready
    * to save/play/forward as one blob. Only use this if you don't need live
    * streaming.
    */
   toWav(): Promise<Uint8Array>;
}

export interface TtsClient {
  synthesize(options: SynthesizeOptions): Promise<Uint8Array>;
  synthesizeStream(options: SynthesizeOptions): Promise<TtsStream>;
  /** Lists the voices for one language (`lang` defaults to the server default). */
  listVoices(lang?: Lang): Promise<VoicesList>;
  cloneVoice(options: CloneVoiceOptions): Promise<CloneResult>;
  /**
   * Imports an existing .safetensors voice file (e.g. previously downloaded
   * via `downloadVoice`) under the given name. Overwrites an existing voice
   * of the same name.
   */
  importVoice(options: {
    name: string;
    /** The .safetensors voice file bytes. */
    file: Uint8Array;
    lang?: Lang;
    signal?: AbortSignal;
  }): Promise<ImportResult>;
  /**
   * Downloads a voice's .safetensors model file. Custom voices are always
   * downloadable; built-in voices only in local mode.
   * @throws TtsApiError (404) when the voice has no local model file.
   */
  downloadVoice(name: string, lang?: Lang, signal?: AbortSignal): Promise<Uint8Array>;
  /**
   * Deletes a cloned voice. Built-in voices are protected (403).
   * @throws TtsApiError (404) when the voice does not exist.
   */
  deleteVoice(name: string, lang?: Lang, signal?: AbortSignal): Promise<DeleteResult>;
  health(): Promise<Health>;
  waitForReady(options?: WaitReadyOptions): Promise<Health>;
}

/**
 * Creates a client for the PocketTTS server.
 *
 * @param options `baseUrl` (default `http://localhost:3001`) and an optional custom `fetch`.
 */
export function createTtsClient(options: TtsClientOptions = {}): TtsClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  
  const doFetch = options.fetch ?? globalThis.fetch;

  async function rawRequest(path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    
    try {
      response = await doFetch(`${baseUrl}${path}`, init);
    } catch (error) {
      if (init.signal?.aborted) throw new TtsApiError(0, "Request aborted", true);
      
      throw new TtsApiError(0, `Request to ${baseUrl}${path} failed: ${errMsg(error)}`);
    }

    if (!response.ok) {
      const message = await errorBody(response);
      
      throw new TtsApiError(response.status, `HTTP ${response.status}: ${message}`);
    }

    return response;
  }

  function ttsBody(options: {
    text: string;
    lang?: Lang;
    voice?: string;
    postprocess?: SynthesizeOptions["postprocess"];
    effects?: SynthesizeOptions["effects"];
    format?: SynthesizeOptions["format"];
    bitrate?: SynthesizeOptions["bitrate"];
  }): Record<string, unknown> {
    const body: Record<string, unknown> = { text: options.text };

    if (options.lang !== undefined) body.lang = options.lang;

    if (options.voice !== undefined) body.voice = options.voice;

    if (options.postprocess !== undefined) body.postprocess = options.postprocess;

    if (options.effects !== undefined) body.effects = options.effects;

    if (options.format !== undefined) body.format = options.format;

    if (options.bitrate !== undefined) body.bitrate = options.bitrate;

    return body;
  }

  async function postJson(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    return rawRequest(
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      },
    );
  }

  async function getJson<T>(path: string): Promise<T> {
    return (await (await rawRequest(path, { method: "GET" })).json()) as T;
  }

  return {
    /**
      * Generates speech and resolves with the COMPLETE audio file as a
      * `Uint8Array`: a 16-bit PCM WAV (24 kHz mono) by default, or an Ogg/Opus
      * container when `format: "opus"`. Blocks for the full generation time —
      * for long text prefer `synthesizeStream` so the consumer gets audio
      * while it renders.
      *
      * @throws TtsApiError on server errors (400 unknown voice, 503 not ready, ...) or network failure.
      */
     async synthesize({ text, lang, voice, postprocess, effects, format, bitrate, signal }) {
       const response = await postJson("/tts", ttsBody({ text, lang, voice, postprocess, effects, format, bitrate }), signal);
       
       return new Uint8Array(await response.arrayBuffer());
     },

    /**
     * Starts streaming speech generation. Resolves as soon as the server
     * accepts the request (before audio exists); audio then arrives via
     * `stream.chunks()`.
     *
     * Cancelling (`stream.cancel()`, breaking out of the chunk loop, or the
     * passed `AbortSignal`) aborts the request; the server stops generation at
     * the next chunk boundary, so cancellation is fast and free.
     *
     * The server generates at most one request at a time in practice, don't
     * overlap concurrent generations.
     */
    async synthesizeStream({ text, lang, voice, postprocess, effects, format, bitrate, signal }) {
      const upstream = new AbortController();

      const onAbort = () => upstream.abort();
      
      if (signal) {
        if (signal.aborted) upstream.abort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }

      const res = await postJson("/tts/stream", ttsBody({ text, lang, voice, postprocess, effects }), upstream.signal);
      
      const body = res.body;
      
      if (!body) throw new TtsApiError(502, "Server returned no stream body");

      let cancelled = false;
      
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

      const stream: TtsStream = {
        get cancelled() {
          return cancelled || upstream.signal.aborted;
        },
        cancel() {
          cancelled = true;
          
          upstream.abort();
          
          reader?.cancel().catch(() => {});
        },
        async *chunks() {
          if (!reader) reader = body.getReader();
          
          try {
            while (true) {
              const { done, value } = await reader.read();

              if (done) return;
              
              if (value) yield value;
            }
          } catch (error) {
            if (upstream.signal.aborted) {
              // Local cancel/abort: normal termination, not an error.
              return;
            }
            
            throw new TtsApiError(0, `Stream error: ${errMsg(error)}`);
          } finally {
            // Consumer broke out of the loop early (or the generator was
            // abandoned): stop paying for audio they don't take.
            if (!cancelled && reader && !upstream.signal.aborted) {
              // Only cancel if the stream is not already finished.
              try {
                const { done } = await reader.read();
                
                if (!done) this.cancel();
              } catch {
                /* already closed/errored */
              }
            }
            
            signal?.removeEventListener("abort", onAbort);
          }
        },
        async toWav() {
          if (!reader) reader = body.getReader();
          
          const parts: Uint8Array[] = [];
          
          let total = 0;
          
          try {
            while(true) {
              const { done, value } = await reader.read();
              
              if (done) break;

              if (value) {
                parts.push(value);
                
                total += value.byteLength;
              }
            }
          } catch (error) {
            if (!upstream.signal.aborted) throw new TtsApiError(0, `Stream error: ${errMsg(error)}`);
          }

          const outArray = new Uint8Array(total);
          
          let offset = 0;
          
          for (const tmpPart of parts) {
            outArray.set(tmpPart, offset);
            
            offset += tmpPart.byteLength;
          }

          signal?.removeEventListener("abort", onAbort);
          
          return fixWavHeader(outArray);
        },
      };

      return stream;
    },

    /**
     * Lists all available voices (built-ins and local clones), plus the
     * server mode. Use this to discover valid `voice` names for synthesis.
     */
    async listVoices(lang) {
      return getJson<VoicesList>(lang ? `/voices?lang=${lang}` : "/voices");
    },

    /**
      * Clones a voice from a reference recording (5-30 s of clean solo speech)
      * and resolves with the new voice name for use in `synthesize`.
      *
      * Pass `audio` (bytes), the recording is uploaded to the server as a
      * multipart form field. Takes ~30-60 s.
      *
      * Legal note: only clone voices you have the rights to / consent for.
      */
      async cloneVoice({ name, lang, audio, signal }) {
        if (!audio) throw new Error("cloneVoice: `audio` (reference recording bytes) is required");
        
        const formData = new FormData();
        
        formData.append("name", name);
        
        if (lang) formData.append("lang", lang);
        
        const extension = looksLikeWav(audio) ? "wav" : "mp3";
       
       const copy = new Uint8Array(audio.byteLength);
       
       copy.set(audio);
       
        formData.append("audio", new Blob([copy], { type: "application/octet-stream" }), `reference.${extension}`);
        
        const response = await rawRequest("/voices/clone", { method: "POST", body: formData, signal });

        return (await response.json()) as CloneResult;
      },

      /**
       * Imports an existing .safetensors voice file under the given name,
       * making it available as a custom voice (e.g. to move a voice between
       * servers). Overwrites an existing voice of the same name.
       */
      async importVoice({ name, file, lang, signal }) {
        if (!file) throw new Error("importVoice: `file` (.safetensors bytes) is required");

        const formData = new FormData();

        formData.append("name", name);

        if (lang) formData.append("lang", lang);

        const copy = new Uint8Array(file.byteLength);

        copy.set(file);

        formData.append("file", new Blob([copy], { type: "application/octet-stream" }), `${name}.safetensors`);

        const response = await rawRequest("/voices/import", { method: "POST", body: formData, signal });

        return (await response.json()) as ImportResult;
      },

      /**
       * Downloads a voice's .safetensors model file (custom voices always;
       * built-in voices only in local mode).
       */
      async downloadVoice(name, lang, signal) {
        const params = new URLSearchParams({ name });

        if (lang) params.set("lang", lang);

        const response = await rawRequest(`/voices/download?${params.toString()}`, { method: "GET", signal });

        return new Uint8Array(await response.arrayBuffer());
      },

      /**
       * Deletes a cloned voice (built-in voices are protected).
       */
      async deleteVoice(name, lang, signal) {
        const params = new URLSearchParams({ name });

        if (lang) params.set("lang", lang);

        const response = await rawRequest(`/voices?${params.toString()}`, { method: "DELETE", signal });

        return (await response.json()) as DeleteResult;
      },

    /**
     * Health check: returns server + sidecar status, mode, temperature, etc.
     * `sidecar` is only true once the model has finished loading.
     */
    async health() {
      return getJson<Health>("/health");
    },

    /**
     * Polls `health()` until the model is loaded (the sidecar needs ~20-60 s to
     * start) or `timeoutMs` elapses. Convenient to call at service startup so
     * you can accept websocket connections before the model is ready and only
     * generate once this resolves.
     *
     * @throws TtsApiError if the timeout is reached or the signal is aborted.
     */
    async waitForReady({ timeoutMs = 120_000, intervalMs = 1_000, signal } = {}) {
      const deadline = Date.now() + timeoutMs;
      
      while (true) {
        if (signal?.aborted) throw new TtsApiError(0, "waitForReady aborted", true);
        
        try {
          const healthResult = await this.health();
          
          if (healthResult.sidecar) return healthResult;
        } catch {
          // Server not up (yet), keep polling until the deadline.
        }

        if (Date.now() + intervalMs > deadline) {
          throw new TtsApiError(503, `TTS sidecar not ready within ${timeoutMs} ms`);
        }
        
        await sleep(intervalMs);
      }
    },
  };
}

function sleep(millisecond: number) {
  return new Promise((result) => setTimeout(result, millisecond));
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function looksLikeWav(array: Uint8Array): boolean {
  return array.length > 4 && array[0] === 0x52 && array[1] === 0x49 && array[2] === 0x46 && array[3] === 0x46;
}

async function errorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    
    try {
      const json = JSON.parse(text) as { error?: unknown };
      
      if (typeof json.error === "string") return json.error;
      
      if (json.error && typeof json.error === "object" && "message" in json.error) {
        return String((json.error as { message?: unknown }).message);
      }
    } catch {
      // not JSON
    }

    return text.trim().slice(0, 300) || "unknown error";
  } catch {
    return "unknown error";
  }
}

// The streamed WAV header carries a 1_000_000_000-frame placeholder (the total
// size is unknown while streaming and the server never patches it). Once the
// full file is collected, fix the RIFF size (offset 4) and the data chunk size
// (after the "data" label). The layout is the standard 44-byte PCM header —
// there is no sample-count field, so only the two size fields are touched.
function fixWavHeader(buffer: Uint8Array): Uint8Array {
  if (buffer.length < 44) return buffer;
  
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  
  const ascii = (o: number, n: number) => {
    let string = "";
    
    for (let tmpIndex = o; tmpIndex < o + n; tmpIndex++) string += String.fromCharCode(buffer[tmpIndex]);
    
    return string;
  };
  
  if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE") return buffer;
  
  let dataOffset = -1;
  
  for (let tmpIndex = 12; tmpIndex + 4 <= buffer.length; tmpIndex++) {
    if (buffer[tmpIndex] === 0x64 && buffer[tmpIndex + 1] === 0x61 && buffer[tmpIndex + 2] === 0x74 && buffer[tmpIndex + 3] === 0x61) {
      dataOffset = tmpIndex;
      
      break;
    }
  }
  
  if (dataOffset < 0 || dataOffset + 8 > buffer.length) return buffer;
  
  const dataSize = buffer.length - (dataOffset + 8);
  
  if (dataSize >= 0) {
    view.setUint32(4, 36 + dataSize, true);
    
    view.setUint32(dataOffset + 4, dataSize, true);
  }

  return buffer;
}