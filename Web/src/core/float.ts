/**
 * Single-precision narrowing. Swift computes `Heading`, `YawSlew`, and the camera rig in
 * `Float`; JavaScript numbers are IEEE binary64 throughout. Narrowing only at the wire
 * boundary is not enough — an intermediate double carries extra mantissa bits into the next
 * operation, so a multi-step expression drifts from the Swift result even though every input
 * and output is representable in binary32. Every step Swift performs in `Float` gets an
 * `f32` here.
 */
export function f32(value: number): number {
  return Math.fround(value)
}

/**
 * Swift's `Float.pi`.
 *
 * This is deliberately **not** `Math.fround(Math.PI)`. Swift specifies
 * `FloatingPoint.pi` as rounded *toward zero* — the stated reason being to keep angle
 * computations from tipping into the wrong quadrant — while `Math.fround` rounds to nearest,
 * which for pi rounds *up*. The two land on adjacent `Float` values:
 *
 *     Math.fround(Math.PI) === 3.1415927410125732   // to nearest
 *     Swift Float.pi       === 3.141592502593994    // toward zero
 *
 * Using the `fround` value puts a one-ulp systematic error into every heading and yaw
 * conversion in the port. Do not "simplify" this back to `Math.fround(Math.PI)`; a test pins
 * the distinction.
 */
export const FLOAT_PI = 3.141592502593994

/**
 * `atan2` narrowed to single precision, with its result held inside `atan2f`'s range.
 *
 * JavaScript has no single-precision `atan2`, so this narrows the binary64 result. That
 * agrees with Apple's `atan2f` everywhere except the exact antipodal boundary, where
 * `atan2f` returns `Float.pi` (rounded toward zero) while narrowing the double rounds to
 * nearest and overshoots it by one ulp. Clamping to the function's own documented range is
 * what closes that gap. Non-boundary transcendental results can still differ from `atan2f`
 * in the last bit — parity is exact for the algebraic chain around this call, not for libm
 * itself.
 */
export function atan2F32(y: number, x: number): number {
  const narrowed = f32(Math.atan2(f32(y), f32(x)))
  if (narrowed > FLOAT_PI) return FLOAT_PI
  if (narrowed < -FLOAT_PI) return -FLOAT_PI
  return narrowed
}

/**
 * Swift's `truncatingRemainder(dividingBy:)` on `Float`. JavaScript `%` already truncates
 * toward zero with the same sign convention; the narrowing is what makes it single-precision.
 */
export function truncatingRemainderF32(value: number, divisor: number): number {
  return f32(f32(value) % f32(divisor))
}

/**
 * Swift's `Float.remainder(dividingBy:)` — IEEE 754 remainder, which rounds the quotient to
 * *nearest* rather than truncating, so the result lands in `[-divisor/2, divisor/2]`. This is
 * what keeps `YawSlew`'s shortest-arc delta from spinning the long way around; it is a
 * different operation from `truncatingRemainder` and JavaScript has no operator for it.
 */
export function ieeeRemainderF32(value: number, divisor: number): number {
  const narrowedValue = f32(value)
  const narrowedDivisor = f32(divisor)
  const rawQuotient = narrowedValue / narrowedDivisor
  const quotient = Math.round(rawQuotient)
  // Math.round breaks .5 ties upward while IEEE 754 breaks them to even; correct the tie so
  // an exact half-quotient matches Swift.
  // Always `- 1`, never `- sign`: `Math.round` breaks *every* tie toward +Infinity, so the
  // round-half-to-even neighbour is the value below for both signs. Subtracting the sign moves a
  // negative tie the wrong way — `Math.round(-1.5)` is `-1`, and `-1 - (-1)` is `0` rather than the
  // `-2` IEEE picks, leaving a remainder outside the range this function promises.
  const tieAdjusted = Math.abs(rawQuotient % 1) === 0.5 && quotient % 2 !== 0 ? quotient - 1 : quotient
  return f32(narrowedValue - tieAdjusted * narrowedDivisor)
}

/** Swift's `copysign(magnitude:sign:)` at single precision. */
export function copysignF32(magnitude: number, sign: number): number {
  return f32(sign < 0 || Object.is(sign, -0) ? -Math.abs(magnitude) : Math.abs(magnitude))
}
