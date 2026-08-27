# syntax=docker/dockerfile:1

# PocketTTS server (Bun) + per-language PocketTTS Python sidecars (de + en) —
# CPU inference.
#
# The models are intentionally NOT baked into the image (keeps it minimal).
#   1. "huggingface" mode (default): first start downloads both models + voices
#      (~900 MB) into $HF_HOME (/data/hf) and caches them in your volume.
#   2. "local" mode: set MODEL_DIR / MODEL_DIR_EN to directories containing
#      model.safetensors, tokenizer.model, embeddings/ (see docker-compose.yml).

ARG BUN_VERSION=1.3.14
ARG BUN_ARCH=x64 # or: aarch64
ARG UV_VERSION=0.12.5
ARG PYTHON_VERSION=3.12
ARG TORCH_VERSION=2.13.0+cpu
ARG POCKET_TTS_VERSION=2.1.0

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# tini: proper PID 1, forwards signals and reaps orphaned sidecar processes
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini unzip \
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

# --- runtime configuration (all overridable via docker-compose.yml)
ENV HOME=/home/tts \
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
# downloads both models (~900 MB total).
HEALTHCHECK --interval=30s --timeout=10s --start-period=900s --retries=3 \
    CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3001) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

ENTRYPOINT ["tini", "--", "bun", "run", "src/index.ts"]
