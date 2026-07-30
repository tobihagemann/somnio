import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { externalResourcePaths, readGLTF, uriToPath } from '@scripts/glb-buffer-uris.mjs'

/**
 * `Scripts/glb-buffer-uris.mjs` — the enumerator behind `bundle-web-assets.sh`'s
 * self-containment gate.
 *
 * It lives outside `Web/` and is reached through the `@scripts` alias rather than being relocated:
 * the script is a build-tool sibling of `bundle-web-assets.sh` and belongs beside it, the same way
 * the model registry and the `.xcstrings` catalogs are read out of `Sources/` rather than copied in.
 * Reaching a hand-written `.mjs` with no declaration file is also why `tsconfig.json` sets
 * `allowJs` — its exports arrive here as `any`, so the assertions below are the only contract on
 * its shape.
 *
 * Tested here because its consumer cannot tell it apart from a clean result: the gate's whole
 * output is "printed nothing", which is also what a crashed or mis-parsing enumerator produces.
 * The shell side now propagates a non-zero exit; these cases are what pin the *answers* it gives
 * when it does run. The Python twin (`Pipeline/glb_buffer_uris.py`) has a suite over the same
 * branches on the producing side.
 */

/** A binary GLB: the 12-byte header, then a JSON chunk header, then the document. */
function binaryGLB(document: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(document), 'utf8')
  // Chunks are 4-byte aligned and JSON chunks pad with spaces, which is what a real exporter emits.
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)])
  const header = Buffer.alloc(20)
  header.writeUInt32LE(0x46546c67, 0) // 'glTF'
  header.writeUInt32LE(2, 4) // version
  header.writeUInt32LE(20 + padded.length, 8) // total length
  header.writeUInt32LE(padded.length, 12) // chunk length
  header.writeUInt32LE(0x4e4f534a, 16) // 'JSON'
  return Buffer.concat([header, padded])
}

describe('glb-buffer-uris', () => {
  let directory: string

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'somnio-glb-'))
  })

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  function write(name: string, contents: Buffer | string): string {
    const path = join(directory, name)
    writeFileSync(path, contents)
    return path
  }

  describe('readGLTF', () => {
    it('reads the JSON chunk out of a binary GLB', () => {
      const path = write('binary.glb', binaryGLB({ asset: { version: '2.0' }, buffers: [{ byteLength: 4 }] }))

      expect(readGLTF(path)).toEqual({ asset: { version: '2.0' }, buffers: [{ byteLength: 4 }] })
    })

    it('reads a JSON glTF carrying a .glb extension', () => {
      // Legal, and the case the gate exists for: a pipeline change that stopped embedding would
      // keep the filename while moving the geometry into a sibling file.
      const path = write(
        'json.glb',
        JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'geo.bin' }] })
      )

      expect(readGLTF(path)).toEqual({ asset: { version: '2.0' }, buffers: [{ uri: 'geo.bin' }] })
    })
  })

  describe('externalResourcePaths', () => {
    it('finds nothing in a self-contained binary GLB', () => {
      // Every model in today's pack. An embedded buffer has no `uri` at all.
      expect(externalResourcePaths({ buffers: [{ byteLength: 128 }] })).toEqual([])
    })

    it('skips data: URIs, which need no separate file', () => {
      expect(
        externalResourcePaths({
          buffers: [{ uri: 'data:application/octet-stream;base64,AAAA' }],
          images: [{ uri: 'data:image/png;base64,AAAA' }],
        })
      ).toEqual([])
    })

    it('reports images as well as buffers', () => {
      // The image half is the one that is easy to miss: a missing texture still renders geometry,
      // so the failure reads as a mis-authored material rather than as an incomplete pack.
      expect(externalResourcePaths({ images: [{ uri: 'skin.png' }] })).toEqual(['skin.png'])
    })

    it('reports buffers before images', () => {
      // The caller names the first missing reference, and geometry is the one that makes a model
      // unloadable rather than merely untextured.
      expect(externalResourcePaths({ images: [{ uri: 'skin.png' }], buffers: [{ uri: 'geo.bin' }] })).toEqual(
        ['geo.bin', 'skin.png']
      )
    })

    it('tolerates a document with neither array', () => {
      expect(externalResourcePaths({})).toEqual([])
    })

    it('prints each URI decoded, as the path its consumer opens', () => {
      // glTF 2.0 *requires* `uri` to be URI-encoded, so this is the correct spelling of a file
      // named `hero mesh.bin`. Printing the raw string failed the image build on a correct pack.
      expect(externalResourcePaths({ buffers: [{ uri: 'hero%20mesh.bin' }] })).toEqual(['hero mesh.bin'])
    })
  })

  describe('uriToPath', () => {
    it('leaves a plain relative URI alone', () => {
      expect(uriToPath('textures/skin.png')).toBe('textures/skin.png')
    })

    it('folds backslashes, as both consumers do', () => {
      expect(uriToPath('textures\\skin.png')).toBe('textures/skin.png')
    })

    it('decodes a multi-byte UTF-8 escape sequence', () => {
      expect(uriToPath('Gepr%C3%A4ge.bin')).toBe('Gepräge.bin')
    })

    it('leaves a malformed escape alone rather than throwing', () => {
      // `decodeURIComponent` raises `URIError` here. Mirroring Python's `unquote`, which passes an
      // undecodable sequence through: this is a gate, so an unparseable URI has to be *reported*
      // as a missing file, not crash the build before any model is checked.
      expect(uriToPath('bad%zz.bin')).toBe('bad%zz.bin')
      expect(uriToPath('truncated%C3')).toBe('truncated%C3')
    })
  })
})
