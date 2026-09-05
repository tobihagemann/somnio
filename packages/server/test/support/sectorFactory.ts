import { GENDER, TEMPO, headingFromCardinal } from '@somnio/core';
import type { Character, CollisionMask, GridPoint, GridSize, MonsterSpawn, Sector, SectorNPC, SectorObject, SectorPortal } from '@somnio/core';

export interface SectorOptions {
  dimensions?: GridSize;
  objects?: SectorObject[];
  collisionMasks?: CollisionMask[];
  portals?: SectorPortal[];
  npcs?: SectorNPC[];
  monsterSpawns?: MonsterSpawn[];
  indoor?: boolean;
}

/** An 8 x 8 tile (1024 px) outdoor sector unless overridden. */
export function makeSector(name = 'TestSector', options: SectorOptions = {}): Sector {
  return {
    name,
    version: 3,
    dimensions: options.dimensions ?? { width: 8, height: 8 },
    floorMaterialID: 'grass-meadow',
    light: { indoor: options.indoor ?? false, brightness: 100 },
    objects: options.objects ?? [],
    collisionMasks: options.collisionMasks ?? [],
    portals: options.portals ?? [],
    npcs: options.npcs ?? [],
    monsterSpawns: options.monsterSpawns ?? [],
    floorPatches: [],
  };
}

/**
 * A 32 x 48 NPC (box == mask, so no centering offset): with feet-center proximity its feet
 * center sits ~(origin + (16, 40)), within the 64 px interaction radius of a player at adjacent
 * grid coordinates.
 */
export function makeNPC(origin: GridPoint, dialogScript: string): SectorNPC {
  return {
    spawnOrigin: origin,
    spawnBoxSize: { width: 32, height: 48 },
    maskSize: { width: 32, height: 48 },
    name: 'test-npc',
    figure: 0,
    facing: headingFromCardinal('south'),
    behaviorTag: 0,
    dialogScript,
  };
}

/**
 * A 32 x 48 monster whose spawn box collapses the 4 px-grid placement range to a single cell
 * (width == sprite width, height == feet height 16), so the spawn position is deterministic at a
 * 4-aligned `origin` independent of the RNG. `boxWidth` widens it for placement sampling.
 */
export function makeMonsterSpawn(origin: GridPoint, aiScriptIndex = 0, boxWidth = 32): MonsterSpawn {
  return {
    spawnOrigin: origin,
    spawnBoxSize: { width: boxWidth, height: 16 },
    spawnedMonsterSize: { width: 32, height: 48 },
    name: 'test-monster',
    figure: 0,
    bounded: false,
    spawnHP: 100,
    spawnBalance: 100,
    spawnMana: 100,
    aiScriptIndex,
  };
}

export function makeCharacter(position: GridPoint, name = 'tester', sector = 'TestSector'): Character {
  return {
    id: crypto.randomUUID(),
    name,
    figure: 0,
    gender: GENDER.male,
    currentSector: sector,
    position,
    facing: headingFromCardinal('south'),
    tempo: TEMPO.default,
    energy: {
      hpCurrent: 100,
      hpMax: 100,
      balanceCurrent: 100,
      balanceMax: 100,
      manaCurrent: 100,
      manaMax: 100,
    },
    lastSeen: new Date(),
  };
}

export function makePortal(
  rect: { x: number; y: number; width: number; height: number },
  targetSectorName: string,
  direction: SectorPortal['direction'],
): SectorPortal {
  return { ...rect, targetSectorName, direction };
}
