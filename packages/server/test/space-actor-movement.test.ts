import { describe, expect, it } from 'vitest';
import type { Gait } from '@somnio/protocol';
import { MOVE_SUBSTEP, OUTDOOR_SPACE_ID, SOMNIO_CONSTANTS, buildSpaceCollision, gaitMetresPerSecond, isLegalMove, resolveMove } from '@somnio/core';
import type { Point, Sector } from '@somnio/core';
import type { ConnectionOutbox } from '../src/connection/outbox.ts';
import type { SpaceActor } from '../src/world/spaceActor.ts';
import { collectMessages, entities, entityMoves } from './support/frames.ts';
import { recordingLogger, testLogger } from './support/logger.ts';
import { attachPlayer, makeClockedSpace, makeNPC, makeSector, makeSectorLine, makeWorld } from './support/sectorFactory.ts';

const RADIUS = SOMNIO_CONSTANTS.playerRadius;

/** One 20 x 20 m sector on a clock the test advances. */
function field(overrides: Partial<Sector> = {}, logger = testLogger()) {
  const world = makeWorld([makeSector('Field', overrides)]);
  return { world, ...makeClockedSpace(world, OUTDOOR_SPACE_ID, { logger }) };
}

function move(x: number, z: number, facing = 0, gait: Gait = 'jog') {
  return { x, z, facing, gait };
}

function positionOf(space: SpaceActor, entityId: string): Point | undefined {
  return space.snapshotForPlayer(entityId)?.character.position;
}

async function corrections(outbox: ConnectionOutbox): Promise<Point[]> {
  return (await collectMessages(outbox)).flatMap((message) => (message.tag === 'correction' ? [message.payload] : []));
}

const wall = (id: string, z: number, depth: number) => ({ id, x: 9.9, z, width: 0.2, depth });

describe('SpaceActor.handleMove', () => {
  it('accepts a clear move and relays it to the peers in the next flush, not to the mover', async () => {
    const { space } = field();
    const mover = attachPlayer(space, { x: 5, z: 5 });
    const peer = attachPlayer(space, { x: 15, z: 15 }, 'peer');
    space.handleMove(move(5.5, 5.5, 90, 'run'), mover.entityId);
    space.flushMoves();
    expect(positionOf(space, mover.entityId)).toEqual({ x: 5.5, z: 5.5 });
    expect(entityMoves(await collectMessages(peer.outbox))).toEqual([{ id: mover.entityId, x: 5.5, z: 5.5, facing: 90, gait: 'run' }]);
    const own = await collectMessages(mover.outbox);
    expect(own.filter((message) => message.tag === 'moves' || message.tag === 'correction')).toEqual([]);
  });

  /** A client may send any degree value; the stored and broadcast facing is the wrapped one. */
  it('normalizes the facing before storing and broadcasting it', async () => {
    const { space } = field();
    const mover = attachPlayer(space, { x: 5, z: 5 });
    const peer = attachPlayer(space, { x: 15, z: 15 }, 'peer');
    space.handleMove(move(5.1, 5, 450), mover.entityId);
    space.flushMoves();
    expect(space.snapshotForPlayer(mover.entityId)?.character.facing).toBe(90);
    expect(entityMoves(await collectMessages(peer.outbox))[0]?.facing).toBe(90);
    space.handleMove(move(5.2, 5, -90), mover.entityId);
    expect(space.snapshotForPlayer(mover.entityId)?.character.facing).toBe(270);
  });

  it('rejects a move that crosses a blocker and corrects the client to the last accepted position', async () => {
    const { space } = field({ blockers: [wall('wall', 0, 20)] });
    const mover = attachPlayer(space, { x: 9.2, z: 10 });
    space.handleMove(move(10.8, 10), mover.entityId);
    expect(positionOf(space, mover.entityId)).toEqual({ x: 9.2, z: 10 });
    expect(await corrections(mover.outbox)).toEqual([{ x: 9.2, z: 10 }]);
  });

  it('rejects a move out of the world', async () => {
    const { space } = field();
    const mover = attachPlayer(space, { x: 0.5, z: 10 });
    space.handleMove(move(-0.5, 10), mover.entityId);
    expect(await corrections(mover.outbox)).toEqual([{ x: 0.5, z: 10 }]);
  });

  it('spends an allowance that only the server clock refills, so rapid messages buy no distance', async () => {
    const { clock, space } = field();
    const mover = attachPlayer(space, { x: 5, z: 5 });
    // Two seconds of running with a quarter to spare: 7.5 m in the bank at the join.
    space.handleMove(move(9, 5), mover.entityId);
    space.handleMove(move(12.4, 5), mover.entityId);
    expect(positionOf(space, mover.entityId)).toEqual({ x: 12.4, z: 5 });
    for (let message = 0; message < 20; message += 1) space.handleMove(move(12.6, 5), mover.entityId);
    expect(positionOf(space, mover.entityId)).toEqual({ x: 12.4, z: 5 });
    clock.ms += 100;
    space.handleMove(move(12.7, 5), mover.entityId);
    expect(positionOf(space, mover.entityId)).toEqual({ x: 12.7, z: 5 });
    expect(await corrections(mover.outbox)).toHaveLength(20);
  });

  it('never banks more than two seconds of allowance', () => {
    const { clock, space } = field();
    const mover = attachPlayer(space, { x: 5, z: 5 });
    clock.ms += 60_000;
    space.handleMove(move(12.6, 5), mover.entityId);
    expect(positionOf(space, mover.entityId)).toEqual({ x: 5, z: 5 });
    space.handleMove(move(12.5, 5), mover.entityId);
    expect(positionOf(space, mover.entityId)).toEqual({ x: 12.5, z: 5 });
  });

  it('accepts the reports a stalled connection held back when they arrive together, up to what the allowance holds', () => {
    /** A client running east, reporting 0.3 m every 100 ms, whose reports of a stall all arrive as it ends: which of those were accepted. */
    const burstAfterStall = (stallMs: number): boolean[] => {
      const { clock, space } = field();
      const mover = attachPlayer(space, { x: 2, z: 10 });
      let x = 2;
      const report = (): boolean => {
        x += 0.3;
        space.handleMove(move(x, 10, 90, 'run'), mover.entityId);
        return positionOf(space, mover.entityId)?.x === x;
      };
      for (let onTime = 0; onTime < 5; onTime += 1) {
        clock.ms += 100;
        report();
      }
      clock.ms += stallMs;
      return Array.from({ length: stallMs / 100 }, report);
    };
    expect(burstAfterStall(1500)).toEqual(Array.from({ length: 15 }, () => true));
    // The 7.5 m the allowance holds is 25 reports to within rounding, so the 25th is left unjudged.
    const overdrawn = burstAfterStall(3000);
    expect(overdrawn.slice(0, 24)).toEqual(Array.from({ length: 24 }, () => true));
    expect(overdrawn.slice(25)).toEqual(Array.from({ length: 5 }, () => false));
  });

  it('charges a move with an illegal path its length, as if it had been walked', async () => {
    const { clock, space } = field({ blockers: [wall('wall', 0, 20)] });
    const mover = attachPlayer(space, { x: 9.2, z: 10 });
    // Four 1.6 m moves through the wall leave 1.1 m of the 7.5 m: not the 1.2 m back to x 8.
    for (let attempt = 0; attempt < 4; attempt += 1) space.handleMove(move(10.8, 10), mover.entityId);
    space.handleMove(move(8, 10), mover.entityId);
    // 20 ms refill 0.075 m, which is still short; 40 ms refill the 0.15 m that covers it.
    clock.ms += 20;
    space.handleMove(move(8, 10), mover.entityId);
    expect(positionOf(space, mover.entityId)).toEqual({ x: 9.2, z: 10 });
    clock.ms += 20;
    space.handleMove(move(8, 10), mover.entityId);
    expect(positionOf(space, mover.entityId)).toEqual({ x: 8, z: 10 });
    expect(await corrections(mover.outbox)).toEqual(Array.from({ length: 6 }, () => ({ x: 9.2, z: 10 })));
  });

  it('charges nothing for a move longer than the allowance', async () => {
    const { space } = field();
    const mover = attachPlayer(space, { x: 5, z: 5 });
    for (let attempt = 0; attempt < 3; attempt += 1) space.handleMove(move(12.6, 5), mover.entityId);
    space.handleMove(move(12.5, 5), mover.entityId);
    expect(positionOf(space, mover.entityId)).toEqual({ x: 12.5, z: 5 });
    expect(await corrections(mover.outbox)).toEqual(Array.from({ length: 3 }, () => ({ x: 5, z: 5 })));
  });

  /**
   * A client running north past a box and east round its north-west corner at (8, 8), whose
   * reports of a stall arrive together. The corner waypoint is the first the allowance does not
   * cover, so the report after it is measured from the position before the corner, and that
   * straight line cuts through the box.
   */
  it('charges the report after a waypoint the allowance refused, which cuts the corner the waypoint went round', async () => {
    const { clock, space } = field({ blockers: [{ id: 'box', x: 8, z: 8, width: 4, depth: 2 }] });
    const mover = attachPlayer(space, { x: 7.6, z: 15.6 });
    // 24 reports of 0.3 m spend 7.2 m of the 7.5 m, up to 0.4 m short of the corner's latitude.
    for (let report = 1; report <= 24; report += 1) space.handleMove(move(7.6, 15.6 - 0.3 * report, 180, 'run'), mover.entityId);
    const beforeCorner = { x: 7.6, z: 15.6 - 0.3 * 24 };
    expect(positionOf(space, mover.entityId)).toEqual(beforeCorner);
    // The waypoint is 0.8 m on, more than the 0.3 m left.
    space.handleMove(move(7.6, 7.6, 180, 'run'), mover.entityId);
    // 250 ms later 1.24 m are banked: enough for the 1.13 m to the next report, whose path is not legal.
    clock.ms += 250;
    space.handleMove(move(8.4, 7.6, 90, 'run'), mover.entityId);
    // That leaves 0.11 m: a legal 0.3 m step the bank covered before the charge is refused, a 0.1 m one accepted.
    space.handleMove(move(7.6, 8.1, 180, 'run'), mover.entityId);
    expect(positionOf(space, mover.entityId)).toEqual(beforeCorner);
    space.handleMove(move(7.6, 8.3, 180, 'run'), mover.entityId);
    expect(positionOf(space, mover.entityId)).toEqual({ x: 7.6, z: 8.3 });
    expect(await corrections(mover.outbox)).toEqual(Array.from({ length: 3 }, () => beforeCorner));
  });

  describe('against the step height', () => {
    // The hall's porch is a metre up, with its stair run on the east side at z 10.04 to 11.76.
    const hall = { placements: [{ id: 'hall-1', modelId: 'hall', x: 10, z: 10, yaw: 0, elevation: 0 }] };

    it('rejects a move from the ground onto the porch', async () => {
      const { space } = field(hall);
      const mover = attachPlayer(space, { x: 12.72, z: 12.5 });
      space.handleMove(move(12.12, 12.5), mover.entityId);
      expect(await corrections(mover.outbox)).toEqual([{ x: 12.72, z: 12.5 }]);
    });

    it('accepts the same climb up the treads', async () => {
      const { clock, space } = field(hall);
      const mover = attachPlayer(space, { x: 14.5, z: 10.9 });
      for (let x = 14.25; x >= 12; x -= 0.25) {
        clock.ms += 100;
        space.handleMove(move(x, 10.9), mover.entityId);
      }
      expect(positionOf(space, mover.entityId)).toEqual({ x: 12, z: 10.9 });
      expect(await corrections(mover.outbox)).toEqual([]);
    });
  });

  it("accepts a move through another player's position", async () => {
    const { space } = field();
    attachPlayer(space, { x: 10, z: 10 }, 'bystander');
    const mover = attachPlayer(space, { x: 9.2, z: 10 });
    space.handleMove(move(10, 10), mover.entityId);
    space.handleMove(move(10.8, 10), mover.entityId);
    expect(positionOf(space, mover.entityId)).toEqual({ x: 10.8, z: 10 });
    expect(await corrections(mover.outbox)).toEqual([]);
  });

  it('blocks at an NPC where its sector puts it in the space, which is where its entity is drawn', async () => {
    const { space } = makeClockedSpace(makeWorld(makeSectorLine({ middle: { npcs: [makeNPC('guard', { x: 10, z: 10 }, '')] } })));
    // Middle starts at x 20, so its guard stands at (30, 10); (10, 10) is open ground in West.
    const beside = attachPlayer(space, { x: 29, z: 10 }, 'beside');
    const elsewhere = attachPlayer(space, { x: 9, z: 10 }, 'elsewhere');
    space.handleMove(move(30, 10), beside.entityId);
    space.handleMove(move(10, 10), elsewhere.entityId);
    expect(positionOf(space, elsewhere.entityId)).toEqual({ x: 10, z: 10 });
    expect(await corrections(elsewhere.outbox)).toEqual([]);
    const seen = await collectMessages(beside.outbox);
    expect(seen.flatMap((message) => (message.tag === 'correction' ? [message.payload] : []))).toEqual([{ x: 29, z: 10 }]);
    expect(entities(seen).filter((entity) => entity.kind === 'npc')).toMatchObject([{ id: 'npc:Middle/guard', x: 30, z: 10 }]);
  });

  it.each<[string, Partial<Sector>]>([
    ['an NPC', { npcs: [makeNPC('guard', { x: 10, z: 10 }, '')] }],
    ['a gap narrower than the body', { blockers: [wall('north', 0, 9.75), wall('south', 10.25, 9.75)] }],
  ])('does not let a fully accrued allowance carry a move through %s', async (_label, overrides) => {
    const { space } = field(overrides);
    const mover = attachPlayer(space, { x: 9.2, z: 10 });
    space.handleMove(move(10.8, 10), mover.entityId);
    expect(await corrections(mover.outbox)).toEqual([{ x: 9.2, z: 10 }]);
  });

  it('accepts the same move through a gap the body fits', async () => {
    const { space } = field({ blockers: [wall('north', 0, 9.65), wall('south', 10.35, 9.65)] });
    const mover = attachPlayer(space, { x: 9.2, z: 10 });
    space.handleMove(move(10.8, 10), mover.entityId);
    expect(await corrections(mover.outbox)).toEqual([]);
  });

  it('logs a rejected move once per player every five seconds, with the count it held back', () => {
    const { logger, records } = recordingLogger();
    const { clock, space } = field({}, logger);
    const mover = attachPlayer(space, { x: 5, z: 5 });
    const rejected = () => records.filter((record) => record['msg'] === 'move rejected');
    for (let message = 0; message < 4; message += 1) space.handleMove(move(15, 5), mover.entityId);
    expect(rejected()).toMatchObject([{ level: 40, entity_id: mover.entityId, from: '5,5', to: '15,5', suppressed_since_last: 0 }]);
    clock.ms += 5000;
    space.handleMove(move(15, 5), mover.entityId);
    expect(rejected()).toHaveLength(2);
    expect(rejected()[1]).toMatchObject({ suppressed_since_last: 3 });
  });
});

/**
 * An honest client, as the predictor moves and reports: substeps of at most 5 cm through
 * `resolveMove`, a report every 100 ms, and a waypoint report before any substep that would make
 * the segment from the last report one `isLegalMove` refuses.
 */
describe('a corner slide reported by an honest client', () => {
  const cases = (['jog', 'run'] as const).flatMap((gait) => [16, 50, 99, 150].map((frameMs) => ({ gait, frameMs })));

  it.each(cases)('is accepted at a $gait with $frameMs ms frames', async ({ gait, frameMs }) => {
    const { clock, world, space } = field({ blockers: [{ id: 'box', x: 8, z: 8, width: 4, depth: 2 }] });
    const collision = buildSpaceCollision(world.spaces.get(OUTDOOR_SPACE_ID)!, world.registry);
    let position: Point = { x: 7.5, z: 9.5 };
    const mover = attachPlayer(space, position);
    let lastReport = position;
    let sinceReport = 0;
    const report = () => {
      space.handleMove(move(position.x, position.z, 135, gait), mover.entityId);
      lastReport = position;
    };
    // North-east into the box's west face, along it, and round its north-west corner.
    const heading = Math.SQRT1_2;
    for (let elapsed = 0; elapsed < 2000; elapsed += frameMs) {
      clock.ms += frameMs;
      for (let remaining = (gaitMetresPerSecond(gait) * frameMs) / 1000; remaining > 1e-9; remaining -= MOVE_SUBSTEP) {
        const length = Math.min(MOVE_SUBSTEP, remaining);
        const next = resolveMove(collision, position, { x: position.x + heading * length, z: position.z - heading * length }, RADIUS, [], []).position;
        if (!isLegalMove(collision, lastReport, next, RADIUS, [])) report();
        position = next;
      }
      sinceReport += frameMs;
      if (sinceReport >= 100) {
        report();
        sinceReport = 0;
      }
    }
    expect(await corrections(mover.outbox)).toEqual([]);
    expect(positionOf(space, mover.entityId)).toEqual(lastReport);
    expect(lastReport.x).toBeGreaterThan(8.3);
    expect(lastReport.z).toBeLessThan(8 - RADIUS);
  });
});
