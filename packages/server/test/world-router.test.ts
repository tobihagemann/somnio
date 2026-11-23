import { afterEach, describe, expect, it, vi } from 'vitest';
import { OUTDOOR_SPACE_ID, boardTurnsAt, bountyIdOf, bountyLands, dayBounties } from '@somnio/core';
import type { Sector } from '@somnio/core';
import type { SomnioMessage } from '@somnio/protocol';
import { STARTER_SECTOR } from '@somnio/data';
import { ConnectionActor } from '../src/connection/connectionActor.ts';
import { collectOutbox } from '../src/connection/outbox.ts';
import { WorldRouter } from '../src/world/worldRouter.ts';
import { interiorSector } from '../../core/test/support/worldFixture.ts';
import { DAY } from './support/bountyBoard.ts';
import { collectMessages, recordingOutbox } from './support/frames.ts';
import { testLogger } from './support/logger.ts';
import { BESIDE_GHOST, CUDGEL, GHOST_AT, RESPAWN_MS, STRIKER, attackGhost, payloads, wearing } from './support/combat.ts';
import { attachPlayer, makeDoor, makeMonsterSpawn, makeSector, makeSectorLine, makeWorld } from './support/sectorFactory.ts';
import { makeStubConnectionDependencies } from './support/stubDependencies.ts';
import { StubCharacterRepository } from './support/stubRepositories.ts';

function routerOver(sectors: Sector[]) {
  return WorldRouter.create(makeWorld(sectors), new StubCharacterRepository(), testLogger());
}

function emptyRouterConnections(count: number, sectors: Sector[] = []) {
  const dependencies = makeStubConnectionDependencies({ sectors });
  const router = dependencies.worldRouter;
  const connections = Array.from({ length: count }, () => ({
    actor: new ConnectionActor(dependencies),
    accountId: crypto.randomUUID(),
  }));
  return { router, connections };
}

describe('WorldRouter ticks', () => {
  it('one space holds every outdoor sector and each interior is a space of its own', () => {
    const router = routerOver([...makeSectorLine(), interiorSector('Hall')]);
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
  function yard() {
    const toA = makeDoor('to-a', { x: 40, z: 10 }, { sector: 'A', door: 'exit' });
    const toB = makeDoor('to-b', { x: 50, z: 10 }, { sector: 'B', door: 'exit' });
    const room = (name: string, door: string) => interiorSector(name, makeDoor('exit', { x: 5, z: 8 }, { sector: 'Yard', door }));
    const router = routerOver([
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
    const { router, join } = yard();
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
    const { router, join } = yard();
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
    const { router, join } = yard();
    const distant = join(OUTDOOR_SPACE_ID, { x: 80, z: 10 });
    const plain = join(OUTDOOR_SPACE_ID, { x: 40, z: 10.5 });
    const inside = join('A', { x: 5, z: 6 });

    router.say(OUTDOOR_SPACE_ID, distant.entityId, YELL);
    router.say(OUTDOOR_SPACE_ID, plain.entityId, { text: 'Hallo?', kind: 'say' });

    expect(await heard(inside.outbox)).toEqual([]);
  });

  /** From the yard's doorway, the way on into `B` would be 10 + 44 + 1 m, inside a yell's reach. */
  it('carries a yell one door and no further, to each listener once', async () => {
    const { router, join } = yard();
    const yeller = join('A', { x: 5, z: 7 });
    const outside = [join(OUTDOOR_SPACE_ID, { x: 40, z: 11 }), join(OUTDOOR_SPACE_ID, { x: 41, z: 9 })];
    const beyond = join('B', { x: 5, z: 7 });

    router.say('A', yeller.entityId, YELL);

    for (const listener of outside) expect(await heard(listener.outbox)).toMatchObject([{ kind: 'yell', x: 40, z: 10 }]);
    expect(await heard(yeller.outbox)).toEqual([]);
    expect(await heard(beyond.outbox)).toEqual([]);
  });

  it('puts the voice in the doorway, not where an arriving body stands', async () => {
    const { router, join } = yard();
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
    const router = routerOver([
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
    const router = routerOver([
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
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('broadcastToAllConnections fans out an identical frame to every attached connection', async () => {
    const { router, connections } = emptyRouterConnections(2);
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
    const { router, connections } = emptyRouterConnections(1);
    const { actor, accountId } = connections[0]!;
    router.register(actor, accountId);
    router.broadcastToAllConnections({ tag: 'adminSay', payload: { text: 'restart at noon' } });
    actor.outbox.finish();
    expect(await collectOutbox(actor.outbox)).toEqual([]);
  });

  it('loggedInPlayerCount counts only attached connections', () => {
    const { router, connections } = emptyRouterConnections(2);
    const [attached, unattached] = connections;
    router.register(attached!.actor, attached!.accountId);
    router.register(unattached!.actor, unattached!.accountId);
    attached!.actor.markAttached('player', 'X', attached!.accountId);
    expect(router.loggedInPlayerCount()).toBe(1);
  });

  it('register refuses a second connection for the same account', () => {
    const { router, connections } = emptyRouterConnections(2);
    const accountId = crypto.randomUUID();
    expect(router.register(connections[0]!.actor, accountId)).toBe(true);
    expect(router.register(connections[1]!.actor, accountId)).toBe(false);
  });

  /** The space runs on the faked `performance` clock here, and on rolls of 0, so a Fighter's three swings drive the Ghost off and leave them a drop. */
  it("unregister takes away the drops lying for the account's character in the world, and none for an account still choosing", () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { router, connections } = emptyRouterConnections(2, [makeSector('TestSector', { monsterSpawns: [makeMonsterSpawn(GHOST_AT)] })]);
    const [playing, choosing] = connections;
    const space = router.space(OUTDOOR_SPACE_ID)!;
    vi.advanceTimersByTime(RESPAWN_MS);
    space.step(0);
    const striker = recordingOutbox();
    const { character, entityId } = attachPlayer(space, BESIDE_GHOST, 'striker', { outbox: striker.outbox, character: STRIKER, inventory: wearing(CUDGEL) });
    router.register(playing!.actor, playing!.accountId);
    router.register(choosing!.actor, choosing!.accountId);
    router.characterJoined(playing!.accountId, character);
    attackGhost(space, entityId);
    for (let swing = 0; swing < 3; swing += 1) {
      space.step(0);
      vi.advanceTimersByTime(1000);
    }
    const [drop] = payloads(striker.sent, 'loot');
    expect(drop).toBeDefined();

    router.unregister(choosing!.accountId);
    expect(payloads(striker.sent, 'lootGone')).toEqual([]);
    const { checkpoint } = space.handOver(entityId, true)!;
    router.unregister(playing!.accountId);
    const back = recordingOutbox();
    space.attach(checkpoint.character, checkpoint.inventory, back.outbox, 0, 'en');
    space.handlePickUp(drop!.lootId, entityId);
    expect([payloads(back.sent, 'loot'), payloads(back.sent, 'inventory').flatMap(({ pickedUp }) => pickedUp ?? [])]).toEqual([[], []]);
  });

  it('kickByCharacterName returns false when nobody matches', () => {
    const { router, connections } = emptyRouterConnections(1);
    router.register(connections[0]!.actor, connections[0]!.accountId);
    router.characterJoined(connections[0]!.accountId, { id: crypto.randomUUID(), name: 'Alice' });
    expect(router.kickByCharacterName('Bob')).toBe(false);
  });

  /** Between the account's registration and its character being read, there is no name to match. */
  it('kickByCharacterName matches no connection whose character is not loaded yet', () => {
    const { router, connections } = emptyRouterConnections(1);
    router.register(connections[0]!.actor, connections[0]!.accountId);
    expect(router.kickByCharacterName('undefined')).toBe(false);
    expect(router.kickByCharacterName('')).toBe(false);
  });

  it('kickByCharacterName normalizes case to match the schema collation', () => {
    const { router, connections } = emptyRouterConnections(1);
    router.register(connections[0]!.actor, connections[0]!.accountId);
    router.characterJoined(connections[0]!.accountId, { id: crypto.randomUUID(), name: 'Saibot' });
    expect(router.kickByCharacterName('saibot')).toBe(true);
  });

  /** Postgres lowercases `İ` to `i`, so the column holds one account under both spellings. */
  it('kickByCharacterName folds İ as the schema collation does', () => {
    const { router, connections } = emptyRouterConnections(1);
    router.register(connections[0]!.actor, connections[0]!.accountId);
    router.characterJoined(connections[0]!.accountId, { id: crypto.randomUUID(), name: 'tobias' });
    expect(router.kickByCharacterName('TOBİAS')).toBe(true);
  });

  it('kickByCharacterName matches NFKC compatibility equivalent names', () => {
    const { router, connections } = emptyRouterConnections(1);
    router.register(connections[0]!.actor, connections[0]!.accountId);
    router.characterJoined(connections[0]!.accountId, { id: crypto.randomUUID(), name: 'Ｓａｉｂｏｔ' });
    expect(router.kickByCharacterName('saibot')).toBe(true);
  });
});

describe('WorldRouter board day', () => {
  it("turns the board in every space on one step across 00:00 UTC, telling each dreamer the new day's bounties", () => {
    const wall = { ms: boardTurnsAt(DAY) - 1 };
    const world = makeWorld([makeSector('Meadow', { monsterSpawns: [makeMonsterSpawn({ x: 2, z: 2 })] })]);
    const router = WorldRouter.create(world, new StubCharacterRepository(), testLogger(), undefined, undefined, () => wall.ms);
    const offered = (day: number) => dayBounties(day, bountyLands([...router.world.spaces.values()].flatMap((space) => space.sectors)));
    const outside = recordingOutbox();
    const inside = recordingOutbox();
    const bounty = offered(DAY)[0]!;
    attachPlayer(router.space(OUTDOOR_SPACE_ID)!, { x: 10, z: 10 }, 'alice', {
      outbox: outside.outbox,
      character: { quests: { active: [], done: [bountyIdOf(bounty)] } },
    });
    attachPlayer(router.space(STARTER_SECTOR)!, { x: 5, z: 6 }, 'bob', {
      outbox: inside.outbox,
      spaceId: STARTER_SECTOR,
      character: { quests: { active: [{ questId: bountyIdOf(bounty), progress: [0], definition: bounty }], done: [] } },
    });
    outside.sent.length = 0;
    inside.sent.length = 0;

    wall.ms = boardTurnsAt(DAY);
    router.runTickAcrossSpaces(0.05);
    expect(offered(DAY + 1)).toHaveLength(1);
    const boardFrames = (sent: readonly SomnioMessage[]) => sent.filter(({ tag }) => tag === 'quests' || tag === 'bountiesRanOut');
    expect(boardFrames(outside.sent)).toEqual([{ tag: 'quests', payload: { active: [], done: [], bounties: offered(DAY + 1) } }]);
    expect(boardFrames(inside.sent)).toEqual([
      { tag: 'quests', payload: { active: [], done: [], bounties: offered(DAY + 1) } },
      { tag: 'bountiesRanOut', payload: { count: 1 } },
    ]);
  });
});
