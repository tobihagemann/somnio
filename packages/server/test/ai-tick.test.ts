import { describe, expect, it } from 'vitest';
import { WIRE_ENTITY_TYPE } from '@somnio/protocol';
import { SOMNIO_CONSTANTS, TEMPO, feetRect, headingFromCardinal, headingFromVector, intersects } from '@somnio/core';
import type { CollisionMask, GridPoint, GridSize, MonsterSpawn, SectorNPC } from '@somnio/core';
import { ConnectionOutbox } from '../src/connection/outbox.ts';
import { npcEntityIndices } from '../src/world/entityIndex.ts';
import { DEFAULT_MONSTER_SPAWN_THRESHOLD, PerSectorActor } from '../src/world/perSectorActor.ts';
import type { PerSectorActorOptions } from '../src/world/perSectorActor.ts';
import { seededRandom } from '../src/world/random.ts';
import { collectMessages, entities, serverPositions, serverSays } from './support/frames.ts';
import { testLogger } from './support/logger.ts';
import { makeCharacter, makeMonsterSpawn, makeNPC, makeSector } from './support/sectorFactory.ts';

interface World {
  dimensions?: GridSize;
  npcs?: SectorNPC[];
  monsterSpawns?: MonsterSpawn[];
  collisionMasks?: CollisionMask[];
}

function actor(world: World = {}, options: Partial<PerSectorActorOptions> = {}): PerSectorActor {
  return new PerSectorActor(makeSector('TestSector', world), { logger: testLogger(), ...options });
}

function attach(sector: PerSectorActor, name: string, at: GridPoint, watermark = 1024) {
  const outbox = new ConnectionOutbox(watermark);
  const entityIndex = sector.attach(makeCharacter(at, name), [], outbox);
  return { outbox, entityIndex };
}

function tick(sector: PerSectorActor, times: number) {
  for (let count = 0; count < times; count += 1) sector.runAITick();
}

/** The exact chase heading `runMonsterTick` computes for a target-center delta. */
const chaseHeading = (dx: number, dy: number) => headingFromVector(dx, dy);

describe('NPC dialog branches', () => {
  it('emit fires on first tick when targeting and in radius', async () => {
    const sector = actor({ npcs: [makeNPC({ x: 0, y: 0 }, 'Hello, $name.\n---\nFollow up.')] });
    const alice = attach(sector, 'alice', { x: 1, y: 1 });
    sector.handleBumpNPC(1, alice.entityIndex);
    const digest = sector.runAITick();
    expect(serverSays(await collectMessages(alice.outbox))).toContain('Hello, alice.');
    expect(digest.dialogUpserts).toEqual([{ sectorName: 'TestSector', npcIndex: 1, scriptStep: 2 }]);
    expect(digest.dialogResets).toEqual([]);
  });

  it('wraps after the final step and clears targeting', () => {
    const sector = actor({ npcs: [makeNPC({ x: 0, y: 0 }, 'Step one.\n---\nStep two.')] });
    const alice = attach(sector, 'alice', { x: 1, y: 1 });
    sector.handleBumpNPC(1, alice.entityIndex);
    sector.runAITick();
    tick(sector, 59);
    const finalDigest = sector.runAITick();
    expect(finalDigest.dialogResets.length).toBe(1);
    expect(finalDigest.dialogUpserts).toEqual([]);
    const idle = sector.runAITick();
    expect(idle.dialogUpserts).toEqual([]);
    expect(idle.dialogResets).toEqual([]);
  });

  it('out of radius branch resets the cursor and emits a digest reset', () => {
    const sector = actor({
      dimensions: { width: 8, height: 8 },
      npcs: [makeNPC({ x: 0, y: 0 }, 'first.\n---\nsecond.\n---\nthird.')],
    });
    const alice = attach(sector, 'alice', { x: 1, y: 1 });
    sector.handleBumpNPC(1, alice.entityIndex);
    sector.runAITick();
    sector.handlePosition({ entityIndex: 0, x: 800, y: 800, facing: headingFromCardinal('south'), tempo: TEMPO.default }, alice.entityIndex);
    const digest = sector.runAITick();
    expect(digest.dialogResets).toEqual([1]);
    expect(digest.dialogUpserts).toEqual([]);
    const idle = sector.runAITick();
    expect(idle.dialogResets).toEqual([]);
    expect(idle.dialogUpserts).toEqual([]);
  });

  it('target leaving the sector resets the cursor and emits a digest reset', () => {
    const sector = actor({ npcs: [makeNPC({ x: 0, y: 0 }, 'first.\n---\nsecond.')] });
    const alice = attach(sector, 'alice', { x: 1, y: 1 });
    sector.handleBumpNPC(1, alice.entityIndex);
    sector.runAITick();
    sector.detach(alice.entityIndex, false);
    expect(sector.runAITick().dialogResets.length).toBe(1);
    expect(sector.runAITick().dialogResets).toEqual([]);
  });

  it('in radius below cooldown advances ticks without emitting', async () => {
    const sector = actor({ npcs: [makeNPC({ x: 0, y: 0 }, 'step.\n---\nstep two.')] });
    const alice = attach(sector, 'alice', { x: 1, y: 1 });
    sector.handleBumpNPC(1, alice.entityIndex);
    sector.runAITick();
    for (let count = 0; count < 59; count += 1) {
      const digest = sector.runAITick();
      expect(digest.dialogUpserts).toEqual([]);
      expect(digest.dialogResets).toEqual([]);
    }
    expect(sector.runAITick().dialogResets.length).toBe(1);
    const says = serverSays(await collectMessages(alice.outbox));
    expect(says).toEqual(['step.', 'step two.']);
  });
});

describe('cursor seeding', () => {
  it('stale persisted cursor clamps to step 1 on init', async () => {
    const sector = actor({ npcs: [makeNPC({ x: 0, y: 0 }, 'first.\n---\nsecond.\n---\nthird.')] }, { initialDialogCursors: new Map([[1, 7]]) });
    const alice = attach(sector, 'alice', { x: 1, y: 1 });
    sector.handleBumpNPC(1, alice.entityIndex);
    const digest = sector.runAITick();
    expect(serverSays(await collectMessages(alice.outbox))).toContain('first.');
    expect(digest.dialogUpserts[0]?.scriptStep).toBe(2);
  });

  it.each([0, -1, -32_768])('out of range persisted cursor %i clamps without trapping', async (persisted) => {
    const sector = actor({ npcs: [makeNPC({ x: 0, y: 0 }, 'first.\n---\nsecond.\n---\nthird.')] }, { initialDialogCursors: new Map([[1, persisted]]) });
    const alice = attach(sector, 'alice', { x: 1, y: 1 });
    sector.handleBumpNPC(1, alice.entityIndex);
    sector.runAITick();
    expect(serverSays(await collectMessages(alice.outbox))).toContain('first.');
  });

  it('empty script with a persisted cursor takes the no-op branch on emit', async () => {
    const sector = actor({ npcs: [makeNPC({ x: 0, y: 0 }, '')] }, { initialDialogCursors: new Map([[1, 3]]) });
    const alice = attach(sector, 'alice', { x: 1, y: 1 });
    sector.handleBumpNPC(1, alice.entityIndex);
    const digest = sector.runAITick();
    expect(serverSays(await collectMessages(alice.outbox))).toEqual([]);
    expect(digest.dialogUpserts).toEqual([]);
    expect(digest.dialogResets).toEqual([]);
  });
});

describe('monster aggro and chase', () => {
  const chaseWorld = (aiScriptIndex = 0, collisionMasks: CollisionMask[] = []): World => ({
    dimensions: { width: 4, height: 4 },
    monsterSpawns: [makeMonsterSpawn({ x: 200, y: 200 }, aiScriptIndex)],
    collisionMasks,
  });

  it('branch zero monster moves toward an in-radius player', async () => {
    const sector = actor(chaseWorld(), { monsterSpawnThreshold: 0 });
    const alice = attach(sector, 'alice', { x: 250, y: 250 });
    sector.runAITick();
    const frame = serverPositions(await collectMessages(alice.outbox))[0]!;
    expect(frame.x).toBeGreaterThan(200);
    expect(frame.y).toBeGreaterThan(200);
    expect(frame.facing).toBe(chaseHeading(50, 50));
  });

  it('branch zero monster idles when no player is in radius', async () => {
    const sector = actor({ dimensions: { width: 8, height: 8 }, monsterSpawns: [makeMonsterSpawn({ x: 0, y: 0 })] }, { monsterSpawnThreshold: 0 });
    const alice = attach(sector, 'alice', { x: 900, y: 900 });
    sector.runAITick();
    expect(serverPositions(await collectMessages(alice.outbox))).toEqual([]);
  });

  it('attaching after a chase delivers the post-tick monster facing in the entity frame', async () => {
    const sector = actor(chaseWorld(), { monsterSpawnThreshold: 0 });
    attach(sector, 'alice', { x: 100, y: 100 });
    sector.runAITick();
    const bob = attach(sector, 'bob', { x: 0, y: 0 });
    const monster = entities(await collectMessages(bob.outbox)).find((entity) => entity.type === WIRE_ENTITY_TYPE.monster);
    expect(monster?.facing).toBe(chaseHeading(-100, -100));
  });

  it.each([true, false])('targets the nearest in-radius player regardless of attach order (closer first: %s)', async (closerFirst) => {
    const sector = actor(chaseWorld(), { monsterSpawnThreshold: 0 });
    let alice: ReturnType<typeof attach>;
    if (closerFirst) {
      alice = attach(sector, 'alice', { x: 320, y: 200 });
      attach(sector, 'bob', { x: 50, y: 200 });
    } else {
      attach(sector, 'bob', { x: 50, y: 200 });
      alice = attach(sector, 'alice', { x: 320, y: 200 });
    }
    sector.runAITick();
    const frame = serverPositions(await collectMessages(alice.outbox))[0]!;
    expect(frame.facing).toBe(chaseHeading(120, 0));
  });

  it('blocked by the sector edge broadcasts facing without moving', async () => {
    const sector = actor({ dimensions: { width: 4, height: 2 }, monsterSpawns: [makeMonsterSpawn({ x: 48, y: 208 })] }, { monsterSpawnThreshold: 0 });
    const alice = attach(sector, 'alice', { x: 48, y: 260 });
    sector.runAITick();
    const frame = serverPositions(await collectMessages(alice.outbox))[0]!;
    expect(frame).toMatchObject({ x: 48, y: 208, facing: headingFromCardinal('south') });
  });

  it('blocked by collision broadcasts facing without moving', async () => {
    const sector = actor(chaseWorld(0, [{ x: 232, y: 248, width: 2, height: 2 }]), {
      monsterSpawnThreshold: 0,
    });
    const alice = attach(sector, 'alice', { x: 250, y: 250 });
    sector.runAITick();
    const frame = serverPositions(await collectMessages(alice.outbox))[0]!;
    expect(frame).toMatchObject({ x: 200, y: 200, facing: chaseHeading(50, 50) });
  });

  it('non-zero AI script index monster idles even when a player is in radius', async () => {
    const sector = actor(chaseWorld(1), { monsterSpawnThreshold: 0 });
    const alice = attach(sector, 'alice', { x: 250, y: 250 });
    tick(sector, 5);
    expect(serverPositions(await collectMessages(alice.outbox))).toEqual([]);
  });
});

describe('monster spawn cadence', () => {
  it('the default monster spawn threshold is the faithful 1199 ticks', () => {
    expect(DEFAULT_MONSTER_SPAWN_THRESHOLD).toBe(1199);
  });

  it('no monster exists at boot', async () => {
    const sector = actor({
      dimensions: { width: 4, height: 4 },
      monsterSpawns: [makeMonsterSpawn({ x: 200, y: 200 })],
    });
    const alice = attach(sector, 'alice', { x: 10, y: 10 });
    const spawned = entities(await collectMessages(alice.outbox)).filter((entity) => entity.type === WIRE_ENTITY_TYPE.monster);
    expect(spawned).toEqual([]);
  });

  it('a monster spawns on the tick the timer reaches the threshold, not before', async () => {
    const threshold = 3;
    const monsterCount = async (ticks: number) => {
      const sector = actor(
        { dimensions: { width: 8, height: 8 }, monsterSpawns: [makeMonsterSpawn({ x: 200, y: 200 })] },
        { monsterSpawnThreshold: threshold },
      );
      const alice = attach(sector, 'alice', { x: 900, y: 900 });
      tick(sector, ticks);
      return entities(await collectMessages(alice.outbox)).filter((entity) => entity.type === WIRE_ENTITY_TYPE.monster).length;
    };
    expect(await monsterCount(threshold)).toBe(0);
    expect(await monsterCount(threshold + 1)).toBe(1);
  });

  it('the sector never exceeds the live monster cap', async () => {
    const sector = actor(
      { dimensions: { width: 8, height: 8 }, monsterSpawns: [makeMonsterSpawn({ x: 200, y: 200 }, 0, 768)] },
      { monsterSpawnThreshold: 0, random: seededRandom(7) },
    );
    const alice = attach(sector, 'alice', { x: 900, y: 900 });
    tick(sector, 10);
    const indices = new Set(
      entities(await collectMessages(alice.outbox))
        .filter((entity) => entity.type === WIRE_ENTITY_TYPE.monster)
        .map((entity) => entity.entityIndex),
    );
    expect(indices.size).toBe(SOMNIO_CONSTANTS.perSectorMonsterCap);
  });

  it('a spawned monster is placed clear of static masks', async () => {
    const mask = { x: 200, y: 232, width: 32, height: 16 };
    const sector = actor(
      {
        dimensions: { width: 4, height: 4 },
        monsterSpawns: [makeMonsterSpawn({ x: 200, y: 200 }, 0, 256)],
        collisionMasks: [mask],
      },
      { monsterSpawnThreshold: 0 },
    );
    const alice = attach(sector, 'alice', { x: 10, y: 10 });
    sector.runAITick();
    const monster = entities(await collectMessages(alice.outbox)).find((entity) => entity.type === WIRE_ENTITY_TYPE.monster)!;
    const feet = feetRect({ x: monster.x, y: monster.y }, { width: monster.maskWidth, height: monster.maskHeight });
    expect(intersects(feet, [mask])).toBe(false);
  });

  it('a fully blocked spawn box keeps the timer armed and spawns once a cell frees', async () => {
    const sector = actor({ dimensions: { width: 8, height: 8 }, monsterSpawns: [makeMonsterSpawn({ x: 200, y: 200 })] }, { monsterSpawnThreshold: 2 });
    const observer = attach(sector, 'observer', { x: 900, y: 900 }, 4096);
    const blocker = attach(sector, 'blocker', { x: 200, y: 200 });
    tick(sector, 3);
    sector.detach(blocker.entityIndex, false);
    sector.runAITick();
    const spawned = entities(await collectMessages(observer.outbox)).filter((entity) => entity.type === WIRE_ENTITY_TYPE.monster);
    expect(spawned.length).toBe(1);
  });

  it('a spawned monster entity is broadcast to an already-attached player', async () => {
    const sector = actor({ dimensions: { width: 4, height: 4 }, monsterSpawns: [makeMonsterSpawn({ x: 200, y: 200 })] }, { monsterSpawnThreshold: 0 });
    const alice = attach(sector, 'alice', { x: 10, y: 10 });
    sector.runAITick();
    expect(entities(await collectMessages(alice.outbox)).some((entity) => entity.type === WIRE_ENTITY_TYPE.monster)).toBe(true);
  });
});

describe('combat carve-out', () => {
  it('monster combat is inert across two hundred ticks', async () => {
    const sector = actor({ dimensions: { width: 4, height: 4 }, monsterSpawns: [makeMonsterSpawn({ x: 200, y: 200 })] }, { monsterSpawnThreshold: 0 });
    const alice = attach(sector, 'alice', { x: 250, y: 250 }, 4096);
    tick(sector, 200);
    const messages = await collectMessages(alice.outbox);
    expect(serverSays(messages).filter((text) => text.toLowerCase().includes('dmg'))).toEqual([]);
    expect(messages.filter((message) => message.tag === 'leave')).toEqual([]);
  });
});

describe('player move gate vs monsters', () => {
  it("handlePosition accepts a player move onto a monster's feet box", async () => {
    const sector = actor({ dimensions: { width: 4, height: 4 }, monsterSpawns: [makeMonsterSpawn({ x: 200, y: 200 })] }, { monsterSpawnThreshold: 0 });
    const alice = attach(sector, 'alice', { x: 10, y: 10 });
    sector.runAITick();
    sector.handlePosition({ entityIndex: 0, x: 200, y: 200, facing: headingFromCardinal('south'), tempo: TEMPO.default }, alice.entityIndex);
    expect(sector.snapshotForPlayer(alice.entityIndex)?.character.position).toEqual({ x: 200, y: 200 });
    const snapped = serverPositions(await collectMessages(alice.outbox)).some((frame) => frame.entityIndex === alice.entityIndex);
    expect(snapped).toBe(false);
  });

  it('handlePosition accepts an implausibly far teleport without snapping back (observe-only)', async () => {
    const sector = actor({ dimensions: { width: 4, height: 4 } });
    const alice = attach(sector, 'alice', { x: 10, y: 10 });
    sector.handlePosition({ entityIndex: 0, x: 400, y: 400, facing: headingFromCardinal('south'), tempo: TEMPO.run }, alice.entityIndex);
    expect(sector.snapshotForPlayer(alice.entityIndex)?.character.position).toEqual({ x: 400, y: 400 });
    const snapped = serverPositions(await collectMessages(alice.outbox)).some((frame) => frame.entityIndex === alice.entityIndex);
    expect(snapped).toBe(false);
  });
});

describe('entity index allocation', () => {
  it('resumes after the NPC indices', async () => {
    const sector = actor(
      {
        dimensions: { width: 4, height: 4 },
        npcs: [makeNPC({ x: 0, y: 0 }, ''), makeNPC({ x: 64, y: 0 }, '')],
        monsterSpawns: [makeMonsterSpawn({ x: 400, y: 400 }, 1)],
      },
      { monsterSpawnThreshold: 0 },
    );
    const alice = attach(sector, 'alice', { x: 10, y: 10 });
    expect(alice.entityIndex).toBe(3);
    sector.runAITick();
    const monsterIndices = entities(await collectMessages(alice.outbox))
      .filter((entity) => entity.type === WIRE_ENTITY_TYPE.monster)
      .map((entity) => entity.entityIndex);
    expect(monsterIndices).toEqual([4]);
  });

  it('starts at one for a sector with no NPCs', () => {
    expect(attach(actor(), 'alice', { x: 10, y: 10 }).entityIndex).toBe(1);
  });

  it('npcEntityIndices walks the skip-zero wrapping sequence', () => {
    expect(npcEntityIndices(3)).toEqual([1, 2, 3]);
    expect(npcEntityIndices(32_768).slice(-2)).toEqual([32_767, -32_768]);
  });
});
