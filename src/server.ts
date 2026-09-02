import { join } from "path";
import { healthHandler } from "./routes/health.js";
import { ttsGenerate, ttsStream } from "./routes/tts.js";
import { openaiSpeech } from "./routes/openai.js";
import { voicesList, voicesClone, voicesDownload, voicesDelete, voicesImport } from "./routes/voices.js";
import { docsHtml, openapiJson, swaggerAsset } from "./routes/docs.js";

const PORT = Number(Bun.env.PORT ?? 3001);

export async function createServer() {
  const demoHtml = await Bun.file(join(import.meta.dir, "../static/index.html")).text();

  return Bun.serve({
    port: PORT,
    // Generations are serialized in the sidecar, so a request queued behind
    // other generations can wait longer than the default 10 s without any
    // data flowing, which would make Bun kill the socket mid-request.
    // 255 s is Bun's maximum. Real client aborts still propagate via the
    // stream's "cancel()".
    idleTimeout: 255,
    fetch(req: Request) {
      const url = new URL(req.url);
      const method = req.method;

      try {
        if (method === "GET" && url.pathname === "/") {
          return new Response(demoHtml, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }

        if (method === "GET" && url.pathname === "/health") {
          return healthHandler(req);
        }

        if (method === "GET" && url.pathname === "/icon.jpg") {
          return new Response(Bun.file(join(import.meta.dir, "../static/icon.jpg")), {
            headers: {
              "Content-Type": "image/jpeg",
              "Cache-Control": "public, max-age=86400",
            },
          });
        }

        if (method === "POST" && url.pathname === "/tts") {
          return ttsGenerate(req);
        }

        if (method === "POST" && url.pathname === "/tts/stream") {
          return ttsStream(req);
        }

        if (method === "POST" && url.pathname === "/v1/audio/speech") {
          return openaiSpeech(req);
        }

        if (method === "GET" && url.pathname === "/voices") {
          return voicesList(req);
        }

        if (method === "POST" && url.pathname === "/voices/clone") {
          return voicesClone(req);
        }

        if (method === "POST" && url.pathname === "/voices/import") {
          return voicesImport(req);
        }

        if (method === "GET" && url.pathname === "/voices/download") {
          return voicesDownload(req);
        }

        if (method === "DELETE" && url.pathname === "/voices") {
          return voicesDelete(req);
        }

        if (method === "GET" && url.pathname === "/docs") {
          return docsHtml(req);
        }

        if (method === "GET" && url.pathname === "/openapi.json") {
          return openapiJson(req);
        }

        if (method === "GET" && url.pathname.startsWith("/swagger/")) {
          return swaggerAsset(req, url.pathname.slice("/swagger/".length));
        }

        return notFound();
      } catch (e) {
        return Response.json(
          { error: e instanceof Error ? e.message : "Internal server error" },
          { status: 500 },
        );
      }
    },
    error(err) {
      return Response.json({ error: err.message }, { status: 500 });
    },
  });
}

function notFound() {
  return Response.json(
    {
      error: "Not found",
      docs: "Full API docs: GET /docs (Swagger UI) or GET /openapi.json",
      endpoints: [
        "GET  /              - Demo page",
        "GET  /icon.jpg      - Favicon (JPEG)",
        "GET  /docs          - Swagger docs (self-hosted, offline-capable)",
        "GET  /openapi.json  - OpenAPI 3 spec",
        "GET  /health        - Health check (incl. per-language sidecar status)",
        'POST /tts             - { "text": "...", "lang": "de|en", "voice": "juergen", "format": "wav|opus|mp3|aac|flac|pcm", "bitrate": 128 } → audio bytes',
        'POST /tts/stream      - same as /tts, streamed in chunks as they are generated',
        'POST /v1/audio/speech - OpenAI-compatible TTS: { "model": "...", "input": "...", "voice": "...", "response_format": "mp3", "language": "de|en" } → audio bytes (OpenAI error envelope on errors)',
        "GET  /voices?lang=de|en - List available voices for a language",
        "POST /voices/clone  - multipart (name + audio file: WAV/MP3 reference recording, lang optional) → cloned voice",
        "POST /voices/import  - multipart (name + file: existing .safetensors voice, lang optional) → imported voice",
        "GET  /voices/download?name=X&lang=de|en - Voice model file (.safetensors)",
        "DELETE /voices?name=X&lang=de|en - Delete a cloned voice (built-ins are protected)",
      ],
    },
    { status: 404 },
  );
}
