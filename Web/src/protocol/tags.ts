/**
 * Mirror of `SomnioMessageTag` (`Sources/SomnioProtocol/Frame.swift`). The tag string equals
 * the Swift case name, so this list is the complete discriminator vocabulary. Order matches
 * the Swift file: client-to-server first, then server-to-client.
 */
export const CLIENT_TO_SERVER_TAGS = [
  'login',
  'register',
  'clientPosition',
  'clientSay',
  'equipToggle',
  'bumpNPC',
  'enterPortal',
  // Session resumption. `redeemSession` is accepted pre-login (it is an alternative to a
  // password login and reuses `loginResult` for its outcome); `revokeSession` is accepted
  // only post-attach. Both are request-gated: the server never volunteers either response.
  'redeemSession',
  'revokeSession',
] as const

export const SERVER_TO_CLIENT_TAGS = [
  'hello',
  'loginResult',
  'registerResult',
  'enterSector',
  'mainCharacter',
  'entity',
  'serverPosition',
  'serverSay',
  'energy',
  'dateTick',
  'inventory',
  'leave',
  'adminSay',
  'sessionToken',
  'sessionRevoked',
] as const

export const SOMNIO_MESSAGE_TAGS = [...CLIENT_TO_SERVER_TAGS, ...SERVER_TO_CLIENT_TAGS] as const

export type ClientToServerTag = (typeof CLIENT_TO_SERVER_TAGS)[number]
export type SomnioMessageTag = (typeof SOMNIO_MESSAGE_TAGS)[number]

const CLIENT_TAG_SET: ReadonlySet<string> = new Set(CLIENT_TO_SERVER_TAGS)
const ALL_TAG_SET: ReadonlySet<string> = new Set(SOMNIO_MESSAGE_TAGS)

export function isSomnioMessageTag(value: string): value is SomnioMessageTag {
  return ALL_TAG_SET.has(value)
}

/**
 * A client-only tag arriving inbound is a hard error, matching the player client's dispatch.
 * The direction check is a real gate, not a formality: it catches a server (or a
 * man-in-the-middle) echoing the client's own vocabulary back.
 */
export function isClientOnlyTag(tag: SomnioMessageTag): tag is ClientToServerTag {
  return CLIENT_TAG_SET.has(tag)
}
