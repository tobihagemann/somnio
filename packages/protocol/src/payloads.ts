import { truncateToUTF8Bytes } from './constants.ts';
import { WireDecodingError } from './errors.ts';
import type { SectorView } from './sectorView.ts';
import { decodeSectorView } from './sectorView.ts';
import {
  PROTOCOL_BYTE_CAPS,
  isAbsent,
  mapArray,
  requireBool,
  requireBoundedString,
  requireEntityId,
  requireFloat,
  requireId,
  requireInt32,
  requireMetres,
  requireNested,
  requirePositiveMetres,
  requireString,
  requireStringEnum,
  requireWithinByteCap,
} from './validate.ts';

/**
 * The message payloads of the protocol package. One interface per payload, property
 * names verbatim, plus a runtime decoder per payload so an inbound frame is rejected at the
 * boundary rather than deep in a handler.
 */

/**
 * The string literal sets of the wire. Each array is the single declaration; the union is derived
 * from it and the decoders validate against it.
 */
export const ENTITY_KINDS = ['player', 'npc', 'monster'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const GAITS = ['walk', 'jog', 'run'] as const;
export type Gait = (typeof GAITS)[number];

export const HANDS = ['left', 'right'] as const;
export type Hand = (typeof HANDS)[number];

export const LOGIN_RESULTS = ['ok', 'badCredentials', 'alreadyLoggedIn', 'throttled'] as const;
export type LoginResult = (typeof LOGIN_RESULTS)[number];

export const REGISTER_RESULTS = ['ok', 'nicknameExists', 'failure', 'nameNotAllowed', 'throttled'] as const;
export type RegisterResult = (typeof REGISTER_RESULTS)[number];

export const ROLES = ['kaempfer', 'heiler'] as const;
export type Role = (typeof ROLES)[number];

/** What asking an NPC offers beyond its dialog. */
export const NPC_SERVICES = ['kaempferMaster', 'heilerMaster'] as const;
export type NPCService = (typeof NPC_SERVICES)[number];

/** How an entity's health stands, by quarters of its maximum. It is all another player learns of it. */
export const CONDITIONS = ['hale', 'wounded', 'hurt', 'failing', 'fallen'] as const;
export type Condition = (typeof CONDITIONS)[number];

export const RAISING_STATES = ['begun', 'broken', 'done'] as const;
export type RaisingState = (typeof RAISING_STATES)[number];

export interface LoginMessage {
  nickname: string;
  password: string;
  /** Request a resumable session token alongside a successful login. Omitting it must yield no `sessionToken` frame at all. */
  requestSessionToken?: boolean;
}

export interface RegisterMessage {
  nickname: string;
  password: string;
  passwordRepeat: string;
  people: string;
  email: string;
}

export interface MoveMessage {
  x: number;
  z: number;
  /** Continuous heading in degrees `[0, 360)` (0 = south, 90 = east). */
  facing: number;
  gait: Gait;
}

export interface ClientSayMessage {
  text: string;
}

export interface EquipToggleMessage {
  slot: number;
  /** Absent unequips the slot. */
  hand?: Hand;
}

/** Asks an NPC to go on past its greeting. The client opens what a master offers with it. */
export interface TalkMessage {
  npcId: string;
}

/** One swing, at the nightmare the client picked in front of the dreamer, or at the air without one. */
export interface SwingMessage {
  targetId?: string;
}

/** The dreamer a Heiler tends from now on; absent tends no one. */
export interface TendMessage {
  targetId?: string;
}

/** A door id is unique only within its sector, and a space can hold several sectors. */
export interface UseDoorMessage {
  sector: string;
  doorId: string;
}

/** Asks a master for a task: their trial without a `teachingId`, the task that gates that teaching with one. */
export interface AskTaskMessage {
  npcId: string;
  teachingId?: string;
}

export interface CompleteTaskMessage {
  npcId: string;
}

export interface StudyMessage {
  npcId: string;
  teachingId: string;
}

export interface UseItemMessage {
  slot: number;
}

/** The payload of a verb that says everything by its tag. */
export type EmptyMessage = Record<string, never>;

/** Redeem a stored session token in place of a password login. Accepted pre-login only. */
export interface RedeemSessionMessage {
  token: string;
}

/** Revoke the token presented on this connection. Accepted post-attach only. */
export interface RevokeSessionMessage {
  token: string;
}

export interface HelloMessage {
  protocolVersion: number;
}

export interface LoginResultMessage {
  result: LoginResult;
}

export interface RegisterResultMessage {
  result: RegisterResult;
}

/**
 * The first frame of every join. `worldSeconds` is the world clock at that moment; the client
 * extrapolates from it, so no later frame carries the time.
 */
export interface EnterSpaceMessage {
  spaceId: string;
  selfId: string;
  worldSeconds: number;
}

export interface SectorMessage {
  sector: SectorView;
}

export interface EntityMessage {
  id: string;
  kind: EntityKind;
  characterModelId: string;
  name: string;
  /** The body radius the server uses for this entity, in metres. */
  radius: number;
  x: number;
  z: number;
  facing: number;
  gait: Gait;
  condition: Condition;
  /** Present on an NPC that offers one. */
  service?: NPCService;
}

export interface EntityMove {
  id: string;
  x: number;
  z: number;
  facing: number;
  gait: Gait;
}

export interface MovesMessage {
  moves: EntityMove[];
}

/** The last position the server accepted, sent in answer to a rejected `move`. */
export interface CorrectionMessage {
  x: number;
  z: number;
}

export interface DoorRefusedMessage {
  sector: string;
  doorId: string;
}

export interface SayMessage {
  entityId: string;
  text: string;
}

export interface Energy {
  healthCurrent: number;
  healthMax: number;
  balanceCurrent: number;
  balanceMax: number;
  spiritCurrent: number;
  spiritMax: number;
}

export interface InventoryRowMessage {
  slot: number;
  itemId: string;
  quantity: number;
  /** Absent when the row is not equipped. */
  equippedHand?: Hand;
}

export interface InventoryMessage {
  rows: InventoryRowMessage[];
}

export interface LeaveMessage {
  entityId: string;
  leftGame: boolean;
}

export interface TeachingRankMessage {
  teachingId: string;
  rank: number;
  /** What the dreamer has done toward the next rank. */
  practice: number;
}

export interface TaskMessage {
  role: Role;
  /** Absent for the role's trial. */
  teachingId?: string;
  progress: number;
}

/** What a dreamer has grown into, sent to that dreamer alone. */
export interface LucidityMessage {
  role?: Role;
  ranks: TeachingRankMessage[];
  /** The teaching whose next rank practice builds toward. */
  study?: string;
  task?: TaskMessage;
}

export interface ConditionMessage {
  entityId: string;
  condition: Condition;
}

/** One swing or strike, landed or not. */
export interface BlowMessage {
  attackerId: string;
  /** Absent for a swing at the air. */
  targetId?: string;
  hit: boolean;
}

export interface RaisingMessage {
  healerId: string;
  targetId: string;
  state: RaisingState;
  /** How long the raise takes, with `begun`; 0 otherwise. */
  seconds: number;
}

export interface AdminSayMessage {
  text: string;
}

/**
 * Issued once, in response to a `Login` that asked for it. A successful `redeemSession` resolves the
 * presented token and deliberately mints no replacement, so no frame of this kind follows a resume —
 * rotating there would invalidate the credential the bounded `alreadyLoggedIn` retry still needs.
 * The raw token is returned exactly once — the server stores only a digest.
 */
export interface SessionTokenMessage {
  token: string;
  /** Seconds until expiry, so the client never has to trust its own clock offset. */
  expiresInSeconds: number;
}

/** Acknowledgement that the presented token's row is gone. */
export interface SessionRevokedMessage {
  revoked: boolean;
}

export function decodeLoginMessage(container: Record<string, unknown>, path: string): LoginMessage {
  return {
    nickname: requireString(container, 'nickname', path),
    password: requireString(container, 'password', path),
    ...(isAbsent(container, 'requestSessionToken') ? {} : { requestSessionToken: requireBool(container, 'requestSessionToken', path) }),
  };
}

/** `people` decodes as a plain string: the list of peoples is the server's to check. */
export function decodeRegisterMessage(container: Record<string, unknown>, path: string): RegisterMessage {
  return {
    nickname: requireString(container, 'nickname', path),
    password: requireString(container, 'password', path),
    passwordRepeat: requireString(container, 'passwordRepeat', path),
    people: requireString(container, 'people', path),
    email: requireString(container, 'email', path),
  };
}

export function decodeMoveMessage(container: Record<string, unknown>, path: string): MoveMessage {
  return {
    x: requireMetres(container, 'x', path),
    z: requireMetres(container, 'z', path),
    facing: requireFloat(container, 'facing', path),
    gait: requireStringEnum(container, 'gait', path, GAITS),
  };
}

/**
 * The client's chat line decodes uncapped: the server answers an over-cap `clientSay` by dropping
 * it and keeping the socket open, which it can only do if the frame reaches its handler.
 */
export function decodeClientSayMessage(container: Record<string, unknown>, path: string): ClientSayMessage {
  return { text: requireString(container, 'text', path) };
}

export function decodeEquipToggleMessage(container: Record<string, unknown>, path: string): EquipToggleMessage {
  return {
    slot: requireInt32(container, 'slot', path),
    ...(isAbsent(container, 'hand') ? {} : { hand: requireStringEnum(container, 'hand', path, HANDS) }),
  };
}

export function decodeTalkMessage(container: Record<string, unknown>, path: string): TalkMessage {
  return { npcId: requireEntityId(container, 'npcId', path) };
}

function decodeOptionalTarget(container: Record<string, unknown>, path: string): { targetId?: string } {
  return isAbsent(container, 'targetId') ? {} : { targetId: requireEntityId(container, 'targetId', path) };
}

export function decodeSwingMessage(container: Record<string, unknown>, path: string): SwingMessage {
  return decodeOptionalTarget(container, path);
}

export function decodeTendMessage(container: Record<string, unknown>, path: string): TendMessage {
  return decodeOptionalTarget(container, path);
}

export function decodeUseDoorMessage(container: Record<string, unknown>, path: string): UseDoorMessage {
  return {
    sector: requireBoundedString(container, 'sector', path, PROTOCOL_BYTE_CAPS.sectorName),
    doorId: requireId(container, 'doorId', path),
  };
}

export function decodeAskTaskMessage(container: Record<string, unknown>, path: string): AskTaskMessage {
  return {
    npcId: requireEntityId(container, 'npcId', path),
    ...(isAbsent(container, 'teachingId') ? {} : { teachingId: requireId(container, 'teachingId', path) }),
  };
}

export function decodeCompleteTaskMessage(container: Record<string, unknown>, path: string): CompleteTaskMessage {
  return { npcId: requireEntityId(container, 'npcId', path) };
}

export function decodeStudyMessage(container: Record<string, unknown>, path: string): StudyMessage {
  return {
    npcId: requireEntityId(container, 'npcId', path),
    teachingId: requireId(container, 'teachingId', path),
  };
}

export function decodeUseItemMessage(container: Record<string, unknown>, path: string): UseItemMessage {
  return { slot: requireInt32(container, 'slot', path) };
}

export function decodeEmptyMessage(): EmptyMessage {
  return {};
}

/**
 * Uncapped on decode, like `decodeClientSayMessage`: the server's session handler answers an over-cap
 * token with `loginResult(badCredentials)` and keeps the socket open, so the cap is its concern.
 */
export function decodeRedeemSessionMessage(container: Record<string, unknown>, path: string): RedeemSessionMessage {
  return { token: requireString(container, 'token', path) };
}

/** Uncapped like its redeem twin; the server answers an over-cap token with `sessionRevoked(false)`. */
export function decodeRevokeSessionMessage(container: Record<string, unknown>, path: string): RevokeSessionMessage {
  return { token: requireString(container, 'token', path) };
}

export function decodeHelloMessage(container: Record<string, unknown>, path: string): HelloMessage {
  return { protocolVersion: requireInt32(container, 'protocolVersion', path) };
}

export function decodeLoginResultMessage(container: Record<string, unknown>, path: string): LoginResultMessage {
  return { result: requireStringEnum(container, 'result', path, LOGIN_RESULTS) };
}

export function decodeRegisterResultMessage(container: Record<string, unknown>, path: string): RegisterResultMessage {
  return { result: requireStringEnum(container, 'result', path, REGISTER_RESULTS) };
}

export function decodeEnterSpaceMessage(container: Record<string, unknown>, path: string): EnterSpaceMessage {
  const worldSeconds = requireFloat(container, 'worldSeconds', path);
  if (worldSeconds < 0) {
    throw new WireDecodingError(`${path}.worldSeconds`, `expected a non-negative number, got ${worldSeconds}`);
  }
  return {
    spaceId: requireBoundedString(container, 'spaceId', path, PROTOCOL_BYTE_CAPS.sectorName),
    selfId: requireEntityId(container, 'selfId', path),
    worldSeconds,
  };
}

export function decodeSectorMessage(container: Record<string, unknown>, path: string): SectorMessage {
  return { sector: decodeSectorView(requireNested(container, 'sector', path), `${path}.sector`) };
}

/**
 * The entity name is bounded on decode for the same reason chat text is: nothing caps what the
 * server *sends*, and a name is retained three times over — in the entity map, in the roster (which
 * re-runs a collating sort on every arrival), and in the `left` chat line when the peer departs.
 *
 * **Truncated, not rejected.** This field carries operator-authored NPC and monster names as well as
 * player nicknames, and only the nicknames are bounded: `maxIdentifierUTF8Bytes` is enforced by the
 * login and registration handlers, while the sector format bounds NPC and monster names nowhere.
 * Rejecting would therefore refuse a whole sector on nothing worse than a long authored label.
 * Truncating keeps the retention bound, and the plaque renderer clamps to the same constant at
 * raster time, so nothing visible is lost.
 */
export function decodeEntityMessage(container: Record<string, unknown>, path: string): EntityMessage {
  return {
    id: requireEntityId(container, 'id', path),
    kind: requireStringEnum(container, 'kind', path, ENTITY_KINDS),
    characterModelId: requireString(container, 'characterModelId', path),
    name: truncateToUTF8Bytes(requireString(container, 'name', path), PROTOCOL_BYTE_CAPS.identifier),
    radius: requirePositiveMetres(container, 'radius', path),
    x: requireMetres(container, 'x', path),
    z: requireMetres(container, 'z', path),
    facing: requireFloat(container, 'facing', path),
    gait: requireStringEnum(container, 'gait', path, GAITS),
    condition: requireStringEnum(container, 'condition', path, CONDITIONS),
    ...(isAbsent(container, 'service') ? {} : { service: requireStringEnum(container, 'service', path, NPC_SERVICES) }),
  };
}

function decodeEntityMove(container: Record<string, unknown>, path: string): EntityMove {
  return {
    id: requireEntityId(container, 'id', path),
    x: requireMetres(container, 'x', path),
    z: requireMetres(container, 'z', path),
    facing: requireFloat(container, 'facing', path),
    gait: requireStringEnum(container, 'gait', path, GAITS),
  };
}

export function decodeMovesMessage(container: Record<string, unknown>, path: string): MovesMessage {
  return { moves: mapArray(container, 'moves', path, decodeEntityMove) };
}

export function decodeCorrectionMessage(container: Record<string, unknown>, path: string): CorrectionMessage {
  return {
    x: requireMetres(container, 'x', path),
    z: requireMetres(container, 'z', path),
  };
}

export function decodeDoorRefusedMessage(container: Record<string, unknown>, path: string): DoorRefusedMessage {
  return {
    sector: requireBoundedString(container, 'sector', path, PROTOCOL_BYTE_CAPS.sectorName),
    doorId: requireId(container, 'doorId', path),
  };
}

/**
 * The server's chat line is capped on decode, not only on send; `requireWithinByteCap` records why
 * an uncapped inbound line freezes the tab. The same reasoning hardens the name plaque.
 */
export function decodeSayMessage(container: Record<string, unknown>, path: string): SayMessage {
  return {
    entityId: requireEntityId(container, 'entityId', path),
    text: requireWithinByteCap(requireString(container, 'text', path), PROTOCOL_BYTE_CAPS.say, `${path}.text`),
  };
}

export function decodeEnergy(container: Record<string, unknown>, path: string): Energy {
  return {
    healthCurrent: requireInt32(container, 'healthCurrent', path),
    healthMax: requireInt32(container, 'healthMax', path),
    balanceCurrent: requireInt32(container, 'balanceCurrent', path),
    balanceMax: requireInt32(container, 'balanceMax', path),
    spiritCurrent: requireInt32(container, 'spiritCurrent', path),
    spiritMax: requireInt32(container, 'spiritMax', path),
  };
}

function decodeInventoryRowMessage(container: Record<string, unknown>, path: string): InventoryRowMessage {
  const quantity = requireInt32(container, 'quantity', path);
  if (quantity < 0) {
    throw new WireDecodingError(`${path}.quantity`, `expected a non-negative quantity, got ${quantity}`);
  }
  return {
    slot: requireInt32(container, 'slot', path),
    itemId: requireBoundedString(container, 'itemId', path, PROTOCOL_BYTE_CAPS.identifier),
    quantity,
    ...(isAbsent(container, 'equippedHand') ? {} : { equippedHand: requireStringEnum(container, 'equippedHand', path, HANDS) }),
  };
}

export function decodeInventoryMessage(container: Record<string, unknown>, path: string): InventoryMessage {
  return { rows: mapArray(container, 'rows', path, decodeInventoryRowMessage) };
}

export function decodeLeaveMessage(container: Record<string, unknown>, path: string): LeaveMessage {
  return {
    entityId: requireEntityId(container, 'entityId', path),
    leftGame: requireBool(container, 'leftGame', path),
  };
}

function requireNonNegative(value: number, path: string): number {
  if (value < 0) {
    throw new WireDecodingError(path, `expected a non-negative number, got ${value}`);
  }
  return value;
}

function decodeTeachingRankMessage(container: Record<string, unknown>, path: string): TeachingRankMessage {
  return {
    teachingId: requireId(container, 'teachingId', path),
    rank: requireNonNegative(requireInt32(container, 'rank', path), `${path}.rank`),
    practice: requireNonNegative(requireFloat(container, 'practice', path), `${path}.practice`),
  };
}

function decodeTaskMessage(container: Record<string, unknown>, path: string): TaskMessage {
  return {
    role: requireStringEnum(container, 'role', path, ROLES),
    ...(isAbsent(container, 'teachingId') ? {} : { teachingId: requireId(container, 'teachingId', path) }),
    progress: requireNonNegative(requireFloat(container, 'progress', path), `${path}.progress`),
  };
}

export function decodeLucidityMessage(container: Record<string, unknown>, path: string): LucidityMessage {
  return {
    ...(isAbsent(container, 'role') ? {} : { role: requireStringEnum(container, 'role', path, ROLES) }),
    ranks: mapArray(container, 'ranks', path, decodeTeachingRankMessage),
    ...(isAbsent(container, 'study') ? {} : { study: requireId(container, 'study', path) }),
    ...(isAbsent(container, 'task') ? {} : { task: decodeTaskMessage(requireNested(container, 'task', path), `${path}.task`) }),
  };
}

export function decodeConditionMessage(container: Record<string, unknown>, path: string): ConditionMessage {
  return {
    entityId: requireEntityId(container, 'entityId', path),
    condition: requireStringEnum(container, 'condition', path, CONDITIONS),
  };
}

export function decodeBlowMessage(container: Record<string, unknown>, path: string): BlowMessage {
  return {
    attackerId: requireEntityId(container, 'attackerId', path),
    ...decodeOptionalTarget(container, path),
    hit: requireBool(container, 'hit', path),
  };
}

export function decodeRaisingMessage(container: Record<string, unknown>, path: string): RaisingMessage {
  return {
    healerId: requireEntityId(container, 'healerId', path),
    targetId: requireEntityId(container, 'targetId', path),
    state: requireStringEnum(container, 'state', path, RAISING_STATES),
    seconds: requireNonNegative(requireFloat(container, 'seconds', path), `${path}.seconds`),
  };
}

export function decodeAdminSayMessage(container: Record<string, unknown>, path: string): AdminSayMessage {
  return {
    text: requireWithinByteCap(requireString(container, 'text', path), PROTOCOL_BYTE_CAPS.say, `${path}.text`),
  };
}

export function decodeSessionTokenMessage(container: Record<string, unknown>, path: string): SessionTokenMessage {
  return {
    // Capped on the way in like `say` and `adminSay`, for the same reason those are: the server
    // bounds what it *accepts*, nothing bounds what it sends. An oversized token would otherwise be
    // written to `localStorage` and cost a full connect-and-redeem round trip on every later load
    // before the server's own cap rejected it.
    token: requireWithinByteCap(requireString(container, 'token', path), PROTOCOL_BYTE_CAPS.sessionToken, `${path}.token`),
    expiresInSeconds: requireInt32(container, 'expiresInSeconds', path),
  };
}

export function decodeSessionRevokedMessage(container: Record<string, unknown>, path: string): SessionRevokedMessage {
  return { revoked: requireBool(container, 'revoked', path) };
}
