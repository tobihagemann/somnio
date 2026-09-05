/**
 * Visual-center geometry for the radius gates that compare entity centers, not their top-left
 * origins: the NPC dialog radius and the monster aggro radius. Squared distances stay within the
 * safe-integer range for any pair of Int16 centers, so a sector edge near `Int16.max` cannot
 * produce a wrong verdict.
 */
export interface Center {
  x: number;
  y: number;
}

export function squaredDistance(a: Center, b: Center): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** Inclusive radius gate: a point exactly at the radius is inside. */
export function isWithin(a: Center, b: Center, radius: number): boolean {
  return squaredDistance(a, b) <= radius * radius;
}
