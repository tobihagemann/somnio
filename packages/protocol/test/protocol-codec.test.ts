import { describe, expect, it } from 'vitest';
import {
  ENTITY_KINDS,
  GAITS,
  HANDS,
  LOGIN_RESULTS,
  REGISTER_RESULTS,
  SECTOR_KINDS,
  OversizedFrameError,
  SOMNIO_PROTOCOL_CONSTANTS,
  UnrecognizedTagError,
  WireDecodingError,
  decodeSomnioMessage,
  encodeSomnioMessage,
  MAX_WIRE_FRAME_SIZE,
  truncateToUTF8Bytes,
  utf8ByteLength,
} from '../src/index.ts';
import type { SomnioMessage } from '../src/index.ts';
import { GOLDEN_FRAME_ENTRIES } from './support/goldenFrameCatalog.ts';

/**
 * Round trips, frame limits, and the decode-time rejections: TypeScript types are erased, so the
 * runtime validators are the only thing standing between a drifted or hostile frame and the
 * handlers.
 */

function roundTrip(message: SomnioMessage): SomnioMessage {
  return decodeSomnioMessage(encodeSomnioMessage(message));
}

function frame(tag: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ tag, payload });
}

describe('frame limits', () => {
  it('holds the WS frame ceiling strictly above the encoder guard', () => {
    expect(MAX_WIRE_FRAME_SIZE).toBeGreaterThan(SOMNIO_PROTOCOL_CONSTANTS.maxFrameLength);
  });

  it('rejects an outbound message larger than maxFrameLength', () => {
    const oversized = 'x'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxFrameLength + 1);
    expect(() => encodeSomnioMessage({ tag: 'adminSay', payload: { text: oversized } })).toThrow(OversizedFrameError);
  });

  it('encodes a max-bounded message without tripping the guard', () => {
    const frame = encodeSomnioMessage({ tag: 'adminSay', payload: { text: 'well within bounds' } });
    expect(utf8ByteLength(frame)).toBeLessThanOrEqual(SOMNIO_PROTOCOL_CONSTANTS.maxFrameLength);
  });

  /**
   * The browser `WebSocket` has no `maxFrameSize` knob, so the inbound cap has to be enforced in
   * the decoder. Without this the oversized case in the server-facing conformance suite passes
   * while the browser accepts the frame.
   */
  it('rejects an inbound frame larger than maxFrameLength', () => {
    const frame = `{"tag":"adminSay","payload":{"text":"${'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxFrameLength)}"}}`;
    expect(() => decodeSomnioMessage(frame)).toThrow(OversizedFrameError);
  });
});

describe('tag discrimination', () => {
  it('throws on an unrecognized tag', () => {
    expect(() => decodeSomnioMessage('{"tag":"notAVerb","payload":{}}')).toThrow(UnrecognizedTagError);
  });

  it('throws on malformed JSON', () => {
    expect(() => decodeSomnioMessage('{ not json')).toThrow(WireDecodingError);
  });

  it('throws on a zero-byte frame', () => {
    expect(() => decodeSomnioMessage('')).toThrow(WireDecodingError);
  });

  it('throws on a known tag with a malformed payload', () => {
    expect(() => decodeSomnioMessage('{"tag":"move","payload":{}}')).toThrow(WireDecodingError);
  });
});

describe('runtime validation the erased types cannot do', () => {
  const energy = { healthCurrent: 100, healthMax: 100, balanceCurrent: 50, balanceMax: 100, spiritCurrent: 25, spiritMax: 50 };
  const move = { x: 10.25, z: 20.5, facing: 137.5, gait: 'jog' };
  const entity = { id: 'monster:7', kind: 'monster', characterModelId: 'gespenst', name: 'Gespenst', radius: 0.3, x: 0, z: 0, facing: 0, gait: 'jog' };
  const row = { slot: 0, itemId: 'purse', quantity: 100 };

  it('rejects a missing required field', () => {
    expect(() => decodeSomnioMessage(frame('energy', { healthCurrent: 100 }))).toThrow(/healthMax: expected Int32, got nothing/);
  });

  it('rejects a wrong JSON type', () => {
    expect(() => decodeSomnioMessage(frame('adminSay', { text: 42 }))).toThrow(/expected a string, got number/);
  });

  it('rejects a non-object payload', () => {
    expect(() => decodeSomnioMessage('{"tag":"adminSay","payload":"hi"}')).toThrow(WireDecodingError);
  });

  /** `1e999` is valid JSON that parses to Infinity, which `JSON.stringify` cannot write, so the frame is literal. */
  it('rejects a non-finite number', () => {
    expect(() => decodeSomnioMessage('{"tag":"move","payload":{"x":0,"z":0,"facing":1e999,"gait":"walk"}}')).toThrow(/facing: expected a finite number/);
  });

  const overCapEntityId = 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxEntityIdUTF8Bytes + 1);
  const overCapId = 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxIdentifierUTF8Bytes + 1);
  const overCapSectorName = 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSectorNameUTF8Bytes + 1);

  it.each<[string, string, Record<string, unknown>, RegExp]>([
    ['an out-of-range integer', 'energy', { ...energy, healthCurrent: 3_000_000_000 }, /Int32 out of range: 3000000000/],
    ['a fractional value in an integer field', 'energy', { ...energy, spiritMax: 12.5 }, /fractional 12.5/],
    ['an unknown login result', 'loginResult', { result: 'locked' }, /unknown value "locked"/],
    ['a numeric register result', 'registerResult', { result: 0 }, /result: expected a string, got number/],
    ['an unknown gait', 'move', { ...move, gait: 'sprint' }, /unknown value "sprint"/],
    ['a coordinate past the metre cap', 'move', { ...move, x: SOMNIO_PROTOCOL_CONSTANTS.maxCoordinateMetres + 1 }, /x: exceeds 10000 metres/],
    ['a negative coordinate past the metre cap', 'correction', { x: 0, z: -10_000.5 }, /z: exceeds 10000 metres/],
    ['an unknown hand', 'equipToggle', { slot: 1, hand: 'both' }, /unknown value "both"/],
    ['an empty entity id', 'bump', { targetId: '' }, /targetId: expected a non-empty string/],
    ['an over-cap entity id', 'bump', { targetId: overCapEntityId }, /targetId: exceeds 320 UTF-8 bytes/],
    ['a door id outside the id alphabet', 'useDoor', { sector: 'EdariaMitte', doorId: 'Main Door' }, /doorId: expected an id/],
    ['an empty door id', 'doorRefused', { sector: 'EdariaMitte', doorId: '' }, /doorId: expected an id/],
    ['an over-cap door id', 'useDoor', { sector: 'EdariaMitte', doorId: overCapId }, /doorId: exceeds 64 UTF-8 bytes/],
    ['an over-cap sector name on useDoor', 'useDoor', { sector: overCapSectorName, doorId: 'main' }, /sector: exceeds 251 UTF-8 bytes/],
    ['an empty sector name on useDoor', 'useDoor', { sector: '', doorId: 'main' }, /sector: expected a non-empty string/],
    ['an over-cap sector name on doorRefused', 'doorRefused', { sector: overCapSectorName, doorId: 'main' }, /sector: exceeds 251 UTF-8 bytes/],
    ['an empty sector name on doorRefused', 'doorRefused', { sector: '', doorId: 'main' }, /sector: expected a non-empty string/],
    ['an over-cap space id', 'enterSpace', { spaceId: overCapSectorName, selfId: 'a', worldSeconds: 0 }, /spaceId: exceeds 251 UTF-8 bytes/],
    ['an empty space id', 'enterSpace', { spaceId: '', selfId: 'a', worldSeconds: 0 }, /spaceId: expected a non-empty string/],
    ['a negative world time', 'enterSpace', { spaceId: 'outdoors', selfId: 'a', worldSeconds: -1 }, /worldSeconds: expected a non-negative number/],
    ['an unknown entity kind', 'entity', { ...entity, kind: 'ghost' }, /unknown value "ghost"/],
    ['a zero entity radius', 'entity', { ...entity, radius: 0 }, /radius: expected a positive length/],
    ['an over-cap id in a moves batch', 'moves', { moves: [{ ...move, id: overCapEntityId }] }, /moves\[0\]\.id: exceeds 320 UTF-8 bytes/],
    ['a negative quantity', 'inventory', { rows: [{ ...row, quantity: -1 }] }, /quantity: expected a non-negative quantity/],
    ['an empty item id', 'inventory', { rows: [{ ...row, itemId: '' }] }, /itemId: expected a non-empty string/],
    ['an over-cap item id', 'inventory', { rows: [{ ...row, itemId: overCapId }] }, /itemId: exceeds 64 UTF-8 bytes/],
    ['an unknown equipped hand', 'inventory', { rows: [{ ...row, equippedHand: 'none' }] }, /unknown value "none"/],
    ['an over-cap leaving entity id', 'leave', { entityId: overCapEntityId, leftGame: true }, /entityId: exceeds 320 UTF-8 bytes/],
  ])('rejects %s', (_case, tag, payload, expected) => {
    expect(() => decodeSomnioMessage(frame(tag, payload))).toThrow(expected);
  });

  /** One byte under the rejection, so the cases above pin boundaries rather than "large values fail". */
  it('accepts values at their caps', () => {
    const atCapEntityId = 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxEntityIdUTF8Bytes);
    const atCapId = 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxIdentifierUTF8Bytes);
    const atCapSectorName = 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSectorNameUTF8Bytes);
    expect(() => decodeSomnioMessage(frame('bump', { targetId: atCapEntityId }))).not.toThrow();
    expect(() => decodeSomnioMessage(frame('bump', { targetId: `npc:${atCapSectorName}/${atCapId}` }))).not.toThrow();
    expect(() => decodeSomnioMessage(frame('useDoor', { sector: atCapSectorName, doorId: atCapId }))).not.toThrow();
    expect(() => decodeSomnioMessage(frame('doorRefused', { sector: atCapSectorName, doorId: atCapId }))).not.toThrow();
    expect(() => decodeSomnioMessage(frame('enterSpace', { spaceId: atCapSectorName, selfId: 'a', worldSeconds: 0 }))).not.toThrow();
    expect(() => decodeSomnioMessage(frame('move', { ...move, x: -SOMNIO_PROTOCOL_CONSTANTS.maxCoordinateMetres }))).not.toThrow();
    expect(() => decodeSomnioMessage(frame('enterSpace', { spaceId: 'outdoors', selfId: 'a', worldSeconds: 0 }))).not.toThrow();
    expect(() => decodeSomnioMessage(frame('inventory', { rows: [{ ...row, itemId: atCapId, quantity: 0 }] }))).not.toThrow();
  });
});

describe('round trips', () => {
  it.each(GOLDEN_FRAME_ENTRIES.map((entry) => [entry.name, entry.message] as const))('%s round-trips', (_name, message) => {
    expect(roundTrip(message)).toEqual(message);
  });

  it('login round-trips without the optional token request', () => {
    const message: SomnioMessage = {
      tag: 'login',
      payload: { nickname: 'Saibot', password: 'hunter2' },
    };
    const decoded = roundTrip(message);
    expect(decoded).toEqual(message);
    expect('requestSessionToken' in decoded.payload).toBe(false);
  });

  /** The golden catalog records one member of each result set, and not this one. */
  it.each(['loginResult', 'registerResult'] as const)('%s decodes a throttled result', (tag) => {
    expect(decodeSomnioMessage(frame(tag, { result: 'throttled' }))).toEqual({ tag, payload: { result: 'throttled' } });
  });

  /** An absent hand is the unequip, so it must stay absent rather than decode to a default hand. */
  it('equipToggle round-trips an unequip without a hand', () => {
    const message: SomnioMessage = { tag: 'equipToggle', payload: { slot: 1 } };
    const decoded = roundTrip(message);
    expect(decoded).toEqual(message);
    expect('hand' in decoded.payload).toBe(false);
    expect(decodeSomnioMessage(frame('equipToggle', { slot: 1, hand: null }))).toEqual(message);
  });

  it('inventory decodes an unequipped row without an equippedHand key', () => {
    const decoded = decodeSomnioMessage(frame('inventory', { rows: [{ slot: 0, itemId: 'purse', quantity: 100, equippedHand: null }] }));
    if (decoded.tag !== 'inventory') throw new Error('expected an inventory frame');
    expect(decoded.payload.rows).toEqual([{ slot: 0, itemId: 'purse', quantity: 100 }]);
    expect('equippedHand' in decoded.payload.rows[0]!).toBe(false);
  });

  /** World time is fractional and far past what an integer or a narrowed float field could carry. */
  it('enterSpace round-trips a fractional world time near year 500 exactly', () => {
    const message: SomnioMessage = {
      tag: 'enterSpace',
      payload: { spaceId: 'EdariaBibliothek', selfId: 'a', worldSeconds: 500 * 12 * 28 * 86_400 + 0.125 },
    };
    expect(roundTrip(message)).toEqual(message);
  });
});

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
    expect(text.length).toBe(units);
    expect(utf8ByteLength(text)).toBe(bytes);
  });

  it('truncates on a code-point boundary rather than splitting a character', () => {
    const truncated = truncateToUTF8Bytes('äää', 3);
    expect(utf8ByteLength(truncated)).toBeLessThanOrEqual(3);
    expect(truncated).toBe('ä');
  });

  it('truncates an astral character without emitting a replacement character', () => {
    const truncated = truncateToUTF8Bytes('\u{1F47B}\u{1F47B}', 6);
    expect(truncated).toBe('\u{1F47B}');
    expect(truncated).not.toContain('�');
  });
});

/**
 * Literal pins for the string sets this package owns.
 *
 * Nothing else catches a renamed member: every consumer encodes and decodes with the same constant,
 * so a rename round-trips cleanly through the codec tests, and the golden frames record one member
 * per set, never the whole set. The tables are literal here, not read from another file: this
 * package is the single implementation.
 */
describe('string literal sets', () => {
  it('pins EntityKind', () => {
    expect(ENTITY_KINDS).toEqual(['player', 'npc', 'monster']);
  });

  it('pins Gait', () => {
    expect(GAITS).toEqual(['walk', 'jog', 'run']);
  });

  it('pins Hand', () => {
    expect(HANDS).toEqual(['left', 'right']);
  });

  it('pins SectorKind', () => {
    expect(SECTOR_KINDS).toEqual(['outdoor', 'interior']);
  });

  it('pins LoginResult', () => {
    expect(LOGIN_RESULTS).toEqual(['ok', 'badCredentials', 'alreadyLoggedIn', 'throttled']);
  });

  it('pins RegisterResult', () => {
    expect(REGISTER_RESULTS).toEqual(['ok', 'nicknameExists', 'failure', 'nameNotAllowed', 'throttled']);
  });
});

/**
 * The protocol constants as literals. `helloVersion` is strict equality at the hello gate on both
 * sides; the byte caps are what the registration form and the server's handlers both read.
 */
describe('protocol constants', () => {
  it('pins the frame and handshake constants', () => {
    expect(SOMNIO_PROTOCOL_CONSTANTS.helloVersion).toBe(5);
    expect(SOMNIO_PROTOCOL_CONSTANTS.maxFrameLength).toBe(1_048_576);
    expect(SOMNIO_PROTOCOL_CONSTANTS.frameSizeSlack).toBe(64);
    expect(MAX_WIRE_FRAME_SIZE).toBe(1_048_640);
  });

  it('pins the byte caps', () => {
    expect(SOMNIO_PROTOCOL_CONSTANTS.maxIdentifierUTF8Bytes).toBe(64);
    expect(SOMNIO_PROTOCOL_CONSTANTS.maxPasswordUTF8Bytes).toBe(128);
    expect(SOMNIO_PROTOCOL_CONSTANTS.minPasswordUTF8Bytes).toBe(8);
    expect(SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes).toBe(256);
    expect(SOMNIO_PROTOCOL_CONSTANTS.maxSessionTokenUTF8Bytes).toBe(256);
    expect(SOMNIO_PROTOCOL_CONSTANTS.maxEntityIdUTF8Bytes).toBe(320);
    expect(SOMNIO_PROTOCOL_CONSTANTS.maxSectorNameUTF8Bytes).toBe(251);
  });

  it('pins the world caps', () => {
    expect(SOMNIO_PROTOCOL_CONSTANTS.maxCoordinateMetres).toBe(10_000);
    expect(SOMNIO_PROTOCOL_CONSTANTS.maxSectorExtentMetres).toBe(512);
    expect(SOMNIO_PROTOCOL_CONSTANTS.maxSectorPlacements).toBe(4096);
    expect(SOMNIO_PROTOCOL_CONSTANTS.maxSectorBlockers).toBe(4096);
    expect(SOMNIO_PROTOCOL_CONSTANTS.maxSectorDoors).toBe(4096);
    expect(SOMNIO_PROTOCOL_CONSTANTS.maxSectorFloorPatches).toBe(4096);
  });
});

/**
 * The field-level byte caps.
 *
 * These are hostile-server guards rather than conveniences — the server bounds what it *accepts*,
 * nothing bounds what it sends — so "the call is present" and "the call fires" are different claims,
 * and only the second one protects anything. `maxFrameLength` is a frame-level check and is covered
 * separately; a 1 MiB `serverSay` sits comfortably inside it.
 */
describe('inbound field byte caps', () => {
  it('rejects a serverSay past the say cap', () => {
    const overCap = 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes + 1);
    expect(() => decodeSomnioMessage(frame('serverSay', { entityId: 'a', text: overCap }))).toThrow(WireDecodingError);
    // One byte under is accepted, so the test pins the boundary rather than "long strings fail".
    const atCap = 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes);
    expect(() => decodeSomnioMessage(frame('serverSay', { entityId: 'a', text: atCap }))).not.toThrow();
  });

  /** Counted in UTF-8 bytes, not code units: 100 emoji are 400 bytes but a `.length` of 200. */
  it('counts the say cap in UTF-8 bytes rather than code units', () => {
    const emoji = '😀'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes / 4 + 1);
    expect(emoji.length).toBeLessThan(SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes);
    expect(utf8ByteLength(emoji)).toBeGreaterThan(SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes);
    expect(() => decodeSomnioMessage(frame('serverSay', { entityId: 'a', text: emoji }))).toThrow(WireDecodingError);
  });

  it('rejects an adminSay past the say cap', () => {
    const overCap = 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes + 1);
    expect(() => decodeSomnioMessage(frame('adminSay', { text: overCap }))).toThrow(WireDecodingError);
  });

  it('rejects a sessionToken past the token cap', () => {
    const overCap = 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSessionTokenUTF8Bytes + 1);
    expect(() => decodeSomnioMessage(frame('sessionToken', { token: overCap, expiresInSeconds: 60 }))).toThrow(WireDecodingError);
  });

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
    const base = { id: 'a', kind: 'npc', characterModelId: 'libus', radius: 0.3, x: 0, z: 0, facing: 0, gait: 'walk' };
    const cap = SOMNIO_PROTOCOL_CONSTANTS.maxIdentifierUTF8Bytes;
    const decoded = decodeSomnioMessage(frame('entity', { ...base, name: 'a'.repeat(cap + 40) }));
    if (decoded.tag !== 'entity') throw new Error('expected an entity frame');
    expect(utf8ByteLength(decoded.payload.name)).toBe(cap);

    const atCap = 'a'.repeat(cap);
    const kept = decodeSomnioMessage(frame('entity', { ...base, name: atCap }));
    if (kept.tag !== 'entity') throw new Error('expected an entity frame');
    expect(kept.payload.name).toBe(atCap);
  });

  /**
   * The client-to-server fields decode uncapped. The server answers an over-cap `clientSay` by
   * dropping it, an over-cap `redeemSession` with `badCredentials`, and an over-cap
   * `revokeSession` with `sessionRevoked(false)` — all with the socket kept open, which it can
   * only do if the frame reaches its handler rather than failing at decode.
   */
  it('decodes an over-cap clientSay, redeemSession, and revokeSession', () => {
    const overCapSay = 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes + 44);
    expect(decodeSomnioMessage(frame('clientSay', { text: overCapSay }))).toEqual({
      tag: 'clientSay',
      payload: { text: overCapSay },
    });
    const overCapToken = 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSessionTokenUTF8Bytes + 44);
    expect(decodeSomnioMessage(frame('redeemSession', { token: overCapToken }))).toEqual({
      tag: 'redeemSession',
      payload: { token: overCapToken },
    });
    expect(decodeSomnioMessage(frame('revokeSession', { token: overCapToken }))).toEqual({
      tag: 'revokeSession',
      payload: { token: overCapToken },
    });
  });
});
