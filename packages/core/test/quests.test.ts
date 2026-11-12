import { SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import { describe, expect, it } from 'vitest';
import { NO_LUCIDITY, TRIAL_QUESTS, teaching } from '../src/lucidity.ts';
import type { Lucidity } from '../src/lucidity.ts';
import {
  NO_QUESTS,
  QUEST_IDS,
  advancedQuests,
  collectsTrophy,
  drivesOff,
  forbidsStriking,
  gatedTeaching,
  markerFor,
  mayAccept,
  objectiveGoal,
  objectiveLines,
  quest,
  questComplete,
  questsMessage,
  questsOf,
  reachedAt,
  trialRole,
  trophyLabelKey,
  turnInFor,
  turnInGrant,
  withAccepted,
  withTurnedIn,
  withoutQuest,
} from '../src/quests.ts';
import type { QuestId, QuestLog, QuestObjective } from '../src/quests.ts';
import { bountyIdOf } from '../src/bounties.ts';
import type { Bounty } from '../src/bounties.ts';
import { ranks } from './support/ranks.ts';
import { outdoorSector } from './support/worldFixture.ts';

function lucidity(role: Lucidity['role'], held: Parameters<typeof ranks>[0] = {}): Lucidity {
  return { ...NO_LUCIDITY, role, ranks: ranks(held) };
}

function holding(...active: [QuestId, number[]][]): QuestLog {
  return { active: active.map(([questId, progress]) => ({ questId, progress })), done: [] };
}

describe('the quest table', () => {
  it("gives each trial at its master and to no need, and each gate at its master to its teaching's role", () => {
    for (const role of ['fighter', 'healer', 'mystic'] as const) {
      const trial = quest(TRIAL_QUESTS[role]);
      expect([trialRole(TRIAL_QUESTS[role]), trial.needs, trial.turnIn]).toEqual([role, undefined, trial.giver]);
    }
    for (const questId of QUEST_IDS) {
      const taught = gatedTeaching(questId);
      if (taught === undefined) continue;
      expect([quest(questId).needs, quest(questId).turnIn]).toEqual([{ role: teaching(taught).role }, quest(questId).giver]);
    }
  });

  it('fits every quest in a `quests` frame', () => {
    expect(QUEST_IDS.length).toBeLessThanOrEqual(SOMNIO_PROTOCOL_CONSTANTS.maxDoneQuests);
    for (const questId of QUEST_IDS) expect(quest(questId).objectives.length).toBeLessThanOrEqual(SOMNIO_PROTOCOL_CONSTANTS.maxQuestObjectives);
  });

  it('forbids striking under the Healer trial alone', () => {
    expect(QUEST_IDS.filter((questId) => forbidsStriking([{ questId }]))).toEqual(['healer-trial']);
    expect(forbidsStriking([])).toBe(false);
  });
});

describe('objectives', () => {
  const objective = (fields: object): QuestObjective => ({ labelKey: 'x', ...fields }) as QuestObjective;

  it('are met at their count, at their amount, or once done', () => {
    expect(
      [
        objective({ kind: 'driveOff', count: 3 }),
        objective({ kind: 'collect', monsterKind: 'ghost', count: 4 }),
        objective({ kind: 'mend', amount: 60 }),
        objective({ kind: 'visit', carrier: 'npc:A/b' }),
        objective({ kind: 'reach', sector: 'A' }),
      ].map(objectiveGoal),
    ).toEqual([3, 4, 60, 1, 1]);
  });

  it('count a nightmare driven off only of the kind and in the sector they name, when they name one', () => {
    const any = objective({ kind: 'driveOff', count: 1 });
    const ghostsHere = objective({ kind: 'driveOff', monsterKind: 'ghost', sector: 'Here', count: 1 });
    expect(drivesOff(any, 'skeleton-minion', 'There')).toBe(true);
    expect([drivesOff(ghostsHere, 'ghost', 'Here'), drivesOff(ghostsHere, 'ghost', 'There'), drivesOff(ghostsHere, 'skeleton-minion', 'Here')]).toEqual([
      true,
      false,
      false,
    ]);
    expect(drivesOff(objective({ kind: 'mend', amount: 1 }), 'ghost', 'Here')).toBe(false);
  });

  it("are reached anywhere in their sector, or within their place, measured from the sector's origin", () => {
    const glade = outdoorSector('Glade', { x: 100, z: 0 });
    const anywhere = objective({ kind: 'reach', sector: 'Glade' });
    const spot = objective({ kind: 'reach', sector: 'Glade', place: { x: 5, z: 5, radius: 2 } });
    expect(reachedAt(anywhere, glade, { x: 119, z: 19 })).toBe(true);
    expect([reachedAt(spot, glade, { x: 106.5, z: 5.5 }), reachedAt(spot, glade, { x: 103, z: 3 })]).toEqual([true, false]);
    expect(reachedAt(spot, outdoorSector('Other', { x: 100, z: 0 }), { x: 105, z: 5 })).toBe(false);
  });
});

describe('taking a quest on', () => {
  it.each<[string, QuestId, QuestLog, Lucidity, boolean]>([
    ['a trial with no role', 'fighter-trial', NO_QUESTS, NO_LUCIDITY, true],
    ['a trial with a role', 'healer-trial', NO_QUESTS, lucidity('fighter', { strike: 1 }), false],
    ["a trial while another master's is held", 'healer-trial', holding(['fighter-trial', [0]]), NO_LUCIDITY, false],
    ['a quest already held', 'fighter-trial', holding(['fighter-trial', [0]]), NO_LUCIDITY, false],
    ['a quest turned in before', 'follow-through-task', { active: [], done: ['follow-through-task'] }, lucidity('fighter', { strike: 2 }), false],
    ["a gate once its teaching's need is met", 'follow-through-task', NO_QUESTS, lucidity('fighter', { strike: 2 }), true],
    ["a gate while its teaching's need is unmet", 'follow-through-task', NO_QUESTS, lucidity('fighter', { strike: 1 }), false],
    ["a gate of another role's teaching", 'drawing-back-task', NO_QUESTS, lucidity('fighter', { touch: 2 }), false],
    ['a gate whose rank is held', 'follow-through-task', NO_QUESTS, lucidity('fighter', { strike: 2, 'follow-through': 1 }), false],
    ["the first of the priest's chain, which needs nothing", 'restless-graves', NO_QUESTS, NO_LUCIDITY, true],
    ['a quest whose needed quest is held, its objectives met', 'cracked-skulls', holding(['restless-graves', [4]]), NO_LUCIDITY, false],
    ['a quest whose needed quest is turned in', 'cracked-skulls', { active: [], done: ['restless-graves'] }, NO_LUCIDITY, true],
    ['a quest whose needed quest needs one turned in itself', 'into-the-crypt', { active: [], done: ['restless-graves'] }, NO_LUCIDITY, false],
    [
      "the last of the priest's chain, once the rest is turned in",
      'into-the-crypt',
      { active: [], done: ['restless-graves', 'cracked-skulls'] },
      NO_LUCIDITY,
      true,
    ],
  ])('is %s: %s', (_label, questId, log, held, accepted) => {
    expect(mayAccept(questId, log, held)).toBe(accepted);
  });

  it('is refused with the log full', () => {
    const full: QuestLog = {
      active: Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxActiveQuests }, () => ({ questId: 'restless-graves' as const, progress: [0] })),
      done: [],
    };
    expect(mayAccept('fighter-trial', full, NO_LUCIDITY)).toBe(false);
    expect(mayAccept('fighter-trial', { ...full, active: full.active.slice(1) }, NO_LUCIDITY)).toBe(true);
  });

  it('starts it with nothing done, and giving it up or turning it in takes it out of the log', () => {
    const taken = withAccepted(NO_QUESTS, 'mystic-trial');
    expect(taken).toEqual(holding(['mystic-trial', [0, 0, 0]]));
    expect(withoutQuest(taken, 'mystic-trial')).toEqual(NO_QUESTS);
    expect(withTurnedIn(taken, 'mystic-trial')).toEqual({ active: [], done: ['mystic-trial'] });
  });
});

describe('turning a quest in', () => {
  it('waits on every objective, and refuses a trial to a dreamer who has a role', () => {
    expect(turnInFor('mystic-trial', holding(['mystic-trial', [1, 0, 1]]), NO_LUCIDITY)).toBeUndefined();
    expect(questComplete({ questId: 'mystic-trial', progress: [1, 1, 1] })).toBe(true);
    expect(turnInFor('mystic-trial', holding(['mystic-trial', [1, 1, 1]]), NO_LUCIDITY)).toEqual({ questId: 'mystic-trial', progress: [1, 1, 1] });
    expect(turnInFor('fighter-trial', holding(['fighter-trial', [1]]), NO_LUCIDITY)).toBeDefined();
    expect(turnInFor('fighter-trial', holding(['fighter-trial', [1]]), lucidity('healer', { touch: 1 }))).toBeUndefined();
    expect(turnInFor('fighter-trial', NO_QUESTS, NO_LUCIDITY)).toBeUndefined();
  });

  it('grants a trial its role, its first teaching, and its item, a gate its teaching, and an inventory frame only for coins or an item', () => {
    const bounty: Bounty = { day: 3, land: 'Graveyard', monsterKind: 'skeleton-warrior', objective: 'collect', count: 4, reward: { coins: 120, gear: 3 } };
    expect(turnInGrant({ questId: 'healer-trial', progress: [1] })).toEqual({ role: 'healer', teaches: 'touch', trialItem: 'moonstone', paysInventory: true });
    expect(turnInGrant({ questId: 'mystic-trial', progress: [1, 1, 1] })).toEqual({ role: 'mystic', teaches: 'ward', trialItem: 'wand', paysInventory: true });
    // The Fighters' trial gives no item and pays nothing, so no `inventory` frame follows it.
    expect(turnInGrant({ questId: 'fighter-trial', progress: [1] })).toEqual({
      role: 'fighter',
      teaches: 'strike',
      trialItem: undefined,
      paysInventory: false,
    });
    expect(turnInGrant({ questId: 'follow-through-task', progress: [3] })).toEqual({
      role: undefined,
      teaches: 'follow-through',
      trialItem: undefined,
      paysInventory: false,
    });
    expect(turnInGrant({ questId: 'newcomer-errand', progress: [1, 1] })).toEqual({
      role: undefined,
      teaches: undefined,
      trialItem: undefined,
      paysInventory: true,
    });
    expect(turnInGrant({ questId: bountyIdOf(bounty), progress: [4], definition: bounty })).toEqual({
      role: undefined,
      teaches: undefined,
      trialItem: undefined,
      paysInventory: true,
    });
  });
});

describe('progress', () => {
  it('moves each objective of each quest held within its goal, and leaves the log as it was when nothing moved', () => {
    const log = holding(['mystic-trial', [1, 0, 0]], ['drawing-back-task', [50]]);
    const next = advancedQuests(log, (objective, progress) => (objective.kind === 'mend' ? progress + 30 : progress + 5));
    expect(next.active).toEqual([
      { questId: 'mystic-trial', progress: [1, 1, 1] },
      { questId: 'drawing-back-task', progress: [60] },
    ]);
    expect(advancedQuests(log, (_objective, progress) => progress)).toBe(log);
    expect(advancedQuests(log, () => -1).active.map((held) => held.progress)).toEqual([[0, 0, 0], [0]]);
  });

  it('collects a trophy only while a held quest still lacks some of its kind', () => {
    expect(collectsTrophy(holding(['cracked-skulls', [2]]), 'skeleton-warrior')).toBe(true);
    expect(collectsTrophy(holding(['cracked-skulls', [2]]), 'skeleton-minion')).toBe(false);
    expect(collectsTrophy(holding(['cracked-skulls', [3]]), 'skeleton-warrior')).toBe(false);
    expect(collectsTrophy(NO_QUESTS, 'skeleton-warrior')).toBe(false);
  });

  it("names each kind's trophy, and none of a kind this build does not know", () => {
    expect([trophyLabelKey('skeleton-warrior'), trophyLabelKey('dragon'), trophyLabelKey('toString')]).toEqual(['Cracked skull', undefined, undefined]);
  });
});

describe('the quests frame', () => {
  it('carries the log and reads it back without a quest this build does not know', () => {
    const log: QuestLog = { active: [{ questId: 'mystic-trial', progress: [1, 0, 1] }], done: ['fighter-trial'] };
    expect(questsOf(questsMessage(log, []))).toEqual(log);
    expect(questsOf({ active: [{ questId: 'bounty-hunt', progress: [0] }], done: ['bounty-hunt', 'fighter-trial'], bounties: [] })).toEqual({
      active: [],
      done: ['fighter-trial'],
    });
  });
});

describe('the lines a quest is said in', () => {
  it('say a single objective with its count toward the goal', () => {
    expect(objectiveLines(quest('drawing-back-task'), [22.5]).map(({ labelKey, done, goal }) => [labelKey, done, goal])).toEqual([
      ['Mend 60 health on other dreamers.', 22, 60],
    ]);
    expect(objectiveLines(quest('cracked-skulls'), []).map(({ done, goal }) => [done, goal])).toEqual([[0, 3]]);
  });

  it("merge a run said by one line into how many of it are met, as a trial's hidden places", () => {
    const [places] = objectiveLines(quest('mystic-trial'), [1, 0, 1]);
    expect([objectiveLines(quest('mystic-trial'), [1, 0, 1]).length, places!.done, places!.goal, places!.objectives.length]).toEqual([1, 2, 3, 3]);
  });
});

describe('the marker over a carrier', () => {
  const pugnax = { id: quest('fighter-trial').giver };

  it('offers what the carrier gives a dreamer who may take it on', () => {
    expect(markerFor(pugnax, NO_QUESTS, NO_LUCIDITY, [])).toBe('offer');
    expect(markerFor(pugnax, NO_QUESTS, lucidity('fighter', { strike: 2 }), [])).toBe('offer');
    expect(markerFor(pugnax, NO_QUESTS, lucidity('fighter', { strike: 1 }), [])).toBeUndefined();
    expect(markerFor(pugnax, NO_QUESTS, lucidity('healer', { touch: 1 }), [])).toBeUndefined();
    expect(markerFor(pugnax, holding(['healer-trial', [0]]), NO_LUCIDITY, [])).toBeUndefined();
  });

  it('asks for the turn-in once every objective of a quest held is met, before any offer', () => {
    expect(markerFor(pugnax, holding(['fighter-trial', [1]]), NO_LUCIDITY, [])).toBe('turnIn');
    expect(markerFor(pugnax, holding(['follow-through-task', [3]]), lucidity('fighter', { strike: 2 }), [])).toBe('turnIn');
  });

  it('shows where to return a quest held that is not finished yet', () => {
    expect(markerFor(pugnax, holding(['fighter-trial', [0]]), NO_LUCIDITY, [])).toBe('inProgress');
    expect(markerFor(pugnax, holding(['follow-through-task', [1]]), lucidity('fighter', { strike: 2 }), [])).toBe('inProgress');
    expect(markerFor({ id: quest('healer-trial').turnIn }, holding(['fighter-trial', [0]]), NO_LUCIDITY, [])).toBeUndefined();
  });

  it('shows nothing over a carrier that gives and takes nothing', () => {
    expect(markerFor({ id: 'npc:EdariaShop/mercus', service: 'shopkeeper' }, NO_QUESTS, NO_LUCIDITY, [])).toBeUndefined();
  });
});
