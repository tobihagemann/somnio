import { describe, expect, it } from 'vitest';
import { CHARACTER_CLASS, GENDER } from '../src/characterClass.ts';
import { figureIndex } from '../src/spriteFigure.ts';

describe('figure index', () => {
  it.each([
    [CHARACTER_CLASS.fighter, GENDER.male, 0],
    [CHARACTER_CLASS.fighter, GENDER.female, 1],
    [CHARACTER_CLASS.lancer, GENDER.male, 2],
    [CHARACTER_CLASS.lancer, GENDER.female, 3],
    [CHARACTER_CLASS.warrior, GENDER.male, 4],
    [CHARACTER_CLASS.warrior, GENDER.female, 5],
    [CHARACTER_CLASS.thief, GENDER.male, 6],
    [CHARACTER_CLASS.thief, GENDER.female, 7],
    [CHARACTER_CLASS.hunter, GENDER.male, 8],
    [CHARACTER_CLASS.hunter, GENDER.female, 9],
    [CHARACTER_CLASS.gangster, GENDER.male, 10],
    [CHARACTER_CLASS.gangster, GENDER.female, 11],
    [CHARACTER_CLASS.cleric, GENDER.male, 12],
    [CHARACTER_CLASS.cleric, GENDER.female, 13],
    [CHARACTER_CLASS.mage, GENDER.male, 14],
    [CHARACTER_CLASS.mage, GENDER.female, 15],
  ])('class %i gender %i -> %i', (characterClass, gender, expected) => {
    expect(figureIndex(characterClass, gender)).toBe(expected);
  });
});
