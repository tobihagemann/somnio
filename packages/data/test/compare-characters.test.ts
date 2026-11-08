import { describe, expect, it } from 'vitest';
import type { Character } from '@somnio/core';
import { compareCharacters, newCharacter } from '../src/repositories/characters.ts';

function listed(...characters: Character[]): string[] {
  return characters.sort(compareCharacters).map((character) => character.name);
}

function played(name: string, lastSeenMs: number): Character {
  return { ...newCharacter(name, name, 'vigils'), lastSeen: new Date(lastSeenMs) };
}

function neverPlayed(name: string): Character {
  return newCharacter(name, name, 'vigils');
}

describe('compareCharacters', () => {
  it('lists the one played last first, then those played earlier, then those never played', () => {
    expect(listed(neverPlayed('Alpha'), played('Zed', 1_000), played('Ida', 2_000))).toEqual(['Ida', 'Zed', 'Alpha']);
  });

  /** A collation that ignores spaces, hyphens, or case would order each of these pairs the other way. */
  it.each([
    ['Mary Jane', 'Maryann'],
    ['Ana-Lee', 'Anabel'],
    ['Zed', 'ida'],
  ])('orders %s before %s by code unit', (first, second) => {
    expect(listed(neverPlayed(second), neverPlayed(first))).toEqual([first, second]);
    expect(listed(played(second, 1_000), played(first, 1_000))).toEqual([first, second]);
  });

  it('breaks a tie of name on the id', () => {
    const first = { ...neverPlayed('Ida'), id: 'a' };
    const second = { ...neverPlayed('Ida'), id: 'b' };
    expect([second, first].sort(compareCharacters)).toEqual([first, second]);
  });
});
