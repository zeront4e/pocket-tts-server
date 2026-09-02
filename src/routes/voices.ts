import { runUv } from "../utils.js";
import { TtsError } from "./tts.js";
import {
  type Lang,
  BUILTIN_VOICES,
  getEffectiveConfigPath,
  isLocalMode,
  isBuiltinVoice,
  isLanguageAvailable,
  languageUnavailableError,
  getDefaultLang,
  normalizeLang,
  builtinVoiceLocalPath,
  customVoiceDir,
  customVoicePath,
  defaultVoiceFor,
} from "../config.js";

// Optional `lang` from a query string or form field: absent → server default,
// unknown → 400. Returns null plus the error when validation fails.
function parseLang(value: string | null): { lang?: Lang; error?: Response } {
  if (value === null || value.trim() === "") {
    return { lang: getDefaultLang() };
  }

  const lang = normalizeLang(value);

  if (!lang) return { error: jsonError(400, "Field 'lang' must be 'de' or 'en'") };

  return { lang };
}

export interface VoiceEntry {
  name: string;
  type: "builtin" | "custom";
  language: string;
  path?: string;
}

export interface VoiceListing {
  mode: "local" | "huggingface";
  language: Lang;
  defaultVoice: string;
  voices: VoiceEntry[];
}

// Shared voice listing for a language: built-ins (in local mode only the ones
// whose embedding exists in the language's model dir) plus the custom voices
// from the language's voice dir. Throws TtsError(503) when the language is
// unavailable. Used by GET /voices and by the MCP list_voices tool.
export async function listVoicesForLang(lang: Lang): Promise<VoiceListing> {
  if (!isLanguageAvailable(lang)) {
    throw new TtsError(503, languageUnavailableError(lang));
  }

  const builtins = BUILTIN_VOICES.map((v) => ({ ...v, type: "builtin" as const }));

  const visibleBuiltins = isLocalMode(lang)
    ? builtins.filter((v) => Bun.file(builtinVoiceLocalPath(v.name, lang)).size > 0)
    : builtins;

  const customVoices: VoiceEntry[] = [];
  const dir = customVoiceDir(lang);

  try {
    const { readdirSync } = await import("fs");
    for (const file of readdirSync(dir)) {
      if (file.endsWith(".safetensors")) {
        const name = file.replace(".safetensors", "");
        customVoices.push({ name, type: "custom", language: lang, path: `${dir}/${file}` });
      }
    }
  } catch {}

  return {
    mode: isLocalMode(lang) ? "local" : "huggingface",
    language: lang,
    defaultVoice: defaultVoiceFor(lang),
    voices: [...visibleBuiltins, ...customVoices],
  };
}

export async function voicesList(req: Request): Promise<Response> {
  const url = new URL(req.url);

  const parsed = parseLang(url.searchParams.get("lang"));

  if (parsed.error) return parsed.error;
  const lang = parsed.lang!;

  try {
    const listing = await listVoicesForLang(lang);

    return Response.json({
      mode: listing.mode,
      language: lang,
      voices: listing.voices,
    });
  } catch (error) {
    if (error instanceof TtsError) {
      return jsonError(error.status, error.message);
    }

    throw error;
  }
}

export async function voicesClone(req: Request): Promise<Response> {
  // No sidecar readiness gate: cloning spawns its own `pocket-tts export-voice`
  // process (which loads the model itself from the language's config), so it
  // works independently of which sidecars are warm.

  const contentType = req.headers.get("content-type") ?? "";

  if (!contentType.includes("multipart/form-data")) {
    return jsonError(400, "Expected multipart/form-data (fields: name, audio file)");
  }

  const formData = await req.formData();
  const n = formData.get("name") as string | null;
  const audio = formData.get("audio") as File | null;
  if (!n?.trim() || !audio) {
    return jsonError(400, "Fields 'name' and 'audio' (file) are required");
  }

  const langParsed = parseLang(formData.get("lang") as string | null);

  if (langParsed.error) return langParsed.error;
  const lang = langParsed.lang!;

  if (!isLanguageAvailable(lang)) {
    return jsonError(503, languageUnavailableError(lang));
  }

  const name = n.trim();
  const audioData = Buffer.from(await audio.arrayBuffer());

  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return jsonError(400, "Voice name must be alphanumeric with hyphens/underscores");
  }

  const src = new Uint8Array(audioData);
  const ext = detectExt(src);
  if (!ext) {
    return jsonError(400, "Could not detect audio format (expected WAV or MP3)");
  }

  const voicesPath = customVoiceDir(lang);
  Bun.spawnSync(["mkdir", "-p", voicesPath]);

  const tempPath = `${voicesPath}/.tmp_${Date.now()}.${ext}`;
  await Bun.write(tempPath, src);

  try {
    const destPath = customVoicePath(name, lang);
    const result = await runExportVoice(tempPath, destPath, lang);

    if (!result.ok) {
      return jsonError(500, `Voice cloning failed: ${result.error}`);
    }

    return Response.json({
      voice_name: name,
      language: lang,
      path: destPath,
      message:
        `Voice "${name}" cloned for language "${lang}". ` +
        `Use it with: { "voice": "${name}", "lang": "${lang}" }`,
    });
  } finally {
    try { Bun.spawnSync(["rm", "-f", tempPath]); } catch {}
  }
}

const NAME_RE = /^[a-zA-Z0-9_-]+$/;

// Local path of a voice's .safetensors, mirroring resolveVoice() priority in
// routes/tts.ts (built-in local embedding first, then the language's custom
// dir). Returns null when the voice has no local file (e.g. built-ins in HF mode).
function voiceModelPath(name: string, lang: Lang): string | null {
  const builtinLocal = isLocalMode(lang) && isBuiltinVoice(name) ? builtinVoiceLocalPath(name, lang) : null;

  if (builtinLocal && Bun.file(builtinLocal).size > 0) {
    return builtinLocal;
  }

  const localPath = customVoicePath(name, lang);

  if (Bun.file(localPath).size > 0) {
    return localPath;
  }

  return null;
}

export async function voicesDownload(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const name = url.searchParams.get("name")?.trim() ?? "";

  if (!NAME_RE.test(name)) {
    return jsonError(400, "Query param 'name' is required (alphanumeric with hyphens/underscores)");
  }

  const langParsed = parseLang(url.searchParams.get("lang"));

  if (langParsed.error) return langParsed.error;
  const lang = langParsed.lang!;

  const path = voiceModelPath(name, lang);

  if (!path) {
    return jsonError(404, `Voice "${name}" has no local model file (language "${lang}"; built-in voices are only downloadable in local mode)`);
  }

  return new Response(Bun.file(path), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${name}.safetensors"`,
    },
  });
}

export async function voicesDelete(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const name = url.searchParams.get("name")?.trim() ?? "";

  if (!NAME_RE.test(name)) {
    return jsonError(400, "Query param 'name' is required (alphanumeric with hyphens/underscores)");
  }

  const langParsed = parseLang(url.searchParams.get("lang"));

  if (langParsed.error) return langParsed.error;
  const lang = langParsed.lang!;

  if (isBuiltinVoice(name)) {
    return jsonError(403, "Built-in voices cannot be deleted");
  }

  const path = customVoicePath(name, lang);
  const file = Bun.file(path);

  if (!(await file.exists())) {
    return jsonError(404, `Voice "${name}" not found (language "${lang}")`);
  }

  await file.delete();

  return Response.json({
    voice_name: name,
    language: lang,
    deleted: true,
    message: `Voice "${name}" (language "${lang}") deleted.`,
  });
}

export async function voicesImport(req: Request): Promise<Response> {
  const contentType = req.headers.get("content-type") ?? "";

  if (!contentType.includes("multipart/form-data")) {
    return jsonError(400, "Expected multipart/form-data (fields: name, file)");
  }

  const formData = await req.formData();
  const n = formData.get("name") as string | null;
  const file = formData.get("file") as File | null;

  if (!n?.trim() || !file) {
    return jsonError(400, "Fields 'name' and 'file' (.safetensors) are required");
  }

  const langParsed = parseLang(formData.get("lang") as string | null);

  if (langParsed.error) return langParsed.error;
  const lang = langParsed.lang!;

  if (!isLanguageAvailable(lang)) {
    return jsonError(503, languageUnavailableError(lang));
  }

  const name = n.trim();

  if (!NAME_RE.test(name)) {
    return jsonError(400, "Voice name must be alphanumeric with hyphens/underscores");
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const invalid = validateSafetensors(buf);

  if (invalid) {
    return jsonError(400, invalid);
  }

  const voicesPath = customVoiceDir(lang);
  Bun.spawnSync(["mkdir", "-p", voicesPath]);

  const destPath = customVoicePath(name, lang);

  await Bun.write(destPath, buf);

  return Response.json({
    voice_name: name,
    language: lang,
    path: destPath,
    message:
      `Voice "${name}" imported for language "${lang}". ` +
      `Use it with: { "voice": "${name}", "lang": "${lang}" }`,
  });
}

// Minimal .safetensors validation: 8-byte little-endian u64 header size,
// followed by a JSON header object, with data following the header.
function validateSafetensors(buf: Buffer): string | null {
  if (buf.length < 8) {
    return "File is too small to be a .safetensors";
  }

  const headerSize = buf.readBigUInt64LE(0);

  if (headerSize === 0n || headerSize > 100n * 1024n * 1024n) {
    return "Invalid .safetensors header size";
  }

  const headerEnd = 8 + Number(headerSize);

  if (headerEnd > buf.length) {
    return "File is smaller than its declared .safetensors header";
  }

  let header: unknown;

  try {
    header = JSON.parse(buf.subarray(8, headerEnd).toString("utf8"));
  } catch {
    return "Invalid .safetensors header (not JSON)";
  }

  if (typeof header !== "object" || header === null || Array.isArray(header)) {
    return "Invalid .safetensors header (expected a JSON object)";
  }

  return null;
}

async function runExportVoice(
  src: string,
  dest: string,
  lang: Lang,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const proc = Bun.spawn(
      runUv([
        "pocket-tts", "export-voice",
        src, dest,
        "--config", await getEffectiveConfigPath(lang),
      ]),
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr] = await Promise.all([
      streamToString(proc.stdout),
      streamToString(proc.stderr),
    ]);
    const code = await proc.exited;
    if (code !== 0) {
      return { ok: false, error: (stderr || stdout).trim().slice(-500) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function streamToString(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) result += decoder.decode(value, { stream: true });
  }
  result += decoder.decode();
  return result;
}

function detectExt(data: Uint8Array): string | null {
  if (data.length > 4 && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46) return "wav";
  if (data.length > 3 && data[0] === 0xFF && data[1] === 0xFB) return "mp3";
  if (data.length > 2 && data[0] === 0x49 && data[1] === 0x44) return "mp3";
  return null;
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}
