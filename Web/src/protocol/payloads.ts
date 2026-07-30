import type { WireInventoryRow, WireSector, WireHand } from './wire'
import { WIRE_HAND_VALUES, decodeWireInventoryRow, decodeWireSector } from './wire'
import { truncateToUTF8Bytes } from './constants'
import {
  PROTOCOL_BYTE_CAPS,
  mapArray,
  requireBool,
  requireFloat,
  requireInt16,
  requireInt32,
  requireNested,
  requireRawEnum,
  requireString,
  requireUInt16,
  requireWithinByteCap,
} from './validate'

/**
 * Mirror of `Sources/SomnioProtocol/Payloads/`. One interface per payload struct, property
 * names verbatim, plus a runtime decoder per payload so an inbound frame is rejected exactly
 * where Swift's `Codable` would reject it.
 */

export interface LoginMessage {
  nickname: string
  password: string
  /**
   * Request a resumable session token alongside a successful login. Optional so a client
   * built before this field still decodes on a token-aware server (Swift's synthesized
   * `Codable` emits `decodeIfPresent` for Optionals) — which is what keeps `helloVersion` at
   * 3. Omitting it must yield no `sessionToken` frame at all.
   */
  requestSessionToken?: boolean
}

export interface RegisterMessage {
  nickname: string
  password: string
  passwordRepeat: string
  characterClass: number
  gender: number
  email: string
}

export interface PositionMessage {
  entityIndex: number
  x: number
  y: number
  /** Continuous heading in degrees `[0, 360)` (0 = south, 90 = east). */
  facing: number
  tempo: number
}

export interface SayMessage {
  entityIndex: number
  text: string
}

export interface EquipToggleMessage {
  slot: number
  hand: WireHand
}

export interface BumpNPCMessage {
  npcIndex: number
}

export interface EnterPortalMessage {
  portalIndex: number
}

/** Redeem a stored session token in place of a password login. Accepted pre-login only. */
export interface RedeemSessionMessage {
  token: string
}

/** Revoke the token presented on this connection. Accepted post-attach only. */
export interface RevokeSessionMessage {
  token: string
}

export interface HelloMessage {
  protocolVersion: number
}

/**
 * The named map is the single declaration; the accepted-value list and the union are derived.
 *
 * Stating the set twice is how a new case gets added to the map and forgotten in the list, at which
 * point the decoder rejects the value the server just started sending and reports a decode failure.
 * Deriving mirrors the Swift original more closely too, where one `Int16` raw-value enum declares
 * the names and the accepted set together.
 */
export const LOGIN_RESULT = { ok: 0, badCredentials: 1, alreadyLoggedIn: 2 } as const
export const LOGIN_RESULT_CODES = Object.values(LOGIN_RESULT)
export type LoginResultCode = (typeof LOGIN_RESULT)[keyof typeof LOGIN_RESULT]

export interface LoginResultMessage {
  result: LoginResultCode
}

export const REGISTER_RESULT = {
  ok: 0,
  nicknameExists: 1,
  failure: 2,
  nameNotAllowed: 3,
} as const
export const REGISTER_RESULT_CODES = Object.values(REGISTER_RESULT)
export type RegisterResultCode = (typeof REGISTER_RESULT)[keyof typeof REGISTER_RESULT]

export interface RegisterResultMessage {
  result: RegisterResultCode
}

export interface EnterSectorMessage {
  sector: WireSector
}

export interface MainCharacterMessage {
  entityIndex: number
}

export const WIRE_ENTITY_TYPE = { player: 0, npc: 1, monster: 2 } as const
export const WIRE_ENTITY_TYPES = Object.values(WIRE_ENTITY_TYPE)
export type WireEntityType = (typeof WIRE_ENTITY_TYPE)[keyof typeof WIRE_ENTITY_TYPE]

export interface EntityMessage {
  entityIndex: number
  figure: number
  gender: number
  maskWidth: number
  maskHeight: number
  type: WireEntityType
  name: string
  x: number
  y: number
  facing: number
  tempo: number
}

export interface Energy {
  hpCurrent: number
  hpMax: number
  balanceCurrent: number
  balanceMax: number
  manaCurrent: number
  manaMax: number
}

export interface DateTickMessage {
  hour: number
  minute: number
}

export interface InventoryMessage {
  rows: WireInventoryRow[]
}

export interface LeaveMessage {
  entityIndex: number
  leftGame: boolean
}

export interface AdminSayMessage {
  text: string
}

/**
 * Issued once, in response to a `Login` that asked for it. A successful `redeemSession` resolves the
 * presented token and deliberately mints no replacement, so no frame of this kind follows a resume —
 * rotating there would invalidate the credential the bounded `alreadyLoggedIn` retry still needs.
 * The raw token is returned exactly once — the server stores only a digest.
 */
export interface SessionTokenMessage {
  token: string
  /**
   * Seconds until expiry, so the client never has to trust its own clock offset. `Int32` on
   * the Swift side: the 30-day lifetime is 2,592,000 seconds, well past an `Int16` ceiling.
   */
  expiresInSeconds: number
}

/** Acknowledgement that the presented token's row is gone. */
export interface SessionRevokedMessage {
  revoked: boolean
}

// MARK: - Decoders

export function decodeLoginMessage(container: Record<string, unknown>, path: string): LoginMessage {
  // `requestSessionToken` is the one Optional on this payload — the additive field that keeps
  // `helloVersion` at 3 — so absent and explicit `null` both decode as "not requested", the way
  // Swift's synthesized `decodeIfPresent` does, while a present value is still type-checked.
  const raw = container['requestSessionToken']
  const requestSessionToken =
    raw === undefined || raw === null ? undefined : requireBool(container, 'requestSessionToken', path)
  return {
    nickname: requireString(container, 'nickname', path),
    password: requireString(container, 'password', path),
    ...(requestSessionToken === undefined ? {} : { requestSessionToken }),
  }
}

export function decodeRegisterMessage(container: Record<string, unknown>, path: string): RegisterMessage {
  return {
    nickname: requireString(container, 'nickname', path),
    password: requireString(container, 'password', path),
    passwordRepeat: requireString(container, 'passwordRepeat', path),
    characterClass: requireInt16(container, 'characterClass', path),
    gender: requireInt16(container, 'gender', path),
    email: requireString(container, 'email', path),
  }
}

export function decodePositionMessage(container: Record<string, unknown>, path: string): PositionMessage {
  return {
    entityIndex: requireInt16(container, 'entityIndex', path),
    x: requireInt16(container, 'x', path),
    y: requireInt16(container, 'y', path),
    facing: requireFloat(container, 'facing', path),
    tempo: requireInt16(container, 'tempo', path),
  }
}

/**
 * Chat text is capped on decode, not only on send.
 *
 * The server caps what it *accepts* but nothing caps what it sends, so a hostile or buggy server
 * could ship a megabyte of text inside the frame limit. That text reaches `wrapSpeech`, which
 * tokenizes on spaces and measures each word through the canvas — half a million `measureText`
 * calls freeze the tab with the player unable to move or log out. The same reasoning already
 * hardens the name plaque.
 */
export function decodeSayMessage(container: Record<string, unknown>, path: string): SayMessage {
  return {
    entityIndex: requireInt16(container, 'entityIndex', path),
    text: requireWithinByteCap(
      requireString(container, 'text', path),
      PROTOCOL_BYTE_CAPS.say,
      `${path}.text`
    ),
  }
}

export function decodeEquipToggleMessage(
  container: Record<string, unknown>,
  path: string
): EquipToggleMessage {
  return {
    slot: requireInt16(container, 'slot', path),
    hand: requireRawEnum(container, 'hand', path, WIRE_HAND_VALUES),
  }
}

export function decodeBumpNPCMessage(container: Record<string, unknown>, path: string): BumpNPCMessage {
  return { npcIndex: requireInt16(container, 'npcIndex', path) }
}

export function decodeEnterPortalMessage(
  container: Record<string, unknown>,
  path: string
): EnterPortalMessage {
  return { portalIndex: requireInt16(container, 'portalIndex', path) }
}

export function decodeRedeemSessionMessage(
  container: Record<string, unknown>,
  path: string
): RedeemSessionMessage {
  return {
    token: requireWithinByteCap(
      requireString(container, 'token', path),
      PROTOCOL_BYTE_CAPS.sessionToken,
      `${path}.token`
    ),
  }
}

/** Capped like its redeem twin: `SessionHandler` carries the identical guard on both halves. */
export function decodeRevokeSessionMessage(
  container: Record<string, unknown>,
  path: string
): RevokeSessionMessage {
  return {
    token: requireWithinByteCap(
      requireString(container, 'token', path),
      PROTOCOL_BYTE_CAPS.sessionToken,
      `${path}.token`
    ),
  }
}

export function decodeHelloMessage(container: Record<string, unknown>, path: string): HelloMessage {
  return { protocolVersion: requireUInt16(container, 'protocolVersion', path) }
}

export function decodeLoginResultMessage(
  container: Record<string, unknown>,
  path: string
): LoginResultMessage {
  return { result: requireRawEnum(container, 'result', path, LOGIN_RESULT_CODES) }
}

export function decodeRegisterResultMessage(
  container: Record<string, unknown>,
  path: string
): RegisterResultMessage {
  return { result: requireRawEnum(container, 'result', path, REGISTER_RESULT_CODES) }
}

export function decodeEnterSectorMessage(
  container: Record<string, unknown>,
  path: string
): EnterSectorMessage {
  return { sector: decodeWireSector(requireNested(container, 'sector', path), `${path}.sector`) }
}

export function decodeMainCharacterMessage(
  container: Record<string, unknown>,
  path: string
): MainCharacterMessage {
  return { entityIndex: requireInt16(container, 'entityIndex', path) }
}

/**
 * The entity name is bounded on decode for the same reason chat text is: nothing caps what the
 * server *sends*, and a name is retained three times over — in the entity map, in the roster (which
 * re-runs a collating sort on every arrival), and in the `left` chat line when the peer departs.
 *
 * **Truncated, not rejected.** This field carries operator-authored NPC and monster names as well as
 * player nicknames, and only the nicknames are bounded: `maxIdentifierUTF8Bytes` is enforced by the
 * login and registration handlers, while the sector format bounds NPC and monster names nowhere.
 * Rejecting would therefore make the browser refuse a sector the native client renders happily, on
 * nothing worse than a long authored label. Truncating keeps the retention bound and matches what
 * the native client effectively shows, since `NamePlaqueArt` clamps to the same constant at raster
 * time.
 */
export function decodeEntityMessage(container: Record<string, unknown>, path: string): EntityMessage {
  return {
    entityIndex: requireInt16(container, 'entityIndex', path),
    figure: requireInt16(container, 'figure', path),
    gender: requireInt16(container, 'gender', path),
    maskWidth: requireInt16(container, 'maskWidth', path),
    maskHeight: requireInt16(container, 'maskHeight', path),
    type: requireRawEnum(container, 'type', path, WIRE_ENTITY_TYPES),
    name: truncateToUTF8Bytes(requireString(container, 'name', path), PROTOCOL_BYTE_CAPS.identifier),
    x: requireInt16(container, 'x', path),
    y: requireInt16(container, 'y', path),
    facing: requireFloat(container, 'facing', path),
    tempo: requireInt16(container, 'tempo', path),
  }
}

export function decodeEnergy(container: Record<string, unknown>, path: string): Energy {
  return {
    hpCurrent: requireInt16(container, 'hpCurrent', path),
    hpMax: requireInt16(container, 'hpMax', path),
    balanceCurrent: requireInt16(container, 'balanceCurrent', path),
    balanceMax: requireInt16(container, 'balanceMax', path),
    manaCurrent: requireInt16(container, 'manaCurrent', path),
    manaMax: requireInt16(container, 'manaMax', path),
  }
}

export function decodeDateTickMessage(container: Record<string, unknown>, path: string): DateTickMessage {
  return {
    hour: requireInt16(container, 'hour', path),
    minute: requireInt16(container, 'minute', path),
  }
}

export function decodeInventoryMessage(container: Record<string, unknown>, path: string): InventoryMessage {
  return { rows: mapArray(container, 'rows', path, decodeWireInventoryRow) }
}

export function decodeLeaveMessage(container: Record<string, unknown>, path: string): LeaveMessage {
  return {
    entityIndex: requireInt16(container, 'entityIndex', path),
    leftGame: requireBool(container, 'leftGame', path),
  }
}

export function decodeAdminSayMessage(container: Record<string, unknown>, path: string): AdminSayMessage {
  return {
    text: requireWithinByteCap(
      requireString(container, 'text', path),
      PROTOCOL_BYTE_CAPS.say,
      `${path}.text`
    ),
  }
}

export function decodeSessionTokenMessage(
  container: Record<string, unknown>,
  path: string
): SessionTokenMessage {
  return {
    // Capped on the way in like `say` and `adminSay`, for the same reason those are: the server
    // bounds what it *accepts*, nothing bounds what it sends. An oversized token would otherwise be
    // written to `localStorage` and cost a full connect-and-redeem round trip on every later load
    // before the server's own cap rejected it.
    token: requireWithinByteCap(
      requireString(container, 'token', path),
      PROTOCOL_BYTE_CAPS.sessionToken,
      `${path}.token`
    ),
    expiresInSeconds: requireInt32(container, 'expiresInSeconds', path),
  }
}

export function decodeSessionRevokedMessage(
  container: Record<string, unknown>,
  path: string
): SessionRevokedMessage {
  return { revoked: requireBool(container, 'revoked', path) }
}
