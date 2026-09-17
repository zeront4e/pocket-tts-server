#!/usr/bin/env bash
#
# Copyright 2026 zeront4e (https://github.com/zeront4e)
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#    http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#

#
# test-image.sh — build + run + smoke-test the bundled-models image, locally.
#
# A throwaway version of create-image.sh for local verification: it builds the
# EXACT same image create-image.sh produces (BUNDLE_MODELS=1, the German +
# English models baked in, no runtime download) but WITHOUT touching git (no
# tag) and WITHOUT pushing. It then runs the container and smoke-tests it:
#
#   * /health reports mode = "local" and the expected voice_cloning state
#   * POST /voices/clone returns 451 when cloning is off (or 400 when on)
#   * (unless --skip-tts) POST /tts actually synthesizes audio for BOTH the
#     baked German and English models
#
# The container is removed on exit (keep it with --keep). Nothing is pushed and
# no git tag is created. The expensive part is the build (the ~0.9 GB model
# download is a cached Docker layer, so re-runs are fast unless --no-cache).
#
# Usage:
#   ./test-image.sh                       build + run + test (cloning off, runs /tts)
#   ./test-image.sh --skip-tts            fast check: skip the (slow) /tts generation
#   ./test-image.sh --enable-voice-cloning   run with VOICE_CLONING=1, assert clone=400
#   ./test-image.sh --keep                leave the container running afterwards
#   ./test-image.sh --port 4000           expose on a different host port
#
# Env (all optional):
#   IMAGE          local image name (default: pocket-tts-server)
#   TAG            image tag (default: test)
#   PORT           host port to expose (default: 3001)
#   VOICE_CLONING  value passed to the container (default: 0; "1"/"true"/"on" = on)
#   MODEL_DIR_DE / MODEL_DIR_EN  where to bake the models (default: /app/models/de, /app/models/en)
#   PLATFORM       target platform (default: host; a multi-arch list is not supported with --load)
#   START_TIMEOUT  seconds to wait for the HTTP server to come up (default: 120)
#   HEALTH_TIMEOUT seconds to wait for the models to load / status=healthy (default: 900)
#   NO_CACHE=1     build with --no-cache

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

IMAGE="pocket-tts-server"
TAG="test"
PORT="3001"
VOICE_CLONING="${VOICE_CLONING:-0}"
PLATFORM=""
NO_CACHE=0
SKIP_TTS=0
KEEP=0
MODEL_DIR_DE="${MODEL_DIR_DE:-/app/models/de}"
MODEL_DIR_EN="${MODEL_DIR_EN:-/app/models/en}"
START_TIMEOUT="${START_TIMEOUT:-120}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-900}"

CONTAINER="pocket-tts-test-$$"
TMP_AUDIO="$(mktemp)"
FAILURES=0
HAVE_PY=0
command -v python3 >/dev/null 2>&1 && HAVE_PY=1

cleanup() {
  rm -f "${TMP_AUDIO}" 2>/dev/null || true
  if [ "${KEEP}" != 1 ]; then
    docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

while [ $# -gt 0 ]; do
  case "$1" in
    --port)                  PORT="${2:?--port needs a value}"; shift 2 ;;
    --image)                 IMAGE="${2:?--image needs a value}"; shift 2 ;;
    --tag)                   TAG="${2:?--tag needs a value}"; shift 2 ;;
    --platform)              PLATFORM="${2:?--platform needs a value}"; shift 2 ;;
    --enable-voice-cloning)  VOICE_CLONING=1; shift ;;
    --skip-tts)              SKIP_TTS=1; shift ;;
    --keep)                  KEEP=1; shift ;;
    --no-cache)              NO_CACHE=1; shift ;;
    -h|--help)               sed -n '/^# test-image.sh/,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done

command -v docker >/dev/null 2>&1 || { echo "error: docker not found" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "error: curl not found" >&2; exit 1; }

# Expected voice_cloning state + the clone endpoint status for a no-body POST
# (451 = disabled/default, 400 = enabled, since the endpoint is now live).
VOICE_CLONING="$(printf '%s' "${VOICE_CLONING}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
lc_voice_cloning="${VOICE_CLONING,,}"
case "${lc_voice_cloning}" in
  1|true|on) EXPECTED_VC="true"; EXPECTED_CLONE=400 ;;
  *)         EXPECTED_VC="false"; EXPECTED_CLONE=451 ;;
esac

# Extract a top-level scalar from JSON on stdin (python3 preferred, grep/sed fallback).
json_scalar() { # $1 = key
  local key="$1" raw
  if [ "${HAVE_PY}" = 1 ]; then
    python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
v = d.get(sys.argv[1])
if isinstance(v, bool):
    print("true" if v else "false")
elif isinstance(v, (str, int, float)):
    print(v)
' "$key" 2>/dev/null
  else
    raw="$(grep -o "\"${key}\"[[:space:]]*:[[:space:]]*\([^,}]\{1,\}\)" | head -n1 \
      | sed -e "s/^\"${key}\"[[:space:]]*:[[:space:]]*//" \
            -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
            -e 's/^"//' -e 's/"$//')"
    printf '%s' "$raw"
  fi
}

# Fetch /health once into $1-named var (empty when the server is not up yet).
fetch_health() {
  local out
  out="$(curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/health" 2>/dev/null || true)"
  HEALTH_JSON="${out}"
}

wait_for_server() {
  local deadline=$(( $(date +%s) + START_TIMEOUT ))
  echo "==> Waiting for the server to come up (up to ${START_TIMEOUT}s)"
  while :; do
    fetch_health
    [ -n "${HEALTH_JSON:-}" ] && return 0
    if [ "$(date +%s)" -ge "${deadline}" ]; then
      echo "    server did not come up within ${START_TIMEOUT}s" >&2
      return 1
    fi
    sleep 2
  done
}

wait_for_healthy() {
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  local status=""
  echo "==> Waiting for the models to load (status=healthy, up to ${HEALTH_TIMEOUT}s)"
  while :; do
    fetch_health
    status="$(printf '%s' "${HEALTH_JSON:-}" | json_scalar status)"
    [ "${status}" = "healthy" ] && return 0
    if [ "$(date +%s)" -ge "${deadline}" ]; then
      echo "    server not healthy within ${HEALTH_TIMEOUT}s (last status: '${status:-<none>}')" >&2
      return 1
    fi
    sleep 3
  done
}

assert_eq() { # $1 desc, $2 expected, $3 actual
  if [ "$2" = "$3" ]; then
    printf '    PASS: %s (=%s)\n' "$1" "$3"
  else
    printf '    FAIL: %s — expected [%s], got [%s]\n' "$1" "$2" "$3"
    FAILURES=$((FAILURES + 1))
  fi
}

assert_contains() { # $1 desc, $2 haystack, $3 needle
  case "${2}" in
    *"${3}"*) printf '    PASS: %s (contains %q)\n' "$1" "$3" ;;
    *)        printf '    FAIL: %s — expected to contain %q, got [%s]\n' "$1" "$3" "$2"; FAILURES=$((FAILURES + 1)) ;;
  esac
}

check_tts() { # $1 lang, $2 text
  local lang="$1" text="$2"
  local body out code ct size magic
  # The fixed test strings below are JSON-safe; keep them that way.
  body="$(printf '{"text":"%s","lang":"%s"}' "${text}" "${lang}")"
  out="$(curl -s -o "${TMP_AUDIO}" -w '%{http_code}\n%{content_type}' \
    --max-time 300 -H 'Content-Type: application/json' \
    -X POST "http://127.0.0.1:${PORT}/tts" --data-binary "${body}" || true)"
  code="${out%%$'\n'*}"
  ct="${out##*$'\n'}"
  size="$(wc -c < "${TMP_AUDIO}" | tr -d '[:space:]')"
  magic="$(head -c 4 "${TMP_AUDIO}" | tr -d '\0')"
  echo "  [TTS ${lang}]"
  assert_eq "status" "200" "${code}"
  assert_contains "content-type" "${ct}" "audio/"
  assert_eq "body is a WAV (RIFF)" "RIFF" "${magic}"
  echo "      ${size} bytes"
}

# --- build -------------------------------------------------------------------
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

echo "==> Building ${IMAGE}:${TAG} with baked-in models (this downloads ~0.9 GB on a cold build)"
"${build[@]}" \
  "${build_args[@]}" \
  -f "${REPO_ROOT}/Dockerfile" \
  -t "${IMAGE}:${TAG}" \
  "${REPO_ROOT}"

# --- run ---------------------------------------------------------------------
run_env=()
[ "${lc_voice_cloning}" != "0" ] && run_env+=(-e "VOICE_CLONING=${VOICE_CLONING}")

echo "==> Running ${IMAGE}:${TAG} on http://127.0.0.1:${PORT} (container: ${CONTAINER})"
if ! docker run -d --rm --name "${CONTAINER}" -p "${PORT}:3001" "${run_env[@]}" "${IMAGE}:${TAG}"; then
  echo "    docker run failed" >&2
  docker logs --tail 60 "${CONTAINER}" 2>&1 | sed 's/^/    /' || true
  exit 1
fi

if ! wait_for_server; then
  echo "==> Container logs (last 60 lines):"
  docker logs --tail 60 "${CONTAINER}" 2>&1 | sed 's/^/    /' || true
  exit 1
fi

# --- checks ------------------------------------------------------------------
echo "==> Smoke tests"
fetch_health

echo "  [config]"
assert_eq "mode" "local" "$(printf '%s' "${HEALTH_JSON}" | json_scalar mode)"
assert_eq "voice_cloning" "${EXPECTED_VC}" "$(printf '%s' "${HEALTH_JSON}" | json_scalar voice_cloning)"

echo "  [clone endpoint]"
clone_code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/voices/clone" || true)"
assert_eq "POST /voices/clone status" "${EXPECTED_CLONE}" "${clone_code}"

if [ "${SKIP_TTS}" != 1 ]; then
  if ! wait_for_healthy; then
    echo "==> Container logs (last 60 lines):"
    docker logs --tail 60 "${CONTAINER}" 2>&1 | sed 's/^/    /' || true
    exit 1
  fi
  check_tts de "Hallo Welt"
  check_tts en "Hello world"
else
  echo "  [tts] skipped (--skip-tts)"
fi

# --- result ------------------------------------------------------------------
echo
if [ "${FAILURES}" -gt 0 ]; then
  echo "==> RESULT: FAILED (${FAILURES} check(s) failed)"
  if [ "${KEEP}" != 1 ]; then
    echo "    (re-run with --keep to inspect the container)"
  fi
  exit 1
fi
echo "==> RESULT: PASSED"
echo "    image: ${IMAGE}:${TAG}"
[ "${KEEP}" = 1 ] && echo "    container ${CONTAINER} left running (docker logs -f ${CONTAINER})"
