import { describe, expect, it } from 'vitest';
import { NO_LUCIDITY, NO_QUESTS, OUTDOOR_SPACE_ID, boardTurnsAt, bountyIdOf, doorOpenAt, monsterKind, parseModelRegistry, resolveDoor } from '@somnio/core';
import type { BaseItemId, Character, Inventory, ItemInstance, Lucidity, MonsterKindId, MonsterSpawn, Point, QuestId, QuestLog, Sector } from '@somnio/core';
import { SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import type { Role, SomnioMessage } from '@somnio/protocol';
import registryJSON from '@somnio/core/data/ModelRegistry.json' with { type: 'json' };
import { plain } from '../../core/test/support/items.ts';
import { outdoorSector } from '../../core/test/support/worldFixture.ts';
import { DEV_SECTORS_DIRECTORY } from '../src/config.ts';
import { loadSectorCache, loadWorld } from '../src/sectors/sectorCache.ts';
import { DAY, dayAsking, noon, offered } from './support/bountyBoard.ts';
import {
  BESIDE_GHOST,
  COINS,
  CUDGEL,
  GHOST,
  GHOST_AT,
  MOONSTONE,
  RESPAWN_MS,
  arena,
  attackGhost,
  carrying,
  characterOf,
  energy,
  energyOf,
  engage,
  face,
  lucidity,
  payloads,
  wearing,
} from './support/combat.ts';
import { collectMessages, recordingOutbox } from './support/frames.ts';
import { attachPlayer, makeClockedSpace, makeMonsterSpawn, makeNPC } from './support/sectorFactory.ts';

const PUGNAX = 'npc:EdariaFighterHall/pugnax';
const SANA = 'npc:EdariaHealerHall/sana';
const TACITA = 'npc:EdariaMysticTower/tacita';
const LIBUS = 'npc:EdariaLibrary/libus';
const MERCUS = 'npc:EdariaShop/mercus';
const MEMOR = 'npc:Graveyard/memor';
const AT_PUGNAX: Point = { x: -4, z: -15 };
const AT_SANA: Point = { x: 24, z: -15 };
const AT_TACITA: Point = { x: 10, z: -23 };
const AT_MEMOR: Point = { x: 16, z: 18 };
const AT_LIBUS: Point = { x: 24, z: 17 };
const AT_MERCUS: Point = { x: 44, z: 17 };
const BOARD = 'fixture:EdariaSquare/fixture-1';
const AT_BOARD: Point = { x: 64, z: 17.5 };
/** Where Pugnax and Sana stand to be met in the Graveyard world, and the Mystics' tower door on its square. */
const AT_PUGNAX_NORTH: Point = { x: 24, z: -15 };
const AT_SANA_NORTH: Point = { x: 44, z: -15 };
const AT_TOWER_DOOR: Point = { x: 72.6, z: 32.23 };

/**
 * The town round a Ghost, with the North Meadow north of it, the North Wood east, the Autumn Wood
 * south, and the West Meadow west. The North Wood is where the Healers' trial sends a dreamer, and
 * each of the other three holds a place of the Mystic's trial where the trial puts it. The masters
 * stand in their halls, named as the committed ones so their quests are theirs: the Fighter Hall
 * west of the North Meadow, the Healer Hall east of it, and the Mystic Tower north of it.
 */
const TOWN: Partial<Sector> = { spawn: { x: 10, z: 18, facing: 0 } };

function town() {
  return arena(TOWN, {
    sectors: [
      outdoorSector('NorthWood', { x: 20, z: 0 }),
      outdoorSector('WestMeadow', { x: -30.72, z: 0 }, { size: { width: 30.72, depth: 30.72 } }),
      outdoorSector('AutumnWood', { x: 0, z: 20 }),
      outdoorSector('NorthMeadow', { x: 0, z: -20 }),
      outdoorSector('EdariaFighterHall', { x: -20, z: -20 }, { npcs: [{ ...makeNPC('pugnax', { x: 16, z: 4 }, ''), service: 'fighterMaster' }] }),
      outdoorSector('EdariaHealerHall', { x: 20, z: -20 }, { npcs: [{ ...makeNPC('sana', { x: 4, z: 4 }, ''), service: 'healerMaster' }] }),
      outdoorSector('EdariaMysticTower', { x: 0, z: -40 }, { npcs: [{ ...makeNPC('tacita', { x: 10, z: 16 }, ''), service: 'mysticMaster' }] }),
    ],
  });
}

type Town = ReturnType<typeof town>;

/**
 * The Graveyard round a nightmare of `kind`, standing where the town's Ghost does, with Memor by
 * its church, the Library east of it, where Libus stands and a new dreamer starts, Mercus's shop
 * east of that, and the square with the bounty board east of that, as large as the committed one.
 * The Fighter Hall lies north of the Library and the Healer Hall north of the shop. Named as the
 * committed ones, so the first quests are theirs, though none of Memor, Libus, and Mercus carries a
 * service.
 */
function graveyard(kind: MonsterKindId = 'skeleton-minion', ...more: MonsterSpawn[]): Town {
  return arena(
    { name: 'Graveyard', npcs: [makeNPC('memor', { x: 16, z: 17 }, '')], monsterSpawns: [{ ...makeMonsterSpawn(GHOST_AT), kind }, ...more] },
    {
      sectors: [
        outdoorSector('EdariaLibrary', { x: 20, z: 0 }, { spawn: { x: 10, z: 4, facing: 0 }, npcs: [makeNPC('libus', { x: 4, z: 16 }, '')] }),
        outdoorSector('EdariaShop', { x: 40, z: 0 }, { npcs: [makeNPC('mercus', { x: 4, z: 16 }, '')] }),
        outdoorSector('EdariaFighterHall', { x: 20, z: -20 }, { npcs: [{ ...makeNPC('pugnax', { x: 4, z: 4 }, ''), service: 'fighterMaster' }] }),
        outdoorSector('EdariaHealerHall', { x: 40, z: -20 }, { npcs: [{ ...makeNPC('sana', { x: 4, z: 4 }, ''), service: 'healerMaster' }] }),
        outdoorSector(
          'EdariaSquare',
          { x: 60, z: 0 },
          {
            size: { width: 40.96, depth: 40.96 },
            placements: [{ id: 'notice-board-1', modelId: 'notice-board', x: 4, z: 16, yaw: 0, elevation: 0 }],
            fixtures: [{ id: 'fixture-1', placement: 'notice-board-1', service: 'bountyBoard' }],
          },
        ),
      ],
    },
  );
}

function lucidityOf(space: Town['space'], entityId: string): Lucidity {
  return characterOf(space, entityId).lucidity;
}

function questsOf(space: Town['space'], entityId: string): QuestLog {
  return characterOf(space, entityId).quests;
}

/** What the dreamer has done toward each objective of the quest they hold. */
function progressOf(space: Town['space'], entityId: string, questId: string): number[] | undefined {
  return questsOf(space, entityId).active.find((held) => held.questId === questId)?.progress;
}

/** A log holding the quest, with that much done toward each of its objectives. */
function holding(questId: QuestId, progress: number[], done: QuestId[] = []): QuestLog {
  return { active: [{ questId, progress }], done };
}

/** A `quests` frame of the log, with whatever bounties the day offers. */
function framed(log: QuestLog) {
  return { ...log, bounties: expect.any(Array) };
}

/**
 * Puts the player at `to`, however far, by way of `via`: a fresh allowance covers a few metres at a
 * time. Then it waits out the 2.5 s a 5 m stride at a jog holds recovery.
 */
function walk(world: Town, entityId: string, to: Point, ...via: Point[]): void {
  for (const point of [...via, to]) walkStraight(world, entityId, point);
  world.clock.ms += 2500;
}

function walkStraight(world: Town, entityId: string, to: Point): void {
  for (let guard = 0; guard < 100; guard += 1) {
    const from = characterOf(world.space, entityId).position;
    const away = Math.hypot(to.x - from.x, to.z - from.z);
    if (away === 0) return;
    const stride = Math.min(1, 5 / away);
    world.clock.ms += 2000;
    world.space.handleMove({ x: from.x + (to.x - from.x) * stride, z: from.z + (to.z - from.z) * stride, facing: 0, gait: 'jog' }, entityId);
  }
  throw new Error(`could not walk to (${to.x}, ${to.z})`);
}

/** Drives the named Ghost, standing where the first one did, off with three cudgel swings. */
function driveOff(world: Town, entityId: string, ghost: string): void {
  strike(world, ghost, 3, entityId);
}

/** Each striker, standing in reach of `GHOST_AT`, swings at the nightmare standing there once a second, `swings` times. */
function strike(world: Town, nightmare: string, swings: number, ...strikers: string[]): void {
  for (const striker of strikers) {
    face(world.space, striker, GHOST_AT);
    engage(world.space, nightmare, striker);
  }
  for (let swing = 0; swing < swings; swing += 1) {
    world.space.step(0);
    world.clock.ms += 1000;
  }
}

/** A bag with no room left, of caps. */
const fullBag = (): ItemInstance[] =>
  Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxBagItems }, (_, index) => ({
    id: `00000000-0000-7000-8000-1${String(index).padStart(11, '0')}`,
    ...plain('cap'),
  }));

const inventoryOf = (world: Town, entityId: string): Inventory => world.space.snapshotForPlayer(entityId)!.inventory;

describe("a trial's reward", () => {
  const BUCKLER: ItemInstance = { id: '00000000-0000-7000-8000-000000000031', ...plain('buckler') };
  const passed = (role: Role): Partial<Character> => {
    const questId = `${role}-trial` as QuestId;
    return { quests: holding(questId, role === 'mystic' ? [1, 1, 1] : [1]) };
  };

  it.each<[Role, string, Point, BaseItemId]>([
    ['healer', SANA, AT_SANA, 'moonstone'],
    ['mystic', TACITA, AT_TACITA, 'wand'],
  ])('waits, granting nothing, while the off hand is filled and the bag full, and goes into the bag once it has room: %s', async (role, master, at, baseId) => {
    const world = town();
    const caps = fullBag();
    const full = carrying({ worn: [BUCKLER], bag: caps });
    const alice = attachPlayer(world.space, at, 'alice', { character: passed(role), inventory: full });
    const before = characterOf(world.space, alice.entityId);
    world.space.handleTurnInQuest(master, `${role}-trial`, alice.entityId);
    expect(characterOf(world.space, alice.entityId)).toMatchObject({ lucidity: before.lucidity, quests: before.quests });
    expect(inventoryOf(world, alice.entityId)).toEqual(full);

    world.space.handleEquip(caps[0]!.id, undefined, alice.entityId);
    world.space.handleTurnInQuest(master, `${role}-trial`, alice.entityId);
    expect(lucidityOf(world.space, alice.entityId).role).toBe(role);
    expect(questsOf(world.space, alice.entityId)).toEqual({ active: [], done: [`${role}-trial`] });
    const { equipped, bag } = inventoryOf(world, alice.entityId);
    expect([equipped.offHand, bag.length, bag[0]?.item.baseId]).toEqual([BUCKLER, SOMNIO_PROTOCOL_CONSTANTS.maxBagItems, baseId]);
    // The refusal sent nothing: past the join's, the equip sent an `inventory` frame, and the reward a `lucidity` and an `inventory` frame.
    const messages = await collectMessages(alice.outbox);
    expect([payloads(messages, 'lucidity').length, payloads(messages, 'inventory').length]).toEqual([2, 3]);
  });

  it('goes into an empty off hand, whatever the bag holds', () => {
    const world = town();
    const alice = attachPlayer(world.space, AT_SANA, 'alice', { character: passed('healer'), inventory: carrying({ bag: fullBag() }) });
    world.space.handleTurnInQuest(SANA, 'healer-trial', alice.entityId);
    expect(lucidityOf(world.space, alice.entityId).role).toBe('healer');
    expect(inventoryOf(world, alice.entityId).equipped.offHand?.baseId).toBe('moonstone');
  });
});

describe('a trial', () => {
  it('makes a dreamer who passes and turns it in a Fighter for good, studying Strike', async () => {
    const world = town();
    const alice = attachPlayer(world.space, AT_PUGNAX, 'alice', { inventory: wearing(CUDGEL) });
    world.space.handleAcceptQuest(PUGNAX, 'fighter-trial', alice.entityId);
    expect(questsOf(world.space, alice.entityId)).toEqual(holding('fighter-trial', [0]));
    // Turning it in early changes nothing.
    world.space.handleTurnInQuest(PUGNAX, 'fighter-trial', alice.entityId);
    expect(lucidityOf(world.space, alice.entityId).role).toBeUndefined();

    walk(world, alice.entityId, BESIDE_GHOST);
    // Eight cudgel swings a second apart, with the nightmare's own strikes landing too.
    attackGhost(world.space, alice.entityId);
    world.steps(8 * 20);
    expect(progressOf(world.space, alice.entityId, 'fighter-trial')).toEqual([1]);
    // Passing the trial alone commits nothing, and the other master does not take it.
    expect(lucidityOf(world.space, alice.entityId).role).toBeUndefined();
    walk(world, alice.entityId, AT_SANA);
    world.space.handleTurnInQuest(SANA, 'fighter-trial', alice.entityId);
    expect(lucidityOf(world.space, alice.entityId).role).toBeUndefined();

    walk(world, alice.entityId, AT_PUGNAX);
    world.space.handleTurnInQuest(PUGNAX, 'fighter-trial', alice.entityId);
    expect(lucidityOf(world.space, alice.entityId)).toEqual({
      role: 'fighter',
      ranks: [{ teachingId: 'strike', rank: 1, practice: 0 }],
      study: 'strike',
    });
    expect(questsOf(world.space, alice.entityId)).toEqual({ active: [], done: ['fighter-trial'] });
    expect(payloads(await collectMessages(alice.outbox), 'lucidity').at(-1)).toEqual({
      role: 'fighter',
      ranks: [{ teachingId: 'strike', rank: 1, practice: 0 }],
      study: 'strike',
    });
  });

  it('makes a Healer of a dreamer who reaches the North Wood and returns, and gives them a Moonstone', async () => {
    const world = town();
    const alice = attachPlayer(world.space, AT_SANA, 'alice', { inventory: carrying({ coins: COINS }) });
    world.space.handleAcceptQuest(SANA, 'healer-trial', alice.entityId);
    walk(world, alice.entityId, { x: 24, z: -0.5 });
    expect(progressOf(world.space, alice.entityId, 'healer-trial')).toEqual([0]);
    walk(world, alice.entityId, { x: 24, z: 0.5 });
    expect(progressOf(world.space, alice.entityId, 'healer-trial')).toEqual([1]);
    walk(world, alice.entityId, AT_SANA);
    world.space.handleTurnInQuest(SANA, 'healer-trial', alice.entityId);
    expect(lucidityOf(world.space, alice.entityId)).toMatchObject({ role: 'healer', ranks: [{ teachingId: 'touch', rank: 1, practice: 0 }], study: 'touch' });
    const messages = await collectMessages(alice.outbox);
    expect(payloads(messages, 'inventory').at(-1)).toEqual({
      coins: 100,
      equipped: [{ slot: 'offHand', item: { id: expect.any(String), ...plain('moonstone') } }],
      bag: [],
      rewarded: [{ kind: 'item', baseId: 'moonstone', rarity: 'plain' }],
    });
    // The Moonstone follows the role in what the dreamer is sent.
    const order = messages.flatMap((message) => (message.tag === 'inventory' || message.tag === 'lucidity' ? [message.tag] : []));
    expect(order.slice(-2)).toEqual(['lucidity', 'inventory']);
  });

  it('makes a Mystic of a dreamer who stands in each of the three hidden places, in any order, and returns, and gives them a wand', async () => {
    const world = town();
    const alice = attachPlayer(world.space, AT_TACITA, 'alice', { inventory: carrying({ coins: COINS }) });
    world.space.handleAcceptQuest(TACITA, 'mystic-trial', alice.entityId);
    const progress = () => progressOf(world.space, alice.entityId, 'mystic-trial');
    // The North Meadow's place, then the West Meadow's, each found once.
    walk(world, alice.entityId, { x: 6.88, z: -3.28 });
    expect(progress()).toEqual([0, 0, 1]);
    walk(world, alice.entityId, { x: -24, z: 21.8 }, { x: 5, z: 5 });
    expect(progress()).toEqual([0, 0, 1]);
    walk(world, alice.entityId, { x: -24, z: 22 });
    expect(progress()).toEqual([1, 0, 1]);
    walk(world, alice.entityId, AT_TACITA, { x: 5, z: 5 });
    world.space.handleTurnInQuest(TACITA, 'mystic-trial', alice.entityId);
    expect(lucidityOf(world.space, alice.entityId).role).toBeUndefined();
    walk(world, alice.entityId, { x: 9.04, z: 28 });
    expect(progress()).toEqual([1, 1, 1]);
    walk(world, alice.entityId, AT_TACITA);
    world.space.handleTurnInQuest(TACITA, 'mystic-trial', alice.entityId);
    expect(lucidityOf(world.space, alice.entityId)).toEqual({
      role: 'mystic',
      ranks: [{ teachingId: 'ward', rank: 1, practice: 0 }],
      study: 'ward',
    });
    expect(payloads(await collectMessages(alice.outbox), 'inventory').at(-1)).toEqual({
      coins: 100,
      equipped: [{ slot: 'offHand', item: { id: expect.any(String), ...plain('wand') } }],
      bag: [],
      rewarded: [{ kind: 'item', baseId: 'wand', rarity: 'plain' }],
    });
  });

  it("keeps a dreamer holding the Healer's trial from swinging, until it is given up", () => {
    const world = town();
    const alice = attachPlayer(world.space, AT_SANA, 'alice');
    world.space.handleAcceptQuest(SANA, 'healer-trial', alice.entityId);
    walk(world, alice.entityId, BESIDE_GHOST);
    world.dice.hit = false;
    attackGhost(world.space, alice.entityId);
    world.space.step(0);
    expect(energyOf(world.space, alice.entityId).balanceCurrent).toBe(100);
    world.space.handleAbandonQuest('healer-trial', alice.entityId);
    attackGhost(world.space, alice.entityId);
    world.space.step(0);
    expect(energyOf(world.space, alice.entityId).balanceCurrent).toBe(92);
  });

  it("is one at a time: another master's is refused until the one held is given up", () => {
    const world = town();
    const alice = attachPlayer(world.space, AT_SANA, 'alice', { character: { quests: holding('fighter-trial', [1]) } });
    world.space.handleAcceptQuest(SANA, 'healer-trial', alice.entityId);
    expect(questsOf(world.space, alice.entityId)).toEqual(holding('fighter-trial', [1]));
    world.space.handleAbandonQuest('fighter-trial', alice.entityId);
    world.space.handleAcceptQuest(SANA, 'healer-trial', alice.entityId);
    expect(questsOf(world.space, alice.entityId)).toEqual(holding('healer-trial', [0]));
  });

  it('is not turned in by a dreamer who has a role already', () => {
    const world = town();
    const character = { lucidity: lucidity('healer', { touch: 1 }), quests: holding('fighter-trial', [1]) };
    const alice = attachPlayer(world.space, AT_PUGNAX, 'alice', { character });
    world.space.handleTurnInQuest(PUGNAX, 'fighter-trial', alice.entityId);
    expect(characterOf(world.space, alice.entityId)).toMatchObject(character);
  });

  it.each<[string, Partial<Character>, string, QuestId]>([
    ['a dreamer of the other role', { lucidity: lucidity('fighter', { strike: 1 }) }, SANA, 'healer-trial'],
    ['a dreamer who already has the role', { lucidity: lucidity('fighter', { strike: 1 }) }, PUGNAX, 'fighter-trial'],
    ['a dreamer who turned it in before', { quests: { active: [], done: ['fighter-trial'] } }, PUGNAX, 'fighter-trial'],
    ['a fallen dreamer', { energy: energy({ healthCurrent: 0 }) }, PUGNAX, 'fighter-trial'],
    ['a master who gives another', {}, PUGNAX, 'healer-trial'],
    ['a quest nobody gives', {}, PUGNAX, 'fireball' as QuestId],
    ['a teaching whose task was done before', { lucidity: lucidity('fighter', { strike: 2, 'follow-through': 2 }) }, PUGNAX, 'follow-through-task'],
  ])('is not given to %s', (_label, character, master, questId) => {
    const world = town();
    const alice = attachPlayer(world.space, master === SANA ? AT_SANA : AT_PUGNAX, 'alice', { character });
    const before = characterOf(world.space, alice.entityId);
    world.space.handleAcceptQuest(master, questId, alice.entityId);
    expect(characterOf(world.space, alice.entityId)).toMatchObject({ lucidity: before.lucidity, quests: before.quests });
  });

  it('is not given from beyond speaking distance, or by an NPC that does not give it', () => {
    const world = town();
    const far = attachPlayer(world.space, { x: -4, z: -13.9 }, 'far');
    world.space.handleAcceptQuest(PUGNAX, 'fighter-trial', far.entityId);
    const reader = attachPlayer(world.space, AT_SANA, 'reader');
    world.space.handleAcceptQuest(SANA, 'fighter-trial', reader.entityId);
    world.space.handleAcceptQuest('npc:TestSector/nobody', 'fighter-trial', reader.entityId);
    expect([far, reader].map((player) => questsOf(world.space, player.entityId))).toEqual([NO_QUESTS, NO_QUESTS]);
  });
});

describe('the quests frame', () => {
  /** The `quests` frames the player was sent since the last call. */
  const questsSent = (recorded: ReturnType<typeof recordingOutbox>) => payloads(recorded.sent.splice(0), 'quests');

  it('goes to the dreamer on joining, after their lucidity, with what they hold and turned in', async () => {
    const world = town();
    const quests: QuestLog = { active: [{ questId: 'follow-through-task', progress: [2] }], done: ['fighter-trial'] };
    const alice = attachPlayer(world.space, AT_PUGNAX, 'alice', { character: { lucidity: lucidity('fighter', { strike: 2 }), quests } });
    const messages = await collectMessages(alice.outbox);
    const tags = messages.map((message) => message.tag);
    expect(tags.indexOf('quests')).toBe(tags.indexOf('lucidity') + 1);
    expect(payloads(messages, 'quests')).toEqual([framed(quests)]);
  });

  it('goes to the dreamer alone on taking a quest on, on progress toward it, on turning it in, and on giving one up', () => {
    const world = town();
    const alice = recordingOutbox();
    const bob = recordingOutbox();
    const aliceId = attachPlayer(world.space, AT_SANA, 'alice', { inventory: carrying({ coins: COINS }), outbox: alice.outbox }).entityId;
    const bobId = attachPlayer(world.space, AT_SANA, 'bob', { outbox: bob.outbox }).entityId;
    questsSent(alice);
    questsSent(bob);
    world.space.handleAcceptQuest(SANA, 'healer-trial', aliceId);
    expect(questsSent(alice)).toEqual([framed(holding('healer-trial', [0]))]);
    walk(world, aliceId, { x: 24, z: 0.5 });
    expect(questsSent(alice)).toEqual([framed(holding('healer-trial', [1]))]);
    // A move that changes nothing sends nothing.
    walk(world, aliceId, { x: 24, z: 1.5 });
    expect(questsSent(alice)).toEqual([]);
    walk(world, aliceId, AT_SANA);
    world.space.handleTurnInQuest(SANA, 'healer-trial', aliceId);
    expect(questsSent(alice)).toEqual([framed({ active: [], done: ['healer-trial'] })]);
    // A refused quest, and giving up one not held, send nothing.
    world.space.handleAcceptQuest(SANA, 'drawing-back-task', aliceId);
    world.space.handleAbandonQuest('drawing-back-task', aliceId);
    expect(questsSent(alice)).toEqual([]);
    world.space.handleAcceptQuest(SANA, 'healer-trial', bobId);
    world.space.handleAbandonQuest('healer-trial', bobId);
    expect(questsSent(bob)).toEqual([framed(holding('healer-trial', [0])), framed(NO_QUESTS)]);
    expect(questsSent(alice)).toEqual([]);
  });
});

describe('practice', () => {
  it('carries the teaching studied to its next ranks, and stops at the last', () => {
    const world = town();
    const almost = lucidity('fighter', { strike: 5 }, { study: 'guard' });
    almost.ranks.push({ teachingId: 'guard', rank: 1, practice: 30 });
    const alice = attachPlayer(world.space, BESIDE_GHOST, 'alice', { character: { lucidity: almost }, inventory: wearing(CUDGEL) });
    driveOff(world, alice.entityId, GHOST);
    // 40 practice at rank 1: 35 for rank 2, and 5 toward rank 3.
    expect(lucidityOf(world.space, alice.entityId)).toMatchObject({
      study: 'guard',
      ranks: [{ teachingId: 'strike' }, { teachingId: 'guard', rank: 2, practice: 5 }],
    });
  });

  it('clears the study once the last rank is reached', () => {
    const world = town();
    const almost = lucidity('fighter', { strike: 5 }, { study: 'guard' });
    almost.ranks.push({ teachingId: 'guard', rank: 2, practice: 45 });
    const alice = attachPlayer(world.space, BESIDE_GHOST, 'alice', { character: { lucidity: almost }, inventory: wearing(CUDGEL) });
    driveOff(world, alice.entityId, GHOST);
    expect(lucidityOf(world.space, alice.entityId)).toMatchObject({
      study: undefined,
      ranks: [{ teachingId: 'strike' }, { teachingId: 'guard', rank: 3, practice: 0 }],
    });
  });

  it('accrues nothing with no teaching studied', () => {
    const world = town();
    const idle = lucidity('fighter', { strike: 5 });
    const alice = attachPlayer(world.space, BESIDE_GHOST, 'alice', { character: { lucidity: idle }, inventory: wearing(CUDGEL) });
    driveOff(world, alice.entityId, GHOST);
    expect(lucidityOf(world.space, alice.entityId)).toEqual(idle);
  });
});

describe('studying', () => {
  const fighter = (strike: number, overrides: Partial<Lucidity> = {}): Partial<Character> => ({
    lucidity: lucidity('fighter', { strike }, { study: 'strike', ...overrides }),
  });

  it("turns to another teaching of the dreamer's role whose needs are met", () => {
    const world = town();
    const alice = attachPlayer(world.space, AT_PUGNAX, 'alice', { character: fighter(1) });
    world.space.handleStudy(PUGNAX, 'guard', alice.entityId);
    expect(lucidityOf(world.space, alice.entityId).study).toBe('guard');
    world.space.handleStudy(PUGNAX, 'toughening', alice.entityId);
    expect(lucidityOf(world.space, alice.entityId).study).toBe('toughening');
  });

  it.each<[string, Partial<Character>, string, string]>([
    ['a teaching whose needs are not met', fighter(1), PUGNAX, 'follow-through'],
    ['a gated teaching at rank 0', fighter(2), PUGNAX, 'follow-through'],
    ['a teaching at its last rank', { lucidity: lucidity('fighter', { strike: 5 }, { study: 'guard' }) }, PUGNAX, 'strike'],
    ['a teaching of the other role', fighter(1), PUGNAX, 'touch'],
    ['a teaching nobody teaches', fighter(1), PUGNAX, 'fireball'],
    ['anything at the other master', fighter(1), SANA, 'guard'],
    ['anything for a dreamer with no role', { lucidity: NO_LUCIDITY }, PUGNAX, 'strike'],
  ])('does not turn to %s', (_label, character, master, teachingId) => {
    const world = town();
    const at = master === SANA ? AT_SANA : AT_PUGNAX;
    const alice = attachPlayer(world.space, at, 'alice', { character });
    const before = lucidityOf(world.space, alice.entityId);
    world.space.handleStudy(master, teachingId, alice.entityId);
    expect(lucidityOf(world.space, alice.entityId)).toEqual(before);
  });
});

describe('a gate', () => {
  it('starts a Follow-through count over when the dreamer falls, and keeps the count of a quest held that does not', () => {
    const world = town();
    const quests: QuestLog = {
      active: [
        { questId: 'follow-through-task', progress: [2] },
        { questId: 'restless-graves', progress: [3] },
      ],
      done: [],
    };
    const character = { lucidity: lucidity('fighter', { strike: 5 }), quests, energy: energy({ healthCurrent: 9 }) };
    const alice = attachPlayer(world.space, BESIDE_GHOST, 'alice', { character });
    world.steps(1);
    expect(world.space.isFallen(alice.entityId)).toBe(true);
    expect(progressOf(world.space, alice.entityId, 'follow-through-task')).toEqual([0]);
    expect(progressOf(world.space, alice.entityId, 'restless-graves')).toEqual([3]);
  });

  it('counts each nightmare driven off, and no further than its goal', () => {
    const world = town();
    const character = { lucidity: lucidity('fighter', { strike: 5 }), quests: holding('follow-through-task', [2]) };
    const alice = attachPlayer(world.space, BESIDE_GHOST, 'alice', { character, inventory: wearing(CUDGEL) });
    world.dice.hit = true;
    driveOff(world, alice.entityId, GHOST);
    expect(progressOf(world.space, alice.entityId, 'follow-through-task')).toEqual([3]);
    world.clock.ms += RESPAWN_MS;
    world.space.step(0);
    driveOff(world, alice.entityId, 'monster:2');
    expect(progressOf(world.space, alice.entityId, 'follow-through-task')).toEqual([3]);
    walk(world, alice.entityId, AT_PUGNAX);
    world.space.handleTurnInQuest(PUGNAX, 'follow-through-task', alice.entityId);
    expect(lucidityOf(world.space, alice.entityId)).toMatchObject({
      study: undefined,
      ranks: [{ teachingId: 'strike' }, { teachingId: 'follow-through', rank: 1, practice: 0 }],
    });
    expect(questsOf(world.space, alice.entityId)).toEqual({ active: [], done: ['follow-through-task'] });
  });

  it('teaches Drawing back from end to end: taken at Touch 2, earned by mending others, and only then does a touch raise', async () => {
    const world = town();
    const novice = attachPlayer(world.space, AT_SANA, 'novice', { character: { lucidity: lucidity('healer', { touch: 1 }) }, inventory: wearing(MOONSTONE) });
    world.space.handleAcceptQuest(SANA, 'drawing-back-task', novice.entityId);
    expect(questsOf(world.space, novice.entityId)).toEqual(NO_QUESTS);
    world.space.handOver(novice.entityId, true);

    const hurt = { energy: energy({ healthCurrent: 20 }), lucidity: lucidity('healer', { touch: 2, depth: 4 }) };
    const healer = attachPlayer(world.space, AT_SANA, 'healer', { character: hurt, inventory: wearing(MOONSTONE) });
    const patient = attachPlayer(world.space, { x: 24.6, z: -15 }, 'patient', { character: { energy: energy({ healthCurrent: 10 }) } });
    const fallen = attachPlayer(world.space, { x: 23.4, z: -15 }, 'fallen', { character: { energy: energy({ healthCurrent: 0 }) } });
    world.space.handleAcceptQuest(SANA, 'drawing-back-task', healer.entityId);
    expect(questsOf(world.space, healer.entityId)).toEqual(holding('drawing-back-task', [0]));
    // A quest held is not taken on again.
    world.space.handleAcceptQuest(SANA, 'drawing-back-task', healer.entityId);
    expect(questsOf(world.space, healer.entityId).active).toHaveLength(1);

    // Mending oneself does not count; 30 a touch on another does.
    engage(world.space, healer.entityId, healer.entityId);
    world.steps(1);
    expect(energyOf(world.space, healer.entityId).healthCurrent).toBeGreaterThan(20);
    expect(progressOf(world.space, healer.entityId, 'drawing-back-task')).toEqual([0]);
    world.clock.ms += 1000;
    engage(world.space, patient.entityId, healer.entityId);
    world.steps(1);
    expect(progressOf(world.space, healer.entityId, 'drawing-back-task')).toEqual([30]);
    world.space.handleTurnInQuest(SANA, 'drawing-back-task', healer.entityId);
    expect(progressOf(world.space, healer.entityId, 'drawing-back-task')).toEqual([30]);
    // Mend on the fallen dreamer for longer than a touch takes begins nothing before the rank.
    engage(world.space, fallen.entityId, healer.entityId);
    world.steps(21);
    engage(world.space, patient.entityId, healer.entityId);
    world.steps(1);
    expect(progressOf(world.space, healer.entityId, 'drawing-back-task')).toEqual([60]);

    world.space.handleTurnInQuest(SANA, 'drawing-back-task', healer.entityId);
    expect(lucidityOf(world.space, healer.entityId).ranks).toEqual(expect.arrayContaining([{ teachingId: 'drawing-back', rank: 1, practice: 0 }]));
    expect(questsOf(world.space, healer.entityId)).toEqual({ active: [], done: ['drawing-back-task'] });
    world.clock.ms += 1000;
    engage(world.space, fallen.entityId, healer.entityId);
    world.steps(1);
    // Only the touch after the rank began a raise.
    expect(payloads(await collectMessages(fallen.outbox), 'raising').map((raising) => raising.state)).toEqual(['holding']);
  });
});

describe('a quest', () => {
  it.each([
    ['standing', 100],
    ['fallen', 0],
  ])('is given up far from its giver, %s, and what was done toward it goes with it', (_label, healthCurrent) => {
    const world = town();
    const alice = attachPlayer(world.space, { x: 10, z: 15 }, 'alice', {
      character: { quests: holding('restless-graves', [2]), energy: energy({ healthCurrent }) },
    });
    world.space.handleAbandonQuest('restless-graves', alice.entityId);
    expect(questsOf(world.space, alice.entityId)).toEqual(NO_QUESTS);
  });

  it('counts a visit to a carrier asked to go on, or asked for a quest, from within speaking distance', () => {
    const world = graveyard();
    const alice = attachPlayer(world.space, { x: 44, z: 18.5 }, 'alice', { character: { quests: holding('newcomer-errand', [0, 0, 0, 0, 0]) } });
    world.space.handleInteract(MERCUS, alice.entityId);
    expect(progressOf(world.space, alice.entityId, 'newcomer-errand')).toEqual([0, 0, 0, 0, 0]);
    walk(world, alice.entityId, AT_MERCUS);
    world.space.handleInteract(MERCUS, alice.entityId);
    expect(progressOf(world.space, alice.entityId, 'newcomer-errand')).toEqual([1, 0, 0, 0, 0]);

    const bob = attachPlayer(world.space, AT_MERCUS, 'bob', { character: { quests: holding('newcomer-errand', [0, 0, 0, 0, 0]) } });
    world.space.handleAcceptQuest(MERCUS, 'restless-graves', bob.entityId);
    expect(progressOf(world.space, bob.entityId, 'newcomer-errand')).toEqual([1, 0, 0, 0, 0]);
  });

  it("counts a read of the bounty board, a fixture, from within speaking distance of its placement's centre, and serves nothing it does not carry", () => {
    const world = graveyard();
    const alice = attachPlayer(world.space, AT_MERCUS, 'alice', {
      character: { quests: holding('newcomer-errand', [1, 0, 0, 0, 0]) },
      inventory: carrying({ coins: COINS }),
    });
    world.space.handleInteract(BOARD, alice.entityId);
    expect(progressOf(world.space, alice.entityId, 'newcomer-errand')).toEqual([1, 0, 0, 0, 0]);
    walk(world, alice.entityId, AT_BOARD);
    world.space.handleBuy(BOARD, 'dagger', alice.entityId);
    world.space.handleStudy(BOARD, 'strike', alice.entityId);
    expect(inventoryOf(world, alice.entityId)).toEqual(carrying({ coins: COINS }));
    world.space.handleInteract(BOARD, alice.entityId);
    expect(progressOf(world.space, alice.entityId, 'newcomer-errand')).toEqual([1, 1, 0, 0, 0]);
  });

  it("counts meeting Pugnax and Sana in their halls toward Libus's errand, each asked to go on", () => {
    const world = graveyard();
    const alice = attachPlayer(world.space, AT_PUGNAX_NORTH, 'alice', { character: { quests: holding('newcomer-errand', [1, 1, 0, 0, 0]) } });
    world.space.handleInteract(PUGNAX, alice.entityId);
    expect(progressOf(world.space, alice.entityId, 'newcomer-errand')).toEqual([1, 1, 1, 0, 0]);
    walk(world, alice.entityId, AT_SANA_NORTH);
    world.space.handleInteract(SANA, alice.entityId);
    expect(progressOf(world.space, alice.entityId, 'newcomer-errand')).toEqual([1, 1, 1, 1, 0]);
  });

  it("counts standing at the Mystics' tower door on the committed square by day, while the door stays shut", () => {
    const world = loadWorld(loadSectorCache(DEV_SECTORS_DIRECTORY), registryJSON);
    const square = world.spaces.get(OUTDOOR_SPACE_ID)!.sectors.find((sector) => sector.name === 'EdariaSquare')!;
    const door = square.doors.find((candidate) => candidate.placement === 'building-tower-1')!;
    const { arrival } = resolveDoor(square, door, parseModelRegistry(registryJSON))!;
    const noon = 12 * 60 * 60;
    expect(doorOpenAt(door, noon)).toBe(false);
    const { clock, space } = makeClockedSpace(world, OUTDOOR_SPACE_ID);
    const alice = attachPlayer(space, { x: arrival.x, z: arrival.z + 4 }, 'alice', {
      worldSeconds: noon,
      character: { quests: holding('newcomer-errand', [1, 1, 1, 1, 0]) },
    });
    expect(progressOf(space, alice.entityId, 'newcomer-errand')).toEqual([1, 1, 1, 1, 0]);
    clock.ms += 2000;
    space.handleMove({ ...arrival, facing: 180, gait: 'jog' }, alice.entityId);
    expect(characterOf(space, alice.entityId).position).toEqual(arrival);
    expect(progressOf(space, alice.entityId, 'newcomer-errand')).toEqual([1, 1, 1, 1, 1]);
  });

  it("is Libus's errand to a newcomer: taken at Libus, done by a visit to Mercus, a read of the bounty board, a meeting with Pugnax and Sana, and a stand at the Mystics' tower door, and paid for at Libus, though none of Libus, Mercus, and the board carries a service", async () => {
    const world = graveyard();
    const alice = attachPlayer(world.space, AT_LIBUS, 'alice', { inventory: carrying({ coins: COINS }) });
    world.space.handleAcceptQuest(LIBUS, 'newcomer-errand', alice.entityId);
    world.space.handleTurnInQuest(LIBUS, 'newcomer-errand', alice.entityId);
    expect(questsOf(world.space, alice.entityId)).toEqual(holding('newcomer-errand', [0, 0, 0, 0, 0]));
    walk(world, alice.entityId, AT_MERCUS);
    world.space.handleInteract(MERCUS, alice.entityId);
    walk(world, alice.entityId, AT_LIBUS);
    world.space.handleTurnInQuest(LIBUS, 'newcomer-errand', alice.entityId);
    expect(questsOf(world.space, alice.entityId)).toEqual(holding('newcomer-errand', [1, 0, 0, 0, 0]));
    walk(world, alice.entityId, AT_BOARD);
    world.space.handleInteract(BOARD, alice.entityId);
    walk(world, alice.entityId, AT_TOWER_DOOR);
    walk(world, alice.entityId, AT_SANA_NORTH, { x: 55, z: 10 });
    world.space.handleInteract(SANA, alice.entityId);
    walk(world, alice.entityId, AT_PUGNAX_NORTH);
    world.space.handleInteract(PUGNAX, alice.entityId);
    walk(world, alice.entityId, AT_LIBUS, { x: 28, z: 17 });
    world.space.handleTurnInQuest(LIBUS, 'newcomer-errand', alice.entityId);
    expect(questsOf(world.space, alice.entityId)).toEqual({ active: [], done: ['newcomer-errand'] });
    expect(inventoryOf(world, alice.entityId).coins).toBe(COINS + 15);
    // It pays no item, so its frame names none.
    expect(payloads(await collectMessages(alice.outbox), 'inventory').at(-1)).toEqual({ coins: COINS + 15, equipped: [], bag: [] });
  });

  it("chains Memor's quests, each offered only once the one before it is turned in", () => {
    const world = graveyard();
    const newcomer = attachPlayer(world.space, AT_MEMOR, 'newcomer');
    world.space.handleAcceptQuest(MEMOR, 'cracked-skulls', newcomer.entityId);
    world.space.handleAcceptQuest(MEMOR, 'into-the-crypt', newcomer.entityId);
    world.space.handleAcceptQuest(MEMOR, 'restless-graves', newcomer.entityId);
    expect(questsOf(world.space, newcomer.entityId)).toEqual(holding('restless-graves', [0]));

    const alice = attachPlayer(world.space, AT_MEMOR, 'alice', { character: { quests: holding('restless-graves', [4]) } });
    world.space.handleAcceptQuest(MEMOR, 'cracked-skulls', alice.entityId);
    expect(questsOf(world.space, alice.entityId)).toEqual(holding('restless-graves', [4]));
    world.space.handleTurnInQuest(MEMOR, 'restless-graves', alice.entityId);
    world.space.handleAcceptQuest(MEMOR, 'into-the-crypt', alice.entityId);
    world.space.handleAcceptQuest(MEMOR, 'cracked-skulls', alice.entityId);
    expect(questsOf(world.space, alice.entityId)).toEqual(holding('cracked-skulls', [0], ['restless-graves']));

    const carol = attachPlayer(world.space, AT_MEMOR, 'carol', { character: { quests: holding('cracked-skulls', [3], ['restless-graves']) } });
    world.space.handleAcceptQuest(MEMOR, 'into-the-crypt', carol.entityId);
    world.space.handleTurnInQuest(MEMOR, 'cracked-skulls', carol.entityId);
    world.space.handleAcceptQuest(MEMOR, 'into-the-crypt', carol.entityId);
    expect(questsOf(world.space, carol.entityId)).toEqual(holding('into-the-crypt', [0], ['restless-graves', 'cracked-skulls']));
  });

  it('pays its coins, its practice, and its gear on its turn-in, and with a full bag waits, granting nothing, until there is room', async () => {
    const world = graveyard();
    const caps = fullBag();
    const character = {
      lucidity: lucidity('fighter', { strike: 3 }, { study: 'strike' }),
      quests: holding('into-the-crypt', [1], ['restless-graves', 'cracked-skulls']),
    };
    const alice = attachPlayer(world.space, AT_MEMOR, 'alice', { character, inventory: carrying({ coins: COINS, bag: caps }) });
    world.space.handleTurnInQuest(MEMOR, 'into-the-crypt', alice.entityId);
    expect(characterOf(world.space, alice.entityId)).toMatchObject(character);
    expect(inventoryOf(world, alice.entityId)).toEqual(carrying({ coins: COINS, bag: caps }));

    world.space.handleEquip(caps[0]!.id, undefined, alice.entityId);
    world.space.handleTurnInQuest(MEMOR, 'into-the-crypt', alice.entityId);
    expect(questsOf(world.space, alice.entityId)).toEqual({ active: [], done: ['restless-graves', 'cracked-skulls', 'into-the-crypt'] });
    // 60 practice at rank 3: rank 4 takes 65.
    expect(lucidityOf(world.space, alice.entityId).ranks).toEqual([{ teachingId: 'strike', rank: 3, practice: 60 }]);
    const { coins, bag } = inventoryOf(world, alice.entityId);
    expect(coins).toBe(COINS + 250);
    const gear = bag.find(({ item }) => item.baseId !== 'cap')!.item;
    expect(gear).toMatchObject({ tier: 3, rarity: expect.not.stringMatching('plain') });
    expect(bag).toHaveLength(SOMNIO_PROTOCOL_CONSTANTS.maxBagItems);
    // The frame says what the turn-in gave, so the dreamer is told of the gear.
    expect(payloads(await collectMessages(alice.outbox), 'inventory').at(-1)).toMatchObject({
      coins: COINS + 250,
      rewarded: [{ kind: 'item', baseId: gear.baseId, rarity: gear.rarity }],
    });
  });

  it('shares a drive-off with every standing dreamer within the share radius, but not one who lies fallen or stands far off', () => {
    const world = graveyard();
    const hunting = { quests: holding('restless-graves', [0]) };
    const alice = attachPlayer(world.space, BESIDE_GHOST, 'alice', {
      character: { ...hunting, lucidity: lucidity('fighter', { strike: 5 }) },
      inventory: wearing(CUDGEL),
    });
    const near = attachPlayer(world.space, { x: 12, z: 12 }, 'near', { character: hunting });
    const fallen = attachPlayer(world.space, { x: 8, z: 12 }, 'fallen', { character: { ...hunting, energy: energy({ healthCurrent: 0 }) } });
    const far = attachPlayer(world.space, { x: 30, z: 10 }, 'far', { character: hunting });
    // A Skeleton's 70 health takes a fourth cudgel swing.
    strike(world, GHOST, 4, alice.entityId);
    expect([alice, near, fallen, far].map((player) => progressOf(world.space, player.entityId, 'restless-graves')?.[0])).toEqual([1, 1, 0, 0]);
  });

  it("leaves a Skeleton Warrior's trophy for each sharer still collecting it, which a pick-up counts without the bag, however full", async () => {
    const world = graveyard('skeleton-warrior');
    const striker = { lucidity: lucidity('fighter', { strike: 5 }) };
    const { outbox, sent } = recordingOutbox();
    const alice = attachPlayer(world.space, BESIDE_GHOST, 'alice', {
      outbox,
      character: { ...striker, quests: holding('cracked-skulls', [0], ['restless-graves']) },
      inventory: carrying({ worn: [CUDGEL], bag: fullBag() }),
    });
    const bob = attachPlayer(world.space, { x: 10.7, z: 10 }, 'bob', { character: striker, inventory: wearing(CUDGEL) });
    const done = attachPlayer(world.space, { x: 9.3, z: 10 }, 'done', {
      character: { ...striker, quests: holding('cracked-skulls', [3], ['restless-graves']) },
      inventory: wearing(CUDGEL),
    });
    // Three cudgels drive its 160 health off in three swings each.
    strike(world, GHOST, 3, alice.entityId, bob.entityId, done.entityId);
    const trophies = (messages: readonly SomnioMessage[]) => payloads(messages, 'loot').filter((loot) => loot.contents.kind === 'trophy');
    expect([trophies(await collectMessages(bob.outbox)), trophies(await collectMessages(done.outbox))]).toEqual([[], []]);
    const [trophy] = trophies(sent);
    expect(trophy?.contents).toEqual({ kind: 'trophy', monsterKind: 'skeleton-warrior' });

    walk(world, alice.entityId, { x: trophy!.x, z: trophy!.z });
    const before = sent.length;
    world.space.handlePickUp(trophy!.lootId, alice.entityId);
    expect(progressOf(world.space, alice.entityId, 'cracked-skulls')).toEqual([1]);
    expect(inventoryOf(world, alice.entityId).bag).toHaveLength(SOMNIO_PROTOCOL_CONSTANTS.maxBagItems);
    expect(sent.slice(before)).toEqual([
      { tag: 'lootGone', payload: { lootId: trophy!.lootId } },
      { tag: 'inventory', payload: expect.objectContaining({ pickedUp: { kind: 'trophy', monsterKind: 'skeleton-warrior' } }) },
      { tag: 'quests', payload: framed(holding('cracked-skulls', [1], ['restless-graves'])) },
    ]);
  });
});

describe('the bounty board', () => {
  /** The Graveyard at noon of the board's day. */
  const graveyardOn = (day: number): Town => {
    const world = graveyard();
    world.wall.ms = noon(day);
    return world;
  };
  const striker = { lucidity: lucidity('fighter', { strike: 5 }) };
  const bountiesSent = (messages: readonly SomnioMessage[]) => payloads(messages, 'quests').map(({ bounties }) => bounties);
  /** The `quests` frame among `messages` and the frame right after it. */
  const questsAndNext = (messages: readonly SomnioMessage[]): SomnioMessage[] => {
    const at = messages.findIndex(({ tag }) => tag === 'quests');
    return messages.slice(at, at + 2);
  };
  /** Runs the simulation until the Skeleton driven off is back, which gives the striker their balance back too. */
  const awaitNextSkeleton = (world: Town): void => world.steps(Math.ceil(monsterKind('skeleton-minion').respawnSeconds / 0.05) + 1);

  it("offers every dreamer the same bounties on one board day, and each the next day's once, in the step that finds 00:00 UTC passed", () => {
    const world = graveyardOn(DAY);
    const alice = recordingOutbox();
    const bob = recordingOutbox();
    attachPlayer(world.space, AT_BOARD, 'alice', { outbox: alice.outbox });
    world.wall.ms += 3_600_000;
    attachPlayer(world.space, AT_MEMOR, 'bob', { outbox: bob.outbox });
    expect([bountiesSent(alice.sent.splice(0)), bountiesSent(bob.sent.splice(0))]).toEqual([[offered(DAY)], [offered(DAY)]]);
    expect(offered(DAY)).toHaveLength(1);

    world.wall.ms = boardTurnsAt(DAY) - 1;
    world.space.step(0);
    expect([bountiesSent(alice.sent), bountiesSent(bob.sent)]).toEqual([[], []]);
    world.wall.ms = boardTurnsAt(DAY);
    world.space.step(0);
    world.wall.ms += 3_600_000;
    world.space.step(0);
    expect([bountiesSent(alice.sent), bountiesSent(bob.sent)]).toEqual([[offered(DAY + 1)], [offered(DAY + 1)]]);
    expect(payloads([...alice.sent, ...bob.sent], 'bountiesRanOut')).toEqual([]);
  });

  it('lets a bounty held run out as the board turns, and tells its holder once', () => {
    const world = graveyardOn(DAY);
    const questId = bountyIdOf(offered(DAY)[0]!);
    const { outbox, sent } = recordingOutbox();
    const alice = attachPlayer(world.space, AT_BOARD, 'alice', { outbox });
    world.space.handleAcceptQuest(BOARD, questId, alice.entityId);
    expect(questsOf(world.space, alice.entityId).active.map((held) => held.questId)).toEqual([questId]);
    sent.length = 0;

    world.wall.ms = boardTurnsAt(DAY);
    world.space.step(0);
    world.wall.ms += 3_600_000;
    world.space.step(0);
    expect(questsOf(world.space, alice.entityId)).toEqual(NO_QUESTS);
    expect(sent.filter(({ tag }) => tag === 'quests' || tag === 'bountiesRanOut')).toEqual([
      { tag: 'quests', payload: { ...NO_QUESTS, bounties: offered(DAY + 1) } },
      { tag: 'bountiesRanOut', payload: { count: 1 } },
    ]);
  });

  it('changes nothing in a step whose clock went back to a day before the one the board turned to', () => {
    const world = graveyardOn(DAY + 1);
    const todays = offered(DAY + 1)[0]!;
    const held: QuestLog = { active: [{ questId: bountyIdOf(todays), progress: [1], definition: todays }], done: [] };
    const turnedIn: QuestLog = { active: [], done: [bountyIdOf(todays)] };
    const alice = recordingOutbox();
    const bob = recordingOutbox();
    const aliceId = attachPlayer(world.space, AT_BOARD, 'alice', { outbox: alice.outbox, character: { quests: held } }).entityId;
    const bobId = attachPlayer(world.space, AT_MEMOR, 'bob', { outbox: bob.outbox, character: { quests: turnedIn } }).entityId;
    alice.sent.length = 0;
    bob.sent.length = 0;

    world.wall.ms = noon(DAY);
    world.space.step(0);
    const carol = recordingOutbox();
    attachPlayer(world.space, AT_MEMOR, 'carol', { outbox: carol.outbox });
    const boardFrames = ({ sent }: { sent: readonly SomnioMessage[] }) => sent.filter(({ tag }) => tag === 'quests' || tag === 'bountiesRanOut');
    expect([boardFrames(alice), boardFrames(bob)]).toEqual([[], []]);
    expect([questsOf(world.space, aliceId), questsOf(world.space, bobId)]).toEqual([held, turnedIn]);
    expect(bountiesSent(carol.sent)).toEqual([[todays]]);
  });

  it('drops a bounty of an earlier day as its holder joins, and tells them right after their quests', () => {
    const world = graveyardOn(DAY + 1);
    const yesterdays = offered(DAY)[0]!;
    const todays = offered(DAY + 1)[0]!;
    const alice = recordingOutbox();
    const bob = recordingOutbox();
    attachPlayer(world.space, AT_BOARD, 'alice', {
      outbox: alice.outbox,
      character: { quests: { active: [{ questId: bountyIdOf(yesterdays), progress: [1], definition: yesterdays }], done: [] } },
    });
    const kept: QuestLog = { active: [{ questId: bountyIdOf(todays), progress: [1], definition: todays }], done: [] };
    attachPlayer(world.space, AT_MEMOR, 'bob', { outbox: bob.outbox, character: { quests: kept } });
    expect(questsAndNext(alice.sent)).toEqual([
      { tag: 'quests', payload: { ...NO_QUESTS, bounties: [todays] } },
      { tag: 'bountiesRanOut', payload: { count: 1 } },
    ]);
    expect(payloads(bob.sent, 'quests')).toEqual([{ ...kept, bounties: [todays] }]);
    expect(payloads(bob.sent, 'bountiesRanOut')).toEqual([]);
  });

  it('gives a bounty of the day at the board alone, by its definition, once a day', () => {
    const world = graveyardOn(DAY);
    const bounty = offered(DAY)[0]!;
    const questId = bountyIdOf(bounty);
    const alice = attachPlayer(world.space, AT_MEMOR, 'alice');
    world.space.handleAcceptQuest(BOARD, questId, alice.entityId);
    walk(world, alice.entityId, AT_BOARD);
    world.space.handleAcceptQuest(BOARD, bountyIdOf(offered(DAY + 1)[0]!), alice.entityId);
    world.space.handleAcceptQuest(BOARD, 'restless-graves', alice.entityId);
    expect(questsOf(world.space, alice.entityId)).toEqual(NO_QUESTS);
    world.space.handleAcceptQuest(BOARD, questId, alice.entityId);
    expect(questsOf(world.space, alice.entityId)).toEqual({ active: [{ questId, progress: [0], definition: bounty }], done: [] });

    const bob = attachPlayer(world.space, AT_MEMOR, 'bob');
    world.space.handleAcceptQuest(MEMOR, questId, bob.entityId);
    expect(questsOf(world.space, bob.entityId)).toEqual(NO_QUESTS);
    const carol = attachPlayer(world.space, AT_BOARD, 'carol', { character: { quests: { active: [], done: [questId] } } });
    world.space.handleAcceptQuest(BOARD, questId, carol.entityId);
    expect(questsOf(world.space, carol.entityId)).toEqual({ active: [], done: [questId] });
    world.wall.ms = noon(DAY + 1);
    world.space.step(0);
    expect(questsOf(world.space, carol.entityId)).toEqual(NO_QUESTS);
  });

  it('counts a drive-off of its kind in its land, and pays its coins and a magic item at the board once', () => {
    const day = dayAsking('driveOff');
    const world = graveyardOn(day);
    const bounty = offered(day)[0]!;
    const questId = bountyIdOf(bounty);
    const alice = attachPlayer(world.space, AT_BOARD, 'alice', { character: striker, inventory: carrying({ coins: COINS, worn: [CUDGEL] }) });
    world.space.handleAcceptQuest(BOARD, questId, alice.entityId);
    walk(world, alice.entityId, BESIDE_GHOST);
    // A Skeleton's 70 health takes a fourth cudgel swing.
    strike(world, GHOST, 4, alice.entityId);
    expect(progressOf(world.space, alice.entityId, questId)).toEqual([1]);
    awaitNextSkeleton(world);
    strike(world, 'monster:2', 4, alice.entityId);
    expect(progressOf(world.space, alice.entityId, questId)).toEqual([bounty.count]);

    world.space.handleTurnInQuest(BOARD, questId, alice.entityId);
    expect(progressOf(world.space, alice.entityId, questId)).toEqual([bounty.count]);
    walk(world, alice.entityId, AT_BOARD);
    const before = inventoryOf(world, alice.entityId);
    world.space.handleTurnInQuest(BOARD, questId, alice.entityId);
    world.space.handleTurnInQuest(BOARD, questId, alice.entityId);
    expect(questsOf(world.space, alice.entityId)).toEqual({ active: [], done: [questId] });
    const { coins, bag } = inventoryOf(world, alice.entityId);
    expect(coins).toBe(before.coins + bounty.reward.coins);
    // The space's loot rolls land at the top of every range, which a quest's own odds make rare.
    expect(bag.slice(before.bag.length).map(({ item }) => [item.tier, item.rarity])).toEqual([[bounty.reward.gear, 'magic']]);
  });

  it('with a full bag waits, granting nothing, until there is room', () => {
    const day = dayAsking('collect');
    const world = graveyardOn(day);
    const bounty = offered(day)[0]!;
    const questId = bountyIdOf(bounty);
    const caps = fullBag();
    const quests: QuestLog = { active: [{ questId, progress: [bounty.count], definition: bounty }], done: [] };
    const alice = attachPlayer(world.space, AT_BOARD, 'alice', { character: { quests }, inventory: carrying({ coins: COINS, bag: caps }) });
    world.space.handleTurnInQuest(BOARD, questId, alice.entityId);
    expect(questsOf(world.space, alice.entityId)).toEqual(quests);
    expect(inventoryOf(world, alice.entityId)).toEqual(carrying({ coins: COINS, bag: caps }));

    world.space.handleEquip(caps[0]!.id, undefined, alice.entityId);
    world.space.handleTurnInQuest(BOARD, questId, alice.entityId);
    expect(questsOf(world.space, alice.entityId)).toEqual({ active: [], done: [questId] });
    expect(inventoryOf(world, alice.entityId).coins).toBe(COINS + bounty.reward.coins);
    expect(inventoryOf(world, alice.entityId).bag).toHaveLength(SOMNIO_PROTOCOL_CONSTANTS.maxBagItems);
  });

  it("leaves a Skeleton's trophy for a dreamer gathering them for a bounty, which a pick-up counts", () => {
    const day = dayAsking('collect');
    const world = graveyardOn(day);
    const bounty = offered(day)[0]!;
    const questId = bountyIdOf(bounty);
    const { outbox, sent } = recordingOutbox();
    const alice = attachPlayer(world.space, BESIDE_GHOST, 'alice', {
      outbox,
      character: { ...striker, quests: { active: [{ questId, progress: [0], definition: bounty }], done: [] } },
      inventory: wearing(CUDGEL),
    });
    strike(world, GHOST, 4, alice.entityId);
    const trophy = payloads(sent, 'loot').find((loot) => loot.contents.kind === 'trophy');
    expect(trophy?.contents).toEqual({ kind: 'trophy', monsterKind: 'skeleton-minion' });
    walk(world, alice.entityId, { x: trophy!.x, z: trophy!.z });
    world.space.handlePickUp(trophy!.lootId, alice.entityId);
    expect(progressOf(world.space, alice.entityId, questId)).toEqual([1]);
  });
});
