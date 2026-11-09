import { describe, expect, it } from 'vitest';
import { CONDITIONS } from '@somnio/protocol';
import {
  COMBAT,
  balancePace,
  balancePerSecond,
  conditionMidpoint,
  conditionOf,
  engageAction,
  fullPools,
  maxPools,
  mendAmount,
  mendReaches,
  reaches,
  strikeChance,
  swingAllowed,
  swingFor,
  swingMeets,
  windedAfter,
  windedOnJoin,
} from '../src/combat.ts';
import { heading } from '../src/heading.ts';
import { TRIALS } from '../src/lucidity.ts';
import { monsterKind } from '../src/monsterKinds.ts';
import { ranks } from './support/ranks.ts';

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

  it('quickens by a quarter with each Balance recovery rank', () => {
    expect(balancePerSecond([])).toBe(12);
    expect(balancePerSecond(ranks({ 'balance-recovery': 2 }))).toBe(18);
  });
});

describe('swingFor', () => {
  it('swings bare hands for less cost and less harm than the cudgel', () => {
    expect(swingFor(undefined, [])).toEqual({ damage: 4, balanceCost: 8, seconds: 1 });
    expect(swingFor('cudgel', [])).toEqual({ damage: 8, balanceCost: 18, seconds: 1 });
  });

  it('does not swing what is no weapon', () => {
    expect(swingFor('moonstone', [])).toBeUndefined();
    expect(swingFor('purse', [])).toBeUndefined();
  });

  it('adds damage with Strike and shortens the pause with Follow-through', () => {
    expect(swingFor('cudgel', ranks({ strike: 2 }))).toMatchObject({ damage: 14, seconds: 1 });
    expect(swingFor(undefined, ranks({ 'follow-through': 3 }))).toMatchObject({ damage: 4, seconds: 0.7 });
  });
});

describe('swingAllowed', () => {
  it('is the swing of what is in hand while the balance covers its cost, to the last point', () => {
    expect(swingAllowed(undefined, 'cudgel', [], 18)).toEqual(swingFor('cudgel', []));
    expect(swingAllowed(undefined, 'cudgel', [], 17)).toBeUndefined();
    expect(swingAllowed(undefined, undefined, [], 8)).toEqual(swingFor(undefined, []));
  });

  it('is none with something in hand that does not swing', () => {
    expect(swingAllowed(undefined, 'moonstone', [], 100)).toBeUndefined();
  });

  it('is none while a task forbids striking, and is not held back by one that does not', () => {
    expect(swingAllowed(TRIALS.healer, 'cudgel', [], 100)).toBeUndefined();
    expect(swingAllowed(TRIALS.fighter, 'cudgel', [], 100)).toEqual(swingFor('cudgel', []));
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
  it('attacks a nightmare with bare hands or a weapon in hand, whoever engages it', () => {
    expect(engageAction('nightmare', undefined, undefined)).toBe('attack');
    expect(engageAction('nightmare', 'healer', 'cudgel')).toBe('attack');
  });

  it('does not attack with the Moonstone in hand, which does not swing', () => {
    expect(engageAction('nightmare', 'healer', 'moonstone')).toBeUndefined();
  });

  it('mends a dreamer only for a Healer with the Moonstone in hand', () => {
    expect(engageAction('dreamer', 'healer', 'moonstone')).toBe('mend');
    expect(engageAction('dreamer', 'healer', undefined)).toBeUndefined();
    expect(engageAction('dreamer', 'healer', 'cudgel')).toBeUndefined();
    expect(engageAction('dreamer', 'fighter', 'moonstone')).toBeUndefined();
    expect(engageAction('dreamer', undefined, 'moonstone')).toBeUndefined();
  });

  it('does nothing without a target it can act on', () => {
    expect(engageAction(undefined, 'healer', 'moonstone')).toBeUndefined();
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
    expect(strikeChance(ghost, 100, 100, [])).toBeCloseTo(0.6, 9);
    expect(strikeChance(ghost, 50, 100, [])).toBeCloseTo(0.75, 9);
    expect(strikeChance(ghost, 0, 100, [])).toBeCloseTo(0.9, 9);
  });

  it('falls with Guard', () => {
    expect(strikeChance(ghost, 100, 100, ranks({ guard: 3 }))).toBeCloseTo(0.36, 9);
  });

  it('stays a chance', () => {
    expect(strikeChance({ ...ghost, hitChance: 0.95 }, 0, 100, [])).toBe(1);
    expect(strikeChance({ ...ghost, hitChance: 0.1 }, 100, 100, ranks({ guard: 3 }))).toBe(0);
  });
});

describe('ranks that deepen a pool or a touch', () => {
  it('fills every pool to what the ranks give', () => {
    expect(fullPools([])).toEqual({ healthCurrent: 100, healthMax: 100, balanceCurrent: 100, balanceMax: 100, spiritCurrent: 100, spiritMax: 100 });
    expect(fullPools(ranks({ toughening: 2, 'spirit-deepening': 1 }))).toMatchObject({
      healthCurrent: 120,
      healthMax: 120,
      spiritCurrent: 110,
      spiritMax: 110,
    });
  });

  it('raises health with Toughening and spirit with Spirit deepening, and leaves balance alone', () => {
    expect(maxPools([])).toEqual({ healthMax: 100, balanceMax: 100, spiritMax: 100 });
    expect(maxPools(ranks({ toughening: 2, 'spirit-deepening': 3 }))).toEqual({ healthMax: 120, balanceMax: 100, spiritMax: 130 });
  });

  it('mends more with Depth', () => {
    expect(mendAmount([])).toBe(10);
    expect(mendAmount(ranks({ depth: 2 }))).toBe(20);
  });
});
