#!/bin/bash
set -euo pipefail

# Somnio lint & check script (exits non-zero on violations; touches no sources, but writes
# packages/web/dist as a build-output check)
# Usage:
#   ./Scripts/lint.sh   # Prettier, ESLint, tsc, Vitest (unit projects only), production build + editor-exclusion check
#
# The pre-commit hook and CI's `checks` job both run this, so a check added here reaches
# developers and CI alike. The unit projects never start a container; `npm run
# test:integration` is CI's separate `integration-tests` job.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${PROJECT_ROOT}"

if ! command -v npm &> /dev/null; then
    echo "error: npm not found. Install Node (see .nvmrc for the pinned version)."
    exit 1
fi

# `${TMPDIR:-/tmp}` because Linux does not set it: GitHub's ubuntu runners leave it unset, and
# under `set -u` a bare `$TMPDIR` aborts the whole script before a single check runs.
LINT_TMP="${TMPDIR:-/tmp}/somnio-lint-$$"
mkdir -p "$LINT_TMP"
trap 'rm -rf "$LINT_TMP"' EXIT

# `npm ci` runs first when node_modules is absent so a fresh checkout works without a separate
# setup step.
if [ ! -d node_modules ]; then
    npm ci --no-audit --no-fund
fi

set +e
FAIL=0
(
  # Through the declared scripts, not bare `npx`: the root `package.json` is the single definition
  # of what each check runs.
  npm run format:check || exit 1
  npm run lint || exit 1
  npm run typecheck || exit 1
  npm test || exit 1
  # Deployment bound: the editor entry is dev-only, kept out of the image by never being added
  # to `build.rollupOptions.input`. A text scan of the config cannot catch an entry added via a
  # plugin hook or an editor module pulled into `dist/` by an `src/` import, so this builds for
  # real (adds ~10s) and asserts over the output. Scoped to `dist/bundle` and `dist/index.html`,
  # never `dist/` recursively — Vite copies `packages/web/public` (which may carry the multi-MB
  # dev asset pack) into the output, and the pre-commit hook must not walk it on every commit.
  npm run build || exit 1
  cd "${PROJECT_ROOT}/packages/web" || exit 1
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
) >"$LINT_TMP/checks.out" 2>&1 || { cat "$LINT_TMP/checks.out"; echo "error: Run './Scripts/format.sh' to auto-fix formatting."; FAIL=1; }
set -e

if [ $FAIL -ne 0 ]; then
    exit 1
fi

echo "Done."
