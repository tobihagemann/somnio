#!/usr/bin/env bash
set -euo pipefail

# create_dmg.sh stub (pointed at by CREATE_DMG_SCRIPT). Emits a dmg-phase boundary marker,
# logs the invocation, and creates the .dmg at the repo-root path release.sh signs and
# notarizes next. MARKETING_VERSION is exported by release.sh before this call.
# Invoked as `create_dmg.sh <target>`.
target="${1:-player}"
printf -- '--- dmg:%s ---\n' "$target" >>"$RELEASE_SMOKE_LOG"
printf 'create_dmg %s\n' "$*" >>"$RELEASE_SMOKE_LOG"

case "$target" in
  player) dmg_basename="${APP_NAME}" ;;
  editor) dmg_basename="${APP_NAME}Editor" ;;
  *)
    echo "stub create_dmg: unknown target '$target'" >&2
    exit 1
    ;;
esac
: >"$REPO_ROOT/${dmg_basename}-${MARKETING_VERSION}.dmg"
exit 0
