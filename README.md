<p align="center">
  <img src="static/icon.jpg" alt="PocketTTS Server" width="240">
</p>

# PocketTTS Server

Bun-based HTTP server for **PocketTTS** (Kyutai) with high-quality German **and** English
text-to-speech with runtime language switching, voice cloning, streaming, an OpenAI-compatible
API, and self-hosted Swagger docs.

- **Models:** German 24-layer (`german_24l`, 24 transformer layers, best quality) and English
  (6-layer) from the ungated mirror
  [`lunahr/pocket-tts-ungated`](https://huggingface.co/lunahr/pocket-tts-ungated), no HF login needed
- **Languages:** `de` (default) and `en` per request (`lang` field). Each language runs in its
  own sidecar process with its model resident in RAM, so switching is instant routing with no reload
- **Model source:** Hugging Face download (default) **or fully local files, zero downloads**,
  per language (see [Local model files](#local-model-files-no-hugging-face-download))
- **Audio:** 24 kHz mono; output as WAV (default), Ogg/Opus, MP3, AAC, FLAC, or raw PCM
  (`format` field, configurable bitrate for the lossy formats)
- **OpenAI-compatible API:** `POST /v1/audio/speech` speaks the OpenAI `audio.speech` request
  shape (drop-in for the official SDKs, `baseURL` → `…/v1`)
- **MCP server:** `POST /mcp` (Model Context Protocol, Streamable HTTP) exposes `generate_speech`
  + `list_voices` tools for AI agents and MCP gateways
- **Runtime:** CPU-only (int8 quantized), ~200 ms to first audio chunk
- **Default voices:** `juergen` (German), `alba` (English)

## Architecture

```
Bun server (port 3001)         Python sidecar DE (8081)   Python sidecar EN (8082)
┌────────────────────────┐    ┌────────────────────┐     ┌────────────────────┐
│ POST /tts              │    │ sidecar_wrapper.py │     │ sidecar_wrapper.py │
│ POST /tts/stream       │    │ (German 24l model) │     │ (English model)    │
│ POST /v1/audio/speech  │    └────────────────────┘     └────────────────────┘
│ POST /mcp (MCP server) │
│ POST /voices/clone     │
│ GET  /voices           │         (each: /tts streaming, /health)
│ GET  /   (demo page)   │
│ GET  /docs (Swagger)   │    + pocket-tts export-voice
│ GET  /openapi.json     │    (spawned per clone, with the
│ GET  /health           │     clone's language config)
└────────────────────────┘
```

The Bun server spawns **one `scripts/sidecar_wrapper.py` per language** (via `uv run python`)
in parallel on startup and waits until **both** models are loaded, both sidecars are
required and the server exits if either fails to start (fatal). Requests are routed to the
sidecar of their `lang` (`de`/`en`, default from `DEFAULT_LANGUAGE`), switching languages is
pure routing and both models stay resident. The wrapper exists because the stock
`pocket-tts serve` CLI has no temperature option, so it sets
`pocket_tts.main.tts_model = TTSModel.load_model(config=…, temp=…, quantize=…)` and serves the
stock `pocket_tts.main:web_app` with an interruptible `/tts` endpoint. It also runs the
post-processing/effects pipeline ([below](#post-processing--effects)) on the generated audio.
Clones are `.safetensors` voice states: German in `voices/de/`, English in `voices/en/`.
**Clones are architecture-specific: a German clone only works with `lang: "de"`, an English
clone only with `lang: "en"`.** After each model loads, the server issues one throwaway
warm-up generation per language (the model's first takes are the worst for artifacts).

## Setup

Requires [bun](https://bun.sh) (Node.js not needed).

```bash
./setup.sh
```

The script:
1. Installs [uv](https://astral.sh/uv/) if missing
2. Creates a Python 3.12 venv (`.venv/`)
3. Installs `pocket-tts` (incl. its PyTorch dependency from PyPI, inference still runs on
    CPU), `soundfile` (voice-cloning audio decode) and PyAV `av` (the Ogg/Opus encoder behind
   `format: "opus"`)
4. Downloads the German model (~672 MB) and the English model (~219 MB), cached by
   huggingface_hub after first run
5. Installs `bun-types`

Manual equivalent:

```bash
uv venv --python 3.12
uv pip install pocket-tts soundfile av
```

Skipping step 4 (downloads everything itself) also works if you use
[local model files](#local-model-files-no-hugging-face-download).

## Usage

```bash
# Start server (Bun on :3001, German sidecar on :8081, English sidecar on :8082)
bun run src/index.ts

# or with auto-reload
bun run dev
```

Open **http://localhost:3001/** for the demo page (generate WAV or Opus, stream with immediate
playback, stop a running generation, switch DE/EN, pick post-processing / effect / format /
bitrate, clone a voice from a **file picker**, import an existing voice,
list / download / delete voices).
Open **http://localhost:3001/docs** for the Swagger API docs (self-hosted, works offline;
raw spec at `/openapi.json`).

### API

| Endpoint           | Method | Body                                                                                                                                                                      | Response                                                          |
|--------------------|--------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------|
| `/`                | GET    | —                                                                                                                                                                         | demo page (HTML)                                                  |
| `/tts`             | POST   | `{"text": "...", "lang": "de\|en", "voice": "juergen", "format": "wav\|opus\|mp3\|aac\|flac\|pcm", "bitrate": 128, "postprocess": "auto", "effects": "cathedral"}` (all optional except `text`) | audio bytes: `audio/wav` (default), `audio/opus`, `audio/mpeg`, `audio/aac`, `audio/flac`, or raw PCM (`application/octet-stream`) |
| `/tts/stream`      | POST   | same                                                                                                                                                                      | chunked audio stream (same formats as `/tts`)                     |
| `/v1/audio/speech` | POST   | OpenAI shape: `{"model": "…", "input": "…", "voice": "…", "response_format": "mp3\|opus\|aac\|flac\|wav\|pcm", "language": "de\|en", "speed": 1.0, "instructions": "…"}` (`model` + `input` required) | audio bytes (same formats; no `Content-Disposition`) or OpenAI error envelope `{"error": {message, type, param, code}}` |
| `/mcp`             | POST   | MCP Streamable HTTP (JSON-RPC 2.0): `initialize`, `ping`, `tools/list`, `tools/call` — tools `generate_speech` + `list_voices` | JSON-RPC result (a `resource_link` to raw bytes + text summary, no base64 by default; base64 with `inline_audio: true`) or 202 (notifications) |
| `/mcp/audio/{id}`  | GET    | — (id from a `generate_speech` `resource_link`)                                                                                                                        | raw audio bytes (no base64), same formats as `/tts`; ~10 min TTL |
| `/voices`          | GET    | query: `?lang=de\|en` (optional)                                                                                                                                          | JSON voice list (`{mode, language, voices}`)                      |
| `/voices/clone`    | POST   | multipart (`name` + `audio`: WAV/MP3 reference, `lang`: optional)                                                                                                         | JSON                                                              |
| `/voices/import`   | POST   | multipart (`name` + `file`: existing `.safetensors` voice, `lang`: optional)                                                                                              | JSON (import overwrites an existing name)                         |
| `/voices/download` | GET    | query: `?name=foo&lang=de\|en`                                                                                                                                            | `.safetensors` file (custom always, built-ins only in local mode) |
| `/voices`          | DELETE | query: `?name=foo&lang=de\|en`                                                                                                                                            | JSON (deletes a cloned voice, built-ins are protected)            |
| `/health`          | GET    | —                                                                                                                                                                         | JSON (incl. mode, temperature, per-language `languages` status)   |
| `/docs`            | GET    | —                                                                                                                                                                         | Swagger UI (self-hosted)                                          |
| `/openapi.json`    | GET    | —                                                                                                                                                                         | OpenAPI 3 spec                                                    |

**Language:** every request takes an optional `lang` field (`de`/`en`, case-insensitive,
`german`/`english` aliases work). Omit it for the server default (`DEFAULT_LANGUAGE`,
default `de`). The voice list, clones, and warm-up all follow the requested language.

Voice values: built-in names (`juergen`, `alba`, `estelle`, `giovanni`, `lola`, `rafael`,
... see `GET /voices?lang=…`) or the name of a cloned voice in the language's directory.
Omit `voice` for that language's default (German: `juergen`, English: `alba`).

> **Note on speed/variation:** the PocketTTS model has **no per-request speed parameter**
> (checked against v2.1.0, the pinned release). Each generation is re-sampled, so generating
> the same text twice yields slightly different takes. The base diversity (sampling
> temperature) is set via the `TEMP` env var at startup.

### Examples

```bash
# Generate German speech (default language de, default voice juergen)
curl -X POST http://localhost:3001/tts \
  -H 'Content-Type: application/json' \
  -d '{"text": "Hallo, wie geht es dir?"}' \
  -o out.wav
# → play with:  ffplay out.wav

# Generate English speech (lang: en, default voice alba)
curl -X POST http://localhost:3001/tts \
  -H 'Content-Type: application/json' \
  -d '{"text": "Hello, how are you doing?", "lang": "en"}' \
  -o out_en.wav
# → play with:  ffplay out_en.wav

# Same, but encoded to Ogg/Opus (24 kHz native, decodes to 48 kHz; 32 kbps default, 6–510 kbps)
curl -X POST http://localhost:3001/tts \
  -H 'Content-Type: application/json' \
  -d '{"text": "Hallo, wie geht es dir?", "format": "opus", "bitrate": 64}' \
  -o out.opus
# → play with:  ffplay out.opus   (much smaller file than the WAV)

# Streaming (chunks arrive as they are generated)
curl -N -X POST http://localhost:3001/tts/stream \
  -H 'Content-Type: application/json' \
  -d '{"text": "Das hier wird live gestreamt.", "voice": "juergen"}' \
  -o out.wav
# NOTE: the streamed WAV header carries a placeholder data size (total size not
# known while streaming) — patch the header for strict players:
#   python - <<'EOF'
#   import struct; d = open("out.wav","rb+").read()
#   i = d.find(b"data", 12); s = len(d) - i - 8
#   d = d[:4] + struct.pack("<I", 36 + s) + d[8:i+4] + struct.pack("<I", s) + struct.pack("<I", s // 2) + d[i+12:]
#   open("out.wav","wb").write(d)
# EOF
# The demo page plays the stream chunk-wise (Web Audio) and is unaffected.
# Generation can be interrupted at any time by killing the request (Ctrl+C
# here; the demo has a Stop button) — the server stops at the next chunk.

# With an intentional effect (preset or custom JSON)
curl -X POST http://localhost:3001/tts \
  -H 'Content-Type: application/json' \
  -d '{"text": "Hallöchen!", "effects": "cathedral"}' -o out.wav
curl -X POST http://localhost:3001/tts \
  -H 'Content-Type: application/json' \
  -d '{"text": "Hallöchen!", "effects": [{"type":"reverb","wet":0.4},{"type":"eq","freq":3000,"gain_db":2,"kind":"peaking"}]}' \
  -o out.wav

# Any other output container (mp3/aac/flac/pcm):
curl -X POST http://localhost:3001/tts \
  -H 'Content-Type: application/json' \
  -d '{"text": "Hallo!", "format": "mp3", "bitrate": 128}' -o out.mp3
# → raw 16-bit PCM (no container header):  ffplay -f s16le -ar 24000 -ac 1 out.pcm
curl -X POST http://localhost:3001/tts \
  -H 'Content-Type: application/json' \
  -d '{"text": "Hallo!", "format": "pcm"}' -o out.pcm
```

### OpenAI-compatible API

`POST /v1/audio/speech` accepts the OpenAI `audio.speech` request shape, so the official
OpenAI SDKs work unchanged (point `baseURL` at `…/v1`; any API key is accepted):

```bash
curl -X POST http://localhost:3001/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{"model": "pocket-tts", "input": "Hello, how are you doing?",
       "voice": "alba", "response_format": "mp3", "language": "en"}' \
  -o out.mp3
```

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:3001/v1", api_key="anything")
with open("out.mp3", "wb") as f:
    f.write(client.audio.speech.create(
        model="pocket-tts",
        input="Hallo, wie geht es dir?",
        voice="juergen",
        response_format="mp3",   # mp3 (default) / opus / aac / flac / wav / pcm
        language="de",
    ).content)
```

Field mapping: `model` (required, any value) is ignored, `input` → `text`, `voice` is a
PocketTTS voice name (built-in or clone, no OpenAI voice aliasing), `response_format`
defaults to `mp3` (the `audio/<name>` variants are accepted), `language` → `lang`
(`de`/`en`, the `{type: "language", value}` object form works), `speed` is validated
(0.25–4.0) but ignored, `instructions` is ignored. `postprocess`/`effects` are not exposed
(server defaults apply). Success returns the raw audio bytes (no `Content-Disposition`);
errors use the OpenAI envelope `{"error": {"message", "type", "param", "code"}}`.

### MCP server (for AI agents)

`POST /mcp` is an [MCP](https://modelcontextprotocol.io) server using the **Streamable HTTP**
transport (JSON-RPC 2.0), built on `@modelcontextprotocol/sdk`. Point any MCP client or
gateway at it to let an agent generate speech:

```jsonc
// MCP client / gateway config (HTTP transport)
{ "mcpServers": { "pocket-tts": { "url": "http://localhost:3001/mcp" } } }
```

Tools:

- **`generate_speech`** — args: `text` (required), `lang` (`de`/`en`, default = server default),
  `voice`, `format` (`opus` **by default** for compact audio; `wav`/`mp3`/`aac`/`flac`/`pcm`
  also work), `bitrate`, `postprocess`, `effects`, and `inline_audio` (default `false`).
  The result is a **`resource_link`** to `GET /mcp/audio/{id}`, which serves the audio as
  *raw bytes (no base64)* for ~10 minutes, plus a text summary — so base64 payload overhead
  is avoided by default (the agent/gateway fetches the link for the bytes). Set
  `inline_audio: true` to also embed the audio as a **base64 MCP `audio` content block**
  (MCP's native binary content type) in the tool result.
- **`list_voices`** — args: `lang` (optional). Returns the built-in + custom voices for the
  language, marking the default.

Handshake (what the gateway does under the hood):

```bash
curl -s http://localhost:3001/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"demo","version":"1.0"}}}'

curl -s http://localhost:3001/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

curl -s http://localhost:3001/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"generate_speech","arguments":{"text":"Hallo Welt","lang":"de"}}}'
# → content: [resource_link → http://…/mcp/audio/<uuid>, text summary]   (no base64 by default)

# fetch the raw bytes (no base64) the resource_link points at:
curl -s http://localhost:3001/mcp/audio/<uuid> -o speech.opus
```

Notes: the endpoint is **stateless** (no session ids, `initialize` / `tools/call` each work as
independent requests) and returns plain JSON (no SSE stream), so it proxies cleanly through an
HTTP gateway. Generation is serialized server-wide, so long texts can take a few seconds.
Optional auth: set `MCP_API_KEY` and requests must carry
`Authorization: Bearer <key>` (same guard applies to `GET /mcp/audio/{id}`).

### Post-processing & effects

The raw model output has known artifacts, strongest on the first generations after startup: a
leading **click/pop** (a near-full-scale transient in the first ~1 ms), occasionally a **noise
tail** after the speech, and occasionally output **below audible level**. By default
(`postprocess: "auto"`) the sidecar runs a numpy/scipy pipeline over **each generated chunk**
(PocketTTS yields one per decoded latent, ~80 ms of audio) and writes the processed chunk
into the response immediately, so `/tts/stream` delivers cleaned audio from the very first
chunk onward, adding only a few ms of post-processing per chunk:

- **declick:** removes the leading transient (first chunk only, ~free)
- **Wiener denoise + online tail gate:** when `postprocess: "full"`, or auto-detected
  inaudible chunks / noise tails (noise estimated from the quietest 300 ms window seen so far)
- **adaptive leveler:** peak-normalizes each chunk (0.95) and lifts quiet chunks up to ≥ 50 %
  of the loudest chunk seen so far (loudness stays within ~6 dB)
- **soft limit:** prevents clipping after level-up/effects

`postprocess: "off"` disables everything and returns the raw model output byte-for-byte. The
server-wide default can be changed with the `POSTPROCESS` env var (`auto`/`full`/`off`), a
request-level value overrides it.

**Effects** (`effects` field, applied after cleanup): a preset name (case-sensitive) —
`cathedral` (reverb), `broadcast` (radio chain), `phone` (bandpass), `robot` (formant shift +
chopper + bitcrush + lowpass), `Female formant` (formant shift up, brighter/more female),
`Male formant` (formant shift down, darker/more male), or a JSON array of effect objects.
The formant presets change only the timbre: fundamental pitch and duration are unchanged.

| type                   | params                                                                                                                                                               |
|------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `reverb`               | `wet` (0–1, default 0.3), `size` (0–1, default 0.5)                                                                                                                  |
| `echo`                 | `delay_ms` (250), `feedback` (0–0.9, 0.4), `mix` (0.3)                                                                                                               |
| `eq`                   | `freq` (Hz), `gain_db`, `q` (1.0), `kind` (peaking/lowshelf/highshelf)                                                                                               |
| `highpass` / `lowpass` | `freq` (Hz, default 80 / 8000)                                                                                                                                       |
| `compressor`           | `threshold_db` (-18), `ratio` (3), `attack_ms` (1), `release_ms` (100)                                                                                               |
| `fade`                 | `attack_ms` (50), `release_ms` (200)                                                                                                                                 |
| `bitcrush`             | `bits` (4–15, default 12)                                                                                                                                            |
| `formant`              | `semitones` (-12…+12, default 0), formant (timbre) shift: positive = brighter/more female, negative = darker/more male, fundamental pitch and duration are unchanged |
| `chop`                 | `freq` (Hz, 1–200, default 44), `depth` (0–1, default 0.8), amplitude chopper (robot voice)                                                                          |

Example: `{"type":"echo","delay_ms":300,"feedback":0.3,"mix":0.4}`.

> **Streaming note:** post-processing is applied per generated chunk (~80 ms of audio), so
> `/tts/stream` with the default `postprocess: "auto"` still streams, processed audio arrives
> from the very first chunk onward. `postprocess: "off"` streams the raw model output.

### Output format

The `format` field selects the container; all formats are 24 kHz mono.

| `format` | Content-Type              | Notes                                                                                          |
|----------|---------------------------|------------------------------------------------------------------------------------------------|
| `wav`    | `audio/wav`               | 16-bit PCM WAV, the default. `/tts` patches the header; `/tts/stream` streams it (placeholder data size, see above) |
| `opus`   | `audio/opus`              | Ogg/Opus, native 24 kHz encoding (decodes to 48 kHz), bitrate 6–510 kbps (default 32)         |
| `mp3`    | `audio/mpeg`              | MP3 (libmp3lame), default 128 kbps                                                             |
| `aac`    | `audio/aac`               | AAC in an ADTS stream (not an `.m4a` container), default 128 kbps                              |
| `flac`   | `audio/flac`              | lossless FLAC. Delivered whole (its header is patched at the end, so it buffers before flushing) — the other formats stream per ~80 ms chunk |
| `pcm`    | `application/octet-stream`| raw 16-bit little-endian samples, no container header (`ffplay -f s16le -ar 24000 -ac 1 …`)    |

- **Encoding** happens in the Python sidecar (PyAV): the 24 kHz model output is fed directly to
  the encoder at its native rate (no resampling). `POST /tts`, `POST /tts/stream`, and
  `POST /v1/audio/speech` all support every format. The file extension (for `Content-Disposition`
  on the native endpoints) always matches the format name.
- **Bitrate:** the `bitrate` field (kbps, 1–1000) applies to the lossy formats
  (`opus`/`mp3`/`aac`). For `opus` the `OPUS_BITRATE` env default is honored when the request
  omits it (and the range is 6–510); for `mp3`/`aac` the sidecar default is 128 kbps. It is
  ignored for `wav`/`flac`/`pcm`. A request-level value always wins.
- **Streaming granularity:** `/tts/stream` streams per ~80 ms chunk for `wav`/`opus`/`mp3`/`aac`/
  `pcm`. `flac` is the exception: its muxer must seek back to patch the STREAMINFO header, so it is
  buffered in the sidecar and delivered whole at the end (still lossless, just not per-chunk). For
  Opus, FFmpeg's Ogg muxer by default only flushes a page after 1 s of media, so the sidecar opens
  the container with `page_duration=80 ms`. The browser demo decodes Opus incrementally via
  `decodeAudioData()` on the growing buffer and plays audio as it arrives.
- `postprocess` / `effects` apply identically before encoding (cleanup runs on the PCM, then the
  result is encoded).

## Docker

The image (`Dockerfile`) contains everything needed to run: Bun server, Python sidecar, CPU-only PyTorch but **not the model**. Either let it download the model on first start (Hugging Face mode) or mount your own files (local mode).

### Build & run locally

```bash
./docker-build.sh             # builds pocket-tts-server:latest (+ :<git-version>)
docker compose up -d          # starts it (creates the required tts-data volume)
```

`docker compose up -d --build` does both in one step. Notes:

- **First start (default HF mode)** downloads both models + voices (~1 GB: German model
  ~672 MB, English model ~219 MB, plus tokenizers and voice embeddings) into the `tts-data`
  volume under `/data/hf`, subsequent starts load from the volume. Both sidecars are required,
  so `/health` only reports `healthy` once **both** models are loaded (the healthcheck
  start-period is set accordingly). If either sidecar fails to start, the process exits and
  the container restarts.
- **Local mode (no downloads):** place the files from
  [Local model files](#local-model-files-no-hugging-face-download) in the volume as
  `/data/models-de/...` and `/data/models-en/...` and set `MODEL_DIR` / `MODEL_DIR_EN` in
  `docker-compose.yml` (either may be omitted to keep that language on Hugging Face).
- Cloned voices persist in the volume at `/data/voices`.
- **The volume is required:** it holds the model cache and all cloned voices.
  `docker compose down -v` deletes it (and the cached model) as well.

### Push to a registry (e.g. GHCR)

```bash
# 1. Log in. For GHCR use a personal access token with the `write:packages` scope:
docker login ghcr.io

# 2. Build + tag + push (tags: latest + git-derived version):
REPO=ghcr.io/<your-user>/pocket-tts ./docker-build.sh --push

# 3. On any other machine:
docker pull ghcr.io/<your-user>/pocket-tts:latest
docker run -d --name pocket-tts -p 3001:3001 -v pocket-tts-data:/data \
  ghcr.io/<your-user>/pocket-tts:latest
```

`REPO` works with any registry (`REPO=registry.example.com/team/pocket-tts`). If omitted,
the script derives `ghcr.io/<owner>/<repo>` (lowercased) from the `origin` git remote.
Useful flags: `--tag name:ver` (extra tag), `--platform linux/amd64` (cross-build),
`--no-cache`, and `VERSION=1.2.3` (explicit version tag instead of the git-derived one).

## Local model files (no Hugging Face download)

By default the model, tokenizer and built-in voice embeddings are downloaded from Hugging Face
on first run. If you want to **provide all model files yourself** and run with zero downloads,
set `MODEL_DIR` (German) and/or `MODEL_DIR_EN` (English) and place the files like this:

```
$MODEL_DIR/                     German (german_24l)
├── model.safetensors        # TTS model weights  (~672 MB)
├── tokenizer.model          # sentencepiece tokenizer
└── embeddings/              # built-in voices (optional — only the ones you need)
    ├── juergen.safetensors
    ├── alba.safetensors
    ├── estelle.safetensors
    ├── giovanni.safetensors
    ├── lola.safetensors
    └── rafael.safetensors

$MODEL_DIR_EN/                 English (same layout, model ~219 MB)
├── model.safetensors
├── tokenizer.model
└── embeddings/                (same six voice names)
```

How to obtain the files (one-time, on any machine with internet):

```bash
uvx --from huggingface_hub huggingface-cli download lunahr/pocket-tts-ungated \
  --include 'languages/german_24l/*' --include 'languages/english/*' \
  --local-dir ./pocket-tts-files
# then arrange so the layout above holds, e.g.:
mv pocket-tts-files/languages/german_24l ./model-dir-de
mv pocket-tts-files/languages/english   ./model-dir-en
```

or reuse an existing HF cache (`~/.cache/huggingface/hub/.../model.safetensors`, `.../tokenizer.model`,
`.../embeddings/*.safetensors`).

Then in `.env`:

```
MODEL_DIR=/path/to/model-dir-de
MODEL_DIR_EN=/path/to/model-dir-en      # optional — omit to keep English on Hugging Face
```

A mixed setup (one language local, the other from HF) works: each language resolves its own
model source. Behavior in local mode (per configured language):
- The server generates a runtime copy of that language's model config (into
  `<cwd>/.cache/pocket-tts/`) with `weights_path` and `tokenizer_path` pointing at your local
  files and passes it to the sidecar. **No Hugging Face requests are ever made** for that
  language (model, voices, everything).
- Built-in voices are loaded from `$MODEL_DIR*/embeddings/<name>.safetensors` and passed to the
  sidecar as `voice_path` (absolute path, the sidecar imports each state once and keeps it in
  memory, no per-request upload). A built-in voice whose embedding file you did *not*
  provide is hidden from `GET /voices?lang=…` and yields a clear error if requested.
- Voice cloning works identically and stays local.
- Your own clones in `VOICES_DIR` are unaffected by either mode.

### Switching language at runtime

Both languages are always available, both sidecars are required at startup (the server exits
if either fails to load). Pass `"lang": "de"` or `"lang": "en"` on any request (see
[API](#api)). There is nothing to reload: each language's model lives in its own sidecar
process. The default for requests without `lang` is `DEFAULT_LANGUAGE` (`de`/`en`, env var).
`/health` reports per-language readiness under `languages`.

## Voice cloning

Clone a voice from a reference recording (5–30 s of clean speech works best, noisy or
multi-speaker audio degrades the result).

**Browse demo:** open `/`, pick a file with the file-open dialog, name the voice, click
"Clone Voice", the browser uploads the file directly (multipart).

**CLI script:**

```bash
bun run scripts/clone-voice.ts /path/to/reference.wav                    # name derived from filename
bun run scripts/clone-voice.ts /path/to/reference.mp3 meine_stimme       # German (default lang)
bun run scripts/clone-voice.ts /path/to/reference.mp3 my_voice --lang en # English
```

Saves `voices/de/meine_stimme.safetensors` (German) or `voices/en/my_voice.safetensors` (English).
**Clones are language-specific:** synthesize with the same `lang` you cloned with:

```bash
curl -X POST http://localhost:3001/tts \
  -H 'Content-Type: application/json' \
  -d '{"text": "Hallo!", "voice": "meine_stimme", "lang": "de"}' -o out.wav
```

**Via API:** upload the reference file from any client (multipart, what the demo uses);
`lang` is an optional form field:

```bash
curl -X POST http://localhost:3001/voices/clone \
  -F 'name=meine_stimme' \
  -F 'lang=de' \
  -F 'audio=@/path/to/reference.wav'
```

**Import an existing voice model** (e.g. downloaded from another server via
`GET /voices/download?name=…&lang=…`) instead of cloning from scratch:

```bash
curl -X POST http://localhost:3001/voices/import \
  -F 'name=meine_stimme' \
  -F 'lang=de' \
  -F 'file=@/path/to/voice.safetensors'
```

The file is validated as a `.safetensors` (header size + JSON header). Importing an existing
name in the same language overwrites the previous voice.
Cloning takes ~30–60 s (the model processes the reference audio), then loading the
`.safetensors` voice state afterwards is instant.

> Legal note: only clone voices you have the rights to/consent for (CC-BY-4.0 model,
> standard prohibited-use clause).

## Configuration

Environment variables (see `.env`):

| Variable           | Default                    | Purpose                                                                                                                   |
|--------------------|----------------------------|---------------------------------------------------------------------------------------------------------------------------|
| `PORT`             | `3001`                     | Bun server port                                                                                                           |
| `SIDECAR_PORT`     | `8081`                     | German sidecar port                                                                                                       |
| `SIDECAR_PORT_EN`  | `8082`                     | English sidecar port                                                                                                      |
| `VOICES_DIR`       | `./voices`                 | where clones are stored (German in `voices/de/`, English in `voices/en/`)                                                 |
| `CONFIG_PATH`      | `./config/german_24l.yaml` | German PocketTTS model config                                                                                             |
| `CONFIG_PATH_EN`   | `./config/english.yaml`    | English PocketTTS model config                                                                                            |
| `MODEL_DIR`        | _(unset)_                  | **local mode (German)**: dir with model files, no HF downloads (see [above](#local-model-files-no-hugging-face-download)) |
| `MODEL_DIR_EN`     | _(unset)_                  | **local mode (English)**: same, for the English model                                                                     |
| `DEFAULT_LANGUAGE` | `de`                       | language for requests without a `lang` field (`de`/`en`)                                                                  |
| `TEMP`             | `0.7`                      | sampling temperature = base diversity/variation (startup only)                                                            |
| `QUANTIZE`         | `1`                        | int8 quantization on/off (startup only)                                                                                   |
| `POSTPROCESS`      | `auto`                     | server-wide default for the `postprocess` request param (`auto`/`full`/`off`)                                             |
| `OUTPUT_FORMAT`    | `wav`                      | server-wide default for the `format` request param (`wav`/`opus`/`mp3`/`aac`/`flac`/`pcm`)                                |
| `OPUS_BITRATE`     | `32`                       | default Opus bitrate in kbps (6–510), a request-level `bitrate` wins                                                      |
| `MCP_API_KEY`      | _(unset)_                  | when set, `POST /mcp` and `GET /mcp/audio/*` require `Authorization: Bearer <key>` (unset = open)                          |

## Project layout

```
Dockerfile            Docker image (Bun + Python sidecar + CPU PyTorch, model not baked in)
docker-compose.yml    Compose setup (required volume: tts-data)
docker-build.sh       build the image locally (+ optional push to a registry)
src/
  index.ts          entry point (starts both sidecars, then HTTP server)
  server.ts         route dispatch
  config.ts         env/config resolution, per-language voice paths, local-mode config generation
  sidecar.ts        spawns/monitors the per-language PocketTTS Python sidecars
  utils.ts          locates the uv binary
  client.ts         self-contained typed HTTP client for the server (Bun + browser)
  openapi.ts        OpenAPI 3 spec (hand-maintained — update with routes!)
   routes/
     tts.ts          /tts, /tts/stream + lang/voice resolution (shared synthesizeTts pipeline)
     openai.ts       /v1/audio/speech (OpenAI-compatible request shape + error envelope)
     voices.ts       /voices, /voices/clone, /voices/import, /voices/download, DELETE /voices
     docs.ts         /docs, /openapi.json, /swagger/* static assets
     health.ts       /health (per-language status)
scripts/
  clone-voice.ts    CLI voice cloning (--lang de|en)
  sidecar_wrapper.py  Python entry: loads model with TEMP/QUANTIZE, serves pocket_tts web_app
  postproc.py       post-processing pipeline + effects engine (numpy/scipy, runs in the sidecar)
  opusenc.py        Ogg/Opus encoder for format=opus (PyAV; native 24 kHz, no resampling)
  audioenc.py       MP3/AAC/FLAC/PCM encoders (PyAV; native 24 kHz, no resampling)
static/
  index.html        browser demo at GET /
  icon.jpg          demo icon / favicon (served at GET /icon.jpg)
  swagger/          vendored Swagger UI assets (docs at GET /docs, offline)
config/
  german_24l.yaml   German model config (ungated mirror, 24-layer)
  english.yaml      English model config (ungated mirror, 6-layer)
voices/
  de/               German clones (*.safetensors)
  en/               English clones (*.safetensors)
```

## Troubleshooting

- **Slow first start:** both models + voice embeddings download once (~1 GB total: German
  ~672 MB, English ~219 MB, plus tokenizers and embeddings), then are cached under
  `~/.cache/huggingface`. (Not relevant in local mode, nothing downloads.)
- **`address already in use`:** a previous sidecar is still running:
  `fuser -k 8081/tcp` (German) and `fuser -k 8082/tcp` (English)
- **Server fails to start:** both sidecars are required, so if either fails to load its model,
  or (in local mode) its model files are missing (`MODEL_DIR` / `MODEL_DIR_EN` must contain
  `model.safetensors` and `tokenizer.model`), startup aborts with a fatal error naming the
  language(s) that failed. Check the `[sidecar:de]` / `[sidecar:en]` log lines.
- **A language returns 503 at runtime:** only happens if that sidecar's process died after a
  successful startup, see `GET /health` → `languages.<lang>.ready` and the sidecar logs.
- **Quantization deprecation warnings in logs:** harmless (PyTorch int8 API notice).
  Quantization is intentionally enabled (default `QUANTIZE=1`), ~48 % less RAM, ~27 % faster,
  ~0 WER change.
- **Local mode: built-in voice missing:** copy the embedding(s) to
  `$MODEL_DIR/embeddings/<name>.safetensors`, only the voices you ship are listed/usable.
- **Cloning fails:** check the reference audio is a valid solo 5–30 s WAV/MP3,
  use `ffmpeg in.wav -ar 24000 -ac 1 cleaned.wav` to normalize first.
