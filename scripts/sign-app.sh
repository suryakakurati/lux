#!/usr/bin/env bash
# Ad-hoc sign a packaged Electron app, inside out, and verify it.
#
# Electron bundles must be signed from the frameworks outward: helpers first,
# then the main bundle, and never with --deep (which re-signs already-signed
# nested code with the wrong identity). A bundle carrying com.apple.FinderInfo
# cannot be signed at all, so clear it from every directory first.
#
# Usage: bash scripts/sign-app.sh release/Lux-darwin-arm64/Lux.app
set -uo pipefail

APP="${1:?usage: sign-app.sh <path/to/App.app>}"
[ -d "$APP" ] || { echo "no bundle at $APP" >&2; exit 1; }

clear_detritus() {
  find "$APP" -type d -exec xattr -d com.apple.FinderInfo {} \; 2>/dev/null
  find "$APP" -type d -exec xattr -d com.apple.fileprovider.fpfs#P {} \; 2>/dev/null
}

sign_one() {
  codesign --force --sign - --preserve-metadata=entitlements,requirements,flags "$1" >/dev/null 2>&1
}

clear_detritus

for framework in "$APP"/Contents/Frameworks/*.framework; do
  [ -e "$framework" ] || continue
  clear_detritus
  sign_one "$framework/Versions/A" || { echo "could not sign $framework" >&2; exit 1; }
done

for helper in "$APP"/Contents/Frameworks/*.app; do
  [ -e "$helper" ] || continue
  clear_detritus
  sign_one "$helper" || { echo "could not sign $helper" >&2; exit 1; }
done

if [ -f "$APP/Contents/Resources/bin/lux-hotkey" ]; then
  clear_detritus
  sign_one "$APP/Contents/Resources/bin/lux-hotkey" || { echo "could not sign hotkey helper" >&2; exit 1; }
fi

clear_detritus
sign_one "$APP" || { echo "could not sign $APP" >&2; exit 1; }

codesign --verify --strict "$APP"
