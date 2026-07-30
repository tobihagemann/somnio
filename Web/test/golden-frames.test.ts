import { describe, expect, it } from 'vitest'
import goldenFrames from '@fixtures/golden-frames.json'
import { SOMNIO_MESSAGE_TAGS, decodeSomnioMessage, encodeSomnioMessage } from '@/protocol'
import type { SomnioMessage } from '@/protocol'

/**
 * The TypeScript half of the cross-language golden-frame invariant.
 *
 * The fixture is read **through the Swift tree** via the `@fixtures` alias, not from a copy under
 * `Web/`. That is the entire point: the Swift side pins `SomnioMessageEncoder`'s output against
 * this same file, so the two sides are connected through one artifact. A forked copy would make
 * each side self-consistent and let a renamed Swift property drift past both.
 *
 * What this catches that nothing else does: a payload **property rename**. The Swift round-trip
 * suite encodes and decodes with the same renamed property and stays green; the browser's own
 * codec suite mirrors only itself. Only a shared fixture notices.
 */

const frames = goldenFrames as Record<string, { tag: string; payload: unknown }>

/** Sorts object keys recursively so the comparison is over structure, not member order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])])
    )
  }
  return value
}

describe('golden frames', () => {
  const names = Object.keys(frames).sort()

  /**
   * Tag coverage rather than a count, so extra shape-coverage fixtures (a second `login` with the
   * optional session field set) do not need to be double-counted.
   *
   * This subsumes the "not empty" check that used to sit beside it: a lost fixture file leaves every
   * tag missing, so it cannot pass vacuously. The old `> 20` threshold was also decoupled from
   * `SOMNIO_MESSAGE_TAGS.length`, so adding a tag never tightened it.
   */
  it('covers every tag in the union', () => {
    const covered = new Set(Object.values(frames).map((frame) => frame.tag))
    const missing = SOMNIO_MESSAGE_TAGS.filter((tag) => !covered.has(tag))
    expect(missing).toEqual([])
  })

  /**
   * Decode then re-encode, and compare canonicalised structure. Byte comparison would be wrong,
   * not merely strict: the Swift encoder uses a bare `JSONEncoder()` with no `.sortedKeys`, so
   * member order is unspecified and is not part of the wire contract.
   */
  it.each(names)('%s survives a decode/re-encode round trip unchanged', (name) => {
    const frame = frames[name]!
    const decoded: SomnioMessage = decodeSomnioMessage(JSON.stringify(frame))
    const reencoded: unknown = JSON.parse(encodeSomnioMessage(decoded))
    expect(canonicalize(reencoded)).toEqual(canonicalize(frame))
  })

  /**
   * The optional session-token field must survive its two distinct states through the fixture:
   * absent stays absent, and present stays present. A decoder that materialised a default would
   * pass the round trip above while silently changing what a pre-token client's frame means.
   */
  it('preserves the absence of the optional session-token request', () => {
    const plain = frames['login']!
    expect('requestSessionToken' in (plain.payload as object)).toBe(false)
    const reencoded = JSON.parse(encodeSomnioMessage(decodeSomnioMessage(JSON.stringify(plain))))
    expect('requestSessionToken' in (reencoded as { payload: object }).payload).toBe(false)
  })

  it('preserves an explicit session-token request', () => {
    const requesting = frames['login-with-session-request']!
    expect((requesting.payload as { requestSessionToken: boolean }).requestSessionToken).toBe(true)
  })

  /** The nested sector fixture is what gives `WireObject.rotation` and the NPC float heading cover. */
  it('carries a fully populated nested sector', () => {
    const sector = (frames['enterSector']!.payload as { sector: Record<string, unknown[]> }).sector
    for (const key of ['objects', 'collisionMasks', 'portals', 'npcs', 'monsterSpawns', 'floorPatches']) {
      expect(sector[key]!.length).toBeGreaterThan(0)
    }
  })
})
