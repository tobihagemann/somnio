#!/bin/bash
set -euo pipefail

# Somnio auto-format script
# Usage:
#   ./Scripts/format.sh   # Prettier --write, ESLint --fix

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${PROJECT_ROOT}"

if ! command -v npm &> /dev/null; then
    echo "error: npm not found. Install Node (see .nvmrc for the pinned version)."
    exit 1
fi

if [ ! -d node_modules ]; then
  npm ci --no-audit --no-fund
fi

echo "Formatting..."
# Through the declared scripts, so the root `package.json` stays the one definition of what
# each check runs.
npm run format
npm run lint:fix

echo "Done."
