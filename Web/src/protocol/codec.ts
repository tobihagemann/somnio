import { SOMNIO_PROTOCOL_CONSTANTS, utf8ByteLength } from './constants'
import { OversizedFrameError, UnrecognizedTagError, WireDecodingError } from './errors'
import type { SomnioMessage } from './message'
import {
  decodeAdminSayMessage,
  decodeBumpNPCMessage,
  decodeDateTickMessage,
  decodeEnergy,
  decodeEnterPortalMessage,
  decodeEnterSectorMessage,
  decodeEntityMessage,
  decodeEquipToggleMessage,
  decodeHelloMessage,
  decodeInventoryMessage,
  decodeLeaveMessage,
  decodeLoginMessage,
  decodeLoginResultMessage,
  decodeMainCharacterMessage,
  decodePositionMessage,
  decodeRedeemSessionMessage,
  decodeRegisterMessage,
  decodeRegisterResultMessage,
  decodeRevokeSessionMessage,
  decodeSayMessage,
  decodeSessionRevokedMessage,
  decodeSessionTokenMessage,
} from './payloads'
import { isSomnioMessageTag, type SomnioMessageTag } from './tags'
import { requireObject } from './validate'

/**
 * Mirror of `SomnioMessageEncoder` / `SomnioMessageDecoder`. Frames are JSON over WebSocket
 * **text** frames; the boundary converts to and from `string` at the frame edge, never
 * `ArrayBuffer` — the Swift server closes on any binary frame.
 */

type PayloadDecoder = (container: Record<string, unknown>, path: string) => unknown

/**
 * Tag-to-decoder table. Exhaustive over `SomnioMessageTag` by the `Record` type, so adding a
 * tag to the union without a decoder is a compile error rather than a runtime surprise.
 */
const PAYLOAD_DECODERS: Record<SomnioMessageTag, PayloadDecoder> = {
  login: decodeLoginMessage,
  register: decodeRegisterMessage,
  clientPosition: decodePositionMessage,
  clientSay: decodeSayMessage,
  equipToggle: decodeEquipToggleMessage,
  bumpNPC: decodeBumpNPCMessage,
  enterPortal: decodeEnterPortalMessage,
  redeemSession: decodeRedeemSessionMessage,
  revokeSession: decodeRevokeSessionMessage,
  hello: decodeHelloMessage,
  loginResult: decodeLoginResultMessage,
  registerResult: decodeRegisterResultMessage,
  enterSector: decodeEnterSectorMessage,
  mainCharacter: decodeMainCharacterMessage,
  entity: decodeEntityMessage,
  serverPosition: decodePositionMessage,
  serverSay: decodeSayMessage,
  energy: decodeEnergy,
  dateTick: decodeDateTickMessage,
  inventory: decodeInventoryMessage,
  leave: decodeLeaveMessage,
  adminSay: decodeAdminSayMessage,
  sessionToken: decodeSessionTokenMessage,
  sessionRevoked: decodeSessionRevokedMessage,
}

/**
 * Encodes a message to the JSON text a WebSocket `send` takes. Guards `maxFrameLength` the
 * way the Swift encoder does, so an abusive frame throws here rather than tripping the
 * receiver's hard close.
 */
export function encodeSomnioMessage(message: SomnioMessage): string {
  const text = JSON.stringify({ tag: message.tag, payload: message.payload })
  const byteCount = utf8ByteLength(text)
  if (byteCount > SOMNIO_PROTOCOL_CONSTANTS.maxFrameLength) {
    throw new OversizedFrameError(byteCount)
  }
  return text
}

/**
 * Decodes one inbound text frame. Three rejections mirror the Swift decoder — malformed JSON,
 * an unknown tag, and a known tag whose payload fails validation — plus one the browser has
 * to add itself: an inbound size cap. Swift gets that from the WebSocket layer's
 * `maxFrameSize` knob, which the browser `WebSocket` does not expose, so enforcing it here is
 * the only place the divergence can be closed.
 */
export function decodeSomnioMessage(frame: string): SomnioMessage {
  const byteCount = utf8ByteLength(frame)
  if (byteCount > SOMNIO_PROTOCOL_CONSTANTS.maxFrameLength) {
    throw new OversizedFrameError(byteCount)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(frame)
  } catch (cause) {
    throw new WireDecodingError('<frame>', `malformed JSON (${(cause as Error).message})`)
  }

  const container = requireObject(parsed, '<frame>')
  const rawTag = container['tag']
  if (typeof rawTag !== 'string') {
    throw new WireDecodingError('<frame>.tag', 'expected a string discriminator')
  }
  if (!isSomnioMessageTag(rawTag)) {
    throw new UnrecognizedTagError(rawTag)
  }

  const payloadContainer = requireObject(container['payload'], `<frame>.payload(${rawTag})`)
  const payload = PAYLOAD_DECODERS[rawTag](payloadContainer, rawTag)
  return { tag: rawTag, payload } as SomnioMessage
}
