import { describe, expect, it } from 'vitest';
import { CONDITIONS } from '@somnio/protocol';
import {
  COMBAT,
  attackRefusal,
  balancePace,
  balancePerSecond,
  conditionMidpoint,
  conditionOf,
  engageAction,
  fullPools,
  gaitAllowed,
  harmTaken,
  shieldedHarm,
  maxPools,
  mendAmount,
  spiritPerSecond,
  statsOf,
  wardShare,
  raiseSecondsFor,
  raiseWorkOver,
  mendReaches,
  reaches,
  strikeChance,
  swingAllowed,
  swingFor,
  swingMeets,
  wholeAmount,
  windedAfter,
  windedOnJoin,
} from '../src/combat.ts';
import { heading } from '../src/heading.ts';
import { NO_STATS } from '../src/items.ts';
import type { Equipment } from '../src/items.ts';
import type { Lucidity, TeachingId } from '../src/lucidity.ts';
import { monsterKind } from '../src/monsterKinds.ts';
import { holding, plain } from './support/items.ts';
import { ranks } from './support/ranks.ts';

/** The stats of a dreamer of the role holding the ranks given and wearing nothing. */
const ranked = (held: Partial<Record<TeachingId, number>>, role: Lucidity['role'] = undefined) => statsOf({}, { role, ranks: ranks(held) });

describe('conditionOf', () => {
  it.each([
    [100, 'hale'],
    [99, 'grazed'],
    [76, 'grazed'],
    [75, 'wounded'],
    [51, 'wounded'],
    [50, 'hurt'],
    [26, 'hurt'],
    [25, 'failing'],
    [1, 'failing'],
    [0, 'fallen'],
  ] as const)('reads %i of 100 as %s', (current, condition) => {
    expect(conditionOf(current, 100)).toBe(condition);
  });

  it('bands by the share of the maximum, not by the number', () => {
    expect(conditionOf(100, 150)).toBe('wounded');
    expect(conditionOf(113, 150)).toBe('grazed');
    expect(conditionOf(150, 150)).toBe('hale');
  });

  it('takes the middle of each band as what a health known only by its band shows', () => {
    expect(CONDITIONS.map(conditionMidpoint)).toEqual([1, 0.875, 0.625, 0.375, 0.125, 0]);
  });
});

describe('winded', () => {
  it('begins at an empty balance and not before', () => {
    expect(windedAfter(false, 1)).toBe(false);
    expect(windedAfter(false, 0)).toBe(true);
  });

  it('ends only once the balance is back to the threshold', () => {
    expect(windedAfter(true, COMBAT.windedUntil - 1)).toBe(true);
    expect(windedAfter(true, COMBAT.windedUntil)).toBe(false);
  });

  it('starts a join from the balance alone', () => {
    expect(windedOnJoin(COMBAT.windedUntil - 1)).toBe(true);
    expect(windedOnJoin(COMBAT.windedUntil)).toBe(false);
  });
});

describe('gaitAllowed', () => {
  it('holds a braced dreamer below a run, and leaves every gait else as asked', () => {
    expect(gaitAllowed('run', ['braced'])).toBe('jog');
    expect(gaitAllowed('jog', ['braced'])).toBe('jog');
    expect(gaitAllowed('walk', ['braced'])).toBe('walk');
    expect(gaitAllowed('run', [])).toBe('run');
    expect(gaitAllowed('run', ['challenged'])).toBe('run');
  });
});

describe('balance recovery', () => {
  it('is full standing and at the slow gait, slow at a jog, and none at a run', () => {
    expect(balancePace('standing', false)).toBe(1);
    expect(balancePace('walk', false)).toBe(1);
    expect(balancePace('jog', false)).toBe(0.4);
    expect(balancePace('run', false)).toBe(0);
  });

  it('holds on the move while winded, and still recovers standing', () => {
    expect(balancePace('walk', true)).toBe(0);
    expect(balancePace('jog', true)).toBe(0);
    expect(balancePace('standing', true)).toBe(1);
  });

  it('quickens by a quarter with each Balance recovery rank, and by its share of gear', () => {
    expect(balancePerSecond(NO_STATS)).toBe(12);
    expect(balancePerSecond(ranked({ 'balance-recovery': 2 }))).toBe(18);
    expect(balancePerSecond({ ...NO_STATS, balanceRecovery: 10 })).toBeCloseTo(13.2, 9);
  });

  it('recovers spirit faster by its share of gear', () => {
    expect(spiritPerSecond(NO_STATS)).toBe(1);
    expect(spiritPerSecond({ ...NO_STATS, spiritRecovery: 15 })).toBeCloseTo(1.15, 9);
  });
});

describe('swingFor', () => {
  const cudgel = plain('cudgel');

  it('swings bare hands for less cost and less harm than the cudgel', () => {
    expect(swingFor(undefined, NO_STATS)).toEqual({ damage: 4, balanceCost: 8, seconds: 1 });
    expect(swingFor(cudgel, NO_STATS)).toEqual({ damage: 8, balanceCost: 18, seconds: 1 });
  });

  it('does not swing what is no weapon', () => {
    expect(swingFor(plain('moonstone'), NO_STATS)).toBeUndefined();
    expect(swingFor(plain('shield'), NO_STATS)).toBeUndefined();
  });

  it('adds damage with Strike and shortens the pause with Follow-through', () => {
    expect(swingFor(cudgel, ranked({ strike: 2 }))).toMatchObject({ damage: 14, seconds: 1 });
    expect(swingFor(undefined, ranked({ 'follow-through': 3 }))).toMatchObject({ damage: 4, seconds: 0.7 });
  });

  it('adds the damage and the swing speed of gear', () => {
    expect(swingFor(cudgel, { ...NO_STATS, damage: 2, swingSpeed: 5 })).toEqual({ damage: 10, balanceCost: 18, seconds: 0.95 });
  });
});

describe('swingAllowed', () => {
  const cudgel = plain('cudgel');

  it('is the swing of what is in the main hand while the balance covers its cost, to the last point', () => {
    expect(swingAllowed([], cudgel, NO_STATS, 18)).toEqual(swingFor(cudgel, NO_STATS));
    expect(swingAllowed([], cudgel, NO_STATS, 17)).toBeUndefined();
    expect(swingAllowed([], undefined, NO_STATS, 8)).toEqual(swingFor(undefined, NO_STATS));
  });

  it('is none with something in the main hand that does not swing', () => {
    expect(swingAllowed([], plain('moonstone'), NO_STATS, 100)).toBeUndefined();
  });

  it('is none while a quest held forbids striking, and is not held back by one that does not', () => {
    expect(swingAllowed([{ questId: 'fighter-trial' }, { questId: 'healer-trial' }], cudgel, NO_STATS, 100)).toBeUndefined();
    expect(swingAllowed([{ questId: 'fighter-trial' }], cudgel, NO_STATS, 100)).toEqual(swingFor(cudgel, NO_STATS));
  });
});

describe('what a swing meets', () => {
  const SOUTH = heading(0);
  const ghost = (x: number, z: number) => ({ x, z, radius: 0.3 });

  it('reaches a body as far as contact and the reach slack, and no further', () => {
    expect(reaches({ x: 0, z: 0 }, ghost(0, 0.85))).toBe(true);
    expect(reaches({ x: 0, z: 0 }, ghost(0, 0.86))).toBe(false);
  });

  it('meets a body in reach inside the arc in front', () => {
    const edge = { x: Math.sin(Math.PI / 3) * 0.8, z: Math.cos(Math.PI / 3) * 0.8 };
    expect(swingMeets({ x: 0, z: 0 }, SOUTH, ghost(0, 0.8))).toBe(true);
    expect(swingMeets({ x: 0, z: 0 }, SOUTH, ghost(edge.x - 0.01, edge.z))).toBe(true);
    expect(swingMeets({ x: 0, z: 0 }, heading(90), ghost(0.8, 0))).toBe(true);
  });

  it('meets nothing beside, behind, or out of reach', () => {
    expect(swingMeets({ x: 0, z: 0 }, SOUTH, ghost(0.8, 0))).toBe(false);
    expect(swingMeets({ x: 0, z: 0 }, SOUTH, ghost(0, -0.8))).toBe(false);
    expect(swingMeets({ x: 0, z: 0 }, SOUTH, ghost(0, 0.9))).toBe(false);
  });

  it('meets a body the dreamer stands inside wherever they face', () => {
    expect(swingMeets({ x: 0, z: 0 }, SOUTH, ghost(0, -0.2))).toBe(true);
  });
});

describe('engageAction', () => {
  const cudgel = plain('cudgel');
  const moonstone = plain('moonstone');

  it('attacks a nightmare with the main hand empty or holding a weapon, whatever the off hand holds and whoever engages it', () => {
    expect(engageAction('nightmare', undefined, {}, [])).toBe('attack');
    expect(engageAction('nightmare', 'healer', holding(cudgel, undefined), [])).toBe('attack');
    expect(engageAction('nightmare', 'healer', holding(undefined, moonstone), [])).toBe('attack');
    expect(engageAction('nightmare', 'mystic', holding(undefined, plain('wand')), [])).toBe('attack');
    expect(engageAction('nightmare', 'fighter', holding(cudgel, plain('shield')), [])).toBe('attack');
  });

  it('does not attack with something in the main hand that does not swing', () => {
    expect(engageAction('nightmare', 'healer', holding(moonstone, undefined), [])).toBeUndefined();
  });

  it('mends a dreamer only for a Healer with the Moonstone in the off hand', () => {
    expect(engageAction('dreamer', 'healer', holding(undefined, moonstone), [])).toBe('mend');
    expect(engageAction('dreamer', 'healer', holding(cudgel, moonstone), [])).toBe('mend');
    expect(engageAction('dreamer', 'healer', {}, [])).toBeUndefined();
    expect(engageAction('dreamer', 'healer', holding(cudgel, undefined), [])).toBeUndefined();
    expect(engageAction('dreamer', 'healer', holding(moonstone, undefined), [])).toBeUndefined();
    expect(engageAction('dreamer', 'fighter', holding(undefined, moonstone), [])).toBeUndefined();
    expect(engageAction('dreamer', 'mystic', holding(undefined, moonstone), [])).toBeUndefined();
    expect(engageAction('dreamer', undefined, holding(undefined, moonstone), [])).toBeUndefined();
  });

  it('attacks or mends, by the target, for a Healer holding a weapon and the Moonstone', () => {
    const both = holding(cudgel, moonstone);
    expect([engageAction('nightmare', 'healer', both, []), engageAction('dreamer', 'healer', both, [])]).toEqual(['attack', 'mend']);
  });

  it('does not attack while a quest held forbids striking, and still mends', () => {
    const trial = [{ questId: 'healer-trial' as const }];
    expect(engageAction('nightmare', undefined, {}, trial)).toBeUndefined();
    expect(engageAction('nightmare', undefined, {}, [{ questId: 'fighter-trial' as const }])).toBe('attack');
    expect(engageAction('dreamer', 'healer', holding(undefined, moonstone), trial)).toBe('mend');
  });

  it('names why it cannot attack, the hand before a quest that forbids striking', () => {
    const trial = [{ questId: 'healer-trial' as const }];
    expect(attackRefusal({}, [])).toBeUndefined();
    expect(attackRefusal({}, trial)).toBe('striking');
    expect(attackRefusal(holding(moonstone, undefined), trial)).toBe('hand');
  });

  it('does nothing without a target it can act on', () => {
    expect(engageAction(undefined, 'healer', holding(cudgel, moonstone), [])).toBeUndefined();
  });
});

describe('mendReaches', () => {
  it('reaches as far as the mend reach, centre to centre, and no further', () => {
    expect(mendReaches({ x: 0, z: 0 }, { x: 0, z: 0 })).toBe(true);
    expect(mendReaches({ x: 0, z: 0 }, { x: COMBAT.mend.reach, z: 0 })).toBe(true);
    expect(mendReaches({ x: 0, z: 0 }, { x: COMBAT.mend.reach + 0.01, z: 0 })).toBe(false);
  });
});

describe('strikeChance', () => {
  const ghost = monsterKind('ghost');

  it('rises as the balance falls', () => {
    expect(strikeChance(ghost, 100, 100, NO_STATS)).toBeCloseTo(0.6, 9);
    expect(strikeChance(ghost, 50, 100, NO_STATS)).toBeCloseTo(0.75, 9);
    expect(strikeChance(ghost, 0, 100, NO_STATS)).toBeCloseTo(0.9, 9);
  });

  it('falls with Guard, from ranks and from gear', () => {
    expect(strikeChance(ghost, 100, 100, ranked({ guard: 3 }))).toBeCloseTo(0.36, 9);
    expect(strikeChance(ghost, 100, 100, { ...NO_STATS, guard: 10 })).toBeCloseTo(0.5, 9);
  });

  it('stays a chance', () => {
    expect(strikeChance({ ...ghost, hitChance: 0.95 }, 0, 100, NO_STATS)).toBe(1);
    expect(strikeChance({ ...ghost, hitChance: 0.1 }, 100, 100, ranked({ guard: 3 }))).toBe(0);
  });
});

describe('whole amounts', () => {
  it('rounds an amount once, half up', () => {
    expect(wholeAmount(4.5)).toBe(5);
    expect(wholeAmount(4.49)).toBe(4);
    expect(wholeAmount(3.5)).toBe(4);
    expect(wholeAmount(0.4)).toBe(0);
    expect(wholeAmount(9)).toBe(9);
  });

  it('lands a hit whole by every effect on either side, and never less than 1', () => {
    expect(harmTaken(9, [], [])).toBe(9);
    expect(harmTaken(9, [], ['braced'])).toBe(5);
    expect(harmTaken(7, [], ['braced'])).toBe(4);
    expect(harmTaken(1, [], ['braced'])).toBe(1);
    expect(harmTaken(9, ['braced'], ['challenged'])).toBe(9);
    expect(harmTaken(9, ['weakened'], [])).toBe(5);
    expect(harmTaken(9, ['weakened'], ['braced'])).toBe(3);
  });

  it("lets a shield take what it holds of a hit's share before the rest is made whole", () => {
    expect(shieldedHarm(9, [], [], 12)).toEqual({ landed: 0, absorbed: 9 });
    expect(shieldedHarm(9, [], [], 3)).toEqual({ landed: 6, absorbed: 3 });
    expect(shieldedHarm(9, [], ['braced'], 3)).toEqual({ landed: 2, absorbed: 3 });
    expect(shieldedHarm(9, [], [], 8.8)).toEqual({ landed: 1, absorbed: 8.8 });
    expect(shieldedHarm(9, [], [], 0)).toEqual({ landed: 9, absorbed: 0 });
  });
});

describe('ranks and gear that deepen a pool, a touch, or a ward', () => {
  it('fills every pool to what the role and ranks give', () => {
    expect(fullPools(NO_STATS)).toEqual({ healthCurrent: 100, healthMax: 100, balanceCurrent: 100, balanceMax: 100, spiritCurrent: 100, spiritMax: 100 });
    expect(fullPools(ranked({ toughening: 2, 'spirit-deepening': 1 }, 'healer'))).toMatchObject({
      healthCurrent: 120,
      healthMax: 120,
      spiritCurrent: 110,
      spiritMax: 110,
    });
  });

  it('raises health with Toughening and spirit with Spirit deepening, and leaves balance alone', () => {
    expect(maxPools(NO_STATS)).toEqual({ healthMax: 100, balanceMax: 100, spiritMax: 100 });
    expect(maxPools(ranked({ toughening: 2, 'spirit-deepening': 3 }, 'healer'))).toEqual({ healthMax: 120, balanceMax: 100, spiritMax: 130 });
  });

  it("reads only the Spirit deepening of the dreamer's own role", () => {
    expect(maxPools(ranked({ 'spirit-deepening': 3 }, 'fighter')).spiritMax).toBe(100);
    expect(maxPools(ranked({ 'spirit-deepening': 3 })).spiritMax).toBe(100);
    expect(maxPools(ranked({ 'mystic-spirit-deepening': 2 }, 'mystic')).spiritMax).toBe(120);
    expect(maxPools(ranked({ 'spirit-deepening': 3 }, 'mystic')).spiritMax).toBe(100);
    expect(maxPools(ranked({ 'mystic-spirit-deepening': 3 }, 'healer')).spiritMax).toBe(100);
  });

  it('raises each pool by what gear adds to it', () => {
    expect(maxPools({ ...NO_STATS, healthMax: 5, balanceMax: 6, spiritMax: 7 })).toEqual({ healthMax: 105, balanceMax: 106, spiritMax: 107 });
  });

  it('mends more with Depth and with gear', () => {
    expect(mendAmount(NO_STATS)).toBe(10);
    expect(mendAmount(ranked({ depth: 2 }))).toBe(20);
    expect(mendAmount({ ...NO_STATS, mendDepth: 3 })).toBe(13);
  });

  it('puts up a stronger ward by its share of gear', () => {
    expect(wardShare(NO_STATS)).toBe(1);
    expect(wardShare({ ...NO_STATS, wardStrength: 10 })).toBeCloseTo(1.1, 9);
  });
});

describe('statsOf', () => {
  it("adds every worn item's base stats and affixes to what the ranks give", () => {
    const equipment: Equipment = {
      mainHand: { baseId: 'sword', tier: 1, rarity: 'magic', affixes: [{ affixId: 'swing-speed', value: 4 }] },
      offHand: plain('shield'),
      chest: {
        baseId: 'tunic',
        tier: 1,
        rarity: 'rare',
        affixes: [
          { affixId: 'health', value: 6 },
          { affixId: 'guard', value: 2 },
          { affixId: 'balance-recovery', value: 9 },
        ],
      },
      neck: plain('amulet'),
    };
    expect(statsOf(equipment, { role: 'fighter', ranks: ranks({ guard: 1, 'follow-through': 1, toughening: 1 }) })).toEqual({
      ...NO_STATS,
      healthMax: 10 + 6 + 5,
      guard: 8 + 4 + 3 + 2,
      swingSpeed: 10 + 4,
      balanceRecovery: 9,
    });
  });

  it('gives nothing to a dreamer with no ranks who wears nothing', () => {
    expect(statsOf({}, { role: undefined, ranks: [] })).toEqual(NO_STATS);
  });
});

describe('the raise schedule', () => {
  it('adds a pace-second a second for each Healer holding on once their pause is over', () => {
    expect(raiseWorkOver([0], 2)).toBe(2);
    expect(raiseWorkOver([0, 0], 2)).toBe(4);
    // One paused for 1.5 s adds half a second of the two.
    expect(raiseWorkOver([1.5, 0], 2)).toBe(2.5);
    // While every one is paused, nothing moves.
    expect(raiseWorkOver([1, 0.5], 0.5)).toBe(0);
  });

  it('takes as long to add work as its inverse says, whatever order the pauses come in', () => {
    for (const paused of [[0], [0, 0], [1.5, 0], [0, 1.5], [0.4, 2, 1], [3, 3]]) {
      for (const work of [0.25, 1, 2.5, 6]) {
        const seconds = raiseSecondsFor(work, paused);
        expect(raiseWorkOver(paused, seconds)).toBeCloseTo(work, 9);
        // And no sooner: a hundredth of a second before, the work falls short.
        expect(raiseWorkOver(paused, seconds - 0.01)).toBeLessThan(work);
      }
    }
  });

  it('waits out the shortest pause before any work, and never finishes with none holding on', () => {
    expect(raiseSecondsFor(1, [1.5, 2])).toBeCloseTo(1.5 + 1 / 2 + 0.25, 9);
    expect(raiseSecondsFor(0, [0.5])).toBe(0.5);
    expect(raiseSecondsFor(1, [])).toBe(Infinity);
  });
});
