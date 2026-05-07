#!/usr/bin/env bash
set -euo pipefail

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

MARKETING_VERSION=${MARKETING_VERSION:-$(git describe --tags --abbrev=0 2>/dev/null || echo "0.0.0")}
APP_BUNDLE="$ROOT/${APP_BUNDLE_NAME}.app"
DMG_NAME="${DMG_BASENAME}-${MARKETING_VERSION}.dmg"
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

if [[ ! -d "$APP_BUNDLE" ]]; then
  echo "ERROR: ${APP_BUNDLE} not found. Run Scripts/package_app.sh first." >&2
  exit 1
fi

cp -R "$APP_BUNDLE" "$TEMP_DIR/"
ln -s /Applications "$TEMP_DIR/Applications"

hdiutil create -volname "$APP_BUNDLE_NAME" \
  -srcfolder "$TEMP_DIR" \
  -ov -format UDZO \
  "$ROOT/$DMG_NAME"

echo "Created $ROOT/$DMG_NAME"
