# syntax=docker/dockerfile:1

# PocketTTS server (Bun) + per-language PocketTTS Python sidecars (de + en) —
# CPU inference.
#
# Model source (three ways):
#   1. "huggingface" mode (default, BUNDLE_MODELS unset): first start downloads
#      both models + voices (~1 GB) into $HF_HOME (/data/hf) and caches them in
#      your volume.
#   2. "local" mode: set MODEL_DIR / MODEL_DIR_EN to directories containing
#      model.safetensors, tokenizer.model, embeddings/ (see docker-compose.yml).
#   3. "bundled" mode: build with --build-arg BUNDLE_MODELS=1 --build-arg
#      MODEL_DIR=/app/models/de --build-arg MODEL_DIR_EN=/app/models/en to bake
#      the ungated de+en models into the image (local mode, no runtime download).
#
# Voice cloning is opt-in (VOICE_CLONING=1); the public image ships TTS-only.

ARG BUN_VERSION=1.3.14
ARG BUN_ARCH=x64 # or: aarch64
ARG UV_VERSION=0.12.5
ARG PYTHON_VERSION=3.12
ARG TORCH_VERSION=2.13.0+cpu
ARG POCKET_TTS_VERSION=2.1.0

# BUNDLE_MODELS=1 bakes the German + English models into the image (local mode,
# no runtime download). When set, MODEL_DIR / MODEL_DIR_EN are applied so the
# sidecars load the baked models. Leave both MODEL_DIR* empty for the default
# Hugging Face download-on-first-run behavior. Voice cloning stays off unless
# VOICE_CLONING=1 (opt-in, see config.ts).
ARG BUNDLE_MODELS=0
ARG MODEL_DIR=""
ARG MODEL_DIR_EN=""

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# tini: proper PID 1, forwards signals and reaps orphaned sidecar processes
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl tini unzip \
    && rm -rf /var/lib/apt/lists/*

# --- toolchains, installed world-readable into /usr/local/bin
ARG BUN_VERSION
ARG BUN_ARCH
RUN curl -fsSL -o /tmp/bun.zip \
        "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${BUN_ARCH}.zip" \
    && unzip -j -o /tmp/bun.zip -d /usr/local/bin \
    && rm /tmp/bun.zip \
    && chmod +x /usr/local/bin/bun \
    && bun --version

ARG UV_VERSION
RUN curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | sh \
    && mv /root/.local/bin/uv /usr/local/bin/uv \
    && rm -rf /root/.local /root/.cargo \
    && uv --version

# --- non-root user + persistent data directories
RUN useradd --create-home --uid 1000 --shell /usr/sbin/nologin tts \
    && mkdir -p /app /data/voices /data/models /data/hf \
    && chown -R tts:tts /app /data
USER tts
WORKDIR /app

# --- Python sidecar environment: uv-managed CPython, CPU-only torch
#     (torch from the CPU index, no CUDA wheels, ~2 GB smaller)
ARG PYTHON_VERSION
ARG TORCH_VERSION
ARG POCKET_TTS_VERSION
RUN uv python install ${PYTHON_VERSION} \
    && uv venv .venv --python ${PYTHON_VERSION} \
    && uv pip install --python .venv/bin/python "torch==${TORCH_VERSION}" \
        --index-url https://download.pytorch.org/whl/cpu \
    && uv pip install --python .venv/bin/python \
        "pocket-tts==${POCKET_TTS_VERSION}" soundfile av \
    && uv cache clean

# --- application (runtime deps only; bun-types is a dev dependency)
COPY --chown=tts:tts package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --chown=tts:tts src/ ./src/
COPY --chown=tts:tts scripts/ ./scripts/
COPY --chown=tts:tts static/ ./static/
COPY --chown=tts:tts config/ ./config/

# --- optional: bake the (ungated) German + English models into the image -----
# Only runs when BUNDLE_MODELS=1. Downloads both language dirs from the ungated
# mirror (no HF token needed) and moves them into the MODEL_DIR / MODEL_DIR_EN
# build args, so the sidecars load them in local mode with zero runtime
# downloads. Voice cloning stays off unless VOICE_CLONING=1 (opt-in).
ARG BUNDLE_MODELS
ARG MODEL_DIR
ARG MODEL_DIR_EN
RUN if [ "${BUNDLE_MODELS}" = "1" ]; then \
    [ -n "${MODEL_DIR}" ] || { echo "BUNDLE_MODELS=1 requires MODEL_DIR to be set"; exit 1; }; \
    [ -n "${MODEL_DIR_EN}" ] || { echo "BUNDLE_MODELS=1 requires MODEL_DIR_EN to be set"; exit 1; }; \
    /app/.venv/bin/python -c 'from huggingface_hub import snapshot_download; snapshot_download(repo_id="lunahr/pocket-tts-ungated", local_dir="/app/models/_hf", allow_patterns=["languages/german_24l/*", "languages/english/*"]); print("downloaded lunahr/pocket-tts-ungated")' \
    && mkdir -p "$(dirname "${MODEL_DIR}")" "$(dirname "${MODEL_DIR_EN}")" \
    && mv /app/models/_hf/languages/german_24l "${MODEL_DIR}" \
    && mv /app/models/_hf/languages/english "${MODEL_DIR_EN}" \
    && rm -rf /app/models/_hf \
    && du -sh "${MODEL_DIR}" "${MODEL_DIR_EN}"; \
  fi

# --- runtime configuration (all overridable via docker-compose.yml)
# MODEL_DIR / MODEL_DIR_EN are empty by default (Hugging Face download-on-first
# run); BUNDLE_MODELS=1 + the build args point them at the baked models.
ENV HOME=/home/tts \
    MODEL_DIR="${MODEL_DIR}" \
    MODEL_DIR_EN="${MODEL_DIR_EN}" \
    PORT=3001 \
    SIDECAR_PORT=8081 \
    SIDECAR_PORT_EN=8082 \
    VOICES_DIR=/data/voices \
    CONFIG_PATH=/app/config/german_24l.yaml \
    CONFIG_PATH_EN=/app/config/english.yaml \
    DEFAULT_LANGUAGE=de \
    TEMP=0.7 \
    QUANTIZE=1 \
    HF_HOME=/data/hf \
    UV_PROJECT_ENVIRONMENT=/app/.venv

EXPOSE 3001

# Model load takes 20-60 s per language; the first start in HF mode also
# downloads both models + voices (~1 GB total). Both sidecars are required, so
# the server only reports healthy once every language's model is loaded.
HEALTHCHECK --interval=30s --timeout=10s --start-period=900s --retries=3 \
    CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3001) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

ENTRYPOINT ["tini", "--", "bun", "run", "src/index.ts"]
