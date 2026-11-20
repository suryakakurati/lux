#!/usr/bin/env bash
# Compile the native right-Option listener. Requires Xcode Command Line Tools.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/native/hotkey/main.swift"
OUT_DIR="$ROOT/resources/bin"
OUT="$OUT_DIR/lux-hotkey"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found. Install Xcode Command Line Tools: xcode-select --install" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
echo "Compiling $SRC"
swiftc -O -o "$OUT" "$SRC" -framework Cocoa -framework CoreGraphics
chmod +x "$OUT"
echo "Built $OUT"
"$OUT" --self-test >/dev/null 2>&1 || true
