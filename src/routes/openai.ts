// OpenAI-compatible text-to-speech endpoint (POST /v1/audio/speech).
//
// Accepts the request shape of OpenAI's /v1/audio/speech API, so the official
// OpenAI SDKs work out of the box (baseURL "<server>/v1", any API key):
//   - model:         required, any non-empty value (accepted but ignored)
//   - input:         required, non-empty string (maps to `text`)
//   - voice:         optional, passed through as a PocketTTS voice name
//                    (built-in name or clone; there is no OpenAI voice aliasing)
//   - response_format: mp3 (default) / opus / aac / flac / wav / pcm, the
//                    `audio/<name>` variants are accepted too
//   - language:      de/en (aliases like `german`/`english` work); the OpenAI
//                    { type: "language", value } object form is accepted, and
//                    the non-OpenAI `lang` field works as a fallback
//   - speed:         accepted, validated (0.25..4.0), ignored — the PocketTTS
//                    model has no per-request speed parameter
//   - instructions:  accepted, ignored
// Success: raw audio bytes with the format's Content-Type, no Content-Disposition
// (unlike the native /tts endpoint). Errors: the OpenAI error envelope
// { "error": { message, type, param, code } }.

import { OUTPUT_FORMATS, type OutputFormat } from "../config.js";
import { FORMAT_CONTENT_TYPE, resolveLang, synthesizeTts, type TtsRequest } from "./tts.js";

interface OpenAiErrorBody {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}

function openAiError(status: number, message: string, param: string | null = null, code: string | null = null): Response {
  const body: OpenAiErrorBody = {
    error: {
      message,
      type: status >= 500 ? "server_error" : "invalid_request_error",
      param,
      code,
    },
  };

  return Response.json(body, { status });
}

// Reverse map of Content-Type -> format, so a client can pass either the
// format name ("mp3") or the real MIME type ("audio/mpeg" for mp3,
// "audio/wav", "application/octet-stream" for pcm, ...).
const CONTENT_TYPE_TO_FORMAT: Record<string, OutputFormat> = Object.fromEntries(
  Object.entries(FORMAT_CONTENT_TYPE).map(([format, contentType]) => [contentType, format as OutputFormat]),
);

// Accepts "mp3", "audio/mpeg", "opus", "wav", "pcm", ... and maps them to the
// internal format names. Returns null for unknown values.
function normalizeResponseFormat(value: unknown): OutputFormat | null {
  if (typeof value !== "string") return null;

  const v = value.trim().toLowerCase();

  if ((OUTPUT_FORMATS as readonly string[]).includes(v)) return v as OutputFormat;

  return CONTENT_TYPE_TO_FORMAT[v] ?? null;
}

// The OpenAI `language` field is a string or a { type: "language", value }
// object. Returns the language string, undefined for an empty value, null for
// an unsupported shape.
function extractLanguage(value: unknown): string | undefined | null {
  if (typeof value === "string") return value.trim() || undefined;

  if (value !== null && typeof value === "object") {
    const inner = (value as Record<string, unknown>).value;

    if (typeof inner === "string") return inner.trim() || undefined;
  }

  return null;
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };

    if (typeof body.error === "string") return body.error;
  } catch {
    // not JSON
  }

  return "TTS request failed";
}

export async function openaiSpeech(request: Request): Promise<Response> {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return openAiError(400, "Request body must be valid JSON", null, "invalid_json");
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return openAiError(400, "Request body must be a JSON object");
  }

  const req = body as Record<string, unknown>;

  // model: required, any non-empty value (ignored, the sidecar is the model).
  if (typeof req.model !== "string" || req.model.trim() === "") {
    return openAiError(400, "'model' is required (any non-empty value works, it is accepted but ignored)", "model");
  }

  // input: required, non-empty string.
  const input = req.input;

  if (typeof input !== "string" || input.trim() === "") {
    return openAiError(400, "'input' is required and must be a non-empty string", "input");
  }

  // voice: optional, passed through as a PocketTTS voice name.
  let voice: string | undefined;

  if (req.voice !== undefined) {
    if (typeof req.voice !== "string" || req.voice.trim() === "") {
      return openAiError(400, "'voice' must be a string (a PocketTTS voice name, see GET /voices)", "voice");
    }

    voice = req.voice.trim();
  }

  // response_format: default mp3 (the OpenAI default).
  const format = normalizeResponseFormat(req.response_format ?? "mp3");

  if (format === null) {
    return openAiError(
      400,
      `'response_format' must be one of: ${OUTPUT_FORMATS.join(", ")} (the 'audio/<name>' variants are accepted too)`,
      "response_format",
    );
  }

  // language (or the non-OpenAI `lang` alias): de/en only.
  const languageField = req.language !== undefined ? "language" : "lang";
  let requestedLang: string | undefined;

  if (req[languageField] !== undefined && req[languageField] !== null) {
    const extracted = extractLanguage(req[languageField]);

    if (extracted === null) {
      return openAiError(400, `'${languageField}' must be a string or a { type, value } object`, languageField);
    }

    requestedLang = extracted;
  }

  // speed: validated, then ignored (the model has no per-request speed knob).
  if (req.speed !== undefined) {
    if (typeof req.speed !== "number" || !Number.isFinite(req.speed) || req.speed < 0.25 || req.speed > 4.0) {
      return openAiError(400, "'speed' must be a number between 0.25 and 4.0 (accepted but ignored)", "speed");
    }
  }

  let lang;

  try {
    lang = resolveLang(requestedLang);
  } catch (error) {
    return openAiError(400, error instanceof Error ? error.message : "Invalid request", languageField);
  }

  const ttsRequest: TtsRequest = {
    text: input,
    voice,
    lang,
    format,
  };

  try {
    const res = await synthesizeTts(ttsRequest, { attachment: false, clientSignal: request.signal });

    if (res.status < 400) return res;

    return openAiError(res.status, await errorMessage(res), null);
  } catch (error) {
    return openAiError(500, error instanceof Error ? error.message : "Internal server error", null, "internal_error");
  }
}
