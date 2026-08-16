#!/usr/bin/env bash
set -euo pipefail

# Retro single-icon install window: the app icon sits over the background's drop-zone,
# deliberately no /Applications symlink. Uses create-dmg (brew) to lay out the Finder
# window -- the background-picture AppleScript it relies on is unreliable to hand-roll on
# current macOS.

ROOT=$(cd "$(dirname "$0")/.." && pwd)
source "$ROOT/version.env"

# The player is the only DMG this script builds (the map editor moved to the browser and
# is never packaged); a stray argument means a caller still passing the retired target.
if [[ $# -gt 0 ]]; then
  echo "ERROR: create_dmg.sh takes no arguments; the target parameter was retired with the Swift editor" >&2
  exit 1
fi

APP_BUNDLE_NAME="${APP_NAME}"
DMG_BASENAME="${APP_NAME}"

# Derive from the latest player-* component tag so the DMG filename isn't stamped with
# another component's newer version; the strip yields the bare X.Y.Z.
MARKETING_VERSION=${MARKETING_VERSION:-$(git describe --tags --abbrev=0 --match "player-*" 2>/dev/null || echo "0.0.0")}
MARKETING_VERSION=$(sed -E 's/^player-//' <<<"$MARKETING_VERSION")
APP_BUNDLE="$ROOT/${APP_BUNDLE_NAME}.app"
DMG_NAME="${DMG_BASENAME}-${MARKETING_VERSION}.dmg"

if [[ ! -d "$APP_BUNDLE" ]]; then
  echo "ERROR: ${APP_BUNDLE} not found. Run Scripts/package_app.sh first." >&2
  exit 1
fi

if ! command -v create-dmg >/dev/null 2>&1; then
  echo "ERROR: create-dmg not found. Install it with: brew install create-dmg" >&2
  exit 1
fi

rm -f "$ROOT/$DMG_NAME"

# --window-size matches background.png's 632x364; --icon X Y is the app icon's center in
# the window (top-left origin) over the drop-zone; --window-pos is just where it opens
# on screen.
create-dmg \
  --volname "$APP_BUNDLE_NAME" \
  --volicon "$ROOT/Resources/DMG/VolumeIcon.icns" \
  --background "$ROOT/Resources/DMG/background.png" \
  --window-pos 200 120 \
  --window-size 632 364 \
  --icon-size 96 \
  --icon "${APP_BUNDLE_NAME}.app" 120 120 \
  --no-internet-enable \
  "$ROOT/$DMG_NAME" \
  "$APP_BUNDLE"

echo "Created $ROOT/$DMG_NAME"
