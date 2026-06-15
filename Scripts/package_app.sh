#!/usr/bin/env bash
set -euo pipefail

CONF=${1:-release}
TARGET=${2:-player}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

source "$ROOT/version.env"

# Derive version from git tag and build number from commit count.
MARKETING_VERSION=${MARKETING_VERSION:-$(git describe --tags --abbrev=0 2>/dev/null || echo "0.0.0")}
BUILD_NUMBER=$(git rev-list --count HEAD 2>/dev/null || echo "1")

case "$TARGET" in
  player)
    APP_BUNDLE_NAME="${APP_NAME}"
    APP_EXEC_NAME=${EXEC_NAME:-Somnio}
    APP_TARGET_NAME="SomnioApp"
    INCLUDE_CLI=1
    APP_ICON_SRC="Resources/Icons/Somnio.icns"
    APP_CATEGORY="public.app-category.role-playing-games"
    ;;
  editor)
    APP_BUNDLE_NAME="${APP_NAME}Editor"
    APP_EXEC_NAME=${EDITOR_EXEC_NAME:-SomnioEditor}
    APP_TARGET_NAME="SomnioEditor"
    INCLUDE_CLI=0
    APP_ICON_SRC="Resources/Icons/SomnioEditor.icns"
    APP_CATEGORY="public.app-category.developer-tools"
    ;;
  *)
    echo "ERROR: unknown target '$TARGET' (expected 'player' or 'editor')" >&2
    exit 1
    ;;
esac

CLI_NAME=${CLI_NAME:-somniocli}
MACOS_MIN_VERSION=${MACOS_MIN_VERSION:-26.0}
SIGNING_MODE=${SIGNING_MODE:-}
APP_IDENTITY=${APP_IDENTITY:-}

ARCH_LIST=( ${ARCHES:-} )
if [[ ${#ARCH_LIST[@]} -eq 0 ]]; then
  HOST_ARCH=$(uname -m)
  ARCH_LIST=("$HOST_ARCH")
fi

case "$TARGET" in
  player)
    SPARKLE_FEED_URL=${SPARKLE_FEED_URL_PLAYER:-}
    SPARKLE_FEED_VAR_NAME="SPARKLE_FEED_URL_PLAYER"
    ;;
  editor)
    SPARKLE_FEED_URL=${SPARKLE_FEED_URL_EDITOR:-}
    SPARKLE_FEED_VAR_NAME="SPARKLE_FEED_URL_EDITOR"
    ;;
esac
SPARKLE_PUBLIC_KEY=${SPARKLE_PUBLIC_ED_KEY:-}

# Sparkle keys are all-or-none per target: both the feed URL and the public key must be
# set together. The release-mode hard-fail must run *before* `swift build` so a missing
# secret short-circuits without consuming build time. Debug builds skip injection silently
# when both are unset and warn (but continue) when only one is set so a local typo is
# visible. The actual Info.plist splice happens after the build via `${SPARKLE_KEYS}`.
if [[ -n "$SPARKLE_FEED_URL" && -n "$SPARKLE_PUBLIC_KEY" ]]; then
  SPARKLE_KEYS=$(cat <<SPARKLE
    <key>SUFeedURL</key><string>${SPARKLE_FEED_URL}</string>
    <key>SUPublicEDKey</key><string>${SPARKLE_PUBLIC_KEY}</string>
SPARKLE
)
elif [[ -z "$SPARKLE_FEED_URL" && -z "$SPARKLE_PUBLIC_KEY" ]]; then
  if [[ "$CONF" == "release" ]]; then
    echo "ERROR: ${SPARKLE_FEED_VAR_NAME} and SPARKLE_PUBLIC_ED_KEY both required for release builds" >&2
    exit 1
  fi
  SPARKLE_KEYS=""
else
  if [[ "$CONF" == "release" ]]; then
    echo "ERROR: ${SPARKLE_FEED_VAR_NAME} and SPARKLE_PUBLIC_ED_KEY must both be set for release builds (only one was provided)" >&2
    exit 1
  fi
  echo "WARNING: only one of ${SPARKLE_FEED_VAR_NAME} / SPARKLE_PUBLIC_ED_KEY is set; skipping Sparkle injection" >&2
  SPARKLE_KEYS=""
fi

# Player release builds bake in the production gameplay endpoint and its pinned trust
# root by rewriting GameplayServerURL.swift / GameplayServerPin.swift before the build;
# their `#error` placeholders make a release compile fail otherwise. Scoped to player +
# release: the editor never imports these files, and debug builds (including the
# compile_and_run.sh dev loop) compile the `#if DEBUG` branch. The injector validates its
# input before consuming build time and owns backup/restore; the EXIT trap restores
# pristine sources so a local release leaves no injected endpoint behind.
if [[ "$TARGET" == "player" && "$CONF" == "release" ]]; then
  trap '"$ROOT/Scripts/inject-release-transport.sh" --restore' EXIT
  "$ROOT/Scripts/inject-release-transport.sh"
fi

for ARCH in "${ARCH_LIST[@]}"; do
  swift build -c "$CONF" --arch "$ARCH" --target "$APP_TARGET_NAME"
  if [[ "$INCLUDE_CLI" == "1" ]]; then
    swift build -c "$CONF" --arch "$ARCH" --target SomnioCLI
  fi
done

APP="$ROOT/${APP_BUNDLE_NAME}.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/Frameworks"

BUILD_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
GIT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

if [[ "$TARGET" == "editor" ]]; then
  EDITOR_DOCUMENT_KEYS=$(cat <<'EDITOR_KEYS'
    <key>CFBundleDocumentTypes</key>
    <array>
        <dict>
            <key>CFBundleTypeName</key><string>Somnio Sector</string>
            <key>CFBundleTypeRole</key><string>Editor</string>
            <key>CFBundleTypeIconFile</key><string>SomnioSector</string>
            <key>LSHandlerRank</key><string>Owner</string>
            <key>LSItemContentTypes</key>
            <array>
                <string>de.tobiha.somnio.sector</string>
            </array>
        </dict>
    </array>
    <key>UTExportedTypeDeclarations</key>
    <array>
        <dict>
            <key>UTTypeIdentifier</key><string>de.tobiha.somnio.sector</string>
            <key>UTTypeDescription</key><string>Somnio Sector</string>
            <key>UTTypeConformsTo</key>
            <array>
                <string>public.json</string>
            </array>
            <key>UTTypeTagSpecification</key>
            <dict>
                <key>public.filename-extension</key>
                <array>
                    <string>somnio-sector</string>
                </array>
            </dict>
        </dict>
    </array>
EDITOR_KEYS
)
else
  EDITOR_DOCUMENT_KEYS=""
fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>${APP_BUNDLE_NAME}</string>
    <key>CFBundleDisplayName</key><string>${APP_BUNDLE_NAME}</string>
    <key>CFBundleIdentifier</key><string>${BUNDLE_ID}.${TARGET}</string>
    <key>CFBundleExecutable</key><string>${APP_EXEC_NAME}</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>${MARKETING_VERSION}</string>
    <key>CFBundleVersion</key><string>${BUILD_NUMBER}</string>
    <key>LSMinimumSystemVersion</key><string>${MACOS_MIN_VERSION}</string>
    <key>CFBundleIconFile</key><string>AppIcon</string>
    <key>LSApplicationCategoryType</key><string>${APP_CATEGORY}</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSHumanReadableCopyright</key><string>Copyright © 2026 Tobias Hagemann. All rights reserved.</string>
    <key>BuildTimestamp</key><string>${BUILD_TIMESTAMP}</string>
    <key>GitCommit</key><string>${GIT_COMMIT}</string>
    <key>SomnioBuildConfiguration</key><string>${CONF}</string>
${SPARKLE_KEYS}
${EDITOR_DOCUMENT_KEYS}
</dict>
</plist>
PLIST

# CFBundleIconFile (not CFBundleIconName, which needs a compiled asset catalog this
# SwiftPM build never produces) resolves Resources/AppIcon.icns. Classic 128px art;
# macOS upscales it at larger sizes.
cp "$ROOT/$APP_ICON_SRC" "$APP/Contents/Resources/AppIcon.icns"
# Editor-only .somnio-sector document icon (CFBundleTypeIconFile).
if [[ "$TARGET" == "editor" ]]; then
  cp "$ROOT/Resources/Icons/SomnioSector.icns" "$APP/Contents/Resources/SomnioSector.icns"
fi

build_product_path() {
  local name="$1"
  local arch="$2"
  case "$arch" in
    arm64|x86_64) echo ".build/${arch}-apple-macosx/$CONF/$name" ;;
    *) echo ".build/$CONF/$name" ;;
  esac
}

verify_binary_arches() {
  local binary="$1"; shift
  local expected=("$@")
  local actual
  actual=$(lipo -archs "$binary")
  local actual_count expected_count
  actual_count=$(wc -w <<<"$actual" | tr -d ' ')
  expected_count=${#expected[@]}
  if [[ "$actual_count" -ne "$expected_count" ]]; then
    echo "ERROR: $binary arch mismatch (expected: ${expected[*]}, actual: ${actual})" >&2
    exit 1
  fi
  for arch in "${expected[@]}"; do
    if [[ "$actual" != *"$arch"* ]]; then
      echo "ERROR: $binary missing arch $arch (have: ${actual})" >&2
      exit 1
    fi
  done
}

install_binary() {
  local name="$1"
  local dest="$2"
  local binaries=()
  for arch in "${ARCH_LIST[@]}"; do
    local src
    src=$(build_product_path "$name" "$arch")
    if [[ ! -f "$src" ]]; then
      echo "ERROR: Missing ${name} build for ${arch} at ${src}" >&2
      exit 1
    fi
    binaries+=("$src")
  done
  if [[ ${#ARCH_LIST[@]} -gt 1 ]]; then
    lipo -create "${binaries[@]}" -output "$dest"
  else
    cp "${binaries[0]}" "$dest"
  fi
  chmod +x "$dest"
  verify_binary_arches "$dest" "${ARCH_LIST[@]}"
}

# Install main app binary.
install_binary "$APP_TARGET_NAME" "$APP/Contents/MacOS/$APP_EXEC_NAME"

# Install CLI binary into Resources (player bundle only).
if [[ "$INCLUDE_CLI" == "1" ]]; then
  install_binary "SomnioCLI" "$APP/Contents/Resources/$CLI_NAME"
fi

# SwiftPM resource bundles are emitted next to the built binary.
PREFERRED_BUILD_DIR="$(dirname "$(build_product_path "$APP_TARGET_NAME" "${ARCH_LIST[0]}")")"
shopt -s nullglob
SWIFTPM_BUNDLES=("${PREFERRED_BUILD_DIR}/"*.bundle)
shopt -u nullglob
if [[ ${#SWIFTPM_BUNDLES[@]} -gt 0 ]]; then
  for bundle in "${SWIFTPM_BUNDLES[@]}"; do
    cp -R "$bundle" "$APP/Contents/Resources/"
  done
fi

# Bundle assets (tilesets, sprites, animation strips). The script is a stub today; wiring
# the call here means broken paths surface in CI as soon as packaging is exercised.
SOMNIO_ASSET_DEST="$APP/Contents/Resources" \
  "${ROOT}/Scripts/bundle-assets.sh"

# Embed frameworks if any exist in the build folder.
FRAMEWORK_DIRS=(".build/$CONF" ".build/${ARCH_LIST[0]}-apple-macosx/$CONF")
for dir in "${FRAMEWORK_DIRS[@]}"; do
  if compgen -G "${dir}/"*.framework >/dev/null; then
    cp -R "${dir}/"*.framework "$APP/Contents/Frameworks/"
    chmod -R a+rX "$APP/Contents/Frameworks"
    install_name_tool -add_rpath "@executable_path/../Frameworks" "$APP/Contents/MacOS/$APP_EXEC_NAME"
    break
  fi
done

# Ensure contents are writable before stripping attributes and signing.
chmod -R u+w "$APP"

# Strip extended attributes to prevent AppleDouble files that break code sealing.
xattr -cr "$APP"
find "$APP" -name '._*' -delete

APP_ENTITLEMENTS=${APP_ENTITLEMENTS:-"$ROOT/Resources/Entitlements.plist"}

if [[ "$SIGNING_MODE" == "adhoc" || -z "$APP_IDENTITY" ]]; then
  CODESIGN_ARGS=(--force --sign "-")
else
  CODESIGN_ARGS=(--force --timestamp --options runtime --sign "$APP_IDENTITY")
fi

# Sign embedded frameworks and their nested binaries before the app bundle.
sign_frameworks() {
  local fw
  for fw in "$APP/Contents/Frameworks/"*.framework; do
    if [[ ! -d "$fw" ]]; then
      continue
    fi
    while IFS= read -r -d '' bin; do
      codesign "${CODESIGN_ARGS[@]}" "$bin"
    done < <(find "$fw" -type f -perm -111 -print0)
    codesign "${CODESIGN_ARGS[@]}" "$fw"
  done
}
sign_frameworks

codesign "${CODESIGN_ARGS[@]}" \
  --entitlements "$APP_ENTITLEMENTS" \
  "$APP"

echo "Created $APP"
