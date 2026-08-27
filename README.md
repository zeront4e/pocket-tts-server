<p align="center">
  <img src="static/icon.jpg" alt="PocketTTS Server" width="240">
</p>

# PocketTTS Server

Bun-based HTTP server for **PocketTTS** (Kyutai) — high-quality German **and** English
text-to-speech with runtime language switching, voice cloning, streaming, and self-hosted
Swagger docs.

- **Models:** German 24-layer (`german_24l`, 24 heads, best quality) and English (6-layer)
  from the ungated mirror [`lunahr/pocket-tts-ungated`](https://huggingface.co/lunahr/pocket-tts-ungated)
  — no HF login needed
- **Languages:** `de` (default) and `en` per request (`lang` field). Each language runs in its
  own sidecar process with its model resident in RAM — switching is instant routing, no reload
- **Model source:** Hugging Face download (default) **or fully local files, zero downloads**,
  per language (see [Local model files](#local-model-files-no-hugging-face-download))
- **Audio:** 24 kHz mono — 16-bit PCM WAV (default) or Ogg/Opus (`format: "opus"`, native 24 kHz
  encoding, decodes to 48 kHz, configurable bitrate)
- **Runtime:** CPU-only (int8 quantized), ~200 ms to first audio chunk
- **Default voices:** `juergen` (German), `alba` (English)

## Architecture

```
Bun server (port 3001)         Python sidecar DE (8081)   Python sidecar EN (8082)
┌────────────────────────┐    ┌────────────────────┐     ┌────────────────────┐
│ POST /tts              │    │ sidecar_wrapper.py │     │ sidecar_wrapper.py │
│ POST /tts/stream       │    │ (German 24l model) │     │ (English model)    │
│ POST /voices/clone     │    └────────────────────┘     └────────────────────┘
│ GET  /voices           │         (each: /tts streaming, /health)
│ GET  /   (demo page)   │
│ GET  /docs (Swagger)   │    + pocket-tts export-voice
│ GET  /openapi.json     │    (spawned per clone, with the
│ GET  /health           │     clone's language config)
└────────────────────────┘
```

The Bun server spawns **one `scripts/sidecar_wrapper.py` per language** (via `uv run python`)
in parallel on startup and waits until the German model is loaded (the English sidecar is
best-effort: its failure degrades but does not stop the server). Requests are routed to the
sidecar of their `lang` (`de`/`en`, default from `DEFAULT_LANGUAGE`) — switching languages is
pure routing, both models stay resident. The wrapper exists because the stock
`pocket-tts serve` CLI has no temperature option; it sets
`pocket_tts.main.tts_model = TTSModel.load_model(config=…, temp=…, quantize=…)` and serves the
stock `pocket_tts.main:web_app` with an interruptible `/tts` endpoint. It also runs the
post-processing/effects pipeline ([below](#post-processing--effects)) on the generated audio.
Clones are `.safetensors` voice states: German in `voices/de/`, English in `voices/en/`.
**Clones are architecture-specific — a German clone only works with `lang: "de"`, an English
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
3. Installs `pocket-tts` (incl. CPU PyTorch), `soundfile` (voice-cloning audio decode) and
   PyAV `av` (the Ogg/Opus encoder behind `format: "opus"`)
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

Open **http://localhost:3001/** for the demo page (generate, stream with immediate
playback, regenerate a take, interrupt a running generation with **Stopp**,
clone a voice from a **file picker**, voice list).
Open **http://localhost:3001/docs** for the Swagger API docs (self-hosted, works offline;
raw spec at `/openapi.json`).

### API

 | Endpoint             | Method | Body                                                        | Response |
 |----------------------|--------|-------------------------------------------------------------|----------|
 | `/tts`               | POST   | `{"text": "...", "lang": "de|en", "voice": "juergen", "format": "wav|opus", "bitrate": 32, "postprocess": "auto", "effects": "cathedral"}` (all optional) | `audio/wav` (or `audio/opus` with `format: "opus"`) |
 | `/tts/stream`        | POST   | same                                                        | chunked `audio/wav` / `audio/opus` stream |
 | `/voices`            | GET    | query: `?lang=de|en` (optional)                              | JSON voice list (`{mode, language, voices}`) |
   | `/voices/clone`      | POST   | multipart (`name` + `audio`: WAV/MP3 reference, `lang`: optional) | JSON |
   | `/voices/import`     | POST   | multipart (`name` + `file`: existing `.safetensors` voice, `lang`: optional) | JSON (import overwrites an existing name) |
   | `/voices/download`   | GET    | query: `?name=foo&lang=de|en`                                | `.safetensors` file (custom always; built-ins only in local mode) |
   | `/voices`            | DELETE | query: `?name=foo&lang=de|en`                                 | JSON (deletes a cloned voice; built-ins are protected) |
 | `/health`            | GET    | —                                                           | JSON (incl. mode, temperature, per-language `languages` status) |
 | `/docs`              | GET    | —                                                           | Swagger UI (self-hosted) |
 | `/openapi.json`      | GET    | —                                                           | OpenAPI 3 spec |

**Language:** every request takes an optional `lang` field (`de`/`en`, case-insensitive,
`german`/`english` aliases work). Omit it for the server default (`DEFAULT_LANGUAGE`,
default `de`). The voice list, clones, and warm-up all follow the requested language.

Voice values: built-in names (`juergen`, `alba`, `estelle`, `giovanni`, `lola`, `rafael`,
... see `GET /voices?lang=…`) or the name of a cloned voice in the language's directory.
Omit `voice` for that language's default (German: `juergen`, English: `alba`).

> **Note on speed/variation:** the PocketTTS model has **no per-request speed parameter**
> (checked against v2.1.0, the latest release). The demo therefore offers a **"Neuer Take"**
> button — each generation is re-sampled, so takes differ slightly. The base diversity
> (sampling temperature) is set via the `TEMP` env var at startup.

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
# here; the demo has a Stopp button) — the server stops at the next chunk.

# With an intentional effect (preset or custom JSON)
curl -X POST http://localhost:3001/tts \
  -H 'Content-Type: application/json' \
  -d '{"text": "Hallöchen!", "effects": "cathedral"}' -o out.wav
curl -X POST http://localhost:3001/tts \
  -H 'Content-Type: application/json' \
  -d '{"text": "Hallöchen!", "effects": [{"type":"reverb","wet":0.4},{"type":"eq","freq":3000,"gain_db":2,"kind":"peaking"}]}' \
  -o out.wav
```

### Post-processing & effects

The raw model output has known artifacts, strongest on the first generations after startup: a
leading **click/pop** (a near-full-scale transient in the first ~1 ms), occasionally a **noise
tail** after the speech, and occasionally output **below audible level**. By default
(`postprocess: "auto"`) the sidecar runs a numpy/scipy pipeline over **each generated chunk**
(PocketTTS yields one per decoded latent, ~80 ms of audio) and writes the processed chunk
into the response immediately — so `/tts/stream` delivers cleaned audio from the very first
chunk onward, adding only a few ms of post-processing per chunk:

- **declick** — removes the leading transient (first chunk only, ~free)
- **Wiener denoise + online tail gate** — when `postprocess: "full"`, or auto-detected
  inaudible chunks (noise estimated from the quietest 300 ms window seen so far)
- **adaptive leveler** — peak-normalizes each chunk (0.95) and lifts quiet chunks up to ≥ 50 %
  of the loudest chunk seen so far (loudness stays within ~6 dB)
- **soft limit** — prevents clipping after level-up/effects

`postprocess: "off"` disables everything and returns the raw model output byte-for-byte. The
server-wide default can be changed with the `POSTPROCESS` env var (`auto`/`full`/`off`); a
request-level value overrides it.

**Effects** (`effects` field, applied after cleanup): a preset name — `cathedral` (reverb),
`broadcast` (radio chain), `phone` (bandpass), `robot` (bitcrush + EQ) — or a JSON array of
effect objects:

| type          | params                                                        |
|---------------|---------------------------------------------------------------|
| `reverb`      | `wet` (0–1, default 0.3), `size` (0–1, default 0.5)           |
| `echo`        | `delay_ms` (250), `feedback` (0–0.9, 0.4), `mix` (0.3)        |
| `eq`          | `freq` (Hz), `gain_db`, `q` (1.0), `kind` (peaking/lowshelf/highshelf) |
| `highpass` / `lowpass` | `freq` (Hz, default 80 / 8000)                      |
| `compressor`  | `threshold_db` (-18), `ratio` (3), `attack_ms` (1), `release_ms` (100) |
| `fade`        | `attack_ms` (50), `release_ms` (200)                          |
| `bitcrush`    | `bits` (4–15, default 12)                                     |

Example: `{"type":"echo","delay_ms":300,"feedback":0.3,"mix":0.4}`.

> **Streaming note:** post-processing is applied per generated chunk (~80 ms of audio), so
> `/tts/stream` with the default `postprocess: "auto"` still streams — processed audio arrives
> from the very first chunk onward. `postprocess: "off"` streams the raw model output.

### Output format (WAV / Opus)

By default every endpoint returns 16-bit PCM WAV (24 kHz mono). Pass `format: "opus"`
to get **Ogg/Opus** instead — typically 3–8× smaller than WAV at equal or better
perceived quality.

- **Encoding** happens in the Python sidecar (PyAV `libopus`): the 24 kHz model output is fed
  directly to the Opus encoder at its native 24 kHz rate (no resampling) and muxed into an
  Ogg/Opus container. `POST /tts` and `POST /tts/stream` both support it; the `Content-Type`
  becomes `audio/opus`. The decoder always outputs 48 kHz (Opus spec), but all signal energy
  stays in the 0–12 kHz speech band.
- **Bitrate** — the `bitrate` field (kbps, 6–510, default 32). Server-wide defaults come from
  the `OUTPUT_FORMAT` / `OPUS_BITRATE` env vars; a request-level value wins.
- **Streaming granularity** — the Ogg muxer flushes ~1 s of media per write, so `/tts/stream`
  with `format: "opus"` still streams but in ~1 s bursts (the WAV path streams per ~80 ms chunk).
  The browser demo decodes Opus incrementally via `decodeAudioData()` on the growing buffer and
  plays audio as it arrives (same Web Audio scheduling as WAV streaming).
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

- **First start (default HF mode)** downloads both models + voices (~900 MB: German ~672 MB,
  English ~219 MB) into the `tts-data` volume under `/data/hf`, subsequent starts load from
  the volume. The container reports `starting` until the German model is loaded (healthcheck
  start-period is set accordingly; the English sidecar starts best-effort in the background).
- **Local mode (no downloads):** place the files from
  [Local model files](#local-model-files-no-hugging-face-download) in the volume as
  `/data/models-de/...` and `/data/models-en/...` and set `MODEL_DIR` / `MODEL_DIR_EN` in
  `docker-compose.yml` (either may be omitted to keep that language on Hugging Face).
- Cloned voices persist in the volume at `/data/voices`.
- **The volume is required** — it holds the model cache and all cloned voices.
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
- The server generates a runtime copy of that language's model config (into the system tmp dir)
  with `weights_path` and `tokenizer_path` pointing at your local files and passes it to the
  sidecar. **No Hugging Face requests are ever made** for that language (model, voices, everything).
- Built-in voices are loaded from `$MODEL_DIR*/embeddings/<name>.safetensors` and uploaded to the
  sidecar as files (not as `hf://` URLs). A built-in voice whose embedding file you did *not*
  provide is hidden from `GET /voices?lang=…` and yields a clear error if requested.
- Voice cloning works identically and stays local.
- Your own clones in `VOICES_DIR` are unaffected by either mode.

### Switching language at runtime

Both languages are always available (when configured) — pass `"lang": "de"` or `"lang": "en"`
on any request (see [API](#api)). There is nothing to reload: each language's model lives in its
own sidecar process. The default for requests without `lang` is `DEFAULT_LANGUAGE`
(`de`/`en`, env var). `/health` reports per-language readiness under `languages`.

## Voice cloning

Clone a voice from a reference recording (5–30 s of clean speech works best; noisy or
multi-speaker audio degrades the result).

**Browse demo:** open `/`, pick a file with the file-open dialog, name the voice, click
"Clone Voice" — the browser uploads the file directly (multipart).

**CLI script:**

```bash
bun run scripts/clone-voice.ts /path/to/reference.wav                    # name derived from filename
bun run scripts/clone-voice.ts /path/to/reference.mp3 meine_stimme       # German (default lang)
bun run scripts/clone-voice.ts /path/to/reference.mp3 my_voice --lang en # English
```

Saves `voices/de/meine_stimme.safetensors` (German) or `voices/en/my_voice.safetensors` (English).
**Clones are language-specific** — synthesize with the same `lang` you cloned with:

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

| Variable       | Default                    | Purpose                                        |
|----------------|----------------------------|------------------------------------------------|
| `PORT`         | `3001`                     | Bun server port                                |
| `SIDECAR_PORT` | `8081`                     | German sidecar port                            |
| `SIDECAR_PORT_EN` | `8082`                  | English sidecar port                           |
| `VOICES_DIR`   | `./voices`                 | where clones are stored (German in `voices/de/`, English in `voices/en/`) |
| `CONFIG_PATH`  | `./config/german_24l.yaml` | German PocketTTS model config                  |
| `CONFIG_PATH_EN` | `./config/english.yaml`  | English PocketTTS model config                 |
| `MODEL_DIR`    | _(unset)_                  | **local mode (German)**: dir with model files, no HF downloads (see [above](#local-model-files-no-hugging-face-download)) |
| `MODEL_DIR_EN` | _(unset)_                  | **local mode (English)**: same, for the English model |
| `DEFAULT_LANGUAGE` | `de`                   | language for requests without a `lang` field (`de`/`en`) |
| `TEMP`         | `0.7`                      | sampling temperature = base diversity/variation (startup only) |
| `QUANTIZE`     | `1`                        | int8 quantization on/off (startup only)        |
| `POSTPROCESS`  | `auto`                     | server-wide default for the `postprocess` request param (`auto`/`full`/`off`) |
| `OUTPUT_FORMAT`| `wav`                      | server-wide default for the `format` request param (`wav`/`opus`) |
| `OPUS_BITRATE` | `32`                       | default Opus bitrate in kbps (6–510); a request-level `bitrate` wins |

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
    tts.ts          /tts, /tts/stream + lang/voice resolution
    voices.ts       /voices, /voices/clone, /voices/import, /voices/download, DELETE /voices
    docs.ts         /docs, /openapi.json, /swagger/* static assets
    health.ts       /health (per-language status)
scripts/
  clone-voice.ts    CLI voice cloning (--lang de|en)
  sidecar_wrapper.py  Python entry: loads model with TEMP/QUANTIZE, serves pocket_tts web_app
  postproc.py       post-processing pipeline + effects engine (numpy/scipy, runs in the sidecar)
  opusenc.py        Ogg/Opus encoder for format=opus (PyAV; native 24 kHz, no resampling)
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

- **Slow first start** — both models + voice embeddings download once (~900 MB total), then
  are cached under `~/.cache/huggingface`. (Not relevant in local mode — nothing downloads.)
- **`address already in use`** — a previous sidecar is still running:
  `fuser -k 8081/tcp` (German) and `fuser -k 8082/tcp` (English)
- **English unavailable (`en` requests return 503)** — in local mode `MODEL_DIR_EN` must point
  at a directory containing `model.safetensors`/`tokenizer.model`; in HF mode the English
  sidecar may still be starting (see `GET /health` → `languages.en`).
- **Quantization deprecation warnings in logs** — harmless (PyTorch int8 API notice),
  quantization is intentionally enabled (default `QUANTIZE=1`): ~48 % less RAM, ~27 % faster,
  ~0 WER change.
- **Local mode: built-in voice missing** — copy the embedding(s) to
  `$MODEL_DIR/embeddings/<name>.safetensors`; only the voices you ship are listed/usable.
- **Cloning fails** — check the reference audio is a valid solo 5–30 s WAV/MP3;
  `ffmpeg in.wav -ar 24000 -ac 1 cleaned.wav` to normalize first.
