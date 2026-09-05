#!/usr/bin/env bash
set -euo pipefail

# Web asset bundling step. Composes the browser client's served asset root from the
# operator-supplied pack. The asset pack itself is never committed (it lives on the
# build machine or is checked out by CI from the private somnio-assets repo).
#
# Env-var contract:
#   SOMNIO_ASSET_SOURCE   — required. Absolute path to the asset root. Geometry comes from
#                           Web/Models/ (glTF); textures from the *root* FloorMaterials/
#                           and UI/, which are already web-native PNGs and are therefore
#                           not duplicated under Web/.
#   SOMNIO_WEB_ASSET_DEST — required. Directory that becomes `/assets` on the served
#                           site. Normally `packages/web/dist/assets`.
#
# Why the destination is `assets/` and the Vite bundle lives in `bundle/`: the client
# references models and textures by absolute `/assets/...` URLs (the model loader's
# baseURL and the CSS `border-image-source`), so this subtree has to sit at a stable
# path that hashed build output never shares. `packages/web/vite.config.ts` sets
# `build.assetsDir: 'bundle'` for exactly this reason — keep the two in step.

if [[ -z "${SOMNIO_WEB_ASSET_DEST:-}" ]]; then
  echo "ERROR: SOMNIO_WEB_ASSET_DEST is not set." >&2
  echo "       Set it to the directory that should be served as /assets (e.g. packages/web/dist/assets)." >&2
  exit 1
fi

if [[ -z "${SOMNIO_ASSET_SOURCE:-}" ]]; then
  echo "ERROR: Web asset bundling: SOMNIO_ASSET_SOURCE is not set." >&2
  echo "       The browser client cannot render without the asset pack." >&2
  echo "       Point it at the somnio-assets checkout, e.g.:" >&2
  echo "         SOMNIO_ASSET_SOURCE=/path/to/somnio-assets SOMNIO_WEB_ASSET_DEST=packages/web/dist/assets \\" >&2
  echo "           Scripts/bundle-web-assets.sh" >&2
  exit 1
fi

SRC="${SOMNIO_ASSET_SOURCE%/}"
DEST="${SOMNIO_WEB_ASSET_DEST%/}"

# `source-subdir:dest-subdir:required` triples. Models/ and FloorMaterials/ warn rather
# than fail so an in-progress pack still yields a loadable page — the model loader
# renders placeholders and the floor falls back to an untextured plane. UI/ is a hard
# failure: the panel chrome has no designed fallback, and every panel would render as an
# unstyled box.
SUBTREES=(
  "Web/Models:Models:optional"
  "FloorMaterials:FloorMaterials:optional"
  "UI:UI:required"
)

for entry in "${SUBTREES[@]}"; do
  IFS=: read -r from to requirement <<< "$entry"
  src="${SRC}/${from}"
  dest="${DEST}/${to}"
  if [[ ! -d "$src" ]]; then
    if [[ "$requirement" == "required" ]]; then
      echo "ERROR: Web asset bundling: required subtree '${from}' missing at ${src}." >&2
      echo "       The browser client needs the UI chrome textures (somnio-assets UI/ subtree)." >&2
      exit 1
    fi
    echo "WARN: Web asset bundling: subtree '${from}' missing at ${src}; skipping."
    continue
  fi
  # Replace rather than merge. `cp -a` only ever adds, so an asset dropped from the pack would
  # keep being served out of a previous bundle — and inside the image build, out of a cached
  # layer — which reads as the pack still carrying a model the source no longer has.
  rm -rf "$dest"
  mkdir -p "$dest"
  # `cp -a`, not rsync: this script also runs inside the web image's slim build stage, which
  # carries neither rsync nor python3, and with the destination cleared above rsync's --delete
  # would add nothing.
  cp -a "${src}/." "${dest}/"
done

# Self-containment check. Today's pack is entirely single-file binary GLBs, so this finds
# nothing — it guards the conversion pipeline rather than the current output. A JSON glTF can
# point at an external buffer or image, and three.js resolves either URI relative to the model URL
# at load time, so a pipeline change that started emitting one would serve a 404 for the geometry
# or the texture — visible only as a missing or untextured character at runtime, which is why it is
# caught here instead.
#
# The enumerator's interpreter is verified up front rather than discovered mid-loop: without the
# check the failure is a run of `node: command not found` lines against a gate that reported
# nothing wrong.
if [[ -d "${DEST}/Models" ]]; then
  if ! command -v node > /dev/null 2>&1; then
    echo "ERROR: Web asset bundling: 'node' is not on PATH." >&2
    echo "       Scripts/glb-buffer-uris.mjs enumerates each model's external references, and" >&2
    echo "       without it the pack would ship unverified. Install the Node version in .nvmrc." >&2
    exit 1
  fi
  missing=0
  while IFS= read -r -d '' model; do
    # Captured into a variable rather than read through `< <(...)`. A process substitution
    # discards its child's exit status and `set -euo pipefail` does not reach inside one, so an
    # enumerator that dies — a syntax error, a missing Node, an unparseable glTF — would produce
    # an empty read, leave `missing` at 0, and let the script print its success summary with the
    # gate silently dead. A command substitution in a plain assignment *does* propagate under `set -e`,
    # which is what makes "this model declares no external URIs" distinguishable from "the
    # enumerator never ran".
    uris="$(node "$(dirname "${BASH_SOURCE[0]}")/glb-buffer-uris.mjs" "$model")"
    while IFS= read -r uri; do
      [[ -z "$uri" ]] && continue
      if [[ ! -f "$(dirname "$model")/${uri}" ]]; then
        echo "ERROR: $(basename "$model") references '${uri}', which is not in the pack." >&2
        missing=$((missing + 1))
      fi
    done <<< "$uris"
  done < <(find "${DEST}/Models" -type f -name '*.glb' -print0)
  if [[ $missing -gt 0 ]]; then
    echo "ERROR: Web asset bundling: ${missing} model(s) reference a file the pack does not carry." >&2
    exit 1
  fi
fi

summary=()
for entry in "${SUBTREES[@]}"; do
  IFS=: read -r _from to _requirement <<< "$entry"
  dest="${DEST}/${to}"
  if [[ -d "$dest" ]]; then
    count=$(find "$dest" -type f | wc -l | tr -d ' ')
  else
    count=0
  fi
  lower=$(printf '%s' "$to" | tr '[:upper:]' '[:lower:]')
  summary+=("${count} ${lower}")
done
echo "Web asset bundling: copied ${summary[*]} into ${DEST}."
