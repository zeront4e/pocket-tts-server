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

## Test the build locally

`test-image.sh` is a local, non-destructive smoke test: it builds the **same** image as
`create-image.sh` (models baked in, `BUNDLE_MODELS=1`) but with **no git tag and no push**,
then runs the container and asserts it behaves correctly. Use it to verify a build before
triggering the pushing GitHub Actions workflow.

### Quick start

```bash
./image-data/test-image.sh                  # build + run + full test (de + en /tts)
./image-data/test-image.sh --skip-tts       # fast: skip the (slow) /tts generation step
```

A passing run prints a `PASS:` line for each check and ends with `RESULT: PASSED` (exit 0):

```text
==> Smoke tests
  [config]
    PASS: mode (=local)
    PASS: voice_cloning (=false)
  [clone endpoint]
    PASS: POST /voices/clone status (=451)
==> Waiting for the models to load (status=healthy, up to 900s)
  [TTS de]
    PASS: status (=200)
    PASS: content-type (contains audio/)
    PASS: body is a WAV (RIFF) (=RIFF)
      63404 bytes
  [TTS en]
    PASS: status (=200)
    PASS: content-type (contains audio/)
    PASS: body is a WAV (RIFF) (=RIFF)
      59564 bytes

==> RESULT: PASSED
    image: pocket-tts-server:test
```

On any failure it prints the failing `FAIL:` line(s), dumps the last 60 lines of the
container logs, and exits non-zero.

### What it checks

1. The container starts and `/health` answers.
2. `/health` reports `mode: local` (models baked in, not Hugging Face download) and the
   expected `voice_cloning` value.
3. `POST /voices/clone` returns `451` when cloning is off (the default) — or `400` when it
   is on (the endpoint is live, so the request reaches validation).
4. (unless `--skip-tts`) `POST /tts` returns real audio for **both** the German and English
   models: status `200`, an `audio/*` content type, and a valid `RIFF` WAV body.

### Options

| Flag / env | Default | Effect |
| --- | --- | --- |
| `--skip-tts` | off | Skip the `/tts` generation checks (no model-load wait); config/clone-only |
| `--enable-voice-cloning` | off | Run with `VOICE_CLONING=1` and assert cloning is on (clone → `400`) |
| `--keep` | off | Leave the container running afterwards instead of removing it |
| `--port <p>` / `PORT` | `3001` | Host port to expose |
| `--image <name>` / `IMAGE` | `pocket-tts-server` | Local image name |
| `--tag <tag>` / `TAG` | `test` | Local image tag |
| `--platform <p>` / `PLATFORM` | host arch | Target platform (a multi-arch list is not supported with `--load`) |
| `--no-cache` / `NO_CACHE=1` | off | Build with `--no-cache` (forces the ~0.9 GB model re-download) |
| `MODEL_DIR_DE` / `MODEL_DIR_EN` | `/app/models/de`, `/app/models/en` | Where to bake the models inside the image |
| `VOICE_CLONING` | `0` | Value passed to the container (`1`/`true`/`on` = on); same as `--enable-voice-cloning` |
| `START_TIMEOUT` / `HEALTH_TIMEOUT` | `120` / `900` | Seconds to wait for the HTTP server / for `status=healthy` |

The expensive part is the **first** build (it downloads ~0.9 GB of models into a cached
Docker layer); re-runs reuse the cache and are fast unless `--no-cache`. The container is
removed on exit (keep it with `--keep`), and the produced `${IMAGE}:${TAG}` image stays
locally (remove it with `docker rmi ${IMAGE}:${TAG}`).

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
