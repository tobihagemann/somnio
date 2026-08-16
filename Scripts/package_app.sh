#!/usr/bin/env bash
set -euo pipefail

CONF=${1:-release}
# The player is the only .app this script assembles (the map editor moved to the browser
# and is served by `vite dev`, never packaged). A stray second argument almost certainly
# means a caller still passing the retired target parameter — fail loudly rather than
# silently building the player under an editor invocation.
if [[ $# -gt 1 ]]; then
  echo "ERROR: package_app.sh takes only [debug|release]; the target parameter was retired with the Swift editor" >&2
  exit 1
fi
if [[ "$CONF" != "debug" && "$CONF" != "release" ]]; then
  echo "ERROR: package_app.sh configuration must be 'debug' or 'release', got '$CONF'" >&2
  exit 1
fi
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

source "$ROOT/version.env"

# Derive version from the latest player-* component tag (avoiding another component's newer
# tag) and build number from commit count; the strip yields the bare X.Y.Z for
# CFBundleShortVersionString.
MARKETING_VERSION=${MARKETING_VERSION:-$(git describe --tags --abbrev=0 --match "player-*" 2>/dev/null || echo "0.0.0")}
MARKETING_VERSION=$(sed -E 's/^player-//' <<<"$MARKETING_VERSION")
BUILD_NUMBER=$(git rev-list --count HEAD 2>/dev/null || echo "1")

APP_BUNDLE_NAME="${APP_NAME}"
APP_EXEC_NAME=${EXEC_NAME:-Somnio}
APP_TARGET_NAME="SomnioApp"
APP_ICON_SRC="Resources/Icons/Somnio.icns"
APP_CATEGORY="public.app-category.role-playing-games"

MACOS_MIN_VERSION=${MACOS_MIN_VERSION:-15.0}
SIGNING_MODE=${SIGNING_MODE:-}
APP_IDENTITY=${APP_IDENTITY:-}

ARCH_LIST=( ${ARCHES:-} )
if [[ ${#ARCH_LIST[@]} -eq 0 ]]; then
  HOST_ARCH=$(uname -m)
  ARCH_LIST=("$HOST_ARCH")
fi

# Sparkle feed URL and public key are all-or-none: both must be set together. The
# release-mode hard-fail runs *before* `swift build` so a missing secret short-circuits
# without consuming build time. Debug builds skip injection silently when both are unset
# and warn (but continue) when only one is set so a local typo is visible. The actual
# Info.plist splice happens after the build via `${SPARKLE_KEYS}`.
SPARKLE_KEYS=""
SPARKLE_FEED_URL=${SPARKLE_FEED_URL_PLAYER:-}
SPARKLE_PUBLIC_KEY=${SPARKLE_PUBLIC_ED_KEY:-}
if [[ -n "$SPARKLE_FEED_URL" && -n "$SPARKLE_PUBLIC_KEY" ]]; then
  SPARKLE_KEYS=$(cat <<SPARKLE
    <key>SUFeedURL</key><string>${SPARKLE_FEED_URL}</string>
    <key>SUPublicEDKey</key><string>${SPARKLE_PUBLIC_KEY}</string>
SPARKLE
)
elif [[ -z "$SPARKLE_FEED_URL" && -z "$SPARKLE_PUBLIC_KEY" ]]; then
  if [[ "$CONF" == "release" ]]; then
    echo "ERROR: SPARKLE_FEED_URL_PLAYER and SPARKLE_PUBLIC_ED_KEY both required for release builds" >&2
    exit 1
  fi
else
  if [[ "$CONF" == "release" ]]; then
    echo "ERROR: SPARKLE_FEED_URL_PLAYER and SPARKLE_PUBLIC_ED_KEY must both be set for release builds (only one was provided)" >&2
    exit 1
  fi
  echo "WARNING: only one of SPARKLE_FEED_URL_PLAYER / SPARKLE_PUBLIC_ED_KEY is set; skipping Sparkle injection" >&2
fi

# Release builds bake in the production gameplay endpoint and its pinned trust root by
# rewriting GameplayServerURL.swift / GameplayServerPin.swift before the build; their
# `#error` placeholders make a release compile fail otherwise. Debug builds (including the
# compile_and_run.sh dev loop) compile the `#if DEBUG` branch and never inject. The
# injector validates its input before consuming build time and owns backup/restore; the
# EXIT trap restores pristine sources so a local release leaves no injected endpoint behind.
if [[ "$CONF" == "release" ]]; then
  trap '"$ROOT/Scripts/inject-release-transport.sh" --restore' EXIT
  "$ROOT/Scripts/inject-release-transport.sh"
fi

# Build by --product, not --target: `swift build --target <exe>` compiles the module but
# can skip the link step, leaving no executable at the bin-path for install_binary below
# (it builds "complete" yet produces nothing). All executables are declared products.
for ARCH in "${ARCH_LIST[@]}"; do
  swift build -c "$CONF" --arch "$ARCH" --product "$APP_TARGET_NAME"
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
    <key>CFBundleIdentifier</key><string>${BUNDLE_ID}.player</string>
    <key>CFBundleExecutable</key><string>${APP_EXEC_NAME}</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleDevelopmentRegion</key><string>en</string>
    <key>CFBundleLocalizations</key>
    <array>
        <string>en</string>
        <string>de</string>
    </array>
    <key>CFBundleAllowMixedLocalizations</key><true/>
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
</dict>
</plist>
PLIST

# CFBundleIconFile (not CFBundleIconName, which needs a compiled asset catalog this
# SwiftPM build never produces) resolves Resources/AppIcon.icns. Classic 128px art;
# macOS upscales it at larger sizes.
cp "$ROOT/$APP_ICON_SRC" "$APP/Contents/Resources/AppIcon.icns"

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

# SwiftPM copies `.process`-declared String Catalogs into the resource bundles verbatim;
# compiling them to per-locale .lproj/Localizable.strings is an Xcode build step that
# `swift build` never runs, leaving German unreachable at runtime. Compile each copied
# catalog in place — before signing, so the .lproj land inside the sealed bundles — and
# drop the raw .xcstrings. The host app additionally advertises the locales in its
# Info.plist above (CFBundleAllowMixedLocalizations et al.); without that, Foundation
# resolves subordinate bundles against the host's localizations and German stays dead.
XCSTRINGSTOOL="$(xcrun --find xcstringstool 2>/dev/null || true)"
if [[ -z "$XCSTRINGSTOOL" ]]; then
  echo "ERROR: xcstringstool not found; the Xcode toolchain is required to compile String Catalogs" >&2
  exit 1
fi
shopt -s nullglob
for bundle in "$APP/Contents/Resources/"*.bundle; do
  if [[ -f "$bundle/Localizable.xcstrings" ]]; then
    "$XCSTRINGSTOOL" compile "$bundle/Localizable.xcstrings" -o "$bundle"
    rm "$bundle/Localizable.xcstrings"
  fi
done
shopt -u nullglob

# Validate the required bundle set rather than counting compiles: the shared build dir
# accumulates bundles from other targets across builds, so a stale catalog could
# otherwise mask a required bundle that is missing or uncompiled.
REQUIRED_CATALOG_BUNDLES=("Somnio_SomnioCore.bundle" "Somnio_SomnioUI.bundle" "Somnio_SomnioApp.bundle")
for name in "${REQUIRED_CATALOG_BUNDLES[@]}"; do
  bundle="$APP/Contents/Resources/$name"
  if [[ ! -d "$bundle" ]]; then
    echo "ERROR: required resource bundle $name is missing from Contents/Resources" >&2
    exit 1
  fi
  for strings in en.lproj/Localizable.strings de.lproj/Localizable.strings; do
    if [[ ! -f "$bundle/$strings" ]]; then
      echo "ERROR: $name is missing compiled $strings" >&2
      exit 1
    fi
  done
  if [[ -e "$bundle/Localizable.xcstrings" ]]; then
    echo "ERROR: $name still carries an uncompiled Localizable.xcstrings" >&2
    exit 1
  fi
done

# Bundle assets (3D models, floor materials, UI chrome). The UI/ subtree is a hard
# requirement — SomnioUI renders unstyled panels without it.
SOMNIO_ASSET_DEST="$APP/Contents/Resources" \
  "${ROOT}/Scripts/bundle-assets.sh"

# Embed frameworks if any exist in the build folder (Sparkle is the project's sole
# framework dependency).
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
