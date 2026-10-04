/**
 * Yaw slewing. Slews toward a target yaw along the shortest
 * arc at a fixed rate, applied identically to local and remote facing changes so both feel the
 * same.
 */

/** A quarter turn completes in 0.175 s regardless of how the facing change arrived. */
const YAW_TURN_RATE = Math.PI / 2 / 0.175;

const FULL_TURN = 2 * Math.PI;

/**
 * The remainder with the quotient rounded to nearest, so the result lies in `[-pi, pi]`. Not the
 * `%` operator, which truncates the quotient and leaves the result on the dividend's side of zero.
 */
function nearestRemainder(value: number): number {
  return value - FULL_TURN * Math.round(value / FULL_TURN);
}

/**
 * One integration step toward `target`, clamped so the result never overshoots.
 *
 * The rounded remainder is load-bearing: it keeps the delta in `[-pi, pi]`, and that is what
 * makes the exact-180-degree south-to-north case resolve to one consistent turn direction instead
 * of spinning. With a truncating remainder the entity oscillates on that input.
 */
export function yawStep(current: number, target: number, deltaTimeSeconds: number): number {
  const delta = nearestRemainder(target - current);
  const maxStep = YAW_TURN_RATE * deltaTimeSeconds;
  if (Math.abs(delta) <= maxStep) return target;
  return nearestRemainder(current + Math.sign(delta) * maxStep);
}
