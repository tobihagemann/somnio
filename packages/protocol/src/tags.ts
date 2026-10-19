/**
 * The message tags of the protocol package: the complete discriminator vocabulary,
 * client-to-server first, then server-to-client.
 */
const CLIENT_TO_SERVER_TAGS = [
  'login',
  'register',
  'move',
  'clientSay',
  'equipToggle',
  'talk',
  'swing',
  'tend',
  'useDoor',
  'askTask',
  'completeTask',
  'abandonTask',
  'study',
  'buy',
  'sell',
  'wake',
  'useItem',
  // Remembered sessions. `redeemSession` is accepted pre-login: it is an alternative to a password
  // login and reuses `loginResult` for its outcome. `revokeSession` and `revokeOtherSessions` are
  // accepted only post-attach. The server sends their answers only on request. `otherSessions`,
  // sent unasked at a login or resume, answers none of them.
  'redeemSession',
  'revokeSession',
  'revokeOtherSessions',
] as const;

const SERVER_TO_CLIENT_TAGS = [
  'hello',
  'loginResult',
  'registerResult',
  'enterSpace',
  'sector',
  'entity',
  'moves',
  'correction',
  'doorRefused',
  'serverSay',
  'energy',
  'inventory',
  'leave',
  'lucidity',
  'condition',
  'blow',
  'raising',
  'mend',
  'adminSay',
  'sessionToken',
  'sessionRevoked',
  'otherSessions',
  'otherSessionsRevoked',
] as const;

export const SOMNIO_MESSAGE_TAGS = [...CLIENT_TO_SERVER_TAGS, ...SERVER_TO_CLIENT_TAGS] as const;

export type ClientToServerTag = (typeof CLIENT_TO_SERVER_TAGS)[number];
export type SomnioMessageTag = (typeof SOMNIO_MESSAGE_TAGS)[number];

const CLIENT_TAG_SET: ReadonlySet<string> = new Set(CLIENT_TO_SERVER_TAGS);
const ALL_TAG_SET: ReadonlySet<string> = new Set(SOMNIO_MESSAGE_TAGS);

export function isSomnioMessageTag(value: string): value is SomnioMessageTag {
  return ALL_TAG_SET.has(value);
}

/**
 * A client-only tag arriving inbound is a hard error, matching the player client's dispatch.
 * The direction check is a real gate, not a formality: it catches a server (or a
 * man-in-the-middle) echoing the client's own vocabulary back.
 */
export function isClientOnlyTag(tag: SomnioMessageTag): tag is ClientToServerTag {
  return CLIENT_TAG_SET.has(tag);
}
