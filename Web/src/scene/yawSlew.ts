import { FLOAT_PI, copysignF32, f32, ieeeRemainderF32 } from '@/core/float'

/**
 * Mirror of `Sources/SomnioScene3D/YawSlew.swift`. Slews toward a target yaw along the shortest
 * arc at a fixed rate, applied identically to local and remote facing changes so both feel the
 * same.
 */

/** A quarter turn completes in 0.175 s regardless of how the facing change arrived. */
export const YAW_TURN_RATE = f32(FLOAT_PI / 2 / 0.175)

/**
 * One integration step toward `target`, clamped so the result never overshoots.
 *
 * The **IEEE** remainder is load-bearing and is not the `%` operator: it rounds the quotient to
 * nearest rather than truncating, keeping the delta in `[-pi, pi]`. That is what makes the
 * exact-180-degree south-to-north case resolve to one consistent turn direction instead of
 * spinning. With a truncating remainder the entity oscillates on that input.
 */
export function yawStep(current: number, target: number, deltaTimeSeconds: number): number {
  const delta = ieeeRemainderF32(f32(target) - f32(current), f32(2 * FLOAT_PI))
  const maxStep = f32(YAW_TURN_RATE * f32(deltaTimeSeconds))
  if (Math.abs(delta) <= maxStep) return f32(target)
  return ieeeRemainderF32(f32(f32(current) + copysignF32(maxStep, delta)), f32(2 * FLOAT_PI))
}
