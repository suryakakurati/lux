#!/usr/bin/env bash
# Optional: install a neural voice so Lux does not sound like a system voice.
#
#   npm run voice:setup
#
# Piper runs entirely on this Mac. Lux uses it for the "Automatic" voice and
# falls back to a macOS voice if the model or the engine is ever removed.
set -euo pipefail

VENV="$HOME/.cache/lux/piper-venv"
DIR="$HOME/.cache/lux/piper"
VOICE="${1:-en_US-lessac-high}"
BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main"

case "$VOICE" in
  en_US-lessac-high) PATH_PART="en/en_US/lessac/high" ;;
  en_US-amy-medium) PATH_PART="en/en_US/amy/medium" ;;
  en_GB-alba-medium) PATH_PART="en/en_GB/alba/medium" ;;
  *)
    echo "Unknown voice: $VOICE" >&2
    echo "Supported: en_US-lessac-high, en_US-amy-medium, en_GB-alba-medium" >&2
    exit 1
    ;;
esac

PYTHON="${PYTHON:-python3}"
if ! "$PYTHON" -c 'import sys; raise SystemExit(0 if (3, 9) <= sys.version_info < (3, 13) else 1)'; then
  echo "Python 3.9-3.12 is required for piper-tts." >&2
  exit 1
fi

if [ ! -x "$VENV/bin/piper" ]; then
  echo "==> Creating the Piper environment"
  "$PYTHON" -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --upgrade pip
  "$VENV/bin/pip" install --quiet "piper-tts==1.8.0"
fi

mkdir -p "$DIR"
if [ ! -f "$DIR/$VOICE.onnx" ]; then
  echo "==> Downloading $VOICE"
  curl -L --fail --progress-bar "$BASE/$PATH_PART/$VOICE.onnx" -o "$DIR/$VOICE.onnx"
  curl -L --fail --progress-bar "$BASE/$PATH_PART/$VOICE.onnx.json" -o "$DIR/$VOICE.onnx.json"
fi

echo "Ready: $DIR/$VOICE.onnx"
echo "Restart Lux. \"Automatic\" now speaks with the neural voice."
