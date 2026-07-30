#!/bin/bash
set -euo pipefail

# Somnio auto-format script
# Usage:
#   ./Scripts/format.sh          # everything: Swift + browser client
#   ./Scripts/format.sh --swift  # Swift only  (SwiftFormat, SwiftLint --fix)
#   ./Scripts/format.sh --web    # browser only (Prettier, ESLint --fix)
#
# Scoped the same way as lint.sh, and for the same reason its own error message depends on: when
# `./Scripts/lint.sh --web` fails a Prettier check it tells the reader to run this script, and on a
# machine with Node but no Swift toolchain an unscoped run would exit at `check_tool swiftformat`
# before reaching `npm run format`. Only the selected scope's tools are required.

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
if [ $RUN_SWIFT -eq 1 ]; then
    check_tool swiftformat
    check_tool swiftlint
fi
# Mirrors lint.sh: a missing web toolchain fails loudly rather than skipping silently.
if [ $RUN_WEB -eq 1 ]; then
    check_tool npm
fi

if [ $RUN_SWIFT -eq 1 ]; then
    echo "Formatting all files..."
    swiftformat .

    echo "Linting (autocorrect)..."
    swiftlint lint --fix --quiet
    # Second pass from the sibling package, mirroring lint.sh: SwiftLint's SPM-aware test-target
    # detection only works when invoked from the package that declares the target, so a violation in
    # IntegrationTests/ is reported by `lint.sh --swift` and would go unfixed here without this.
    (cd "${PROJECT_ROOT}/IntegrationTests" && swiftlint lint --fix --quiet)
fi

if [ $RUN_WEB -eq 1 ]; then
    echo "Formatting the browser client..."
    (
      cd "${PROJECT_ROOT}/Web"
      if [ ! -d node_modules ]; then
        npm ci --no-audit --no-fund
      fi
      # Through the declared scripts, as lint.sh does, so `Web/package.json` stays the one definition
      # of what each check runs.
      npm run format
      npm run lint:fix
    )
fi

echo "Done."
