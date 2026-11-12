import { SOMNIO_PROTOCOL_CONSTANTS, truncateToUTF8Bytes } from './constants.ts';
import { WireDecodingError } from './errors.ts';
import type { SectorView } from './sectorView.ts';
import { decodeSectorView } from './sectorView.ts';
import {
  PROTOCOL_BYTE_CAPS,
  isAbsent,
  mapArray,
  requireArray,
  requireBool,
  requireBoundedString,
  requireEntityId,
  requireEntityIds,
  requireFloat,
  requireFloatValue,
  requireId,
  requireIds,
  requireInt32,
  requireMetres,
  requireNested,
  requirePositiveMetres,
  requireString,
  requireStringEnum,
  requireUnitInterval,
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

/** Where a dreamer wears an item, a ring on either hand. Only the two hands show on their body. */
export const EQUIP_SLOTS = ['mainHand', 'offHand', 'head', 'chest', 'hands', 'legs', 'feet', 'neck', 'ring1', 'ring2'] as const;
export type EquipSlot = (typeof EQUIP_SLOTS)[number];

/** The slots that show on a dreamer's body, each in a hand. */
export const HANDS = ['mainHand', 'offHand'] as const satisfies readonly EquipSlot[];
export type Hand = (typeof HANDS)[number];

/** How many stat lines an item rolls beyond its base: plain none, magic one or two, rare three or four. */
export const RARITIES = ['plain', 'magic', 'rare'] as const;
export type Rarity = (typeof RARITIES)[number];

export const LOGIN_RESULTS = ['ok', 'badCredentials', 'alreadyLoggedIn', 'throttled'] as const;
export type LoginResult = (typeof LOGIN_RESULTS)[number];

export const REGISTER_RESULTS = ['ok', 'emailExists', 'failure', 'throttled'] as const;
export type RegisterResult = (typeof REGISTER_RESULTS)[number];

export const CHARACTER_RESULTS = ['ok', 'nameExists', 'nameNotAllowed', 'full', 'failure'] as const;
export type CharacterResult = (typeof CHARACTER_RESULTS)[number];

export const ROLES = ['fighter', 'healer', 'mystic'] as const;
export type Role = (typeof ROLES)[number];

/** What asking an NPC offers beyond its dialog. */
export const NPC_SERVICES = ['fighterMaster', 'healerMaster', 'mysticMaster', 'shopkeeper'] as const;
export type NPCService = (typeof NPC_SERVICES)[number];

/** How an entity's health stands: hale at its maximum, by quarters of it below, and fallen at none. It is all another player learns of it, unless it is their target. */
export const CONDITIONS = ['hale', 'grazed', 'wounded', 'hurt', 'failing', 'fallen'] as const;
export type Condition = (typeof CONDITIONS)[number];

export const RAISING_STATES = ['holding', 'broken', 'done'] as const;
export type RaisingState = (typeof RAISING_STATES)[number];

/** Where a channelled ability stands: begun, under way as told to a dreamer who targets its user, landed, or broken off. */
export const ABILITY_PHASES = ['start', 'channel', 'done', 'broken'] as const;
export type AbilityPhase = (typeof ABILITY_PHASES)[number];

/** What a trade did, from the dreamer's side. */
export const TRADE_KINDS = ['bought', 'sold'] as const;
export type TradeKind = (typeof TRADE_KINDS)[number];

/**
 * What sets a nightmare above its kind's ordinary run: an elite carries a trait of its own, more
 * health, and better drops, and a boss is a kind of its own with moves of its own and the best drops.
 */
export const NIGHTMARE_RANKS = ['elite', 'boss'] as const;
export type NightmareRank = (typeof NIGHTMARE_RANKS)[number];

/** What a nightmare telegraphs as a circle on the ground before it strikes there. */
export const TELEGRAPH_KINDS = ['wail'] as const;
export type TelegraphKind = (typeof TELEGRAPH_KINDS)[number];

/** What a drop lying on the ground is. */
export const LOOT_KINDS = ['item'] as const;
export type LootKind = (typeof LOOT_KINDS)[number];

/** How loudly a line is spoken, which sets how far it carries. */
export const SPEECH_KINDS = ['whisper', 'say', 'yell'] as const;
export type SpeechKind = (typeof SPEECH_KINDS)[number];

/** The languages a reader can read the world in. */
export const LOCALES = ['en', 'de'] as const;
export type Locale = (typeof LOCALES)[number];

export interface LoginMessage {
  email: string;
  password: string;
  /** Request a resumable session token alongside a successful login. Omitting it must yield no `sessionToken` frame at all. */
  requestSessionToken?: boolean;
  /** The language NPCs speak to this connection in; English when absent. */
  locale?: Locale;
}

export interface RegisterMessage {
  email: string;
  password: string;
  passwordRepeat: string;
}

export interface CreateCharacterMessage {
  name: string;
  people: string;
}

/** Joins the world as one of the account's characters. */
export interface SelectCharacterMessage {
  characterId: string;
}

export interface DeleteCharacterMessage {
  characterId: string;
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
  kind: SpeechKind;
}

/**
 * Wears an item in a slot its base fits: `slot` when given, else the free one of a ring's two, else
 * its first. From the bag, whatever the slot wore takes the item's place there. A ring worn in the
 * other ring slot changes slots with what that one wears.
 */
export interface EquipMessage {
  itemId: string;
  slot?: EquipSlot;
}

/** Puts what the slot wears into the bag, at its first free place. */
export interface UnequipMessage {
  slot: EquipSlot;
}

/**
 * Moves an item to a place in the bag. From another place, onto an occupied one, the two change
 * places. A worn item is put away there, or changes places with the item there when that one fits
 * its slot, or else goes to the first free place.
 */
export interface MoveItemMessage {
  itemId: string;
  place: number;
}

/** Throws an item the dreamer carries or wears to the ground a short way along `heading`, for anyone in reach to pick up. A worn one leaves its slot. */
export interface DropItemMessage {
  itemId: string;
  /** Continuous heading in degrees (0 = south, 90 = east): toward where a drag let the item go, else toward the cursor, else on a finger the way the dreamer faces. */
  heading: number;
}

/** Picks up a drop lying on the ground for the dreamer, into their bag. */
export interface PickUpMessage {
  lootId: string;
}

/** Asks an NPC to go on past its greeting. The client opens what a master offers with it. */
export interface TalkMessage {
  npcId: string;
}

/** The entity the dreamer acts on from now on; absent clears it. */
export interface TargetMessage {
  targetId?: string;
}

/**
 * The dreamer's action on their target on or off: Attack at a nightmare, Mend at a dreamer for a
 * Healer with the Moonstone in hand, which raises a fallen one.
 */
export interface EngageMessage {
  on: boolean;
}

/** Uses an ability on the belt. It names no target: the server lands it by the dreamer's one target. */
export interface UseAbilityMessage {
  abilityId: string;
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

/** Asks the shopkeeper to sell a plain one of a ware, into a bag with room. */
export interface BuyMessage {
  npcId: string;
  baseId: string;
}

/** Asks the shopkeeper to buy back an item from the dreamer's bag. */
export interface SellMessage {
  npcId: string;
  itemId: string;
}

/** The payload of a verb that says everything by its tag. */
export type EmptyMessage = Record<string, never>;

/** Redeem a stored session token in place of a password login. Accepted pre-login only. */
export interface RedeemSessionMessage {
  token: string;
  /** As on `login`. */
  locale?: Locale;
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

export interface CharacterSummaryMessage {
  id: string;
  name: string;
  people: string;
  role?: Role;
}

/** The account's characters, the one played last first. */
export interface CharactersMessage {
  characters: CharacterSummaryMessage[];
}

export interface CharacterResultMessage {
  result: CharacterResult;
}

/**
 * The first frame of every join. `worldSeconds` is the world clock at that moment; the client
 * extrapolates from it, so no later frame carries the time. `people` is the joining character's.
 */
export interface EnterSpaceMessage {
  spaceId: string;
  selfId: string;
  people: string;
  worldSeconds: number;
}

/**
 * A sector and, for a room, the ids of its doors that open to the outdoors, the first of which that
 * resolves lets the hour's light in. Left out where there are none. The server derives them from
 * the world, so they are no part of the sector view or its file.
 */
export interface SectorMessage {
  sector: SectorView;
  outdoorDoorIds?: string[];
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
  /** Present on a dreamer. */
  held?: Held;
  /** Present on a nightmare above its kind's ordinary run. */
  rank?: NightmareRank;
  /** The trait an elite carries, by id. */
  trait?: string;
  /** The boss that has just called the nightmare up, on the frame that shows it arriving and no other. */
  summonedBy?: string;
}

/** The bases of what a dreamer's hands hold, which is all anyone else is shown of their gear. */
export interface Held {
  mainHand?: string;
  offHand?: string;
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

/** A line as one listener hears it: the server crumbles the text for each listener by distance. */
export interface SayMessage {
  /** The speaker. Through a door it names a body the listener does not have yet, which a bubble follows once it arrives. */
  entityId: string;
  name: string;
  kind: SpeechKind;
  text: string;
  /** 1 for clear speech, falling toward 0 across the band where it crumbles. */
  clarity: number;
  /** Where the voice comes from, in the listener's space. */
  x: number;
  z: number;
}

export interface Energy {
  healthCurrent: number;
  healthMax: number;
  balanceCurrent: number;
  balanceMax: number;
  spiritCurrent: number;
  spiritMax: number;
}

export interface AffixMessage {
  affixId: string;
  value: number;
}

/** One item a dreamer has, named by its own id while they keep it. */
export interface ItemMessage {
  id: string;
  baseId: string;
  tier: number;
  rarity: Rarity;
  affixes: AffixMessage[];
}

/**
 * What a drop is, as its owner sees it before picking it up: an item of a base at a rarity. The
 * server keeps the item's tier and stat lines until it is picked up.
 */
export interface LootContentsMessage {
  kind: 'item';
  baseId: string;
  rarity: Rarity;
}

export interface EquippedItemMessage {
  slot: EquipSlot;
  item: ItemMessage;
}

/** An item in the bag at the place the dreamer keeps it in. */
export interface BaggedItemMessage {
  place: number;
  item: ItemMessage;
}

/** A trade that produced the frame carrying it: what changed hands, and the coins paid or received. */
export interface TradeMessage {
  kind: TradeKind;
  baseId: string;
  rarity: Rarity;
  coins: number;
}

/** Everything a dreamer carries, whole in every frame: their coins, what they wear, one slot at most once, and their bag, one item to a place. */
export interface InventoryMessage {
  coins: number;
  equipped: EquippedItemMessage[];
  bag: BaggedItemMessage[];
  /** Present only on the frame a trade produced. */
  trade?: TradeMessage;
  /** Present only on the frame a drop to the ground produced: what was dropped. */
  dropped?: LootContentsMessage;
  /** Present only on the frame a pick-up produced: what was picked up. */
  pickedUp?: LootContentsMessage;
}

/**
 * Where a drop was thrown from as it fell: by a dreamer, named, or from where a nightmare stood.
 * `hand` names the hand the thrown item left, when a dreamer threw it from one.
 */
export interface ThrownFromMessage {
  x: number;
  z: number;
  entityId?: string;
  hand?: Hand;
}

/**
 * A drop lying on the ground at a point of the space: for the dreamer it is sent to alone, or, with
 * `shared` set, an item a dreamer dropped, which everyone who sees its sector is sent. `from` is on
 * the frame of its fall alone, never on one that shows it lying.
 */
export interface LootMessage {
  lootId: string;
  x: number;
  z: number;
  contents: LootContentsMessage;
  shared?: boolean;
  from?: ThrownFromMessage;
}

/** A drop is gone from the dreamer's view: picked up, expired, taken away by a newer drop past the cap, or its sector out of view. */
export interface LootGoneMessage {
  lootId: string;
}

/** `crumbled` is set on a minion that crumbles where it stands as its boss's fight ends, rather than falling. */
export interface LeaveMessage {
  entityId: string;
  leftGame: boolean;
  crumbled?: boolean;
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

/** What a dreamer's hands hold, sent when it changes. */
export interface HeldMessage {
  entityId: string;
  held: Held;
}

/** The health of the dreamer's target, as a share of its maximum. Sent to that dreamer alone. */
export interface VitalsMessage {
  entityId: string;
  health: number;
}

/** An effect its holder holds, with the seconds it has left; without them it lasts as long as its holder. */
export interface HeldEffectMessage {
  effectId: string;
  seconds?: number;
}

/** Every effect an entity holds, whole in every frame. Sent to the entity and to each dreamer whose target it is. */
export interface EffectsMessage {
  entityId: string;
  effects: HeldEffectMessage[];
}

/** One swing or strike, landed or not. */
export interface BlowMessage {
  attackerId: string;
  targetId: string;
  hit: boolean;
}

/**
 * An entity used an ability. `targetId` is whom it landed on, absent when that is the user or the
 * ability lands round them. A channelled ability carries its `phase`, and an instant one none.
 * `seconds` is the channel's length on `start` and the seconds left on `channel`, and is carried
 * with no other phase. `evaded` is set when the nightmare it flies at evades it, landing nothing.
 */
export interface AbilityMessage {
  entityId: string;
  abilityId: string;
  targetId?: string;
  phase?: AbilityPhase;
  seconds?: number;
  evaded?: boolean;
}

export interface AbilityCooldownMessage {
  abilityId: string;
  seconds: number;
}

/**
 * The seconds left on each of the dreamer's running cooldowns, the global one beside each
 * ability's own, whole in every frame. An ability left out is ready. Sent to that dreamer alone.
 */
export interface CooldownsMessage {
  globalSeconds: number;
  cooldowns: AbilityCooldownMessage[];
}

/**
 * A raise on a fallen dreamer as it stands, whole in every frame. While `holding`, `healerIds` are
 * the Healers holding on in the order they took hold, `progress` is the share done, and `seconds`
 * the time left at their pace. Each adds their pace once a channel of theirs ends, and
 * `pausedSeconds` gives the seconds before each does, in the order of `healerIds`, left out while
 * every one adds it now. `done` and `broken` name the Healers holding on just before the end,
 * with `seconds` 0 and `progress` 1 when done, 0 when broken.
 */
export interface RaisingMessage {
  targetId: string;
  healerIds: string[];
  state: RaisingState;
  progress: number;
  seconds: number;
  pausedSeconds?: number[];
}

/**
 * A Healer's touch mended a dreamer. It carries no amount, because another player learns a dreamer's
 * health only as its condition, or as `vitals` while targeting them.
 */
export interface MendMessage {
  targetId: string;
}

/**
 * A circle on the ground that `casterId` strikes once `seconds` have run, hitting every dreamer
 * inside it whom nightmares do not leave alone. It goes to everyone who sees the caster's sector as
 * it begins, and with the seconds left to a dreamer who comes into view of it under way. Its end
 * sends nothing: it strikes, or it ends with its caster, driven off or out of view.
 */
export interface TelegraphMessage {
  id: string;
  casterId: string;
  kind: TelegraphKind;
  x: number;
  z: number;
  radius: number;
  seconds: number;
}

/** Where a fallen dreamer lies, in the coordinates of the space. */
export interface SensedBearingMessage {
  name: string;
  x: number;
  z: number;
}

/**
 * The fallen dreamers in the space other than the Mystic, nearest first and at most
 * `maxSensedBearings`, whole in every frame and empty when none lies fallen. Sent only to a Mystic
 * who senses the fallen.
 */
export interface SensedMessage {
  bearings: SensedBearingMessage[];
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

/** Sent once per login or resume: how many other browsers could still resume this account. */
export interface OtherSessionsMessage {
  count: number;
}

/** Answers `revokeOtherSessions`: whether the delete ran, and how many of the account's other sessions it ended. */
export interface OtherSessionsRevokedMessage {
  revoked: boolean;
  count: number;
}

export function decodeLoginMessage(container: Record<string, unknown>, path: string): LoginMessage {
  return {
    email: requireString(container, 'email', path),
    password: requireString(container, 'password', path),
    ...(isAbsent(container, 'requestSessionToken') ? {} : { requestSessionToken: requireBool(container, 'requestSessionToken', path) }),
    ...decodeOptionalLocale(container, path),
  };
}

function decodeOptionalLocale(container: Record<string, unknown>, path: string): { locale?: Locale } {
  return isAbsent(container, 'locale') ? {} : { locale: requireStringEnum(container, 'locale', path, LOCALES) };
}

export function decodeRegisterMessage(container: Record<string, unknown>, path: string): RegisterMessage {
  return {
    email: requireString(container, 'email', path),
    password: requireString(container, 'password', path),
    passwordRepeat: requireString(container, 'passwordRepeat', path),
  };
}

/** Both decode as plain strings: the name's cap and policy and the list of peoples are the server's to check. */
export function decodeCreateCharacterMessage(container: Record<string, unknown>, path: string): CreateCharacterMessage {
  return {
    name: requireString(container, 'name', path),
    people: requireString(container, 'people', path),
  };
}

export function decodeSelectCharacterMessage(container: Record<string, unknown>, path: string): SelectCharacterMessage {
  return { characterId: requireEntityId(container, 'characterId', path) };
}

export function decodeDeleteCharacterMessage(container: Record<string, unknown>, path: string): DeleteCharacterMessage {
  return { characterId: requireEntityId(container, 'characterId', path) };
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
  return { text: requireString(container, 'text', path), kind: requireStringEnum(container, 'kind', path, SPEECH_KINDS) };
}

export function decodeEquipMessage(container: Record<string, unknown>, path: string): EquipMessage {
  return {
    itemId: requireId(container, 'itemId', path),
    ...(isAbsent(container, 'slot') ? {} : { slot: requireStringEnum(container, 'slot', path, EQUIP_SLOTS) }),
  };
}

export function decodeUnequipMessage(container: Record<string, unknown>, path: string): UnequipMessage {
  return { slot: requireStringEnum(container, 'slot', path, EQUIP_SLOTS) };
}

export function decodeMoveItemMessage(container: Record<string, unknown>, path: string): MoveItemMessage {
  return { itemId: requireId(container, 'itemId', path), place: requireBagPlace(container, 'place', path) };
}

export function decodeDropItemMessage(container: Record<string, unknown>, path: string): DropItemMessage {
  return { itemId: requireId(container, 'itemId', path), heading: requireFloat(container, 'heading', path) };
}

/** Loot ids decode as ids: the server names its drops. */
export function decodePickUpMessage(container: Record<string, unknown>, path: string): PickUpMessage {
  return { lootId: requireId(container, 'lootId', path) };
}

export function decodeTalkMessage(container: Record<string, unknown>, path: string): TalkMessage {
  return { npcId: requireEntityId(container, 'npcId', path) };
}

export function decodeTargetMessage(container: Record<string, unknown>, path: string): TargetMessage {
  return isAbsent(container, 'targetId') ? {} : { targetId: requireEntityId(container, 'targetId', path) };
}

export function decodeEngageMessage(container: Record<string, unknown>, path: string): EngageMessage {
  return { on: requireBool(container, 'on', path) };
}

/** The ability id decodes as an id: the abilities are core's, so the server checks it. */
export function decodeUseAbilityMessage(container: Record<string, unknown>, path: string): UseAbilityMessage {
  return { abilityId: requireId(container, 'abilityId', path) };
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

export function decodeBuyMessage(container: Record<string, unknown>, path: string): BuyMessage {
  return {
    npcId: requireEntityId(container, 'npcId', path),
    baseId: requireId(container, 'baseId', path),
  };
}

export function decodeSellMessage(container: Record<string, unknown>, path: string): SellMessage {
  return {
    npcId: requireEntityId(container, 'npcId', path),
    itemId: requireId(container, 'itemId', path),
  };
}

export function decodeEmptyMessage(): EmptyMessage {
  return {};
}

/**
 * Uncapped on decode, like `decodeClientSayMessage`: the server's session handler answers an over-cap
 * token with `loginResult(badCredentials)` and keeps the socket open, so the cap is its concern.
 */
export function decodeRedeemSessionMessage(container: Record<string, unknown>, path: string): RedeemSessionMessage {
  return { token: requireString(container, 'token', path), ...decodeOptionalLocale(container, path) };
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

function decodeCharacterSummaryMessage(container: Record<string, unknown>, path: string): CharacterSummaryMessage {
  return {
    id: requireEntityId(container, 'id', path),
    name: requireBoundedString(container, 'name', path, PROTOCOL_BYTE_CAPS.identifier),
    people: requireId(container, 'people', path),
    ...(isAbsent(container, 'role') ? {} : { role: requireStringEnum(container, 'role', path, ROLES) }),
  };
}

export function decodeCharactersMessage(container: Record<string, unknown>, path: string): CharactersMessage {
  return { characters: mapArray(container, 'characters', path, SOMNIO_PROTOCOL_CONSTANTS.maxCharactersPerAccount, decodeCharacterSummaryMessage) };
}

export function decodeCharacterResultMessage(container: Record<string, unknown>, path: string): CharacterResultMessage {
  return { result: requireStringEnum(container, 'result', path, CHARACTER_RESULTS) };
}

export function decodeEnterSpaceMessage(container: Record<string, unknown>, path: string): EnterSpaceMessage {
  const worldSeconds = requireFloat(container, 'worldSeconds', path);
  if (worldSeconds < 0) {
    throw new WireDecodingError(`${path}.worldSeconds`, `expected a non-negative number, got ${worldSeconds}`);
  }
  return {
    spaceId: requireBoundedString(container, 'spaceId', path, PROTOCOL_BYTE_CAPS.sectorName),
    selfId: requireEntityId(container, 'selfId', path),
    people: requireId(container, 'people', path),
    worldSeconds,
  };
}

export function decodeSectorMessage(container: Record<string, unknown>, path: string): SectorMessage {
  return {
    sector: decodeSectorView(requireNested(container, 'sector', path), `${path}.sector`),
    ...(isAbsent(container, 'outdoorDoorIds')
      ? {}
      : { outdoorDoorIds: requireIds(container, 'outdoorDoorIds', path, SOMNIO_PROTOCOL_CONSTANTS.maxSectorDoors) }),
  };
}

/**
 * The entity name is bounded on decode for the same reason chat text is: nothing caps what the
 * server *sends*, and a name is retained three times over — in the entity map, in the roster (which
 * re-runs a collating sort on every arrival), and in the `left` chat line when the peer departs.
 *
 * **Truncated, not rejected.** This field carries operator-authored NPC and monster names as well as
 * character names, and only the character names are bounded: `maxIdentifierUTF8Bytes` is enforced
 * when a character is created, while the sector format bounds NPC and monster names nowhere.
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
    ...(isAbsent(container, 'held') ? {} : { held: decodeHeld(requireNested(container, 'held', path), `${path}.held`) }),
    ...(isAbsent(container, 'rank') ? {} : { rank: requireStringEnum(container, 'rank', path, NIGHTMARE_RANKS) }),
    ...(isAbsent(container, 'trait') ? {} : { trait: requireId(container, 'trait', path) }),
    ...(isAbsent(container, 'summonedBy') ? {} : { summonedBy: requireEntityId(container, 'summonedBy', path) }),
  };
}

function decodeHeld(container: Record<string, unknown>, path: string): Held {
  return {
    ...(isAbsent(container, 'mainHand') ? {} : { mainHand: requireId(container, 'mainHand', path) }),
    ...(isAbsent(container, 'offHand') ? {} : { offHand: requireId(container, 'offHand', path) }),
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
  return { moves: mapArray(container, 'moves', path, SOMNIO_PROTOCOL_CONSTANTS.maxMovesPerFrame, decodeEntityMove) };
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
 * an uncapped inbound line freezes the tab. The name is truncated as `decodeEntityMessage` truncates
 * it, for the same reasons.
 */
export function decodeSayMessage(container: Record<string, unknown>, path: string): SayMessage {
  return {
    entityId: requireEntityId(container, 'entityId', path),
    name: truncateToUTF8Bytes(requireString(container, 'name', path), PROTOCOL_BYTE_CAPS.identifier),
    kind: requireStringEnum(container, 'kind', path, SPEECH_KINDS),
    text: requireWithinByteCap(requireString(container, 'text', path), PROTOCOL_BYTE_CAPS.say, `${path}.text`),
    clarity: requireUnitInterval(container, 'clarity', path),
    x: requireMetres(container, 'x', path),
    z: requireMetres(container, 'z', path),
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

function decodeAffixMessage(container: Record<string, unknown>, path: string): AffixMessage {
  return {
    affixId: requireId(container, 'affixId', path),
    value: requireNonNegative(requireInt32(container, 'value', path), `${path}.value`),
  };
}

/** Item, base, and affix ids decode as ids: the items are core's, so core's reader checks them. */
function decodeItemMessage(container: Record<string, unknown>, path: string): ItemMessage {
  const tier = requireInt32(container, 'tier', path);
  if (tier < 1) {
    throw new WireDecodingError(`${path}.tier`, `expected a tier of 1 or more, got ${tier}`);
  }
  return {
    id: requireId(container, 'id', path),
    baseId: requireId(container, 'baseId', path),
    tier,
    rarity: requireStringEnum(container, 'rarity', path, RARITIES),
    affixes: mapArray(container, 'affixes', path, SOMNIO_PROTOCOL_CONSTANTS.maxItemAffixes, decodeAffixMessage),
  };
}

function decodeEquippedItemMessage(container: Record<string, unknown>, path: string): EquippedItemMessage {
  return {
    slot: requireStringEnum(container, 'slot', path, EQUIP_SLOTS),
    item: decodeItemMessage(requireNested(container, 'item', path), `${path}.item`),
  };
}

function decodeBaggedItemMessage(container: Record<string, unknown>, path: string): BaggedItemMessage {
  return {
    place: requireBagPlace(container, 'place', path),
    item: decodeItemMessage(requireNested(container, 'item', path), `${path}.item`),
  };
}

/** A place in the bag: a whole number from 0 to one less than `maxBagItems`. */
function requireBagPlace(container: Record<string, unknown>, key: string, path: string): number {
  const place = requireInt32(container, key, path);
  if (place < 0 || place >= SOMNIO_PROTOCOL_CONSTANTS.maxBagItems) {
    throw new WireDecodingError(`${path}.${key}`, `expected a bag place from 0 to ${SOMNIO_PROTOCOL_CONSTANTS.maxBagItems - 1}, got ${place}`);
  }
  return place;
}

function decodeTradeMessage(container: Record<string, unknown>, path: string): TradeMessage {
  return {
    kind: requireStringEnum(container, 'kind', path, TRADE_KINDS),
    baseId: requireId(container, 'baseId', path),
    rarity: requireStringEnum(container, 'rarity', path, RARITIES),
    coins: requireNonNegative(requireInt32(container, 'coins', path), `${path}.coins`),
  };
}

export function decodeInventoryMessage(container: Record<string, unknown>, path: string): InventoryMessage {
  const equipped = mapArray(container, 'equipped', path, EQUIP_SLOTS.length, decodeEquippedItemMessage);
  const worn = new Set<EquipSlot>();
  equipped.forEach(({ slot }, index) => {
    if (worn.has(slot)) {
      throw new WireDecodingError(`${path}.equipped[${index}].slot`, `slot "${slot}" worn twice`);
    }
    worn.add(slot);
  });
  const bag = mapArray(container, 'bag', path, SOMNIO_PROTOCOL_CONSTANTS.maxBagItems, decodeBaggedItemMessage);
  const taken = new Set<number>();
  bag.forEach(({ place }, index) => {
    if (taken.has(place)) {
      throw new WireDecodingError(`${path}.bag[${index}].place`, `place ${place} held twice`);
    }
    taken.add(place);
  });
  return {
    coins: requireNonNegative(requireInt32(container, 'coins', path), `${path}.coins`),
    equipped,
    bag,
    ...(isAbsent(container, 'trade') ? {} : { trade: decodeTradeMessage(requireNested(container, 'trade', path), `${path}.trade`) }),
    ...(isAbsent(container, 'dropped') ? {} : { dropped: decodeLootContentsMessage(requireNested(container, 'dropped', path), `${path}.dropped`) }),
    ...(isAbsent(container, 'pickedUp') ? {} : { pickedUp: decodeLootContentsMessage(requireNested(container, 'pickedUp', path), `${path}.pickedUp`) }),
  };
}

/** A tagged union on `kind`, so a kind this build does not know fails on its tag rather than on a field it lacks. */
function decodeLootContentsMessage(container: Record<string, unknown>, path: string): LootContentsMessage {
  const kind = requireStringEnum(container, 'kind', path, LOOT_KINDS);
  switch (kind) {
    case 'item':
      return { kind, baseId: requireId(container, 'baseId', path), rarity: requireStringEnum(container, 'rarity', path, RARITIES) };
  }
}

export function decodeLootMessage(container: Record<string, unknown>, path: string): LootMessage {
  return {
    lootId: requireId(container, 'lootId', path),
    x: requireMetres(container, 'x', path),
    z: requireMetres(container, 'z', path),
    contents: decodeLootContentsMessage(requireNested(container, 'contents', path), `${path}.contents`),
    ...(isAbsent(container, 'shared') ? {} : { shared: requireBool(container, 'shared', path) }),
    ...(isAbsent(container, 'from') ? {} : { from: decodeThrownFromMessage(requireNested(container, 'from', path), `${path}.from`) }),
  };
}

function decodeThrownFromMessage(container: Record<string, unknown>, path: string): ThrownFromMessage {
  return {
    x: requireMetres(container, 'x', path),
    z: requireMetres(container, 'z', path),
    ...(isAbsent(container, 'entityId') ? {} : { entityId: requireEntityId(container, 'entityId', path) }),
    ...(isAbsent(container, 'hand') ? {} : { hand: requireStringEnum(container, 'hand', path, HANDS) }),
  };
}

export function decodeLootGoneMessage(container: Record<string, unknown>, path: string): LootGoneMessage {
  return { lootId: requireId(container, 'lootId', path) };
}

export function decodeLeaveMessage(container: Record<string, unknown>, path: string): LeaveMessage {
  return {
    entityId: requireEntityId(container, 'entityId', path),
    leftGame: requireBool(container, 'leftGame', path),
    ...(isAbsent(container, 'crumbled') ? {} : { crumbled: requireBool(container, 'crumbled', path) }),
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
    ranks: mapArray(container, 'ranks', path, SOMNIO_PROTOCOL_CONSTANTS.maxLucidityRanks, decodeTeachingRankMessage),
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

export function decodeHeldMessage(container: Record<string, unknown>, path: string): HeldMessage {
  return {
    entityId: requireEntityId(container, 'entityId', path),
    held: decodeHeld(requireNested(container, 'held', path), `${path}.held`),
  };
}

export function decodeVitalsMessage(container: Record<string, unknown>, path: string): VitalsMessage {
  return {
    entityId: requireEntityId(container, 'entityId', path),
    health: requireUnitInterval(container, 'health', path),
  };
}

function decodeHeldEffectMessage(container: Record<string, unknown>, path: string): HeldEffectMessage {
  return {
    effectId: requireId(container, 'effectId', path),
    ...(isAbsent(container, 'seconds') ? {} : { seconds: requireNonNegative(requireFloat(container, 'seconds', path), `${path}.seconds`) }),
  };
}

/** Effect ids decode as ids: the effects are core's, and the client draws only those it knows. */
export function decodeEffectsMessage(container: Record<string, unknown>, path: string): EffectsMessage {
  return {
    entityId: requireEntityId(container, 'entityId', path),
    effects: mapArray(container, 'effects', path, SOMNIO_PROTOCOL_CONSTANTS.maxEntityEffects, decodeHeldEffectMessage),
  };
}

export function decodeBlowMessage(container: Record<string, unknown>, path: string): BlowMessage {
  return {
    attackerId: requireEntityId(container, 'attackerId', path),
    targetId: requireEntityId(container, 'targetId', path),
    hit: requireBool(container, 'hit', path),
  };
}

export function decodeAbilityMessage(container: Record<string, unknown>, path: string): AbilityMessage {
  const phase = isAbsent(container, 'phase') ? undefined : requireStringEnum(container, 'phase', path, ABILITY_PHASES);
  const timed = phase === 'start' || phase === 'channel';
  if (timed === isAbsent(container, 'seconds')) {
    throw new WireDecodingError(`${path}.seconds`, timed ? 'expected the seconds of a channel' : 'expected no seconds outside a channel');
  }
  return {
    entityId: requireEntityId(container, 'entityId', path),
    abilityId: requireId(container, 'abilityId', path),
    ...(isAbsent(container, 'targetId') ? {} : { targetId: requireEntityId(container, 'targetId', path) }),
    ...(phase === undefined ? {} : { phase }),
    ...(timed ? { seconds: requireNonNegative(requireFloat(container, 'seconds', path), `${path}.seconds`) } : {}),
    ...(isAbsent(container, 'evaded') ? {} : { evaded: requireBool(container, 'evaded', path) }),
  };
}

function decodeAbilityCooldownMessage(container: Record<string, unknown>, path: string): AbilityCooldownMessage {
  return {
    abilityId: requireId(container, 'abilityId', path),
    seconds: requireNonNegative(requireFloat(container, 'seconds', path), `${path}.seconds`),
  };
}

export function decodeCooldownsMessage(container: Record<string, unknown>, path: string): CooldownsMessage {
  return {
    globalSeconds: requireNonNegative(requireFloat(container, 'globalSeconds', path), `${path}.globalSeconds`),
    cooldowns: mapArray(container, 'cooldowns', path, SOMNIO_PROTOCOL_CONSTANTS.maxAbilityCooldowns, decodeAbilityCooldownMessage),
  };
}

export function decodeRaisingMessage(container: Record<string, unknown>, path: string): RaisingMessage {
  const healerIds = requireEntityIds(container, 'healerIds', path, SOMNIO_PROTOCOL_CONSTANTS.maxRaiseHealers);
  if (healerIds.length === 0) {
    throw new WireDecodingError(`${path}.healerIds`, 'expected at least one healer');
  }
  return {
    targetId: requireEntityId(container, 'targetId', path),
    healerIds,
    state: requireStringEnum(container, 'state', path, RAISING_STATES),
    progress: requireUnitInterval(container, 'progress', path),
    seconds: requireNonNegative(requireFloat(container, 'seconds', path), `${path}.seconds`),
    ...decodePausedSeconds(container, path, healerIds.length),
  };
}

/** One pause per Healer named, so the count is checked against theirs before any pause is decoded. */
function decodePausedSeconds(container: Record<string, unknown>, path: string, healerCount: number): { pausedSeconds?: number[] } {
  if (isAbsent(container, 'pausedSeconds')) return {};
  const pauses = requireArray(container, 'pausedSeconds', path);
  if (pauses.length !== healerCount) {
    throw new WireDecodingError(`${path}.pausedSeconds`, `expected one pause per Healer (${healerCount}), got ${pauses.length}`);
  }
  return {
    pausedSeconds: pauses.map((pause, index) => {
      const elementPath = `${path}.pausedSeconds[${index}]`;
      return requireNonNegative(requireFloatValue(pause, elementPath), elementPath);
    }),
  };
}

export function decodeMendMessage(container: Record<string, unknown>, path: string): MendMessage {
  return { targetId: requireEntityId(container, 'targetId', path) };
}

export function decodeTelegraphMessage(container: Record<string, unknown>, path: string): TelegraphMessage {
  return {
    id: requireId(container, 'id', path),
    casterId: requireEntityId(container, 'casterId', path),
    kind: requireStringEnum(container, 'kind', path, TELEGRAPH_KINDS),
    x: requireMetres(container, 'x', path),
    z: requireMetres(container, 'z', path),
    radius: requirePositiveMetres(container, 'radius', path),
    seconds: requireNonNegative(requireFloat(container, 'seconds', path), `${path}.seconds`),
  };
}

function decodeSensedBearingMessage(container: Record<string, unknown>, path: string): SensedBearingMessage {
  return {
    name: requireBoundedString(container, 'name', path, PROTOCOL_BYTE_CAPS.identifier),
    x: requireMetres(container, 'x', path),
    z: requireMetres(container, 'z', path),
  };
}

export function decodeSensedMessage(container: Record<string, unknown>, path: string): SensedMessage {
  return { bearings: mapArray(container, 'bearings', path, SOMNIO_PROTOCOL_CONSTANTS.maxSensedBearings, decodeSensedBearingMessage) };
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

export function decodeOtherSessionsMessage(container: Record<string, unknown>, path: string): OtherSessionsMessage {
  return { count: requireNonNegative(requireInt32(container, 'count', path), `${path}.count`) };
}

export function decodeOtherSessionsRevokedMessage(container: Record<string, unknown>, path: string): OtherSessionsRevokedMessage {
  return {
    revoked: requireBool(container, 'revoked', path),
    count: requireNonNegative(requireInt32(container, 'count', path), `${path}.count`),
  };
}
