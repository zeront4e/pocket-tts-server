#!/usr/bin/env bash
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

step() { echo -e "\n${GREEN}==> $1${NC}"; }
warn() { echo -e "${YELLOW}Warning: $1${NC}"; }
err() { echo -e "${RED}Error: $1${NC}"; exit 1; }

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

# 1. Check Bun
step "Checking Bun..."
if command -v bun &>/dev/null; then
  echo "  bun $(bun --version)"
else
  err "Bun not found. Install from https://bun.sh"
fi

# 2. Install uv
step "Installing uv (Python package manager)..."
if command -v uv &>/dev/null || [ -x "$HOME/.local/bin/uv" ]; then
  UV=$(command -v uv 2>/dev/null || echo "$HOME/.local/bin/uv")
  echo "  $UV ($($UV --version))"
else
  curl -LsSf https://astral.sh/uv/install.sh | sh
  UV="$HOME/.local/bin/uv"
  echo "  Installed: $($UV --version)"
fi
export PATH="$HOME/.local/bin:$PATH"

# 3. Create Python venv (repair if the interpreter symlink is broken)
step "Creating Python virtual environment (3.12)..."
if [ -d ".venv" ] && .venv/bin/python3 --version &>/dev/null; then
  echo "  .venv already exists, skipping"
else
  if [ -d ".venv" ]; then
    warn ".venv interpreter is broken (stale symlink), repairing in place..."
    uv python install 3.12
    PY=$(uv python find 3.12)
    ln -sfn "$PY" .venv/bin/python
    ln -sfn python .venv/bin/python3
    ln -sfn python .venv/bin/python3.12
    sed -i "s|^home = .*|home = $(dirname "$PY")|" .venv/pyvenv.cfg
    # console scripts may carry a shebang from the venv's old location
    OLD_SHEBANG=$(.venv/bin/python3 - <<'EOF' 2>/dev/null || true
import pathlib
for p in pathlib.Path("bin").glob("*"):
    if p.is_file() and not p.name.startswith("activate") and not p.name.endswith(".bat"):
        first = p.open("rb").read_line().rstrip(b"\n")
        if first.startswith(b"#!") and b"venv/bin/python" in first:
            print(first[2:].decode(errors="replace"))
            break
EOF
)
    if [ -n "$OLD_SHEBANG" ]; then
      find .venv/bin -maxdepth 1 -type f -print0 \
        | xargs -0 sed -i "1s|^#!$OLD_SHEBANG.*|#!$PWD/.venv/bin/python3|"
    fi
    .venv/bin/python3 --version &>/dev/null || err "Could not repair .venv, remove it and re-run setup"
  else
    uv venv --python 3.12
  fi
fi

# 4. Install soundfile (needed by pocket-tts to read non-WAV audio, e.g. voice cloning)
step "Installing soundfile..."
if ! .venv/bin/python -c "import soundfile" 2>/dev/null; then
  uv pip install soundfile
  echo "  soundfile $(.venv/bin/python -c 'import soundfile; print(soundfile.__version__)')"
else
  echo "  soundfile already installed"
fi

# 5. Install pocket-tts
step "Installing pocket-tts..."
if .venv/bin/pocket-tts --help &>/dev/null 2>&1; then
  echo "  pocket-tts already installed"
else
  uv pip install pocket-tts
  .venv/bin/pocket-tts --help > /dev/null
  echo "  pocket-tts $(.venv/bin/pocket-tts --version 2>&1 | head -1 || echo 'installed')"
fi

# 5b. Install PyAV (Ogg/Opus encoder for the format=opus output option)
step "Installing PyAV (Ogg/Opus encoder)..."
if ! .venv/bin/python -c "import av" 2>/dev/null; then
  uv pip install av
  echo "  av $(.venv/bin/python -c 'import av; print(av.__version__)')"
else
  echo "  av $(.venv/bin/python -c 'import av; print(av.__version__)') already installed"
fi

# 6. Create directories
step "Creating project directories..."
mkdir -p voices config scripts static voices/de voices/en

# 7. Install TypeScript types
step "Installing TypeScript types..."
bun add -d bun-types 2>/dev/null || true

# 8. Download models (first run: German ~672MB + English ~219MB)
step "Downloading German 24l model from lunahr/pocket-tts-ungated (~672MB)..."
echo "  (This only runs once; subsequent starts are instant)"
uv run python -c "
from pocket_tts import TTSModel
model = TTSModel.load_model(config='config/german_24l.yaml')
print('  Model loaded successfully!')
print(f'  Sample rate: {model.sample_rate} Hz')
print(f'  Device: {model.device}')
" 2>&1 | grep -v "^ $"

step "Downloading English model from lunahr/pocket-tts-ungated (~219MB)..."
echo "  (This only runs once; subsequent starts are instant)"
uv run python -c "
from pocket_tts import TTSModel
model = TTSModel.load_model(config='config/english.yaml')
print('  Model loaded successfully!')
print(f'  Sample rate: {model.sample_rate} Hz')
print(f'  Device: {model.device}')
" 2>&1 | grep -v "^ $"

echo ""
step "Setup complete!"
echo ""
echo "  Start the server:  bun run src/index.ts"
echo "  Demo page:         http://localhost:3001/"
echo "  Clone a voice:     bun run scripts/clone-voice.ts <audio_file> [name] [--lang de|en]"
echo ""
  echo "  API endpoints (all accept a \"lang\" field: de|en, default de):"
  echo "    POST /tts           - Generate full WAV or Ogg/Opus (format: wav|opus)"
  echo "    POST /tts/stream    - Stream WAV or Ogg/Opus (format: wav|opus)"
  echo "    GET  /voices        - List voices (?lang=)"
  echo "    POST /voices/clone  - Clone a voice (form field \"lang\")"
  echo "    POST /voices/import - Import an existing .safetensors voice (form field \"lang\")"
  echo "    GET  /voices/download - Download a voice model file (?name=X&lang=)"
  echo "    DELETE /voices      - Delete a cloned voice (?name=X&lang=)"
  echo "    GET  /health        - Health check (per-language status)"
  echo "    GET  /docs          - Swagger API docs"
  echo ""
