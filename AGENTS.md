# AGENTS.md

Bun + Python (PocketTTS) TTS server with runtime DE/EN language switching. Bun (port 3001)
proxies to ONE PocketTTS Python sidecar PER LANGUAGE: German (port 8081, `german_24l`
24-layer model) and English (port 8082, 6-layer model), both from the ungated mirror
`lunahr/pocket-tts-ungated` (CPU, int8-quantized), each holding its model in memory.
Requests carry a `lang` field (`de`/`en`; `german`/`english` aliases; default from the
`DEFAULT_LANGUAGE` env var, default `de`) and are routed to the matching sidecar —
switching languages is pure routing with no model reload, both models stay resident.

## Commands

```bash
bun run src/index.ts            # start server (spawns both sidecars in parallel, waits for BOTH model loads; exits if either sidecar fails)
bun run scripts/clone-voice.ts <ref.wav> [name] [--lang de|en]   # clone a voice -> voices/de/<name>.safetensors (de) or voices/en/<name>.safetensors (en)
bun test                        # run tests (none yet)
tsc --noEmit                    # typecheck (uses tsconfig.json; types from bun-types)
```

There is no linter configured. Test endpoints with curl against a running server (see README).

## API docs (keep in sync!)

- The OpenAPI 3 spec lives in `src/openapi.ts` and is **maintained by hand**.
- **Whenever an endpoint is added, renamed, or its request/response changes, update
  BOTH `src/openapi.ts` and the endpoint list in the 404 handler in `src/server.ts`.**
  Swagger UI is served self-hosted (vendored assets in `static/swagger/`, loaded by
  `src/routes/docs.ts`) at `GET /docs`; the spec is at `GET /openapi.json`.
- Do not add npm dependencies for docs; the Swagger UI assets in `static/swagger/`
  are vendored files.

## Conventions

- ESM TypeScript, `bun-types` only, no external TS/JS deps; keep it that way unless needed.
- Route handlers live in `src/routes/*.ts`, dispatched in `src/server.ts` (plain path+method
  match, no router). Add new routes there (and in `src/openapi.ts` + the 404 list).
- ONE Python sidecar per language is managed in `src/sidecar.ts` (`sidecars: Record<Lang, …>`,
  helpers take a `lang` argument: `sidecarUrl(lang, path)`, `isSidecarReady(lang)`,
  `startSidecars()`, `stopSidecars()`). Each is spawned as
  `uv run python scripts/sidecar_wrapper.py` (NOT `pocket-tts serve`) with its OWN `SIDECAR_PORT`
  and `CONFIG_PATH` env vars (the wrapper hardcodes reading those two names, that is how the
  same script serves two ports): the wrapper is needed because the stock CLI cannot set the
   sampling temperature. `startSidecars()` starts both in parallel and REQUIRES both sidecars:
   a failed or missing sidecar for ANY language (including an unavailable one, e.g. local mode
   with missing model files) is fatal, `index.ts` exits with the collected errors. Both
   languages are treated equally, there is no best-effort language. Requests still return 503
   (`langNotReadyError()` in routes/tts.ts, `isSidecarReady(lang)` / `isLanguageAvailable()` /
   `languageUnavailableError()` in config.ts) if a sidecar's process DIES after a successful
   startup (`ready` is reset on exit) — that is the only 503 path left at runtime. The wrapper sets
  `pocket_tts.main.tts_model = TTSModel.load_model(config=…, temp=…, quantize=…)` and serves
  the stock `pocket_tts.main:web_app` (same `/health` + `/tts`). The wrapper also REPLACES the
   stock `/tts` route with an interruptible variant: the stock endpoint keeps generating into
   an unbounded queue after client disconnect. The replacement polls `Request.is_disconnected()`
    and stops generation promptly: the response generator's `finally` sets the REQUEST's own
    `stop_event` (one `threading.Event` per request, never a shared global, because requests
    queue on `_GEN_LOCK` and a queued request's disconnect must not truncate the currently
    active request). The event is set on EVERY exit path, not only when the disconnect poll
    fires: a client that dies mid-stream closes the generator via GeneratorExit at the yield
    without the poll ever seeing it, and without the event the worker would spin forever in
    `_put_or_drop` on a dead queue while holding `_GEN_LOCK` (the wedged-sidecar bug). While a
    request holds the generation lock it registers its event as the module-global `_ACTIVE_STOP`,
    and a monkey-patch on the model's per-step `_run_flow_lm_and_increment_step` returns EOS at
    the NEXT LM step when `_ACTIVE_STOP` is set, so the LM loop unwinds within one step (~40 ms)
    instead of running to EOS in a background thread. Keep this stop-flag mechanism if the
    wrapper is touched, without it, interrupted requests
    leave orphan generation/decoder daemon threads mutating the shared model state (the
    wedged-sidecar / leaked-threads bug). `uv` location resolved in `src/utils.ts`.
    Note: the patched step short-circuits only AR steps (the per-sentence prompting phase
    always runs, ~30 LM steps ≈ 1.5 s), so when a worker acquires `_GEN_LOCK` it first checks
    its `stop_event`: a request whose client already died while queued skips generation
    entirely (no prompting, no AR, no rewind) and releases the lock immediately.
    **Serialization + in-place state:** the model is NOT thread-safe, so a global `_GEN_LOCK`
    serializes every generation end-to-end (including backpressure waits). Generation runs
    in-place on the resolved voice state (`copy_state=False`), no per-request 74 MB deep copy —
    and is rewound to its pristine prompt position by resetting every module's `offset` tensor
    back to `prompt_end` (the KV-cache prompt region `[0:prompt_end]` is never rewritten;
    attention only reads `[0:offset)`). The rewind happens (a) BEFORE every sentence chunk
    after the first, a monkey-patched `_generate_audio_stream_short_text` consults the
    module-global `_ACTIVE_PROMPT_END` (set under the lock in the worker) and resets the
    offsets, and (b) a final time when the request is done. (a) is NOT optional: stock
    PocketTTS deep-copies the pristine state per sentence chunk, and each chunk's AR loop
    starts with a NaN BOS that the model only knows from position `prompt_end`, continuing
    the 2nd+ chunk on the previous chunk's state (plain `copy_state=False`) makes the model
    emit EOS within 1-2 steps of every later chunk (early-EOS bug: long texts silently
    truncated to their first sentence chunk). A short quiescence poll waits for the model's
    internal threads to drain before the next generation may start.
   The replaced `/tts` accepts extra form fields: `postprocess` (`auto` default / `full` /
   `off`), `effects` (preset name or JSON array), `format` (`wav` default / `opus`) and
   `bitrate` (kbps, 6–510, default 32; opus only). It also accepts `voice_path` (absolute path to
   a local `.safetensors` voice state): the Bun server sends it for local voices instead of
   uploading the ~74 MB state as `voice_wav`, and the sidecar imports it once per
   `(path, mtime)` and keeps it in an in-memory `_STATE_CACHE` (bounded to 8 entries), this is
   what makes custom voices as fast as built-ins. `voice_wav` (raw audio clone) and `voice_url`
   are unchanged; providing more than one of `voice_url`/`voice_path`/`voice_wav` is a 400. When `postprocess != "off"` (or effects are
  set) every generated chunk (PocketTTS yields one per decoded latent, ~80 ms of audio) is run
  through `postproc.StreamingPostProcessor` on the worker thread (declick on the first chunk,
  Wiener denoise when `full`/inaudible, online tail gate, adaptive leveler, stateful effects,
  soft limit) and written into the same placeholder-header streaming WAV immediately, the
  first processed bytes reach the client after the FIRST CHUNK, not after the whole generation.
  `postprocess=off` keeps the original raw true-streaming path byte-for-byte. If post-processing
  throws, the sidecar falls back to the raw audio (never fails the request) and logs
   `postprocessing failed`. A `postprocess`/`effects` validation error returns 400 before
   generation starts.
    **Output format:** when `format=opus` the sidecar writes each chunk through
    `opusenc.OpusWriter` instead of the streaming WAV writer, the 24 kHz float PCM is fed
    DIRECTLY to libopus at its native 24 kHz rate (no resampling); the response `Content-Type`
    becomes `audio/opus` (the WAV path stays byte-for-byte unchanged). Encoding at 24 kHz keeps
    all bitrate in the 0–12 kHz speech band (the source has no content above 12 kHz); upsampled
    48 kHz encoding wastes bits on the empty upper band and causes quantization crackle at low
    bitrates. The decoder still outputs 48 kHz (Opus always decodes to 48 kHz). A `format`/
    `bitrate` validation error also returns 400 before generation starts. The Ogg muxer flushes
    ~1 s of media per `write()`, so `/tts/stream` + opus streams in ~1 s bursts (not the ~80 ms
    WAV granularity), a FFmpeg muxer property, NOT tunable via `av.open(..., buffer_size=...)`.
   **All DSP lives in `scripts/postproc.py` (pure numpy/scipy, no other Python deps).** It fixes
  cold-start artifacts (leading click in the first ~10 ms, inaudible output, noise tails) and
  implements the effects engine. Two twins with the same stages: `process()` (offline, full
  buffer; reference implementation) and `StreamingPostProcessor` (per generated chunk; what the
  sidecar uses, its docstring lists the deliberate differences: adaptive leveler instead of
  global normalize, online expander gate with 200 ms hangover, running quietest-window noise PSD,
  no fade release). Key invariants: custom OLA STFT/ISTFT (scipy's stft/istft do NOT round-trip
  with the params needed here, do not "fix" it), declick only touches the first 10 ms and only
  when the 10–50 ms region is quiet (or an isolated >0.5 spike), heavy path = Wiener (noise from
   the quietest 300 ms window) + tail gate, output is peak-normalized to 0.95.
    **Opus encoding lives in `scripts/opusenc.py`** (PyAV `av`, the only Python dep beyond
    pocket-tts/scipy/soundfile; installed by `setup.sh` + `Dockerfile`). `OpusWriter` takes
    24 kHz float32 mono PCM via `write_pcm_data()`, feeds it DIRECTLY to libopus at 24 kHz
    (480-sample / 20 ms frames, no resampling), and forwards container bytes to a `push(bytes)`
    callback (the sidecar feeds each write into the streaming response). `finalize()` is
    idempotent and pads/flushes the tail. Do NOT write raw codec packets to the file object —
    always go through the `av` container, which muxes the Ogg stream and writes OpusHead/OpusTags.
    Do NOT add resampling: encoding at the native 24 kHz rate keeps all bits in the speech band
    (0–12 kHz) and avoids the quantization crackle that upsampled 48 kHz encoding produces at low
    bitrates.
    After `waitForReady()` in `startSidecar(lang)`, `warmupModel(lang)` runs one throwaway `/tts`
  generation (that language's default voice, `postprocess=auto`) so the first real request hits a
  warm model (first takes are the worst for artifacts). Best-effort: failures only log a warning.
  It dynamically imports `routes/tts.js` (`resolveVoice`) to avoid a static import cycle
  (sidecar.ts ↔ routes/tts.ts), keep it dynamic.
  Do NOT call `pocket-tts` binaries directly from routes except for `export-voice` (cloning),
  which is spawned via `runUv()` in `src/routes/voices.ts` with the effective config path of
  the TARGET language (cloning never needs a running sidecar of that language).
- All env/config resolution goes through functions in `src/config.ts` (never read
  `Bun.env` at module top level, the effective config may be generated at startup).
  Everything model-related is PER LANGUAGE (`LANGUAGES` record in config.ts, keys `de`/`en`;
  the per-language values are `getModelDir(lang)`, `getConfigPath(lang)`, `getSidecarPort(lang)`,
  `isLocalMode(lang)`, `customVoiceDir(lang)`):
  - `MODEL_DIR` (de) / `MODEL_DIR_EN` (en) unset → **HF mode** for that language: model config
    is `CONFIG_PATH` / `CONFIG_PATH_EN` (hf:// URLs), built-in voices are passed to the sidecar
    as `voice_url: hf://lunahr/pocket-tts-ungated/<languageDir>/embeddings/<name>.safetensors`.
  - `MODEL_DIR` / `MODEL_DIR_EN` set → **local mode, no downloads** for that language:
    `getEffectiveConfigPath(lang)` copies the base config, points `weights_path` at
    `$MODEL_DIR*/model.safetensors` and the lookup table's `tokenizer_path` at
    `$MODEL_DIR*/tokenizer.model`, writes the result to `<cwd>/.cache/pocket-tts/pocket-tts-local-config[-en].yaml`,
    and passes that to the sidecar. Built-in voices then resolve to
    `$MODEL_DIR*/embeddings/<name>.safetensors` (sent as `voice_path`); a same-named clone in
    the language's custom-voice dir is the fallback. `GET /voices?lang=` hides built-ins whose
    local embedding file is missing.
  - Mixed setups work: each language resolves independently (e.g. DE local + EN HF).
    `isLanguageAvailable(lang)` = local model files exist (local mode) or HF mode.
- Voice names are resolved in `src/routes/tts.ts` `resolveVoice(voice, lang)`:
  - built-in names → HF URL for that language (HF mode) or local embedding file (local mode; see above)
   - custom names → local file in the language's custom-voice dir: `voices/de/` for de,
     `voices/en/` for en; sent to the sidecar as `voice_path`
  - **Clones are architecture-specific**: a German 24-layer clone only works with `lang: "de"`,
    an English clone only with `lang: "en"`. Never mix.
  - NEVER pass a bare voice name or `file://` URL to the sidecar `/tts`, `voice_url` only
    accepts `http(s)://`, `hf://`, or predefined voice names, and predefined names fail when
    the model was loaded via custom config (ValueError in sidecar).
- All config via env vars (`.env`): `PORT`, `SIDECAR_PORT` (de, 8081), `SIDECAR_PORT_EN`
  (en, 8082), `DEFAULT_LANGUAGE` (`de`/`en`, default `de`), `VOICES_DIR`, `CONFIG_PATH`,
  `CONFIG_PATH_EN` (default `./config/english.yaml`), `MODEL_DIR`, `MODEL_DIR_EN`, `TEMP`
  (sampling temperature / base diversity, startup only), `QUANTIZE` (int8, default on),
  `POSTPROCESS` (server-wide default for the `postprocess` param: `auto`/`full`/`off`, default
  `auto`; request-level value wins), `OUTPUT_FORMAT` (server-wide default for the `format` param:
  `wav`/`opus`, default `wav`) and `OPUS_BITRATE` (default Opus bitrate kbps, 6–510, default 32;
  request-level `bitrate` wins). NOTE: the PocketTTS model has **no per-request speed
  parameter**, do not invent one.
 - Request params `lang` + `postprocess` + `effects` + `format` + `bitrate` are accepted by
   `/tts` and `/tts/stream` (Bun validates lang/postprocess/format/bitrate; the sidecar
   validates effects and all of them). `lang` is `de`/`en` (aliases `german`/`english`,
   case-insensitive; missing/empty → `DEFAULT_LANGUAGE`; unknown → 400). The voice endpoints
   accept `lang` as a query param (`GET /voices`, `GET /voices/download`) or a form field
   (`clone`, `import`, `delete`); missing → `DEFAULT_LANGUAGE`. `effects` is a preset name (`cathedral`, `broadcast`, `phone`, `robot`, `none`) or a JSON
  array of `{type, ...}` objects; on the wire it is always a string (arrays are
  `JSON.stringify`ed into the multipart form field). `format` is `wav` (default) or `opus`;
  `bitrate` (kbps, 6–510) applies to opus. Effect types/params are documented in the
  OpenAPI spec and README.

## Gotchas

- Each sidecar's startup takes ~20–60 s (model load); both start in parallel and
  `waitForReady(lang)` polls its `/health`.
- Killing the server may leave the sidecars behind → `fuser -k 8081/tcp` and `fuser -k 8082/tcp`.
- `Bun.GlobDirectory` does not exist in Bun 1.3, use Node `fs.readdirSync`.
- Voice cloning from non-WAV audio (MP3 etc.) requires `soundfile` in `.venv`
  (optional PocketTTS dep); `setup.sh` installs it. WAV works without it.
- `format=opus` requires PyAV (`av`) in `.venv`, it provides the `libopus` encoder;
  `setup.sh` and the `Dockerfile` install it. WAV output works without it.
- `bun-types` 1.3 lacks `BunFile.textSync` / `Bun.writeSync`, use the async `text()` /
  `Bun.write()` (that's why `getEffectiveConfigPath()` is async).
- Do NOT use `os.tmpdir()`, Bun honours the `TEMP` env var (our temperature!) in it, which
  made it return `0.7`. The generated local config goes to `<cwd>/.cache/pocket-tts/` instead.
- Model/voices download on first run (~900 MB total for both languages) into
  `~/.cache/huggingface`, only for languages in HF mode. In local mode nothing is downloaded.
- German config sets `remove_semicolons: true`; model configs are `config/german_24l.yaml`
  (de) and `config/english.yaml` (en), both strict pydantic schema (every key in
  `pocket_tts/config/*.yaml` is validated, so the generated local config just overrides the
  two path fields of a valid config).
 - `/tts/stream` + `format=opus` streams in ~1 s bursts (Ogg muxer flush cadence), not the
  ~80 ms per-chunk WAV cadence, `av.open(..., buffer_size=...)` only changes the size of each
  `write()` call, not the cadence (see the `opusenc.py` notes above).
- `/tts/stream` WAV header carries a placeholder data size (PocketTTS streams via
  `StreamingWAVWriter` with `setnframes(1_000_000_000)`; total size unknown while streaming,
  header is never patched). Do NOT "fix" it by buffering the stream in the proxy, that kills
  streaming. The demo plays chunk-wise via Web Audio (parses the 44-byte header for the sample
  rate, feeds PCM to `AudioBufferSourceNode`s) precisely because a header with a false size
  cannot be played from a blob/file. `/tts` patches its header AFTER full buffering
   (`patchWavHeader` in `src/routes/tts.ts`). Post-processing (default `auto`/`full`) is applied
   per generated chunk (see wrapper notes above), so `/tts/stream` streams processed audio from
   the first chunk onward; `postprocess=off` streams the raw model output.
- Generating is NOT thread-safe model-wise: one in-flight generation per sidecar at a time in
  practice; aborts stop at the next chunk boundary (see wrapper notes above).
- `Bun.serve` runs with `idleTimeout: 255` (src/server.ts; 255 s is Bun's maximum —
  the option is a uint8): a `/tts/stream` request QUEUED behind other serialized
  generations sends no body bytes while it waits, and the default 10 s idle timeout
  used to kill those sockets mid-request. Do not lower it below realistic queue waits.
- The `TEMP` env var only applies at sidecar startup; changing it requires a restart.
