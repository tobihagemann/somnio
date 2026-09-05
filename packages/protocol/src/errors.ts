/** A frame whose tag is not in the protocol's vocabulary; distinct from a validation failure so the admin route can answer `unknownCommand`. */
export class UnrecognizedTagError extends Error {
  readonly tag: string;

  constructor(tag: string) {
    super(`unrecognizedTag(${tag})`);
    this.name = 'UnrecognizedTagError';
    this.tag = tag;
  }
}

/** A frame over `maxFrameLength`. */
export class OversizedFrameError extends Error {
  readonly byteCount: number;

  constructor(byteCount: number) {
    super(`oversizedFrame(${byteCount})`);
    this.name = 'OversizedFrameError';
    this.byteCount = byteCount;
  }
}

/**
 * The decode-time rejection raised by the validators in `validate.ts`. `path` names the offending
 * field so a drifted payload is legible rather than surfacing later as an inscrutable rendering bug.
 */
export class WireDecodingError extends Error {
  readonly path: string;
  readonly detail: string;

  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = 'WireDecodingError';
    this.path = path;
    this.detail = detail;
  }
}
