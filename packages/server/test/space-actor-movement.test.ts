import { describe, expect, it } from 'vitest';
import { SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import type { Gait } from '@somnio/protocol';
import {
  MOVE_SUBSTEP,
  OUTDOOR_SPACE_ID,
  SOMNIO_CONSTANTS,
  buildSpaceCollision,
  gaitMetresPerSecond,
  isLegalMove,
  monsterKind,
  resolveMove,
} from '@somnio/core';
import type { Point, Sector } from '@somnio/core';
import { ConnectionOutbox } from '../src/connection/outbox.ts';
import type { SpaceActor } from '../src/world/spaceActor.ts';
import { GHOST, GHOST_AT, arena, energy, energyOf, lucidity } from './support/combat.ts';
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

  /** A client refuses a `moves` frame over the cap, so a crowd's batch goes out in as many frames as it takes, none lost. */
  it('splits a batch larger than one frame holds across frames, in order', async () => {
    const { space } = field();
    const peer = attachPlayer(space, { x: 19, z: 19 }, 'peer');
    const count = SOMNIO_PROTOCOL_CONSTANTS.maxMovesPerFrame + 1;
    const movers = Array.from({ length: count }, (_, index) => attachPlayer(space, { x: 1 + (index % 17), z: 1 + Math.floor(index / 17) }, `mover-${index}`));
    for (const mover of movers) space.handleMove(move(mover.character.position.x + 0.1, mover.character.position.z), mover.entityId);
    space.flushMoves();
    const messages = await collectMessages(peer.outbox);
    expect(messages.flatMap((message) => (message.tag === 'moves' ? [message.payload.moves.length] : []))).toEqual([
      SOMNIO_PROTOCOL_CONSTANTS.maxMovesPerFrame,
      1,
    ]);
    expect(entityMoves(messages).map((entry) => entry.id)).toEqual(movers.map((mover) => mover.entityId));
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
 * A walk or a jog spends a credit of seconds at its gait's speed. The credit refills at 1.25 s a
 * second whatever gait is reported and holds 7.5 s, what the allowance covers at a walk. Metres
 * past it were run.
 */
describe('SpaceActor.handleMove against the reported gait', () => {
  /** A dreamer at `at` whose balance stands at `balance`, on a field wide enough to run across. */
  function walker(balance: number, at: Point = { x: 2, z: 10 }) {
    const { clock, space } = field({ size: { width: 100, depth: 20 } });
    const mover = attachPlayer(space, at, 'walker', { character: { energy: energy({ balanceCurrent: balance }) } });
    const balanceNow = () => energyOf(space, mover.entityId).balanceCurrent;
    return { clock, space, mover, balanceNow };
  }

  /** Walks 7.5 m east in one report, which spends the whole allowance and the whole pace credit. */
  function spendBoth(space: SpaceActor, entityId: string): void {
    const at = positionOf(space, entityId)!;
    space.handleMove(move(at.x + 7.5, at.z, 90, 'walk'), entityId);
  }

  it('drains balance and holds recovery for a client that runs while reporting a walk', () => {
    const { clock, space, mover, balanceNow } = walker(100);
    for (let report = 1; report <= 200; report += 1) {
      clock.ms += 100;
      space.handleMove(move(2 + 0.3 * report, 10, 90, 'walk'), mover.entityId);
      space.step(0.1);
    }
    expect(positionOf(space, mover.entityId)).toEqual({ x: 2 + 0.3 * 200, z: 10 });
    expect(balanceNow()).toBeLessThan(50);
  });

  it('charges nothing for an honest walk a stall bunched by just under the credit', () => {
    const { clock, space, mover, balanceNow } = walker(100);
    let x = 2;
    const report = () => {
      x += 0.1;
      space.handleMove(move(x, 10, 90, 'walk'), mover.entityId);
    };
    for (let onTime = 0; onTime < 20; onTime += 1) {
      clock.ms += 100;
      report();
    }
    clock.ms += 7400;
    for (let held = 0; held < 74; held += 1) report();
    expect(positionOf(space, mover.entityId)).toEqual({ x, z: 10 });
    expect(balanceNow()).toBe(100);
  });

  /** After 2 s the allowance is back at its 7.5 m cap, the credit only at 2.5 s, so the credit binds first. */
  it('charges a walk past the credit once the credit, not the allowance, has run out', () => {
    const { clock, space, mover, balanceNow } = walker(100);
    spendBoth(space, mover.entityId);
    clock.ms += 2000;
    let x = positionOf(space, mover.entityId)!.x;
    for (let report = 0; report < 25; report += 1) {
      x += 0.1;
      space.handleMove(move(x, 10, 90, 'walk'), mover.entityId);
    }
    expect(balanceNow()).toBe(100);
    space.handleMove(move(x + 0.4, 10, 90, 'walk'), mover.entityId);
    expect(positionOf(space, mover.entityId)).toEqual({ x: x + 0.4, z: 10 });
    expect(balanceNow()).toBe(99);
  });

  /**
   * 0.55 m walked against 0.25 s of credit runs 0.3 m, which drains a whole unit. A 1 mm jog a
   * millisecond later fits the credit, and must not bring jog recovery back inside the window.
   */
  it('holds recovery at the running pace for the window after a charged move, whatever the next move reports', () => {
    const { clock, space, mover, balanceNow } = walker(50);
    spendBoth(space, mover.entityId);
    clock.ms += 200;
    const at = positionOf(space, mover.entityId)!;
    space.handleMove(move(at.x + 0.55, 10, 90, 'walk'), mover.entityId);
    expect(balanceNow()).toBe(49);
    clock.ms += 1;
    space.handleMove(move(at.x + 0.551, 10, 90, 'jog'), mover.entityId);
    clock.ms += 239;
    space.step(0.24);
    expect(balanceNow()).toBe(49);
  });

  it('carries the running hold through a hand-over, so recovery on arrival waits for its window to end', () => {
    const { clock, space, mover, balanceNow } = walker(50);
    spendBoth(space, mover.entityId);
    clock.ms += 200;
    space.handleMove(move(positionOf(space, mover.entityId)!.x + 0.55, 10, 90, 'walk'), mover.entityId);
    const { checkpoint, transient } = space.handOver(mover.entityId, false)!;
    space.attach(checkpoint.character, checkpoint.inventory, new ConnectionOutbox(4096), 0, 'en', transient);
    const recovered: number[] = [];
    for (let step = 0; step < 2; step += 1) {
      clock.ms += 240;
      space.step(0.24);
      recovered.push(balanceNow());
    }
    // 12 balance a second standing for 0.24 s is 2.88, so the second step recovers two whole units.
    expect(recovered).toEqual([49, 51]);
  });

  /** Ten seconds of jogging on time leave the credit full, so it covers a stall's bunch of just under the allowance after them. */
  it('charges nothing for an honest jog a stall bunched by just under the allowance', () => {
    const { clock, space, mover, balanceNow } = walker(100);
    let x = 2;
    const report = () => {
      x += 0.2;
      space.handleMove(move(x, 10, 90, 'jog'), mover.entityId);
    };
    for (let onTime = 0; onTime < 100; onTime += 1) {
      clock.ms += 100;
      report();
    }
    clock.ms += 3700;
    for (let held = 0; held < 37; held += 1) report();
    expect(positionOf(space, mover.entityId)).toEqual({ x, z: 10 });
    expect(balanceNow()).toBe(100);
  });

  /** A blow winds the jogger as a stall begins: 1 s of jogging and 4 s of winded walking arrive together, 6 m the allowance accepts and 5 s of credit. */
  it('charges nothing for an honest bunch that turns from a jog to a walk', () => {
    const { clock, space, mover, balanceNow } = walker(100);
    let x = 2;
    const report = (gait: Gait, metres: number) => {
      x += metres;
      space.handleMove(move(x, 10, 90, gait), mover.entityId);
    };
    for (let onTime = 0; onTime < 100; onTime += 1) {
      clock.ms += 100;
      report('jog', 0.2);
    }
    clock.ms += 5000;
    for (let held = 0; held < 10; held += 1) report('jog', 0.2);
    for (let held = 0; held < 40; held += 1) report('walk', 0.1);
    expect(positionOf(space, mover.entityId)).toEqual({ x, z: 10 });
    expect(balanceNow()).toBe(100);
  });

  /**
   * 3.75 m a second reported as a jog spends 1.875 s of credit a second against the 1.25 s
   * refilled, so the 7.5 s of credit last 12 s; the 4 s after them cover 15 m against 5 s of
   * credit, and the 5 m past it were run.
   */
  it("charges a client that covers the allowance's pace while reporting a jog once its credit is spent", () => {
    const { clock, space, mover, balanceNow } = walker(100);
    for (let report = 1; report <= 160; report += 1) {
      clock.ms += 100;
      space.handleMove(move(2 + 0.375 * report, 10, 90, 'jog'), mover.entityId);
      if (report === 120) expect(balanceNow()).toBe(100);
    }
    expect(positionOf(space, mover.entityId)).toEqual({ x: 2 + 0.375 * 160, z: 10 });
    // 5 m run drains 16.7.
    expect(balanceNow()).toBe(83);
  });

  /**
   * The credit refills the same whatever gait is reported, so tiny reports at a faster gait buy
   * nothing for the walk reports beside them: each schedule below covers 2.4 m a second reported
   * as walking for 10 s, 24 s of credit against the 20 s refilled and held, and is charged the 4 m
   * past it, as walking alone is.
   */
  it.each([
    { schedule: 'nothing', reports: [] },
    { schedule: 'a jog, pausing before it', reports: [{ afterMs: 99, gait: 'jog' }] },
    { schedule: 'a jog, pausing before the walk', reports: [{ afterMs: 1, gait: 'jog' }] },
    {
      schedule: 'a run, then a jog',
      reports: [
        { afterMs: 98, gait: 'run' },
        { afterMs: 1, gait: 'jog' },
      ],
    },
    {
      schedule: 'two jogs',
      reports: [
        { afterMs: 51, gait: 'jog' },
        { afterMs: 48, gait: 'jog' },
      ],
    },
  ] as const)('charges a client that slips $schedule beside each walk', ({ reports }) => {
    const { clock, space, mover, balanceNow } = walker(100);
    let x = 2;
    for (let cycle = 0; cycle < 100; cycle += 1) {
      for (const { afterMs, gait } of reports) {
        clock.ms += afterMs;
        x += 0.000_001;
        space.handleMove(move(x, 10, 90, gait), mover.entityId);
      }
      clock.ms += 100 - reports.reduce((spent, { afterMs }) => spent + afterMs, 0);
      x += 0.24 - 0.000_001 * reports.length;
      space.handleMove(move(x, 10, 90, 'walk'), mover.entityId);
    }
    expect(positionOf(space, mover.entityId)).toEqual({ x, z: 10 });
    // 4 m run drains 13.3.
    expect(balanceNow()).toBe(87);
  });

  /** A turn on the spot reported as a run does not change how fast the credit refilled since the last move, before a door or a disconnect. */
  it('carries through a hand-over the credit the time since the last move refilled, whatever a turn reported', () => {
    const carried = (turn: Gait | undefined) => {
      const { clock, space, mover } = walker(100);
      spendBoth(space, mover.entityId);
      clock.ms += 2000;
      const at = positionOf(space, mover.entityId)!;
      if (turn !== undefined) space.handleMove(move(at.x, at.z, 0, turn), mover.entityId);
      return space.handOver(mover.entityId, false)!.transient.paceCredit;
    };
    expect([carried(undefined), carried('jog'), carried('run')]).toEqual([2.5, 2.5, 2.5]);
  });

  /** A run reported once a second holds recovery at the running pace for the second it covers, as a run reported every 100 ms does: 4 runs of 3 m drain 40, and only the step at each second's end recovers. */
  it('recovers next to nothing between run reports however seldom the client sends them', () => {
    const { clock, space, mover, balanceNow } = walker(50);
    for (let second = 1; second <= 4; second += 1) {
      space.handleMove(move(2 + 3 * second, 10, 90, 'run'), mover.entityId);
      for (let step = 0; step < 20; step += 1) {
        clock.ms += 50;
        space.step(0.05);
      }
    }
    expect(balanceNow()).toBe(12);
  });

  /**
   * Each use adds the way to the target at a walk to the credit past its cap, but no more than one
   * way's past it, however often Lunge is used standing still. 24 s at the allowance's pace
   * reported as a jog spend 45 s of credit against the 7.5 s and one way held and what refills once
   * the credit is back under its cap: about 6.3 s past it, 12.7 m run, which drains 42.
   */
  it("banks no more than one leap's credit from Lunge used again and again", () => {
    const { clock, space } = arena({ size: { width: 150, depth: 30 } });
    const contact = monsterKind('ghost').radius + SOMNIO_CONSTANTS.playerRadius;
    const from = GHOST_AT.z - contact - 2.9;
    const fighter = attachPlayer(space, { x: GHOST_AT.x, z: from }, 'fighter', {
      character: { lucidity: lucidity('fighter', { strike: 2, lunge: 1 }), energy: energy({ balanceCurrent: 100 }) },
    });
    space.handleTarget(GHOST, fighter.entityId);
    for (let use = 0; use < 4; use += 1) {
      clock.ms += 10_000;
      space.handleUseAbility('lunge', fighter.entityId);
    }
    const balance = () => energyOf(space, fighter.entityId).balanceCurrent;
    expect(balance()).toBe(100 - 4 * 12);
    for (let report = 1; report <= 240; report += 1) {
      clock.ms += 100;
      space.handleMove(move(GHOST_AT.x + 0.375 * report, from, 90, 'jog'), fighter.entityId);
    }
    expect(positionOf(space, fighter.entityId)).toEqual({ x: GHOST_AT.x + 0.375 * 240, z: from });
    expect(balance()).toBe(10);
  });

  /** The whole way to the target at a walk goes into the credit, so the credit right after a Lunge from a full credit reads its cap and that many seconds. */
  it("adds the way to Lunge's target at a walk to the pace credit", () => {
    const { space } = arena({ size: { width: 30, depth: 30 } });
    const contact = monsterKind('ghost').radius + SOMNIO_CONSTANTS.playerRadius;
    const fighter = attachPlayer(space, { x: GHOST_AT.x, z: GHOST_AT.z - contact - 2.9 }, 'fighter', {
      character: { lucidity: lucidity('fighter', { strike: 2, lunge: 1 }), energy: energy({ balanceCurrent: 100 }) },
    });
    space.handleTarget(GHOST, fighter.entityId);
    space.handleUseAbility('lunge', fighter.entityId);
    expect(space.handOver(fighter.entityId, false)!.transient.paceCredit).toBeCloseTo(7.5 + contact + 2.9, 9);
  });

  /** 1.5 m walked leave 6 s of credit, which the 2 s before Lunge refill to the cap, so the way is added to 7.5 s, not to the 6 s last counted. */
  it("adds the way to Lunge's target to the credit the time since the last move refilled", () => {
    const { clock, space } = arena({ size: { width: 30, depth: 30 } });
    const contact = monsterKind('ghost').radius + SOMNIO_CONSTANTS.playerRadius;
    const from = GHOST_AT.z - contact - 2.9;
    const fighter = attachPlayer(space, { x: GHOST_AT.x - 1.5, z: from }, 'fighter', {
      character: { lucidity: lucidity('fighter', { strike: 2, lunge: 1 }), energy: energy({ balanceCurrent: 100 }) },
    });
    space.handleMove(move(GHOST_AT.x, from, 90, 'walk'), fighter.entityId);
    clock.ms += 2000;
    space.handleTarget(GHOST, fighter.entityId);
    space.handleUseAbility('lunge', fighter.entityId);
    expect(space.handOver(fighter.entityId, false)!.transient.paceCredit).toBeCloseTo(7.5 + contact + 2.9, 9);
  });

  /** The leap's 2.9 m reported at a walk over half a second, with the allowance refilled a second and the credit spent. */
  it("charges nothing for Lunge's leap that a winded client reports at a walk", async () => {
    const { clock, space } = arena({ size: { width: 30, depth: 30 } });
    const contact = monsterKind('ghost').radius + SOMNIO_CONSTANTS.playerRadius;
    const from = GHOST_AT.z - contact - 2.9;
    const fighter = attachPlayer(space, { x: GHOST_AT.x - 7.5, z: from }, 'fighter', {
      character: { lucidity: lucidity('fighter', { strike: 2, lunge: 1 }), energy: energy({ balanceCurrent: 14 }) },
    });
    space.handleMove(move(GHOST_AT.x, from, 180, 'walk'), fighter.entityId);
    clock.ms += 1000;
    space.handleTarget(GHOST, fighter.entityId);
    space.handleUseAbility('lunge', fighter.entityId);
    expect(energyOf(space, fighter.entityId).balanceCurrent).toBe(2);
    for (let report = 1; report <= 5; report += 1) {
      clock.ms += 100;
      space.handleMove(move(GHOST_AT.x, from + 0.58 * report, 0, 'walk'), fighter.entityId);
    }
    expect(positionOf(space, fighter.entityId)).toEqual({ x: GHOST_AT.x, z: from + 0.58 * 5 });
    expect(energyOf(space, fighter.entityId).balanceCurrent).toBe(2);
    expect(await corrections(fighter.outbox)).toEqual([]);
  });

  /**
   * A leap reported as a run holds recovery at the running pace for as long as its metres take at
   * the leap's 6 m a second, not at a run's 3: by its last report, held only for the window after it.
   */
  it("holds recovery for Lunge's leap reported as a run only as long as the leap takes", () => {
    const { clock, space } = arena({ size: { width: 30, depth: 30 } });
    const contact = monsterKind('ghost').radius + SOMNIO_CONSTANTS.playerRadius;
    const from = GHOST_AT.z - contact - 2.9;
    const fighter = attachPlayer(space, { x: GHOST_AT.x, z: from }, 'fighter', {
      character: { lucidity: lucidity('fighter', { strike: 2, lunge: 1 }), energy: energy({ balanceCurrent: 100 }) },
    });
    space.handleTarget(GHOST, fighter.entityId);
    space.handleUseAbility('lunge', fighter.entityId);
    for (let report = 1; report <= 5; report += 1) {
      clock.ms += 100;
      space.handleMove(move(GHOST_AT.x, from + 0.58 * report, 0, 'run'), fighter.entityId);
    }
    expect(space.handOver(fighter.entityId, false)!.transient.runningSeconds).toBeCloseTo(0.25, 9);
  });

  /** Ten 0.3 m runs reported in the same millisecond: the first holds for the window, and each after it adds its 0.1 s at a run, however the reports bunch. */
  it('holds recovery for every run of a bunch, one after another', () => {
    const { space, mover } = walker(100);
    for (let report = 1; report <= 10; report += 1) space.handleMove(move(2 + 0.3 * report, 10, 90, 'run'), mover.entityId);
    expect(space.handOver(mover.entityId, false)!.transient.runningSeconds).toBeCloseTo(1.15, 9);
  });

  /** 3 m run hold recovery for a second; a 4 m walk right after, past the 2.5 s of credit 2 s refilled, is charged but leaves that second whole. */
  it('keeps a run hold whole through a charged walk after it', () => {
    const { clock, space, mover, balanceNow } = walker(100);
    spendBoth(space, mover.entityId);
    clock.ms += 2000;
    const at = positionOf(space, mover.entityId)!;
    space.handleMove(move(at.x + 3, 10, 90, 'run'), mover.entityId);
    space.handleMove(move(at.x + 7, 10, 90, 'walk'), mover.entityId);
    expect(balanceNow()).toBeLessThan(90);
    expect(space.handOver(mover.entityId, false)!.transient.runningSeconds).toBeCloseTo(1, 9);
  });

  /**
   * Reports however seldom hold recovery at their gait for as long as their metres take at it, and
   * a slower gait's report beside them cannot cut that short. Over 4 s of 50 ms steps, standing
   * would recover 48.
   */
  it.each([
    // Jogging recovers 4.8 a second; the step that ends each second's hold recovers standing.
    { schedule: 'a jog of 2 m once a second', balance: 50, reports: [{ atMs: 0, gait: 'jog', metres: 2 }], recovered: 20 },
    // Moving while winded recovers nothing; the step that ends each second's hold recovers standing.
    { schedule: 'a winded walk of 1 m once a second', balance: 5, reports: [{ atMs: 0, gait: 'walk', metres: 1 }], recovered: 2 },
    {
      schedule: 'a jog of 0.2 m with a 1 µm walk after it every 100 ms',
      balance: 50,
      reports: Array.from({ length: 10 }, (_, report) => [
        { atMs: 100 * report, gait: 'jog' as const, metres: 0.2 },
        { atMs: 100 * report + 1, gait: 'walk' as const, metres: 0.000_001 },
      ]).flat(),
      recovered: 19,
    },
  ] as const)('recovers at the gait of $schedule, not as standing', ({ balance, reports, recovered }) => {
    const { clock, space, mover, balanceNow } = walker(balance);
    let x = 2;
    for (let second = 0; second < 4; second += 1) {
      let next = 0;
      for (let step = 1; step <= 20; step += 1) {
        const stepAt = 1000 * second + 50 * step;
        for (; next < reports.length && 1000 * second + reports[next]!.atMs < stepAt; next += 1) {
          const { atMs, gait, metres } = reports[next]!;
          clock.ms = 1000 * second + atMs;
          x += metres;
          space.handleMove(move(x, 10, 90, gait), mover.entityId);
        }
        clock.ms = stepAt;
        space.step(0.05);
      }
    }
    expect(balanceNow()).toBe(balance + recovered);
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
