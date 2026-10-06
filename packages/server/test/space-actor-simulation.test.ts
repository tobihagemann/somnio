import { describe, expect, it } from 'vitest';
import { OUTDOOR_SPACE_ID, SOMNIO_CONSTANTS, headingFromCardinal, headingFromVector, monsterKind } from '@somnio/core';
import type { NPCDialogState, Point, Sector } from '@somnio/core';
import type { ConnectionOutbox } from '../src/connection/outbox.ts';
import { seededRandom } from '../src/world/random.ts';
import type { SpaceActor } from '../src/world/spaceActor.ts';
import type { SpaceActorOptions } from '../src/world/spaceActor.ts';
import { RESPAWN_MS } from './support/combat.ts';
import { collectMessages, entities, entityMoves, serverSays } from './support/frames.ts';
import { attachPlayer, makeClockedSpace, makeMonsterSpawn, makeNPC, makeSector, makeWorld } from './support/sectorFactory.ts';

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
    const kind = monsterKind('gespenst');
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
  /** A space whose one monster already stands at (10, 10). */
  function withMonster(overrides: Partial<Sector> = {}) {
    const { clock, space } = actor({ monsterSpawns: [makeMonsterSpawn({ x: 10, z: 10 })], ...overrides });
    clock.ms = RESPAWN_MS;
    space.step(0);
    return space;
  }

  async function monsterMoves(space: SpaceActor, outbox: ConnectionOutbox) {
    space.flushMoves();
    return entityMoves(await collectMessages(outbox));
  }

  it('moves toward an in-radius player at its speed, facing them', async () => {
    const space = withMonster();
    const alice = attachPlayer(space, { x: 12, z: 12 }, 'alice');
    space.step(0.05);
    const [frame] = await monsterMoves(space, alice.outbox);
    const stride = (monsterKind('gespenst').metresPerSecond * 0.05) / Math.SQRT2;
    expect(frame).toMatchObject({ id: 'monster:1', facing: headingFromVector(2, 2) });
    expect(frame!.x).toBeCloseTo(10 + stride, 9);
    expect(frame!.z).toBeCloseTo(10 + stride, 9);
  });

  it('idles when no player is in radius', async () => {
    const space = withMonster();
    const alice = attachPlayer(space, { x: 18, z: 18 }, 'alice');
    space.step(0.05);
    expect(await monsterMoves(space, alice.outbox)).toEqual([]);
  });

  it('attaching after a chase delivers the post-step monster facing in the entity frame', async () => {
    const space = withMonster();
    attachPlayer(space, { x: 8, z: 8 }, 'alice');
    space.step(0.05);
    const bob = attachPlayer(space, { x: 2, z: 2 }, 'bob');
    expect((await monstersSeen(bob.outbox))[0]?.facing).toBe(headingFromVector(-2, -2));
  });

  it.each([true, false])('targets the nearest in-radius player regardless of attach order (closer first: %s)', async (closerFirst) => {
    const space = withMonster();
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

  it('blocked by collision turns to face the player without moving', async () => {
    const space = withMonster({ blockers: [{ id: 'post', x: 10.25, z: 10.25, width: 0.1, depth: 0.1 }] });
    const alice = attachPlayer(space, { x: 12, z: 12 }, 'alice');
    space.step(0.05);
    expect(await monsterMoves(space, alice.outbox)).toEqual([{ id: 'monster:1', x: 10, z: 10, facing: headingFromVector(2, 2), gait: 'jog' }]);
  });

  it('does not step onto a player, while a player may step onto it', async () => {
    const space = withMonster();
    const alice = attachPlayer(space, { x: 10.65, z: 10 }, 'alice');
    space.step(0.05);
    expect(await monsterMoves(space, alice.outbox)).toMatchObject([{ id: 'monster:1', x: 10, z: 10 }]);
    const bob = attachPlayer(space, { x: 9, z: 10 }, 'bob');
    space.handleMove({ x: 10, z: 10, facing: 0, gait: 'jog' }, bob.entityId);
    expect(space.snapshotForPlayer(bob.entityId)?.character.position).toEqual({ x: 10, z: 10 });
  });
});
