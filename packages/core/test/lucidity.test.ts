import { describe, expect, it } from 'vitest';
import {
  NO_LUCIDITY,
  TEACHINGS,
  TEACHING_IDS,
  TRIALS,
  forbidsStriking,
  isRole,
  isSoundTask,
  isTeachingId,
  masterRole,
  placesFound,
  placesReached,
  practiceNeeded,
  rankOf,
  taskGoal,
  taskSpec,
  teaching,
  teachingStanding,
  unmetNeed,
} from '../src/lucidity.ts';
import type { Lucidity, TaskSpec } from '../src/lucidity.ts';
import { outdoorSector } from './support/worldFixture.ts';
import { ranks } from './support/ranks.ts';

function fighter(strike: number): Lucidity {
  return { ...NO_LUCIDITY, role: 'fighter', ranks: [{ teachingId: 'strike', rank: strike, practice: 0 }] };
}

describe('practice', () => {
  it('asks more for each rank already held', () => {
    expect([0, 1, 2].map(practiceNeeded)).toEqual([20, 35, 50]);
  });
});

describe('the teachings', () => {
  /** A rank is stored against its teaching's last rank, and a master offers a teaching only once its need is met. */
  it('pins the last rank and the need of every teaching', () => {
    expect(Object.fromEntries(TEACHING_IDS.map((id) => [id, [teaching(id).maxRank, teaching(id).needs]]))).toEqual({
      strike: [5, undefined],
      guard: [3, { teachingId: 'strike', rank: 1 }],
      'follow-through': [3, { teachingId: 'strike', rank: 2 }],
      'balance-recovery': [3, undefined],
      toughening: [5, undefined],
      cleave: [3, { teachingId: 'strike', rank: 1 }],
      challenge: [1, { teachingId: 'guard', rank: 1 }],
      brace: [3, { teachingId: 'guard', rank: 1 }],
      lunge: [3, { teachingId: 'strike', rank: 2 }],
      rally: [3, { teachingId: 'balance-recovery', rank: 1 }],
      touch: [3, undefined],
      depth: [5, { teachingId: 'touch', rank: 1 }],
      'drawing-back': [1, { teachingId: 'touch', rank: 2 }],
      'spirit-deepening': [5, undefined],
      'deep-mend': [3, { teachingId: 'touch', rank: 1 }],
      renewal: [3, { teachingId: 'touch', rank: 2 }],
      radiance: [3, { teachingId: 'depth', rank: 1 }],
      calm: [1, { teachingId: 'touch', rank: 1 }],
      ward: [3, undefined],
      weaken: [3, { teachingId: 'ward', rank: 1 }],
      bind: [3, { teachingId: 'weaken', rank: 1 }],
      'dream-bolt': [3, { teachingId: 'ward', rank: 1 }],
      veil: [1, { teachingId: 'bind', rank: 1 }],
      'sense-the-fallen': [1, { teachingId: 'ward', rank: 1 }],
      'mystic-spirit-deepening': [5, undefined],
    });
  });
});

describe('what a teaching needs', () => {
  it('reads a teaching nobody holds as rank 0', () => {
    expect(rankOf([], 'strike')).toBe(0);
    expect(rankOf(fighter(2).ranks, 'strike')).toBe(2);
  });

  it('names the need a dreamer falls short of, and none once it is met', () => {
    expect(unmetNeed(fighter(1).ranks, 'follow-through')).toEqual({ teachingId: 'strike', rank: 2 });
    expect(unmetNeed(fighter(2).ranks, 'follow-through')).toBeUndefined();
    expect(unmetNeed([], 'strike')).toBeUndefined();
  });

  it.each([
    ['open to study with no need and no gate', ranks({}), 'strike', 'open'],
    ['later while its need is unmet', ranks({ strike: 1 }), 'follow-through', 'later'],
    ["earned by its gate's task once the need is met", ranks({ strike: 2 }), 'follow-through', 'task'],
    ['open to study past its gate', ranks({ strike: 2, 'follow-through': 1 }), 'follow-through', 'open'],
    ['mastered at its last rank', ranks({ strike: 2, 'follow-through': 3 }), 'follow-through', 'mastered'],
    ['mastered even when its need is no longer met', ranks({ 'drawing-back': 1 }), 'drawing-back', 'mastered'],
    ['an ability later while its need is unmet', ranks({ strike: 1 }), 'challenge', 'later'],
    ['an ability open to study once its need is met', ranks({ strike: 1, guard: 1 }), 'challenge', 'open'],
  ] as const)('a teaching is %s', (_label, held, teachingId, standing) => {
    expect(teachingStanding(held, teachingId)).toBe(standing);
  });
});

describe('tasks', () => {
  it("reads a task without a teaching as its role's trial and one with a teaching as that teaching's gate", () => {
    expect(taskSpec({ role: 'healer', teachingId: undefined })).toBe(TRIALS.healer);
    expect(taskSpec({ role: 'healer', teachingId: 'drawing-back' })).toEqual({ kind: 'mend', amount: 60 });
  });

  it('has no spec for a task naming a teaching without a gate', () => {
    expect(taskSpec({ role: 'healer', teachingId: 'touch' })).toBeUndefined();
  });

  it.each([
    ["a role's trial", { role: 'healer', teachingId: undefined }, true],
    ["the gate of a teaching of the task's role", { role: 'healer', teachingId: 'drawing-back' }, true],
    ['a teaching without a gate', { role: 'healer', teachingId: 'touch' }, false],
    ["another role's gate", { role: 'fighter', teachingId: 'drawing-back' }, false],
  ] as const)('judges a task naming %s sound: %s', (_label, task, sound) => {
    expect(isSoundTask(task)).toBe(sound);
  });

  it('is done at its count, at its amount, or on arriving', () => {
    expect(taskGoal({ kind: 'driveOff', count: 3 })).toBe(3);
    expect(taskGoal({ kind: 'mend', amount: 60 })).toBe(60);
    expect(taskGoal({ kind: 'reach', sector: 'NorthWood', labelKey: 'North Wood' })).toBe(1);
  });

  it('is done with every place found, one bit a place', () => {
    expect(taskGoal(TRIALS.mystic)).toBe(0b111);
    expect([0, 0b001, 0b100, 0b101, 0b111].map(placesFound)).toEqual([0, 1, 1, 2, 3]);
  });

  it("finds a place within its radius in its own sector, at the sector's origin", () => {
    const spec: TaskSpec = {
      kind: 'reachAll',
      places: [
        { sector: 'Glade', x: 5, z: 5, radius: 2 },
        { sector: 'Other', x: 5, z: 5, radius: 2 },
        { sector: 'Glade', x: 6, z: 5, radius: 2 },
      ],
    };
    const glade = outdoorSector('Glade', { x: 100, z: 0 });
    expect(placesReached(spec, glade, { x: 105.5, z: 5.5 })).toBe(0b101);
    expect(placesReached(spec, glade, { x: 103, z: 3 })).toBe(0b000);
    expect(placesReached(spec, glade, { x: 103.5, z: 5 })).toBe(0b001);
    expect(placesReached(TRIALS.healer, glade, { x: 105, z: 5 })).toBe(0);
  });
});

describe('guards and services', () => {
  it('knows the roles and the teachings, and nothing inherited from an object', () => {
    expect(isRole('healer')).toBe(true);
    expect(isRole('mystic')).toBe(true);
    expect(isRole('necromancer')).toBe(false);
    expect(isTeachingId('follow-through')).toBe(true);
    expect(isTeachingId('followThrough')).toBe(false);
    expect(isTeachingId('toString')).toBe(false);
  });

  it("forbids striking under the Healer's trial alone", () => {
    expect(forbidsStriking(TRIALS.healer)).toBe(true);
    expect(forbidsStriking(TRIALS.fighter)).toBe(false);
    expect(forbidsStriking(TRIALS.mystic)).toBe(false);
    expect(forbidsStriking(TEACHINGS['drawing-back'].gate)).toBe(false);
  });

  it('gives each master a role, and the shopkeeper none', () => {
    expect(masterRole('fighterMaster')).toBe('fighter');
    expect(masterRole('healerMaster')).toBe('healer');
    expect(masterRole('mysticMaster')).toBe('mystic');
    expect(masterRole('shopkeeper')).toBeUndefined();
  });
});
