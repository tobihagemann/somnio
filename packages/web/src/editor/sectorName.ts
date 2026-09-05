/** The sector file API route, shared by the dev-server middleware and the editor's client. */
export const SECTOR_API_PREFIX = '/__editor/sectors'

/**
 * Byte budget for a decoded sector name. A POSIX filename component is capped at 255 bytes, and
 * the on-disk name is the stem plus `.somnio-sector` (14 bytes) plus the atomic write's
 * `.tmp-<random>` suffix, so bounding the stem here keeps both the form and the file API from
 * ever handing the filesystem an `ENAMETOOLONG` — which, on the write path, would otherwise throw
 * inside a stream callback and take the dev server down.
 */
export const MAX_SECTOR_NAME_BYTES = 200

/**
 * The one sector-name policy, shared by the dev-server file middleware and the editor's
 * sector form — so a name the form accepts is exactly a name the file API serves, and
 * `foo/bar` or `.hidden` is refused in the form with a message rather than failing opaquely
 * when New Map or Save As reaches the API.
 *
 * Deliberately permissive beyond that: the form accepts any non-empty name, so spaces and
 * non-ASCII (`Nordwiese Süd`) stay authorable — the route component is percent-encoded, not
 * restricted to a filename-safe alphabet.
 */
export function isValidSectorName(name: string): boolean {
  if (name.length === 0) return false
  if (new TextEncoder().encode(name).length > MAX_SECTOR_NAME_BYTES) return false
  // Covers `.`, `..`, and dot-prefixed hidden names in one rule.
  if (name.startsWith('.')) return false
  return !name.includes('/') && !name.includes('\\') && !name.includes('\u0000')
}
