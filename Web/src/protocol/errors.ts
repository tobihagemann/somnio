/** Mirror of `SomnioProtocolError.unrecognizedTag`. */
export class UnrecognizedTagError extends Error {
  readonly tag: string

  constructor(tag: string) {
    super(`unrecognizedTag(${tag})`)
    this.name = 'UnrecognizedTagError'
    this.tag = tag
  }
}

/** Mirror of `SomnioProtocolError.oversizedFrame`. */
export class OversizedFrameError extends Error {
  readonly byteCount: number

  constructor(byteCount: number) {
    super(`oversizedFrame(${byteCount})`)
    this.name = 'OversizedFrameError'
    this.byteCount = byteCount
  }
}

/**
 * The browser counterpart of Swift's `DecodingError`. `Codable` rejects a missing key, a
 * wrong JSON type, an out-of-range integer, and an unknown enum raw value at decode time;
 * TypeScript interfaces are erased at compile time and reject none of it, so the runtime
 * validators raise this instead. `path` names the offending field so a drifted payload is
 * legible rather than surfacing later as an inscrutable rendering bug.
 */
export class WireDecodingError extends Error {
  readonly path: string
  readonly detail: string

  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`)
    this.name = 'WireDecodingError'
    this.path = path
    this.detail = detail
  }
}
