import { describe, expect, it } from 'vitest';
import {
  NO_LUCIDITY,
  TEACHINGS,
  TRIALS,
  forbidsStriking,
  isRole,
  isSoundTask,
  isTeachingId,
  masterRole,
  practiceNeeded,
  rankOf,
  taskGoal,
  taskSpec,
  teachingStanding,
  unmetNeed,
} from '../src/lucidity.ts';
import type { Lucidity } from '../src/lucidity.ts';
import { ranks } from './support/ranks.ts';

function fighter(strike: number): Lucidity {
  return { ...NO_LUCIDITY, role: 'fighter', ranks: [{ teachingId: 'strike', rank: strike, practice: 0 }] };
}

describe('practice', () => {
  it('asks more for each rank already held', () => {
    expect([0, 1, 2].map(practiceNeeded)).toEqual([20, 35, 50]);
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
});

describe('guards and services', () => {
  it('knows the roles and the teachings, and nothing inherited from an object', () => {
    expect(isRole('healer')).toBe(true);
    expect(isRole('mystic')).toBe(false);
    expect(isTeachingId('follow-through')).toBe(true);
    expect(isTeachingId('followThrough')).toBe(false);
    expect(isTeachingId('toString')).toBe(false);
  });

  it("forbids striking under the Healer's trial alone", () => {
    expect(forbidsStriking(TRIALS.healer)).toBe(true);
    expect(forbidsStriking(TRIALS.fighter)).toBe(false);
    expect(forbidsStriking(TEACHINGS['drawing-back'].gate)).toBe(false);
  });

  it('gives each master a role, and the shopkeeper none', () => {
    expect(masterRole('fighterMaster')).toBe('fighter');
    expect(masterRole('healerMaster')).toBe('healer');
    expect(masterRole('shopkeeper')).toBeUndefined();
  });
});
