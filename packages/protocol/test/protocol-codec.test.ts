import { describe, expect, it } from 'vitest';
import {
  CHARACTER_RESULTS,
  CONDITIONS,
  ENTITY_KINDS,
  EQUIP_SLOTS,
  GAITS,
  GROUND_SHAPE_KINDS,
  HANDS,
  LOCALES,
  LOGIN_RESULTS,
  LOOT_KINDS,
  NIGHTMARE_RANKS,
  NPC_SERVICES,
  RAISING_STATES,
  RARITIES,
  ABILITY_PHASES,
  REGISTER_RESULTS,
  ROLES,
  SECTOR_KINDS,
  SPEECH_KINDS,
  TELEGRAPH_KINDS,
  TRADE_KINDS,
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

  /** The server splits a crowd's moves at the per-frame cap, so a full frame has to encode or its movers freeze. */
  it('encodes a full moves frame of the longest ids, each escaped to six bytes a character', () => {
    const id = '\u0001'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxEntityIdUTF8Bytes);
    const moves = Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxMovesPerFrame }, () => ({
      id,
      x: -9999.123456789,
      z: -9999.123456789,
      facing: 359.123456789,
      gait: 'walk' as const,
    }));
    expect(() => encodeSomnioMessage({ tag: 'moves', payload: { moves } })).not.toThrow();
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

  it.each([
    ['useItem', { slot: 2 }],
    ['equipToggle', { slot: 1, hand: 'right' }],
  ])('no longer knows %s', (tag, payload) => {
    expect(() => decodeSomnioMessage(frame(tag, payload))).toThrow(UnrecognizedTagError);
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
  const entity = {
    id: 'monster:7',
    kind: 'monster',
    characterModelId: 'ghost',
    name: 'Ghost',
    radius: 0.3,
    x: 0,
    z: 0,
    facing: 0,
    gait: 'jog',
    condition: 'hale',
  };
  const lucidity = { ranks: [{ teachingId: 'strike', rank: 1, practice: 0 }] };
  const item = { id: '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b', baseId: 'sword', tier: 1, rarity: 'magic', affixes: [{ affixId: 'damage', value: 2 }] };
  const bagged = { place: 0, item };
  const inventory = { coins: 100, equipped: [], bag: [bagged] };
  const loot = { lootId: 'loot-1', x: 1, z: 2, contents: { kind: 'item', baseId: 'cap', rarity: 'magic' } };
  const character = { id: 'c', name: 'Saibot', people: 'vigils' };
  const say = { entityId: 'a', name: 'Alice', kind: 'say', text: 'hallo', clarity: 1, x: 0, z: 0 };
  const raising = { targetId: 'b', healerIds: ['a'], state: 'holding', progress: 0, seconds: 6 };
  const telegraph = { id: 'telegraph-1', casterId: 'monster:3', kind: 'wail', x: 4, z: 6, radius: 4, seconds: 2.5 };
  const room = { name: 'Cellar', kind: 'interior', brightness: 50, size: { width: 10, depth: 10 }, ground: { backgroundMaterialId: 'wood-warm', marks: [] } };

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
    ['an unknown character result', 'characterResult', { result: 'taken' }, /unknown value "taken"/],
    ['an empty character id', 'selectCharacter', { characterId: '' }, /characterId: expected a non-empty string/],
    ['an over-cap character id', 'deleteCharacter', { characterId: overCapEntityId }, /characterId: exceeds 320 UTF-8 bytes/],
    ['an over-cap character name', 'characters', { characters: [{ ...character, name: overCapId }] }, /name: exceeds 64 UTF-8 bytes/],
    ['a people outside the id alphabet', 'characters', { characters: [{ ...character, people: 'Vigils' }] }, /people: expected an id/],
    ['an unknown role on a character', 'characters', { characters: [{ ...character, role: 'bard' }] }, /role: unknown value "bard"/],
    [
      'more characters than an account holds',
      'characters',
      // The first character is no object, so only a count checked before the characters reports the cap.
      { characters: [7, ...Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxCharactersPerAccount }, (_, index) => ({ ...character, id: `c${index}` }))] },
      /characters: exceeds 4 records \(got 5\)/,
    ],
    ['an unknown gait', 'move', { ...move, gait: 'sprint' }, /unknown value "sprint"/],
    ['a coordinate past the metre cap', 'move', { ...move, x: SOMNIO_PROTOCOL_CONSTANTS.maxCoordinateMetres + 1 }, /x: exceeds 10000 metres/],
    ['a negative coordinate past the metre cap', 'correction', { x: 0, z: -10_000.5 }, /z: exceeds 10000 metres/],
    ['an item id outside the id alphabet on an equip', 'equip', { itemId: 'Sword 1' }, /itemId: expected an id/],
    ['an unknown slot on an equip', 'equip', { itemId: 'ring-1', slot: 'charm' }, /slot: unknown value "charm"/],
    ['a bag place below 0 on a move', 'moveItem', { itemId: 'cap-1', place: -1 }, /place: expected a bag place from 0 to 23, got -1/],
    ['a bag place past the bag on a move', 'moveItem', { itemId: 'cap-1', place: 24 }, /place: expected a bag place from 0 to 23, got 24/],
    ['a fractional bag place on a move', 'moveItem', { itemId: 'cap-1', place: 1.5 }, /place: expected Int32/],
    ['an unknown slot on an unequip', 'unequip', { slot: 'charm' }, /unknown value "charm"/],
    ['an empty entity id', 'talk', { npcId: '' }, /npcId: expected a non-empty string/],
    ['an over-cap entity id', 'talk', { npcId: overCapEntityId }, /npcId: exceeds 320 UTF-8 bytes/],
    ['an empty target', 'target', { targetId: '' }, /targetId: expected a non-empty string/],
    ['an over-cap target', 'target', { targetId: overCapEntityId }, /targetId: exceeds 320 UTF-8 bytes/],
    ['an engage that is neither on nor off', 'engage', { on: 'yes' }, /on: expected a bool/],
    ['a door id outside the id alphabet', 'useDoor', { sector: 'EdariaSquare', doorId: 'Main Door' }, /doorId: expected an id/],
    ['an empty door id', 'doorRefused', { sector: 'EdariaSquare', doorId: '' }, /doorId: expected an id/],
    ['an over-cap door id', 'useDoor', { sector: 'EdariaSquare', doorId: overCapId }, /doorId: exceeds 64 UTF-8 bytes/],
    ['an over-cap sector name on useDoor', 'useDoor', { sector: overCapSectorName, doorId: 'main' }, /sector: exceeds 251 UTF-8 bytes/],
    ['an empty sector name on useDoor', 'useDoor', { sector: '', doorId: 'main' }, /sector: expected a non-empty string/],
    ['an over-cap sector name on doorRefused', 'doorRefused', { sector: overCapSectorName, doorId: 'main' }, /sector: exceeds 251 UTF-8 bytes/],
    ['an empty sector name on doorRefused', 'doorRefused', { sector: '', doorId: 'main' }, /sector: expected a non-empty string/],
    ['an over-cap space id', 'enterSpace', { spaceId: overCapSectorName, selfId: 'a', people: 'vigils', worldSeconds: 0 }, /spaceId: exceeds 251 UTF-8 bytes/],
    ['an empty space id', 'enterSpace', { spaceId: '', selfId: 'a', people: 'vigils', worldSeconds: 0 }, /spaceId: expected a non-empty string/],
    [
      'a negative world time',
      'enterSpace',
      { spaceId: 'outdoors', selfId: 'a', people: 'vigils', worldSeconds: -1 },
      /worldSeconds: expected a non-negative number/,
    ],
    ['a join without its people', 'enterSpace', { spaceId: 'outdoors', selfId: 'a', worldSeconds: 0 }, /people: expected a string, got nothing/],
    [
      'a join whose people is outside the id alphabet',
      'enterSpace',
      { spaceId: 'outdoors', selfId: 'a', people: 'Vigils', worldSeconds: 0 },
      /people: expected an id/,
    ],
    ['an unknown entity kind', 'entity', { ...entity, kind: 'ghost' }, /unknown value "ghost"/],
    ['a zero entity radius', 'entity', { ...entity, radius: 0 }, /radius: expected a positive length/],
    ['an over-cap id in a moves batch', 'moves', { moves: [{ ...move, id: overCapEntityId }] }, /moves\[0\]\.id: exceeds 320 UTF-8 bytes/],
    [
      'more moves in a batch than the cap',
      'moves',
      // The first move is no object, so only a count checked before the moves reports the cap.
      { moves: [7, ...Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxMovesPerFrame }, (_, index) => ({ ...move, id: `m${index}` }))] },
      /moves: exceeds 256 records \(got 257\)/,
    ],
    ['a negative purse', 'inventory', { ...inventory, coins: -1 }, /coins: expected a non-negative number/],
    ['a negative count of other sessions', 'otherSessions', { count: -1 }, /count: expected a non-negative number/],
    ['a negative count of other sessions revoked', 'otherSessionsRevoked', { revoked: true, count: -1 }, /count: expected a non-negative number/],
    ['an empty item id', 'inventory', { ...inventory, bag: [{ place: 0, item: { ...item, id: '' } }] }, /bag\[0\]\.item\.id: expected an id/],
    ['an over-cap base id', 'inventory', { ...inventory, bag: [{ place: 0, item: { ...item, baseId: overCapId } }] }, /baseId: exceeds 64 UTF-8 bytes/],
    ['a tier below 1', 'inventory', { ...inventory, bag: [{ place: 0, item: { ...item, tier: 0 } }] }, /tier: expected a tier of 1 or more/],
    ['an unknown rarity', 'inventory', { ...inventory, bag: [{ place: 0, item: { ...item, rarity: 'legendary' } }] }, /unknown value "legendary"/],
    [
      'a negative affix value',
      'inventory',
      { ...inventory, bag: [{ place: 0, item: { ...item, affixes: [{ affixId: 'damage', value: -1 }] } }] },
      /value: expected a non-negative number/,
    ],
    [
      'more affixes than the cap',
      'inventory',
      // The first affix is no object, so only a count checked before the affixes reports the cap.
      {
        ...inventory,
        bag: [{ place: 0, item: { ...item, affixes: [7, ...Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxItemAffixes }, () => item.affixes[0])] } }],
      },
      /affixes: exceeds 8 records \(got 9\)/,
    ],
    ['a bag place past the bag', 'inventory', { ...inventory, bag: [{ ...bagged, place: 24 }] }, /bag\[0\]\.place: expected a bag place from 0 to 23, got 24/],
    [
      'two items at one bag place',
      'inventory',
      { ...inventory, bag: [bagged, { place: 0, item: { ...item, id: 'other' } }] },
      /bag\[1\]\.place: place 0 held twice/,
    ],
    ['an unknown equipped slot', 'inventory', { ...inventory, equipped: [{ slot: 'charm', item }] }, /equipped\[0\]\.slot: unknown value "charm"/],
    [
      'a slot worn twice',
      'inventory',
      {
        ...inventory,
        equipped: [
          { slot: 'mainHand', item },
          { slot: 'mainHand', item: { ...item, id: 'b' } },
        ],
      },
      /equipped\[1\]\.slot: slot "mainHand" worn twice/,
    ],
    [
      'more equipped items than there are slots',
      'inventory',
      // The first is no object, so only a count checked before the items reports the cap.
      { ...inventory, equipped: [7, ...EQUIP_SLOTS.map((slot) => ({ slot, item }))] },
      /equipped: exceeds 10 records \(got 11\)/,
    ],
    [
      'more bag items than the cap',
      'inventory',
      // The first item is no object, so only a count checked before the bag reports the cap.
      {
        ...inventory,
        bag: [7, ...Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxBagItems }, (_, index) => ({ place: index, item: { ...item, id: `i${index}` } }))],
      },
      /bag: exceeds 24 records \(got 25\)/,
    ],
    [
      'an unknown trade',
      'inventory',
      { ...inventory, trade: { kind: 'stolen', baseId: 'dagger', rarity: 'plain', coins: 60 } },
      /trade\.kind: unknown value "stolen"/,
    ],
    [
      'a trade for negative coins',
      'inventory',
      { ...inventory, trade: { kind: 'sold', baseId: 'dagger', rarity: 'plain', coins: -1 } },
      /trade\.coins: expected a non-negative number/,
    ],
    ['an unknown kind of pick-up', 'inventory', { ...inventory, pickedUp: { kind: 'trophy', baseId: 'cap' } }, /pickedUp\.kind: unknown value "trophy"/],
    ['an item id outside the id alphabet on a drop', 'dropItem', { itemId: 'Cap 1', heading: 90 }, /itemId: expected an id/],
    ['a drop with no heading', 'dropItem', { itemId: 'cap-1' }, /heading: expected a finite number, got nothing/],
    ['a drop with a heading of text', 'dropItem', { itemId: 'cap-1', heading: 'north' }, /heading: expected a finite number/],
    ['a drop with a null heading', 'dropItem', { itemId: 'cap-1', heading: null }, /heading: expected a finite number, got null/],
    ['an unknown kind of drop', 'inventory', { ...inventory, dropped: { kind: 'trophy', baseId: 'cap' } }, /dropped\.kind: unknown value "trophy"/],
    ['a loot id outside the id alphabet', 'pickUp', { lootId: 'Loot 1' }, /lootId: expected an id/],
    ['loot of an unknown kind', 'loot', { ...loot, contents: { kind: 'trophy' } }, /contents\.kind: unknown value "trophy"/],
    ['loot of an unknown rarity', 'loot', { ...loot, contents: { ...loot.contents, rarity: 'legendary' } }, /contents\.rarity: unknown value "legendary"/],
    ['loot shared by a string', 'loot', { ...loot, shared: 'yes' }, /shared: expected a bool/],
    ['loot without its contents', 'loot', { lootId: 'loot-1', x: 1, z: 2 }, /contents: expected an object/],
    ['loot past the metre cap', 'loot', { ...loot, x: SOMNIO_PROTOCOL_CONSTANTS.maxCoordinateMetres + 1 }, /x: exceeds 10000 metres/],
    [
      'loot thrown from past the metre cap',
      'loot',
      { ...loot, from: { x: 0, z: -SOMNIO_PROTOCOL_CONSTANTS.maxCoordinateMetres - 1 } },
      /from\.z: exceeds 10000 metres/,
    ],
    ['loot thrown by a malformed entity', 'loot', { ...loot, from: { x: 0, z: 0, entityId: 7 } }, /from\.entityId: expected a string/],
    ['loot thrown from an unknown hand', 'loot', { ...loot, from: { x: 0, z: 0, entityId: 'a', hand: 'head' } }, /from\.hand: unknown value "head"/],
    ['loot gone without its id', 'lootGone', {}, /lootId: expected a string, got nothing/],
    ['an over-cap ware on a buy', 'buy', { npcId: 'npc:a/b', baseId: overCapId }, /baseId: exceeds 64 UTF-8 bytes/],
    ['an unknown held hand item', 'held', { entityId: 'a', held: { mainHand: 'Short Sword' } }, /held\.mainHand: expected an id/],
    ['a ware outside the id alphabet on a sell', 'sell', { npcId: 'npc:a/b', itemId: 'Short Sword' }, /itemId: expected an id/],
    ['a sell without its shopkeeper', 'sell', { itemId: 'dagger' }, /npcId: expected a string, got nothing/],
    ['an over-cap leaving entity id', 'leave', { entityId: overCapEntityId, leftGame: true }, /entityId: exceeds 320 UTF-8 bytes/],
    ['a crumble that is no bool', 'leave', { entityId: 'monster:8', leftGame: false, crumbled: 1 }, /crumbled: expected a bool/],
    ['an unknown condition on an entity', 'entity', { ...entity, condition: 'dying' }, /unknown value "dying"/],
    ['an unknown service', 'entity', { ...entity, service: 'banker' }, /unknown value "banker"/],
    ['an unknown nightmare rank', 'entity', { ...entity, rank: 'champion' }, /rank: unknown value "champion"/],
    ['an elite trait that is no id', 'entity', { ...entity, rank: 'elite', trait: 'Stony' }, /trait: expected an id/],
    ['a summoner that is no string', 'entity', { ...entity, summonedBy: 3 }, /summonedBy: expected a string, got number/],
    ['an over-cap summoner', 'entity', { ...entity, summonedBy: overCapEntityId }, /summonedBy: exceeds 320 UTF-8 bytes/],
    ['an unknown telegraph kind', 'telegraph', { ...telegraph, kind: 'roar' }, /kind: unknown value "roar"/],
    ['a telegraph id outside the id alphabet', 'telegraph', { ...telegraph, id: 'Wail 1' }, /id: expected an id/],
    ['a telegraph without its caster', 'telegraph', { ...telegraph, casterId: undefined }, /casterId: expected a string, got nothing/],
    ['a telegraph of no size', 'telegraph', { ...telegraph, radius: 0 }, /radius: expected a positive/],
    ['a telegraph with negative time left', 'telegraph', { ...telegraph, seconds: -1 }, /seconds: expected a non-negative number/],
    ['a telegraph past the metre cap', 'telegraph', { ...telegraph, x: 1e9 }, /x: /],
    ['an outdoor door id outside the id alphabet', 'sector', { sector: room, outdoorDoorIds: ['Exit'] }, /outdoorDoorIds\[0\]: expected an id/],
    [
      'more outdoor doors than a sector holds doors',
      'sector',
      { sector: room, outdoorDoorIds: Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxSectorDoors + 1 }, (_, index) => `d${index}`) },
      /outdoorDoorIds: exceeds \d+ ids/,
    ],
    ['an unknown condition', 'condition', { entityId: 'monster:7', condition: 'dying' }, /unknown value "dying"/],
    ['an unknown role', 'lucidity', { ...lucidity, role: 'bard' }, /unknown value "bard"/],
    ['an unknown role on a task', 'lucidity', { ...lucidity, task: { role: 'bard', progress: 0 } }, /task\.role: unknown value "bard"/],
    ['a teaching id outside the id alphabet', 'study', { npcId: 'npc:a/b', teachingId: 'followThrough' }, /teachingId: expected an id/],
    ['a studied teaching outside the id alphabet', 'lucidity', { ...lucidity, study: 'Follow Through' }, /study: expected an id/],
    ['a negative rank', 'lucidity', { ranks: [{ teachingId: 'strike', rank: -1, practice: 0 }] }, /rank: expected a non-negative number/],
    ['a fractional rank', 'lucidity', { ranks: [{ teachingId: 'strike', rank: 1.5, practice: 0 }] }, /fractional 1.5/],
    ['negative practice', 'lucidity', { ranks: [{ teachingId: 'strike', rank: 1, practice: -0.5 }] }, /practice: expected a non-negative number/],
    [
      'more ranks than the cap',
      'lucidity',
      // The first rank is no object, so only a count checked before the ranks reports the cap.
      { ranks: [7, ...Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxLucidityRanks }, (_, index) => ({ teachingId: `t${index}`, rank: 1, practice: 0 }))] },
      /ranks: exceeds 32 records \(got 33\)/,
    ],
    ['an unknown raising state', 'raising', { ...raising, state: 'paused' }, /unknown value "paused"/],
    ['a raise held by no one', 'raising', { ...raising, healerIds: [] }, /healerIds: expected at least one healer/],
    [
      'a raise held by more Healers than the cap',
      'raising',
      // The first id is no string, so only a count checked before the ids reports the cap.
      { ...raising, healerIds: [7, ...Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxRaiseHealers }, (_, index) => `h${index}`)] },
      /healerIds: exceeds 32 ids \(got 33\)/,
    ],
    ['a Healer named twice in a raise', 'raising', { ...raising, healerIds: ['a', 'c', 'a'] }, /healerIds\[2\]: duplicate id "a"/],
    ['a Healer id that is no string', 'raising', { ...raising, healerIds: ['a', 7] }, /healerIds\[1\]: expected a string, got number/],
    ['an empty Healer id', 'raising', { ...raising, healerIds: ['a', ''] }, /healerIds\[1\]: expected a non-empty string/],
    ['an over-cap Healer id', 'raising', { ...raising, healerIds: [overCapEntityId] }, /healerIds\[0\]: exceeds 320 UTF-8 bytes/],
    ['a raise past its end', 'raising', { ...raising, progress: 1.5 }, /progress: expected a number from 0 to 1, got 1.5/],
    ['a raise with negative time left', 'raising', { ...raising, seconds: -1 }, /seconds: expected a non-negative number/],
    [
      'a pause for each of fewer Healers than hold on',
      'raising',
      { ...raising, pausedSeconds: [0, 1] },
      /pausedSeconds: expected one pause per Healer \(1\), got 2/,
    ],
    ['a pause that is no number', 'raising', { ...raising, pausedSeconds: ['1'] }, /pausedSeconds\[0\]: expected a finite number, got string/],
    ['a negative pause', 'raising', { ...raising, pausedSeconds: [-1] }, /pausedSeconds\[0\]: expected a non-negative number/],
    ['a blow without its outcome', 'blow', { attackerId: 'a', targetId: 'b' }, /hit: expected a bool/],
    ['a blow without its target', 'blow', { attackerId: 'a', hit: false }, /targetId: expected a string, got nothing/],
    ['a mend without its target', 'mend', {}, /targetId: expected/],
    ['a sensed bearing without its name', 'sensed', { bearings: [{ x: 1, z: 2 }] }, /name: expected a string, got nothing/],
    ['an over-cap sensed name', 'sensed', { bearings: [{ name: overCapId, x: 1, z: 2 }] }, /name: exceeds 64 UTF-8 bytes/],
    [
      'a sensed bearing past the metre cap',
      'sensed',
      { bearings: [{ name: 'Mira', x: 1, z: SOMNIO_PROTOCOL_CONSTANTS.maxCoordinateMetres + 1 }] },
      /z: exceeds 10000 metres/,
    ],
    [
      'more sensed bearings than the cap',
      'sensed',
      // The first bearing is no object, so only a count checked before the bearings reports the cap.
      { bearings: [7, ...Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxSensedBearings }, (_, index) => ({ name: `d${index}`, x: 0, z: 0 }))] },
      /bearings: exceeds 32 records \(got 33\)/,
    ],
    ['vitals below 0', 'vitals', { entityId: 'monster:7', health: -0.01 }, /health: expected a number from 0 to 1, got -0.01/],
    ['vitals above 1', 'vitals', { entityId: 'monster:7', health: 1.01 }, /health: expected a number from 0 to 1, got 1.01/],
    ['vitals without their entity', 'vitals', { health: 0.5 }, /entityId: expected a string, got nothing/],
    ['an ability id outside the id alphabet', 'useAbility', { abilityId: 'Brace' }, /abilityId: expected an id/],
    ['a use of no ability', 'useAbility', {}, /abilityId: expected a string, got nothing/],
    ['an ability used by no one', 'ability', { abilityId: 'brace' }, /entityId: expected a string, got nothing/],
    ['an empty ability target', 'ability', { entityId: 'a', abilityId: 'brace', targetId: '' }, /targetId: expected a non-empty string/],
    ['an unknown ability phase', 'ability', { entityId: 'a', abilityId: 'deep-mend', phase: 'paused' }, /unknown value "paused"/],
    ['a channel begun without its length', 'ability', { entityId: 'a', abilityId: 'deep-mend', phase: 'start' }, /seconds: expected the seconds of a channel/],
    ['a channel under way without its time left', 'ability', { entityId: 'a', abilityId: 'deep-mend', phase: 'channel' }, /seconds: expected the seconds/],
    [
      'a channel with negative time left',
      'ability',
      { entityId: 'a', abilityId: 'deep-mend', phase: 'channel', seconds: -1 },
      /seconds: expected a non-negative number/,
    ],
    [
      'a landed channel with seconds',
      'ability',
      { entityId: 'a', abilityId: 'deep-mend', phase: 'done', seconds: 0 },
      /seconds: expected no seconds outside a channel/,
    ],
    ['an instant ability with seconds', 'ability', { entityId: 'a', abilityId: 'brace', seconds: 1 }, /seconds: expected no seconds outside a channel/],
    ['an evasion that is no bool', 'ability', { entityId: 'a', abilityId: 'dream-bolt', evaded: 1 }, /evaded: expected a bool/],
    ['an effect id outside the id alphabet', 'effects', { entityId: 'a', effects: [{ effectId: 'Braced', seconds: 1 }] }, /effectId: expected an id/],
    [
      'an effect with negative time left',
      'effects',
      { entityId: 'a', effects: [{ effectId: 'braced', seconds: -1 }] },
      /seconds: expected a non-negative number/,
    ],
    [
      'more effects than the cap',
      'effects',
      // The first effect is no object, so only a count checked before the effects reports the cap.
      { entityId: 'a', effects: [7, ...Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxEntityEffects }, (_, index) => ({ effectId: `e${index}` }))] },
      /effects: exceeds 32 records \(got 33\)/,
    ],
    ['a global cooldown with negative time left', 'cooldowns', { globalSeconds: -0.5, cooldowns: [] }, /globalSeconds: expected a non-negative number/],
    ['a cooldown without its time left', 'cooldowns', { globalSeconds: 0, cooldowns: [{ abilityId: 'brace' }] }, /seconds: expected a finite number/],
    [
      'more cooldowns than the cap',
      'cooldowns',
      // The first cooldown is no object, so only a count checked before the cooldowns reports the cap.
      {
        globalSeconds: 0,
        cooldowns: [7, ...Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxAbilityCooldowns }, (_, index) => ({ abilityId: `a${index}`, seconds: 1 }))],
      },
      /cooldowns: exceeds 32 records \(got 33\)/,
    ],
    ['an unknown speech kind on a clientSay', 'clientSay', { text: 'hallo', kind: 'sing' }, /unknown value "sing"/],
    ['a clientSay without its kind', 'clientSay', { text: 'hallo' }, /kind: expected a string, got nothing/],
    ['an unknown locale on a login', 'login', { email: 'info@example.com', password: 'hunter2', locale: 'fr' }, /locale: unknown value "fr"/],
    ['an unknown locale on a redeemSession', 'redeemSession', { token: 'tok-abc', locale: 'en-GB' }, /locale: unknown value "en-GB"/],
    ['an unknown speech kind on a serverSay', 'serverSay', { ...say, kind: 'sing' }, /unknown value "sing"/],
    ['a clarity below 0', 'serverSay', { ...say, clarity: -0.1 }, /clarity: expected a number from 0 to 1, got -0.1/],
    ['a clarity above 1', 'serverSay', { ...say, clarity: 1.5 }, /clarity: expected a number from 0 to 1, got 1.5/],
    ['a voice past the metre cap', 'serverSay', { ...say, x: SOMNIO_PROTOCOL_CONSTANTS.maxCoordinateMetres + 1 }, /x: exceeds 10000 metres/],
  ])('rejects %s', (_case, tag, payload, expected) => {
    expect(() => decodeSomnioMessage(frame(tag, payload))).toThrow(expected);
  });

  /** One byte under the rejection, so the cases above pin boundaries rather than "large values fail". */
  it('accepts values at their caps', () => {
    const atCapEntityId = 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxEntityIdUTF8Bytes);
    const atCapId = 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxIdentifierUTF8Bytes);
    const atCapSectorName = 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSectorNameUTF8Bytes);
    expect(() => decodeSomnioMessage(frame('target', { targetId: atCapEntityId }))).not.toThrow();
    expect(() => decodeSomnioMessage(frame('talk', { npcId: `npc:${atCapSectorName}/${atCapId}` }))).not.toThrow();
    expect(() => decodeSomnioMessage(frame('useDoor', { sector: atCapSectorName, doorId: atCapId }))).not.toThrow();
    expect(() => decodeSomnioMessage(frame('doorRefused', { sector: atCapSectorName, doorId: atCapId }))).not.toThrow();
    expect(() => decodeSomnioMessage(frame('enterSpace', { spaceId: atCapSectorName, selfId: 'a', people: 'vigils', worldSeconds: 0 }))).not.toThrow();
    expect(() => decodeSomnioMessage(frame('move', { ...move, x: -SOMNIO_PROTOCOL_CONSTANTS.maxCoordinateMetres }))).not.toThrow();
    expect(() => decodeSomnioMessage(frame('enterSpace', { spaceId: 'outdoors', selfId: 'a', people: 'vigils', worldSeconds: 0 }))).not.toThrow();
    expect(() => decodeSomnioMessage(frame('inventory', { ...inventory, coins: 0, bag: [{ place: 0, item: { ...item, baseId: atCapId } }] }))).not.toThrow();
    const atCapBag = Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxBagItems }, (_, index) => ({
      place: SOMNIO_PROTOCOL_CONSTANTS.maxBagItems - 1 - index,
      item: { ...item, id: `i${index}` },
    }));
    expect(() => decodeSomnioMessage(frame('inventory', { ...inventory, bag: atCapBag }))).not.toThrow();
    const atCapAffixes = Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxItemAffixes }, () => item.affixes[0]);
    expect(() => decodeSomnioMessage(frame('inventory', { ...inventory, bag: [{ place: 0, item: { ...item, affixes: atCapAffixes } }] }))).not.toThrow();
    const everySlotWorn = EQUIP_SLOTS.map((slot) => ({ slot, item }));
    expect(() => decodeSomnioMessage(frame('inventory', { ...inventory, equipped: everySlotWorn }))).not.toThrow();
    const atCapMoves = Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxMovesPerFrame }, (_, index) => ({ ...move, id: `m${index}` }));
    expect(() => decodeSomnioMessage(frame('moves', { moves: atCapMoves }))).not.toThrow();
    const atCapRanks = Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxLucidityRanks }, (_, index) => ({ teachingId: `t${index}`, rank: 1, practice: 0 }));
    expect(() => decodeSomnioMessage(frame('lucidity', { ranks: atCapRanks }))).not.toThrow();
    const atCapHealers = Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxRaiseHealers }, (_, index) => `h${index}`);
    expect(() => decodeSomnioMessage(frame('raising', { targetId: 'b', healerIds: atCapHealers, state: 'holding', progress: 0, seconds: 0 }))).not.toThrow();
    const atCapCharacters = Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxCharactersPerAccount }, (_, index) => ({
      ...character,
      id: `c${index}`,
      name: atCapId,
    }));
    expect(() => decodeSomnioMessage(frame('characters', { characters: atCapCharacters }))).not.toThrow();
    const atCapEffects = Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxEntityEffects }, (_, index) => ({ effectId: `e${index}`, seconds: 1 }));
    expect(() => decodeSomnioMessage(frame('effects', { entityId: 'a', effects: atCapEffects }))).not.toThrow();
    const atCapCooldowns = Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxAbilityCooldowns }, (_, index) => ({ abilityId: `a${index}`, seconds: 1 }));
    expect(() => decodeSomnioMessage(frame('cooldowns', { globalSeconds: 0, cooldowns: atCapCooldowns }))).not.toThrow();
    const atCapBearings = Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxSensedBearings }, (_, index) => ({ name: `d${index}`, x: 0, z: 0 }));
    expect(() => decodeSomnioMessage(frame('sensed', { bearings: atCapBearings }))).not.toThrow();
  });
});

describe('round trips', () => {
  it.each(GOLDEN_FRAME_ENTRIES.map((entry) => [entry.name, entry.message] as const))('%s round-trips', (_name, message) => {
    expect(roundTrip(message)).toEqual(message);
  });

  it('login round-trips without the optional token request', () => {
    const message: SomnioMessage = {
      tag: 'login',
      payload: { email: 'info@example.com', password: 'hunter2' },
    };
    const decoded = roundTrip(message);
    expect(decoded).toEqual(message);
    expect('requestSessionToken' in decoded.payload).toBe(false);
  });

  /** Without a locale the server speaks English, so the key must stay absent rather than decode to a default. */
  it.each(['login', 'redeemSession'] as const)('%s decodes without a locale, and with each locale', (tag) => {
    const payload = tag === 'login' ? { email: 'info@example.com', password: 'hunter2' } : { token: 'tok-abc' };
    expect('locale' in decodeSomnioMessage(frame(tag, payload)).payload).toBe(false);
    for (const locale of LOCALES) expect(decodeSomnioMessage(frame(tag, { ...payload, locale }))).toEqual({ tag, payload: { ...payload, locale } });
  });

  /** The golden catalog records one member of each result set, and not this one. */
  it.each(['loginResult', 'registerResult'] as const)('%s decodes a throttled result', (tag) => {
    expect(decodeSomnioMessage(frame(tag, { result: 'throttled' }))).toEqual({ tag, payload: { result: 'throttled' } });
  });

  /** Without a teaching the request is for the master's trial, so the key must stay absent. */
  it('askTask round-trips a trial request without a teaching', () => {
    const message: SomnioMessage = { tag: 'askTask', payload: { npcId: 'npc:EdariaFighterHall/pugnax' } };
    const decoded = roundTrip(message);
    expect(decoded).toEqual(message);
    expect('teachingId' in decoded.payload).toBe(false);
  });

  it('lucidity decodes a dreamer with no role, study, or task without those keys', () => {
    const decoded = decodeSomnioMessage(frame('lucidity', { role: null, ranks: [], study: null, task: null }));
    expect(decoded).toEqual({ tag: 'lucidity', payload: { ranks: [] } });
  });

  /** Without a target a `target` clears, so the key must stay absent. */
  it('effects decodes an effect that lasts as long as its holder without a seconds key', () => {
    const decoded = decodeSomnioMessage(frame('effects', { entityId: 'monster:7', effects: [{ effectId: 'stony' }] }));
    expect(decoded).toEqual({ tag: 'effects', payload: { entityId: 'monster:7', effects: [{ effectId: 'stony' }] } });
  });

  it('target round-trips without a target', () => {
    const message: SomnioMessage = { tag: 'target', payload: {} };
    const decoded = roundTrip(message);
    expect(decoded).toEqual(message);
    expect('targetId' in decoded.payload).toBe(false);
  });

  it('entity decodes an NPC without a service without the key', () => {
    const decoded = decodeSomnioMessage(
      frame('entity', { id: 'a', kind: 'npc', characterModelId: 'libus', name: 'Libus', radius: 0.3, x: 0, z: 0, facing: 0, gait: 'walk', condition: 'hale' }),
    );
    expect('service' in decoded.payload).toBe(false);
    expect('held' in decoded.payload).toBe(false);
    expect('rank' in decoded.payload).toBe(false);
    expect('trait' in decoded.payload).toBe(false);
  });

  /** A verb with nothing to say still has to carry an object, and whatever a client puts in it is dropped. */
  it.each(['abandonTask', 'wake'] as const)('%s decodes to an empty payload', (tag) => {
    expect(decodeSomnioMessage(frame(tag, { extra: 1 }))).toEqual({ tag, payload: {} });
  });

  /** Only the frame a trade produced says what was traded, so every other frame must decode without the key. */
  it('inventory decodes a frame no trade produced without a trade key', () => {
    const inventory = { coins: 100, equipped: [], bag: [] };
    const decoded = decodeSomnioMessage(frame('inventory', { ...inventory, trade: null }));
    expect(decoded).toEqual({ tag: 'inventory', payload: inventory });
    expect('trade' in decoded.payload).toBe(false);
  });

  /** An empty hand is left out, so it must stay absent rather than decode to an empty id. */
  it('held decodes empty hands without their keys', () => {
    const decoded = decodeSomnioMessage(frame('held', { entityId: 'a', held: { mainHand: null, offHand: 'moonstone' } }));
    expect(decoded).toEqual({ tag: 'held', payload: { entityId: 'a', held: { offHand: 'moonstone' } } });
  });

  /** World time is fractional and far past what an integer or a narrowed float field could carry. */
  it('enterSpace round-trips a fractional world time near year 500 exactly', () => {
    const message: SomnioMessage = {
      tag: 'enterSpace',
      payload: { spaceId: 'EdariaLibrary', selfId: 'a', people: 'vigils', worldSeconds: 500 * 12 * 28 * 86_400 + 0.125 },
    };
    expect(roundTrip(message)).toEqual(message);
  });

  /** A resume straight into the world learns the player's own people from `enterSpace` alone. */
  it.each(['vigils', 'sopors', 'umbrae', 'lumina'])('enterSpace round-trips the people %s', (people) => {
    const message: SomnioMessage = { tag: 'enterSpace', payload: { spaceId: 'outdoors', selfId: 'a', people, worldSeconds: 0 } };
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

  it('pins GroundShapeKind', () => {
    expect(GROUND_SHAPE_KINDS).toEqual(['stroke', 'polygon']);
  });

  it('pins EquipSlot', () => {
    expect(EQUIP_SLOTS).toEqual(['mainHand', 'offHand', 'head', 'chest', 'hands', 'legs', 'feet', 'neck', 'ring1', 'ring2']);
  });

  it('pins Hand', () => {
    expect(HANDS).toEqual(['mainHand', 'offHand']);
  });

  it('pins Rarity', () => {
    expect(RARITIES).toEqual(['plain', 'magic', 'rare']);
  });

  it('pins SectorKind', () => {
    expect(SECTOR_KINDS).toEqual(['outdoor', 'interior']);
  });

  it('pins LoginResult', () => {
    expect(LOGIN_RESULTS).toEqual(['ok', 'badCredentials', 'alreadyLoggedIn', 'throttled']);
  });

  it('pins CharacterResult', () => {
    expect(CHARACTER_RESULTS).toEqual(['ok', 'nameExists', 'nameNotAllowed', 'full', 'failure']);
  });

  it('pins RegisterResult', () => {
    expect(REGISTER_RESULTS).toEqual(['ok', 'emailExists', 'failure', 'throttled']);
  });

  it('pins Role', () => {
    expect(ROLES).toEqual(['fighter', 'healer', 'mystic']);
  });

  it('pins NPCService', () => {
    expect(NPC_SERVICES).toEqual(['fighterMaster', 'healerMaster', 'mysticMaster', 'shopkeeper']);
  });

  it('pins Locale', () => {
    expect(LOCALES).toEqual(['en', 'de']);
  });

  it('pins Condition', () => {
    expect(CONDITIONS).toEqual(['hale', 'grazed', 'wounded', 'hurt', 'failing', 'fallen']);
  });

  it('pins RaisingState', () => {
    expect(RAISING_STATES).toEqual(['holding', 'broken', 'done']);
  });

  it('pins AbilityPhase', () => {
    expect(ABILITY_PHASES).toEqual(['start', 'channel', 'done', 'broken']);
  });

  it('pins SpeechKind', () => {
    expect(SPEECH_KINDS).toEqual(['whisper', 'say', 'yell']);
  });

  it('pins TradeKind', () => {
    expect(TRADE_KINDS).toEqual(['bought', 'sold']);
  });

  it('pins LootKind', () => {
    expect(LOOT_KINDS).toEqual(['item']);
  });

  it('pins NightmareRank', () => {
    expect(NIGHTMARE_RANKS).toEqual(['elite', 'boss']);
  });

  it('pins TelegraphKind', () => {
    expect(TELEGRAPH_KINDS).toEqual(['wail']);
  });
});

/**
 * The protocol constants as literals. `helloVersion` is strict equality at the hello gate on both
 * sides; the byte caps are what the registration form and the server's handlers both read.
 */
describe('protocol constants', () => {
  it('pins the frame and handshake constants', () => {
    expect(SOMNIO_PROTOCOL_CONSTANTS.helloVersion).toBe(21);
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
    expect(SOMNIO_PROTOCOL_CONSTANTS.maxSectorGroundMarks).toBe(512);
    expect(SOMNIO_PROTOCOL_CONSTANTS.maxSectorGroundPoints).toBe(8192);
    expect(SOMNIO_PROTOCOL_CONSTANTS.markFeatherMetres).toBe(0.6);
    expect(SOMNIO_PROTOCOL_CONSTANTS.markEdgeNoiseMetres).toBe(0.375);
    expect(SOMNIO_PROTOCOL_CONSTANTS.maxMarkStrokeRadiusMetres).toBe(10);
    expect(SOMNIO_PROTOCOL_CONSTANTS.maxRaiseHealers).toBe(32);
    expect(SOMNIO_PROTOCOL_CONSTANTS.maxBagItems).toBe(24);
    expect(SOMNIO_PROTOCOL_CONSTANTS.maxItemAffixes).toBe(8);
    expect(SOMNIO_PROTOCOL_CONSTANTS.maxLucidityRanks).toBe(32);
    expect(SOMNIO_PROTOCOL_CONSTANTS.maxEntityEffects).toBe(32);
    expect(SOMNIO_PROTOCOL_CONSTANTS.maxAbilityCooldowns).toBe(32);
    expect(SOMNIO_PROTOCOL_CONSTANTS.maxSensedBearings).toBe(32);
    expect(SOMNIO_PROTOCOL_CONSTANTS.maxCharactersPerAccount).toBe(4);
    expect(SOMNIO_PROTOCOL_CONSTANTS.maxMovesPerFrame).toBe(256);
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
  const say = { entityId: 'a', name: 'Alice', kind: 'say', clarity: 1, x: 0, z: 0 };

  it('rejects a serverSay past the say cap', () => {
    const overCap = 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes + 1);
    expect(() => decodeSomnioMessage(frame('serverSay', { ...say, text: overCap }))).toThrow(WireDecodingError);
    // One byte under is accepted, so the test pins the boundary rather than "long strings fail".
    const atCap = 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes);
    expect(() => decodeSomnioMessage(frame('serverSay', { ...say, text: atCap }))).not.toThrow();
  });

  /** A speaker's name is an entity name by another route, bounded the same way. */
  it('truncates an over-cap speaker name on a serverSay instead of rejecting the frame', () => {
    const cap = SOMNIO_PROTOCOL_CONSTANTS.maxIdentifierUTF8Bytes;
    const decoded = decodeSomnioMessage(frame('serverSay', { ...say, name: 'a'.repeat(cap + 40), text: 'hallo' }));
    if (decoded.tag !== 'serverSay') throw new Error('expected a serverSay frame');
    expect(utf8ByteLength(decoded.payload.name)).toBe(cap);
  });

  /** Counted in UTF-8 bytes, not code units: 100 emoji are 400 bytes but a `.length` of 200. */
  it('counts the say cap in UTF-8 bytes rather than code units', () => {
    const emoji = '😀'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes / 4 + 1);
    expect(emoji.length).toBeLessThan(SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes);
    expect(utf8ByteLength(emoji)).toBeGreaterThan(SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes);
    expect(() => decodeSomnioMessage(frame('serverSay', { ...say, text: emoji }))).toThrow(WireDecodingError);
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
    const base = { id: 'a', kind: 'npc', characterModelId: 'libus', radius: 0.3, x: 0, z: 0, facing: 0, gait: 'walk', condition: 'hale' };
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
    expect(decodeSomnioMessage(frame('clientSay', { text: overCapSay, kind: 'say' }))).toEqual({
      tag: 'clientSay',
      payload: { text: overCapSay, kind: 'say' },
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
