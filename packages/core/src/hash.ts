/**
 * Deterministic hashing and noise: the same inputs give the same numbers on every machine, so
 * whatever is generated from a seed or a position (the painted ground, the scatter, the composed
 * lands) is identical wherever it is computed.
 */

/** A 32-bit hash of a string (FNV-1a), for turning a name into a seed. */
export function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A number in `[0, 1)` for an integer lattice point and a seed. */
export function hash2(x: number, z: number, seed: number): number {
  let hash = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
  hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967296;
}

/** Smoothly interpolated value noise in `[0, 1]`, one lattice cell per unit. */
export function valueNoise(x: number, z: number, seed: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = zf * zf * (3 - 2 * zf);
  const a = hash2(xi, zi, seed);
  const b = hash2(xi + 1, zi, seed);
  const c = hash2(xi, zi + 1, seed);
  const d = hash2(xi + 1, zi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Three octaves of value noise, weighted to stay in `[0, 1]`. */
export function fbm(x: number, z: number, seed: number): number {
  return 0.5 * valueNoise(x, z, seed) + 0.3 * valueNoise(x * 2.03 + 17, z * 2.03 + 5, seed) + 0.2 * valueNoise(x * 4.1 + 3, z * 4.1 + 11, seed);
}

/** A sequence of numbers in `[0, 1)` from a seed (mulberry32). */
export function seededSequence(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}
