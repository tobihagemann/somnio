#!/usr/bin/env bash
set -euo pipefail

# Asset bundling step. Copies the runtime pack (converted USDZ models / floor
# materials / UI chrome textures) from SOMNIO_ASSET_SOURCE into the .app bundle's
# Resources/ directory. The asset pack itself is never committed (it lives on the
# build machine).
#
# Env-var contract:
#   SOMNIO_ASSET_SOURCE — required. Absolute path to the asset root containing the
#                         Models/, FloorMaterials/, and UI/ subdirectories. Set on the
#                         build machine; never committed.
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
  echo "ERROR: Asset bundling: SOMNIO_ASSET_SOURCE is not set." >&2
  echo "       The player bundle requires the asset pack (its UI/ subtree styles every panel)." >&2
  echo "       Point it at the somnio-assets checkout, e.g.:" >&2
  echo "         SOMNIO_ASSET_SOURCE=/path/to/somnio-assets Scripts/package_app.sh debug" >&2
  exit 1
fi

SUBTREES=(Models FloorMaterials UI)

# Per-subtree copy. Models/ and FloorMaterials/ missing are soft warnings so an
# in-progress operator-supplied pack still produces a runnable bundle (the loader's
# nil-fallback path renders placeholder models and an untextured floor). UI/ is a
# hard failure: SomnioUI has no designed fallback, so a bundle without it ships
# unstyled panels.
#
# Case-sensitivity hazard: the loaders resolve Models/, FloorMaterials/, and UI/ via
# `Bundle.url(forResource:withExtension:subdirectory:)` with lowercase `usdz`/`png`
# extensions only. A file shipped with an uppercase extension resolves on
# case-insensitive macOS (HFS+/APFS default) but silently fails on a case-sensitive
# Linux bundle. Keep asset filenames lowercase-extension.
for subtree in "${SUBTREES[@]}"; do
  src="${SOMNIO_ASSET_SOURCE%/}/${subtree}"
  dest="${SOMNIO_ASSET_DEST%/}/${subtree}"
  if [[ ! -d "$src" ]]; then
    if [[ "$subtree" == "UI" ]]; then
      echo "ERROR: Asset bundling: required subtree 'UI' missing at ${src}." >&2
      echo "       The player bundle needs the UI chrome textures (somnio-assets UI/ subtree)." >&2
      exit 1
    fi
    echo "WARN: Asset bundling: subtree '${subtree}' missing at ${src}; skipping."
    continue
  fi
  mkdir -p "$dest"
  # Replace rather than merge: without `--delete`, a stem renamed or dropped in the pack keeps being
  # shipped out of a previous build's bundle, so the .app carries a model the pack no longer has.
  # `Scripts/bundle-web-assets.sh` makes the same guarantee for the served root.
  rsync -a --delete "${src}/" "${dest}/"
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
