// IMPORTANT: this spec is maintained by hand. Whenever a route is added or
// changed in src/routes/*, update BOTH this spec and the endpoint list in the
// 404 handler in src/server.ts.

export function openapiSpec() {
  return {
    openapi: "3.0.3",
    info: {
      title: "PocketTTS Server API",
      version: "2.0.0",
      description:
        "Bun server proxying PocketTTS (Kyutai) Python sidecars, one per language, each holding " +
        "its model in memory: German 24-layer (`de`) and English (`en`). Set the `lang` field " +
        "('de' | 'en') on any request to choose the language; omitting it uses the server default " +
        "(DEFAULT_LANGUAGE env var, default 'de'). Switching is instant, both models stay loaded " +
        "and warmed up, the server just routes to the matching sidecar. " +
        "24 kHz mono output (WAV by default, or Ogg/Opus via the per-request `format` field), " +
        "voice cloning, streaming. " +
        "Output is post-processed by default (postprocess=auto): each generated chunk is " +
        "cleaned up on the fly by a numpy/scipy pipeline in the sidecar (leading cold-start " +
        "click removed, noise tails denoised/gated, loudness kept consistent) and streamed " +
        "as soon as it is generated (postprocess=off returns the raw model output). " +
         "Opus output is encoded in the sidecar with libopus (native 24 kHz) at a per-request " +
        "bitrate (default 32 kbps). Optional intentional effects (reverb, echo, EQ, ...) are " +
         "supported per request. Model files come from Hugging Face by default, or fully locally " +
         "via the MODEL_DIR / MODEL_DIR_EN env vars (one per language, see the project README for " +
         "details). Both sidecars are required: the server only starts once every language's " +
         "model is loaded. Note: the model has no " +
        "per-request speed parameter. The sampling temperature is set at startup via the TEMP env var.",
    },
    servers: [{ url: "/" }],
    tags: [
      { name: "tts", description: "Speech generation" },
      { name: "voices", description: "Voice list and cloning" },
      { name: "meta", description: "Health and documentation" },
    ],
    paths: {
      "/tts": {
        post: {
          tags: ["tts"],
          summary: "Generate full speech",
          description:
            "Renders the full audio in one response (WAV by default, or Ogg/Opus with format=opus). " +
            "May take several seconds for long text.",
          operationId: "ttsGenerate",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/TtsRequest" } },
            },
          },
          responses: {
            200: {
              description: "Generated audio (WAV or Ogg/Opus per the format field)",
              content: {
                "audio/wav": { schema: { type: "string", format: "binary" } },
                "audio/opus": { schema: { type: "string", format: "binary" } },
              },
            },
            400: { $ref: "#/components/responses/BadRequest" },
            502: { $ref: "#/components/responses/SidecarError" },
            503: { $ref: "#/components/responses/NotReady" },
          },
        },
      },
      "/tts/stream": {
        post: {
          tags: ["tts"],
          summary: "Generate streaming speech",
          description:
            "Same request as /tts, but the audio body is sent in chunks as it is generated " +
            "(Transfer-Encoding: chunked). First bytes arrive as soon as the first audio chunk is " +
            "decoded. NOTE: a streamed WAV carries a placeholder data size in its header (the total " +
            "size is not known while streaming, a property of all streamed WAV streams), do not rely " +
            "on the RIFF/data chunk sizes; the server-side header is never patched. The browser demo " +
            "plays the stream chunk-wise via Web Audio, ignoring the header sizes. Interrupt at any " +
            "time by aborting the request (closing the connection); the server stops generation at " +
            "the next chunk boundary. Chunks are small (~80 ms of audio each, one per decoded latent). " +
            "Post-processing (the default, postprocess=auto) is applied per chunk in the sidecar " +
            "(a few ms each), so processed audio streams from the very first chunk onward; " +
            "postprocess=off streams the raw model output. With format=opus the body is a streamed " +
            "Ogg/Opus: the OpusHead/OpusTags header pages are sent first, then the libopus encoder " +
            "flushes in ~1-second bursts (a PyAV/FFmpeg muxer property), so the client can start " +
            "decoding after the first burst; clips shorter than ~1s effectively flush at the end.",
          operationId: "ttsStream",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/TtsRequest" } },
            },
          },
          responses: {
            200: {
              description: "Streaming audio (chunked WAV or Ogg/Opus per the format field)",
              headers: {
                "X-Streaming": { schema: { type: "string", example: "true" } },
              },
              content: {
                "audio/wav": { schema: { type: "string", format: "binary" } },
                "audio/opus": { schema: { type: "string", format: "binary" } },
              },
            },
            400: { $ref: "#/components/responses/BadRequest" },
            502: { $ref: "#/components/responses/SidecarError" },
            503: { $ref: "#/components/responses/NotReady" },
          },
        },
      },
      "/voices": {
        get: {
          tags: ["voices"],
          summary: "List available voices",
          description:
            "Lists the voices usable with the given `lang` (built-ins for that language's model " +
            "plus its custom clones). Omit `lang` for the server default language.",
          operationId: "voicesList",
          parameters: [
            {
              name: "lang",
              in: "query",
              required: false,
              schema: { type: "string", enum: ["de", "en"] },
              description: "Language to list voices for (default: the server default language).",
            },
          ],
          responses: {
            200: {
              description: "Voice list",
              content: { "application/json": { schema: { $ref: "#/components/schemas/VoicesList" } } },
            },
            503: {
              description: "Language not configured on this server",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
          },
        },
        delete: {
          tags: ["voices"],
          summary: "Delete a cloned voice",
          description:
            "Deletes the .safetensors of a cloned voice from its language's directory (German: " +
            "VOICES_DIR/de/, English: VOICES_DIR/en/). Built-in voices are protected (403). The " +
            "voice disappears from GET /voices immediately.",
          operationId: "voicesDelete",
          parameters: [
            {
              name: "name",
              in: "query",
              required: true,
              schema: { type: "string", pattern: "^[a-zA-Z0-9_-]+$" },
              description: "Name of the cloned voice to delete.",
            },
            {
              name: "lang",
              in: "query",
              required: false,
              schema: { type: "string", enum: ["de", "en"] },
              description: "Language the clone belongs to (default: the server default language).",
            },
          ],
          responses: {
            200: {
              description: "Voice deleted",
              content: { "application/json": { schema: { $ref: "#/components/schemas/DeleteResult" } } },
            },
            400: { $ref: "#/components/responses/BadRequest" },
            403: {
              description: "Built-in voices cannot be deleted",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
            404: {
              description: "Voice not found",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
          },
        },
      },
      "/voices/import": {
        post: {
          tags: ["voices"],
          summary: "Import an existing voice model",
          description:
            "Uploads an existing .safetensors voice file (e.g. downloaded from another server via " +
            "/voices/download) and makes it available as a custom voice under the given name. The " +
             "file is validated as a .safetensors (header size + JSON header) before saving. " +
             "The optional `lang` field picks the language the voice belongs to (its model " +
             "architecture, a German-model voice does not work with the English model); it is " +
             "stored in the matching language directory. Importing a name that already exists " +
             "overwrites the previous voice. The sidecar does not need to be ready, the voice is " +
             "uploaded to it per request. Legal note: only import voices you have the rights to / " +
             "consent for.",
          operationId: "voicesImport",
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: { $ref: "#/components/schemas/ImportMultipartRequest" },
              },
            },
          },
          responses: {
            200: {
              description: "Voice imported",
              content: { "application/json": { schema: { $ref: "#/components/schemas/CloneResult" } } },
            },
            400: { $ref: "#/components/responses/BadRequest" },
          },
        },
      },
      "/voices/download": {
        get: {
          tags: ["voices"],
          summary: "Download a voice model file",
          description:
            "Returns the voice's .safetensors embedding as an attachment (application/octet-stream). " +
            "Custom voices are always downloadable; built-in voices only in local mode (MODEL_DIR set), " +
            "where their embedding files exist on disk. If both a built-in embedding and a same-named " +
            "clone exist, the built-in wins (same resolution as /tts).",
          operationId: "voicesDownload",
          parameters: [
            {
              name: "name",
              in: "query",
              required: true,
              schema: { type: "string", pattern: "^[a-zA-Z0-9_-]+$" },
              description: "Name of the voice whose model file to download.",
            },
            {
              name: "lang",
              in: "query",
              required: false,
              schema: { type: "string", enum: ["de", "en"] },
              description: "Language the voice belongs to (default: the server default language).",
            },
          ],
          responses: {
            200: {
              description: "Voice model file",
              headers: {
                "Content-Disposition": { schema: { type: "string", example: 'attachment; filename="my_voice.safetensors"' } },
              },
              content: {
                "application/octet-stream": { schema: { type: "string", format: "binary" } },
              },
            },
            400: { $ref: "#/components/responses/BadRequest" },
            404: {
              description: "Voice has no local model file",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
          },
        },
      },
      "/voices/clone": {
        post: {
          tags: ["voices"],
          summary: "Clone a voice from a reference recording",
          description:
            "Creates a voice clone (.safetensors) from 5-30 s of clean solo speech. The reference " +
             "recording is uploaded as the multipart form field `audio` (works from any client, " +
             "used by the browser demo). Server-side file paths are NOT supported, the audio bytes " +
             "must be in the request. Cloning takes ~30-60 s. The optional `lang` field picks the " +
             "language the clone is made for (German 24-layer model or English model, clones are " +
             "architecture-specific and only work with the language they were created for); the " +
             "clone is stored in that language's directory. " +
             "Legal note: only clone voices you have the rights to / consent for.",
          operationId: "voicesClone",
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: { $ref: "#/components/schemas/CloneMultipartRequest" },
              },
            },
          },
          responses: {
            200: {
              description: "Clone created",
              content: { "application/json": { schema: { $ref: "#/components/schemas/CloneResult" } } },
            },
            400: { $ref: "#/components/responses/BadRequest" },
            500: { $ref: "#/components/responses/BadRequest" },
            503: { $ref: "#/components/responses/NotReady" },
          },
        },
      },
      "/health": {
        get: {
          tags: ["meta"],
          summary: "Health check",
          operationId: "health",
          responses: {
            200: {
              description: "Server and sidecar status",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Health" } } },
            },
          },
        },
      },
      "/openapi.json": {
        get: {
          tags: ["meta"],
          summary: "This OpenAPI document",
          operationId: "openapi",
          responses: {
            200: {
              description: "OpenAPI 3 document",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        TtsRequest: {
          type: "object",
          required: ["text"],
          properties: {
            text: {
              type: "string",
              description:
                "Text to synthesize. Write it in the language selected via `lang`, the German " +
                "model speaks German, the English model speaks English.",
            },
            lang: {
              type: "string",
              enum: ["de", "en"],
              description:
                "Language of the speech: 'de' (German 24-layer model, default voice juergen) or " +
                "'en' (English model, default voice alba). 'german'/'english' are accepted as " +
                "aliases. Omit for the server default (DEFAULT_LANGUAGE env var, default 'de'). " +
                "Each language runs on its own sidecar with the model kept in memory, so switching " +
                "costs nothing. Cloned voices are language-specific (a 'de' clone does not work " +
                "with 'en').",
              example: "de",
            },
            voice: {
              type: "string",
              description:
                "Built-in voice name or name of a clone in VOICES_DIR (clones live in the language " +
                "subdir: German in VOICES_DIR/de/, English in VOICES_DIR/en/). Omit for the " +
                "language's default voice (juergen for de, alba for en). Unknown names yield a 400.",
              example: "juergen",
            },
            postprocess: {
              type: "string",
              enum: ["auto", "full", "off"],
              default: "auto",
              description:
                "Output post-processing, applied per generated chunk (audio still streams as it is " +
                "generated). 'auto' (default): declick, adaptive level, and per-chunk Wiener denoise + " +
                "online tail gate where artifacts are detected; 'full': always denoise + tail gate; " +
                "'off': raw model output, no cleanup/normalization. The server-wide default can be " +
                "changed with the POSTPROCESS env var.",
            },
            effects: { $ref: "#/components/schemas/Effects" },
            format: {
              type: "string",
              enum: ["wav", "opus"],
              default: "wav",
              description:
                "Output container. 'wav' (default) is 16-bit PCM WAV at 24 kHz. 'opus' is Ogg/Opus " +
                "encoded in the sidecar with libopus at the native 24 kHz rate (decodes to 48 kHz, " +
                "the Opus standard). The server-wide default can be changed with the OUTPUT_FORMAT " +
                "env var; this field always wins.",
            },
            bitrate: {
              type: "integer",
              minimum: 6,
              maximum: 510,
              default: 32,
              description:
                "Opus bitrate in kbps, only used when format=opus (ignored for wav). Range 6..510, " +
                "default 32 (clamped to the codec's valid range). The server-wide default can be " +
                "changed with the OPUS_BITRATE env var; this field always wins.",
            },
          },
        },
        CloneMultipartRequest: {
          type: "object",
          required: ["name", "audio"],
          properties: {
            name: {
              type: "string",
              pattern: "^[a-zA-Z0-9_-]+$",
              description: "Name for the new voice (alphanumeric, hyphen, underscore).",
            },
            audio: { type: "string", format: "binary", description: "WAV or MP3 reference recording (5-30 s)." },
            lang: {
              type: "string",
              enum: ["de", "en"],
              description:
                "Language the clone is made for (default: the server default language). Clones are " +
                "model-architecture-specific: a 'de' clone only works with lang='de'.",
            },
          },
        },
        CloneResult: {
          type: "object",
          required: ["voice_name", "path", "message"],
          properties: {
            voice_name: { type: "string", description: "The name the clone was created under." },
            language: { type: "string", description: "The language the clone was created for." },
            path: { type: "string", description: "Where the .safetensors was stored." },
            message: {
              type: "string",
              example: 'Voice "meine_stimme" cloned for language "de". Use it with: { "voice": "meine_stimme", "lang": "de" }',
            },
          },
        },
        ImportMultipartRequest: {
          type: "object",
          required: ["name", "file"],
          properties: {
            name: {
              type: "string",
              pattern: "^[a-zA-Z0-9_-]+$",
              description: "Name for the imported voice (alphanumeric, hyphen, underscore).",
            },
            file: {
              type: "string",
              format: "binary",
              description: "A .safetensors voice file (existing voice model).",
            },
            lang: {
              type: "string",
              enum: ["de", "en"],
              description:
                "Language the voice belongs to (default: the server default language). Must match " +
                "the model the .safetensors was created with.",
            },
          },
        },
        DeleteResult: {
          type: "object",
          required: ["voice_name", "deleted", "message"],
          properties: {
            voice_name: { type: "string", description: "Name of the deleted voice." },
            deleted: { type: "boolean" },
            message: { type: "string", example: 'Voice "my_voice" deleted.' },
          },
        },
        Voice: {
          type: "object",
          required: ["name", "type"],
          properties: {
            name: { type: "string", description: "Use this value in the `voice` request field." },
            type: { type: "string", enum: ["builtin", "custom"] },
            language: {
              type: "string",
              description:
                "For built-in voices: the persona's native language (informational, every " +
                "built-in voice exists in every language). For custom voices: the language the " +
                "clone was created for (use the matching `lang` when synthesizing).",
            },
            path: { type: "string", description: "Only present for custom voices." },
          },
        },
        VoicesList: {
          type: "object",
          required: ["mode", "language", "voices"],
          properties: {
            mode: { type: "string", enum: ["huggingface", "local"], description: "Where model files are loaded from." },
            language: { type: "string", enum: ["de", "en"], description: "The language this list is for." },
            voices: { type: "array", items: { $ref: "#/components/schemas/Voice" } },
          },
        },
        Effects: {
          description:
            "Optional intentional audio effects, applied after cleanup/normalization. Either a " +
            "preset name (EffectPreset) or an ordered list of effect objects (EffectList) applied " +
            "in the given order. Omit (or use 'none') for no effects.",
          oneOf: [
            { $ref: "#/components/schemas/EffectPreset" },
            { $ref: "#/components/schemas/EffectList" },
          ],
        },
        EffectPreset: {
          type: "string",
          enum: ["cathedral", "broadcast", "phone", "robot", "none"],
          description:
            "Preset name (case-sensitive): cathedral (reverb), broadcast (radio chain), phone " +
            "(bandpass), robot (bitcrush + EQ), none (no effects).",
          example: "cathedral",
        },
        EffectList: {
          type: "array",
          description: "Ordered list of effect objects; each element is one Effect, applied in order.",
          items: { $ref: "#/components/schemas/Effect" },
          example: [
            { type: "reverb", wet: 0.4 },
            { type: "eq", freq: 3000, gain_db: 2, kind: "peaking" },
          ],
        },
        Effect: {
          description:
            "One audio effect. Exactly one of the models below applies; 'type' selects the effect " +
            "and is fixed per model. All parameter fields are optional (defaults shown). Unknown " +
            "types or parameters yield a 400.",
          oneOf: [
            { $ref: "#/components/schemas/ReverbEffect" },
            { $ref: "#/components/schemas/EchoEffect" },
            { $ref: "#/components/schemas/EqEffect" },
            { $ref: "#/components/schemas/HighpassEffect" },
            { $ref: "#/components/schemas/LowpassEffect" },
            { $ref: "#/components/schemas/CompressorEffect" },
            { $ref: "#/components/schemas/FadeEffect" },
            { $ref: "#/components/schemas/BitcrushEffect" },
          ],
        },
        ReverbEffect: {
          type: "object",
          required: ["type"],
          description: "Reverb (Schroeder-style).",
          properties: {
            type: { type: "string", const: "reverb" },
            wet: { type: "number", minimum: 0, maximum: 1, default: 0.3, description: "Wet mix, 0–1." },
            size: { type: "number", minimum: 0, maximum: 1, default: 0.5, description: "Virtual room size, 0–1." },
          },
          example: { type: "reverb", wet: 0.55, size: 0.9 },
        },
        EchoEffect: {
          type: "object",
          required: ["type"],
          description: "Delayed feedback echo.",
          properties: {
            type: { type: "string", const: "echo" },
            delay_ms: { type: "number", minimum: 1, default: 250, description: "Echo delay in milliseconds." },
            feedback: { type: "number", minimum: 0, maximum: 0.9, default: 0.4, description: "Feedback per echo, 0–0.9." },
            mix: { type: "number", minimum: 0, maximum: 1, default: 0.3, description: "Echo level, 0–1." },
          },
          example: { type: "echo", delay_ms: 300, feedback: 0.3, mix: 0.4 },
        },
        EqEffect: {
          type: "object",
          required: ["type"],
          description: "Parametric / shelf EQ (biquad).",
          properties: {
            type: { type: "string", const: "eq" },
            freq: { type: "number", minimum: 20, maximum: 12000, default: 1000, description: "Center (peaking) or shelf frequency in Hz." },
            gain_db: { type: "number", default: 0, description: "Gain in dB." },
            q: { type: "number", minimum: 0.1, default: 1, description: "Bandwidth (peaking only)." },
            kind: { type: "string", enum: ["peaking", "lowshelf", "highshelf"], default: "peaking" },
          },
          example: { type: "eq", freq: 3000, gain_db: 2, q: 0.8, kind: "peaking" },
        },
        HighpassEffect: {
          type: "object",
          required: ["type"],
          description: "High-pass filter.",
          properties: {
            type: { type: "string", const: "highpass" },
            freq: { type: "number", minimum: 20, maximum: 12000, default: 80, description: "Cutoff frequency in Hz." },
          },
          example: { type: "highpass", freq: 300 },
        },
        LowpassEffect: {
          type: "object",
          required: ["type"],
          description: "Low-pass filter.",
          properties: {
            type: { type: "string", const: "lowpass" },
            freq: { type: "number", minimum: 20, maximum: 12000, default: 8000, description: "Cutoff frequency in Hz." },
          },
          example: { type: "lowpass", freq: 3400 },
        },
        CompressorEffect: {
          type: "object",
          required: ["type"],
          description: "Threshold/ratio compressor.",
          properties: {
            type: { type: "string", const: "compressor" },
            threshold_db: { type: "number", default: -18, description: "Compression threshold in dB." },
            ratio: { type: "number", minimum: 1, default: 3, description: "Compression ratio (1 = no compression)." },
            attack_ms: { type: "number", minimum: 0, default: 1, description: "Attack time in milliseconds." },
            release_ms: { type: "number", minimum: 1, default: 100, description: "Release time in milliseconds." },
          },
          example: { type: "compressor", threshold_db: -18, ratio: 3.5 },
        },
        FadeEffect: {
          type: "object",
          required: ["type"],
          description: "Attack/release fade over the whole clip.",
          properties: {
            type: { type: "string", const: "fade" },
            attack_ms: { type: "number", minimum: 0, default: 50, description: "Fade-in in milliseconds." },
            release_ms: { type: "number", minimum: 0, default: 200, description: "Fade-out in milliseconds." },
          },
          example: { type: "fade", attack_ms: 100, release_ms: 300 },
        },
        BitcrushEffect: {
          type: "object",
          required: ["type"],
          description: "Bit-depth reduction (lo-fi).",
          properties: {
            type: { type: "string", const: "bitcrush" },
            bits: { type: "integer", minimum: 4, maximum: 15, default: 12, description: "Bit depth, 4–15." },
          },
          example: { type: "bitcrush", bits: 10 },
        },
        Health: {
          type: "object",
          required: ["status", "sidecar", "mode", "model_dir", "voices_dir", "temperature", "quantized", "default_language", "languages", "timestamp"],
          properties: {
            status: { type: "string", enum: ["healthy", "degraded"] },
            sidecar: { type: "boolean", description: "True once every language's sidecar is ready (backwards-compatible)." },
            mode: { type: "string", enum: ["huggingface", "local"] },
            model_dir: { type: ["string", "null"], description: "MODEL_DIR (German) when in local mode, else null." },
            model_dir_en: { type: ["string", "null"], description: "MODEL_DIR_EN (English) when set, else null." },
            voices_dir: { type: "string" },
            temperature: { type: "number", description: "Sampling temperature (TEMP env var)." },
            quantized: { type: "boolean", description: "int8 quantization enabled (QUANTIZE env var)." },
            default_language: { type: "string", enum: ["de", "en"], description: "Language used when a request omits `lang` (DEFAULT_LANGUAGE env var)." },
            languages: {
              type: "object",
              description: "Per-language sidecar status.",
              properties: {
                de: { $ref: "#/components/schemas/LanguageStatus" },
                en: { $ref: "#/components/schemas/LanguageStatus" },
              },
            },
            timestamp: { type: "string", format: "date-time" },
          },
        },
        LanguageStatus: {
          type: "object",
          required: ["available", "ready", "model_dir"],
          properties: {
            available: { type: "boolean", description: "True when the language's model files are configured (always true in HF mode)." },
            ready: { type: "boolean", description: "True once this language's sidecar has loaded the model and is warm." },
            model_dir: { type: ["string", "null"], description: "The language's MODEL_DIR in local mode, else null." },
          },
        },
        Error: {
          type: "object",
          required: ["error"],
          properties: { error: { type: "string", description: "Human-readable error message." } },
        },
      },
      responses: {
        BadRequest: {
          description: "Invalid request",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
        SidecarError: {
          description: "Sidecar returned an error",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
        NotReady: {
          description: "TTS sidecar not ready yet",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
      },
    },
  };
}
