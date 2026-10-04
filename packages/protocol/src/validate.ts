import { WireDecodingError } from './errors.ts';
import { SOMNIO_PROTOCOL_CONSTANTS, utf8ByteLength } from './constants.ts';

/**
 * Decode-time enforcement primitives: a missing key, a mismatched JSON type, an integer outside
 * the declared width, a non-finite float, and an unknown enum value are all rejected here.
 * TypeScript's structural types are erased at compile time and reject none of that, so every
 * inbound payload is narrowed through these helpers before it reaches a handler. Without them a
 * drifted or hostile frame is accepted and fails much later, far from the boundary.
 */

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;
const ID_PATTERN = /^[a-z0-9-]+$/;

export function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WireDecodingError(path, `expected an object, got ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

export function requireString(container: Record<string, unknown>, key: string, path: string): string {
  const value = container[key];
  if (typeof value !== 'string') {
    throw new WireDecodingError(`${path}.${key}`, `expected a string, got ${describe(value)}`);
  }
  return value;
}

export function requireBool(container: Record<string, unknown>, key: string, path: string): boolean {
  const value = container[key];
  if (typeof value !== 'boolean') {
    throw new WireDecodingError(`${path}.${key}`, `expected a bool, got ${describe(value)}`);
  }
  return value;
}

/**
 * A fractional value and anything outside the 32-bit signed range are rejected. JSON has one
 * number type, so both checks live here.
 */
export function requireInt32(container: Record<string, unknown>, key: string, path: string): number {
  const value = container[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new WireDecodingError(`${path}.${key}`, `expected Int32, got ${describe(value)}`);
  }
  if (!Number.isInteger(value)) {
    throw new WireDecodingError(`${path}.${key}`, `expected Int32, got fractional ${value}`);
  }
  if (value < INT32_MIN || value > INT32_MAX) {
    throw new WireDecodingError(`${path}.${key}`, `Int32 out of range: ${value}`);
  }
  return value;
}

/**
 * JSON has no NaN literal, but `1e999` parses to Infinity, and a decoded `null` or string must be
 * rejected here rather than propagating NaN into the transform math.
 */
export function requireFloat(container: Record<string, unknown>, key: string, path: string): number {
  const value = container[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new WireDecodingError(`${path}.${key}`, `expected a finite number, got ${describe(value)}`);
  }
  return value;
}

/** A coordinate or length in metres: finite and within `maxCoordinateMetres` of zero. */
export function requireMetres(container: Record<string, unknown>, key: string, path: string): number {
  const value = requireFloat(container, key, path);
  if (Math.abs(value) > SOMNIO_PROTOCOL_CONSTANTS.maxCoordinateMetres) {
    throw new WireDecodingError(`${path}.${key}`, `exceeds ${SOMNIO_PROTOCOL_CONSTANTS.maxCoordinateMetres} metres (got ${value})`);
  }
  return value;
}

export function requirePositiveMetres(container: Record<string, unknown>, key: string, path: string): number {
  const value = requireMetres(container, key, path);
  if (value <= 0) {
    throw new WireDecodingError(`${path}.${key}`, `expected a positive length, got ${value}`);
  }
  return value;
}

export function requireArray(container: Record<string, unknown>, key: string, path: string): unknown[] {
  const value = container[key];
  if (!Array.isArray(value)) {
    throw new WireDecodingError(`${path}.${key}`, `expected an array, got ${describe(value)}`);
  }
  return value;
}

export function requireNested(container: Record<string, unknown>, key: string, path: string): Record<string, unknown> {
  return requireObject(container[key], `${path}.${key}`);
}

export function mapArray<T>(
  container: Record<string, unknown>,
  key: string,
  path: string,
  decodeElement: (element: Record<string, unknown>, elementPath: string) => T,
): T[] {
  return requireArray(container, key, path).map((element, index) =>
    decodeElement(requireObject(element, `${path}.${key}[${index}]`), `${path}.${key}[${index}]`),
  );
}

/**
 * The record arrays of a sector: a missing key decodes as empty, the count is capped before any
 * element is decoded, and every `id` is unique within the array.
 */
export function mapRecords<T extends { id: string }>(
  container: Record<string, unknown>,
  key: string,
  path: string,
  maxCount: number,
  decodeElement: (element: Record<string, unknown>, elementPath: string) => T,
): T[] {
  if (isAbsent(container, key)) return [];
  const count = requireArray(container, key, path).length;
  if (count > maxCount) {
    throw new WireDecodingError(`${path}.${key}`, `exceeds ${maxCount} records (got ${count})`);
  }
  const records = mapArray(container, key, path, decodeElement);
  const seen = new Set<string>();
  records.forEach((record, index) => {
    if (seen.has(record.id)) {
      throw new WireDecodingError(`${path}.${key}[${index}].id`, `duplicate id "${record.id}"`);
    }
    seen.add(record.id);
  });
  return records;
}

/** Absent and explicit `null` both mean "not set". */
export function isAbsent(container: Record<string, unknown>, key: string): boolean {
  return container[key] === undefined || container[key] === null;
}

export function requireStringEnum<const T extends readonly string[]>(container: Record<string, unknown>, key: string, path: string, allowed: T): T[number] {
  const value = requireString(container, key, path);
  if (!allowed.includes(value)) {
    throw new WireDecodingError(`${path}.${key}`, `unknown value "${value}" (expected one of ${allowed.join(', ')})`);
  }
  return value;
}

/** A record id inside a sector: non-empty, lowercase letters, digits, and hyphens, within the identifier cap. */
export function requireId(container: Record<string, unknown>, key: string, path: string): string {
  const value = requireWithinByteCap(requireString(container, key, path), PROTOCOL_BYTE_CAPS.identifier, `${path}.${key}`);
  if (!ID_PATTERN.test(value)) {
    throw new WireDecodingError(`${path}.${key}`, `expected an id of lowercase letters, digits, and hyphens, got "${value}"`);
  }
  return value;
}

/** A runtime entity id on the wire: non-empty and within the entity-id cap. */
export function requireEntityId(container: Record<string, unknown>, key: string, path: string): string {
  return requireBoundedString(container, key, path, PROTOCOL_BYTE_CAPS.entityId);
}

/** A non-empty string within a UTF-8 byte cap. */
export function requireBoundedString(container: Record<string, unknown>, key: string, path: string, maxBytes: number): string {
  const value = requireWithinByteCap(requireString(container, key, path), maxBytes, `${path}.${key}`);
  if (value === '') {
    throw new WireDecodingError(`${path}.${key}`, 'expected a non-empty string');
  }
  return value;
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
  const byteLength = utf8ByteLength(value);
  if (byteLength > maxBytes) {
    throw new WireDecodingError(path, `exceeds ${maxBytes} UTF-8 bytes (got ${byteLength})`);
  }
  return value;
}

export const PROTOCOL_BYTE_CAPS = {
  /** A floor, not a cap, but it belongs with its siblings: one family, one lookup. */
  minPassword: SOMNIO_PROTOCOL_CONSTANTS.minPasswordUTF8Bytes,
  identifier: SOMNIO_PROTOCOL_CONSTANTS.maxIdentifierUTF8Bytes,
  password: SOMNIO_PROTOCOL_CONSTANTS.maxPasswordUTF8Bytes,
  say: SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes,
  sessionToken: SOMNIO_PROTOCOL_CONSTANTS.maxSessionTokenUTF8Bytes,
  entityId: SOMNIO_PROTOCOL_CONSTANTS.maxEntityIdUTF8Bytes,
  sectorName: SOMNIO_PROTOCOL_CONSTANTS.maxSectorNameUTF8Bytes,
} as const;

function describe(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}
