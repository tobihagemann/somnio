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
  return { id: 'libus', name: 'Libus', characterModelId: 'libus', x: 1, z: 1, facing: 0, dialogScript: '', ...overrides };
}

function monsterSpawn(overrides: Partial<MonsterSpawn> = {}): MonsterSpawn {
  return { id: 'spawn-1', kind: 'gespenst', x: 1, z: 1, width: 4, depth: 4, maxAlive: 3, ...overrides };
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
        '  "floorMaterialId": "grass",',
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
    for (const key of ['yaw', 'elevation', 'floorPatches', 'blockers', 'doors', 'npcs', 'monsterSpawns', 'spawn']) {
      expect(text).not.toContain(`"${key}"`);
    }
    expect(readSectorFile(text, 'Town')).toEqual(sector);
  });

  it('writes what differs from a default', () => {
    const sector = outdoorSector(
      'Town',
      { x: 0, z: 0 },
      {
        placements: [{ id: 'candle-1', modelId: 'candle', x: 1, z: 2, yaw: 137.5, elevation: 0.76 }],
        spawn: { x: 3, z: 4, facing: 90 },
        npcs: [npc({ dialogScript: 'Grüß dich, "$name".\n---\nBis bald.' })],
        monsterSpawns: [monsterSpawn()],
      },
    );
    const text = writeSectorFile(sector);
    expect(text).toContain('"yaw": 137.5');
    expect(text).toContain('"elevation": 0.76');
    expect(text).toContain('Grüß dich, \\"$name\\".\\n---\\nBis bald.');
    expect(readSectorFile(text, 'Town')).toEqual(sector);
  });
});

describe('reader validation', () => {
  it('rejects invalid JSON', () => {
    expect(() => readSectorFile('not json', 'X')).toThrow(SectorFileError);
  });

  it('rejects an oversized file before parsing', () => {
    expect(() => readSectorFile(' '.repeat(SOMNIO_CONSTANTS.maxSectorFileBytes + 1), 'X')).toThrow(/file size/);
  });

  it.each([
    ['a missing required field', '"floorMaterialId"', '"floorMaterial"', /sector\.floorMaterialId/],
    ['a non-numeric coordinate', '"x": 10.145', '"x": "10.145"', /sector\.placements\[0\]\.x/],
    ['a coordinate out of range', '"x": 10.145', '"x": 1e9', /exceeds 10000 metres/],
    ['a size beyond the extent cap', '"width": 10.24', '"width": 600', /exceeds 512 metres/],
    ['an unknown kind', '"kind": "interior"', '"kind": "indoor"', /sector\.kind/],
    ['an origin on an interior', '"kind": "interior"', '"kind": "interior", "origin": { "x": 0, "z": 0 }', /origin: not allowed on an interior sector/],
    ['an interior without brightness', '"brightness": 75,', '', /sector\.brightness/],
    ['a duplicate record id', '"id": "blocker-2"', '"id": "blocker-1"', /duplicate id "blocker-1"/],
    ['an id outside the id alphabet', '"id": "blocker-1"', '"id": "Blocker 1"', /lowercase letters, digits, and hyphens/],
    ['a door on a placement the sector lacks', '"placement": "door-1"', '"placement": "door-9"', /no placement "door-9"/],
    ['an unknown monster kind', '"kind": "gespenst"', '"kind": "drache"', /monsterSpawns\[0\]\.kind/],
    ['a spawn that keeps nothing alive', '"maxAlive": 3', '"maxAlive": 0', /maxAlive: expected 1 to 16/],
    ['a spawn area without extent', '"width": 7.04', '"width": 0', /expected a positive length/],
  ])('rejects %s', (_name, from, to, message) => {
    const text = edited('EdariaArena', from, to);
    expect(() => readSectorFile(text, 'EdariaArena')).toThrow(SectorFileError);
    expect(() => readSectorFile(text, 'EdariaArena')).toThrow(message);
  });

  it('takes the sector name from the caller, never from the file', () => {
    const text = edited('EdariaArena', '"kind": "interior"', '"kind": "interior", "name": "Elsewhere"');
    expect(readSectorFile(text, 'EdariaArena').name).toBe('EdariaArena');
  });

  it('normalizes an out-of-range facing rather than rejecting it', () => {
    const sector = readSectorFile(edited('EdariaBibliothek', '"facing": 270', '"facing": 450'), 'EdariaBibliothek');
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

  it('rejects a dialog step that could exceed the say cap once it names the longest nickname', () => {
    const atCap = `${'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes - SOMNIO_PROTOCOL_CONSTANTS.maxIdentifierUTF8Bytes)}$name`;
    const room = (dialogScript: string) => interiorSector('Room', { npcs: [npc({ dialogScript })] });
    expect(readSectorFile(writeSectorFile(room(`Hello.\n---\n${atCap}`)), 'Room').npcs[0]?.dialogScript).toBe(`Hello.\n---\n${atCap}`);
    expect(() => writeSectorFile(room(`Hello.\n---\na${atCap}`))).toThrow(/npcs\[0\]\.dialogScript: step 2 can exceed 256 UTF-8 bytes/);
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
    const npcs = [npc({ dialogScript: 'a'.repeat(SOMNIO_CONSTANTS.maxSectorFileBytes) })];
    expect(() => writeSectorFile(interiorSector('Room', { npcs }))).toThrow(/file size/);
  });

  it('measures the byte cap in UTF-8 bytes, not UTF-16 code units', () => {
    // An umlaut is one code unit but two UTF-8 bytes, so a `.length` check would pass this.
    const halfCap = Math.trunc(SOMNIO_CONSTANTS.maxSectorFileBytes / 2);
    const npcs = [npc({ dialogScript: 'ü'.repeat(halfCap + 512) })];
    expect(() => writeSectorFile(interiorSector('Room', { npcs }))).toThrow(/file size/);
  });
});
