const INT16_MIN = -32_768;
const INT16_MAX = 32_767;

/**
 * Entity indices are sector-local `Int16`s. Index 0 is reserved for client-originated
 * `clientPosition`, so allocation starts at 1; `advance` wraps `Int16.max` to `Int16.min`
 * (negative indices are wire-valid) and skips 0.
 */
export function advanceEntityIndex(index: number): number {
  let next = index === INT16_MAX ? INT16_MIN : index + 1;
  if (next === 0) next = 1;
  return next;
}

/** The indices the sector assigns to its first `count` NPCs, in file order, walking `advance` from 1. */
export function npcEntityIndices(count: number): number[] {
  const indices: number[] = [];
  let index = 1;
  for (let position = 0; position < count; position += 1) {
    indices.push(index);
    index = advanceEntityIndex(index);
  }
  return indices;
}

/**
 * First free index at or after `start`, probing the full nonzero `Int16` domain. Returns
 * `undefined` when every candidate is occupied: handing back an occupied index would overwrite a
 * live slot's broadcast routing.
 */
export function nextFreeIndex(start: number, isOccupied: (index: number) => boolean): number | undefined {
  let candidate = start;
  for (let attempt = 0; attempt < 65_535; attempt += 1) {
    if (!isOccupied(candidate)) return candidate;
    candidate = advanceEntityIndex(candidate);
  }
  return undefined;
}
