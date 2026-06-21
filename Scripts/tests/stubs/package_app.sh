#!/usr/bin/env bash
set -euo pipefail

# package_app.sh stub (pointed at by PACKAGE_APP_SCRIPT). Emits a build-phase boundary
# marker so the harness can window the ordering assertions, logs the invocation, and
# fabricates the .app bundle at the exact repo-root path release.sh's BUNDLE var expects.
# Invoked as `package_app.sh release <target>`.
target="${2:-player}"
printf -- '--- build:%s ---\n' "$target" >>"$RELEASE_SMOKE_LOG"
printf 'package_app %s\n' "$*" >>"$RELEASE_SMOKE_LOG"

# Simulate a build failure after the scratch dir is created (release.sh creates it before
# the build loop), so the harness can assert the EXIT-trap scratch cleanup still fires.
if [[ -n "${SMOKE_PACKAGE_APP_EXIT:-}" ]]; then
  exit "$SMOKE_PACKAGE_APP_EXIT"
fi

case "$target" in
  player) bundle="$REPO_ROOT/${APP_NAME}.app" ;;
  editor) bundle="$REPO_ROOT/${APP_NAME}Editor.app" ;;
  *)
    echo "stub package_app: unknown target '$target'" >&2
    exit 1
    ;;
esac
mkdir -p "$bundle"
exit 0
