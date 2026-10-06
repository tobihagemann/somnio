import { describe, expect, it } from 'vitest';
import { OUTDOOR_SPACE_ID, sectorPointInSpace } from '@somnio/core';
import type { NPCDialogState, Sector } from '@somnio/core';
import { ConnectionActor } from '../src/connection/connectionActor.ts';
import { collectOutbox } from '../src/connection/outbox.ts';
import { WorldRouter } from '../src/world/worldRouter.ts';
import { interiorSector } from '../../core/test/support/worldFixture.ts';
import { collectMessages, serverSays } from './support/frames.ts';
import { testLogger } from './support/logger.ts';
import { attachPlayer, makeNPC, makeSectorLine, makeWorld } from './support/sectorFactory.ts';
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
    // The two sectors are neighbours, so each player hears both guards, told apart by entity id.
    const says = (await collectMessages(west.outbox)).flatMap((message) => (message.tag === 'serverSay' ? [message.payload] : []));
    expect(says).toEqual([
      { entityId: 'npc:West/guard', text: 'second.' },
      { entityId: 'npc:Middle/guard', text: 'third.' },
    ]);
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
