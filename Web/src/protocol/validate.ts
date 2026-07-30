import { WireDecodingError } from './errors'
import { SOMNIO_PROTOCOL_CONSTANTS, utf8ByteLength } from './constants'

/**
 * Decode-time enforcement primitives. Swift's synthesized `Codable` rejects a missing key,
 * a mismatched JSON type, an integer outside the declared width, a non-finite float, and an
 * unknown enum raw value. TypeScript's structural types are erased at compile time and
 * reject none of that, so every inbound payload is narrowed through these helpers before it
 * reaches the client. Without them a drifted or hostile frame is accepted and fails much
 * later somewhere in the renderer.
 */

// Re-stated locally on purpose: `@/core` must not become a dependency of the protocol layer, and
// these are the wire's own bounds. `core/geometry.ts` exports the same pair for the geometry side.
const INT16_MIN = -32_768
const INT16_MAX = 32_767
/** `Float.greatestFiniteMagnitude`, the boundary Swift's `JSONDecoder` rejects past. */
const FLOAT32_MAX = 3.4028234663852886e38
const INT32_MIN = -2_147_483_648
const INT32_MAX = 2_147_483_647
const UINT16_MAX = 65_535

export function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WireDecodingError(path, `expected an object, got ${describe(value)}`)
  }
  return value as Record<string, unknown>
}

export function requireString(container: Record<string, unknown>, key: string, path: string): string {
  const value = container[key]
  if (typeof value !== 'string') {
    throw new WireDecodingError(`${path}.${key}`, `expected a string, got ${describe(value)}`)
  }
  return value
}

export function requireBool(container: Record<string, unknown>, key: string, path: string): boolean {
  const value = container[key]
  if (typeof value !== 'boolean') {
    throw new WireDecodingError(`${path}.${key}`, `expected a bool, got ${describe(value)}`)
  }
  return value
}

/**
 * Swift decodes these fields as `Int16`, which throws on a fractional value and on anything
 * outside the 16-bit signed range. JSON has one number type, so both checks live here.
 */
export function requireInt16(container: Record<string, unknown>, key: string, path: string): number {
  return requireInteger(container, key, path, INT16_MIN, INT16_MAX, 'Int16')
}

export function requireUInt16(container: Record<string, unknown>, key: string, path: string): number {
  return requireInteger(container, key, path, 0, UINT16_MAX, 'UInt16')
}

/**
 * For durations, which overflow `Int16` immediately — a 30-day token lifetime is 2,592,000
 * seconds against an `Int16` ceiling of 32,767.
 */
export function requireInt32(container: Record<string, unknown>, key: string, path: string): number {
  return requireInteger(container, key, path, INT32_MIN, INT32_MAX, 'Int32')
}

function requireInteger(
  container: Record<string, unknown>,
  key: string,
  path: string,
  min: number,
  max: number,
  typeName: string
): number {
  const value = container[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new WireDecodingError(`${path}.${key}`, `expected ${typeName}, got ${describe(value)}`)
  }
  if (!Number.isInteger(value)) {
    throw new WireDecodingError(`${path}.${key}`, `expected ${typeName}, got fractional ${value}`)
  }
  if (value < min || value > max) {
    throw new WireDecodingError(`${path}.${key}`, `${typeName} out of range: ${value}`)
  }
  return value
}

/**
 * Swift decodes headings and other continuous fields as `Float`. A non-finite JSON literal
 * cannot occur (JSON has no NaN), but a decoded `null` or string must still be rejected here
 * rather than propagating NaN into the transform math.
 */
export function requireFloat(container: Record<string, unknown>, key: string, path: string): number {
  const value = container[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new WireDecodingError(`${path}.${key}`, `expected a finite number, got ${describe(value)}`)
  }
  // Binary64-finite is not enough. Swift decodes these as `Float` and `JSONDecoder` throws
  // `dataCorrupted` ("not representable in Swift") for anything past `Float.greatestFiniteMagnitude`
  // — verified down to 3.5e38, not just at absurd magnitudes. Accepting such a value here means
  // `Math.fround` turns it into Infinity and the heading math then produces NaN, so the entity's
  // transform goes invalid and it vanishes rather than being rejected at the boundary.
  if (Math.abs(value) > FLOAT32_MAX) {
    throw new WireDecodingError(`${path}.${key}`, `exceeds Float range (got ${value})`)
  }
  return value
}

export function requireArray(container: Record<string, unknown>, key: string, path: string): unknown[] {
  const value = container[key]
  if (!Array.isArray(value)) {
    throw new WireDecodingError(`${path}.${key}`, `expected an array, got ${describe(value)}`)
  }
  return value
}

export function requireNested(
  container: Record<string, unknown>,
  key: string,
  path: string
): Record<string, unknown> {
  return requireObject(container[key], `${path}.${key}`)
}

export function mapArray<T>(
  container: Record<string, unknown>,
  key: string,
  path: string,
  decodeElement: (element: Record<string, unknown>, elementPath: string) => T
): T[] {
  return requireArray(container, key, path).map((element, index) =>
    decodeElement(requireObject(element, `${path}.${key}[${index}]`), `${path}.${key}[${index}]`)
  )
}

/**
 * Mirrors an `Int16`-raw-value enum: Swift's synthesized `RawRepresentable` `Codable` throws
 * `DecodingError.dataCorrupted` for a value outside the case set.
 */
export function requireRawEnum<const T extends readonly number[]>(
  container: Record<string, unknown>,
  key: string,
  path: string,
  allowed: T
): T[number] {
  const value = requireInt16(container, key, path)
  if (!allowed.includes(value)) {
    throw new WireDecodingError(
      `${path}.${key}`,
      `unknown raw value ${value} (expected one of ${allowed.join(', ')})`
    )
  }
  return value
}

/**
 * Rejects a string whose UTF-8 length exceeds a protocol cap.
 *
 * Used on the **decode** path, where it is a hostile-server guard rather than a convenience: the
 * server caps what it accepts, but nothing caps what it *sends*, so a single 1 MiB `serverSay` (well
 * inside `maxFrameLength`) would reach `wrapSpeech`, split into half a million words, and call canvas
 * `measureText` once per word — freezing the tab. Outbound text is truncated at the form instead, so
 * the player sees a bounded field rather than a rejected frame.
 *
 * Counts through `utf8ByteLength` rather than a local `TextEncoder`, because `constants.ts` states
 * that every cap check in the browser routes through that one helper.
 */
export function requireWithinByteCap(value: string, maxBytes: number, path: string): string {
  const byteLength = utf8ByteLength(value)
  if (byteLength > maxBytes) {
    throw new WireDecodingError(path, `exceeds ${maxBytes} UTF-8 bytes (got ${byteLength})`)
  }
  return value
}

export const PROTOCOL_BYTE_CAPS = {
  /** A floor, not a cap, but it belongs with its siblings: one family, one lookup. */
  minPassword: SOMNIO_PROTOCOL_CONSTANTS.minPasswordUTF8Bytes,
  identifier: SOMNIO_PROTOCOL_CONSTANTS.maxIdentifierUTF8Bytes,
  password: SOMNIO_PROTOCOL_CONSTANTS.maxPasswordUTF8Bytes,
  say: SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes,
  sessionToken: SOMNIO_PROTOCOL_CONSTANTS.maxSessionTokenUTF8Bytes,
} as const

function describe(value: unknown): string {
  if (value === undefined) return 'nothing'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return typeof value
}
