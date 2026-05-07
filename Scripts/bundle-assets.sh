#!/usr/bin/env bash
set -euo pipefail

# Asset bundling step. Currently a stub; the actual rsync / xcrun actool invocations that
# copy tilesets / sprites / animation strips from SOMNIO_ASSET_SOURCE into SOMNIO_ASSET_DEST
# land in a later iteration. The env-var contract is stable so callers don't have to churn.
#
# Env-var contract:
#   SOMNIO_ASSET_SOURCE — required at release time. Absolute path to the asset root
#                         containing tilesets, sprites, sound. Set on the build machine;
#                         never committed.
#   SOMNIO_ASSET_DEST   — required. The .app/Resources destination set by package_app.sh.

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

# Real copy logic lands when the asset pack is finalized.
echo "Asset bundling: would copy from $SOMNIO_ASSET_SOURCE to $SOMNIO_ASSET_DEST."
exit 0
