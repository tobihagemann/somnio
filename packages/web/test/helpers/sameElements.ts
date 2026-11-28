import { expect } from 'vitest';

/**
 * Asserts that `actual` holds the very elements of `expected`, in order, as a panel that keeps its
 * elements must. `toEqual` compares DOM nodes with `isEqualNode`, so an element rebuilt with the
 * same markup would pass it.
 */
export function expectSameElements(actual: readonly Element[], expected: readonly Element[]): void {
  expect(actual.length).toBe(expected.length);
  actual.forEach((node, index) => expect(node).toBe(expected[index]));
}
