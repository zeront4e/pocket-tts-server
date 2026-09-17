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

import { sidecarUrl, isSidecarReady } from "../sidecar.js";
import {
  type Lang,
  getDefaultLang,
  normalizeLang,
  isLanguageAvailable,
  languageUnavailableError,
  isBuiltinVoice,
  isLocalMode,
  builtinVoiceUrl,
  builtinVoiceLocalPath,
  defaultVoiceFor,
  customVoicePath,
  getModelDir,
  getPostprocessDefault,
  getOutputFormat,
  getOpusBitrate,
  OUTPUT_FORMATS,
  type OutputFormat,
} from "../config.js";

export type EffectsParam = string | Array<Record<string, unknown>>;

export type { OutputFormat };

// Response Content-Type per output container (pcm has no audio/* type: it is
// raw 16-bit little-endian mono samples). The file extension always matches
// the format name.
export const FORMAT_CONTENT_TYPE: Record<OutputFormat, string> = {
  wav: "audio/wav",
  opus: "audio/opus",
  mp3: "audio/mpeg",
  aac: "audio/aac",
  flac: "audio/flac",
  pcm: "application/octet-stream",
};

export interface TtsRequest {
  text?: string;
  voice?: string;
  lang?: string;
  postprocess?: string;
  effects?: EffectsParam;
  format?: string;
  bitrate?: number;
}

// Resolves the `lang` request field to a language: an explicit value wins
// (case-insensitive, accepts "de"/"german" and "en"/"english"), otherwise the
// server default (DEFAULT_LANGUAGE env var). Throws (→ 400) on unknown values.
export function resolveLang(requested?: string | null): Lang {
  if (requested === undefined || requested === null || requested.trim() === "") return getDefaultLang();
  const lang = normalizeLang(requested);
  if (!lang) throw new Error("Field 'lang' must be 'de' or 'en'");
  return lang;
}

export function resolveVoice(
  voice: string | undefined,
  lang: Lang,
): { url?: string; file?: { path: string; name: string } } {
  const selectedVoice = (voice || defaultVoiceFor(lang)).trim();

  if (isBuiltinVoice(selectedVoice) && !isLocalMode(lang)) {
    // HF mode: the language's own embedding of the built-in voice.
    return { url: builtinVoiceUrl(selectedVoice, lang) };
  }

  // Local mode: built-in names use the language's MODEL_DIR*/embeddings,
  // falling back to a same-named clone in the language's VOICES_DIR area;
  // custom names resolve directly to the language's custom-voice dir.
  const localPath = customVoicePath(selectedVoice, lang);

  const builtinLocal =
    isLocalMode(lang) && isBuiltinVoice(selectedVoice) ? builtinVoiceLocalPath(selectedVoice, lang) : null;

  if (builtinLocal && Bun.file(builtinLocal).size > 0) {
    return { file: { path: builtinLocal, name: `${selectedVoice}.safetensors` } };
  }

  if (Bun.file(localPath).size > 0) {
    return { file: { path: localPath, name: `${selectedVoice}.safetensors` } };
  }

  if (builtinLocal) {
    throw new Error(
      `Voice "${selectedVoice}" is built-in but its local embedding is missing: ${builtinLocal}. ` +
        `Copy voice embeddings into ${getModelDir(lang)}/embeddings/ or clone it with a name without a built-in clash.`,
    );
  }

  throw new Error(
    `Voice "${selectedVoice}" not found (language "${lang}"). Use GET /voices?lang=${lang} to see available voices.`,
  );
}

function buildForm(body: TtsRequest, lang: Lang): { formData: FormData; format: OutputFormat } {
  const formData = new FormData();

  formData.append("text", body.text!.trim());

  const { url, file } = resolveVoice(body.voice, lang);

  if (url) {
    formData.append("voice_url", url);
  } else if (file) {
    // Local .safetensors voice state: send the absolute path and let the
    // sidecar import + cache it in memory, instead of uploading the ~74 MB
    // state on every request (the single biggest first-chunk cost for custom
    // voices). The sidecar runs as a local child process, so the path is valid
    // for it.
    formData.append("voice_path", file.path);
  }

  const postprocess = (body.postprocess ?? getPostprocessDefault()).trim().toLowerCase();

  if (!["auto", "full", "off"].includes(postprocess)) {
    throw new Error("Field 'postprocess' must be 'auto', 'full', or 'off'");
  }

  formData.append("postprocess", postprocess);

  const effects = body.effects;

  if (effects !== undefined && effects !== "") {
    if (typeof effects === "string") {
      formData.append("effects", effects);
    } else if (Array.isArray(effects)) {
      formData.append("effects", JSON.stringify(effects));
    } else {
      throw new Error("Field 'effects' must be a preset name (string) or an array of effect objects");
    }
  }

  const format = (body.format ?? getOutputFormat()).trim().toLowerCase();

  if (!(OUTPUT_FORMATS as readonly string[]).includes(format)) {
    throw new Error(`Field 'format' must be one of: ${OUTPUT_FORMATS.join(", ")}`);
  }

  formData.append("format", format);

  // Bitrate applies to the lossy formats (opus/mp3/aac). For opus the env
  // default (OPUS_BITRATE) is honored by always sending a value; for the other
  // formats it is only sent when the request provides one, so the sidecar falls
  // back to its per-format defaults (128 kbps for mp3/aac). Range 1..1000 kbps.
  let bitrate: number | undefined;

  if (body.bitrate !== undefined) {
    const b = Number(body.bitrate);

    if (!Number.isFinite(b)) {
      throw new Error("Field 'bitrate' must be a number (kbps)");
    }

    bitrate = Math.round(b);
  }

  if (format === "opus" && bitrate === undefined) {
    bitrate = getOpusBitrate();
  }

  if (bitrate !== undefined && (bitrate < 1 || bitrate > 1000)) {
    throw new Error("Field 'bitrate' must be between 1 and 1000 (kbps)");
  }

  if (bitrate !== undefined) {
    formData.append("bitrate", String(bitrate));
  }

  return { formData, format: format as OutputFormat };
}

// 503 when the language cannot serve right now (not configured, or its
// sidecar is still loading). null when the language is ready.
function langNotReadyError(lang: Lang): Response | null {
  if (!isLanguageAvailable(lang)) {
    return jsonError(503, languageUnavailableError(lang));
  }

  if (!isSidecarReady(lang)) {
    return jsonError(503, `TTS sidecar for language "${lang}" not ready`);
  }

  return null;
}

export async function ttsGenerate(request: Request): Promise<Response> {
  const body = await request.json().catch(() => null) as TtsRequest | null;
  return synthesizeTts(body, { clientSignal: clientAbortSignal(request) });
}

// Error with an HTTP status, thrown by synthesizeAudio(). Callers map the
// status to their own error envelope (400/502/503 JSON for HTTP routes,
// isError text for the MCP tool).
export class TtsError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TtsError";
  }
}

export interface SynthesizedAudio {
  buffer: Buffer;
  format: OutputFormat;
  contentType: string;
  lang: Lang;
}

// Shared synthesis pipeline: lang resolution, readiness check, voice
// resolution, sidecar fetch, WAV header patch. Returns the final audio bytes.
// Used by /tts, the OpenAI-compatible /v1/audio/speech endpoint, and the MCP
// server. Throws TtsError (with the HTTP status to report) on any failure.
export async function synthesizeAudio(body: TtsRequest | null, opts: { clientSignal?: AbortSignal } = {}): Promise<SynthesizedAudio> {
  if (!body?.text?.trim()) {
    throw new TtsError(400, "Field 'text' is required");
  }

  let lang: Lang;

  try {
    lang = resolveLang(body.lang);
  } catch (error) {
    throw new TtsError(400, error instanceof Error ? error.message : "Invalid request");
  }

  if (!isLanguageAvailable(lang)) {
    throw new TtsError(503, languageUnavailableError(lang));
  }

  if (!isSidecarReady(lang)) {
    throw new TtsError(503, `TTS sidecar for language "${lang}" not ready`);
  }

  let formData: FormData;
  let format: OutputFormat;

  try {
    ({ formData, format } = buildForm(body, lang));
  } catch (error) {
    throw new TtsError(400, error instanceof Error ? error.message : "Invalid request");
  }

  let res: Response;

  try {
    res = await fetch(sidecarUrl(lang, "/tts"), {
      method: "POST",
      body: formData,
      signal: opts.clientSignal,
    });
  } catch (error) {
    throw new TtsError(502, error instanceof Error ? `Sidecar request failed: ${error.message}` : "Sidecar request failed");
  }

  const sidecarErr = await sidecarErrorDetails(res);

  if (sidecarErr) {
    throw new TtsError(sidecarErr.status, sidecarErr.message);
  }

  let buffer = Buffer.from(await res.arrayBuffer());

  if (format === "wav") {
    buffer = patchWavHeader(buffer);
  }

  return { buffer, format, contentType: FORMAT_CONTENT_TYPE[format], lang };
}

// Zero-copy BodyInit over a Buffer (Bun Buffers are always backed by a
// regular ArrayBuffer; the typed-array view keeps this BodyInit-assignable
// across TypeScript versions).
export function bodyFromBuffer(buffer: Buffer): BodyInit {
  return new Uint8Array(buffer.buffer as ArrayBuffer, buffer.byteOffset, buffer.byteLength);
}

// HTTP wrapper around synthesizeAudio(): maps TtsError to a JSON error
// response and success to an audio byte response. Used by /tts and by the
// OpenAI-compatible /v1/audio/speech endpoint (which passes attachment: false).
export async function synthesizeTts(body: TtsRequest | null, opts: { attachment?: boolean; clientSignal?: AbortSignal } = {}): Promise<Response> {
  let audio: SynthesizedAudio;

  try {
    audio = await synthesizeAudio(body, { clientSignal: opts.clientSignal });
  } catch (error) {
    if (error instanceof TtsError) {
      return jsonError(error.status, error.message);
    }

    return jsonError(400, error instanceof Error ? error.message : "Invalid request");
  }

  const headers: Record<string, string> = {
    "Content-Type": audio.contentType,
    "Content-Length": String(audio.buffer.length),
  };

  // The OpenAI-compatible endpoint returns bare audio bytes (no
  // Content-Disposition), the native /tts endpoint a download attachment.
  if (opts.attachment !== false) {
    headers["Content-Disposition"] = `attachment; filename="speech.${audio.format}"`;
  }

  return new Response(bodyFromBuffer(audio.buffer), { headers });
}

export async function ttsStream(request: Request): Promise<Response> {
  const body = await request.json().catch(() => null) as TtsRequest | null;

  if (!body?.text?.trim()) {
    return jsonError(400, "Field 'text' is required");
  }

  let lang: Lang;

  try {
    lang = resolveLang(body.lang);
  } catch (error) {
    return jsonError(400, error instanceof Error ? error.message : "Invalid request");
  }

  const notReady = langNotReadyError(lang);

  if (notReady) return notReady;

  try {
    const { formData, format } = buildForm(body, lang);
    const upstream = new AbortController();
    const clientSignal = clientAbortSignal(request);
    if (clientSignal) {
      if (clientSignal.aborted) upstream.abort();
      else clientSignal.addEventListener("abort", () => upstream.abort(), { once: true });
    }
    const res = await fetch(sidecarUrl(lang, "/tts"), {
      method: "POST",
      body: formData,
      signal: upstream.signal,
    });
    if (!res.ok) {
      upstream.abort();

      const err = await sidecarErrorDetails(res);

      return err ? jsonError(err.status, err.message) : jsonError(502, "Sidecar error");
    }

    const reader = res.body?.getReader();

    if (!reader) {
      upstream.abort();

      return jsonError(502, "No stream body from sidecar");
    }

    const stream = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();

          if (done) {
            controller.close();
            return;
          }

          controller.enqueue(value);
        } catch (error) {
          controller.error(error);
        }
      },
      // Client aborted (or dropped the connection): abort the sidecar fetch so
      // the sidecar sees the disconnect and stops generation.
      cancel() {
        upstream.abort();

        reader.cancel().catch(() => {});
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": FORMAT_CONTENT_TYPE[format],
        "X-Streaming": "true",
      },
    });
  } catch (error) {
    return jsonError(400, error instanceof Error ? error.message : "Invalid request");
  }
}

// The sidecar streams WAV through an unseekable queue, so its header carries a
// 1_000_000_000-frame placeholder. /tts buffers the full file, so fix that here
// (RIFF size + data size). The layout is the standard 44-byte PCM header —
// there is no sample-count field, so only the two size fields are touched
// (writing past dataOffset+8 would clobber the first PCM samples).
function patchWavHeader<T extends Buffer>(buf: T): T {
  if (buf.length < 44) return buf;

  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return buf;

  const dataOffset = buf.indexOf(Buffer.from("data"), 12);

  if (dataOffset < 0 || dataOffset + 8 > buf.length) return buf;

  const dataSize = buf.length - (dataOffset + 8);

  buf.writeUInt32LE(36 + dataSize, 4);
  buf.writeUInt32LE(dataSize, dataOffset + 4);

  return buf;
}

// AbortSignal that fires when the browser/client goes away (Bun.serve sets
// Request.signal for that). Returns undefined if the runtime does not provide it.
function clientAbortSignal(req: Request): AbortSignal | undefined {
  return req.signal;
}

// Map a failed sidecar response to status + message: 400s are validation
// errors from the sidecar (e.g. bad effects) and stay 400; everything else
// is a 502. Returns null for successful responses.
async function sidecarErrorDetails(res: Response): Promise<{ status: number; message: string } | null> {
  if (res.ok) return null;

  const text = await res.text();

  let message = `Sidecar error: ${text}`;

  if (res.status === 400) {
    const detail = (JSON.parse(text || "{}") as { detail?: string }).detail;

    message = detail || text || "Invalid request";
  }

  return { status: res.status === 400 ? 400 : 502, message };
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}
