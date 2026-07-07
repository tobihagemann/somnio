#!/usr/bin/env bash
# Kill running instances, package, relaunch, verify.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/version.env"

EXEC_NAME=${EXEC_NAME:-Somnio}
APP_BUNDLE="${ROOT_DIR}/${APP_NAME}.app"
APP_PROCESS_PATTERN="${APP_NAME}.app/Contents/MacOS/${EXEC_NAME}"
DEBUG_PROCESS_PATTERN="${ROOT_DIR}/.build/debug/${EXEC_NAME}"
RELEASE_PROCESS_PATTERN="${ROOT_DIR}/.build/release/${EXEC_NAME}"
RUN_TESTS=0
RELEASE_ARCHES=""

log() { printf '%s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

for arg in "$@"; do
  case "${arg}" in
    --test|-t) RUN_TESTS=1 ;;
    --release-universal) RELEASE_ARCHES="arm64 x86_64" ;;
    --release-arches=*) RELEASE_ARCHES="${arg#*=}" ;;
    --help|-h)
      log "Usage: $(basename "$0") [--test] [--release-universal] [--release-arches=\"arm64 x86_64\"]"
      log "  Default builds debug (loopback, honors SOMNIO_SERVER_URL). The --release-* flags build"
      log "  release config, which requires SOMNIO_GAMEPLAY_PRODUCTION_URL."
      exit 0
      ;;
  esac
done

# Fail before any build time is spent: package_app.sh's asset step hard-requires the
# pack for the player bundle (its UI/ subtree styles every panel).
if [[ -z "${SOMNIO_ASSET_SOURCE:-}" ]]; then
  fail "SOMNIO_ASSET_SOURCE is not set. Point it at the somnio-assets checkout (the sibling repo carrying Models/, FloorMaterials/, and UI/), e.g. SOMNIO_ASSET_SOURCE=\"\$HOME/Developer/github.com/tobihagemann/somnio-assets\" $(basename "$0")"
fi

log "==> Killing existing ${APP_NAME} instances"
pkill -f "${APP_PROCESS_PATTERN}" 2>/dev/null || true
pkill -f "${DEBUG_PROCESS_PATTERN}" 2>/dev/null || true
pkill -f "${RELEASE_PROCESS_PATTERN}" 2>/dev/null || true
pkill -x "${EXEC_NAME}" 2>/dev/null || true

if [[ "${RUN_TESTS}" == "1" ]]; then
  log "==> swift test"
  swift test -q
fi

HOST_ARCH="$(uname -m)"
ARCHES_VALUE="${HOST_ARCH}"
# Default to a debug build: it compiles the `#if DEBUG` transport path (loopback,
# honors SOMNIO_SERVER_URL) and so needs no production endpoint. A universal/multi-arch
# build is a release-distribution concern, so the --release-* flags also select release
# config, which compiles the `#if !DEBUG` literals and therefore requires
# SOMNIO_GAMEPLAY_PRODUCTION_URL (see package_app.sh).
CONF="debug"
if [[ -n "${RELEASE_ARCHES}" ]]; then
  ARCHES_VALUE="${RELEASE_ARCHES}"
  CONF="release"
fi

log "==> package app (${CONF})"
SIGNING_MODE=adhoc ARCHES="${ARCHES_VALUE}" "${ROOT_DIR}/Scripts/package_app.sh" "${CONF}"

log "==> launch app"
if ! open "${APP_BUNDLE}"; then
  log "WARN: open failed; launching binary directly."
  "${APP_BUNDLE}/Contents/MacOS/${EXEC_NAME}" >/dev/null 2>&1 &
  disown
fi

for _ in {1..10}; do
  if pgrep -f "${APP_PROCESS_PATTERN}" >/dev/null 2>&1; then
    log "OK: ${APP_NAME} is running."
    exit 0
  fi
  sleep 0.4
done
fail "App exited immediately. Check crash logs in Console.app (User Reports)."
