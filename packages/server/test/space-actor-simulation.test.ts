import { describe, expect, it } from 'vitest';
import { OUTDOOR_SPACE_ID, SOMNIO_CONSTANTS, headingFromCardinal, headingFromVector, monsterKind } from '@somnio/core';
import type { NPCDialogState, Point, Sector } from '@somnio/core';
import type { ConnectionOutbox } from '../src/connection/outbox.ts';
import { seededRandom } from '../src/world/random.ts';
import type { SpaceActor } from '../src/world/spaceActor.ts';
import type { SpaceActorOptions } from '../src/world/spaceActor.ts';
import { collectMessages, entities, entityMoves, serverSays } from './support/frames.ts';
import { attachPlayer, makeClockedSpace, makeMonsterSpawn, makeNPC, makeSector, makeWorld } from './support/sectorFactory.ts';

const GUARD = 'npc:TestSector/guard';
const COOLDOWN_MS = SOMNIO_CONSTANTS.npcDialogCooldownSeconds * 1000;
const RESPAWN_MS = monsterKind('gespenst').respawnSeconds * 1000;

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
  it('emits on the first step after a bump from inside the dialog radius', async () => {
    const { space } = actor(guard('Hello, $name.\n---\nFollow up.'));
    const alice = attachPlayer(space, { x: 10, z: 11.2 }, 'alice');
    space.handleBump(GUARD, alice.entityId);
    const digest = space.step(0.05);
    expect(serverSays(await collectMessages(alice.outbox))).toEqual(['Hello, alice.']);
    expect(digest.dialogUpserts).toEqual([{ sectorName: 'TestSector', npcId: 'guard', scriptStep: 2 }]);
    expect(digest.dialogResets).toEqual([]);
  });

  it('drops a bump from outside the dialog radius and a bump at anything but an NPC', async () => {
    const { space } = actor(guard('Hello, $name.'));
    const far = attachPlayer(space, { x: 10, z: 11.4 }, 'far');
    const near = attachPlayer(space, { x: 10, z: 11.2 }, 'near');
    space.handleBump(GUARD, far.entityId);
    space.handleBump(far.entityId, near.entityId);
    space.handleBump('npc:TestSector/nobody', near.entityId);
    const digest = space.step(0.05);
    expect(digest).toEqual({ dialogUpserts: [], dialogResets: [] });
    expect(serverSays(await collectMessages(near.outbox))).toEqual([]);
  });

  it('holds the next step until the cooldown has passed on the clock, then wraps and clears targeting', async () => {
    const { clock, space } = actor(guard('step.\n---\nstep two.'));
    const alice = attachPlayer(space, { x: 10, z: 11.2 }, 'alice');
    space.handleBump(GUARD, alice.entityId);
    space.step(0.05);
    clock.ms = COOLDOWN_MS - 1;
    expect(space.step(0.05)).toEqual({ dialogUpserts: [], dialogResets: [] });
    clock.ms = COOLDOWN_MS;
    expect(space.step(0.05)).toEqual({ dialogUpserts: [], dialogResets: [{ sectorName: 'TestSector', npcId: 'guard' }] });
    clock.ms = 2 * COOLDOWN_MS;
    expect(space.step(0.05)).toEqual({ dialogUpserts: [], dialogResets: [] });
    expect(serverSays(await collectMessages(alice.outbox))).toEqual(['step.', 'step two.']);
  });

  it('a target walking out of the radius resets the cursor and emits one digest reset', () => {
    const { clock, space } = actor(guard('first.\n---\nsecond.\n---\nthird.'));
    const alice = attachPlayer(space, { x: 10, z: 11.2 }, 'alice');
    space.handleBump(GUARD, alice.entityId);
    space.step(0.05);
    clock.ms += 1000;
    space.handleMove({ x: 10, z: 12.7, facing: 0, gait: 'jog' }, alice.entityId);
    expect(space.step(0.05)).toEqual({ dialogUpserts: [], dialogResets: [{ sectorName: 'TestSector', npcId: 'guard' }] });
    expect(space.step(0.05)).toEqual({ dialogUpserts: [], dialogResets: [] });
  });

  it('a target leaving the space resets the cursor and emits one digest reset', () => {
    const { space } = actor(guard('first.\n---\nsecond.'));
    const alice = attachPlayer(space, { x: 10, z: 11.2 }, 'alice');
    space.handleBump(GUARD, alice.entityId);
    space.step(0.05);
    space.detach(alice.entityId, false);
    expect(space.step(0.05).dialogResets).toHaveLength(1);
    expect(space.step(0.05).dialogResets).toEqual([]);
  });
});

describe('cursor seeding', () => {
  const persisted = (scriptStep: number, npcId = 'guard'): NPCDialogState[] => [{ sectorName: 'TestSector', npcId, scriptStep }];

  it('resumes at the persisted step', async () => {
    const { space } = actor(guard('first.\n---\nsecond.\n---\nthird.'), { initialDialogStates: persisted(2) });
    const alice = attachPlayer(space, { x: 10, z: 11.2 }, 'alice');
    space.handleBump(GUARD, alice.entityId);
    const digest = space.step(0.05);
    expect(serverSays(await collectMessages(alice.outbox))).toEqual(['second.']);
    expect(digest.dialogUpserts[0]?.scriptStep).toBe(3);
  });

  it.each([7, 0, -1])('an out of range persisted cursor %i clamps to the first step', async (scriptStep) => {
    const { space } = actor(guard('first.\n---\nsecond.\n---\nthird.'), { initialDialogStates: persisted(scriptStep) });
    const alice = attachPlayer(space, { x: 10, z: 11.2 }, 'alice');
    space.handleBump(GUARD, alice.entityId);
    space.step(0.05);
    expect(serverSays(await collectMessages(alice.outbox))).toEqual(['first.']);
  });

  it('an empty script with a persisted cursor takes the no-op branch on emit', async () => {
    const { space } = actor(guard(''), { initialDialogStates: persisted(3) });
    const alice = attachPlayer(space, { x: 10, z: 11.2 }, 'alice');
    space.handleBump(GUARD, alice.entityId);
    expect(space.step(0.05)).toEqual({ dialogUpserts: [], dialogResets: [] });
    expect(serverSays(await collectMessages(alice.outbox))).toEqual([]);
  });

  it.each([false, true])('a persisted cursor stays with its NPC when the records are reordered (reversed: %s)', async (reversed) => {
    const npcs = [makeNPC('guard', { x: 10, z: 10 }, 'guard one.\n---\nguard two.'), makeNPC('smith', { x: 11.6, z: 10 }, 'smith one.\n---\nsmith two.')];
    const { space } = actor({ npcs: reversed ? npcs.toReversed() : npcs }, { initialDialogStates: persisted(2, 'smith') });
    const alice = attachPlayer(space, { x: 10.8, z: 10.9 }, 'alice');
    space.handleBump(GUARD, alice.entityId);
    space.handleBump('npc:TestSector/smith', alice.entityId);
    space.step(0.05);
    expect(serverSays(await collectMessages(alice.outbox)).toSorted()).toEqual(['guard one.', 'smith two.']);
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
