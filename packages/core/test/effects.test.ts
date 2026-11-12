import { describe, expect, it } from 'vitest';
import { EFFECTS, effectAbsorb, effectHealthPerSecond, effectSeconds, isEffectId, scaled } from '../src/effects.ts';

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
      renewing: { seconds: 10, healthPerSecond: { atRank1: 2.5, perRank: 0.75 } },
      calmed: { seconds: 8, threatGenerated: 0.5 },
      warded: { seconds: 12, absorb: { atRank1: 12, perRank: 5 } },
      weakened: { seconds: { atRank1: 8, perRank: 2 }, damageDealt: 0.6 },
      bound: { seconds: { atRank1: 3, perRank: 1 }, movement: 'rooted' },
      veiled: { seconds: 5, unseen: true },
      stony: { damageTaken: 0.6 },
      shielded: { absorb: 15 },
    });
  });

  it('heals its holder a second by the rank of the ability that applies it, and nothing for an effect that does not heal', () => {
    expect([1, 2, 3].map((rank) => effectHealthPerSecond('renewing', rank))).toEqual([2.5, 3.25, 4]);
    expect(effectHealthPerSecond('braced', 1)).toBe(0);
  });

  it('shields its holder by the rank of the ability that applies it, and not at all for an effect that is no shield', () => {
    expect([1, 2, 3].map((rank) => effectAbsorb('warded', rank))).toEqual([12, 17, 22]);
    expect(effectAbsorb('braced', 1)).toBe(0);
  });

  it('holds each effect for its seconds at the rank of the ability that applies it', () => {
    expect([1, 2, 3].map((rank) => effectSeconds('braced', rank))).toEqual([4, 5, 6]);
    expect([1, 2, 3].map((rank) => effectSeconds('challenged', rank))).toEqual([6, 6, 6]);
  });

  it("holds an elite trait's effect without end", () => {
    expect(effectSeconds('stony', 1)).toBe(Number.POSITIVE_INFINITY);
  });

  it('knows the effects, and nothing inherited from an object', () => {
    expect(isEffectId('braced')).toBe(true);
    expect(isEffectId('Braced')).toBe(false);
    expect(isEffectId('toString')).toBe(false);
  });
});
