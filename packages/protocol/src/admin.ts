import { UnrecognizedTagError, WireDecodingError } from './errors.ts';
import { requireObject, requireString } from './validate.ts';

/**
 * The `/admin` WebSocket request/response set. Travels as JSON over text frames in the shape
 * `{"tag":"<verb>","payload":"<text>"}`; only the payload-bearing variants carry the `payload`
 * key — a bare verb encodes as `{"tag":"<verb>"}` with no `payload` at all, never `null`.
 */

export const ADMIN_REQUEST_TAGS = ['log', 'weblog', 'players', 'time', 'say', 'kick', 'version', 'logRemove', 'weblogRemove'] as const;
export type AdminRequestTag = (typeof ADMIN_REQUEST_TAGS)[number];

export type AdminRequest =
  | { tag: 'log' }
  | { tag: 'weblog' }
  | { tag: 'players' }
  | { tag: 'time' }
  | { tag: 'say'; payload: string }
  | { tag: 'kick'; payload: string }
  | { tag: 'version' }
  | { tag: 'logRemove' }
  | { tag: 'weblogRemove' };

export const ADMIN_RESPONSE_TAGS = [
  'logContents',
  'weblogContents',
  'logEmpty',
  'logRemoved',
  'weblogEmpty',
  'weblogRemoved',
  'playerCount',
  'worldClock',
  'sayBroadcast',
  'kickedPlayer',
  'kickedPlayerNotFound',
  'versionString',
  'unknownCommand',
] as const;
export type AdminResponseTag = (typeof ADMIN_RESPONSE_TAGS)[number];

/** Payload-bearing responses carry the localized output the CLI prints to the operator's terminal. */
export type AdminResponse =
  | { tag: 'logContents'; payload: string }
  | { tag: 'weblogContents'; payload: string }
  | { tag: 'logEmpty' }
  | { tag: 'logRemoved' }
  | { tag: 'weblogEmpty' }
  | { tag: 'weblogRemoved' }
  | { tag: 'playerCount'; payload: string }
  | { tag: 'worldClock'; payload: string }
  | { tag: 'sayBroadcast'; payload: string }
  | { tag: 'kickedPlayer'; payload: string }
  | { tag: 'kickedPlayerNotFound'; payload: string }
  | { tag: 'versionString'; payload: string }
  | { tag: 'unknownCommand' };

const REQUEST_PAYLOAD_TAGS: ReadonlySet<AdminRequestTag> = new Set(['say', 'kick']);
const RESPONSE_PAYLOAD_TAGS: ReadonlySet<AdminResponseTag> = new Set([
  'logContents',
  'weblogContents',
  'playerCount',
  'worldClock',
  'sayBroadcast',
  'kickedPlayer',
  'kickedPlayerNotFound',
  'versionString',
]);
const REQUEST_TAG_SET: ReadonlySet<string> = new Set(ADMIN_REQUEST_TAGS);
const RESPONSE_TAG_SET: ReadonlySet<string> = new Set(ADMIN_RESPONSE_TAGS);

export function encodeAdminRequest(request: AdminRequest): string {
  return JSON.stringify(request);
}

export function encodeAdminResponse(response: AdminResponse): string {
  return JSON.stringify(response);
}

export function decodeAdminRequest(frame: string): AdminRequest {
  const { tag, container } = decodeTaggedFrame(frame, REQUEST_TAG_SET);
  if (REQUEST_PAYLOAD_TAGS.has(tag as AdminRequestTag)) {
    return { tag, payload: requireString(container, 'payload', `<frame>(${tag})`) } as AdminRequest;
  }
  return { tag } as AdminRequest;
}

export function decodeAdminResponse(frame: string): AdminResponse {
  const { tag, container } = decodeTaggedFrame(frame, RESPONSE_TAG_SET);
  if (RESPONSE_PAYLOAD_TAGS.has(tag as AdminResponseTag)) {
    return { tag, payload: requireString(container, 'payload', `<frame>(${tag})`) } as AdminResponse;
  }
  return { tag } as AdminResponse;
}

/** Shared framing: the discriminator is read first, so an unknown verb is `UnrecognizedTagError`. */
function decodeTaggedFrame(frame: string, known: ReadonlySet<string>): { tag: string; container: Record<string, unknown> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame);
  } catch (cause) {
    throw new WireDecodingError('<frame>', `malformed JSON (${(cause as Error).message})`);
  }
  const container = requireObject(parsed, '<frame>');
  const tag = container['tag'];
  if (typeof tag !== 'string') {
    throw new WireDecodingError('<frame>.tag', 'expected a string discriminator');
  }
  if (!known.has(tag)) {
    throw new UnrecognizedTagError(tag);
  }
  return { tag, container };
}
