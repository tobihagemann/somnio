/**
 * Mirror of `Sources/SomnioProtocol/Constants.swift`. Hand-mirrored rather than generated:
 * the struct set is small and flat, while a generator would still not verify close codes or
 * frame limits — the cross-language conformance suite is what catches drift here.
 */
export const SOMNIO_PROTOCOL_CONSTANTS = {
  /**
   * Strict equality at the hello gate on both sides, so this must equal the Swift value
   * exactly. A mismatch in either direction rejects the connection rather than degrading it.
   */
  helloVersion: 3,
  maxFrameLength: 1 << 20,

  /** UTF-8 byte cap for `nickname` and `email` on login/registration. */
  maxIdentifierUTF8Bytes: 64,
  /** UTF-8 byte cap for `password`. */
  maxPasswordUTF8Bytes: 128,
  /** Minimum UTF-8 byte floor for a registration password. */
  minPasswordUTF8Bytes: 8,
  /** UTF-8 byte cap for chat and admin-say text. */
  maxSayUTF8Bytes: 256,
  /**
   * UTF-8 cap for `redeemSession`/`revokeSession` tokens, mirroring
   * `SomnioProtocolConstants.maxSessionTokenUTF8Bytes`. A base64url 256-bit token is 43 characters,
   * so this is headroom; the point is that a tampered or oversized value in `localStorage` is
   * refused here instead of costing a round trip.
   */
  maxSessionTokenUTF8Bytes: 256,

  /**
   * Slack the WebSocket-layer frame ceiling keeps above the encoder guard, so an oversized
   * message throws at encode time rather than the receiver hard-closing.
   */
  frameSizeSlack: 64,
} as const

/** Convenience mirror of the Swift `maxWireFrameSize`. */
export const MAX_WIRE_FRAME_SIZE =
  SOMNIO_PROTOCOL_CONSTANTS.maxFrameLength + SOMNIO_PROTOCOL_CONSTANTS.frameSizeSlack

/**
 * UTF-8 byte length. `String.prototype.length` counts UTF-16 code units, so it disagrees
 * with every Swift cap above the moment a field carries a non-ASCII character (an umlaut is
 * one code unit but two UTF-8 bytes; an emoji is two code units but four bytes). Every
 * cap check in the browser must route through here.
 */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

/**
 * Truncates `value` to at most `maxBytes` UTF-8 bytes without splitting a character.
 * `TextDecoder` in non-fatal mode would emit a replacement character for a severed
 * sequence, so the cut is walked back to a code-point boundary instead.
 */
export function truncateToUTF8Bytes(value: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(value)
  if (encoded.length <= maxBytes) return value
  let end = maxBytes
  // 0b10xxxxxx marks a UTF-8 continuation byte; walk back off one to land on a lead byte.
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1
  return new TextDecoder().decode(encoded.subarray(0, end))
}
