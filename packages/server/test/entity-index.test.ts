import { describe, expect, it } from 'vitest';
import { advanceEntityIndex, nextFreeIndex, npcEntityIndices } from '../src/world/entityIndex.ts';

const INT16_MIN = -32_768;
const INT16_MAX = 32_767;

describe('nextFreeIndex', () => {
  it('returns the start index when it is free', () => {
    expect(nextFreeIndex(5, () => false)).toBe(5);
  });

  it('skips an occupied start to the next free index', () => {
    const occupied = new Set([5]);
    expect(nextFreeIndex(5, (index) => occupied.has(index))).toBe(6);
  });

  it('wraps Int16.max to Int16.min rather than to 1', () => {
    const occupied = new Set([INT16_MAX]);
    expect(nextFreeIndex(INT16_MAX, (index) => occupied.has(index))).toBe(INT16_MIN);
  });

  it('skips past Int16.min after wrapping from Int16.max', () => {
    const occupied = new Set([INT16_MAX, INT16_MIN]);
    expect(nextFreeIndex(INT16_MAX, (index) => occupied.has(index))).toBe(INT16_MIN + 1);
  });

  it('returns undefined when every index is occupied', () => {
    expect(nextFreeIndex(1, () => true)).toBeUndefined();
  });
});

describe('advanceEntityIndex', () => {
  it('skips zero on the way through the negative range', () => {
    expect(advanceEntityIndex(-1)).toBe(1);
    expect(advanceEntityIndex(INT16_MAX)).toBe(INT16_MIN);
  });
});

describe('npcEntityIndices', () => {
  it('walks the skip-zero wrapping sequence', () => {
    expect(npcEntityIndices(0)).toEqual([]);
    expect(npcEntityIndices(3)).toEqual([1, 2, 3]);
    expect(npcEntityIndices(32_768).slice(-2)).toEqual([INT16_MAX, INT16_MIN]);
    expect(npcEntityIndices(32_769).at(-1)).toBe(INT16_MIN + 1);
  });
});
