import { SOMNIO_PROTOCOL_CONSTANTS, decodeSomnioMessage, encodeSomnioMessage } from '@somnio/protocol';
import { describe, expect, it } from 'vitest';
import {
  BOUNTY_BOARD,
  BOUNTY_KINDS,
  boardDay,
  boardTurnsAt,
  bountyFromJSON,
  bountyIdOf,
  bountyLands,
  bountyOf,
  bountyQuest,
  dayBounties,
  isBountyId,
  isBountyKindId,
} from '../src/bounties.ts';
import type { Bounty, BountyLand } from '../src/bounties.ts';
import { NO_LUCIDITY } from '../src/lucidity.ts';
import { MONSTER_KIND_IDS, bossMoves } from '../src/monsterKinds.ts';
import {
  NO_QUESTS,
  advancedQuests,
  bountiesOf,
  collectsTrophy,
  drivesOff,
  markerFor,
  mayTakeBounty,
  questComplete,
  questsMessage,
  questsOf,
  turnInFor,
  withAcceptedBounty,
  withTurnedIn,
} from '../src/quests.ts';
import type { QuestLog } from '../src/quests.ts';
import { loadSectorFixtures } from './support/sectorFixture.ts';

const DAY = boardDay(Date.UTC(2026, 10, 16));

const GRAVEYARD: Bounty = { day: DAY, land: 'Graveyard', monsterKind: 'skeleton-warrior', objective: 'collect', count: 4, reward: { coins: 120, gear: 3 } };
const ARENA: Bounty = { day: DAY, land: 'EdariaArena', monsterKind: 'ghost', objective: 'driveOff', count: 6, reward: { coins: 72 } };

const board = { id: 'fixture:EdariaSquare/fixture-1', service: 'bountyBoard' } as const;

/** Whether one nightmare driven off, or one trophy picked up, would advance both bounties. */
function clash(a: Bounty, b: Bounty): boolean {
  return a.monsterKind === b.monsterKind && (a.objective === 'collect' || b.objective === 'collect' || a.land === b.land);
}

function ghostLand(name: string): BountyLand {
  return { name, kinds: [{ kind: 'ghost', alive: 3 }] };
}

describe("the board's day", () => {
  it('is the UTC day, and turns at the next 00:00 UTC', () => {
    expect([boardDay(Date.UTC(2026, 10, 16, 23, 59, 59, 999)), boardDay(Date.UTC(2026, 10, 17))]).toEqual([DAY, DAY + 1]);
    expect(boardTurnsAt(DAY)).toBe(Date.UTC(2026, 10, 17));
  });
});

describe('the lands', () => {
  it('are the committed sectors keeping nightmares alive, outdoors and in, but not the boss chamber, with how many of each kind they keep', () => {
    expect(bountyLands(loadSectorFixtures())).toEqual([
      {
        name: 'AutumnWood',
        kinds: [
          { kind: 'boar', alive: 3 },
          { kind: 'bogey', alive: 1 },
          { kind: 'wolf', alive: 4 },
        ],
      },
      { name: 'EdariaArena', kinds: [{ kind: 'ghost', alive: 3 }] },
      {
        name: 'Graveyard',
        kinds: [
          { kind: 'skeleton-minion', alive: 4 },
          { kind: 'skeleton-warrior', alive: 2 },
        ],
      },
      {
        name: 'GraveyardCrypt',
        kinds: [
          { kind: 'skeleton-minion', alive: 3 },
          { kind: 'skeleton-warrior', alive: 2 },
        ],
      },
      { name: 'NorthMeadow', kinds: [{ kind: 'ghost', alive: 3 }] },
      {
        name: 'NorthWood',
        kinds: [
          { kind: 'bogey', alive: 1 },
          { kind: 'wolf', alive: 4 },
        ],
      },
      { name: 'SouthMeadow', kinds: [{ kind: 'ghost', alive: 3 }] },
      { name: 'WestMeadow', kinds: [{ kind: 'ghost', alive: 3 }] },
    ]);
  });

  it('name every kind but a boss, each with a trophy to gather', () => {
    expect(MONSTER_KIND_IDS.filter(isBountyKindId)).toEqual(MONSTER_KIND_IDS.filter((kind) => bossMoves(kind) === undefined));
    expect(Object.keys(BOUNTY_KINDS)).toEqual(MONSTER_KIND_IDS.filter(isBountyKindId));
  });
});

describe('the bounties of a day', () => {
  const lands = bountyLands(loadSectorFixtures());
  const days = Array.from({ length: 1000 }, (_, index) => DAY + index);

  it('are three from three different lands, the same for every reading of the same day and lands', () => {
    const bounties = dayBounties(DAY, lands);
    expect(bounties).toHaveLength(3);
    expect(new Set(bounties.map(({ land }) => land)).size).toBe(3);
    expect(bounties.every((bounty) => bounty.day === DAY && lands.some(({ name }) => name === bounty.land))).toBe(true);
    expect(dayBounties(DAY, structuredClone(lands))).toEqual(bounties);
  });

  it('turn over from day to day, the lands with them', () => {
    const boards = days.slice(0, 8).map((day) =>
      dayBounties(day, lands)
        .map(({ land }) => land)
        .sort()
        .join(),
    );
    expect(new Set(boards).size).toBeGreaterThan(1);
  });

  it('never hold two that one nightmare driven off or one trophy picked up advances together', () => {
    const clashing = days.flatMap((day) => {
      const bounties = dayBounties(day, lands);
      return bounties.flatMap((a, index) => bounties.slice(index + 1).flatMap((b) => (clash(a, b) ? [[a, b]] : [])));
    });
    expect(clashing).toEqual([]);
  });

  it("turn a collect into a drive-off when another of the day's lands rolled the same kind, and leave it when none did", () => {
    const day = days.find((candidate) => dayBounties(candidate, [ghostLand('Barrow')])[0]!.objective === 'collect');
    expect(day).toBeDefined();
    const sameKind = dayBounties(day!, [ghostLand('Barrow'), ghostLand('Fen')]);
    expect(sameKind.find(({ land }) => land === 'Barrow')?.objective).toBe('driveOff');
    const otherKind = dayBounties(day!, [ghostLand('Barrow'), { name: 'Fen', kinds: [{ kind: 'skeleton-warrior', alive: 2 }] }]);
    expect(otherKind.find(({ land }) => land === 'Barrow')?.objective).toBe('collect');
  });

  it('are as many as the lands, three at most', () => {
    const many = Array.from({ length: 6 }, (_, index) => ghostLand(`Land${index}`));
    expect([0, 1, 2, 3, 6].map((count) => dayBounties(DAY, many.slice(0, count)).length)).toEqual([0, 1, 2, 3, 3]);
  });

  it("ask twice what the land keeps alive of the kind, at most ten, pay the kind's bounty for each, and about one in four an item at the land's highest tier", () => {
    const land: BountyLand = {
      name: 'Barrow',
      kinds: [
        { kind: 'ghost', alive: 2 },
        { kind: 'skeleton-warrior', alive: 9 },
      ],
    };
    const asked = days.map((day) => dayBounties(day, [land])[0]!);
    expect(asked.find((bounty) => bounty.monsterKind === 'ghost')).toMatchObject({ count: 4, reward: { coins: 48 } });
    expect(asked.find((bounty) => bounty.monsterKind === 'skeleton-warrior')).toMatchObject({ count: 10, reward: { coins: 300 } });
    expect(new Set(asked.map(({ objective }) => objective))).toEqual(new Set(['driveOff', 'collect']));
    expect(new Set(asked.map(({ reward }) => reward.gear))).toEqual(new Set([undefined, 3]));
    expect(asked.filter(({ reward }) => reward.gear !== undefined).length / asked.length).toBeCloseTo(0.25, 1);
  });
});

describe('a bounty', () => {
  it('is a quest given and taken by any bounty board, asking a drive-off in its land or trophies from anywhere', () => {
    expect(bountyQuest(ARENA)).toEqual({
      labelKey: 'Bounty: %@',
      giver: BOUNTY_BOARD,
      turnIn: BOUNTY_BOARD,
      objectives: [{ kind: 'driveOff', count: 6, monsterKind: 'ghost', sector: 'EdariaArena', labelKey: 'Drive off %@ Ghosts there.' }],
      reward: { coins: 72 },
    });
    const [driveOff] = bountyQuest(ARENA).objectives;
    expect([drivesOff(driveOff!, 'ghost', 'EdariaArena'), drivesOff(driveOff!, 'ghost', 'NorthWood')]).toEqual([true, false]);
    expect(bountyQuest(GRAVEYARD).objectives).toEqual([
      { kind: 'collect', count: 4, monsterKind: 'skeleton-warrior', labelKey: 'Gather %@ cracked skulls from Skeleton Warriors.' },
    ]);
  });

  it('pays its coins, and a magic item only when it pays one', () => {
    expect(bountyQuest(GRAVEYARD).reward).toStrictEqual({ coins: 120, gear: 3, gearRarity: 'magic' });
    expect(bountyQuest(ARENA).reward).toStrictEqual({ coins: 72 });
  });

  it('goes by an id naming its day and what it asks', () => {
    expect(bountyIdOf(GRAVEYARD)).toBe(`bounty:${DAY}:Graveyard:skeleton-warrior:collect`);
    expect([isBountyId(bountyIdOf(GRAVEYARD)), isBountyId('fighter-trial')]).toEqual([true, false]);
  });

  it('reads back from a stored definition, paying an item or not, and not from one of a kind no bounty names or of a tier this build does not know', () => {
    expect(bountyFromJSON(JSON.parse(JSON.stringify(GRAVEYARD)))).toEqual(GRAVEYARD);
    expect(bountyFromJSON(JSON.parse(JSON.stringify(ARENA)))).toStrictEqual(ARENA);
    expect(bountyOf(ARENA)).toStrictEqual(ARENA);
    expect(bountyOf({ ...GRAVEYARD, monsterKind: 'necromancer' })).toBeUndefined();
    expect(bountyOf({ ...GRAVEYARD, reward: { coins: 1, gear: 9 } })).toBeUndefined();
    expect([bountyFromJSON(null), bountyFromJSON([]), bountyFromJSON({ ...GRAVEYARD, count: 0 })]).toEqual([undefined, undefined, undefined]);
  });
});

describe('a bounty in the quest log', () => {
  const taken = withAcceptedBounty(NO_QUESTS, GRAVEYARD);

  it('is held by its definition, counted as a quest is, and turned in once done', () => {
    expect(taken).toEqual({ active: [{ questId: bountyIdOf(GRAVEYARD), progress: [0], definition: GRAVEYARD }], done: [] });
    expect(collectsTrophy(taken, 'skeleton-warrior')).toBe(true);
    const done = advancedQuests(taken, (objective, progress) => (objective.kind === 'collect' ? progress + 9 : progress));
    expect(done.active[0]?.progress).toEqual([4]);
    expect([questComplete(done.active[0]!), turnInFor(bountyIdOf(GRAVEYARD), done, NO_LUCIDITY)]).toEqual([true, done.active[0]]);
    expect(withTurnedIn(done, bountyIdOf(GRAVEYARD))).toEqual({ active: [], done: [bountyIdOf(GRAVEYARD)] });
  });

  it('is taken once a day: not while held or turned in, nor with the log full', () => {
    expect([mayTakeBounty(GRAVEYARD, NO_QUESTS), mayTakeBounty(GRAVEYARD, taken), mayTakeBounty(ARENA, taken)]).toEqual([true, false, true]);
    expect(mayTakeBounty(GRAVEYARD, { active: [], done: [bountyIdOf(GRAVEYARD)] })).toBe(false);
    expect(mayTakeBounty({ ...GRAVEYARD, day: DAY + 1 }, { active: [], done: [bountyIdOf(GRAVEYARD)] })).toBe(true);
    const full: QuestLog = { active: Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxActiveQuests }, () => taken.active[0]!), done: [] };
    expect(mayTakeBounty(ARENA, full)).toBe(false);
  });

  it('travels the quests frame with its definition, paying an item or not, beside the bounties of the day', () => {
    const both = withAcceptedBounty(taken, ARENA);
    const frame = decodeSomnioMessage(encodeSomnioMessage({ tag: 'quests', payload: questsMessage(both, [GRAVEYARD, ARENA]) }));
    expect(frame.tag === 'quests' ? [questsOf(frame.payload), bountiesOf(frame.payload)] : undefined).toStrictEqual([both, [GRAVEYARD, ARENA]]);
  });

  it('is dropped from a quests frame whose definition is not the one its id names, or names a kind this build does not know', () => {
    const message = questsMessage(taken, [ARENA, { ...GRAVEYARD, monsterKind: 'dragon' as never }]);
    const forged = { ...message, active: [{ ...message.active[0]!, definition: ARENA }] };
    expect([questsOf(forged).active, bountiesOf(message)]).toEqual([[], [ARENA]]);
  });
});

describe('the marker over a bounty board', () => {
  it("offers while the day's bounties hold one the dreamer has neither taken nor turned in, and nothing once all are turned in", () => {
    expect(markerFor(board, NO_QUESTS, NO_LUCIDITY, [GRAVEYARD, ARENA])).toBe('offer');
    expect(markerFor(board, withAcceptedBounty(NO_QUESTS, GRAVEYARD), NO_LUCIDITY, [GRAVEYARD, ARENA])).toBe('offer');
    expect(markerFor(board, { active: [], done: [bountyIdOf(GRAVEYARD), bountyIdOf(ARENA)] }, NO_LUCIDITY, [GRAVEYARD, ARENA])).toBeUndefined();
    expect(markerFor(board, NO_QUESTS, NO_LUCIDITY, [])).toBeUndefined();
  });

  it('shows where to return a bounty held that is not finished yet, once every bounty is taken or turned in', () => {
    const both = withAcceptedBounty(withAcceptedBounty(NO_QUESTS, GRAVEYARD), ARENA);
    expect(markerFor(board, both, NO_LUCIDITY, [GRAVEYARD, ARENA])).toBe('inProgress');
    expect(markerFor(board, { active: both.active.slice(1), done: [bountyIdOf(GRAVEYARD)] }, NO_LUCIDITY, [GRAVEYARD, ARENA])).toBe('inProgress');
  });

  it('asks for the turn-in of a bounty held that is done, whatever day it was taken on, over one not finished yet, and only over a board', () => {
    const done = { active: [{ questId: bountyIdOf(GRAVEYARD), progress: [4], definition: GRAVEYARD }], done: [] };
    expect(markerFor(board, done, NO_LUCIDITY, [])).toBe('turnIn');
    expect(markerFor(board, withAcceptedBounty(done, ARENA), NO_LUCIDITY, [GRAVEYARD, ARENA])).toBe('turnIn');
    expect(markerFor({ id: 'npc:EdariaShop/mercus', service: 'shopkeeper' }, done, NO_LUCIDITY, [GRAVEYARD])).toBeUndefined();
  });
});
