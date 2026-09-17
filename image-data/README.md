# Release image (bundled models)

`create-image.sh` cuts a versioned release of the PocketTTS Docker image: it tags the
current git commit, builds an image that **bakes in the German + English models**, and
(optionally) pushes both the git tag and the image to a container registry (GHCR by default).

## What the produced image contains

- **All the software:** Bun server + per-language Python sidecars + CPU-only PyTorch + the
  `pocket-tts` toolchain (the same runtime as the normal `Dockerfile`).
- **The (non-gated) models, baked in:** the German 24-layer (`german_24l`, ~672 MB) and
  English (~219 MB) models + tokenizers + built-in voice embeddings are downloaded from the
  ungated mirror [`lunahr/pocket-tts-ungated`](https://huggingface.co/lunahr/pocket-tts-ungated)
  **at build time** and stored under `/app/models/de` and `/app/models/en`. The image runs in
  **local mode**, so there is **no download at first start** — it works fully offline.
- **No voice cloning by default:** voice cloning is opt-in. The image ships **TTS-only**,
  `POST /voices/clone` returns `451 Unavailable For Legal Reasons` and the demo disables its
  clone controls unless you set `VOICE_CLONING=1` at runtime. This is what makes the image
  safe to publish publicly (no deepfake/voice-cloning capability out of the box).

> The models are the ungated mirror weights (no Hugging Face login required to download), so
> building needs no `HF_TOKEN`. Image size is ~2–3 GB (CPU PyTorch + ~0.9 GB of models).

## Release flow

1. `version` = `VERSION` (if set) → else the `"version"` field of `package.json`.
2. A git tag `${TAG_PREFIX}${version}` (prefix defaults to none) is created/moved to `HEAD`
   and pushed (when `PUSH=1`).
3. The image is built with `--build-arg BUNDLE_MODELS=1 --build-arg MODEL_DIR=… --build-arg
   MODEL_DIR_EN=…` and tagged `${IMAGE}:${version}` + `${IMAGE}:latest`.
4. When `PUSH=1`, `${registry}:${version}` and `${registry}:latest` are pushed.

Registry resolution (first that is set): `GHCR_REPO` → `REPO` → `ghcr.io/<GITHUB_REPOSITORY>`
→ derived from the git `origin` remote (GitHub ⇒ `ghcr.io/<owner>/<repo>`), lowercased.

## Run it locally

```bash
# 1) Log in to the registry (GHCR: a PAT with the `write:packages` scope)
docker login ghcr.io

# 2) Tag + build locally only (no push)
./image-data/create-image.sh

# 3) Tag + build + push the git tag and the image
PUSH=1 ./image-data/create-image.sh
#    or, to target a specific registry:
PUSH=1 GHCR_REPO=ghcr.io/<you>/pocket-tts ./image-data/create-image.sh
```

Useful overrides: `VERSION=2.0.0` (ignore package.json), `TAG_PREFIX=v` (tag `v1.0.0`),
`IMAGE=my-image`, `PLATFORM=linux/amd64` (or a comma list for multi-arch), `--no-cache`.

## Trigger from GitHub Actions

`.github/workflows/image-release.yml` is a **manual** (`workflow_dispatch`) workflow: click
*Actions → Image release → Run workflow* (optionally supply a `version` and whether to
`push`). It checks out the code, sets up Docker Buildx, logs in to GHCR with the default
`GITHUB_TOKEN`, and runs this script with `PUSH=1`. The workflow has `contents: write`
(push the git tag) and `packages: write` (push the image) permissions.

## Enabling voice cloning in the image

The image is TTS-only by default. To use voice cloning on a deployment:

```bash
docker run -d --name pocket-tts -p 3001:3001 -v pocket-tts-data:/data \
  -e VOICE_CLONING=1 \
  ghcr.io/<you>/pocket-tts:latest
```

`VOICE_CLONING=1` (or `true`/`on`) re-enables `POST /voices/clone` and the demo controls.
`POST /voices/import` (uploading an existing `.safetensors`) is unaffected and works either way.
