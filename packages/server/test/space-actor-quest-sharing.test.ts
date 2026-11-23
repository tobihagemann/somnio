import { describe, expect, it } from 'vitest';
import { NO_QUESTS, OUTDOOR_SPACE_ID, QUEST_IDS, boardTurnsAt, bountyIdOf, quest } from '@somnio/core';
import type { Character, Inventory, Point, QuestId, QuestLog } from '@somnio/core';
import { STARTER_SECTOR } from '@somnio/data';
import { WorldRouter } from '../src/world/worldRouter.ts';
import type { SpaceActor } from '../src/world/spaceActor.ts';
import { DAY, dayAsking, noon, offered } from './support/bountyBoard.ts';
import {
  BESIDE_GHOST,
  COINS,
  CUDGEL,
  GHOST,
  GHOST_AT,
  MOONSTONE,
  STRIKER,
  arena,
  carrying,
  characterOf,
  energy,
  engage,
  face,
  lucidity,
  payloads,
  wearing,
} from './support/combat.ts';
import { recordingOutbox } from './support/frames.ts';
import { testLogger } from './support/logger.ts';
import { attachPlayer, makeMonsterSpawn, makeNPC, makeSector, makeWorld } from './support/sectorFactory.ts';
import { StubCharacterRepository } from './support/stubRepositories.ts';

const MEMOR = 'npc:Graveyard/memor';
const AT_MEMOR: Point = { x: 16, z: 18 };
const BOARD = 'fixture:Graveyard/fixture-1';
/** Within speaking distance of the board and the share radius of the Skeleton, outside its notice. */
const BESIDE_BOARD: Point = { x: 10, z: 15 };
/** Where a sharer stands in the north of the Graveyard, far from the Skeleton. */
const AT: Point = { x: 2, z: 2 };
/** Out of a said line's reach of `AT`, within it of a dreamer standing a metre east of it. */
const BEYOND_ALICE: Point = { x: 14.5, z: 2 };

/**
 * The Graveyard at noon of the board's day: a Skeleton standing at `GHOST_AT`, Memor by its church,
 * and the bounty board just south of the Skeleton.
 */
function graveyard(day: number = DAY) {
  const world = arena({
    name: 'Graveyard',
    npcs: [makeNPC('memor', { x: 16, z: 17 }, {})],
    monsterSpawns: [{ ...makeMonsterSpawn(GHOST_AT), kind: 'skeleton-minion' }],
    placements: [{ id: 'notice-board-1', modelId: 'notice-board', x: 10, z: 13.5, yaw: 0, elevation: 0 }],
    fixtures: [{ id: 'fixture-1', placement: 'notice-board-1', service: 'bountyBoard' }],
  });
  world.wall.ms = noon(day);
  return world;
}

/** A dreamer attached at `at` whose every frame the test reads. */
function dreamer(
  space: SpaceActor,
  at: Point,
  name: string,
  character: Partial<Pick<Character, 'energy' | 'lucidity' | 'quests'>> = {},
  inventory?: Inventory,
) {
  const { outbox, sent } = recordingOutbox();
  const { entityId } = attachPlayer(space, at, name, { outbox, character, ...(inventory === undefined ? {} : { inventory }) });
  return { entityId, sent };
}

type Dreamer = ReturnType<typeof dreamer>;

/** A log holding the quest, with that much done toward each of its objectives. */
function holding(questId: QuestId, progress: number[], done: QuestId[] = []): QuestLog {
  return { active: [{ questId, progress }], done };
}

/** A log with no room left, holding none of Memor's first two quests. */
const FULL_LOG: QuestLog = {
  active: QUEST_IDS.filter((questId) => questId !== 'restless-graves' && questId !== 'cracked-skulls')
    .slice(0, 10)
    .map((questId) => ({ questId, progress: quest(questId).objectives.map(() => 0) })),
  done: [],
};

const questsOf = (space: SpaceActor, { entityId }: Dreamer): QuestLog => characterOf(space, entityId).quests;
const offerIdOf = ({ sent }: Dreamer): number => payloads(sent, 'questOffer').at(-1)!.offerId;
const answersTo = ({ sent }: Dreamer) => payloads(sent, 'questShareAnswer');

describe('sharing a quest', () => {
  it("offers it to each other standing dreamer within a said line's reach, and tells the sharer how many it reached", () => {
    const { space } = graveyard();
    const alice = dreamer(space, AT, 'alice', { quests: holding('restless-graves', [1]) });
    const near = dreamer(space, { x: 13.9, z: 2 }, 'near');
    const far = dreamer(space, { x: 14.1, z: 2 }, 'far');
    const fallen = dreamer(space, { x: 4, z: 2 }, 'fallen', { energy: energy({ healthCurrent: 0 }) });
    space.handleShareQuest('restless-graves', alice.entityId);
    expect(payloads(alice.sent, 'questShared')).toEqual([{ reached: 1 }]);
    expect(payloads(near.sent, 'questOffer')).toEqual([{ offerId: expect.any(Number), fromName: 'alice', questId: 'restless-graves' }]);
    expect([...payloads(far.sent, 'questOffer'), ...payloads(fallen.sent, 'questOffer')]).toEqual([]);
  });

  it('is dropped from a sharer who lies fallen, holds no such quest, holds it as a trial, or holds a bounty of the day the board does not offer', () => {
    const { space } = graveyard();
    const stray = { ...offered(DAY)[0]!, monsterKind: 'ghost' } as const;
    const fallen = dreamer(space, AT, 'fallen', { quests: holding('restless-graves', [1]), energy: energy({ healthCurrent: 0 }) });
    const trial = dreamer(space, { x: 3, z: 2 }, 'trial', { quests: holding('fighter-trial', [0]) });
    const near = dreamer(space, { x: 4, z: 2 }, 'near');
    const unboarded = dreamer(space, { x: 5, z: 2 }, 'unboarded', {
      quests: { active: [{ questId: bountyIdOf(stray), progress: [1], definition: stray }], done: [] },
    });
    space.handleShareQuest('restless-graves', fallen.entityId);
    space.handleShareQuest('restless-graves', near.entityId);
    space.handleShareQuest('fighter-trial', trial.entityId);
    space.handleShareQuest(bountyIdOf(stray), unboarded.entityId);
    expect(
      [fallen, trial, near, unboarded].flatMap(({ sent }) =>
        sent.filter(({ tag }) => tag === 'questShared' || tag === 'questOffer' || tag === 'questShareAnswer'),
      ),
    ).toEqual([]);
  });

  it('answers at once for each dreamer who cannot take it on: one holding it, one who turned it in, one whose log is full, and one who may not take it yet; and counts only those offered it, ahead of the answers', () => {
    const { space } = graveyard();
    const alice = dreamer(space, AT, 'alice', { quests: holding('cracked-skulls', [1], ['restless-graves']) });
    dreamer(space, { x: 3, z: 2 }, 'holder', { quests: holding('cracked-skulls', [0], ['restless-graves']) });
    dreamer(space, { x: 4, z: 2 }, 'finished', { quests: { active: [], done: ['restless-graves', 'cracked-skulls'] } });
    dreamer(space, { x: 5, z: 2 }, 'full', { quests: FULL_LOG });
    dreamer(space, { x: 6, z: 2 }, 'early');
    const ready = dreamer(space, { x: 7, z: 2 }, 'ready', { quests: { active: [], done: ['restless-graves'] } });
    space.handleShareQuest('cracked-skulls', alice.entityId);
    expect(payloads(alice.sent, 'questShared')).toEqual([{ reached: 1 }]);
    expect(alice.sent.map(({ tag }) => tag).filter((tag) => tag === 'questShared' || tag === 'questShareAnswer')).toEqual([
      'questShared',
      ...Array<string>(4).fill('questShareAnswer'),
    ]);
    expect(answersTo(alice)).toEqual([
      { questId: 'cracked-skulls', name: 'holder', outcome: 'holds' },
      { questId: 'cracked-skulls', name: 'finished', outcome: 'done' },
      { questId: 'cracked-skulls', name: 'full', outcome: 'logFull' },
      { questId: 'cracked-skulls', name: 'early', outcome: 'cannotYet' },
    ]);
    expect(payloads(ready.sent, 'questOffer')).toHaveLength(1);
  });

  it('tells the sharer no count when every dreamer near was answered for, so the answers speak alone', () => {
    const { space } = graveyard();
    const alice = dreamer(space, AT, 'alice', { quests: holding('restless-graves', [1]) });
    dreamer(space, { x: 3, z: 2 }, 'holder', { quests: holding('restless-graves', [0]) });
    space.handleShareQuest('restless-graves', alice.entityId);
    expect(payloads(alice.sent, 'questShared')).toEqual([]);
    expect(answersTo(alice)).toEqual([{ questId: 'restless-graves', name: 'holder', outcome: 'holds' }]);
  });

  it('takes the quest on from its start when taken, and tells the sharer; lets it pass when not, and tells them too, once each', () => {
    const { space } = graveyard();
    const alice = dreamer(space, AT, 'alice', { quests: holding('restless-graves', [3]) });
    const bob = dreamer(space, { x: 3, z: 2 }, 'bob');
    const carol = dreamer(space, { x: 4, z: 2 }, 'carol');
    space.handleShareQuest('restless-graves', alice.entityId);
    space.handleAnswerQuestOffer(offerIdOf(bob), true, bob.entityId);
    space.handleAnswerQuestOffer(offerIdOf(carol), false, carol.entityId);
    space.handleAnswerQuestOffer(offerIdOf(carol), true, carol.entityId);
    expect([questsOf(space, bob), questsOf(space, carol)]).toEqual([holding('restless-graves', [0]), NO_QUESTS]);
    expect(answersTo(alice)).toEqual([
      { questId: 'restless-graves', name: 'bob', outcome: 'took' },
      { questId: 'restless-graves', name: 'carol', outcome: 'didNotTake' },
    ]);
  });

  it('checks the quest again as it is taken, and ends the offer as the check says', () => {
    const { space } = graveyard();
    const alice = dreamer(space, { x: 14, z: 18 }, 'alice', { quests: holding('restless-graves', [3]) });
    const bob = dreamer(space, AT_MEMOR, 'bob');
    space.handleShareQuest('restless-graves', alice.entityId);
    space.handleAcceptQuest(MEMOR, 'restless-graves', bob.entityId);
    space.handleAnswerQuestOffer(offerIdOf(bob), true, bob.entityId);
    expect(questsOf(space, bob)).toEqual(holding('restless-graves', [0]));
    expect(answersTo(alice)).toEqual([{ questId: 'restless-graves', name: 'bob', outcome: 'holds' }]);
  });

  it('checks a bounty again as it is taken, and ends the offer as the check says', () => {
    const { space } = graveyard();
    const bounty = offered(DAY)[0]!;
    const questId = bountyIdOf(bounty);
    const alice = dreamer(space, { x: 8, z: 15 }, 'alice', { quests: { active: [{ questId, progress: [1], definition: bounty }], done: [] } });
    const bob = dreamer(space, BESIDE_BOARD, 'bob');
    space.handleShareQuest(questId, alice.entityId);
    space.handleAcceptQuest(BOARD, questId, bob.entityId);
    space.handleAnswerQuestOffer(offerIdOf(bob), true, bob.entityId);
    expect(questsOf(space, bob)).toEqual({ active: [{ questId, progress: [0], definition: bounty }], done: [] });
    expect(answersTo(alice)).toEqual([{ questId, name: 'bob', outcome: 'holds' }]);
  });

  it("shares a bounty the board offers today, which is taken on by the day's definition", () => {
    const { space } = graveyard();
    const bounty = offered(DAY)[0]!;
    const questId = bountyIdOf(bounty);
    const alice = dreamer(space, AT, 'alice', { quests: { active: [{ questId, progress: [1], definition: bounty }], done: [] } });
    const bob = dreamer(space, { x: 3, z: 2 }, 'bob');
    space.handleShareQuest(questId, alice.entityId);
    space.handleAnswerQuestOffer(offerIdOf(bob), true, bob.entityId);
    expect(questsOf(space, bob)).toEqual({ active: [{ questId, progress: [0], definition: bounty }], done: [] });
    expect(answersTo(alice)).toEqual([{ questId, name: 'bob', outcome: 'took' }]);
  });

  it("ends a bounty's offer untaken as the board turns, so an answer after takes nothing on, and leaves an offer of a quest waiting", () => {
    const world = graveyard();
    const questId = bountyIdOf(offered(DAY)[0]!);
    const alice = dreamer(world.space, AT, 'alice', { quests: { active: [{ questId, progress: [1], definition: offered(DAY)[0]! }], done: [] } });
    const bob = dreamer(world.space, { x: 3, z: 2 }, 'bob');
    const carol = dreamer(world.space, BEYOND_ALICE, 'carol');
    const dave = dreamer(world.space, { x: 15.5, z: 2 }, 'dave', { quests: holding('restless-graves', [1]) });
    world.wall.ms = boardTurnsAt(DAY) - 10_000;
    world.space.handleShareQuest(questId, alice.entityId);
    world.space.handleShareQuest('restless-graves', dave.entityId);
    world.wall.ms = boardTurnsAt(DAY);
    world.space.step(0);
    expect([answersTo(alice), answersTo(dave)]).toEqual([[{ questId, name: 'bob', outcome: 'didNotTake' }], []]);
    world.space.handleAnswerQuestOffer(offerIdOf(bob), true, bob.entityId);
    world.space.handleAnswerQuestOffer(offerIdOf(carol), true, carol.entityId);
    expect([questsOf(world.space, bob), questsOf(world.space, carol).active]).toEqual([NO_QUESTS, [{ questId: 'restless-graves', progress: [0] }]]);
    expect(answersTo(alice)).toHaveLength(1);
  });

  it('leaves a dreamer this sharer already offered the quest to as they are, and tells the sharer no count while that dreamer alone stands near', () => {
    const { space } = graveyard();
    const alice = dreamer(space, AT, 'alice', { quests: holding('restless-graves', [1]) });
    const bob = dreamer(space, { x: 3, z: 2 }, 'bob');
    space.handleShareQuest('restless-graves', alice.entityId);
    space.handleShareQuest('restless-graves', alice.entityId);
    expect(payloads(alice.sent, 'questShared')).toEqual([{ reached: 1 }]);
    expect(payloads(bob.sent, 'questOffer')).toHaveLength(1);
    expect(answersTo(alice)).toEqual([]);
  });

  it('tells the sharer it reached no one while no other standing dreamer stands near', () => {
    const { space } = graveyard();
    const alice = dreamer(space, AT, 'alice', { quests: holding('restless-graves', [1]) });
    dreamer(space, { x: 3, z: 2 }, 'fallen', { energy: energy({ healthCurrent: 0 }) });
    dreamer(space, BEYOND_ALICE, 'far');
    space.handleShareQuest('restless-graves', alice.entityId);
    expect(payloads(alice.sent, 'questShared')).toEqual([{ reached: 0 }]);
  });

  it('never gives two offers in the world one id, across its spaces', () => {
    const router = WorldRouter.create(makeWorld([makeSector()]), new StubCharacterRepository(), testLogger());
    const ids = [OUTDOOR_SPACE_ID, router.world.sectorSpace.get(STARTER_SECTOR)!].map((spaceId) => {
      const space = router.space(spaceId)!;
      const sharer = attachPlayer(space, { x: 4, z: 5 }, `sharer-${spaceId}`, { spaceId, character: { quests: holding('restless-graves', [1]) } });
      const { outbox, sent } = recordingOutbox();
      attachPlayer(space, { x: 6, z: 5 }, `bob-${spaceId}`, { spaceId, outbox });
      space.handleShareQuest('restless-graves', sharer.entityId);
      return payloads(sent, 'questOffer')[0]!.offerId;
    });
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe('a quest offer', () => {
  it('ends untaken in the step that finds its 30 s passed, and an answer after that changes nothing', () => {
    const world = graveyard();
    const alice = dreamer(world.space, AT, 'alice', { quests: holding('restless-graves', [1]) });
    const bob = dreamer(world.space, { x: 3, z: 2 }, 'bob');
    world.space.handleShareQuest('restless-graves', alice.entityId);
    world.clock.ms += 29_999;
    world.space.step(0);
    expect(answersTo(alice)).toEqual([]);
    world.clock.ms += 1;
    world.space.step(0);
    world.space.handleAnswerQuestOffer(offerIdOf(bob), true, bob.entityId);
    expect(questsOf(world.space, bob)).toEqual(NO_QUESTS);
    expect(answersTo(alice)).toEqual([{ questId: 'restless-graves', name: 'bob', outcome: 'didNotTake' }]);
  });

  it('answered past its 30 s with no step between, ends untaken and takes nothing on', () => {
    const world = graveyard();
    const alice = dreamer(world.space, AT, 'alice', { quests: holding('restless-graves', [1]) });
    const bob = dreamer(world.space, { x: 3, z: 2 }, 'bob');
    world.space.handleShareQuest('restless-graves', alice.entityId);
    world.clock.ms += 30_000;
    world.space.handleAnswerQuestOffer(offerIdOf(bob), true, bob.entityId);
    world.space.step(0);
    expect(questsOf(world.space, bob)).toEqual(NO_QUESTS);
    expect(answersTo(alice)).toEqual([{ questId: 'restless-graves', name: 'bob', outcome: 'didNotTake' }]);
  });

  it('ends untaken when another dreamer shares a quest with the same dreamer', () => {
    const { space } = graveyard();
    const alice = dreamer(space, AT, 'alice', { quests: holding('restless-graves', [1]) });
    const carol = dreamer(space, BEYOND_ALICE, 'carol', { quests: holding('restless-graves', [2]) });
    const bob = dreamer(space, { x: 3, z: 2 }, 'bob');
    space.handleShareQuest('restless-graves', alice.entityId);
    space.handleShareQuest('restless-graves', carol.entityId);
    expect(answersTo(alice)).toEqual([{ questId: 'restless-graves', name: 'bob', outcome: 'didNotTake' }]);
    expect(payloads(bob.sent, 'questOffer').map(({ fromName }) => fromName)).toEqual(['alice', 'carol']);
  });

  it('is settled only by an answer naming it, so one naming the offer it replaced leaves it waiting', () => {
    const { space } = graveyard();
    const alice = dreamer(space, AT, 'alice', { quests: holding('restless-graves', [1]) });
    const carol = dreamer(space, BEYOND_ALICE, 'carol', { quests: holding('restless-graves', [2]) });
    const bob = dreamer(space, { x: 3, z: 2 }, 'bob');
    space.handleShareQuest('restless-graves', alice.entityId);
    const replaced = offerIdOf(bob);
    space.handleShareQuest('restless-graves', carol.entityId);
    space.handleAnswerQuestOffer(replaced, true, bob.entityId);
    expect(questsOf(space, bob)).toEqual(NO_QUESTS);
    expect(answersTo(carol)).toEqual([]);
    space.handleAnswerQuestOffer(offerIdOf(bob), true, bob.entityId);
    expect(questsOf(space, bob)).toEqual(holding('restless-graves', [0]));
    expect(answersTo(carol)).toEqual([{ questId: 'restless-graves', name: 'bob', outcome: 'took' }]);
  });

  it('ends untaken when its dreamer goes through a door', () => {
    const { space } = graveyard();
    const alice = dreamer(space, AT, 'alice', { quests: holding('restless-graves', [1]) });
    const bob = dreamer(space, { x: 3, z: 2 }, 'bob');
    space.handleShareQuest('restless-graves', alice.entityId);
    space.handOver(bob.entityId, false);
    expect(answersTo(alice)).toEqual([{ questId: 'restless-graves', name: 'bob', outcome: 'didNotTake' }]);
  });

  it('is taken all the same once its sharer has gone through a door, who is told nothing', () => {
    const { space } = graveyard();
    const alice = dreamer(space, AT, 'alice', { quests: holding('restless-graves', [1]) });
    const bob = dreamer(space, { x: 3, z: 2 }, 'bob');
    space.handleShareQuest('restless-graves', alice.entityId);
    space.handOver(alice.entityId, false);
    space.handleAnswerQuestOffer(offerIdOf(bob), true, bob.entityId);
    expect(questsOf(space, bob)).toEqual(holding('restless-graves', [0]));
    expect(answersTo(alice)).toEqual([]);
  });

  it('ends untaken in the step that finds its 30 s passed once its sharer has gone through a door', () => {
    const world = graveyard();
    const alice = dreamer(world.space, AT, 'alice', { quests: holding('restless-graves', [1]) });
    const bob = dreamer(world.space, { x: 3, z: 2 }, 'bob');
    world.space.handleShareQuest('restless-graves', alice.entityId);
    world.space.handOver(alice.entityId, false);
    world.clock.ms += 30_000;
    world.space.step(0);
    // Back within its seconds, the answer would take the offer on had the step not ended it.
    world.clock.ms -= 30_000;
    world.space.handleAnswerQuestOffer(offerIdOf(bob), true, bob.entityId);
    expect(questsOf(world.space, bob)).toEqual(NO_QUESTS);
  });

  it('ends untaken when its dreamer falls, an answer to it changes nothing, and once raised they can be offered the quest again', () => {
    const { space, steps } = arena();
    const alice = dreamer(space, BESIDE_GHOST, 'alice', { energy: energy({ healthCurrent: 9 }) });
    // In the Ghost's reach as well as in Alice's touch, where it fights the Healer.
    const healer = dreamer(space, { x: 10.5, z: 10.5 }, 'healer', { lucidity: lucidity('healer', { touch: 2, 'drawing-back': 1 }) }, wearing(MOONSTONE));
    const bob = dreamer(space, { x: 10, z: 19 }, 'bob', { quests: holding('restless-graves', [1]) });
    space.handleShareQuest('restless-graves', bob.entityId);
    const fallenOffer = offerIdOf(alice);
    steps(1);
    expect(space.isFallen(alice.entityId)).toBe(true);
    space.handleAnswerQuestOffer(fallenOffer, true, alice.entityId);
    expect(questsOf(space, alice)).toEqual(NO_QUESTS);
    expect(answersTo(bob)).toEqual([{ questId: 'restless-graves', name: 'alice', outcome: 'didNotTake' }]);

    engage(space, alice.entityId, healer.entityId);
    steps(140);
    expect(space.isFallen(alice.entityId)).toBe(false);
    space.handleShareQuest('restless-graves', bob.entityId);
    expect(payloads(alice.sent, 'questOffer').map(({ offerId }) => offerId)).toEqual([fallenOffer, expect.any(Number)]);
    expect(offerIdOf(alice)).not.toBe(fallenOffer);
  });

  it('once taken, pays each holder in full at its own turn-in', () => {
    const day = dayAsking('driveOff');
    const world = graveyard(day);
    const bounty = offered(day)[0]!;
    const questId = bountyIdOf(bounty);
    const alice = dreamer(
      world.space,
      BESIDE_GHOST,
      'alice',
      { ...STRIKER, quests: { active: [{ questId, progress: [0], definition: bounty }], done: [] } },
      carrying({ coins: COINS, worn: [CUDGEL] }),
    );
    const bob = dreamer(world.space, BESIDE_BOARD, 'bob', {}, carrying({ coins: COINS }));
    world.space.handleShareQuest(questId, alice.entityId);
    world.space.handleAnswerQuestOffer(offerIdOf(bob), true, bob.entityId);
    // A Skeleton's 70 health takes a fourth cudgel swing; Bob stands within the share radius of each.
    strike(world, GHOST, alice.entityId);
    world.steps(Math.ceil(45 / 0.05) + 1);
    strike(world, 'monster:2', alice.entityId);
    expect([alice, bob].map((holder) => questsOf(world.space, holder).active[0]!.progress)).toEqual([[bounty.count], [bounty.count]]);

    world.clock.ms += 2000;
    world.space.handleMove({ x: 10, z: 11.6, facing: 0, gait: 'jog' }, alice.entityId);
    const inventoryOf = (holder: Dreamer): Inventory => world.space.snapshotForPlayer(holder.entityId)!.inventory;
    const before = [alice, bob].map(inventoryOf);
    for (const holder of [alice, bob]) world.space.handleTurnInQuest(BOARD, questId, holder.entityId);
    [alice, bob].forEach((holder, index) => {
      expect(questsOf(world.space, holder)).toEqual({ active: [], done: [questId] });
      const { coins, bag } = inventoryOf(holder);
      expect(coins).toBe(before[index]!.coins + bounty.reward.coins);
      expect(bag.map(({ item }) => [item.tier, item.rarity])).toEqual([[bounty.reward.gear, 'magic']]);
    });
  });
});

/** The striker, standing in reach of `GHOST_AT`, swings at the nightmare standing there once a second, four times. */
function strike(world: ReturnType<typeof graveyard>, nightmare: string, striker: string): void {
  face(world.space, striker, GHOST_AT);
  engage(world.space, nightmare, striker);
  for (let swing = 0; swing < 4; swing += 1) {
    world.space.step(0);
    world.clock.ms += 1000;
  }
}
