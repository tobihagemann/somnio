import { describe, expect, it } from 'vitest';
import { CHARACTER_CLASS, GENDER } from '../src/characterClass.ts';
import { TEMPO } from '../src/tempo.ts';

/**
 * Raw-value pins for the enums this package owns. `characterClass` and `gender` travel as opaque
 * numbers in the `register` payload and `tempo` in every position frame, so a renumbering would
 * round-trip cleanly through every codec test — and every browser registration would then create
 * the wrong class, or every entity animate at the wrong cadence, with a green suite.
 */
describe('enum raw values', () => {
  it('pins CharacterClass', () => {
    expect(CHARACTER_CLASS).toEqual({
      fighter: 0,
      lancer: 1,
      warrior: 2,
      thief: 3,
      hunter: 4,
      gangster: 5,
      cleric: 6,
      mage: 7,
    });
  });

  it('pins Gender', () => {
    expect(GENDER).toEqual({ male: 0, female: 1 });
  });

  it('pins Tempo', () => {
    expect(TEMPO).toEqual({ walk: 1, default: 2, run: 4 });
  });
});
