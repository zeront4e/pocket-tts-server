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

// MCP (Model Context Protocol) server, exposed over HTTP at POST /mcp using
// the MCP "Streamable HTTP" transport (JSON-RPC 2.0). AI agents connected via
// an MCP gateway can call the generate_speech / list_voices tools.
//
// Implementation notes:
// - Uses @modelcontextprotocol/sdk's WebStandardStreamableHTTPServerTransport,
//   which is fetch-based (Request in, Response out) and needs no Node shim.
// - STATELESS mode (no sessionIdGenerator): no session ids are issued and no
//   session validation is performed, so initialize / tools/list / tools/call
//   each work as independent requests. That keeps the endpoint trivially
//   proxyable through an HTTP gateway and restart-safe.
// - enableJsonResponse: true: POST responses are plain application/json (not
//   SSE streams), which is friendlier to HTTP proxies. The server sends no
//   server-to-client notifications, so GET/SSE is not offered (405).
// - Optional auth: when MCP_API_KEY is set, requests must carry
//   Authorization: Bearer <key> (checked before the JSON-RPC layer).
// - Audio is NOT base64-encoded by default: generate_speech returns a
//   resource_link to GET /mcp/audio/<id>, which serves the audio as raw
//   (non-base64) bytes for ~10 minutes (in-memory cache). The client fetches
//   the link for the bytes. inline_audio=true additionally embeds a base64
//   audio block in the tool result.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getDefaultLang, getMcpApiKey, defaultVoiceFor, type OutputFormat } from "../config.js";
import {
  bodyFromBuffer,
  FORMAT_CONTENT_TYPE,
  synthesizeAudio,
  type SynthesizedAudio,
  type TtsRequest,
} from "./tts.js";
import { listVoicesForLang } from "./voices.js";

// Keep in sync with the version in package.json.
const SERVER_NAME = "pocket-tts-server";
const SERVER_VERSION = "1.0.0";

const AUDIO_CACHE_TTL_MS = 10 * 60 * 1000;
const AUDIO_CACHE_MAX_ENTRIES = 256;

interface CachedAudio {
  buffer: Buffer;
  format: OutputFormat;
  contentType: string;
  expires: number;
}

// In-memory cache of generated audio, so the resource_link URLs can serve raw
// bytes without re-running the (expensive, serialized) generation.
const audioCache = new Map<string, CachedAudio>();

function pruneExpiredAudio(now: number = Date.now()): void {
  for (const [id, entry] of audioCache) {
    if (entry.expires <= now) audioCache.delete(id);
  }
}

function storeAudio(buffer: Buffer, format: OutputFormat): string {
  pruneExpiredAudio();

  while (audioCache.size >= AUDIO_CACHE_MAX_ENTRIES) {
    const oldest = audioCache.keys().next().value;
    if (oldest === undefined) break;
    audioCache.delete(oldest);
  }

  const id = crypto.randomUUID();
  audioCache.set(id, {
    buffer,
    format,
    contentType: FORMAT_CONTENT_TYPE[format],
    expires: Date.now() + AUDIO_CACHE_TTL_MS,
  });
  return id;
}

// GET /mcp/audio/<uuid>: raw bytes of a generated take (no base64).
export function mcpAudioResponse(req: Request): Response {
  const authError = mcpAuthError(req);
  if (authError) return authError;

  const id = decodeURIComponent(new URL(req.url).pathname.slice("/mcp/audio/".length));

  pruneExpiredAudio();

  const entry = audioCache.get(id);

  if (!entry || entry.expires <= Date.now()) {
    return Response.json(
      { error: "Audio not found: unknown id or it expired (generated audio is kept for ~10 minutes)" },
      { status: 404 },
    );
  }

  return new Response(bodyFromBuffer(entry.buffer), {
    headers: {
      "Content-Type": entry.contentType,
      "Content-Length": String(entry.buffer.length),
      "Content-Disposition": `attachment; filename="speech.${entry.format}"`,
      "Cache-Control": "private, max-age=600",
    },
  });
}

// POST /mcp: one stateless MCP Streamable HTTP exchange per request.
export async function mcpHandler(req: Request): Promise<Response> {
  const authError = mcpAuthError(req);
  if (authError) return authError;

  const server = createMcpServer(publicBaseUrl(req));
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });

  await server.connect(transport);

  let response: Response;

  try {
    response = await transport.handleRequest(req);
  } catch (error) {
    response = Response.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32603,
          message: `Internal error: ${error instanceof Error ? error.message : String(error)}`,
        },
      },
      { status: 500 },
    );
  }

  // JSON-mode responses are complete at this point; drop the per-request
  // server/transport so nothing outlives the exchange.
  await server.close().catch(() => {});

  return response;
}

// Builds the generate_speech tool result content. Non-base64 by default:
// a resource_link to the raw bytes (GET /mcp/audio/<id>) plus a text summary.
// inline=true additionally embeds the audio as a base64 MCP audio block.
export function buildGenerateSpeechContent(
  audio: SynthesizedAudio,
  audioBaseUrl: string,
  audioId: string,
  voiceName: string,
  inline: boolean,
): ContentBlock[] {
  const content: ContentBlock[] = [];

  if (inline) {
    content.push({ type: "audio", data: audio.buffer.toString("base64"), mimeType: audio.contentType });
  }

  content.push({
    type: "resource_link",
    uri: `${audioBaseUrl}/mcp/audio/${audioId}`,
    name: `speech.${audio.format}`,
    title: "Generated audio (raw bytes)",
    description:
      `GET this URL to download the ${audio.format.toUpperCase()} audio without base64 encoding. ` +
      "Valid for ~10 minutes after generation.",
    mimeType: audio.contentType,
    size: audio.buffer.length,
  });

  content.push({
    type: "text",
    text:
      `Generated ${audio.format.toUpperCase()} speech: language "${audio.lang}", voice "${voiceName}", ` +
      `${audio.buffer.length} bytes. ` +
      (inline
        ? "Audio is in the base64 'audio' block. "
        : "Audio is not inlined (inline_audio defaults to false); fetch the resource_link for the raw bytes. ") +
      "The resource_link serves the same bytes for ~10 minutes.",
  });

  return content;
}

function createMcpServer(audioBaseUrl: string): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, title: "PocketTTS Server", version: SERVER_VERSION },
    {
      instructions:
        "Text-to-speech for German (lang \"de\") and English (lang \"en\") using PocketTTS. " +
        "Call list_voices to see the available voices for a language, then generate_speech. " +
        "Generated audio is returned as a resource_link to the raw bytes at GET /mcp/audio/{id} " +
        "(Opus by default, ~32 kbps; valid ~10 minutes) — no base64 by default. Fetch the link to " +
        "download the bytes, or pass inline_audio=true to also embed the audio as a base64 block. " +
        "Generation is serialized server-wide, expect a few seconds per request.",
    },
  );

  server.registerTool(
    "generate_speech",
    {
      title: "Generate speech",
      description:
        "Generate TTS audio from text with PocketTTS. Returns a resource_link to the audio as raw " +
        "bytes at GET /mcp/audio/{id} (Opus by default for compactness; valid ~10 minutes) plus a " +
        "text summary — no base64 by default. Set inline_audio=true to also embed the audio inline " +
        "as a base64 MCP 'audio' block. Omitting lang uses the server default; omitting voice uses " +
        "the language default. Call list_voices first to pick a voice. Takes a few seconds; " +
        "generation is serialized.",
      inputSchema: {
        text: z.string().min(1).describe("The text to speak."),
        lang: z
          .enum(["de", "en"])
          .optional()
          .describe("Language: 'de' (German) or 'en' (English). Omit to use the server default."),
        voice: z.string().optional().describe("Voice name (see list_voices). Omit to use the language default."),
        format: z
          .enum(["wav", "opus", "mp3", "aac", "flac", "pcm"])
          .optional()
          .describe("Output container. Default 'opus' (compact); use 'wav' for uncompressed PCM-in-WAV."),
        bitrate: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Bitrate in kbps for the lossy formats (opus/mp3/aac)."),
        postprocess: z
          .enum(["auto", "full", "off"])
          .optional()
          .describe("'auto' (default) cleans up cold-start artifacts, 'full' also denoises, 'off' returns raw model output."),
        effects: z
          .union([z.string(), z.array(z.record(z.string(), z.unknown()))])
          .optional()
          .describe("Effects preset ('cathedral', 'broadcast', 'phone', 'robot', 'none') or a JSON array of {type, ...} effect objects."),
        inline_audio: z
          .boolean()
          .optional()
          .describe(
            "Include the audio inline as a base64 MCP 'audio' block (default false). Defaulting to " +
              "false avoids base64 payload overhead: the result is just the resource_link plus a " +
              "text summary, and you fetch the link for the raw bytes. Set true to also embed the " +
              "base64 audio in the tool result.",
          ),
      },
    },
    async (args) => {
        const body: TtsRequest = {
          text: args.text,
          lang: args.lang,
          voice: args.voice,
          // Opus is the MCP default: compact (good for the raw-bytes URL and
          // the optional base64 block alike). The HTTP endpoints still default to wav.
          format: args.format ?? "opus",
          bitrate: args.bitrate,
          postprocess: args.postprocess,
          effects: args.effects,
        };

        try {
          const audio = await synthesizeAudio(body);
          // Non-base64 by default: the tool result carries the resource_link
          // (raw bytes at GET /mcp/audio/<id>) + a text summary; base64 is opt-in.
          const inline = args.inline_audio ?? false;
          const id = storeAudio(audio.buffer, audio.format);
          const voiceName = args.voice ?? defaultVoiceFor(audio.lang);
          return { content: buildGenerateSpeechContent(audio, audioBaseUrl, id, voiceName, inline) };
        } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `TTS generation failed: ${message}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "list_voices",
    {
      title: "List voices",
      description:
        "List the TTS voices available for a language: built-in voices plus cloned/imported custom " +
        "voices. The language's default voice is marked. Clones are architecture-specific: a 'de' " +
        "clone only works with lang 'de', an 'en' clone only with 'en'.",
      inputSchema: {
        lang: z
          .enum(["de", "en"])
          .optional()
          .describe("Language to list voices for. Omit to use the server default."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const lang = args.lang ?? getDefaultLang();
        const listing = await listVoicesForLang(lang);
        const lines = listing.voices.map((v) => {
          const marker = v.name === listing.defaultVoice ? " (default)" : "";
          return `- ${v.name} [${v.type}]${marker}`;
        });

        return {
          content: [
            {
              type: "text",
              text:
                `Voices for "${lang}" (${listing.mode} mode), default voice: ${listing.defaultVoice}.\n` +
                lines.join("\n") +
                `\n\nUse one of these names as the "voice" argument of generate_speech. ` +
                "Clones are language-specific: pass a matching lang when using them.",
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        };
      }
    },
  );

  return server;
}

// 401 response when MCP_API_KEY is set and the request does not carry the
// matching Authorization: Bearer header. null when auth passes.
function mcpAuthError(req: Request): Response | null {
  const key = getMcpApiKey();
  if (!key) return null;

  const match = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");

  if (!match || !timingSafeEqual(match[1], key)) {
    return Response.json(
      { error: "Unauthorized: this MCP endpoint requires 'Authorization: Bearer <MCP_API_KEY>'" },
      { status: 401 },
    );
  }

  return null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Absolute base URL of this server as seen by the caller, used to build the
// resource_link URLs. Honors X-Forwarded-Proto when behind a gateway.
function publicBaseUrl(req: Request): string {
  const url = new URL(req.url);
  const forwarded = req.headers.get("x-forwarded-proto");
  const scheme = (forwarded ?? url.protocol.replace(":", "")).split(",")[0].trim() || "http";
  return `${scheme}://${url.host}`;
}
