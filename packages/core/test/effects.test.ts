import { describe, expect, it } from 'vitest';
import { EFFECTS, effectSeconds, isEffectId, scaled } from '../src/effects.ts';

describe('scaled', () => {
  it('holds a plain number at every rank', () => {
    expect([1, 2, 3].map((rank) => scaled(6, rank))).toEqual([6, 6, 6]);
  });

  it('starts at its first rank and adds its step for each rank after', () => {
    expect([1, 2, 3].map((rank) => scaled({ atRank1: 10, perRank: -2 }, rank))).toEqual([10, 8, 6]);
  });
});

/** An effect id travels the wire, so the table is pinned, not only its use. */
describe('effects', () => {
  it('pins the table', () => {
    expect(EFFECTS).toEqual({
      braced: { seconds: { atRank1: 4, perRank: 1 }, damageTaken: 0.5, movement: 'noRun' },
      challenged: { seconds: 6, turnsOnSource: true },
    });
  });

  it('holds each effect for its seconds at the rank of the ability that applies it', () => {
    expect([1, 2, 3].map((rank) => effectSeconds('braced', rank))).toEqual([4, 5, 6]);
    expect([1, 2, 3].map((rank) => effectSeconds('challenged', rank))).toEqual([6, 6, 6]);
  });

  it('knows the effects, and nothing inherited from an object', () => {
    expect(isEffectId('braced')).toBe(true);
    expect(isEffectId('Braced')).toBe(false);
    expect(isEffectId('toString')).toBe(false);
  });
});
