#!/usr/bin/env node
// Lists the external resource URIs a glTF/GLB file references, one per line.
//
// A self-contained binary GLB embeds its buffer and prints nothing, which is what every model in
// today's pack does. A JSON glTF — including one carrying a `.glb` extension, which is legal and
// which a pipeline change could start emitting — prints each `buffers[].uri` and `images[].uri`
// that is not a data URI, so `bundle-web-assets.sh` can verify the sidecar shipped: three.js
// resolves both kinds relative to the model URL at load time, and a missing one is a runtime 404
// for the model's geometry or its texture.
//
// Both arrays, because glTF 2.0 declares external file references nowhere else — the pair is the
// whole surface, not a sample of it. The asset repo's `Pipeline/glb_buffer_uris.py` walks the same
// two for the producing side.
//
// **Each URI is printed as a path, not as the URI it was authored as.** glTF 2.0 *requires* `uri`
// to be URI-encoded, so a pack correctly shipping `hero mesh.bin` declares it as `hero%20mesh.bin`
// — and the caller interpolates whatever this prints straight into a `[[ -f ... ]]` test, while
// nginx percent-decodes the request before hitting the filesystem. Printing the raw string
// therefore fails the build on a correct pack, and — in the mirror-image arrangement — passes a
// pack whose file really is named with a literal `%20`, which the served client then 404s. So the
// normalization here has to be the consumer's: fold backslashes, then percent-decode, mirroring
// Blender's `io/com/path.py:uri_to_path` and the Python twin's `escapes_directory`, which decodes
// for exactly the same reason (a check that normalized differently from the consumer would pass
// strings the consumer still escapes with).
//
// Node rather than Python because the only places this runs — a developer's web build and the
// `Web/Dockerfile` build stage — are guaranteed to have Node and are not guaranteed to have
// Python. The asset repo keeps its own Python copy for the producing side; this repo is public and
// cannot import from that one.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const GLB_MAGIC = 0x46546c67 // 'glTF'

/** Parses either container: a binary GLB's first (JSON) chunk, or a plain JSON glTF document. */
export function readGLTF(path) {
  const bytes = readFileSync(path)
  if (bytes.length >= 12 && bytes.readUInt32LE(0) === GLB_MAGIC) {
    const chunkLength = bytes.readUInt32LE(12)
    return JSON.parse(bytes.subarray(20, 20 + chunkLength).toString('utf8'))
  }
  return JSON.parse(bytes.toString('utf8'))
}

/**
 * A declared `uri` as the filesystem path its consumer will open.
 *
 * Backslashes fold to `/` first (a Windows-authored exporter writes them, and both Blender and
 * three.js treat them as separators), then percent-escapes decode. Decoding runs per *run* of
 * escapes with a fallback, mirroring Python's `unquote`, which leaves a malformed sequence such as
 * `%zz` alone rather than raising: this is a gate, and a URI it cannot decode must still be
 * reported as missing rather than crashing the build with a `URIError`.
 */
export function uriToPath(uri) {
  return uri.replace(/\\/g, '/').replace(/(?:%[0-9A-Fa-f]{2})+/g, (escapes) => {
    try {
      return decodeURIComponent(escapes)
    } catch {
      return escapes
    }
  })
}

/**
 * The external file paths `document` declares, in `buffers` then `images` order.
 *
 * The order is part of the contract rather than incidental: the caller reports the first missing
 * reference it reads, so a model missing both its geometry and its texture names the geometry —
 * the one that makes the model unloadable rather than merely untextured.
 */
export function externalResourcePaths(document) {
  const paths = []
  for (const declared of [...(document.buffers ?? []), ...(document.images ?? [])]) {
    // An embedded resource has no `uri`; a data: URI needs no separate file.
    if (declared.uri && !declared.uri.startsWith('data:')) paths.push(uriToPath(declared.uri))
  }
  return paths
}

/**
 * Guarded so the module can be imported by the test suite without running the CLI.
 *
 * `process.argv[1]` is the script Node was handed; comparing it to this file's own path is what
 * distinguishes `node glb-buffer-uris.mjs model.glb` from an `import` of the same file, where
 * `argv[1]` is the test runner and the CLI must stay silent (it would otherwise read `argv[2]` —
 * a Vitest argument — and `process.exit(2)` out of the suite).
 */
const invokedAsCLI =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedAsCLI) {
  const path = process.argv[2]
  if (path === undefined) {
    console.error('usage: glb-buffer-uris.mjs <model.glb>')
    process.exit(2)
  }
  for (const resourcePath of externalResourcePaths(readGLTF(path))) console.log(resourcePath)
}
