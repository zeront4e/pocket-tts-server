#!/usr/bin/env bash
set -euo pipefail

# docker-build.sh, build the PocketTTS Docker image locally, optionally push it
# to a container registry (e.g. GHCR). See README → "Docker".
#
# Usage:
#   ./docker-build.sh                         build pocket-tts-server:latest (+ :<version>)
#   ./docker-build.sh --tag name:ver          additionally tag the image as name:ver
#   ./docker-build.sh --platform linux/amd64  cross-build for another architecture
#   ./docker-build.sh --no-cache              bypass the build cache
#
# Pushing (log in first, e.g. `docker login ghcr.io` with a PAT that has the
# `write:packages` scope):
#   REPO=ghcr.io/<user>/pocket-tts ./docker-build.sh --push
#
# Env:
#   REPO     registry path to push to; default: derived from the `origin` git
#            remote (GitHub: ghcr.io/<owner>/<repo>, lowercased)
#   VERSION  explicit version tag (default: exact git tag of HEAD, else short commit sha)

IMAGE="pocket-tts-server"
extra_tag=""
platform=""
no_cache=0
push=0

while [ $# -gt 0 ]; do
  case "$1" in
    --tag)      extra_tag="${2:?--tag needs a value}"; shift 2 ;;
    --platform) platform="${2:?--platform needs a value}"; shift 2 ;;
    --no-cache) no_cache=1; shift ;;
    --push)     push=1; shift ;;
    -h|--help)  sed -n '/^# docker-build.sh/,/^IMAGE=/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done

command -v docker >/dev/null 2>&1 || { echo "error: docker not found" >&2; exit 1; }

if docker buildx version >/dev/null 2>&1; then
  build=(docker buildx build --load)
else
  build=(docker build)
  echo "note: 'docker buildx' not found, using the legacy builder"
fi

# version tag: $VERSION > exact git tag of HEAD > short commit sha > none
version="${VERSION:-}"
if [ -z "$version" ]; then
  version=$(git describe --tags --exact-match 2>/dev/null | sed 's/^v//' || true)
fi
if [ -z "$version" ]; then
  version=$(git rev-parse --short HEAD 2>/dev/null || true)
fi

args=()
[ -n "$platform" ] && args+=("--platform" "$platform")
[ "$no_cache" = 1 ] && args+=("--no-cache")
args+=(-t "$IMAGE:latest")
[ -n "$version" ] && args+=(-t "$IMAGE:$version")
[ -n "$extra_tag" ] && args+=(-t "$extra_tag")
args+=(".")

echo "==> Building ${IMAGE}:latest${version:+ (and ${IMAGE}:${version})}"
"${build[@]}" "${args[@]}"

if [ "$push" != 1 ]; then
  echo "==> Done. Run it with: docker compose up -d"
  exit 0
fi

# --- push -------------------------------------------------------------------
repo="${REPO:-}"
if [ -z "$repo" ]; then
  remote=$(git remote get-url origin 2>/dev/null || true)
  if [ -n "$remote" ]; then
    path="${remote#*://}"; path="${path#*:}"; path="${path%.git}"
    owner="${path%/*}"; name="${path##*/}"
    if [ "$owner" != "$path" ]; then
      repo="ghcr.io/$(echo "$owner/$name" | tr '[:upper:]' '[:lower:]')"
    fi
  fi
fi
[ -n "$repo" ] || { echo "error: no REPO set and no git 'origin' remote to derive one from" >&2; exit 1; }
repo=$(echo "$repo" | tr '[:upper:]' '[:lower:]')

echo "==> Pushing to $repo"
tags=(latest)
[ -n "$version" ] && tags+=("$version")
pushed=""
for t in "${tags[@]}"; do
  docker tag "$IMAGE:$t" "$repo:$t"
  docker push "$repo:$t"
  pushed+="$repo:$t "
done
echo "==> Pushed: $pushed"
