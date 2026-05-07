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
    ;;
  editor)
    APP_BUNDLE_NAME="${APP_NAME}Editor"
    APP_EXEC_NAME=${EDITOR_EXEC_NAME:-SomnioEditor}
    APP_TARGET_NAME="SomnioEditor"
    INCLUDE_CLI=0
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
    <key>CFBundleIconName</key><string>AppIcon</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSHumanReadableCopyright</key><string>Copyright © 2026 Tobias Hagemann. All rights reserved.</string>
    <key>BuildTimestamp</key><string>${BUILD_TIMESTAMP}</string>
    <key>GitCommit</key><string>${GIT_COMMIT}</string>
    <key>SomnioBuildConfiguration</key><string>${CONF}</string>
</dict>
</plist>
PLIST

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
