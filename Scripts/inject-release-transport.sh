#!/usr/bin/env bash
set -euo pipefail

# Player-release transport injection. Rewrites the two source files that ship the
# production gameplay endpoint and its pinned trust root, replacing the `#error`
# placeholders with real values so a release build compiles:
#
#   Sources/SomnioApp/Transport/GameplayServerURL.swift  -> gameplayProductionURL
#   Sources/SomnioApp/Transport/GameplayServerPin.swift   -> gameplayProductionTrustRootPEM
#
# Both files guard their literals behind `#if !DEBUG`, so this only matters for
# release packaging of the player; debug builds and the editor never reach here. The
# pinned roots are the committed, publicly-verifiable ISRG roots in
# Scripts/release-trust-roots.pem (Let's Encrypt) -- see that file's header.
#
# Modes:
#   (no args)   Back up the pristine sources, then inject. Fails before the backup if
#               SOMNIO_GAMEPLAY_PRODUCTION_URL is missing or not wss://.
#   --restore   Restore the backed-up sources (no-op if no backup exists). The caller
#               (Scripts/package_app.sh) runs this from an EXIT trap so a local release
#               leaves no injected endpoint behind; backup/restore (rather than
#               `git checkout`) also preserves any uncommitted local edits.
#
# This script is the single source of truth for which files are rewritten and what a
# valid production endpoint is. Running inject twice without an intervening --restore
# fails the marker asserts, by design.
#
# Env-var contract:
#   SOMNIO_GAMEPLAY_PRODUCTION_URL -- required for inject. The wss:// gameplay
#                                     endpoint, e.g. wss://somnio.tobiha.de/ws.

ROOT=$(cd "$(dirname "$0")/.." && pwd)
URL_SWIFT="$ROOT/Sources/SomnioApp/Transport/GameplayServerURL.swift"
PIN_SWIFT="$ROOT/Sources/SomnioApp/Transport/GameplayServerPin.swift"
PEM_FILE="$ROOT/Scripts/release-trust-roots.pem"
BACKUP_DIR="${TMPDIR:-/tmp}/somnio-release-transport-backup"
TARGETS=("$URL_SWIFT" "$PIN_SWIFT")

restore() {
  for f in "${TARGETS[@]}"; do
    bak="$BACKUP_DIR/$(basename "$f")"
    if [[ -f "$bak" ]]; then
      cp "$bak" "$f"
    fi
  done
  rm -rf "$BACKUP_DIR"
}

if [[ "${1:-}" == "--restore" ]]; then
  restore
  exit 0
fi

URL="${SOMNIO_GAMEPLAY_PRODUCTION_URL:-}"
if [[ -z "$URL" ]]; then
  echo "ERROR: SOMNIO_GAMEPLAY_PRODUCTION_URL is not set." >&2
  echo "       Set it to the production gameplay endpoint, e.g. wss://somnio.tobiha.de/ws." >&2
  exit 1
fi
if [[ "$URL" != wss://* ]]; then
  # Release pinning + SecureTransportValidator require TLS; fail here with a clear
  # message instead of letting the build embed a plaintext or malformed endpoint.
  echo "ERROR: SOMNIO_GAMEPLAY_PRODUCTION_URL must be a wss:// URL (got: ${URL})." >&2
  exit 1
fi

for f in "${TARGETS[@]}" "$PEM_FILE"; do
  if [[ ! -f "$f" ]]; then
    echo "ERROR: expected file not found: $f" >&2
    exit 1
  fi
done

# Embed only the certificate blocks; the committed PEM's documentation header is
# stripped so it never lands in the runtime trust-root string.
PEM_BODY=$(sed -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d' "$PEM_FILE")
if ! grep -q "BEGIN CERTIFICATE" <<<"$PEM_BODY"; then
  echo "ERROR: $PEM_FILE contains no certificate blocks." >&2
  exit 1
fi

# The opening `"""` keeps the original 4-space indent; the certificate lines and the
# closing `"""` sit at column 0 so Swift's multiline-literal indentation stripping
# leaves the PEM byte-for-byte intact.
PEM_BLOCK=$(printf '    let gameplayProductionTrustRootPEM: String = """\n%s\n"""' "$PEM_BODY")

assert_marker() {
  local file="$1" marker="$2"
  if ! grep -qF "$marker" "$file"; then
    echo "ERROR: expected marker not found in $file: $marker" >&2
    echo "       The file may already be injected, or its structure changed." >&2
    exit 1
  fi
}

assert_marker "$URL_SWIFT" '#error('
assert_marker "$URL_SWIFT" 'let gameplayProductionURL: String = ""'
assert_marker "$PIN_SWIFT" '#error('
assert_marker "$PIN_SWIFT" 'let gameplayProductionTrustRootPEM: String = ""'

# Back up the pristine sources before the first edit so --restore can recover them.
mkdir -p "$BACKUP_DIR"
for f in "${TARGETS[@]}"; do
  cp "$f" "$BACKUP_DIR/$(basename "$f")"
done

# Values reach perl through the environment so URL/PEM contents never land in the
# program text -- no shell/sed metacharacter or multiline-quoting hazards. Perl does
# not re-interpolate a variable's value, so `$`/`@` inside the data are inert.
URL="$URL" perl -i -pe '
  s/^\s*#error\(.*\n//;
  s/(let gameplayProductionURL: String = )""/$1 . "\"" . $ENV{URL} . "\""/e;
' "$URL_SWIFT"

PEM_BLOCK="$PEM_BLOCK" perl -i -pe '
  s/^\s*#error\(.*\n//;
  s/^\s*let gameplayProductionTrustRootPEM: String = ""$/$ENV{PEM_BLOCK}/;
' "$PIN_SWIFT"

if grep -qF '#error(' "$URL_SWIFT" || grep -qF '#error(' "$PIN_SWIFT"; then
  echo "ERROR: a #error directive survived injection." >&2
  exit 1
fi
if ! grep -qF "let gameplayProductionURL: String = \"$URL\"" "$URL_SWIFT"; then
  echo "ERROR: production URL was not injected into $URL_SWIFT." >&2
  exit 1
fi

cert_count=$(grep -c 'BEGIN CERTIFICATE' "$PIN_SWIFT")
echo "Transport injection: URL=${URL}, pinned ${cert_count} root certificate(s)."
