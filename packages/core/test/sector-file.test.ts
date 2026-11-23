import { describe, expect, it } from 'vitest';
import { SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import { SOMNIO_CONSTANTS } from '../src/constants.ts';
import { SectorFileError, readSectorFile, writeSectorFile } from '../src/sectorFile.ts';
import type { MonsterSpawn, SectorNPC } from '../src/sector.ts';
import { SECTOR_FIXTURE_NAMES, readSectorFixture } from './support/sectorFixture.ts';
import { interiorSector, outdoorSector } from './support/worldFixture.ts';

/**
 * The `.somnio-sector` codec against the committed fixtures — a **raw** comparison, not
 * canonicalized JSON: for this format byte identity is exactly right. A failure here means an
 * authored save would rewrite unrelated bytes of every sector the server loads.
 */

function npc(overrides: Partial<SectorNPC> = {}): SectorNPC {
  return { id: 'libus', name: 'Libus', characterModelId: 'libus', x: 1, z: 1, facing: 0, dialog: [], ...overrides };
}

function monsterSpawn(overrides: Partial<MonsterSpawn> = {}): MonsterSpawn {
  return { id: 'spawn-1', kind: 'ghost', x: 1, z: 1, width: 4, depth: 4, maxAlive: 3, eliteChance: 0, ...overrides };
}

/** An interior sector file holding one NPC built from raw JSON, for the reader's refusals of what the model cannot express. */
function roomWithNPC(record: Record<string, unknown>): string {
  const room = JSON.parse(writeSectorFile(interiorSector('Room'))) as Record<string, unknown>;
  return JSON.stringify({ ...room, npcs: [{ id: 'libus', name: 'Libus', characterModelId: 'libus', x: 1, z: 1, facing: 0, ...record }] });
}

/** A committed sector file with one piece of its text replaced, for the reader's refusals. */
function edited(name: (typeof SECTOR_FIXTURE_NAMES)[number], from: string, to: string): string {
  const text = readSectorFixture(name);
  expect(text).toContain(from);
  return text.replace(from, to);
}

describe('fixture byte stability', () => {
  it.each(SECTOR_FIXTURE_NAMES)('%s round-trips byte-identical', (name) => {
    const text = readSectorFixture(name);
    expect(writeSectorFile(readSectorFile(text, name))).toBe(text);
  });
});

describe('the written form', () => {
  it('is 2-space JSON with sorted keys, a trailing newline, and no name', () => {
    expect(writeSectorFile(interiorSector('Room'))).toBe(
      [
        '{',
        '  "brightness": 100,',
        '  "ground": {',
        '    "backgroundMaterialId": "grass"',
        '  },',
        '  "kind": "interior",',
        '  "size": {',
        '    "depth": 10,',
        '    "width": 10',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('leaves out every default and reads it back', () => {
    const sector = outdoorSector('Town', { x: 0, z: 0 }, { placements: [{ id: 'box-1', modelId: 'box', x: 1, z: 2, yaw: 0, elevation: 0 }] });
    const text = writeSectorFile(sector);
    for (const key of ['yaw', 'elevation', 'marks', 'blockers', 'doors', 'npcs', 'monsterSpawns', 'spawn']) {
      expect(text).not.toContain(`"${key}"`);
    }
    expect(readSectorFile(text, 'Town')).toEqual(sector);
  });

  it("writes an NPC's service and reads it back, and writes none for an NPC without one", () => {
    const sector = interiorSector('Inn', { spawn: { x: 3, z: 4, facing: 0 }, npcs: [npc({ id: 'sana', service: 'healerMaster' }), npc()] });
    const text = writeSectorFile(sector);
    expect(text.match(/"service"/g)).toHaveLength(1);
    expect(text).toContain('"service": "healerMaster"');
    expect(readSectorFile(text, 'Inn')).toEqual(sector);
  });

  it("writes a monster spawn's elite chance and reads it back, and writes none at 0", () => {
    const sector = interiorSector('Crypt', { monsterSpawns: [monsterSpawn({ eliteChance: 0.15 }), monsterSpawn({ id: 'spawn-2' })] });
    const text = writeSectorFile(sector);
    expect(text.match(/"eliteChance"/g)).toHaveLength(1);
    expect(text).toContain('"eliteChance": 0.15');
    expect(readSectorFile(text, 'Crypt')).toEqual(sector);
  });

  it('writes what differs from a default', () => {
    const sector = outdoorSector(
      'Town',
      { x: 0, z: 0 },
      {
        placements: [{ id: 'candle-1', modelId: 'candle', x: 1, z: 2, yaw: 137.5, elevation: 0.76 }],
        spawn: { x: 3, z: 4, facing: 90 },
        npcs: [npc({ greeting: 'Grüß dich, "$name".', dialog: [{ text: 'Bis bald.' }] })],
        monsterSpawns: [monsterSpawn()],
      },
    );
    const text = writeSectorFile(sector);
    expect(text).toContain('"yaw": 137.5');
    expect(text).toContain('"elevation": 0.76');
    expect(text).toContain('"greeting": "Grüß dich, \\"$name\\"."');
    expect(readSectorFile(text, 'Town')).toEqual(sector);
  });

  it("writes an NPC's greeting and each shape of a step's when, and reads them back byte-identical", () => {
    const pugnax = npc({
      id: 'pugnax',
      service: 'fighterMaster',
      greeting: 'Well, $name?',
      dialog: [
        { text: 'Whoever would learn from me first drives off a nightmare.', when: { quest: 'fighter-trial', state: 'offered' } },
        { text: 'Meet a blow with your guard.', when: { role: 'own' } },
        { text: 'You walk another path now.', when: { role: 'other' } },
        { text: 'Stand up straight.', when: { role: 'none' } },
        { text: 'In the north the dream frays.' },
      ],
    });
    const sector = interiorSector('Hall', { npcs: [pugnax] });
    const text = writeSectorFile(sector);
    expect(text.match(/"when"/g)).toHaveLength(4);
    expect(readSectorFile(text, 'Hall')).toEqual(sector);
    expect(writeSectorFile(readSectorFile(text, 'Hall'))).toBe(text);
  });

  it('writes neither a greeting nor a dialog for an NPC with neither', () => {
    const text = writeSectorFile(interiorSector('Room', { npcs: [npc()] }));
    expect(text).not.toContain('"greeting"');
    expect(text).not.toContain('"dialog"');
    expect(readSectorFile(text, 'Room').npcs).toEqual([npc()]);
  });
});

describe('reader validation', () => {
  /** The x and z of the Arena's first placement, the refuge's north-west floor tile. No other record stands at this point. */
  const FIRST_PLACEMENT_X = '"x": 8.32,\n      "z": 0.64';

  it('rejects invalid JSON', () => {
    expect(() => readSectorFile('not json', 'X')).toThrow(SectorFileError);
  });

  it('rejects an oversized file before parsing', () => {
    expect(() => readSectorFile(' '.repeat(SOMNIO_CONSTANTS.maxSectorFileBytes + 1), 'X')).toThrow(/file size/);
  });

  it.each([
    ['a missing required field', '"backgroundMaterialId"', '"background"', /sector\.ground\.backgroundMaterialId/],
    ['a non-numeric coordinate', FIRST_PLACEMENT_X, FIRST_PLACEMENT_X.replace('8.32', '"8.32"'), /sector\.placements\[0\]\.x/],
    ['a coordinate out of range', FIRST_PLACEMENT_X, FIRST_PLACEMENT_X.replace('8.32', '1e9'), /exceeds 10000 metres/],
    ['a size beyond the extent cap', '"width": 10.24', '"width": 600', /exceeds 512 metres/],
    ['an unknown kind', '"kind": "interior"', '"kind": "indoor"', /sector\.kind/],
    ['an origin on an interior', '"kind": "interior"', '"kind": "interior", "origin": { "x": 0, "z": 0 }', /origin: not allowed on an interior sector/],
    ['an interior without brightness', '"brightness": 75,', '', /sector\.brightness/],
    ['a duplicate record id', '"id": "floor-boards-2"', '"id": "floor-boards-1"', /duplicate id "floor-boards-1"/],
    ['an id outside the id alphabet', '"id": "bench-1"', '"id": "Bench 1"', /lowercase letters, digits, and hyphens/],
    ['a door on a placement the sector lacks', '"placement": "door-1"', '"placement": "door-9"', /no placement "door-9"/],
    ['an unknown monster kind', '"kind": "ghost"', '"kind": "drache"', /monsterSpawns\[0\]\.kind/],
    ['a spawn that keeps nothing alive', '"maxAlive": 3', '"maxAlive": 0', /maxAlive: expected 1 to 16/],
    ['a spawn area without extent', '"width": 2.84', '"width": 0', /expected a positive length/],
    ['an elite chance above 1', '"maxAlive": 3', '"maxAlive": 3, "eliteChance": 1.5', /monsterSpawns\[0\]\.eliteChance: expected a number from 0 to 1/],
    ['an elite chance below 0', '"maxAlive": 3', '"maxAlive": 3, "eliteChance": -0.1', /monsterSpawns\[0\]\.eliteChance: expected a number from 0 to 1/],
  ])('rejects %s', (_name, from, to, message) => {
    const text = edited('EdariaArena', from, to);
    expect(() => readSectorFile(text, 'EdariaArena')).toThrow(SectorFileError);
    expect(() => readSectorFile(text, 'EdariaArena')).toThrow(message);
  });

  it('rejects an NPC service it does not know', () => {
    const text = edited('EdariaLibrary', '"id": "libus"', '"id": "libus", "service": "banker"');
    expect(() => readSectorFile(text, 'EdariaLibrary')).toThrow(/npcs\[0\]\.service: unknown value "banker"/);
  });

  it.each([
    ['a script', 'Hello.\n---\nBye.'],
    ['null', null],
  ])('rejects an NPC still carrying a dialogScript of %s, even beside a valid dialog', (_case, dialogScript) => {
    const text = roomWithNPC({ dialogScript, dialog: [{ text: 'Bye.' }] });
    expect(() => readSectorFile(text, 'Room')).toThrow(/npcs\[0\]\.dialogScript: replaced by "dialog"/);
  });

  it('rejects more dialog steps than an NPC may hold before decoding any of them', () => {
    const text = roomWithNPC({ dialog: Array.from({ length: SOMNIO_CONSTANTS.maxNPCDialogSteps + 1 }, () => ({})) });
    expect(() => readSectorFile(text, 'Room')).toThrow(/npcs\[0\]\.dialog: exceeds 32 records/);
  });

  it.each([
    ['an empty greeting', { greeting: '' }, /npcs\[0\]\.greeting: says nothing/],
    ['a greeting of spaces', { greeting: '   ' }, /npcs\[0\]\.greeting: says nothing/],
    ['a greeting past the budget', { greeting: 'a'.repeat(101) }, /npcs\[0\]\.greeting: runs past 100 graphemes/],
    ['an empty step', { dialog: [{ text: '' }] }, /npcs\[0\]\.dialog\[0\]\.text: says nothing/],
    ['a step of spaces', { dialog: [{ text: '   ' }] }, /npcs\[0\]\.dialog\[0\]\.text: says nothing/],
    // 101 bytes, well within the say cap, so only the budget refuses it.
    ['a step of 101 graphemes', { dialog: [{ text: 'a'.repeat(101) }] }, /npcs\[0\]\.dialog\[0\]\.text: runs past 100 graphemes/],
    ['an unknown quest', { dialog: [{ text: 'Hi.', when: { quest: 'dragon-hunt', state: 'held' } }] }, /dialog\[0\]\.when\.quest: unknown value "dragon-hunt"/],
    [
      'an unknown quest standing',
      { dialog: [{ text: 'Hi.', when: { quest: 'fighter-trial', state: 'lost' } }] },
      /dialog\[0\]\.when\.state: unknown value "lost"/,
    ],
    [
      'a when mixing both shapes',
      { dialog: [{ text: 'Hi.', when: { role: 'none', quest: 'fighter-trial', state: 'held' } }] },
      /dialog\[0\]\.when: expected either/,
    ],
    ['an empty when', { dialog: [{ text: 'Hi.', when: {} }] }, /dialog\[0\]\.when: expected either/],
  ])('rejects %s', (_name, record, message) => {
    expect(() => readSectorFile(roomWithNPC(record), 'Room')).toThrow(message);
  });

  it.each(['own', 'other'])('rejects a step for the %s role on an NPC that is no master', (role) => {
    for (const service of [{}, { service: 'shopkeeper' }]) {
      const text = roomWithNPC({ ...service, dialog: [{ text: 'Hi.', when: { role } }] });
      expect(() => readSectorFile(text, 'Room')).toThrow(new RegExp(`dialog\\[0\\]\\.when\\.role: "${role}" is for a master's steps`));
    }
  });

  it('reads a step for no role on an NPC that is no master', () => {
    for (const service of [{}, { service: 'shopkeeper' }]) {
      const text = roomWithNPC({ ...service, dialog: [{ text: 'Hi.', when: { role: 'none' } }] });
      expect(readSectorFile(text, 'Room').npcs[0]!.dialog).toEqual([{ text: 'Hi.', when: { role: 'none' } }]);
    }
  });

  it('takes the sector name from the caller, never from the file', () => {
    const text = edited('EdariaArena', '"kind": "interior"', '"kind": "interior", "name": "Elsewhere"');
    expect(readSectorFile(text, 'EdariaArena').name).toBe('EdariaArena');
  });

  it('normalizes an out-of-range facing rather than rejecting it', () => {
    const libus = '"facing": 0,\n      "greeting": "Greetings, $name!"';
    const sector = readSectorFile(edited('EdariaLibrary', libus, libus.replace('0', '450')), 'EdariaLibrary');
    expect(sector.npcs[0]?.facing).toBe(90);
  });
});

/** The editor saves through the writer, so everything the server would refuse at boot is refused at save. */
describe('writer guards', () => {
  it('rejects more NPCs or monster spawns than a sector may hold', () => {
    const npcs = Array.from({ length: SOMNIO_CONSTANTS.maxSectorNPCs + 1 }, (_, index) => npc({ id: `npc-${index}` }));
    expect(() => writeSectorFile(interiorSector('Room', { npcs }))).toThrow(/npcs: exceeds 4096 records/);
    const monsterSpawns = Array.from({ length: SOMNIO_CONSTANTS.maxSectorMonsterSpawns + 1 }, (_, index) => monsterSpawn({ id: `spawn-${index}` }));
    expect(() => writeSectorFile(interiorSector('Room', { monsterSpawns }))).toThrow(/monsterSpawns: exceeds 4096 records/);
  });

  /** 30 m wide and 20 m deep, away from the space's origin: an NPC's position is relative to its sector, and the two extents differ. */
  const field = (npcs: SectorNPC[]) => outdoorSector('Field', { x: 40, z: -20 }, { size: { width: 30, depth: 20 }, npcs });

  it.each([
    ['east', { x: 30.0005, z: 10 }],
    ['west', { x: -0.0005, z: 10 }],
    ['south', { x: 15, z: 20.0005 }],
    ['north', { x: 15, z: -0.0005 }],
  ])('rejects an NPC standing half a millimetre %s of its sector', (_side, at) => {
    expect(() => writeSectorFile(field([npc(at)]))).toThrow(/npcs\[0\]: stands outside the sector/);
  });

  it('accepts an NPC standing on the edge of its sector', () => {
    const npcs = [npc({ id: 'north-west', x: 0, z: 0 }), npc({ id: 'south-east', x: 30, z: 20 })];
    expect(readSectorFile(writeSectorFile(field(npcs)), 'Field').npcs).toEqual(npcs);
  });

  it('rejects a dialog step that could exceed the say cap once it names the longest character name', () => {
    // Four bytes and one grapheme each, so the line reaches the say cap at 60 budgeted graphemes.
    const atCap = `${'🌙'.repeat((SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes - SOMNIO_PROTOCOL_CONSTANTS.maxIdentifierUTF8Bytes) / 4)}$name`;
    const room = (text: string) => interiorSector('Room', { npcs: [npc({ dialog: [{ text }] })] });
    expect(readSectorFile(writeSectorFile(room(atCap)), 'Room').npcs[0]?.dialog).toEqual([{ text: atCap }]);
    expect(() => writeSectorFile(room(`${atCap}a`))).toThrow(/npcs\[0\]\.dialog\[0\]\.text: can exceed 256 UTF-8 bytes/);
  });

  it('rejects a spawn keeping more alive than the cap', () => {
    const monsterSpawns = [monsterSpawn({ maxAlive: SOMNIO_CONSTANTS.maxSpawnAlive + 1 })];
    expect(() => writeSectorFile(interiorSector('Room', { monsterSpawns }))).toThrow(/maxAlive: expected 1 to 16, got 17/);
  });

  it('rejects brightness on an outdoor sector', () => {
    expect(() => writeSectorFile(outdoorSector('Town', { x: 0, z: 0 }, { brightness: 70 }))).toThrow(/brightness: not allowed on an outdoor sector/);
  });

  it('rejects a coordinate that is not a finite number', () => {
    const blockers = [{ id: 'wall', x: Number.NaN, z: 0, width: 1, depth: 1 }];
    expect(() => writeSectorFile(interiorSector('Room', { blockers }))).toThrow(SectorFileError);
  });

  it('rejects a serialized file over the byte cap', () => {
    const npcs = [npc({ dialog: [{ text: 'a'.repeat(SOMNIO_CONSTANTS.maxSectorFileBytes) }] })];
    expect(() => writeSectorFile(interiorSector('Room', { npcs }))).toThrow(/file size/);
  });

  it('measures the byte cap in UTF-8 bytes, not UTF-16 code units', () => {
    // An umlaut is one code unit but two UTF-8 bytes, so a `.length` check would pass this.
    const halfCap = Math.trunc(SOMNIO_CONSTANTS.maxSectorFileBytes / 2);
    const npcs = [npc({ dialog: [{ text: 'ü'.repeat(halfCap + 512) }] })];
    expect(() => writeSectorFile(interiorSector('Room', { npcs }))).toThrow(/file size/);
  });
});
