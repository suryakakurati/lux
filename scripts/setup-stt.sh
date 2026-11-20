#!/usr/bin/env bash
# Optional: install whisper.cpp for the fastest local transcription path.
# Without this, Lux falls back to a pip/brew `whisper` CLI if present.
set -euo pipefail

MODEL="${1:-base.en}"
REGISTRY="$HOME/.cache/lux/whisper"
mkdir -p "$REGISTRY"

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is required: https://brew.sh" >&2
  exit 1
fi

if ! command -v whisper-cli >/dev/null 2>&1; then
  echo "Installing whisper.cpp…"
  brew install whisper.cpp
fi

TARGET="$REGISTRY/ggml-${MODEL}.bin"
if [ ! -f "$TARGET" ]; then
  echo "Downloading ggml-${MODEL}.bin…"
  curl -L --fail --progress-bar \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${MODEL}.bin" \
    -o "$TARGET"
fi

echo "Ready: $TARGET"
echo "Start Lux and hold right Option to speak."
