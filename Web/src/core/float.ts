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

/**
 * Foundation's shortest-round-trip decimal for a `Float`, as `JSONEncoder` writes it
 * (`270 -> "270"`, `123.456 -> "123.456"`, `1/3 -> "0.33333334"`, `1e-06 -> "1e-06"`).
 *
 * `NPC.facing` (via `Heading.degrees`) is the **only** `Float` anywhere in the on-disk sector
 * model — every other field is `Int16`/`String`/`Bool` — so this exists solely for the
 * `"direction"` key. A heading is in `[0, 360)`, so the one place Swift and JS pick different
 * spellings is a magnitude below `1e-4` (reachable by typing a tiny value into the Facing field):
 * Foundation switches to scientific notation there, which `foundationFloatString` reproduces.
 *
 * The candidates are compared against the **narrowed** target, not the raw binary64 input: the
 * double `123.456` is not equal to its Float32 representation, so comparing against the input
 * finds no match at all for any value that is not exactly representable in binary32.
 */
export function formatSwiftFloat32(value: number): string {
  const target = f32(value)
  if (target === 0) return foundationFloatString(target)
  for (let precision = 1; precision <= 9; precision += 1) {
    if (f32(Number(target.toPrecision(precision))) !== target) continue
    // `precision` is the shortest round-tripping length. `toPrecision` rounds ties away from zero,
    // but Swift's shortest-format rounds ties to even (`334.515625` -> `334.51562`, not `...63`).
    // Bracket the target with the two decimals of this length and pick the one Foundation would:
    // nearest to the exact Float32 value, ties broken to the even last digit.
    const exponent = Math.floor(Math.log10(Math.abs(target)))
    const unit = Math.pow(10, exponent - (precision - 1))
    const scaled = target / unit
    const down = Number((Math.floor(scaled) * unit).toPrecision(precision))
    const up = Number((Math.ceil(scaled) * unit).toPrecision(precision))
    const roundTrips = [down, up].filter((candidate) => f32(candidate) === target)
    let chosen: number
    if (roundTrips.length === 1) {
      chosen = roundTrips[0]!
    } else {
      const distanceDown = Math.abs(target - down)
      const distanceUp = Math.abs(up - target)
      if (distanceDown < distanceUp) chosen = down
      else if (distanceUp < distanceDown) chosen = up
      else chosen = Math.abs(Math.round(down / unit)) % 2 === 0 ? down : up
    }
    return foundationFloatString(chosen)
  }
  return foundationFloatString(target)
}

/**
 * Spells `n` the way Foundation's `Float` encoder does. `String(n)` already agrees for the fixed
 * range, but Foundation uses scientific notation for a magnitude below `1e-4` — `1e-06`, not
 * `0.000001` — with the exponent as a sign and **at least two** digits (`e-06`, not JS's `e-6`).
 * `n` already carries only the digits that round-trip the Float32, so `toExponential()` with no
 * argument yields the shortest mantissa.
 */
function foundationFloatString(n: number): string {
  if (n !== 0 && Math.abs(n) < 1e-4) {
    const [mantissa, exponent] = n.toExponential().split('e')
    const sign = exponent!.startsWith('-') ? '-' : '+'
    const digits = exponent!.replace(/[+-]/, '').padStart(2, '0')
    return `${mantissa}e${sign}${digits}`
  }
  return String(n)
}
