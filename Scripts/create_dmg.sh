#!/usr/bin/env bash
set -euo pipefail

# Retro single-icon install window: the app icon sits over the background's drop-zone,
# deliberately no /Applications symlink. Uses create-dmg (brew) to lay out the Finder
# window -- the background-picture AppleScript it relies on is unreliable to hand-roll on
# current macOS.

TARGET=${1:-player}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
source "$ROOT/version.env"

case "$TARGET" in
  player)
    APP_BUNDLE_NAME="${APP_NAME}"
    DMG_BASENAME="${APP_NAME}"
    ;;
  editor)
    APP_BUNDLE_NAME="${APP_NAME}Editor"
    DMG_BASENAME="${APP_NAME}Editor"
    ;;
  *)
    echo "ERROR: unknown target '$TARGET' (expected 'player' or 'editor')" >&2
    exit 1
    ;;
esac

# Derive from this target's latest component tag (player-*/editor-*) so the DMG filename
# isn't stamped with another component's newer version; the strip yields the bare X.Y.Z.
MARKETING_VERSION=${MARKETING_VERSION:-$(git describe --tags --abbrev=0 --match "${TARGET}-*" 2>/dev/null || echo "0.0.0")}
MARKETING_VERSION=$(sed -E 's/^(player|server|editor)-//' <<<"$MARKETING_VERSION")
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
