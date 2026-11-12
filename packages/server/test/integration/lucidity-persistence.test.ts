import { afterAll, beforeAll, expect, it } from 'vitest';
import { bountyIdOf, bountyLands, dayBounties, worldDay } from '@somnio/core';
import type { Bounty, Character, Inventory, ItemInstance, Lucidity, QuestLog } from '@somnio/core';
import { PostgresCharacterRepository, PostgresItemRepository, PostgresQuestRepository } from '@somnio/data';
import { plain } from '../../../core/test/support/items.ts';
import { bootTestServer, closeAndAwaitCleanup, drainFrames, frame, joinFreshPlayer, loginOverWire, pollUntil, startDatabase } from './support/harness.ts';
import type { DatabaseHarness, TestServer } from './support/harness.ts';

let harness: DatabaseHarness;
let server: TestServer;
let characters: PostgresCharacterRepository;

beforeAll(async () => {
  harness = await startDatabase();
  // No simulation step runs inside the suite, so no pool recovers under the assertions.
  server = await bootTestServer(harness.url, { simulationIntervalMs: 3_600_000 });
  characters = new PostgresCharacterRepository(harness.db);
});
afterAll(async () => {
  await server.stop();
  await harness.stop();
});

const NOTHING: Inventory = { coins: 0, equipped: {}, bag: [] };

/** The world day the test server's clock stands on. */
function today(): number {
  return worldDay(server.server.worldClock.currentWorldSeconds());
}

/** Registers a player, lets them leave, and writes `changes` over their row as a later checkpoint would. */
async function seeded(prefix: string, changes: Partial<Character>, inventory: Inventory = NOTHING): Promise<Character> {
  const fresh = await joinFreshPlayer(server.url, prefix);
  const registered = (await characters.findByName(fresh.name))!;
  await closeAndAwaitCleanup(fresh, server);
  const left = await pollUntil(async () => {
    const row = await characters.findByName(fresh.name);
    return row !== undefined && row.lastSeen.getTime() > registered.lastSeen.getTime() ? row : undefined;
  });
  const character = { ...left, ...changes, lastSeen: new Date(left.lastSeen.getTime() + 1) };
  expect(await characters.persistCheckpoint(character, inventory)).toBe(true);
  return character;
}

it('what a dreamer has grown into, carries, and has taken on joins as it was stored, and a checkpoint stores what changed and nothing else', async () => {
  const lucidity: Lucidity = {
    role: 'healer',
    ranks: [
      { teachingId: 'depth', rank: 1, practice: 3 },
      { teachingId: 'touch', rank: 2, practice: 12.5 },
    ],
    study: 'depth',
  };
  const energy = { healthCurrent: 40, healthMax: 100, balanceCurrent: 60, balanceMax: 100, spiritCurrent: 30, spiritMax: 100 };
  // Nothing here adds to a pool, so the stored maxima stand.
  const moonstone: ItemInstance = { id: '00000000-0000-7000-8000-0000000000a1', ...plain('moonstone') };
  const sword: ItemInstance = {
    id: '00000000-0000-7000-8000-0000000000a2',
    ...plain('sword'),
    rarity: 'rare',
    affixes: [
      { affixId: 'damage', value: 2 },
      { affixId: 'swing-speed', value: 5 },
      { affixId: 'balance-recovery', value: 12 },
    ],
  };
  const amulet: ItemInstance = { id: '00000000-0000-7000-8000-0000000000a3', ...plain('amulet'), rarity: 'magic', affixes: [{ affixId: 'health', value: 5 }] };
  const inventory: Inventory = { coins: 137, equipped: { mainHand: sword, offHand: moonstone }, bag: [{ place: 0, item: amulet }] };
  const quests: QuestLog = { active: [{ questId: 'drawing-back-task', progress: [22] }], done: ['healer-trial'] };
  const stored = await seeded('lucid', { lucidity, energy, quests }, inventory);

  const joined = await loginOverWire(server.url, stored.name);
  const sent = (tag: string) => joined.join.find((message) => message.tag === tag)?.payload;
  expect(sent('energy')).toEqual(energy);
  expect(sent('lucidity')).toEqual(lucidity);
  expect(sent('inventory')).toEqual({
    coins: 137,
    equipped: [
      { slot: 'mainHand', item: sword },
      { slot: 'offHand', item: moonstone },
    ],
    bag: [{ place: 0, item: amulet }],
  });

  const facing = (stored.facing + 90) % 360;
  joined.client.send(frame({ tag: 'move', payload: { ...stored.position, facing, gait: 'walk' } }));
  await closeAndAwaitCleanup(joined, server);
  const after = await pollUntil(async () => {
    const row = await characters.findByName(stored.name);
    return row !== undefined && row.lastSeen.getTime() > stored.lastSeen.getTime() ? row : undefined;
  });
  expect(after).toMatchObject({ lucidity, energy, facing });
  expect(await new PostgresItemRepository(harness.db).load(stored.id)).toEqual(inventory);
  expect(await new PostgresQuestRepository(harness.db).load(stored.id)).toEqual(quests);
});

it('a dreamer who left fallen joins fallen, and cannot move', async () => {
  const energy = { healthCurrent: 0, healthMax: 100, balanceCurrent: 80, balanceMax: 100, spiritCurrent: 100, spiritMax: 100 };
  const stored = await seeded('fallen', { energy });
  const joined = await loginOverWire(server.url, stored.name);
  const self = joined.join.find((message) => message.tag === 'entity' && message.payload.id === joined.entityId);
  expect(self).toMatchObject({ payload: { condition: 'fallen', x: stored.position.x, z: stored.position.z } });
  joined.client.send(frame({ tag: 'move', payload: { x: stored.position.x + 0.1, z: stored.position.z, facing: 0, gait: 'walk' } }));
  expect(await drainFrames(joined.client)).toEqual([{ tag: 'correction', payload: stored.position }]);
  await joined.client.close();
  await pollUntil(() => Promise.resolve(server.server.worldRouter.loggedInPlayerCount() === 0 ? true : undefined));
});

it('a Mystic joins as stored, with the spirit their Spirit deepening gives and the fallen they sense, and leaves as they joined', async () => {
  const lucidity: Lucidity = {
    role: 'mystic',
    ranks: [
      { teachingId: 'mystic-spirit-deepening', rank: 2, practice: 0 },
      { teachingId: 'sense-the-fallen', rank: 1, practice: 0 },
      { teachingId: 'ward', rank: 2, practice: 4.5 },
    ],
    study: 'ward',
  };
  const energy = { healthCurrent: 100, healthMax: 100, balanceCurrent: 100, balanceMax: 100, spiritCurrent: 115, spiritMax: 120 };
  const stored = await seeded('mystic', { lucidity, energy });

  const joined = await loginOverWire(server.url, stored.name);
  const sent = (tag: string) => joined.join.find((message) => message.tag === tag)?.payload;
  expect(sent('lucidity')).toEqual({ role: lucidity.role, ranks: lucidity.ranks, study: lucidity.study });
  expect(sent('energy')).toEqual(energy);
  expect(sent('sensed')).toEqual({ bearings: [] });
  await closeAndAwaitCleanup(joined, server);
  const after = await pollUntil(async () => {
    const row = await characters.findByName(stored.name);
    return row !== undefined && row.lastSeen.getTime() > stored.lastSeen.getTime() ? row : undefined;
  });
  expect(after).toMatchObject({ lucidity, energy });
});

it("a bounty taken on an earlier day joins held by its definition beside the day's bounties, and only today's turned-in bounties block anything", async () => {
  const day = today();
  const yesterday = (bounty: Bounty): Bounty => ({ ...bounty, day: day - 1 });
  const offered = dayBounties(day, bountyLands([...server.server.worldRouter.world.spaces.values()].flatMap((space) => space.sectors)));
  const [held, turnedIn] = [yesterday(offered[0]!), offered[1]!];
  const quests: QuestLog = {
    active: [{ questId: bountyIdOf(held), progress: [1], definition: held }],
    done: [bountyIdOf(yesterday(turnedIn)), bountyIdOf(turnedIn)],
  };
  const stored = await seeded('bounty', { quests });
  const joined = await loginOverWire(server.url, stored.name);
  expect(joined.join.find((message) => message.tag === 'quests')?.payload).toEqual({
    active: [{ questId: bountyIdOf(held), progress: [1], definition: held }],
    done: [bountyIdOf(turnedIn)],
    bounties: offered,
  });
  expect(offered.map(({ land }) => land)).toEqual(['AutumnWood', 'EdariaArena', 'Graveyard', 'GraveyardCrypt', 'NorthWood']);
  await closeAndAwaitCleanup(joined, server);
});
