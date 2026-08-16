#!/usr/bin/env bash
set -euo pipefail

# create_dmg.sh stub (pointed at by CREATE_DMG_SCRIPT). Emits a dmg-phase boundary marker,
# logs the invocation, and creates the .dmg at the repo-root path release.sh signs and
# notarizes next. MARKETING_VERSION is exported by release.sh before this call.
# Invoked as `create_dmg.sh` (the target parameter was retired with the editor).
# Mirror the real script's arity guard so a reintroduced target argument fails here too.
if [[ $# -gt 0 ]]; then
  echo "ERROR: create_dmg.sh takes no arguments; the target parameter was retired with the Swift editor" >&2
  exit 1
fi
printf -- '--- dmg:player ---\n' >>"$RELEASE_SMOKE_LOG"
printf 'create_dmg %s\n' "$*" >>"$RELEASE_SMOKE_LOG"

: >"$REPO_ROOT/${APP_NAME}-${MARKETING_VERSION}.dmg"
exit 0
