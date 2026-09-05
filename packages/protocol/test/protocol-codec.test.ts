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
} from '../src/index.ts'
import type { SomnioMessage } from '../src/index.ts'

/**
 * Round trips, frame limits, and the decode-time rejections: TypeScript types are erased, so the
 * runtime validators are the only thing standing between a drifted or hostile frame and the
 * handlers.
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
   * The browser `WebSocket` has no `maxFrameSize` knob, so the inbound cap has to be enforced in
   * the decoder. Without this the oversized case in the server-facing conformance suite passes
   * while the browser accepts the frame.
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

  it('rejects a fractional value in an integer field', () => {
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
   * `String.prototype.length` counts UTF-16 code units, so it disagrees with every protocol byte cap
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
 * Raw-value pins for the enums this package owns.
 *
 * Nothing else catches a swapped pair: every consumer encodes and decodes with the same constant,
 * so a renumbering round-trips cleanly through the codec tests and the golden frames — the fixtures
 * record one case per enum, never the mapping — and every other test spells the names symbolically.
 * Swap `npc` and `monster` and no bump ever fires, with a green suite. The tables are literal here,
 * not read from another file: this package is the single implementation.
 */
describe('enum raw values', () => {
  it('pins WireEntityType', () => {
    expect(WIRE_ENTITY_TYPE).toEqual({ player: 0, npc: 1, monster: 2 })
  })

  it('pins LoginResultCode', () => {
    expect(LOGIN_RESULT).toEqual({ ok: 0, badCredentials: 1, alreadyLoggedIn: 2 })
  })

  it('pins RegisterResultCode', () => {
    expect(REGISTER_RESULT).toEqual({ ok: 0, nicknameExists: 1, failure: 2, nameNotAllowed: 3 })
  })

  it('pins WireHand', () => {
    expect(WIRE_HAND).toEqual({ none: 0, left: 1, right: 2 })
  })
})

/**
 * The protocol constants as literals. `helloVersion` is strict equality at the hello gate on both
 * sides; the byte caps are what the registration form and the server's handlers both read.
 */
describe('protocol constants', () => {
  it('pins the frame and handshake constants', () => {
    expect(SOMNIO_PROTOCOL_CONSTANTS.helloVersion).toBe(3)
    expect(SOMNIO_PROTOCOL_CONSTANTS.maxFrameLength).toBe(1_048_576)
    expect(SOMNIO_PROTOCOL_CONSTANTS.frameSizeSlack).toBe(64)
    expect(MAX_WIRE_FRAME_SIZE).toBe(1_048_640)
  })

  it('pins the byte caps', () => {
    expect(SOMNIO_PROTOCOL_CONSTANTS.maxIdentifierUTF8Bytes).toBe(64)
    expect(SOMNIO_PROTOCOL_CONSTANTS.maxPasswordUTF8Bytes).toBe(128)
    expect(SOMNIO_PROTOCOL_CONSTANTS.minPasswordUTF8Bytes).toBe(8)
    expect(SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes).toBe(256)
    expect(SOMNIO_PROTOCOL_CONSTANTS.maxSessionTokenUTF8Bytes).toBe(256)
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
   * would refuse a whole sector on nothing worse than a long label.
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

  /**
   * The client-to-server fields decode uncapped. The server answers an over-cap `clientSay` by
   * dropping it, an over-cap `redeemSession` with `badCredentials`, and an over-cap
   * `revokeSession` with `sessionRevoked(false)` — all with the socket kept open, which it can
   * only do if the frame reaches its handler rather than failing at decode.
   */
  it('decodes an over-cap clientSay, redeemSession, and revokeSession', () => {
    const overCapSay = 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes + 44)
    expect(decodeSomnioMessage(frame('clientSay', { entityIndex: 0, text: overCapSay }))).toEqual({
      tag: 'clientSay',
      payload: { entityIndex: 0, text: overCapSay },
    })
    const overCapToken = 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSessionTokenUTF8Bytes + 44)
    expect(decodeSomnioMessage(frame('redeemSession', { token: overCapToken }))).toEqual({
      tag: 'redeemSession',
      payload: { token: overCapToken },
    })
    expect(decodeSomnioMessage(frame('revokeSession', { token: overCapToken }))).toEqual({
      tag: 'revokeSession',
      payload: { token: overCapToken },
    })
  })
})

/**
 * `requireFloat` rejects any number beyond the largest finite Float32: the field is Float32 on
 * the wire, and accepting a larger value would let `Math.fround` turn it into Infinity.
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
