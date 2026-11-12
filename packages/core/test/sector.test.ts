import { describe, expect, it } from 'vitest';
import { placedFixtures, sectorOrigin, sectorPointInSpace, sectorRect, sectorView } from '../src/sector.ts';
import { interiorSector, outdoorSector } from './support/worldFixture.ts';

describe('sectorView', () => {
  it('keeps what a client draws and collides with, and nothing the server alone acts on', () => {
    const sector = outdoorSector(
      'Town',
      { x: 5.12, z: -30.72 },
      {
        placements: [{ id: 'box-1', modelId: 'box', x: 1, z: 2, yaw: 90, elevation: 0 }],
        fixtures: [{ id: 'fixture-1', placement: 'box-1', service: 'bountyBoard' }],
        spawn: { x: 1, z: 1, facing: 0 },
        npcs: [{ id: 'libus', name: 'Libus', characterModelId: 'libus', x: 3, z: 3, facing: 0, dialogScript: 'Hello.' }],
        monsterSpawns: [{ id: 'spawn-1', kind: 'ghost', x: 0, z: 0, width: 4, depth: 4, maxAlive: 3, eliteChance: 0 }],
      },
    );
    expect(sectorView(sector)).toEqual({
      name: 'Town',
      kind: 'outdoor',
      origin: { x: 5.12, z: -30.72 },
      size: { width: 20, depth: 20 },
      ground: { backgroundMaterialId: 'grass', marks: [] },
      placements: sector.placements,
      blockers: [],
      doors: [],
      fixtures: sector.fixtures,
    });
  });

  it("carries an interior's brightness and no origin", () => {
    const view = sectorView(interiorSector('Room', { brightness: 75 }));
    expect(view.brightness).toBe(75);
    expect('origin' in view).toBe(false);
  });
});

describe('placedFixtures', () => {
  it('stands each fixture at its placement, in the coordinates of its space, by its carrier id', () => {
    const sector = outdoorSector(
      'Square',
      { x: 40, z: -20 },
      {
        placements: [
          { id: 'well', modelId: 'well', x: 3, z: 4, yaw: 0, elevation: 0 },
          { id: 'notice-board-1', modelId: 'notice-board', x: 18.15, z: 18.125, yaw: 35, elevation: 0 },
        ],
        fixtures: [{ id: 'fixture-1', placement: 'notice-board-1', service: 'bountyBoard' }],
      },
    );
    expect(placedFixtures(sector)).toEqual([
      { id: 'fixture:Square/fixture-1', sector: 'Square', fixture: sector.fixtures[0], position: { x: 58.15, z: -1.875 } },
    ]);
  });
});

describe('a sector in its space', () => {
  it('sits at its origin outdoors', () => {
    const sector = outdoorSector('Meadow', { x: 5.12, z: -30.72 });
    expect(sectorOrigin(sector)).toEqual({ x: 5.12, z: -30.72 });
    expect(sectorRect(sector)).toEqual({ x: 5.12, z: -30.72, width: 20, depth: 20 });
    expect(sectorPointInSpace(sector, { x: 1, z: 2 })).toEqual({ x: 6.12, z: -28.72 });
  });

  it('sits at the origin of its own space as an interior', () => {
    const sector = interiorSector('Room');
    expect(sectorOrigin(sector)).toEqual({ x: 0, z: 0 });
    expect(sectorRect(sector)).toEqual({ x: 0, z: 0, width: 10, depth: 10 });
    expect(sectorPointInSpace(sector, { x: 1, z: 2 })).toEqual({ x: 1, z: 2 });
  });
});
