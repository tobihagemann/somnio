import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LOGIN_RESULT,
  REGISTER_RESULT,
  WIRE_ENTITY_TYPE,
  WIRE_HAND,
  OversizedFrameError,
  SOMNIO_PROTOCOL_CONSTANTS,
  UnrecognizedTagError,
  WireDecodingError,
  decodeSomnioMessage,
  encodeSomnioMessage,
  MAX_WIRE_FRAME_SIZE,
  truncateToUTF8Bytes,
  utf8ByteLength,
} from '@/protocol'
import type { SomnioMessage } from '@/protocol'
import { CHARACTER_CLASS, GENDER, TEMPO } from '@/core'
import { swiftEnumCases } from './helpers/swiftEnum'

/**
 * Mirrors `Tests/SomnioProtocolTests/RoundTripTests.swift` and `WireFrameLimitsTests.swift`
 * with the same values, plus the rejections that only exist on this side: TypeScript types
 * are erased, so the runtime validators are the only thing standing in for Swift `Codable`'s
 * decode-time enforcement.
 */

function roundTrip(message: SomnioMessage): SomnioMessage {
  return decodeSomnioMessage(encodeSomnioMessage(message))
}

describe('frame limits', () => {
  it('holds the WS frame ceiling strictly above the encoder guard', () => {
    expect(MAX_WIRE_FRAME_SIZE).toBeGreaterThan(SOMNIO_PROTOCOL_CONSTANTS.maxFrameLength)
  })

  it('rejects an outbound message larger than maxFrameLength', () => {
    const oversized = 'x'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxFrameLength + 1)
    expect(() => encodeSomnioMessage({ tag: 'adminSay', payload: { text: oversized } })).toThrow(
      OversizedFrameError
    )
  })

  it('encodes a max-bounded message without tripping the guard', () => {
    const frame = encodeSomnioMessage({ tag: 'adminSay', payload: { text: 'well within bounds' } })
    expect(utf8ByteLength(frame)).toBeLessThanOrEqual(SOMNIO_PROTOCOL_CONSTANTS.maxFrameLength)
  })

  /**
   * The browser `WebSocket` has no `maxFrameSize` knob, so an inbound cap the Swift transport
   * gets from the WS layer has to be enforced in the decoder. Without this the oversized case
   * in the server-facing conformance suite passes while the browser accepts the frame.
   */
  it('rejects an inbound frame larger than maxFrameLength', () => {
    const frame = `{"tag":"adminSay","payload":{"text":"${'a'.repeat(
      SOMNIO_PROTOCOL_CONSTANTS.maxFrameLength
    )}"}}`
    expect(() => decodeSomnioMessage(frame)).toThrow(OversizedFrameError)
  })
})

describe('tag discrimination', () => {
  it('throws on an unrecognized tag', () => {
    expect(() => decodeSomnioMessage('{"tag":"notAVerb","payload":{}}')).toThrow(UnrecognizedTagError)
  })

  it('throws on malformed JSON', () => {
    expect(() => decodeSomnioMessage('{ not json')).toThrow(WireDecodingError)
  })

  it('throws on a zero-byte frame', () => {
    expect(() => decodeSomnioMessage('')).toThrow(WireDecodingError)
  })

  it('throws on a known tag with a malformed payload', () => {
    expect(() => decodeSomnioMessage('{"tag":"clientPosition","payload":{}}')).toThrow(WireDecodingError)
  })
})

describe('runtime validation the erased types cannot do', () => {
  it('rejects a missing required field', () => {
    const frame = '{"tag":"dateTick","payload":{"hour":12}}'
    expect(() => decodeSomnioMessage(frame)).toThrow(/minute: expected Int16, got nothing/)
  })

  it('rejects an out-of-range integer', () => {
    const frame = '{"tag":"dateTick","payload":{"hour":40000,"minute":0}}'
    expect(() => decodeSomnioMessage(frame)).toThrow(/Int16 out of range: 40000/)
  })

  it('rejects a fractional value where Swift decodes an integer', () => {
    const frame = '{"tag":"dateTick","payload":{"hour":12.5,"minute":0}}'
    expect(() => decodeSomnioMessage(frame)).toThrow(/fractional 12.5/)
  })

  it('rejects an unknown enum raw value', () => {
    const frame = '{"tag":"loginResult","payload":{"result":9}}'
    expect(() => decodeSomnioMessage(frame)).toThrow(/unknown raw value 9/)
  })

  it('rejects a wrong JSON type', () => {
    const frame = '{"tag":"adminSay","payload":{"text":42}}'
    expect(() => decodeSomnioMessage(frame)).toThrow(/expected a string, got number/)
  })

  it('rejects a non-object payload', () => {
    expect(() => decodeSomnioMessage('{"tag":"adminSay","payload":"hi"}')).toThrow(WireDecodingError)
  })
})

describe('round trips', () => {
  const headings = [0.0, 137.5, 359.96875]

  it.each(headings)('client position round-trips heading %s exactly', (heading) => {
    const message: SomnioMessage = {
      tag: 'clientPosition',
      payload: { entityIndex: 0, x: 10, y: 20, facing: heading, tempo: 2 },
    }
    expect(roundTrip(message)).toEqual(message)
  })

  it.each(headings)('server position round-trips heading %s exactly', (heading) => {
    const message: SomnioMessage = {
      tag: 'serverPosition',
      payload: { entityIndex: 7, x: 10, y: 20, facing: heading, tempo: 2 },
    }
    expect(roundTrip(message)).toEqual(message)
  })

  it('login round-trips without the optional token request', () => {
    const message: SomnioMessage = {
      tag: 'login',
      payload: { nickname: 'Saibot', password: 'hunter2' },
    }
    const decoded = roundTrip(message)
    expect(decoded).toEqual(message)
    expect('requestSessionToken' in decoded.payload).toBe(false)
  })

  it('login round-trips with the optional token request set', () => {
    const message: SomnioMessage = {
      tag: 'login',
      payload: { nickname: 'Saibot', password: 'hunter2', requestSessionToken: true },
    }
    expect(roundTrip(message)).toEqual(message)
  })

  it('enter sector round-trips a fully populated sector', () => {
    const message: SomnioMessage = {
      tag: 'enterSector',
      payload: {
        sector: {
          name: 'EdariaArena',
          version: 1,
          dimensions: { width: 16, height: 16 },
          floorMaterialID: 'stone-arena',
          light: { indoor: true, brightness: 75 },
          objects: [
            {
              x: 1,
              y: 2,
              modelID: 'door',
              sourceWidth: 1,
              sourceHeight: 1,
              priority: 0,
              rotation: 270,
            },
          ],
          collisionMasks: [{ x: 0, y: 0, width: 1, height: 1 }],
          portals: [{ x: 0, y: 0, width: 1, height: 1, targetSectorName: 'EdariaMitte', direction: 0 }],
          npcs: [
            {
              spawnX: 5,
              spawnY: 7,
              spawnBoxWidth: 2,
              spawnBoxHeight: 2,
              maskWidth: 1,
              maskHeight: 1,
              name: 'Libus',
              figure: 12,
              direction: 137.5,
              behaviorTag: 0,
              dialogScript: 'Hallo $name, willkommen!',
            },
          ],
          monsterSpawns: [
            {
              spawnX: 10,
              spawnY: 12,
              spawnBoxWidth: 4,
              spawnBoxHeight: 4,
              monsterWidth: 1,
              monsterHeight: 1,
              name: 'Gespenst',
              figure: 99,
              bounded: true,
              spawnHP: 100,
              spawnBalance: 100,
              spawnMana: 100,
              aiScriptIndex: 3,
            },
          ],
          floorPatches: [{ floorMaterialID: 'cobble-town', x: 0, y: 0, width: 128, height: 128 }],
        },
      },
    }
    expect(roundTrip(message)).toEqual(message)
  })

  it('inventory round-trips ordered extras and an equipped hand', () => {
    const message: SomnioMessage = {
      tag: 'inventory',
      payload: {
        rows: [
          { slot: 0, category: 0, itemId: 0, extras: [{ key: 'gold', value: 100 }], equippedHand: 0 },
          { slot: 1, category: 1, itemId: 0, extras: [], equippedHand: 2 },
        ],
      },
    }
    expect(roundTrip(message)).toEqual(message)
  })

  it('session token round-trips a 30-day lifetime past the Int16 ceiling', () => {
    const message: SomnioMessage = {
      tag: 'sessionToken',
      payload: { token: 'AAAA-BBBB', expiresInSeconds: 2_592_000 },
    }
    expect(roundTrip(message)).toEqual(message)
  })
})

describe('UTF-8 byte counting', () => {
  /**
   * `String.prototype.length` counts UTF-16 code units, so it disagrees with every Swift cap
   * the moment a field carries non-ASCII text. These are the cases that actually diverge.
   */
  it.each([
    ['Grussformel', 11, 11],
    ['Grüße', 5, 7],
    ['Gespenst \u{1F47B}', 11, 13],
  ])('%s is %i UTF-16 units but %i UTF-8 bytes', (text, units, bytes) => {
    expect(text.length).toBe(units)
    expect(utf8ByteLength(text)).toBe(bytes)
  })

  it('truncates on a code-point boundary rather than splitting a character', () => {
    const truncated = truncateToUTF8Bytes('äää', 3)
    expect(utf8ByteLength(truncated)).toBeLessThanOrEqual(3)
    expect(truncated).toBe('ä')
  })

  it('truncates an astral character without emitting a replacement character', () => {
    const truncated = truncateToUTF8Bytes('\u{1F47B}\u{1F47B}', 6)
    expect(truncated).toBe('\u{1F47B}')
    expect(truncated).not.toContain('�')
  })
})

/**
 * Raw-value fidelity against the Swift enums these tables mirror.
 *
 * Nothing else in the repo catches a swapped pair. Both languages encode and decode with their own
 * constant, so a renumbering round-trips cleanly through the codec tests and the golden frames — the
 * fixtures record one case per enum, never the mapping — and every other test spells the names
 * symbolically. It shows up only in play: swap `npc` and `monster` and `npcFeetRects()` matches
 * nothing, so no bump ever fires and NPC dialog becomes unreachable game-wide with a green suite.
 *
 * Reading the Swift source is the same technique `core-sector.test.ts` uses for `PortalDirection`,
 * and it is deliberately a *file read* rather than a copied table: a copy would drift in exactly the
 * way this exists to prevent.
 */
describe('mirrored enums match their Swift raw values', () => {
  it('matches the raw values of Swift WireEntityType', () => {
    expect(swiftEnumCases('Sources/SomnioProtocol/Payloads/Entity.swift', 'WireEntityType')).toEqual(
      WIRE_ENTITY_TYPE
    )
  })

  it('matches the raw values of Swift RegisterResultCode', () => {
    expect(
      swiftEnumCases('Sources/SomnioProtocol/Payloads/RegisterResult.swift', 'RegisterResultCode')
    ).toEqual(REGISTER_RESULT)
  })

  it('matches the raw values of Swift LoginResultCode', () => {
    expect(swiftEnumCases('Sources/SomnioProtocol/Payloads/LoginResult.swift', 'LoginResultCode')).toEqual(
      LOGIN_RESULT
    )
  })

  /**
   * The registration form's two tables have the same exposure as the wire enums above and less
   * protection: `characterClass` and `gender` travel as opaque `Int16`s, so the round-trip and
   * golden-frame suites both encode and decode whatever number the form chose. Reorder the Swift
   * enum and every browser registration silently creates the wrong class.
   */
  it('matches the raw values of Swift CharacterClass', () => {
    expect(swiftEnumCases('Sources/SomnioCore/Models/CharacterClass.swift', 'CharacterClass')).toEqual(
      CHARACTER_CLASS
    )
  })

  it('matches the raw values of Swift Gender', () => {
    expect(swiftEnumCases('Sources/SomnioCore/Models/Gender.swift', 'Gender')).toEqual(GENDER)
  })

  /**
   * The last two mirrored raw-value tables without a pin, and `TEMPO` is the more exposed of the
   * pair: `WIRE_HAND` at least reaches `requireRawEnum` and throws on an unknown value, while
   * `tempoFromRaw` and `tempoFromRawOrKeep` fall back *silently* by design. Renumber `Tempo` on the
   * Swift side — plausible, since 1/2/4 already invites a tidy-up — and every entity in the browser
   * animates at the wrong cadence with the round-trip, golden-frame, and conformance suites green.
   */
  it('matches the raw values of Swift Tempo', () => {
    expect(swiftEnumCases('Sources/SomnioCore/Models/Tempo.swift', 'Tempo')).toEqual(TEMPO)
  })

  it('matches the raw values of Swift WireHand', () => {
    expect(swiftEnumCases('Sources/SomnioProtocol/WireDTOs.swift', 'WireHand')).toEqual(WIRE_HAND)
  })

  /**
   * The byte caps have the same exposure and no guard at all: `constants.ts` claims "the
   * cross-language conformance suite is what catches drift here", but that suite only checks
   * `helloVersion` and `maxFrameLength`. A TS `maxPasswordUTF8Bytes` of 256 against Swift's 128
   * would let the registration form accept a password the server can only ever reject.
   */
  it('matches the Swift protocol byte caps', () => {
    const source = readFileSync(
      resolve(process.cwd(), '..', 'Sources/SomnioProtocol/Constants.swift'),
      'utf8'
    )
    const swiftValue = (name: string): number => {
      const match = new RegExp(`let ${name}\\s*(?::\\s*\\w+)?\\s*=\\s*(\\d+)`).exec(source)
      expect(match, `${name} not found in Constants.swift`).not.toBeNull()
      return Number(match?.[1])
    }
    expect(SOMNIO_PROTOCOL_CONSTANTS.maxIdentifierUTF8Bytes).toBe(swiftValue('maxIdentifierUTF8Bytes'))
    expect(SOMNIO_PROTOCOL_CONSTANTS.maxPasswordUTF8Bytes).toBe(swiftValue('maxPasswordUTF8Bytes'))
    expect(SOMNIO_PROTOCOL_CONSTANTS.minPasswordUTF8Bytes).toBe(swiftValue('minPasswordUTF8Bytes'))
    expect(SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes).toBe(swiftValue('maxSayUTF8Bytes'))
    expect(SOMNIO_PROTOCOL_CONSTANTS.maxSessionTokenUTF8Bytes).toBe(swiftValue('maxSessionTokenUTF8Bytes'))
  })
})

/**
 * The field-level byte caps.
 *
 * These are hostile-server guards rather than conveniences — the server bounds what it *accepts*,
 * nothing bounds what it sends — so "the call is present" and "the call fires" are different claims,
 * and only the second one protects anything. `maxFrameLength` is a frame-level check and is covered
 * separately; a 1 MiB `serverSay` sits comfortably inside it.
 */
describe('inbound field byte caps', () => {
  function frame(tag: string, payload: Record<string, unknown>): string {
    return JSON.stringify({ tag, payload })
  }

  it('rejects a serverSay past the say cap', () => {
    const overCap = 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes + 1)
    expect(() => decodeSomnioMessage(frame('serverSay', { entityIndex: 1, text: overCap }))).toThrow(
      WireDecodingError
    )
    // One byte under is accepted, so the test pins the boundary rather than "long strings fail".
    const atCap = 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes)
    expect(() => decodeSomnioMessage(frame('serverSay', { entityIndex: 1, text: atCap }))).not.toThrow()
  })

  /** Counted in UTF-8 bytes, not code units: 100 emoji are 400 bytes but a `.length` of 200. */
  it('counts the say cap in UTF-8 bytes rather than code units', () => {
    const emoji = '😀'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes / 4 + 1)
    expect(emoji.length).toBeLessThan(SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes)
    expect(utf8ByteLength(emoji)).toBeGreaterThan(SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes)
    expect(() => decodeSomnioMessage(frame('serverSay', { entityIndex: 1, text: emoji }))).toThrow(
      WireDecodingError
    )
  })

  it('rejects an adminSay past the say cap', () => {
    const overCap = 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes + 1)
    expect(() => decodeSomnioMessage(frame('adminSay', { text: overCap }))).toThrow(WireDecodingError)
  })

  it('rejects a sessionToken past the token cap', () => {
    const overCap = 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSessionTokenUTF8Bytes + 1)
    expect(() =>
      decodeSomnioMessage(frame('sessionToken', { token: overCap, expiresInSeconds: 60 }))
    ).toThrow(WireDecodingError)
  })

  /**
   * An entity name is retained three times over — the entity map, the roster (which re-runs a
   * collating sort on every arrival), and the `left` chat line — so it costs far more than the one
   * plaque `renderNamePlaque` clamps at raster time.
   *
   * Truncated rather than rejected, and the distinction is the point: this field also carries
   * operator-authored NPC and monster names, which nothing in the sector format bounds. Rejecting
   * would refuse a sector the native client renders, on nothing worse than a long label.
   */
  it('truncates an over-cap entity name instead of rejecting the frame', () => {
    const base = {
      entityIndex: 1,
      figure: 1,
      gender: 0,
      maskWidth: 32,
      maskHeight: 48,
      type: 0,
      x: 0,
      y: 0,
      facing: 0,
      tempo: 2,
    }
    const cap = SOMNIO_PROTOCOL_CONSTANTS.maxIdentifierUTF8Bytes
    const decoded = decodeSomnioMessage(frame('entity', { ...base, name: 'a'.repeat(cap + 40) }))
    if (decoded.tag !== 'entity') throw new Error('expected an entity frame')
    expect(utf8ByteLength(decoded.payload.name)).toBe(cap)

    const atCap = 'a'.repeat(cap)
    const kept = decodeSomnioMessage(frame('entity', { ...base, name: atCap }))
    if (kept.tag !== 'entity') throw new Error('expected an entity frame')
    expect(kept.payload.name).toBe(atCap)
  })

  it('rejects a revokeSession past the token cap, like its redeem twin', () => {
    const overCap = 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSessionTokenUTF8Bytes + 1)
    expect(() => decodeSomnioMessage(frame('revokeSession', { token: overCap }))).toThrow(WireDecodingError)
  })
})

/**
 * `requireFloat`'s range rejection, mirroring Swift's `JSONDecoder`, which throws `dataCorrupted`
 * ("not representable in Swift") for any number beyond `Float.greatestFiniteMagnitude`. Without it
 * the two clients disagree about whether the very same server frame is valid at all.
 */
describe('requireFloat rejects values Float cannot represent', () => {
  it('rejects a facing past Float.greatestFiniteMagnitude', () => {
    const payload = {
      entityIndex: 1,
      figure: 0,
      gender: 0,
      maskWidth: 32,
      maskHeight: 48,
      type: 0,
      name: 'Peer',
      x: 10,
      y: 10,
      facing: 1e39,
      tempo: 2,
    }
    expect(() => decodeSomnioMessage(JSON.stringify({ tag: 'entity', payload }))).toThrow(WireDecodingError)
    expect(() =>
      decodeSomnioMessage(JSON.stringify({ tag: 'entity', payload: { ...payload, facing: 359.5 } }))
    ).not.toThrow()
  })
})
