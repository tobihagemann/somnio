import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SOMNIO_MESSAGE_TAGS, decodeSomnioMessage, encodeSomnioMessage } from '../src/index.ts'
import type { SomnioMessage } from '../src/index.ts'
import { GOLDEN_FRAMES_PATH } from './support/fixtures.ts'
import { GOLDEN_FRAME_ENTRIES } from './support/goldenFrameCatalog.ts'

/**
 * The golden-frame invariant: the encoder's output for every catalog entry is pinned against a
 * committed file, and every committed fixture decodes through the real decoder.
 *
 * What this catches that nothing else does: a payload **property rename**. The round-trip suite
 * encodes and decodes with the same renamed property and stays green; only a fixture written
 * before the rename notices. Regenerate deliberately with `SOMNIO_RECORD_GOLDEN_FRAMES=1` and read
 * the diff before committing — a surprising diff means the wire format moved.
 */

const committed = JSON.parse(readFileSync(GOLDEN_FRAMES_PATH, 'utf8')) as Record<
  string,
  { tag: string; payload: unknown }
>

/**
 * Sorts object keys recursively so the comparison is over structure, not member order — the
 * encoder's key order is not part of the wire contract. Numbers compare after `Math.fround`,
 * because the Float32 fields (`facing`, NPC `direction`) are equal as Float32 values, not as
 * decimal strings: `0.10000000149011612` and `0.1` are the same `Float`.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])])
    )
  }
  if (typeof value === 'number') return Math.fround(value)
  return value
}

function recordedFrames(): Record<string, unknown> {
  return Object.fromEntries(
    GOLDEN_FRAME_ENTRIES.map((entry) => [entry.name, JSON.parse(encodeSomnioMessage(entry.message))])
  )
}

describe('golden frames', () => {
  it('covers every tag in the union', () => {
    const covered = new Set(GOLDEN_FRAME_ENTRIES.map((entry) => entry.message.tag))
    const missing = SOMNIO_MESSAGE_TAGS.filter((tag) => !covered.has(tag))
    expect(missing).toEqual([])
    const names = new Set(GOLDEN_FRAME_ENTRIES.map((entry) => entry.name))
    expect(names.size, 'duplicate fixture name').toBe(GOLDEN_FRAME_ENTRIES.length)
  })

  it('encoder output matches the committed fixtures', () => {
    const recorded = recordedFrames()
    if (process.env.SOMNIO_RECORD_GOLDEN_FRAMES === '1') {
      writeFileSync(GOLDEN_FRAMES_PATH, JSON.stringify(canonicalize(recorded), null, 2))
      throw new Error('golden frames re-recorded; review the diff and commit golden-frames.json')
    }
    for (const entry of GOLDEN_FRAME_ENTRIES) {
      const expected = committed[entry.name]
      expect(
        expected,
        `missing fixture "${entry.name}" — re-record with SOMNIO_RECORD_GOLDEN_FRAMES=1`
      ).toBeDefined()
      expect(canonicalize(recorded[entry.name]), `golden frame "${entry.name}" drifted`).toEqual(
        canonicalize(expected)
      )
    }
  })

  it.each(Object.keys(committed).sort())(
    '%s decodes through the real decoder and re-encodes unchanged',
    (name) => {
      const frame = committed[name]!
      const decoded: SomnioMessage = decodeSomnioMessage(JSON.stringify(frame))
      const reencoded: unknown = JSON.parse(encodeSomnioMessage(decoded))
      expect(canonicalize(reencoded)).toEqual(canonicalize(frame))
    }
  )

  /**
   * The optional session-token field must survive its two distinct states through the fixture:
   * absent stays absent, and present stays present. A decoder that materialised a default would
   * pass the canonicalized comparison while silently changing what a pre-token client's frame means.
   */
  it('preserves the absence of the optional session-token request', () => {
    const plain = committed['login']!
    expect('requestSessionToken' in (plain.payload as object)).toBe(false)
    const reencoded = JSON.parse(encodeSomnioMessage(decodeSomnioMessage(JSON.stringify(plain))))
    expect('requestSessionToken' in (reencoded as { payload: object }).payload).toBe(false)
  })

  it('preserves an explicit session-token request', () => {
    const requesting = committed['login-with-session-request']!
    expect((requesting.payload as { requestSessionToken: boolean }).requestSessionToken).toBe(true)
  })

  /** The nested sector fixture is what gives `WireObject.rotation` and the NPC float heading cover. */
  it('carries a fully populated nested sector', () => {
    const sector = (committed['enterSector']!.payload as { sector: Record<string, unknown[]> }).sector
    for (const key of ['objects', 'collisionMasks', 'portals', 'npcs', 'monsterSpawns', 'floorPatches']) {
      expect(sector[key]!.length).toBeGreaterThan(0)
    }
  })
})
