#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
source "$ROOT/version.env"

# An explicitly-set MARKETING_VERSION applies to every target built; otherwise each target
# derives its own version from its latest component tag (player-*/editor-*), so a local
# editor build is never stamped with the player's (or server's) version. The prefix strip
# yields the bare X.Y.Z for bundle versions and asset filenames.
MARKETING_VERSION_OVERRIDE="${MARKETING_VERSION:-}"

resolve_marketing_version() {
  local target="$1" version
  version="${MARKETING_VERSION_OVERRIDE:-$(git describe --tags --abbrev=0 --match "${target}-*" 2>/dev/null || echo "0.0.0")}"
  sed -E 's/^(player|server|editor)-//' <<<"$version"
}

if [[ -z "${APP_IDENTITY:-}" ]]; then
  echo "APP_IDENTITY env var must be set (e.g., 'Developer ID Application: Name (TEAMID)')." >&2
  exit 1
fi

if [[ -z "${APP_STORE_CONNECT_API_KEY_P8:-}" || -z "${APP_STORE_CONNECT_KEY_ID:-}" || -z "${APP_STORE_CONNECT_ISSUER_ID:-}" ]]; then
  echo "Missing APP_STORE_CONNECT_* env vars (API key, key id, issuer id)." >&2
  exit 1
fi

SCRATCH_DIR=$(mktemp -d "${TMPDIR:-/tmp}/somnio-release-XXXXXX")
trap 'rm -rf "$SCRATCH_DIR"' EXIT
chmod 700 "$SCRATCH_DIR"

ASC_KEY_FILE="$SCRATCH_DIR/app-store-connect-key.p8"
(umask 077 && echo "$APP_STORE_CONNECT_API_KEY_P8" | sed 's/\\n/\n/g' > "$ASC_KEY_FILE")

ARCHES_VALUE=${ARCHES:-"arm64 x86_64"}
DITTO_BIN=${DITTO_BIN:-/usr/bin/ditto}

submit_for_notarization() {
  local zip_path="$1"
  xcrun notarytool submit "$zip_path" \
    --key "$ASC_KEY_FILE" \
    --key-id "$APP_STORE_CONNECT_KEY_ID" \
    --issuer "$APP_STORE_CONNECT_ISSUER_ID" \
    --wait
}

notarize_and_staple() {
  local bundle="$1"
  local zip_path="$2"
  "$DITTO_BIN" --norsrc -c -k --keepParent "$bundle" "$zip_path"
  submit_for_notarization "$zip_path"
  xcrun stapler staple "$bundle"
  xattr -cr "$bundle"
  find "$bundle" -name '._*' -delete
}

# Build targets to sign, notarize, and zip. No args defaults to both bundles; CI passes `player`.
TARGETS=("$@")
if [[ ${#TARGETS[@]} -eq 0 ]]; then
  TARGETS=(player editor)
fi

# Validate every target up front so a typo fails before any expensive build/notarize, and
# so the loops below (and package_and_notarize_dmg) can assume a known target.
for TARGET in "${TARGETS[@]}"; do
  case "$TARGET" in
    player | editor) ;;
    *)
      echo "ERROR: unknown release target '$TARGET' (expected 'player' or 'editor')" >&2
      exit 1
      ;;
  esac
done

for TARGET in "${TARGETS[@]}"; do
  export MARKETING_VERSION="$(resolve_marketing_version "$TARGET")"
  case "$TARGET" in
    player)
      BUNDLE="$ROOT/${APP_NAME}.app"
      ZIP_NAME="${APP_NAME}-${MARKETING_VERSION}.zip"
      ;;
    editor)
      BUNDLE="$ROOT/${APP_NAME}Editor.app"
      ZIP_NAME="${APP_NAME}Editor-${MARKETING_VERSION}.zip"
      ;;
  esac

  APP_IDENTITY="$APP_IDENTITY" ARCHES="${ARCHES_VALUE}" \
    "$ROOT/Scripts/package_app.sh" release "$TARGET"

  notarize_and_staple "$BUNDLE" "$SCRATCH_DIR/${APP_NAME}-${TARGET}-Notarize.zip"

  "$DITTO_BIN" --norsrc -c -k --keepParent "$BUNDLE" "$ROOT/$ZIP_NAME"

  spctl -a -t exec -vv "$BUNDLE"
  xcrun stapler validate "$BUNDLE"
done

package_and_notarize_dmg() {
  local target="$1"
  # Re-resolve per target; the build loop above left MARKETING_VERSION at the last target's value.
  export MARKETING_VERSION="$(resolve_marketing_version "$target")"
  local dmg_basename
  # target is already validated against player/editor before this runs.
  case "$target" in
    player) dmg_basename="${APP_NAME}" ;;
    editor) dmg_basename="${APP_NAME}Editor" ;;
  esac
  local dmg_name="${dmg_basename}-${MARKETING_VERSION}.dmg"
  "$ROOT/Scripts/create_dmg.sh" "$target"
  codesign --force --timestamp --sign "$APP_IDENTITY" "$ROOT/$dmg_name"
  local notarize_zip="$SCRATCH_DIR/${dmg_basename}DmgNotarize.zip"
  "$DITTO_BIN" --norsrc -c -k "$ROOT/$dmg_name" "$notarize_zip"
  submit_for_notarization "$notarize_zip"
  xcrun stapler staple "$ROOT/$dmg_name"
}

for TARGET in "${TARGETS[@]}"; do
  package_and_notarize_dmg "$TARGET"
done

echo "Done."
