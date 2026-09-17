#!/usr/bin/env bash
#
# create-image.sh — cut a versioned release of the PocketTTS Docker image.
#
# It:
#   1. Reads the version from package.json (or an override).
#   2. Creates (or moves) a git tag at HEAD and, when pushing, pushes it.
#   3. Builds a Docker image that BAKES IN the German + English models
#      (BUNDLE_MODELS=1 => local mode, no runtime download) and tags it with
#      the version + "latest".
#   4. When pushing, pushes the image to a container registry (GHCR by default).
#
# Voice cloning is OFF in the produced image (opt-in via VOICE_CLONING=1 at
# runtime), so the public image ships TTS-only. See README.md in this dir.
#
# Usage:
#   ./create-image.sh                       tag + build locally (no push)
#   PUSH=1 ./create-image.sh                tag + build + push git tag + image
#   ./create-image.sh --push                same as PUSH=1
#   VERSION=2.0.0 ./create-image.sh         override the package.json version
#   GHCR_REPO=ghcr.io/me/pocket-tts PUSH=1 ./create-image.sh
#
# Env (all optional):
#   VERSION      explicit version tag (default: "version" from package.json)
#   TAG_PREFIX   prefix for the git tag (default: none; e.g. "v" -> v1.0.0)
#   IMAGE        local image name (default: pocket-tts-server)
#   PUSH         1 to push the git tag + image (default: 0)
#   REPO / GHCR_REPO   registry to push to (default: derived, see below)
#   PLATFORM     target platform (e.g. linux/amd64, or a comma list)
#   MODEL_DIR_DE / MODEL_DIR_EN
#                where to bake the models inside the image
#                (default: /app/models/de, /app/models/en)
#
# Registry derivation (when REPO/GHCR_REPO unset): GITHUB_REPOSITORY
# (=> ghcr.io/<owner>/<repo>), else the git "origin" remote (GitHub =>
# ghcr.io/<owner>/<repo>), lowercased.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

IMAGE="pocket-tts-server"
PUSH="${PUSH:-0}"
PLATFORM=""
NO_CACHE=0
MODEL_DIR_DE="${MODEL_DIR_DE:-/app/models/de}"
MODEL_DIR_EN="${MODEL_DIR_EN:-/app/models/en}"

while [ $# -gt 0 ]; do
  case "$1" in
    --push)        PUSH=1; shift ;;
    --version)     VERSION="${2:?--version needs a value}"; shift 2 ;;
    --registry)    REPO="${2:?--registry needs a value}"; shift 2 ;;
    --tag-prefix)  TAG_PREFIX="${2:?--tag-prefix needs a value}"; shift 2 ;;
    --image)       IMAGE="${2:?--image needs a value}"; shift 2 ;;
    --platform)    PLATFORM="${2:?--platform needs a value}"; shift 2 ;;
    --no-cache)    NO_CACHE=1; shift ;;
    -h|--help)     sed -n '/^# create-image.sh/,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done

command -v docker >/dev/null 2>&1 || { echo "error: docker not found" >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "error: git not found" >&2; exit 1; }

# --- version ----------------------------------------------------------------
PKG="${REPO_ROOT}/package.json"
[ -f "${PKG}" ] || { echo "error: package.json not found at ${PKG}" >&2; exit 1; }

VERSION="${VERSION:-}"
if [ -z "${VERSION}" ]; then
  VERSION="$(python3 -c "import json; print(json.load(open('${PKG}'))['version'])" 2>/dev/null \
    || sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${PKG}" | head -n1)"
fi
[ -n "${VERSION}" ] || { echo "error: could not determine a version (package.json?)" >&2; exit 1; }

TAG_PREFIX="${TAG_PREFIX:-}"
TAG="${TAG_PREFIX}${VERSION}"

echo "==> Version: ${VERSION}   (git tag: ${TAG})"

# --- git tag ----------------------------------------------------------------
# Always (re)create the tag at HEAD so it points at the release commit.
git tag -d "${TAG}" >/dev/null 2>&1 || true
git tag "${TAG}"
echo "==> Created git tag ${TAG} at $(git rev-parse --short HEAD)"

if [ "${PUSH}" = 1 ]; then
  git push origin "${TAG}"
  echo "==> Pushed git tag ${TAG}"
fi

# --- docker build ------------------------------------------------------------
if docker buildx version >/dev/null 2>&1; then
  build=(docker buildx build --load)
else
  build=(docker build)
  echo "note: 'docker buildx' not found, using the legacy builder"
fi

build_args=(
  --build-arg BUNDLE_MODELS=1
  --build-arg MODEL_DIR="${MODEL_DIR_DE}"
  --build-arg MODEL_DIR_EN="${MODEL_DIR_EN}"
)
[ -n "${PLATFORM}" ] && build_args+=("--platform" "${PLATFORM}")
[ "${NO_CACHE}" = 1 ] && build_args+=("--no-cache")

echo "==> Building ${IMAGE}:${VERSION} (and ${IMAGE}:latest) with baked-in models"
"${build[@]}" \
  "${build_args[@]}" \
  -f "${REPO_ROOT}/Dockerfile" \
  -t "${IMAGE}:${VERSION}" \
  -t "${IMAGE}:latest" \
  "${REPO_ROOT}"

if [ "${PUSH}" != 1 ]; then
  echo "==> Done (local). Image: ${IMAGE}:${VERSION}"
  exit 0
fi

# --- push to registry --------------------------------------------------------
registry="${GHCR_REPO:-${REPO:-}}"
if [ -z "${registry}" ]; then
  if [ -n "${GITHUB_REPOSITORY:-}" ]; then
    registry="ghcr.io/${GITHUB_REPOSITORY}"
  else
    remote="$(git remote get-url origin 2>/dev/null || true)"
    if [ -n "${remote}" ]; then
      path="${remote#*://}"; path="${path#*:}"; path="${path%.git}"
      owner="${path%/*}"; name="${path##*/}"
      [ "${owner}" != "${path}" ] && registry="ghcr.io/${owner}/${name}"
    fi
  fi
fi
[ -n "${registry}" ] || { echo "error: no registry (set REPO/GHCR_REPO or git 'origin')" >&2; exit 1; }
registry="$(echo "${registry}" | tr '[:upper:]' '[:lower:]')"

echo "==> Pushing to ${registry}"
for t in "${VERSION}" latest; do
  docker tag "${IMAGE}:${t}" "${registry}:${t}"
  docker push "${registry}:${t}"
  echo "    pushed ${registry}:${t}"
done
echo "==> Done. Pulled with: docker pull ${registry}:${VERSION}"
