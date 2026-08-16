#!/bin/bash
set -euo pipefail

# Somnio lint & check script (exits non-zero on violations; touches no sources, but the web
# scope writes Web/dist as a build-output check)
# Usage:
#   ./Scripts/lint.sh          # everything: Swift + browser client (local default, pre-commit hook)
#   ./Scripts/lint.sh --swift  # Swift only  (SwiftFormat, SwiftLint x2, Periphery)
#   ./Scripts/lint.sh --web    # browser only (Prettier, ESLint, tsc, Vitest, production build + editor-exclusion check)
#
# The scopes let CI run each half on the platform that half belongs to — the macOS job needs macOS
# for the Swift toolchain, and the browser suite belongs on Linux because that is what the web image
# builds on. Each half therefore runs in exactly one job, so a browser failure is reported once
# rather than under two job names. Locally the default stays "everything", so the pre-commit hook
# and a bare invocation cover both halves.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${PROJECT_ROOT}"

RUN_SWIFT=1
RUN_WEB=1
case "${1-}" in
    --swift) RUN_WEB=0 ;;
    --web) RUN_SWIFT=0 ;;
    "") ;;
    *) echo "error: unknown option '$1' (expected --swift, --web, or no argument)"; exit 1 ;;
esac

check_tool() {
    if ! command -v "$1" &> /dev/null; then
        echo "error: $1 not found. Install via: brew install $1"
        exit 1
    fi
}
# Only the tools the selected scope actually runs, so a Linux CI runner with no SwiftFormat can
# still run --web. Within a scope a missing tool is still a hard failure rather than a silent skip.
if [ $RUN_SWIFT -eq 1 ]; then
    check_tool swiftformat
    check_tool swiftlint
    check_tool periphery
fi
# The browser client's toolchain is a hard requirement, matching the Swift tools above: a
# missing `npm` must fail loudly rather than silently skipping the web checks. Install Node
# (see Web/.nvmrc for the pinned version) alongside `brew install argon2`.
if [ $RUN_WEB -eq 1 ]; then
    check_tool npm
fi

# `${TMPDIR:-/tmp}` because Linux does not set it: GitHub's ubuntu runners leave it unset, and
# under `set -u` a bare `$TMPDIR` aborts the whole script before a single check runs. macOS hid
# this for as long as the Swift job was the only caller — launchd always exports it there.
# `Scripts/release.sh` and `Scripts/inject-release-transport.sh` guard it the same way.
LINT_TMP="${TMPDIR:-/tmp}/somnio-lint-$$"
mkdir -p "$LINT_TMP"
trap 'rm -rf "$LINT_TMP"' EXIT

set +e
FAIL=0

if [ $RUN_SWIFT -eq 1 ]; then
swiftformat --lint . >"$LINT_TMP/swiftformat.out" 2>&1 &
PID_FORMAT=$!

swiftlint lint --strict --quiet >"$LINT_TMP/swiftlint.out" 2>&1 &
PID_LINT=$!

# IntegrationTests is a sibling SwiftPM package. SwiftLint's SPM-aware
# test-target detection only works when invoked from the package that
# declares the target, so run a second pass from there with its own config.
(cd "${PROJECT_ROOT}/IntegrationTests" && swiftlint lint --strict --quiet) \
    >"$LINT_TMP/swiftlint-integration.out" 2>&1 &
PID_LINT_INT=$!

# --retain-public is needed because the sibling IntegrationTests package consumes
# SomnioCore / SomnioData / SomnioProtocol as library products; Periphery scans
# only the root package and would otherwise flag their externally-used public symbols.
periphery scan --quiet --strict --retain-public >"$LINT_TMP/periphery.out" 2>&1 &
PID_PERIPHERY=$!
fi

# Browser client: format check, lint, typecheck, unit tests. `npm ci` runs first when
# node_modules is absent so a fresh checkout works without a separate setup step — the same
# property the Swift side gets from SwiftPM resolving on demand.
if [ $RUN_WEB -eq 1 ]; then
(
  cd "${PROJECT_ROOT}/Web" || exit 1
  if [ ! -d node_modules ]; then
    npm ci --no-audit --no-fund || exit 1
  fi
  # Through the declared scripts, not bare `npx`: `Web/package.json` is the single definition of
  # what each check runs, and the `web` CI job invokes the same four names. Spelling the commands
  # out here instead would let a flag added to a script reach CI but not this script or the
  # pre-commit hook.
  npm run format:check || exit 1
  npm run lint || exit 1
  npm run typecheck || exit 1
  npm test || exit 1
  # Deployment bound: the editor entry is dev-only, kept out of the image by never being added
  # to `build.rollupOptions.input`. A text scan of the config cannot catch an entry added via a
  # plugin hook or an editor module pulled into `dist/` by an `src/` import, so this builds for
  # real (adds ~10s) and asserts over the output. Scoped to `dist/bundle` and `dist/*.html`,
  # never `dist/` recursively — Vite copies `Web/public` (which may carry the multi-MB dev
  # asset pack) into the output, and the pre-commit hook must not walk it on every commit.
  npm run build || exit 1
  if [ -e dist/editor.html ]; then
    echo "error: dist/editor.html is present — the editor entry leaked into the production build" >&2
    exit 1
  fi
  # Fail closed: if the build layout changed and these paths are gone, `grep` would exit 2 and the
  # `if` would read as "no markers found", passing a check that examined nothing.
  if [ ! -d dist/bundle ] || [ ! -f dist/index.html ]; then
    echo "error: expected build output missing (dist/bundle or dist/index.html) — cannot verify the editor exclusion" >&2
    exit 1
  fi
  if grep -rlE '__editor/sectors|somnioEditor|somnio-editor-root' dist/bundle dist/index.html; then
    echo "error: editor markers found in the production bundle (an src/ import pulled editor code into dist/)" >&2
    exit 1
  fi
) >"$LINT_TMP/web.out" 2>&1 &
PID_WEB=$!
fi

if [ $RUN_SWIFT -eq 1 ]; then
    wait $PID_FORMAT || { echo "--- SwiftFormat ---"; cat "$LINT_TMP/swiftformat.out"; echo "error: Run './Scripts/format.sh' to auto-fix."; FAIL=1; }
    wait $PID_LINT || { echo "--- SwiftLint ---"; cat "$LINT_TMP/swiftlint.out"; FAIL=1; }
    wait $PID_LINT_INT || { echo "--- SwiftLint (IntegrationTests) ---"; cat "$LINT_TMP/swiftlint-integration.out"; FAIL=1; }
    wait $PID_PERIPHERY || { echo "--- Periphery ---"; cat "$LINT_TMP/periphery.out"; FAIL=1; }
fi
if [ $RUN_WEB -eq 1 ]; then
    wait $PID_WEB || { echo "--- Web (Prettier / ESLint / tsc / Vitest / build check) ---"; cat "$LINT_TMP/web.out"; echo "error: Run './Scripts/format.sh' to auto-fix formatting."; FAIL=1; }
fi

set -e

if [ $FAIL -ne 0 ]; then
    exit 1
fi

echo "Done."
