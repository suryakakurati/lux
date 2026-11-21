#!/usr/bin/env bash
# Build a real Lux.app bundle: icon, Info.plist usage strings, native helper
# outside the asar, and an ad-hoc signature.
#
# Ad-hoc signing is not notarisation: the app runs on this Mac, but a copy
# downloaded elsewhere would need right-click → Open. Rebuilding changes the
# signature, so macOS asks for Microphone / Input Monitoring again after a
# re-package.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> Bundling renderer and main"
npm run build

echo "==> Drawing icon"
python3 scripts/make-app-icon.py

echo "==> Building .icns"
ICONSET="build/Lux.iconset"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" resources/app-icon.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" resources/app-icon.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
sips -z 1024 1024 resources/app-icon.png --out "$ICONSET/icon_512x512@2x.png" >/dev/null
iconutil -c icns "$ICONSET" -o resources/Lux.icns

VERSION=$(node -p "require('./package.json').version")
echo "==> Packaging Lux.app $VERSION"
rm -rf release
npx @electron/packager . Lux \
  --platform=darwin \
  --arch=arm64 \
  --out=release \
  --overwrite \
  --app-bundle-id=com.lux.assistant \
  --app-version="$VERSION" \
  --icon=resources/Lux.icns \
  --extend-info=resources/info.plist \
  --extra-resource=resources/bin \
  --extra-resource=playbooks \
  --extra-resource=resources/trayTemplate.png \
  --extra-resource=resources/trayTemplate@2x.png \
  --ignore="^/src" \
  --ignore="^/native" \
  --ignore="^/docs" \
  --ignore="^/tests" \
  --ignore="^/scripts" \
  --ignore="^/release" \
  --ignore="^/build" \
  --ignore="^/resources/app-icon.png" \
  --ignore="^/resources/Lux.icns"

APP="release/Lux-darwin-arm64/Lux.app"

echo "==> Signing (ad-hoc, best effort)"
# Desktop and Documents are iCloud-managed on many Macs. The file provider there
# re-attaches com.apple.FinderInfo to every bundle, and codesign refuses to sign
# a bundle carrying it ("resource fork, Finder information ... not allowed").
# Signing is not required to run locally, so a failure warns instead of aborting.
if bash scripts/sign-app.sh "$APP"; then
  echo "    signed"
else
  echo "    WARNING: ad-hoc signing failed (iCloud-managed folder?); the app still runs locally"
fi

echo "==> Verifying bundle"
/usr/bin/plutil -p "$APP/Contents/Info.plist" | grep -iE "CFBundleName|CFBundleIdentifier|NSMicrophoneUsageDescription" || true
ls -l "$APP/Contents/Resources/bin/lux-hotkey"

echo
echo "Built: $APP"
echo "Launch it with:  open \"$ROOT/$APP\""
echo "Install it with: cp -R \"$ROOT/$APP\" /Applications/"
