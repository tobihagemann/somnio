import { describe, expect, it } from 'vitest';
import { isClear, rasterizeWalkable } from '@somnio/core';
import type { WalkRaster, WalkRasterInputs } from '@somnio/core';
import { ClientWorld } from '@/client';
import type { WalkRasterizer } from '@/client/walkRasterizer';
import { TEST_REGISTRY, interiorSector, outdoorSector } from '../../core/test/support/worldFixture.ts';
import { makeDoor } from './helpers/worldFixture';

/**
 * The client's view of a space: three outdoor sectors in a line running north, each 20 m square.
 * `South` covers z 0..20, `Middle` z -20..0, and `North` z -40..-20.
 */
const south = outdoorSector('South', { x: 0, z: 0 });
const middle = outdoorSector('Middle', { x: 0, z: -20 });
const north = outdoorSector('North', { x: 0, z: -40 });

const IN_SOUTH = { x: 10, z: 10 };
const IN_MIDDLE = { x: 10, z: -10 };
const IN_NORTH = { x: 10, z: -30 };

function spy(): { drawn: Set<string>; calls: string[]; addSector: (sector: { name: string }) => void; removeSector: (name: string) => void } {
  const drawn = new Set<string>();
  const calls: string[] = [];
  return {
    drawn,
    calls,
    addSector: (sector) => {
      drawn.add(sector.name);
      calls.push(`add:${sector.name}`);
    },
    removeSector: (name) => {
      drawn.delete(name);
      calls.push(`remove:${name}`);
    },
  };
}

function lineWorld(): ClientWorld {
  const world = new ClientWorld('outdoors', TEST_REGISTRY);
  for (const sector of [south, middle, north]) world.addSector(sector);
  return world;
}

describe('the draw set', () => {
  it('is the predicted sector plus its neighbours', () => {
    const world = lineWorld();
    const surface = spy();

    world.follow(IN_SOUTH, surface);

    expect([...surface.drawn]).toEqual(['South', 'Middle']);
    expect(world.predictedSector).toBe('South');
  });

  it('follows the predicted sector, adding what comes into reach and removing what falls out of it', () => {
    const world = lineWorld();
    const surface = spy();
    world.follow(IN_SOUTH, surface);

    world.follow(IN_MIDDLE, surface);
    expect([...surface.drawn].sort()).toEqual(['Middle', 'North', 'South']);

    world.follow(IN_NORTH, surface);
    expect([...surface.drawn].sort()).toEqual(['Middle', 'North']);
    expect(surface.calls).toEqual(['add:South', 'add:Middle', 'add:North', 'remove:South']);
    expect(world.predictedSector).toBe('North');
  });

  it('does nothing while the position stays in one sector', () => {
    const world = lineWorld();
    const surface = spy();
    world.follow(IN_SOUTH, surface);
    surface.calls.length = 0;

    world.follow({ x: 3, z: 17 }, surface);

    expect(surface.calls).toEqual([]);
  });

  it('keeps what is drawn when no held sector covers the position', () => {
    const world = lineWorld();
    const surface = spy();
    world.follow(IN_SOUTH, surface);
    surface.calls.length = 0;

    world.follow({ x: 500, z: 500 }, surface);

    expect(surface.calls).toEqual([]);
    expect(world.predictedSector).toBe('South');
  });
});

describe('sector data', () => {
  /**
   * The server sends a sector again only when the sector it *accepted* the player in changes. A
   * client that dropped data whenever its own predicted sector moved on would be left with a
   * border that blocks, with nothing coming to fill it back in.
   */
  it('keeps every sector through a dip across a border and back', () => {
    const world = lineWorld();
    const surface = spy();
    world.follow(IN_MIDDLE, surface);

    // Predicted into the far sector and back between two reports: the server saw neither.
    world.follow(IN_NORTH, surface);
    world.follow(IN_MIDDLE, surface);

    expect(world.collision.sectors).toHaveLength(3);
    expect([...surface.drawn].sort()).toEqual(['Middle', 'North', 'South']);
    for (const point of [IN_SOUTH, IN_MIDDLE, IN_NORTH]) expect(isClear(world.collision, point, 0.3)).toBe(true);
  });

  it('keeps every sector when a crossing is rejected', () => {
    const world = lineWorld();
    const surface = spy();
    world.follow(IN_SOUTH, surface);

    // The prediction crossed two borders; the server refused the move and corrected back.
    world.follow(IN_MIDDLE, surface);
    world.follow(IN_NORTH, surface);
    world.follow(IN_SOUTH, surface);

    expect(world.collision.sectors).toHaveLength(3);
    // The far border is still open ground, not an edge.
    expect(isClear(world.collision, { x: 10, z: -20 }, 0.3)).toBe(true);
    expect([...surface.drawn].sort()).toEqual(['Middle', 'South']);
  });

  it('rebuilds the collision when a sector arrives, opening the border it shares', () => {
    const world = new ClientWorld('outdoors', TEST_REGISTRY);
    world.addSector(south);
    expect(isClear(world.collision, { x: 10, z: 0.1 }, 0.3)).toBe(false);

    world.addSector(middle);

    expect(isClear(world.collision, { x: 10, z: 0.1 }, 0.3)).toBe(true);
  });

  it('replaces a sector sent again rather than holding it twice', () => {
    const world = lineWorld();

    world.addSector(north);

    expect(world.collision.sectors).toHaveLength(3);
  });

  it('resolves the doors of every held sector, in space coordinates', () => {
    const world = new ClientWorld('outdoors', TEST_REGISTRY);
    world.addSector(outdoorSector('Middle', { x: 0, z: -20 }, makeDoor('exit', { x: 10, z: 12 }, { sector: 'Hall', door: 'entry' })));

    expect(world.doors).toHaveLength(1);
    expect(world.doors[0]).toMatchObject({ sector: 'Middle', doorId: 'exit', resolved: { transform: { x: 10, z: -8, yaw: 0 } } });
  });

  it('leaves out a door whose placement has no such anchor', () => {
    const world = new ClientWorld('Hall', TEST_REGISTRY);
    world.addSector(
      interiorSector('Hall', {
        placements: [{ id: 'box-1', modelId: 'box', x: 5, z: 5, yaw: 0, elevation: 0 }],
        doors: [{ id: 'entry', placement: 'box-1', anchor: 'main', target: { sector: 'Middle', door: 'exit' } }],
      }),
    );

    expect(world.doors).toEqual([]);
  });
});

describe('walk rasters', () => {
  /** A rasterizer that holds every raster asked of it until the test answers it, as a worker would answer later. */
  function heldRasterizer(): { rasterizer: WalkRasterizer; jobs: { inputs: WalkRasterInputs; done: (raster: WalkRaster) => void }[] } {
    const jobs: { inputs: WalkRasterInputs; done: (raster: WalkRaster) => void }[] = [];
    return { rasterizer: { rasterize: (inputs, done) => jobs.push({ inputs, done }) }, jobs };
  }

  function answer(job: { inputs: WalkRasterInputs; done: (raster: WalkRaster) => void }): void {
    job.done(rasterizeWalkable(job.inputs));
  }

  const ACROSS = { from: IN_SOUTH, to: IN_MIDDLE };

  it('rasterizes a sector again when a sector touching it arrives, so a path crosses the border it once blocked', () => {
    const held = heldRasterizer();
    const world = new ClientWorld('outdoors', TEST_REGISTRY, held.rasterizer);
    world.addSector(south);
    for (const job of held.jobs.splice(0)) answer(job);
    expect(world.findPath(ACROSS.from, ACROSS.to, [], new Set()).reached).toBe(false);

    world.addSector(middle);
    expect(held.jobs.map((job) => job.inputs.sector)).toEqual(['Middle', 'South']);
    for (const job of held.jobs.splice(0)) answer(job);

    const path = world.findPath(ACROSS.from, ACROSS.to, [], new Set());
    expect(path.reached).toBe(true);
    expect(path.waypoints).toEqual([ACROSS.to]);
  });

  it('drops a raster asked for before the one the sector waits for', () => {
    const held = heldRasterizer();
    const world = new ClientWorld('outdoors', TEST_REGISTRY, held.rasterizer);
    world.addSector(south);
    const stale = held.jobs.splice(0);
    world.addSector(middle);
    for (const job of held.jobs.splice(0)) answer(job);

    for (const job of stale) answer(job);

    expect(world.findPath(ACROSS.from, ACROSS.to, [], new Set()).reached).toBe(true);
  });
});
