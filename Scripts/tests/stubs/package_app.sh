#!/usr/bin/env bash
set -euo pipefail

# package_app.sh stub (pointed at by PACKAGE_APP_SCRIPT). Emits a build-phase boundary
# marker so the harness can window the ordering assertions, logs the invocation, and
# fabricates the .app bundle at the exact repo-root path release.sh's BUNDLE var expects.
# Invoked as `package_app.sh release` (the target parameter was retired with the editor).
# Mirror the real script's arity guard so a reintroduced `package_app.sh release player` fails
# here too — the smoke test is the only automated gate on release.sh's call shape.
if [[ $# -gt 1 ]]; then
  echo "ERROR: package_app.sh takes only [debug|release]; the target parameter was retired with the Swift editor" >&2
  exit 1
fi
printf -- '--- build:player ---\n' >>"$RELEASE_SMOKE_LOG"
printf 'package_app %s\n' "$*" >>"$RELEASE_SMOKE_LOG"

# Simulate a build failure after the scratch dir is created (release.sh creates it before
# the build), so the harness can assert the EXIT-trap scratch cleanup still fires.
if [[ -n "${SMOKE_PACKAGE_APP_EXIT:-}" ]]; then
  exit "$SMOKE_PACKAGE_APP_EXIT"
fi

mkdir -p "$REPO_ROOT/${APP_NAME}.app"
exit 0
