import { describe, expect, it } from 'vitest';
import {
  EDGE_TOLERANCE,
  OUTDOOR_SPACE_ID,
  SOMNIO_CONSTANTS,
  distance,
  headingFromCardinal,
  headingFromVector,
  headingRadians,
  monsterKind,
  reachDistance,
} from '@somnio/core';
import type { NPCDialogState, Point, Sector } from '@somnio/core';
import type { SomnioMessage } from '@somnio/protocol';
import { outdoorSector } from '../../core/test/support/worldFixture.ts';
import type { ConnectionOutbox } from '../src/connection/outbox.ts';
import { seededRandom } from '../src/world/random.ts';
import type { SpaceActor } from '../src/world/spaceActor.ts';
import type { SpaceActorOptions } from '../src/world/spaceActor.ts';
import { CUDGEL_IN_HAND, GHOST, RESPAWN_MS, energy, payloads } from './support/combat.ts';
import { collectMessages, entities, entityMoves, serverSays } from './support/frames.ts';
import { attachPlayer, landsAtCentre, makeClockedSpace, makeMonsterGround, makeMonsterSpawn, makeNPC, makeSector, makeWorld } from './support/sectorFactory.ts';

const GUARD = 'npc:TestSector/guard';
const COOLDOWN_MS = SOMNIO_CONSTANTS.npcDialogCooldownSeconds * 1000;

/** One 20 x 20 m sector on a clock the test advances. */
function actor(overrides: Partial<Sector> = {}, options: Partial<SpaceActorOptions> = {}) {
  return makeClockedSpace(makeWorld([makeSector('TestSector', overrides)]), OUTDOOR_SPACE_ID, options);
}

function guard(dialogScript: string): Partial<Sector> {
  return { npcs: [makeNPC('guard', { x: 10, z: 10 }, dialogScript)] };
}

async function monstersSeen(outbox: ConnectionOutbox) {
  return entities(await collectMessages(outbox)).filter((entity) => entity.kind === 'monster');
}

describe('NPC dialog', () => {
  const NEAR: Point = { x: 10, z: 11.2 };
  const AWAY: Point = { x: 10, z: 12.7 };
  const QUIET = { dialogUpserts: [], dialogResets: [] };
  const KEY = { sectorName: 'TestSector', npcId: 'guard' };

  it('greets a dreamer who comes within speaking distance with its first line, once, and leaves the cursor alone', async () => {
    const { clock, space } = actor(guard('Hello, $name.\n---\nFollow up.'));
    const alice = attachPlayer(space, AWAY, 'alice');
    expect(space.step(0.05)).toEqual(QUIET);
    space.handleMove({ ...NEAR, facing: 0, gait: 'jog' }, alice.entityId);
    expect(space.step(0.05)).toEqual(QUIET);
    clock.ms += 2 * COOLDOWN_MS;
    space.step(0.05);
    expect(serverSays(await collectMessages(alice.outbox))).toEqual(['Hello, alice.']);
  });

  it('greets a dreamer again who walked away and came back, but not within the greeting pause', async () => {
    const { clock, space } = actor(guard('Hello, $name.'));
    const alice = attachPlayer(space, NEAR, 'alice');
    const walk = (to: Point): void => {
      clock.ms += 2000;
      space.handleMove({ ...to, facing: 0, gait: 'jog' }, alice.entityId);
      space.step(0.05);
    };
    space.step(0.05);
    walk(AWAY);
    walk(NEAR);
    walk(AWAY);
    clock.ms += SOMNIO_CONSTANTS.npcGreetingPauseSeconds * 1000;
    walk(NEAR);
    expect(serverSays(await collectMessages(alice.outbox))).toEqual(['Hello, alice.', 'Hello, alice.']);
  });

  it('greets a dreamer who stays beside it once, however long they stay', async () => {
    const { clock, space } = actor(guard('Hello, $name.'));
    const alice = attachPlayer(space, NEAR, 'alice');
    space.step(0.05);
    clock.ms += 2 * SOMNIO_CONSTANTS.npcGreetingPauseSeconds * 1000;
    space.step(0.05);
    expect(serverSays(await collectMessages(alice.outbox))).toEqual(['Hello, alice.']);
  });

  it('greets arrivals one at a time, a cooldown apart', async () => {
    const { clock, space } = actor(guard('Hello, $name.'));
    const alice = attachPlayer(space, NEAR, 'alice');
    const bob = attachPlayer(space, { x: 10.8, z: 10.9 }, 'bob');
    space.step(0.05);
    clock.ms = COOLDOWN_MS - 1;
    space.step(0.05);
    expect(serverSays(await collectMessages(bob.outbox))).toEqual(['Hello, alice.']);
    clock.ms = COOLDOWN_MS;
    space.step(0.05);
    expect(serverSays(await collectMessages(alice.outbox))).toEqual(['Hello, alice.', 'Hello, bob.']);
  });

  it('answers a dreamer who asks with the lines after its greeting, the first at once and the rest a cooldown apart, then wraps and clears targeting', async () => {
    const { clock, space } = actor(guard('Hello.\n---\nstep two, $name.\n---\nstep three.'));
    const alice = attachPlayer(space, NEAR, 'alice');
    space.step(0.05);
    space.handleTalk(GUARD, alice.entityId);
    expect(space.step(0.05)).toEqual({ dialogUpserts: [{ ...KEY, scriptStep: 3 }], dialogResets: [] });
    clock.ms = COOLDOWN_MS - 1;
    expect(space.step(0.05)).toEqual(QUIET);
    clock.ms = COOLDOWN_MS;
    expect(space.step(0.05)).toEqual({ dialogUpserts: [], dialogResets: [KEY] });
    clock.ms = 2 * COOLDOWN_MS;
    expect(space.step(0.05)).toEqual(QUIET);
    expect(serverSays(await collectMessages(alice.outbox))).toEqual(['Hello.', 'step two, alice.', 'step three.']);
  });

  it('drops a talk from beyond speaking distance and one at anything but an NPC', async () => {
    const { clock, space } = actor(guard('Hello, $name.\n---\nFollow up.'));
    const far = attachPlayer(space, { x: 10, z: 12.1 }, 'far');
    const near = attachPlayer(space, NEAR, 'near');
    space.handleTalk(GUARD, far.entityId);
    space.handleTalk(far.entityId, near.entityId);
    space.handleTalk('npc:TestSector/nobody', near.entityId);
    expect(space.step(0.05)).toEqual(QUIET);
    clock.ms = COOLDOWN_MS;
    expect(space.step(0.05)).toEqual(QUIET);
    expect(serverSays(await collectMessages(near.outbox))).toEqual(['Hello, near.']);
  });

  it('has nothing to go on with when its greeting is all it has', async () => {
    const { clock, space } = actor(guard('Hello, $name.'));
    const alice = attachPlayer(space, NEAR, 'alice');
    space.step(0.05);
    space.handleTalk(GUARD, alice.entityId);
    expect(space.step(0.05)).toEqual(QUIET);
    clock.ms = COOLDOWN_MS;
    expect(space.step(0.05)).toEqual(QUIET);
    expect(serverSays(await collectMessages(alice.outbox))).toEqual(['Hello, alice.']);
  });

  it('a target walking out of speaking distance resets the cursor and emits one digest reset', () => {
    const { clock, space } = actor(guard('first.\n---\nsecond.\n---\nthird.'));
    const alice = attachPlayer(space, NEAR, 'alice');
    space.step(0.05);
    space.handleTalk(GUARD, alice.entityId);
    expect(space.step(0.05).dialogUpserts).toHaveLength(1);
    clock.ms += 1000;
    space.handleMove({ ...AWAY, facing: 0, gait: 'jog' }, alice.entityId);
    expect(space.step(0.05)).toEqual({ dialogUpserts: [], dialogResets: [KEY] });
    expect(space.step(0.05)).toEqual(QUIET);
  });

  it('a target leaving the space resets the cursor and emits one digest reset', () => {
    const { space } = actor(guard('first.\n---\nsecond.'));
    const alice = attachPlayer(space, NEAR, 'alice');
    space.step(0.05);
    space.handleTalk(GUARD, alice.entityId);
    space.detach(alice.entityId, false);
    expect(space.step(0.05).dialogResets).toHaveLength(1);
    expect(space.step(0.05).dialogResets).toEqual([]);
  });
});

describe('cursor seeding', () => {
  const NEAR: Point = { x: 10, z: 11.2 };
  const persisted = (scriptStep: number, npcId = 'guard'): NPCDialogState[] => [{ sectorName: 'TestSector', npcId, scriptStep }];

  /** Greets the dreamer beside the guard, then has them ask it to go on. */
  async function asked(script: string, states: NPCDialogState[]) {
    const { space } = actor(guard(script), { initialDialogStates: states });
    const alice = attachPlayer(space, NEAR, 'alice');
    space.step(0.05);
    space.handleTalk(GUARD, alice.entityId);
    const digest = space.step(0.05);
    return { digest, says: serverSays(await collectMessages(alice.outbox)) };
  }

  it('resumes at the persisted step', async () => {
    const { digest, says } = await asked('first.\n---\nsecond.\n---\nthird.', persisted(3));
    expect(says).toEqual(['first.', 'third.']);
    expect(digest.dialogResets).toHaveLength(1);
  });

  it.each([7, 0, -1, 1])('a persisted cursor %i that is out of range or on the greeting starts past the greeting', async (scriptStep) => {
    const { digest, says } = await asked('first.\n---\nsecond.\n---\nthird.', persisted(scriptStep));
    expect(says).toEqual(['first.', 'second.']);
    expect(digest.dialogUpserts[0]?.scriptStep).toBe(3);
  });

  it('an empty script with a persisted cursor says nothing', async () => {
    const { digest, says } = await asked('', persisted(3));
    expect(digest).toEqual({ dialogUpserts: [], dialogResets: [] });
    expect(says).toEqual([]);
  });

  it.each([false, true])('a persisted cursor stays with its NPC when the records are reordered (reversed: %s)', async (reversed) => {
    const npcs = [
      makeNPC('guard', { x: 10, z: 10 }, 'guard one.\n---\nguard two.\n---\nguard three.'),
      makeNPC('smith', { x: 11.6, z: 10 }, 'smith one.\n---\nsmith two.\n---\nsmith three.'),
    ];
    const { space } = actor({ npcs: reversed ? npcs.toReversed() : npcs }, { initialDialogStates: persisted(3, 'smith') });
    const alice = attachPlayer(space, { x: 10.8, z: 10.9 }, 'alice');
    space.step(0.05);
    space.handleTalk(GUARD, alice.entityId);
    space.handleTalk('npc:TestSector/smith', alice.entityId);
    space.step(0.05);
    expect(serverSays(await collectMessages(alice.outbox)).toSorted()).toEqual(['guard one.', 'guard two.', 'smith one.', 'smith three.']);
  });
});

describe('monster spawn cadence', () => {
  it('no monster exists at boot, and one spawns once the respawn time has passed on the clock', async () => {
    const { clock, space } = actor({ monsterSpawns: [makeMonsterSpawn({ x: 10, z: 10 })] });
    const early = attachPlayer(space, { x: 2, z: 2 }, 'early');
    clock.ms = RESPAWN_MS - 1;
    space.step(0.05);
    const late = attachPlayer(space, { x: 18, z: 18 }, 'late');
    clock.ms = RESPAWN_MS;
    space.step(0.05);
    const kind = monsterKind('ghost');
    const spawned = { id: 'monster:1', kind: 'monster', characterModelId: kind.characterModelId, name: kind.name, radius: kind.radius, x: 10, z: 10 };
    expect(await monstersSeen(early.outbox)).toMatchObject([spawned]);
    expect(await monstersSeen(late.outbox)).toMatchObject([spawned]);
  });

  it('a spawn never keeps more than maxAlive monsters', async () => {
    const { clock, space } = actor({ monsterSpawns: [makeMonsterSpawn({ x: 5, z: 5 }, 10, 3)] }, { random: seededRandom(7) });
    const alice = attachPlayer(space, { x: 2, z: 2 }, 'alice');
    for (let pass = 1; pass <= 10; pass += 1) {
      clock.ms = pass * RESPAWN_MS;
      space.step(0);
    }
    expect((await monstersSeen(alice.outbox)).map((monster) => monster.id)).toEqual(['monster:1', 'monster:2', 'monster:3']);
  });

  it('a spawned monster is placed clear of blockers', async () => {
    // The west half of the area is under a blocker.
    const blocker = { id: 'slab', x: 8, z: 8, width: 2, depth: 4 };
    const { clock, space } = actor({ monsterSpawns: [makeMonsterSpawn({ x: 8, z: 8 }, 4)], blockers: [blocker] }, { random: seededRandom(3) });
    const alice = attachPlayer(space, { x: 2, z: 2 }, 'alice');
    clock.ms = RESPAWN_MS;
    space.step(0);
    const [monster] = await monstersSeen(alice.outbox);
    expect(monster!.x).toBeGreaterThanOrEqual(blocker.x + blocker.width + monster!.radius);
  });

  it('places a monster inside an area whose size has a fraction of a centimetre', async () => {
    const area = { ...makeMonsterSpawn({ x: 2, z: 2 }), width: 5.765, depth: 5.765 };
    // 5.765 m rounds to 577 cm, and this is the last draw of that range.
    const { clock, space } = actor({ monsterSpawns: [area] }, { random: { nextUInt32: () => 577 } });
    const alice = attachPlayer(space, { x: 18, z: 18 }, 'alice');
    clock.ms = RESPAWN_MS;
    space.step(0);
    const [monster] = await monstersSeen(alice.outbox);
    expect(monster!.x).toBeLessThanOrEqual(area.x + area.width);
    expect(monster!.z).toBeLessThanOrEqual(area.z + area.depth);
  });

  it('a blocked spawn point keeps the timer due and spawns once it frees', async () => {
    const { clock, space } = actor({ monsterSpawns: [makeMonsterSpawn({ x: 10, z: 10 })] });
    const observer = attachPlayer(space, { x: 2, z: 2 }, 'observer');
    const blocker = attachPlayer(space, { x: 10, z: 10 }, 'blocker');
    clock.ms = RESPAWN_MS;
    space.step(0);
    space.detach(blocker.entityId, false);
    space.step(0);
    expect(await monstersSeen(observer.outbox)).toHaveLength(1);
  });
});

describe('monster aggro and chase', () => {
  const HOME: Point = { x: 10, z: 10 };
  /** Outside every ground and aggro radius here, where a watcher joins. */
  const AFAR: Point = { x: 1, z: 19 };
  const FALLEN = { character: { energy: energy({ healthCurrent: 0 }) } };
  const REACH = reachDistance(monsterKind('ghost').radius);
  const STRIDE = monsterKind('ghost').metresPerSecond * 0.05;

  type Steps = (count: number, each?: () => void) => void;

  /** Runs `count` steps of 50 ms on the clock, calling `each` before every one. */
  function stepper(clock: { ms: number }, space: SpaceActor): Steps {
    return (count, each = () => {}) => {
      for (let index = 0; index < count; index += 1) {
        clock.ms += 50;
        each();
        space.step(0.05);
      }
    };
  }

  /** A space whose one monster already stands at (10, 10), in the middle of a home ground reaching `half` metres each way. */
  function withMonster(overrides: Partial<Sector> = {}, half = 4) {
    const { clock, space } = actor({ monsterSpawns: [makeMonsterGround(HOME, half)], ...overrides }, { random: landsAtCentre(half) });
    clock.ms = RESPAWN_MS;
    space.step(0);
    return { clock, space, steps: stepper(clock, space) };
  }

  const movesIn = (messages: readonly SomnioMessage[]) => entityMoves(messages).filter((move) => move.id === GHOST);

  /** The monster's moves, as the outbox's dreamer is told them. Reading an outbox finishes it. */
  async function monsterMoves(space: SpaceActor, outbox: ConnectionOutbox) {
    space.flushMoves();
    return movesIn(await collectMessages(outbox));
  }

  /** The monster as a dreamer joining at `at` is shown it now. */
  async function monsterNow(space: SpaceActor, at: Point = AFAR) {
    const watcher = attachPlayer(space, at, 'watcher');
    space.detach(watcher.entityId, false);
    return (await monstersSeen(watcher.outbox))[0]!;
  }

  /** Everything a dreamer who joins at `at` is sent over `count` more steps. */
  async function sentOver(space: SpaceActor, steps: Steps, count: number, at: Point = AFAR) {
    space.flushMoves();
    const watcher = attachPlayer(space, at, 'watcher');
    steps(count);
    space.flushMoves();
    space.detach(watcher.entityId, false);
    return collectMessages(watcher.outbox);
  }

  const conditionsIn = (messages: readonly SomnioMessage[]) =>
    payloads(messages, 'condition').flatMap((sent) => (sent.entityId === GHOST ? [sent.condition] : []));

  /** Has the monster chase a dreamer from its home at (10, 10) to just inside its reach of them. The returned `leave` moves the dreamer out of its ground. */
  async function chasedFromHome(dreamer: Point = { x: 12, z: 10 }) {
    const monster = withMonster();
    const alice = attachPlayer(monster.space, dreamer, 'alice');
    monster.steps(30);
    const chaseEnd = await monsterNow(monster.space);
    const leave = (): void => monster.space.handleMove({ x: 15, z: 10, facing: 0, gait: 'jog' }, alice.entityId);
    return { ...monster, alice, chaseEnd, leave };
  }

  it('moves toward an in-radius player at its speed, facing them', async () => {
    const { space } = withMonster();
    const alice = attachPlayer(space, { x: 12, z: 12 }, 'alice');
    space.step(0.05);
    const [frame] = await monsterMoves(space, alice.outbox);
    expect(frame).toMatchObject({ id: GHOST, facing: headingFromVector(2, 2) });
    expect(frame!.x).toBeCloseTo(10 + STRIDE / Math.SQRT2, 9);
    expect(frame!.z).toBeCloseTo(10 + STRIDE / Math.SQRT2, 9);
  });

  it('idles when no player is in radius', async () => {
    const { space } = withMonster();
    const alice = attachPlayer(space, { x: 18, z: 18 }, 'alice');
    space.step(0.05);
    expect(await monsterMoves(space, alice.outbox)).toEqual([]);
  });

  it('lets a dreamer within its aggro radius but outside its ground be', async () => {
    const { space, steps } = withMonster({}, 2);
    const alice = attachPlayer(space, { x: 13, z: 10 }, 'alice');
    steps(10);
    expect(await monsterMoves(space, alice.outbox)).toEqual([]);
  });

  it('attaching after a chase delivers the post-step monster facing in the entity frame', async () => {
    const { space } = withMonster();
    attachPlayer(space, { x: 8, z: 8 }, 'alice');
    space.step(0.05);
    const bob = attachPlayer(space, { x: 2, z: 2 }, 'bob');
    expect((await monstersSeen(bob.outbox))[0]?.facing).toBe(headingFromVector(-2, -2));
  });

  it.each([true, false])('targets the nearest in-radius player regardless of attach order (closer first: %s)', async (closerFirst) => {
    const { space } = withMonster();
    const places: [string, Point][] = [
      ['alice', { x: 11.2, z: 10 }],
      ['bob', { x: 7, z: 10 }],
    ];
    const [alice] = (closerFirst ? places : places.toReversed())
      .map(([name, at]) => attachPlayer(space, at, name))
      .filter((_, index) => (index === 0) === closerFirst);
    space.step(0.05);
    expect((await monsterMoves(space, alice!.outbox))[0]?.facing).toBe(headingFromCardinal('east'));
  });

  it('steers round a post in its way, still facing the player', async () => {
    const { space } = withMonster({ blockers: [{ id: 'post', x: 10.25, z: 10.25, width: 0.1, depth: 0.1 }] });
    const alice = attachPlayer(space, { x: 12, z: 12 }, 'alice');
    space.step(0.05);
    const [frame] = await monsterMoves(space, alice.outbox);
    expect(frame).toMatchObject({ id: GHOST, facing: headingFromVector(2, 2) });
    expect(distance(frame!, HOME)).toBeCloseTo(STRIDE, 9);
    expect(Math.abs(headingFromVector(frame!.x - 10, frame!.z - 10) - headingFromVector(2, 2))).toBeGreaterThan(1);
  });

  it('closes to just inside its reach of a player and stops there, while a player may step onto it', async () => {
    const { space, steps } = withMonster();
    const alice = attachPlayer(space, { x: 11.2, z: 10 }, 'alice');
    steps(20, () => space.flushMoves());
    const moves = await monsterMoves(space, alice.outbox);
    expect(moves).toHaveLength(3);
    const stop = moves.at(-1)!.x;
    expect(stop).toBeCloseTo(11.2 - (REACH - 0.01), 9);
    const bob = attachPlayer(space, { x: 9, z: 10 }, 'bob');
    space.handleMove({ x: stop, z: 10, facing: 0, gait: 'jog' }, bob.entityId);
    expect(space.snapshotForPlayer(bob.entityId)?.character.position).toEqual({ x: stop, z: 10 });
  });

  it('closes on a dreamer on the diagonal and strikes them', async () => {
    const { space, steps } = withMonster();
    const alice = attachPlayer(space, { x: 12, z: 12 }, 'alice');
    steps(25);
    expect(payloads(await collectMessages(alice.outbox), 'blow')).toContainEqual({ attackerId: GHOST, targetId: alice.entityId, hit: true });
  });

  it('strikes a dreamer in its reach just outside its ground, and the one it chases once it has reached them', async () => {
    const { space, steps } = withMonster({}, 0.8);
    const chased = attachPlayer(space, { x: 10.75, z: 10.75 }, 'chased');
    const outside = attachPlayer(space, { x: 10.83, z: 10 }, 'outside');
    steps(31);
    const blows = payloads(await collectMessages(chased.outbox), 'blow');
    expect(blows.map((blow) => blow.targetId)).toEqual([outside.entityId, chased.entityId]);
  });

  describe('at the north edge of its ground', () => {
    /**
     * The monster lands 5 cm in from its ground's north-west corner, at (10, 10), heading east
     * toward a dreamer at (12, 10) with a fallen body straight ahead in contact. A turn to its
     * first side, north, would leave the ground at any angle.
     */
    function atNorthEdge() {
      const ground = { ...makeMonsterSpawn({ x: 9.95, z: 9.95 }), width: 4, depth: 4 };
      const { clock, space } = actor({ monsterSpawns: [ground] }, { random: landsAtCentre(0.05) });
      clock.ms = RESPAWN_MS;
      space.step(0);
      const fallen = attachPlayer(space, { x: 10.6, z: 10 }, 'fallen', FALLEN);
      const alice = attachPlayer(space, { x: 12, z: 10 }, 'alice');
      return { space, steps: stepper(clock, space), fallen, alice };
    }

    it('turns the other way, and never leaves its ground', async () => {
      const { space, steps, alice } = atNorthEdge();
      steps(40, () => space.flushMoves());
      const moves = await monsterMoves(space, alice.outbox);
      expect(moves[0]!.z).toBeGreaterThan(10);
      for (const move of moves) expect(move.z).toBeGreaterThanOrEqual(9.95 - EDGE_TOLERANCE);
    });

    it('keeps turning to the side it last turned to', async () => {
      const { space, steps, fallen } = atNorthEdge();
      steps(1);
      const first = await monsterNow(space);
      expect(first.x).toBeCloseTo(10, 9);
      expect(first.z).toBeCloseTo(10 + STRIDE, 9);
      space.detach(fallen.entityId, false);
      // 0.65 m ahead and 0.1 m south of the bearing, a body blocks the straight step, both 30-degree
      // turns, and the 60 to the south. The 90 to the south and the 60 to the north are free.
      const bearing = headingRadians(headingFromVector(12 - first.x, 10 - first.z));
      const ahead = { x: Math.sin(bearing), z: Math.cos(bearing) };
      const south = { x: -ahead.z, z: ahead.x };
      attachPlayer(space, { x: first.x + 0.65 * ahead.x + 0.1 * south.x, z: first.z + 0.65 * ahead.z + 0.1 * south.z }, 'wall', FALLEN);
      steps(1);
      const second = await monsterNow(space);
      expect(second.x).toBeCloseTo(first.x + STRIDE * south.x, 9);
      expect(second.z).toBeCloseTo(first.z + STRIDE * south.z, 9);
    });
  });

  it('walks back to its home once no dreamer stands in its ground, and then sends nothing', async () => {
    const { space, steps, leave } = await chasedFromHome();
    leave();
    steps(40);
    expect(await monsterNow(space)).toMatchObject(HOME);
    expect(movesIn(await sentOver(space, steps, 20))).toEqual([]);
  });

  it('chases a dreamer who steps back into its ground while it walks home', async () => {
    const { space, steps, alice, chaseEnd, leave } = await chasedFromHome();
    leave();
    steps(3);
    const homeward = await monsterNow(space);
    expect(homeward.x).toBeLessThan(chaseEnd.x);
    space.handleMove({ x: 13, z: 10, facing: 0, gait: 'jog' }, alice.entityId);
    steps(3);
    const chasing = await monsterNow(space);
    expect(chasing.x).toBeCloseTo(homeward.x + 3 * STRIDE, 9);
    expect(chasing.facing).toBe(headingFromCardinal('east'));
  });

  it('rests short of a body lying on its home, and walks on home once the body is gone', async () => {
    const { space, steps, leave } = await chasedFromHome();
    const fallen = attachPlayer(space, HOME, 'fallen', FALLEN);
    leave();
    steps(100);
    expect(movesIn(await sentOver(space, steps, 40))).toEqual([]);
    space.detach(fallen.entityId, false);
    steps(20);
    expect(await monsterNow(space)).toMatchObject(HOME);
  });

  it('steps round a fallen body in its way home, however long the chase before it', async () => {
    // Lured to the far corner of its ground, it is still steering round the body a second into its walk home, when the rest rule first weighs its progress.
    const { space, steps } = withMonster();
    const alice = attachPlayer(space, { x: 12.5, z: 12.5 }, 'alice');
    steps(20);
    space.handleMove({ x: 13.9, z: 13.9, facing: 0, gait: 'jog' }, alice.entityId);
    steps(20);
    attachPlayer(space, { x: 11.2, z: 11.2 }, 'fallen', FALLEN);
    space.handleMove({ x: 15, z: 13.9, facing: 0, gait: 'jog' }, alice.entityId);
    steps(100);
    expect(await monsterNow(space)).toMatchObject(HOME);
  });

  it('steers home round a fallen body that blocks its first step back after a chase', async () => {
    const { space, steps, chaseEnd, leave } = await chasedFromHome({ x: 13.5, z: 10 });
    attachPlayer(space, { x: chaseEnd.x - 0.65, z: 10 }, 'fallen', FALLEN);
    leave();
    steps(100);
    expect(await monsterNow(space)).toMatchObject(HOME);
  });

  it('steps round another nightmare chasing the same dreamer', async () => {
    const second = { ...makeMonsterGround({ x: 10, z: 9.3 }, 4), id: 'spawn-2' };
    const { space, steps } = withMonster({ monsterSpawns: [makeMonsterGround(HOME, 4), second] });
    const alice = { x: 10, z: 12.8 };
    attachPlayer(space, alice, 'alice');
    steps(40);
    const [one, other] = await monstersSeen(attachPlayer(space, AFAR, 'watcher').outbox);
    // Both reached her, the one behind by coming round the other.
    expect(distance(one!, alice)).toBeLessThanOrEqual(REACH);
    expect(distance(other!, alice)).toBeLessThanOrEqual(REACH);
    expect(distance(one!, other!)).toBeGreaterThanOrEqual(2 * monsterKind('ghost').radius - 1e-6);
  });

  it('turns to face a dreamer it strikes, and sends the turn', async () => {
    const { space, steps } = withMonster({}, 0);
    const alice = attachPlayer(space, { x: 10.7, z: 10 }, 'alice');
    steps(1);
    expect(await monsterMoves(space, alice.outbox)).toEqual([{ id: GHOST, x: 10, z: 10, facing: headingFromCardinal('east'), gait: 'jog' }]);
  });

  it('rests before a wall of fallen bodies across its way home', async () => {
    const { space, steps, leave } = await chasedFromHome();
    for (const z of [9.4, 10, 10.6]) attachPlayer(space, { x: 10.5, z }, `fallen-${z}`, FALLEN);
    leave();
    steps(100);
    expect(movesIn(await sentOver(space, steps, 40))).toEqual([]);
  });

  it('comes round a fallen dreamer it touches to reach a standing one behind them', async () => {
    const { space, steps } = withMonster();
    attachPlayer(space, { x: 10.6, z: 10 }, 'fallen', FALLEN);
    const standing = attachPlayer(space, { x: 11.8, z: 10 }, 'standing');
    steps(40);
    expect(payloads(await collectMessages(standing.outbox), 'blow').map((blow) => blow.targetId)).toContain(standing.entityId);
  });

  it('steps away from a fallen body lying on it', async () => {
    const { space, steps } = withMonster();
    attachPlayer(space, HOME, 'fallen', FALLEN);
    attachPlayer(space, { x: 12, z: 10 }, 'alice');
    steps(5);
    expect((await monsterNow(space)).x).toBeGreaterThan(HOME.x);
  });

  it('heals at rest up to its maximum, and not while a dreamer stands in its reach', async () => {
    const { space, steps } = withMonster({}, 0.5);
    // Just outside the ground and in reach, so it strikes her and does not chase her.
    const inReach = { x: 10.7, z: 10 };
    const alice = attachPlayer(space, inReach, 'alice', { inventory: [CUDGEL_IN_HAND] });
    // Two cudgel hits take it from 60 to 44, and more than a second of rest takes it past 45.
    const woundTwice = async () => {
      const watcher = attachPlayer(space, AFAR, 'watcher');
      space.handleSwing(GHOST, alice.entityId);
      steps(20);
      space.handleSwing(GHOST, alice.entityId);
      space.detach(watcher.entityId, false);
      return conditionsIn(await collectMessages(watcher.outbox));
    };
    expect(await woundTwice()).toEqual(['grazed', 'wounded']);
    expect(conditionsIn(await sentOver(space, steps, 60))).toEqual([]);

    space.handleMove({ x: 12, z: 10, facing: 0, gait: 'jog' }, alice.entityId);
    expect(conditionsIn(await sentOver(space, steps, 19))).toEqual([]);
    const rested = await sentOver(space, steps, 3);
    expect(conditionsIn(rested)).toEqual(['grazed']);
    expect(movesIn(rested)).toEqual([]);

    // A hundred seconds on, two more hits wound it again: it healed no further than 60.
    steps(2000);
    space.handleMove({ ...inReach, facing: 0, gait: 'jog' }, alice.entityId);
    expect(await woundTwice()).toEqual(['grazed', 'wounded']);
  });

  it('heals nothing while it walks home', async () => {
    const { space, steps } = withMonster();
    const alice = attachPlayer(space, { x: 13.7, z: 10 }, 'alice', { inventory: [CUDGEL_IN_HAND] });
    steps(30);
    space.handleSwing(GHOST, alice.entityId);
    steps(20);
    space.handleSwing(GHOST, alice.entityId);
    space.handleMove({ x: 15, z: 10, facing: 0, gait: 'jog' }, alice.entityId);
    let lastMove = 0;
    let grazed = 0;
    for (let step = 1; step <= 80; step += 1) {
      const sent = await sentOver(space, steps, 1);
      if (movesIn(sent).length > 0) lastMove = step;
      if (conditionsIn(sent).includes('grazed')) grazed = step;
    }
    // The walk home takes longer than the second of rest that heals it past the band.
    expect(lastMove).toBeGreaterThan(20);
    expect(grazed).toBeGreaterThan(lastMove + 20);
  });

  it('walks back onto a home at the far edge of its ground, away from the origin', async () => {
    const spawn = { ...makeMonsterSpawn({ x: 0.01, z: 0.01 }), width: 4.8, depth: 4.8 };
    const sector = outdoorSector('Far', { x: -61.44, z: 0 }, { monsterSpawns: [spawn] });
    // The last draw of each axis puts the home on the ground's south-east corner.
    const { clock, space } = makeClockedSpace(makeWorld([sector]), OUTDOOR_SPACE_ID, { random: { nextUInt32: () => 480 } });
    clock.ms = RESPAWN_MS;
    const alice = attachPlayer(space, { x: -58.5, z: 3 }, 'alice');
    space.step(0);
    const afar = { x: -45, z: 18 };
    const home = await monsterNow(space, afar);
    const steps = stepper(clock, space);
    steps(20);
    expect((await monsterNow(space, afar)).x).toBeLessThan(home.x);
    space.handleMove({ x: -54, z: 3, facing: 0, gait: 'jog' }, alice.entityId);
    steps(40);
    expect(await monsterNow(space, afar)).toMatchObject({ x: home.x, z: home.z });
  });
});
