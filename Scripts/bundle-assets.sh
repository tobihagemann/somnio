#!/usr/bin/env bash
set -euo pipefail

# Asset bundling step. Copies tilesets / character sprite sheets / animation strips /
# system images / editor buttons from SOMNIO_ASSET_SOURCE into the .app bundle's
# Resources/ directory. The asset pack itself is never committed (it lives on the
# build machine); a release run sets SOMNIO_ASSET_SOURCE, a dev run via
# compile_and_run.sh leaves it unset and falls through to the silent-skip path.
#
# Env-var contract:
#   SOMNIO_ASSET_SOURCE — required at release time. Absolute path to the asset root
#                         containing Tilesets/, Characters/, Animations/, System/,
#                         Buttons/ subdirectories. Set on the build machine; never
#                         committed.
#   SOMNIO_ASSET_DEST   — required. The .app/Resources destination set by
#                         package_app.sh.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../version.env"

if [[ -z "${SOMNIO_ASSET_DEST:-}" ]]; then
  echo "ERROR: SOMNIO_ASSET_DEST is not set." >&2
  echo "       Set it to the .app/Resources path that should receive the assets." >&2
  exit 1
fi

if [[ -z "${SOMNIO_ASSET_SOURCE:-}" ]]; then
  echo "Asset bundling: SOMNIO_ASSET_SOURCE not set; skipping (no-op)."
  exit 0
fi

SUBTREES=(Tilesets Characters Animations System Buttons)

# Per-subtree copy. Each missing subtree is a soft warning so an in-progress
# operator-supplied pack still produces a runnable bundle; the loader's nil-fallback
# path renders untextured nodes and a solid-color splash in that case.
#
# Case-sensitivity hazard: the loader resolves character/tileset sheets via
# `Bundle.urls(forResourcesWithExtension: "png", ...)`, which matches the lowercase
# `png` extension only. A sheet shipped with an uppercase extension (e.g.
# `025-Beast03.PNG`) resolves on case-insensitive macOS (HFS+/APFS default) but
# silently fails on a case-sensitive Linux bundle, leaving that one sheet untextured.
# Keep asset filenames lowercase-`.png`.
for subtree in "${SUBTREES[@]}"; do
  src="${SOMNIO_ASSET_SOURCE%/}/${subtree}"
  dest="${SOMNIO_ASSET_DEST%/}/${subtree}"
  if [[ ! -d "$src" ]]; then
    echo "WARN: Asset bundling: subtree '${subtree}' missing at ${src}; skipping."
    continue
  fi
  mkdir -p "$dest"
  rsync -a "${src}/" "${dest}/"
done

summary=()
for subtree in "${SUBTREES[@]}"; do
  dest="${SOMNIO_ASSET_DEST%/}/${subtree}"
  if [[ -d "$dest" ]]; then
    count=$(find "$dest" -type f | wc -l | tr -d ' ')
  else
    count=0
  fi
  lower=$(printf '%s' "$subtree" | tr '[:upper:]' '[:lower:]')
  summary+=("${count} ${lower}")
done
echo "Asset bundling: copied ${summary[*]}."
