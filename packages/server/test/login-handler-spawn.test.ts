import { describe, expect, it } from 'vitest';
import { headingFromCardinal } from '@somnio/core';
import type { Sector } from '@somnio/core';
import { STARTER_SECTOR, newCharacter } from '@somnio/data';
import { interiorSector } from '../../core/test/support/worldFixture.ts';
import { resolvedSpawn } from '../src/handlers/login.ts';
import { makeCharacter, makeNPC, makeSector } from './support/sectorFactory.ts';
import { makeStubConnectionDependencies } from './support/stubDependencies.ts';

const STARTER_SPAWN = { space: STARTER_SECTOR, position: { x: 3, z: 4 }, facing: headingFromCardinal('east') };

/** A world of one outdoor sector and a starter sector whose spawn is at (3, 4), facing east. */
async function router(field: Partial<Sector> = {}) {
  const starter = interiorSector(STARTER_SECTOR, { spawn: { x: 3, z: 4, facing: headingFromCardinal('east') } });
  return (await makeStubConnectionDependencies({ sectors: [makeSector('Field', field), starter] })).worldRouter;
}

describe('resolvedSpawn', () => {
  it('keeps a saved position a player can stand on', async () => {
    const character = makeCharacter({ x: 5, z: 5 });
    expect(resolvedSpawn(character, await router())).toBe(character);
  });

  it('puts a fresh character, stored at the origin sentinel, on the starter spawn', async () => {
    expect(resolvedSpawn(newCharacter(crypto.randomUUID(), 'fresh', 'wachen', new Date()), await router())).toEqual(STARTER_SPAWN);
  });

  it.each<[string, Partial<Sector>]>([
    ['inside a collider', { placements: [{ id: 'box-1', modelId: 'box', x: 5, z: 5, yaw: 0, elevation: 0 }] }],
    ['inside a blocker', { blockers: [{ id: 'slab', x: 4, z: 4, width: 2, depth: 2 }] }],
    ['on an NPC', { npcs: [makeNPC('guard', { x: 5.2, z: 5 }, '')] }],
  ])('falls back to the starter spawn from a saved position %s', async (_label, field) => {
    expect(resolvedSpawn(makeCharacter({ x: 5, z: 5 }), await router(field))).toEqual(STARTER_SPAWN);
  });

  it('falls back to the starter spawn from a space the world no longer has', async () => {
    expect(resolvedSpawn(makeCharacter({ x: 5, z: 5 }, 'tester', 'Gone'), await router())).toEqual(STARTER_SPAWN);
  });
});
