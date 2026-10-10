import { describe, expect, it } from 'vitest';
import { OUTDOOR_SPACE_ID, sectorPointInSpace } from '@somnio/core';
import type { NPCDialogState, Sector } from '@somnio/core';
import { ConnectionActor } from '../src/connection/connectionActor.ts';
import { collectOutbox } from '../src/connection/outbox.ts';
import { WorldRouter } from '../src/world/worldRouter.ts';
import { interiorSector } from '../../core/test/support/worldFixture.ts';
import { collectMessages, serverSays } from './support/frames.ts';
import { testLogger } from './support/logger.ts';
import { payloads } from './support/combat.ts';
import { attachPlayer, makeDoor, makeNPC, makeSector, makeSectorLine, makeWorld } from './support/sectorFactory.ts';
import { makeStubConnectionDependencies } from './support/stubDependencies.ts';
import { RepositoryFailure, StubCharacterRepository, StubNPCDialogStateRepository } from './support/stubRepositories.ts';

class RecordingDialogRepository extends StubNPCDialogStateRepository {
  readonly upserted: NPCDialogState[] = [];
  readonly resets: Pick<NPCDialogState, 'sectorName' | 'npcId'>[] = [];
  readonly rows: NPCDialogState[];
  nextUpsertThrows = false;
  nextResetThrows = false;
  upsertCalls = 0;
  resetCalls = 0;

  constructor(rows: NPCDialogState[] = []) {
    super();
    this.rows = rows;
  }

  override loadAll(sectorName: string): Promise<NPCDialogState[]> {
    return Promise.resolve(this.rows.filter((row) => row.sectorName === sectorName));
  }

  override upsert(state: NPCDialogState): Promise<void> {
    this.upsertCalls += 1;
    if (this.nextUpsertThrows) {
      this.nextUpsertThrows = false;
      return Promise.reject(new RepositoryFailure());
    }
    this.upserted.push(state);
    return Promise.resolve();
  }

  override reset(sectorName: string, npcId: string): Promise<void> {
    this.resetCalls += 1;
    if (this.nextResetThrows) {
      this.nextResetThrows = false;
      return Promise.reject(new RepositoryFailure());
    }
    this.resets.push({ sectorName, npcId });
    return Promise.resolve();
  }
}

const guard = (dialogScript: string) => ({ npcs: [makeNPC('guard', { x: 5, z: 5 }, dialogScript)] });

async function routerOver(sectors: Sector[], dialogRepo = new RecordingDialogRepository()) {
  return WorldRouter.create(makeWorld(sectors), new StubCharacterRepository(), dialogRepo, testLogger());
}

/** Attaches a player beside the guard at (5, 5) of `sectorName` and talks to it. */
function talk(router: WorldRouter, sectorName: string, playerName: string) {
  const world = router.world;
  const spaceId = world.sectorSpace.get(sectorName)!;
  const sector = world.spaces.get(spaceId)!.sectors.find((candidate) => candidate.name === sectorName)!;
  const space = router.space(spaceId)!;
  const { outbox, entityId } = attachPlayer(space, sectorPointInSpace(sector, { x: 5, z: 6 }), playerName, { spaceId });
  space.handleTalk(`npc:${sectorName}/guard`, entityId);
  return { outbox, space, entityId };
}

async function tick(router: WorldRouter): Promise<void> {
  await router.persistDialogDigest(router.runTickAcrossSpaces(0.05));
}

async function emptyRouterConnections(count: number) {
  const dependencies = await makeStubConnectionDependencies();
  const router = dependencies.worldRouter;
  const connections = Array.from({ length: count }, () => ({
    actor: new ConnectionActor(dependencies),
    accountId: crypto.randomUUID(),
  }));
  return { router, connections };
}

describe('WorldRouter ticks', () => {
  it('persists the wrap reset of a script with one line after its greeting, and skips the empty-script no-op', async () => {
    const dialogRepo = new RecordingDialogRepository();
    const router = await routerOver([interiorSector('A', guard('hi.\n---\nbye $name.')), interiorSector('B', guard(''))], dialogRepo);
    talk(router, 'A', 'alice');
    talk(router, 'B', 'bob');
    await tick(router);
    expect(dialogRepo.upserted).toEqual([]);
    expect(dialogRepo.resets).toEqual([{ sectorName: 'A', npcId: 'guard' }]);
  });

  it('init pre-loads the persisted cursor from the repository', async () => {
    const dialogRepo = new RecordingDialogRepository([{ sectorName: 'A', npcId: 'guard', scriptStep: 3 }]);
    const router = await routerOver([interiorSector('A', guard('first line.\n---\nsecond line.\n---\nthird line.'))], dialogRepo);
    const { outbox } = talk(router, 'A', 'alice');
    router.runTickAcrossSpaces(0.05);
    expect(serverSays(await collectMessages(outbox))).toEqual(['third line.']);
  });

  /** Two outdoor NPCs live in one space and share the sector-local id: the row is keyed by the NPC's own sector. */
  it('persists dialog advance and reset under the own sector of two outdoor NPCs sharing a local id', async () => {
    const dialogRepo = new RecordingDialogRepository([{ sectorName: 'Middle', npcId: 'guard', scriptStep: 3 }]);
    const script = guard('first.\n---\nsecond.\n---\nthird.\n---\nfourth.');
    const router = await routerOver(makeSectorLine({ west: script, middle: script }), dialogRepo);
    const west = talk(router, 'West', 'alice');
    const middle = talk(router, 'Middle', 'bob');
    await tick(router);
    expect(dialogRepo.upserted).toEqual([
      { sectorName: 'West', npcId: 'guard', scriptStep: 3 },
      { sectorName: 'Middle', npcId: 'guard', scriptStep: 4 },
    ]);
    // The two sectors are neighbours, but the guards stand 20 m apart, past a said line's reach: each player hears the guard beside them.
    const says = (await collectMessages(west.outbox)).flatMap((message) => (message.tag === 'serverSay' ? [message.payload] : []));
    expect(says.map(({ entityId, text }) => ({ entityId, text }))).toEqual([{ entityId: 'npc:West/guard', text: 'second.' }]);
    middle.space.detach(middle.entityId, true);
    await tick(router);
    expect(dialogRepo.resets).toEqual([{ sectorName: 'Middle', npcId: 'guard' }]);
  });

  it('tolerates a transient upsert failure', async () => {
    const dialogRepo = new RecordingDialogRepository();
    dialogRepo.nextUpsertThrows = true;
    const router = await routerOver([interiorSector('A', guard('first.\n---\nsecond.\n---\nthird.'))], dialogRepo);
    talk(router, 'A', 'alice');
    await tick(router);
    await tick(router);
    expect(dialogRepo.upsertCalls).toBeGreaterThanOrEqual(1);
  });

  it('tolerates a transient reset failure', async () => {
    const dialogRepo = new RecordingDialogRepository();
    dialogRepo.nextResetThrows = true;
    const router = await routerOver([interiorSector('A', guard('Hi.\n---\nOnce: $name.'))], dialogRepo);
    talk(router, 'A', 'alice');
    await tick(router);
    await tick(router);
    expect(dialogRepo.resetCalls).toBeGreaterThanOrEqual(1);
  });

  it('one space holds every outdoor sector and each interior is a space of its own', async () => {
    const router = await routerOver([...makeSectorLine(), interiorSector('Hall')]);
    expect(router.space(OUTDOOR_SPACE_ID)).toBeDefined();
    expect(router.space('Hall')).toBeDefined();
    expect(router.space('West')).toBeUndefined();
  });
});

describe('WorldRouter speech', () => {
  const YELL = { text: 'Hilfe, hier drüben bei der Tür!', kind: 'yell' } as const;
  /** Where a body comes out of a room's door, 0.8 m in from its doorway at (5, 8). */
  const ROOM_ARRIVAL = { x: 5, z: 7.2 };

  /** A 100 m yard with a door into room `A` at (40, 10) and one into room `B` at (50, 10). */
  async function yard() {
    const toA = makeDoor('to-a', { x: 40, z: 10 }, { sector: 'A', door: 'exit' });
    const toB = makeDoor('to-b', { x: 50, z: 10 }, { sector: 'B', door: 'exit' });
    const room = (name: string, door: string) => interiorSector(name, makeDoor('exit', { x: 5, z: 8 }, { sector: 'Yard', door }));
    const router = await routerOver([
      makeSector('Yard', { size: { width: 100, depth: 20 }, placements: [...toA.placements, ...toB.placements], doors: [...toA.doors, ...toB.doors] }),
      room('A', 'to-a'),
      room('B', 'to-b'),
    ]);
    const join = (spaceId: string, at: { x: number; z: number }) => ({ spaceId, ...attachPlayer(router.space(spaceId)!, at, 'tester', { spaceId }) });
    return { router, join };
  }

  async function heard(outbox: Parameters<typeof collectMessages>[0]) {
    return payloads(await collectMessages(outbox), 'serverSay');
  }

  it('carries a yell near a door into the room beyond it, crumbled and coming from its doorway', async () => {
    const { router, join } = await yard();
    const yeller = join(OUTDOOR_SPACE_ID, { x: 30, z: 10 });
    const inside = join('A', { x: 5, z: 6 });

    router.say(OUTDOOR_SPACE_ID, yeller.entityId, YELL);

    const lines = await heard(inside.outbox);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ name: 'tester', kind: 'yell', clarity: 0.6, x: 5, z: 8 });
    expect(lines[0]!.entityId).toBe(yeller.entityId);
    expect(lines[0]!.text).toContain('...');
  });

  /**
   * Both listeners are 62 m along: one outdoors, one 16 + 44 + 2 m through the door. They hear six
   * of the ten words missing; were each crumble rolled afresh, the same six would go once in 210.
   */
  it('crumbles a yell through a door from the same rolls as outdoors', async () => {
    const { router, join } = await yard();
    const yeller = join(OUTDOOR_SPACE_ID, { x: 24, z: 10 });
    const outside = join(OUTDOOR_SPACE_ID, { x: 86, z: 10 });
    const inside = join('A', { x: 5, z: 6 });

    router.say(OUTDOOR_SPACE_ID, yeller.entityId, { text: 'eins zwei drei vier fünf sechs sieben acht neun zehn', kind: 'yell' });

    const [outdoors] = await heard(outside.outbox);
    const [indoors] = await heard(inside.outbox);
    expect(indoors!.clarity).toBeCloseTo(outdoors!.clarity, 12);
    expect(indoors!.text).toContain('...');
    expect(indoors!.text).toBe(outdoors!.text);
  });

  it('carries no yell from beyond its reach of the door, and no line said plainly', async () => {
    const { router, join } = await yard();
    const distant = join(OUTDOOR_SPACE_ID, { x: 80, z: 10 });
    const plain = join(OUTDOOR_SPACE_ID, { x: 40, z: 10.5 });
    const inside = join('A', { x: 5, z: 6 });

    router.say(OUTDOOR_SPACE_ID, distant.entityId, YELL);
    router.say(OUTDOOR_SPACE_ID, plain.entityId, { text: 'Hallo?', kind: 'say' });

    expect(await heard(inside.outbox)).toEqual([]);
  });

  /** From the yard's doorway, the way on into `B` would be 10 + 44 + 1 m, inside a yell's reach. */
  it('carries a yell one door and no further, to each listener once', async () => {
    const { router, join } = await yard();
    const yeller = join('A', { x: 5, z: 7 });
    const outside = [join(OUTDOOR_SPACE_ID, { x: 40, z: 11 }), join(OUTDOOR_SPACE_ID, { x: 41, z: 9 })];
    const beyond = join('B', { x: 5, z: 7 });

    router.say('A', yeller.entityId, YELL);

    for (const listener of outside) expect(await heard(listener.outbox)).toMatchObject([{ kind: 'yell', x: 40, z: 10 }]);
    expect(await heard(yeller.outbox)).toEqual([]);
    expect(await heard(beyond.outbox)).toEqual([]);
  });

  it('puts the voice in the doorway, not where an arriving body stands', async () => {
    const { router, join } = await yard();
    const yeller = join(OUTDOOR_SPACE_ID, { x: 38, z: 10 });
    const arrived = join('A', ROOM_ARRIVAL);

    router.say(OUTDOOR_SPACE_ID, yeller.entityId, YELL);

    const [line] = await heard(arrived.outbox);
    expect({ x: line!.x, z: line!.z }).not.toEqual(ROOM_ARRIVAL);
  });

  /** The way through the far door, 32 + 44 + 1.5 m, is in a yell's reach too, but longer than 2 + 44 + 6.2 m through the near one. */
  it('carries a yell into a room with two doors by the shorter way', async () => {
    const near = makeDoor('to-a-1', { x: 40, z: 10 }, { sector: 'A', door: 'exit-1' });
    const far = makeDoor('to-a-2', { x: 70, z: 10 }, { sector: 'A', door: 'exit-2' });
    const exits = [
      makeDoor('exit-1', { x: 2, z: 8 }, { sector: 'Yard', door: 'to-a-1' }),
      makeDoor('exit-2', { x: 8, z: 8 }, { sector: 'Yard', door: 'to-a-2' }),
    ];
    const router = await routerOver([
      makeSector('Yard', { size: { width: 100, depth: 20 }, placements: [...near.placements, ...far.placements], doors: [...near.doors, ...far.doors] }),
      interiorSector('A', { placements: exits.flatMap((exit) => exit.placements), doors: exits.flatMap((exit) => exit.doors) }),
    ]);
    const yeller = attachPlayer(router.space(OUTDOOR_SPACE_ID)!, { x: 38, z: 10 }, 'yeller');
    const inside = attachPlayer(router.space('A')!, { x: 8, z: 6.5 }, 'inside', { spaceId: 'A' });

    router.say(OUTDOOR_SPACE_ID, yeller.entityId, YELL);

    expect(await heard(inside.outbox)).toMatchObject([{ x: 2, z: 8 }]);
  });

  /** A door pair within the one outdoor space carries no voice: everyone it could reach already hears the yell itself. */
  it('carries no second copy of a yell through a door pair within its own space', async () => {
    const east = makeDoor('east', { x: 40, z: 10 }, { sector: 'Yard', door: 'west' });
    const west = makeDoor('west', { x: 60, z: 10 }, { sector: 'Yard', door: 'east' });
    const router = await routerOver([
      makeSector('Yard', { size: { width: 100, depth: 20 }, placements: [...east.placements, ...west.placements], doors: [...east.doors, ...west.doors] }),
    ]);
    expect(router.world.spaces.get(OUTDOOR_SPACE_ID)!.sectors[0]!.doors).toHaveLength(2);
    const space = router.space(OUTDOOR_SPACE_ID)!;
    const yeller = attachPlayer(space, { x: 38, z: 10 }, 'yeller');
    const listener = attachPlayer(space, { x: 62, z: 10 }, 'listener');

    router.say(OUTDOOR_SPACE_ID, yeller.entityId, YELL);

    expect(await heard(listener.outbox)).toMatchObject([{ x: 38, z: 10 }]);
    expect(await heard(yeller.outbox)).toEqual([]);
  });
});

describe('WorldRouter connections', () => {
  it('broadcastToAllConnections fans out an identical frame to every attached connection', async () => {
    const { router, connections } = await emptyRouterConnections(2);
    for (const { actor, accountId } of connections) {
      router.register(actor, accountId);
      actor.markAttached('player', 'X', accountId);
    }
    router.broadcastToAllConnections({ tag: 'adminSay', payload: { text: 'restart at noon' } });
    const frames = await Promise.all(
      connections.map(({ actor }) => {
        actor.outbox.finish();
        return collectOutbox(actor.outbox);
      }),
    );
    expect(frames[0]!.length).toBe(1);
    expect(frames[1]!.length).toBe(1);
    expect(frames[0]![0]).toBe(frames[1]![0]);
  });

  it('broadcastToAllConnections skips connections still awaiting login', async () => {
    const { router, connections } = await emptyRouterConnections(1);
    const { actor, accountId } = connections[0]!;
    router.register(actor, accountId);
    router.broadcastToAllConnections({ tag: 'adminSay', payload: { text: 'restart at noon' } });
    actor.outbox.finish();
    expect(await collectOutbox(actor.outbox)).toEqual([]);
  });

  it('loggedInPlayerCount counts only attached connections', async () => {
    const { router, connections } = await emptyRouterConnections(2);
    const [attached, unattached] = connections;
    router.register(attached!.actor, attached!.accountId);
    router.register(unattached!.actor, unattached!.accountId);
    attached!.actor.markAttached('player', 'X', attached!.accountId);
    expect(router.loggedInPlayerCount()).toBe(1);
  });

  it('register refuses a second connection for the same account', async () => {
    const { router, connections } = await emptyRouterConnections(2);
    const accountId = crypto.randomUUID();
    expect(router.register(connections[0]!.actor, accountId)).toBe(true);
    expect(router.register(connections[1]!.actor, accountId)).toBe(false);
  });

  it('kickByCharacterName returns false when nobody matches', async () => {
    const { router, connections } = await emptyRouterConnections(1);
    router.register(connections[0]!.actor, connections[0]!.accountId);
    router.nameRegistered(connections[0]!.accountId, 'Alice');
    expect(router.kickByCharacterName('Bob')).toBe(false);
  });

  /** Between the account's registration and its character being read, there is no name to match. */
  it('kickByCharacterName matches no connection whose character is not loaded yet', async () => {
    const { router, connections } = await emptyRouterConnections(1);
    router.register(connections[0]!.actor, connections[0]!.accountId);
    expect(router.kickByCharacterName('undefined')).toBe(false);
    expect(router.kickByCharacterName('')).toBe(false);
  });

  it('kickByCharacterName normalizes case to match the schema collation', async () => {
    const { router, connections } = await emptyRouterConnections(1);
    router.register(connections[0]!.actor, connections[0]!.accountId);
    router.nameRegistered(connections[0]!.accountId, 'Saibot');
    expect(router.kickByCharacterName('saibot')).toBe(true);
  });

  it('kickByCharacterName matches NFKC compatibility equivalent names', async () => {
    const { router, connections } = await emptyRouterConnections(1);
    router.register(connections[0]!.actor, connections[0]!.accountId);
    router.nameRegistered(connections[0]!.accountId, 'Ｓａｉｂｏｔ');
    expect(router.kickByCharacterName('saibot')).toBe(true);
  });
});
