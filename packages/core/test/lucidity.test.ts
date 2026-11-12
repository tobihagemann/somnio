import { describe, expect, it } from 'vitest';
import { NO_LUCIDITY, TEACHING_IDS, isRole, isTeachingId, masterRole, practiceNeeded, rankOf, teaching, teachingStanding, unmetNeed } from '../src/lucidity.ts';
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
    ["earned by its gate's quest once the need is met", ranks({ strike: 2 }), 'follow-through', 'task'],
    ['open to study past its gate', ranks({ strike: 2, 'follow-through': 1 }), 'follow-through', 'open'],
    ['mastered at its last rank', ranks({ strike: 2, 'follow-through': 3 }), 'follow-through', 'mastered'],
    ['mastered even when its need is no longer met', ranks({ 'drawing-back': 1 }), 'drawing-back', 'mastered'],
    ['an ability later while its need is unmet', ranks({ strike: 1 }), 'challenge', 'later'],
    ['an ability open to study once its need is met', ranks({ strike: 1, guard: 1 }), 'challenge', 'open'],
  ] as const)('a teaching is %s', (_label, held, teachingId, standing) => {
    expect(teachingStanding(held, teachingId)).toBe(standing);
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

  it('gives each master a role, and the shopkeeper none', () => {
    expect(masterRole('fighterMaster')).toBe('fighter');
    expect(masterRole('healerMaster')).toBe('healer');
    expect(masterRole('mysticMaster')).toBe('mystic');
    expect(masterRole('shopkeeper')).toBeUndefined();
  });
});
