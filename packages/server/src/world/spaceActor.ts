import { HANDS, SOMNIO_PROTOCOL_CONSTANTS, encodeSomnioMessage } from '@somnio/protocol';
import type {
  AbilityPhase,
  ClientSayMessage,
  Condition,
  EffectsMessage,
  Energy,
  EntityMessage,
  EntityMove,
  EquipSlot,
  Gait,
  Held,
  Locale,
  LootContentsMessage,
  LucidityMessage,
  MoveMessage,
  NightmareRank,
  QuestShareOutcome,
  RaisingState,
  Service,
  SomnioMessage,
  SpeechKind,
  ThrownFromMessage,
} from '@somnio/protocol';
import {
  COMBAT,
  EDGE_TOLERANCE,
  ELITE_TRAIT_IDS,
  GLOBAL_COOLDOWN_SECONDS,
  MAX_SHARED_DROPS,
  MOVE_ALLOWANCE_SECONDS,
  NIGHTMARE_AWARENESS,
  NIGHTMARE_WANDER,
  OUTDOOR_SPACE_ID,
  POOL_FIELDS,
  PRACTICE,
  QUEST_OFFER_SECONDS,
  SHARED_LOOT_SECONDS,
  SOMNIO_CONSTANTS,
  THROW_DISTANCE,
  SPEECH,
  TELEGRAPHS,
  ability,
  abilityAllowed,
  advancedQuests,
  abilityChannelSeconds,
  abilityCooldownSeconds,
  abilityRank,
  areaRecipients,
  bagHasRoom,
  boardDay,
  boltFlightSeconds,
  bountyLands,
  bountyQuest,
  balancePace,
  balancePerSecond,
  bodiesBlock,
  bossMoves,
  buyBackable,
  buildSpaceCollision,
  canBuy,
  canStand,
  collectsTrophy,
  conditionOf,
  crumble,
  dayBounties,
  dialogSteps,
  distance,
  drivesOff,
  droppableItem,
  effect,
  effectAbsorb,
  effectHealthPerSecond,
  effectSeconds,
  eliteTrait,
  engageAction,
  equipItem,
  gaitAllowed,
  gaitMetresPerSecond,
  grantItem,
  handAllows,
  heading,
  heldQuest,
  headingFromCardinal,
  headingFromVector,
  headingRadians,
  inventoryMessage,
  isAbilityId,
  isBountyId,
  isClear,
  isLegalMove,
  isQuestId,
  isTeachingId,
  localizedDialogLine,
  masterRole,
  mayAccept,
  mayShare,
  mayTakeBounty,
  maxPools,
  mendAmount,
  mendReaches,
  monsterKind,
  nightmareHealth,
  moveItem,
  neighbourSectors,
  newItemId,
  nextLastSeen,
  npcBodies,
  npcEntityId,
  offeredBounty,
  outdoorDoorIds,
  placedFixtures,
  plainInstance,
  poolShare,
  practiceNeeded,
  raiseSecondsFor,
  raiseWorkOver,
  quest,
  questCarriedBy,
  questsMessage,
  price,
  rankOf,
  reachDistance,
  reachedAt,
  reaches,
  rectContains,
  resolveDoor,
  rollDrops,
  rollQuestGear,
  scatterLandings,
  scaled,
  salePrice,
  sellableItem,
  shareOutcomeFor,
  sectorAt,
  sectorPointInSpace,
  sectorView,
  shieldedHarm,
  soldToShopAfterSale,
  spawnArea,
  speechClarity,
  spiritPerSecond,
  statsOf,
  strikeChance,
  swingAllowed,
  swingFor,
  swingMeets,
  teaching,
  teachingStanding,
  threatRaised,
  turnInFor,
  turnInGrant,
  unequipItem,
  wardShare,
  wholeAmount,
  windedAfter,
  windedOnJoin,
  withItem,
  withAccepted,
  withAcceptedBounty,
  withBoardDay,
  withRank,
  withTurnedIn,
  withoutItem,
  withoutQuest,
  throwLanding,
  withinPickupReach,
  withinSpeakingDistance,
} from '@somnio/core';
import type {
  Ability,
  AbilityBody,
  AbilityDeed,
  AbilityId,
  Body,
  BossMoves,
  Bounty,
  BountyLand,
  Character,
  EffectId,
  EliteTraitId,
  EngageAction,
  EngageTarget,
  Heading,
  Inventory,
  InventoryChange,
  Item,
  ItemInstance,
  Lucidity,
  MonsterKind,
  MonsterKindId,
  MonsterSpawn,
  NPCDialogState,
  PlacedFixture,
  Point,
  Quest,
  QuestCarrier,
  QuestLog,
  QuestObjective,
  QuestOrBountyId,
  Rect,
  Sector,
  SectorNPC,
  Space,
  SpaceCollision,
  Stats,
} from '@somnio/core';
import { encodeOrWarn } from '../connection/encodeFrame.ts';
import { LogThrottle } from '../connection/logThrottle.ts';
import type { ConnectionOutbox } from '../connection/outbox.ts';
import type { Logger } from '../logging.ts';
import { counterpartOf } from '../sectors/sectorCache.ts';
import type { LoadedWorld } from '../sectors/sectorCache.ts';
import { PersonalDrops } from './personalDrops.ts';
import { randomInRange, randomUnit, systemRandom } from './random.ts';
import type { RandomSource } from './random.ts';

interface PlayerSlot {
  character: Character;
  inventory: Inventory;
  /** What the dreamer sold the shopkeeper here, newest first, to buy back until they leave the space. It is never saved. */
  soldToShop: ItemInstance[];
  outbox: ConnectionOutbox;
  /** The language NPCs speak to this player in. */
  locale: Locale;
  gait: Gait;
  /** The sector the player stands in, which decides what they are sent. */
  sector: string;
  /** The metres the player may still move, as of `allowanceAt`. */
  allowance: number;
  allowanceAt: number;
  /** The seconds the player may still walk or jog, as of `paceCreditAt`; metres past it are charged as running. */
  paceCredit: number;
  paceCreditAt: number;
  /** Until when recovery reads the player at each gait, as `holdMotion` holds it, and as `payPace` holds a run for metres charged as running. */
  movingUntil: Record<Gait, number>;
  /** The metres of a leap still to come, which take the leap's time whatever gait the client reports them at. */
  leap: { metres: number; metresPerSecond: number };
  rejectionLog: LogThrottle;
  /**
   * What recovery and the running drain have not yet moved into `character.energy`, which holds
   * whole numbers only. Each is under one unit, and none is saved.
   */
  carry: { health: number; balance: number; spirit: number };
  /** Kept with `windedAfter` over every balance the dreamer is sent, as their client keeps it. */
  winded: boolean;
  swingReadyAt: number;
  mendReadyAt: number;
  /** Nightmares leave the dreamer alone until this moment. */
  graceUntil: number;
  condition: Condition;
  /** What everyone who sees the dreamer was last shown in their hands. */
  held: Held;
  /** The raise this fallen dreamer is being given, by every Healer holding on. */
  raise: Raise | undefined;
  /** The quest another dreamer here shared with this one, awaiting their answer. */
  questOffer: QuestOffer | undefined;
  /** The entity the dreamer chose to act on. It is let go once it is out of their view. */
  target: string | undefined;
  /** Whether slot 1 is on: the dreamer attacks their target, a nightmare, or a Healer mends or raises their target, a dreamer. */
  engaged: boolean;
  /** The health share of their target last sent to the dreamer, and when. */
  vitals: { entityId: string; health: number; at: number } | undefined;
  effects: HeldEffect[];
  /** When the global cooldown ends, and when each ability's own does; an ability left out is ready. */
  globalReadyAt: number;
  readyAt: Partial<Record<AbilityId, number>>;
  /** The channel under way, during which slot 1 holds and no other ability is used. */
  channel: Channel | undefined;
}

/** A timed effect an entity holds: until when, who put it on them, and at what rank. */
interface HeldEffect {
  effectId: EffectId;
  endsAt: number;
  sourceId: string;
  rank: number;
  /** A heal over time gives its holder health once a second: when it next does, and the part of a whole health owed from those before. */
  heal: { perSecond: number; nextAt: number; owed: number } | undefined;
  /** What a shield still takes in its holder's place; `undefined` for an effect that is no shield. */
  shield: number | undefined;
}

/** An ability being channelled: whom it lands on, at what rank, and when. */
interface Channel {
  abilityId: AbilityId;
  recipientId: string;
  rank: number;
  endsAt: number;
}

/** Harm sent at a nightmare as a bolt, landing on it when the bolt arrives. */
interface Bolt {
  caster: PlayerSlot;
  monster: MonsterRuntime;
  damage: number;
  landsAt: number;
}

interface Raise {
  /** The pace-seconds done by `accruedAt`, up to the raise time: each Healer holding on adds one a second. */
  work: number;
  /** When `work` was last brought up to, by `accrueRaise`. */
  accruedAt: number;
  /** The Healers holding on, in the order they took hold. */
  holders: string[];
  /** Each Healer who has held on, also after they dropped out: the seconds held and the spirit paid for them. */
  shares: Map<string, { seconds: number; charged: number }>;
}

/** A quest shared with a dreamer: by whom, and until when they may take it on. */
interface QuestOffer {
  offerId: number;
  questId: QuestOrBountyId;
  fromId: string;
  endsAt: number;
}

interface NPCRuntime {
  id: string;
  sector: string;
  definition: SectorNPC;
  position: Point;
  /** The dreamer who asked it to go on, while it says the lines after its greeting. */
  targetingEntity: string | undefined;
  /** The parsed script, cached so a step does not parse it again: the greeting, then what it says when asked. */
  dialogSteps: string[];
  /** No line after the greeting is spoken before this moment. */
  readyAt: number;
  /** No greeting is spoken before this moment. A dreamer who asks right after being greeted is answered at once. */
  greetReadyAt: number;
  /** 0-based cursor into `dialogSteps`. Persisted as 1-based; translated at the seam. */
  scriptStepIndex: number;
  /** The dreamers within speaking distance it has taken note of, so each is greeted once per approach. */
  near: Set<string>;
  /** When it last greeted each dreamer in the space. */
  greetedAt: Map<string, number>;
}

interface MonsterRuntime {
  id: string;
  kindId: MonsterKindId;
  kind: MonsterKind;
  /** Set on an elite, which spawns with more health and drops better. */
  trait: EliteTraitId | undefined;
  /** When a renewing trait whose effect has ended puts it on again. */
  traitRenewsAt: number | undefined;
  sector: string;
  position: Point;
  /** Toward where it means to go, even when its way is blocked, and toward whoever it strikes. Otherwise it keeps the facing it last had, south until it first turns. */
  facing: Heading;
  health: number;
  healthMax: number;
  condition: Condition;
  strikeReadyAt: number;
  /** The spawn keeping it alive, a slot of which its fall, or its leaving walled off, frees; none for a minion a boss called up. */
  timer: MonsterSpawnTimer | undefined;
  /** The boss that called it up, whose fight it lasts no longer than. */
  summoner: MonsterRuntime | undefined;
  /** Set on a boss: its moves and how they stand. */
  boss: Boss | undefined;
  /**
   * Its spawn's area in the space, its summoner's for a minion: where it spawns, wanders, and goes
   * back to. A confined nightmare (`confined`) chases only dreamers standing inside, and never leaves it.
   */
  area: Rect;
  phase: MonsterPhase;
  /** When it may next pick a point of its area to wander to. */
  wanderAt: number;
  /**
   * Where it last stood at rest or wandering before it set off, to fight or to follow: where a return
   * walks it back to. Always inside its area, since it rests and wanders only there, and a return
   * held up outside the area by a body on it takes a free point of the area near it instead (`rehome`).
   */
  home: Point;
  /** The side it last turned to round something in its way. */
  steerSide: 1 | -1;
  /**
   * The closest it has come to `home` on the current return, and when. A new home (`rehome`) sets
   * both afresh, and once `homeBestAt` is `HOME_PROGRESS_SECONDS` past, `walkHome` tries only the
   * straight step.
   */
  homeBest: number;
  homeBestAt: number;
  /**
   * When it last came `HOME_PROGRESS_METRES` nearer home on the current return, or set out on it:
   * what `STUCK_RETURN_SECONDS` counts from. A new home leaves it be, so no number of them puts off
   * the leaving of one walled off from home.
   */
  homeNearedAt: number;
  /** Set once it is driven off: it lies until this moment and does nothing. */
  lyingUntil: number | undefined;
  effects: HeldEffect[];
  /** The threat each dreamer on its table has raised against it, by their entity id. */
  threat: Map<string, number>;
  /** The dreamers who struck it from within its reach since its last turn. At its next it may answer one, and forgets the rest. */
  answerDue: Set<string>;
}

/**
 * What a nightmare is about. At `rest` it stands, noticing. On a `wander` it walks at half speed to
 * a point of its area, noticing. On a `follow` it is aware of a leader that set off, still until
 * `from` and then following it, and `alerted` once it has stirred its own neighbours. In a `fight`
 * it chases, leashed to `from`, where the fight began, unless confined. On a `return` it walks back
 * to its `home`, `evading` everything after a give-up until stalled outside its area, and nothing
 * after a lead it lost.
 */
type MonsterPhase =
  | { at: 'rest' }
  | { at: 'wander'; to: Point }
  | { at: 'follow'; leaderId: string; from: number; alerted: boolean }
  | { at: 'fight'; from: Point }
  | { at: 'return'; evading: boolean };

/** A boss's moves, and how they stand: the wail under way, when it may next wail and call up minions, and when it gives its fight up. */
interface Boss {
  moves: BossMoves;
  /**
   * When it gives its fight up, `giveUpSeconds` after it last had someone to chase in a fight. None
   * while it has someone to chase, and none outside a fight, so it gives up once per fight.
   */
  givesUpAt: number | undefined;
  /** The wail telegraphed, by its telegraph's id: round where the boss stood as it began, striking at `endsAt`. */
  wail: { id: string; centre: Point; endsAt: number } | undefined;
  /** When it may next wail; armed afresh with `callReadyAt` as each fight begins. */
  wailReadyAt: number;
  callReadyAt: number;
}

/**
 * What a drop is: a whole item, of which whoever is shown the drop sees only the base and the rarity
 * until they pick it up, or the trophy of a nightmare kind, which never enters the bag.
 */
type LootContents = { kind: 'item'; item: Item } | { kind: 'trophy'; monsterKind: MonsterKindId };

/**
 * A drop lying on the ground until it is picked up: one from a nightmare for one dreamer alone,
 * which lies until they leave the world or it is their oldest past `MAX_PERSONAL_DROPS`, or an item
 * a dreamer dropped, for anyone, which lies until it has lain there too long.
 */
interface Loot {
  lootId: string;
  /** The dreamer it lies for alone; none for an item a dreamer dropped. */
  ownerId: string | undefined;
  position: Point;
  /** The sector it lies in, by whose interest an item a dreamer dropped is shown. */
  sector: string;
  contents: LootContents;
  /** When an item a dreamer dropped is gone; none for a drop from a nightmare. */
  expiresAt: number | undefined;
}

/** A live door of the space whose counterpart lies in another space: a yell near it is heard on the far side. */
interface Doorway {
  /** The door's own opening, in this space. */
  near: Point;
  spaceId: string;
  /** The counterpart's opening, in its space, where the voice comes out. */
  far: Point;
}

interface Voice {
  entityId: string;
  name: string;
  kind: SpeechKind;
  /** A dreamer's words as said, or the step of its script an NPC says to a dreamer, which each listener hears in their own language. */
  line: { words: string } | { step: string; targetName: string };
}

/**
 * A line as said once. Every listener's crumble of it draws on the same `rolls`, each drawn when the
 * first listener needs it. So one who hears it less clearly misses every word a clearer one missed,
 * and listeners who pool what they heard learn no more than the clearest of them, except words a
 * cut to the say cap took from that one's end. That holds among listeners who hear it in one
 * language: an NPC's line in two languages is two texts, whose words the same rolls pick apart.
 */
interface Utterance {
  voice: Voice;
  rolls: number[];
}

/** Per-`MonsterSpawn` cadence: while fewer than `maxAlive` of its monsters live, it spawns one at `spawnAt`. */
interface MonsterSpawnTimer {
  sector: Sector;
  definition: MonsterSpawn;
  alive: number;
  spawnAt: number;
}

/** A yell's way into another space, through one door: it comes out at `source` already `baseMetres` along. */
export interface DoorVoice {
  spaceId: string;
  source: Point;
  baseMetres: number;
}

/** A yell spoken near doors, for the router to carry into the spaces beyond them. */
export interface YellThroughDoors {
  utterance: Utterance;
  voices: DoorVoice[];
}

/**
 * What a dreamer carries through a door or a wake, and back after a disconnect, but is never
 * saved. Each effect they hold, each cooldown running, the swing and touch timers, and how long
 * recovery still reads them as running come with the seconds each has left. The movement
 * allowance and the pace credit come as they stood.
 */
export interface PlayerTransient {
  /**
   * `shield` is what a shield still takes, and `heal` the seconds until a heal over time next gives
   * health and the part of a whole it owes, carried so a door neither makes a worn shield whole nor
   * costs a heal its time.
   */
  effects: { effectId: EffectId; seconds: number; sourceId: string; rank: number; shield?: number; heal?: { seconds: number; owed: number } }[];
  globalSeconds: number;
  cooldowns: { abilityId: AbilityId; seconds: number }[];
  swingSeconds: number;
  mendSeconds: number;
  runningSeconds: number;
  /** Metres. */
  allowance: number;
  /** Seconds. */
  paceCredit: number;
  /** How long the dreamer was out of the world, which refills the allowance and the pace credit on arrival: 0 for a door. */
  awaySeconds: number;
}

export interface PlayerCheckpoint {
  character: Character;
  inventory: Inventory;
}

/** A player taken out of the space: what is saved of them, and what they carry on but is never saved. */
export interface PlayerHandOver {
  checkpoint: PlayerCheckpoint;
  transient: PlayerTransient;
}

/** One step's persistence digest; the router applies it outside the actor so a failed write cannot corrupt in-process state. */
export interface TickDigest {
  dialogUpserts: NPCDialogState[];
  /** The NPCs whose dialog row is deleted: a reset persists a deletion, not a full state. */
  dialogResets: Pick<NPCDialogState, 'sectorName' | 'npcId'>[];
}

/** What a joining player and every NPC and monster start at; a player's own gait arrives with their first move. */
const DEFAULT_GAIT: Gait = 'jog';
/**
 * A player's movement budget accrues on the server's clock at running speed with a quarter to
 * spare, and holds `MOVE_ALLOWANCE_SECONDS` of it: the reports a stalled connection held back arrive
 * together, and a client that never outran its gait is not to be corrected for them.
 */
const ALLOWANCE_METRES_PER_SECOND = gaitMetresPerSecond('run') * 1.25;
const ALLOWANCE_CAP_METRES = ALLOWANCE_METRES_PER_SECOND * MOVE_ALLOWANCE_SECONDS;
/**
 * The seconds a player may still walk or jog accrue with the allowance's quarter to spare,
 * whatever gait is reported, so no report buys credit faster than another. Each walked or jogged
 * move spends its length over its own gait's speed.
 */
const PACE_CREDIT_SECONDS_PER_SECOND = 1.25;
/**
 * The most the pace credit refills to: what the allowance covers at a walk, the slowest gait, so
 * reports a stall bunched are never charged where the allowance accepts them. A Lunge can lift the
 * credit past it (`handleUseAbility`).
 */
const PACE_CREDIT_CAP_SECONDS = ALLOWANCE_CAP_METRES / gaitMetresPerSecond('walk');
/** How far a move's cost may pass the pace credit uncharged, so a bunch of exactly the cap summed in floating point is not charged an ulp. */
const PACE_CREDIT_TOLERANCE_SECONDS = 1e-6;

/** What a first join starts from: nothing running, and a full allowance and pace credit. */
export const NO_TRANSIENT: PlayerTransient = {
  effects: [],
  globalSeconds: 0,
  cooldowns: [],
  swingSeconds: 0,
  mendSeconds: 0,
  runningSeconds: 0,
  allowance: ALLOWANCE_CAP_METRES,
  paceCredit: PACE_CREDIT_CAP_SECONDS,
  awaySeconds: 0,
};

/**
 * How long away until a dreamer who left with `transient` comes back as a first join would: every
 * timer and effect run out, and the allowance and pace credit refilled as `attach` refills them.
 * A pace credit past its cap, the unspent part of a leap, is not counted.
 */
export function settledAfterSeconds(transient: PlayerTransient): number {
  return Math.max(
    transient.globalSeconds,
    transient.swingSeconds,
    transient.mendSeconds,
    transient.runningSeconds,
    ...transient.effects.map((held) => held.seconds),
    ...transient.cooldowns.map((cooldown) => cooldown.seconds),
    (ALLOWANCE_CAP_METRES - transient.allowance) / ALLOWANCE_METRES_PER_SECOND,
    (PACE_CREDIT_CAP_SECONDS - transient.paceCredit) / PACE_CREDIT_SECONDS_PER_SECOND,
  );
}
/** Minimum gap between one player's rejected-move warnings. */
const REJECTED_MOVE_LOG_INTERVAL_MS = 5000;
const PLACEMENT_ATTEMPTS = 64;
/**
 * The longest a spawn waits to fill at first, when its space starts: a boss's long respawn holds it
 * back only after it is driven off, not after every restart.
 */
const FIRST_FILL_SECONDS = 60;
/** The nearest a minion is called up to its boss, centre to centre. */
const MINION_NEAREST_METRES = 1;
/**
 * How far out from a home with a body on it a returning nightmare looks for another (`rehome`), in
 * rings `REHOME_RING_METRES` apart of `REHOME_RING_POINTS` points each.
 */
const REHOME_METRES = 3;
const REHOME_RING_METRES = 0.25;
const REHOME_RING_POINTS = 16;
/**
 * How long after an accepted move a dreamer still counts as moving. Reports come ten times a
 * second, so a walking dreamer never falls outside it, and one who stopped does a quarter of a
 * second later.
 */
const MOVING_WINDOW_MS = 250;
/**
 * A nightmare walking home that has come no `HOME_PROGRESS_METRES` nearer for this long stops
 * steering and tries only the straight step home, as when a body lies on its home or bodies wall
 * it off. Its way home is then blocked: inside its area it rests where it stands once whole, and
 * outside it stops evading, and takes another home when a body is on its own.
 */
const HOME_PROGRESS_SECONDS = 1;
const HOME_PROGRESS_METRES = 0.01;
/**
 * A nightmare outside its area that has come no `HOME_PROGRESS_METRES` nearer for this long is walled
 * off from home, behind a wall it chased round, and leaves the space, freeing its spawn's slot.
 */
const STUCK_RETURN_SECONDS = 10;
/**
 * How far inside its stop distance a nightmare's step ends. A step ending exactly at reach can
 * land a rounding error outside it, and the strides left would then be too small to close it.
 */
const STOP_SLACK = 0.01;
/** The turns off the bearing to its goal, in degrees, that a nightmare tries on each side when the straight step is blocked. */
const STEER_DEGREES = [30, 60, 90];
/** The least time between two `vitals` frames about one entity to one dreamer. */
const VITALS_INTERVAL_MS = 250;
/**
 * How far a sum of step times may fall short of a figure and still reach it, since rounding lands it
 * just under: a Healer's seconds held against the next whole unit of spirit, and a raise's work
 * against the raise time.
 */
const SUM_SLACK_SECONDS = 1e-9;

export interface SpaceActorOptions {
  logger: Logger;
  /** The persisted 1-based dialog cursors of the space's sectors. */
  initialDialogStates?: readonly NPCDialogState[];
  random?: RandomSource;
  /** Picks the words a listener misses; separate from `random`, so speech never shifts the rolls of combat and placement. */
  speechRandom?: RandomSource;
  /** Rolls each dreamer's drops; separate from `random`, so a drop never shifts the rolls of combat and placement. */
  lootRandom?: RandomSource;
  /** Rolls whether a nightmare spawns an elite, and its trait; separate from `random`, so an elite never shifts the rolls of combat and placement. */
  eliteRandom?: RandomSource;
  /** Picks where each nightmare wanders and when; separate from `random`, so a wander never shifts the rolls of combat and placement. */
  wanderRandom?: RandomSource;
  /** Counts each dreamer's drops from nightmares across the world; one ledger serves every space of it. */
  personalDrops?: PersonalDrops;
  /**
   * Asks for a thrower's checkpoint to be saved outside the space, without the space awaiting it:
   * an item thrown to the ground cannot wait for the next periodic pass, since another dreamer's
   * own checkpoint could otherwise save it as theirs while the thrower's rows still hold it.
   */
  requestDropSave: (checkpoint: PlayerCheckpoint) => void;
  /** Monotonic milliseconds, for the movement allowance and the dialog and spawn deadlines. */
  now?: () => number;
  /** Epoch milliseconds, for the bounty board's day. */
  wallNow?: () => number;
  /** Hands out the id of each quest offer. The router passes one to every space, so no two offers in the world share an id. */
  newOfferId?: () => number;
}

/** Hands out ids from 1 up, each once. */
export function offerIds(): () => number {
  let last = 0;
  return () => (last += 1);
}

type NPCDialogAction = { kind: 'holdCooldown' } | { kind: 'resetTargeting' } | { kind: 'emit'; targetName: string };

/** The bases of what the dreamer's hands hold, which everyone who sees them is shown. */
function heldOf({ equipped: { mainHand, offHand } }: Inventory): Held {
  return { ...(mainHand === undefined ? {} : { mainHand: mainHand.baseId }), ...(offHand === undefined ? {} : { offHand: offHand.baseId }) };
}

/** What a drop's viewers are shown of it: an item's base and rarity, never its stat lines, or a trophy's kind. */
function lootContentsMessage(contents: LootContents): LootContentsMessage {
  switch (contents.kind) {
    case 'item':
      return { kind: 'item', baseId: contents.item.baseId, rarity: contents.item.rarity };
    case 'trophy':
      return contents;
  }
}

/** A drop as it is shown; `from` only as it is thrown, so the viewers who see it fall play its flight. */
function lootMessage({ lootId, ownerId, position, contents }: Loot, from?: ThrownFromMessage): SomnioMessage {
  return {
    tag: 'loot',
    payload: {
      lootId,
      x: position.x,
      z: position.z,
      contents: lootContentsMessage(contents),
      ...(ownerId === undefined ? { shared: true } : {}),
      ...(from === undefined ? {} : { from }),
    },
  };
}

/** The pools at new maxima, none above its maximum. */
function withinMaxima(energy: Energy, maxima: Pick<Energy, 'healthMax' | 'balanceMax' | 'spiritMax'>): Energy {
  return {
    healthCurrent: Math.min(energy.healthCurrent, maxima.healthMax),
    balanceCurrent: Math.min(energy.balanceCurrent, maxima.balanceMax),
    spiritCurrent: Math.min(energy.spiritCurrent, maxima.spiritMax),
    ...maxima,
  };
}

function lucidityMessage({ role, ranks, study }: Lucidity): LucidityMessage {
  return {
    ...(role === undefined ? {} : { role }),
    ranks: ranks.map(({ teachingId, rank, practice }) => ({ teachingId, rank, practice })),
    ...(study === undefined ? {} : { study }),
  };
}

function isFallen(slot: PlayerSlot): boolean {
  return slot.condition === 'fallen';
}

/** Whether nightmares leave the dreamer alone, whatever they hold against them: fallen, within the grace after a raise, or unseen. */
function leftAlone(slot: PlayerSlot, now: number): boolean {
  return isFallen(slot) || now < slot.graceUntil || unseen(slot);
}

const GAITS_FASTEST_FIRST: readonly Gait[] = ['run', 'jog', 'walk'];

/** How recovery reads the player: at the fastest gait still held, else standing, so a report at a slower gait cannot cut a faster one short. */
function motionOf(slot: PlayerSlot, now: number): Gait | 'standing' {
  return GAITS_FASTEST_FIRST.find((gait) => now < slot.movingUntil[gait]) ?? 'standing';
}

/** Whether an effect the dreamer holds hides them from nightmares. */
function unseen(slot: PlayerSlot): boolean {
  return slot.effects.some((held) => effect(held.effectId).unseen === true);
}

/** Whether an effect the nightmare holds keeps it where it stands. */
function rooted(monster: MonsterRuntime): boolean {
  return monster.effects.some((held) => effect(held.effectId).movement === 'rooted');
}

/** Whether the nightmare keeps to its area: a boss and its minions chase only inside their chamber, and never leave it. */
function confined(monster: MonsterRuntime): boolean {
  return monster.boss !== undefined || monster.summoner !== undefined;
}

/** Whether the nightmare evades everything a dreamer sends at it: on a return after giving up, until it is stalled outside its area. */
function evadesAll({ phase }: MonsterRuntime): boolean {
  return phase.at === 'return' && phase.evading;
}

/** Whether the dreamer senses the fallen in the space, a passive of the Mystic's. */
function sensesFallen(slot: PlayerSlot): boolean {
  return rankOf(slot.character.lucidity.ranks, 'sense-the-fallen') >= 1;
}

function idOf(entity: PlayerSlot | MonsterRuntime): string {
  return 'character' in entity ? entity.character.id : entity.id;
}

function effectIds(holder: PlayerSlot | MonsterRuntime): EffectId[] {
  return holder.effects.map((effect) => effect.effectId);
}

/** The seconds from `now` until the moment, none once it is past. */
function secondsLeft(until: number, now: number): number {
  return Math.max(0, (until - now) / 1000);
}

/** `amount` refilled for `seconds` at `perSecond` up to `cap`, never lowering an amount already past the cap. */
function refilled(amount: number, seconds: number, perSecond: number, cap: number): number {
  return Math.max(amount, Math.min(cap, amount + seconds * perSecond));
}

/**
 * An effect as its holder holds it from `now`. A heal over time it gives is next due in a second and
 * owes nothing, and a shield it is starts at its rank's size. `carried` overrides either: with how
 * they stood as the holder left their last space, or with a new shield's strength by its source's wards.
 */
function heldEffect(
  effectId: EffectId,
  endsAt: number,
  sourceId: string,
  rank: number,
  now: number,
  carried: Pick<PlayerTransient['effects'][number], 'shield' | 'heal'> = {},
): HeldEffect {
  const perSecond = effectHealthPerSecond(effectId, rank);
  const absorb = effectAbsorb(effectId, rank);
  return {
    effectId,
    endsAt,
    sourceId,
    rank,
    heal: perSecond > 0 ? { perSecond, nextAt: now + (carried.heal?.seconds ?? 1) * 1000, owed: carried.heal?.owed ?? 0 } : undefined,
    shield: absorb > 0 ? (carried.shield ?? absorb) : undefined,
  };
}

/** A boss's rank by its moves, an elite's by its trait, and none for any other nightmare. */
function nightmareRankOf({ boss, trait }: Pick<MonsterRuntime, 'boss' | 'trait'>): NightmareRank | undefined {
  return boss !== undefined ? 'boss' : trait !== undefined ? 'elite' : undefined;
}

/** The effect an elite's trait puts on it, held as long as it stands. */
function traitEffect(trait: EliteTraitId, monsterId: string, now: number): HeldEffect {
  return heldEffect(eliteTrait(trait).effectId, Number.POSITIVE_INFINITY, monsterId, 1, now);
}

/** Adds the threat a deed of `amount` raises against the nightmare to what it holds against the dreamer. */
function addThreat(monster: MonsterRuntime, dreamer: PlayerSlot, amount: number): void {
  const id = dreamer.character.id;
  monster.threat.set(id, (monster.threat.get(id) ?? 0) + threatRaised(amount, effectIds(dreamer)));
}

/**
 * How high a dreamer stands in a nightmare's mind: the one whose Challenge it holds above all, then
 * each on its table by the threat it holds against them. `undefined` for anyone else.
 */
function threatRank(monster: MonsterRuntime, dreamerId: string): number | undefined {
  const challenged = monster.effects.some((held) => held.sourceId === dreamerId && effect(held.effectId).turnsOnSource === true);
  return challenged ? Number.POSITIVE_INFINITY : monster.threat.get(dreamerId);
}

/**
 * Whether the nightmare notices the dreamer standing `away` from it: within its aggro radius or on
 * its table, wherever they stand, though a confined one notices only dreamers inside its area.
 */
function notices(monster: MonsterRuntime, dreamer: PlayerSlot, away: number): boolean {
  const near = away <= monster.kind.aggroRadius || threatRank(monster, dreamer.character.id) !== undefined;
  return near && (!confined(monster) || rectContains(monster.area, dreamer.character.position, EDGE_TOLERANCE));
}

/** A dreamer's or a nightmare's health and its maximum. */
function healthOf(entity: PlayerSlot | MonsterRuntime): [current: number, max: number] {
  return 'character' in entity ? [entity.character.energy.healthCurrent, entity.character.energy.healthMax] : [entity.health, entity.healthMax];
}

/**
 * One space's runtime: its player set, NPCs and monsters, and the broadcast stream that funnels
 * every peer-visible mutation through outboxes. A player is sent their own sector and its
 * neighbours, and the entities standing in them. Speech alone ignores sectors: each listener hears
 * a line by their distance from it. Every method is synchronous, so Node's
 * run-to-completion supplies the isolation the name implies; persistence is dispatched by the
 * router outside the space.
 */
export class SpaceActor {
  private readonly space: Space<Sector>;
  private readonly collision: SpaceCollision;
  private readonly playerModel: string;
  /** Per sector, the names of the sectors a player standing in it is sent: itself, then its neighbours. */
  private readonly interest = new Map<string, ReadonlySet<string>>();
  /** Per sector, the ids of its doors that open to the outdoors, which its `sector` frame names. */
  private readonly outdoorDoorIds = new Map<string, string[]>();
  private readonly players = new Map<string, PlayerSlot>();
  private readonly npcs = new Map<string, NPCRuntime>();
  /** The fixtures of the space's sectors, by carrier id. */
  private readonly fixtures = new Map<string, PlacedFixture>();
  /** The lands of the whole world, which every bounty board's bounties are set in. */
  private readonly bountyLands: BountyLand[];
  /** The board's day the space last reached, and the bounties the board offers on it. */
  private bountyDay: number | undefined;
  private bounties: Bounty[] = [];
  private readonly npcBodies: Body[];
  private readonly monsters = new Map<string, MonsterRuntime>();
  /** The bolts in flight, in the order they were sent. */
  private bolts: Bolt[] = [];
  /** The drops lying on the ground, by id. */
  private readonly loot = new Map<string, Loot>();
  private readonly spawnTimers: MonsterSpawnTimer[] = [];
  /** The entities that moved since the last flush, each with the sector it now stands in. */
  private readonly moved = new Map<string, { sector: string; move: EntityMove }>();
  private readonly doorways: Doorway[];
  private readonly random: RandomSource;
  private readonly speechRandom: RandomSource;
  private readonly lootRandom: RandomSource;
  private readonly eliteRandom: RandomSource;
  private readonly wanderRandom: RandomSource;
  private readonly personalDrops: PersonalDrops;
  private readonly requestDropSave: (checkpoint: PlayerCheckpoint) => void;
  private readonly now: () => number;
  private readonly wallNow: () => number;
  private readonly newOfferId: () => number;
  private nextMonsterNumber = 1;
  private nextLootNumber = 1;
  private nextTelegraphNumber = 1;
  private readonly logger: Logger;

  constructor(world: LoadedWorld, spaceId: string, options: SpaceActorOptions) {
    this.space = world.spaces.get(spaceId)!;
    this.collision = buildSpaceCollision(this.space, world.registry);
    this.playerModel = world.registry.playerModel;
    this.logger = options.logger;
    this.random = options.random ?? systemRandom;
    this.speechRandom = options.speechRandom ?? systemRandom;
    this.lootRandom = options.lootRandom ?? systemRandom;
    this.eliteRandom = options.eliteRandom ?? systemRandom;
    this.wanderRandom = options.wanderRandom ?? systemRandom;
    this.personalDrops = options.personalDrops ?? new PersonalDrops();
    this.requestDropSave = options.requestDropSave;
    this.now = options.now ?? (() => performance.now());
    this.wallNow = options.wallNow ?? (() => Date.now());
    this.newOfferId = options.newOfferId ?? offerIds();
    for (const sector of this.space.sectors) {
      this.interest.set(sector.name, new Set([sector.name, ...neighbourSectors(this.space, sector.name).map((neighbour) => neighbour.name)]));
      this.outdoorDoorIds.set(sector.name, outdoorDoorIds(sector, world.spaces.get(OUTDOOR_SPACE_ID)?.sectors ?? []));
      for (const definition of sector.monsterSpawns) {
        const firstFill = Math.min(monsterKind(definition.kind).respawnSeconds, FIRST_FILL_SECONDS);
        this.spawnTimers.push({ sector, definition, alive: 0, spawnAt: this.now() + firstFill * 1000 });
      }
      for (const npc of sector.npcs) {
        const id = npcEntityId(sector.name, npc.id);
        const steps = dialogSteps(npc.dialogScript);
        const persisted = options.initialDialogStates?.find((state) => state.sectorName === sector.name && state.npcId === npc.id);
        this.npcs.set(id, {
          id,
          sector: sector.name,
          definition: npc,
          position: sectorPointInSpace(sector, npc),
          targetingEntity: undefined,
          near: new Set(),
          greetedAt: new Map(),
          greetReadyAt: 0,
          dialogSteps: steps,
          readyAt: 0,
          scriptStepIndex: this.resolveSeedStepIndex(persisted?.scriptStep, steps.length, id),
        });
      }
      for (const fixture of placedFixtures(sector)) this.fixtures.set(fixture.id, fixture);
    }
    this.npcBodies = npcBodies(this.space);
    this.doorways = doorwaysOut(world, this.space);
    this.bountyLands = bountyLands([...world.spaces.values()].flatMap((space) => space.sectors));
  }

  /**
   * Translates a persisted 1-based `script_step` into the 0-based cursor. Out-of-range values
   * clamp to 0 with a warning so a shortened script is visible rather than silently rewound.
   */
  private resolveSeedStepIndex(persisted: number | undefined, stepCount: number, npcId: string): number {
    if (persisted === undefined) return 0;
    if (stepCount === 0) {
      if (persisted !== 1) {
        this.logger.warn({ npc: npcId, persisted_step: persisted }, 'npc dialog cursor reset (script empty)');
      }
      return 0;
    }
    if (persisted < 1 || persisted > stepCount) {
      this.logger.warn({ npc: npcId, persisted_step: persisted, step_count: stepCount }, 'npc dialog cursor clamped (out of range)');
      return 0;
    }
    return persisted - 1;
  }

  /**
   * Creates the player's slot, streams the join sequence to the newcomer's outbox with
   * `enterSpace` first, and broadcasts one `entity` for the newcomer to the players who can see
   * them. The player's entity id is the character's. Throws when no sector holds the position
   * or the join sequence cannot be encoded; a throw leaves no slot and no frame behind.
   *
   * The pools' maxima are what the character's role, ranks, and worn gear give, whatever the row
   * held. NPCs speak to the player in `locale`. The effects, cooldowns, and timers a transfer or a
   * reconnect carries run on from `transient`, and its allowance and pace credit refill by the time
   * away.
   * The player is sent their cooldowns, and their effects when they hold any. A bounty of another
   * board day goes from their log, and they are told right after their quests how many they held.
   */
  attach(
    character: Character,
    inventory: Inventory,
    outbox: ConnectionOutbox,
    worldSeconds: number,
    locale: Locale,
    transient: PlayerTransient = NO_TRANSIENT,
  ): void {
    const now = this.now();
    const sector = sectorAt(this.space, character.position);
    if (sector === undefined) throw new Error(`no sector of ${this.space.id} holds (${character.position.x}, ${character.position.z})`);
    this.reachBoardDay(boardDay(this.wallNow()));
    const energy = withinMaxima(character.energy, maxPools(statsOf(inventory.equipped, character.lucidity)));
    const { log: quests, ranOut } = withBoardDay(character.quests, this.bountyDay!);
    const slot: PlayerSlot = {
      character: { ...character, energy, quests },
      inventory,
      soldToShop: [],
      outbox,
      locale,
      gait: DEFAULT_GAIT,
      sector: sector.name,
      allowance: refilled(transient.allowance, transient.awaySeconds, ALLOWANCE_METRES_PER_SECOND, ALLOWANCE_CAP_METRES),
      allowanceAt: now,
      paceCredit: refilled(transient.paceCredit, transient.awaySeconds, PACE_CREDIT_SECONDS_PER_SECOND, PACE_CREDIT_CAP_SECONDS),
      paceCreditAt: now,
      movingUntil: { walk: Number.NEGATIVE_INFINITY, jog: Number.NEGATIVE_INFINITY, run: now + transient.runningSeconds * 1000 },
      leap: { metres: 0, metresPerSecond: gaitMetresPerSecond('run') },
      rejectionLog: new LogThrottle(REJECTED_MOVE_LOG_INTERVAL_MS),
      carry: { health: 0, balance: 0, spirit: 0 },
      winded: windedOnJoin(energy.balanceCurrent),
      swingReadyAt: now + transient.swingSeconds * 1000,
      mendReadyAt: now + transient.mendSeconds * 1000,
      graceUntil: 0,
      condition: conditionOf(energy.healthCurrent, energy.healthMax),
      held: heldOf(inventory),
      raise: undefined,
      questOffer: undefined,
      target: undefined,
      engaged: false,
      vitals: undefined,
      effects: transient.effects.map(({ effectId, seconds, sourceId, rank, ...carried }) =>
        heldEffect(effectId, now + seconds * 1000, sourceId, rank, now, carried),
      ),
      globalReadyAt: now + transient.globalSeconds * 1000,
      readyAt: Object.fromEntries(transient.cooldowns.map(({ abilityId, seconds }) => [abilityId, now + seconds * 1000])),
      channel: undefined,
    };
    const interest = this.interest.get(sector.name)!;
    const messages: SomnioMessage[] = [
      { tag: 'enterSpace', payload: { spaceId: this.space.id, selfId: character.id, people: character.people, worldSeconds } },
      ...[...interest].map((name) => this.sectorMessage(name)),
      { tag: 'entity', payload: this.playerEntity(slot) },
      { tag: 'inventory', payload: inventoryMessage(inventory) },
      { tag: 'energy', payload: energy },
      { tag: 'lucidity', payload: lucidityMessage(character.lucidity) },
      { tag: 'quests', payload: questsMessage(quests, this.bounties) },
      ...(ranOut > 0 ? [{ tag: 'bountiesRanOut' as const, payload: { count: ranOut } }] : []),
      { tag: 'cooldowns', payload: this.cooldownsLeft(slot) },
    ];
    if (slot.effects.length > 0) messages.push({ tag: 'effects', payload: this.effectsMessage(slot) });
    if (sensesFallen(slot)) messages.push(this.sensedMessage(slot));
    for (const other of this.entities()) {
      if (interest.has(other.sector)) messages.push({ tag: 'entity', payload: other.entity });
    }
    for (const other of this.players.values()) {
      if (other.raise !== undefined && interest.has(other.sector)) messages.push(this.raisingMessage(other, 'holding', other.raise.holders));
    }
    for (const monster of this.monsters.values()) {
      if (monster.boss?.wail !== undefined && interest.has(monster.sector)) messages.push(this.telegraphMessage(monster, monster.boss.wail));
    }
    for (const loot of this.loot.values()) {
      if (this.seesLoot(slot, loot)) messages.push(lootMessage(loot));
    }
    const frames = messages.map((message) => encodeSomnioMessage(message));
    for (const frame of frames) outbox.send(frame);

    this.players.set(character.id, slot);
    this.broadcast({ tag: 'entity', payload: this.playerEntity(slot) }, slot.sector, character.id);
    if (isFallen(slot)) this.fallenChanged(slot);
  }

  /**
   * Takes the player out of the space, `leftGame` `true` for a disconnect and `false` for a
   * transfer: a door, or waking. Hands back their checkpoint and what they carry on, as of now.
   * Their effects are settled before the checkpoint is read, so a heal tick that fell due as they
   * leave is in it, whoever then saves it or attaches it elsewhere.
   */
  handOver(entityId: string, leftGame: boolean): PlayerHandOver | undefined {
    const slot = this.players.get(entityId);
    if (slot === undefined) return undefined;
    const transient = this.detach(slot, leftGame);
    return { checkpoint: this.checkpointOf(slot, new Date()), transient };
  }

  private detach(slot: PlayerSlot, leftGame: boolean): PlayerTransient {
    const entityId = slot.character.id;
    this.settleEffects([slot]);
    this.breakChannelsOn(slot);
    this.breakChannel(slot);
    this.endOffer(slot, 'didNotTake');
    // A leaver's raises are charged and, once full, completed now, since no step charges one who is gone.
    for (const [target, raise] of [...this.raisesHeldBy(entityId)]) this.advanceRaise(target, raise);
    this.players.delete(entityId);
    this.moved.delete(entityId);
    for (const npc of this.npcs.values()) npc.greetedAt.delete(entityId);
    this.broadcast({ tag: 'leave', payload: { entityId, leftGame } }, slot.sector);
    // A Healer who leaves drops out at once, so one back under the same id before the next step holds on only once they take hold again.
    for (const [target, raise] of this.raisesHeldBy(entityId)) this.releaseRaise(target, raise);
    if (isFallen(slot)) this.fallenChanged();
    const now = this.now();
    this.refillAllowance(slot, now);
    this.refillPaceCredit(slot, now);
    return {
      effects: slot.effects.map(({ effectId, endsAt, sourceId, rank, shield, heal }) => ({
        effectId,
        seconds: secondsLeft(endsAt, now),
        sourceId,
        rank,
        ...(shield === undefined ? {} : { shield }),
        ...(heal === undefined ? {} : { heal: { seconds: secondsLeft(heal.nextAt, now), owed: heal.owed } }),
      })),
      ...this.cooldownsLeft(slot),
      swingSeconds: secondsLeft(slot.swingReadyAt, now),
      mendSeconds: secondsLeft(slot.mendReadyAt, now),
      runningSeconds: secondsLeft(slot.movingUntil.run, now),
      allowance: slot.allowance,
      paceCredit: slot.paceCredit,
      awaySeconds: 0,
    };
  }

  /** Whether a player can stand at the point: clear of the world and of every NPC. */
  canStand(point: Point): boolean {
    return canStand(this.collision, point, this.npcBodies);
  }

  /**
   * Accepts a move the player's allowance covers and the shared movement rule allows, and answers
   * any other with a `correction` to the last accepted position.
   *
   * A move the allowance covers spends its length whether or not its path is legal, so a refused
   * path costs what walking it would have. A move longer than the allowance is refused and spends
   * nothing. A client corrected after a stall past the cap still has reports under way. Those are
   * measured from the last accepted position, where their path can be illegal, so they are
   * charged too.
   *
   * Other players and monsters are deliberately not checked. The mover saw them where they were a
   * moment ago, so that comparison would only ever correct an honest client.
   *
   * Running drains balance by the distance run, at the gait `gaitAllowed` leaves the one reported.
   * A walk or a jog spends the pace credit, and the metres past it are charged as running
   * (`payPace`), so a client that runs while reporting a slower gait still pays for the run. A
   * winded dreamer's allowance is not shortened: their client holds the slow gait, and running at
   * empty buys nothing but staying empty, so a late `energy` frame never gets an honest player
   * corrected. Nor is a braced one's, so a client a frame late to apply Brace is not corrected either.
   * A fallen dreamer does not move. A move away from where the dreamer stands breaks their channel,
   * whether it is accepted or not; a turn on the spot leaves it be.
   */
  handleMove(message: MoveMessage, entityId: string): void {
    const slot = this.players.get(entityId);
    if (slot === undefined) return;
    if (isFallen(slot)) {
      this.snapBack(slot);
      return;
    }
    const now = this.now();
    this.refillAllowance(slot, now);
    const from = slot.character.position;
    const to = { x: message.x, z: message.z };
    const length = distance(from, to);
    if (length > 0) this.breakChannel(slot);
    if (length > slot.allowance) {
      this.rejectMove(slot, to, now);
      return;
    }
    slot.allowance -= length;
    if (!isLegalMove(this.collision, from, to, SOMNIO_CONSTANTS.playerRadius, this.npcBodies)) {
      this.rejectMove(slot, to, now);
      return;
    }
    // Wrapped into `[0, 360)` once, so storage and the broadcast carry the same normalized value.
    const facing = heading(message.facing);
    slot.character = { ...slot.character, position: to, facing };
    slot.gait = gaitAllowed(message.gait, effectIds(slot));
    const previous = slot.sector;
    const sector = sectorAt(this.space, to)!;
    slot.sector = sector.name;
    this.moved.set(entityId, { sector: slot.sector, move: { id: entityId, x: to.x, z: to.z, facing, gait: slot.gait } });
    if (slot.sector !== previous) this.playerChangedSector(slot, previous);
    this.advanceQuests(slot, (objective, progress) => (reachedAt(objective, sector, to) ? 1 : progress));
    // A turn on the spot is reported as a move too, and must not count as moving.
    if (length === 0) return;
    this.holdMotion(slot, length, now);
    if (slot.gait === 'run') this.drainRun(slot, length);
    else this.payPace(slot, length, now);
  }

  /**
   * Holds recovery at the move's gait for as long as its metres take at that gait, counted on from
   * what the gait already holds, and for at least `MOVING_WINDOW_MS`. A leap's metres take the leap's time.
   */
  private holdMotion(slot: PlayerSlot, length: number, now: number): void {
    const leapt = Math.min(length, slot.leap.metres);
    slot.leap.metres -= leapt;
    const seconds = leapt / slot.leap.metresPerSecond + (length - leapt) / gaitMetresPerSecond(slot.gait);
    const held = slot.movingUntil[slot.gait];
    slot.movingUntil[slot.gait] = Math.max(Math.max(held, now) + seconds * 1000, now + MOVING_WINDOW_MS);
  }

  private refillAllowance(slot: PlayerSlot, now: number): void {
    slot.allowance = refilled(slot.allowance, (now - slot.allowanceAt) / 1000, ALLOWANCE_METRES_PER_SECOND, ALLOWANCE_CAP_METRES);
    slot.allowanceAt = now;
  }

  private refillPaceCredit(slot: PlayerSlot, now: number): void {
    slot.paceCredit = refilled(slot.paceCredit, (now - slot.paceCreditAt) / 1000, PACE_CREDIT_SECONDS_PER_SECOND, PACE_CREDIT_CAP_SECONDS);
    slot.paceCreditAt = now;
  }

  /**
   * Spends the seconds a walked or jogged move takes at its gait from the pace credit. The metres
   * past what the credit covers were run, so they drain balance as running does and hold recovery
   * at the running pace for at least `MOVING_WINDOW_MS`, whatever gait the next moves report.
   */
  private payPace(slot: PlayerSlot, length: number, now: number): void {
    const metresPerSecond = gaitMetresPerSecond(slot.gait);
    this.refillPaceCredit(slot, now);
    const cost = length / metresPerSecond;
    if (cost - slot.paceCredit <= PACE_CREDIT_TOLERANCE_SECONDS) {
      slot.paceCredit = Math.max(0, slot.paceCredit - cost);
      return;
    }
    const excess = (cost - slot.paceCredit) * metresPerSecond;
    slot.paceCredit = 0;
    slot.movingUntil.run = Math.max(slot.movingUntil.run, now + MOVING_WINDOW_MS);
    this.drainRun(slot, excess);
  }

  private drainRun(slot: PlayerSlot, metres: number): void {
    this.drainBalance(slot, metres * (COMBAT.runDrainPerSecond / gaitMetresPerSecond('run')));
  }

  private rejectMove(slot: PlayerSlot, to: Point, now: number): void {
    this.snapBack(slot);
    const suppressed = slot.rejectionLog.take(now);
    if (suppressed === undefined) return;
    const from = slot.character.position;
    this.logger.warn({ entity_id: slot.character.id, from: `${from.x},${from.z}`, to: `${to.x},${to.z}`, suppressed_since_last: suppressed }, 'move rejected');
  }

  private snapBack(slot: PlayerSlot): void {
    slot.outbox.sendEncoded({ tag: 'correction', payload: { x: slot.character.position.x, z: slot.character.position.z } }, this.logger);
  }

  /** The player crossed into another sector: they are sent what entered their view, and everyone is told what they now see of each other. */
  private playerChangedSector(slot: PlayerSlot, from: string): void {
    const previous = this.interest.get(from)!;
    const current = this.interest.get(slot.sector)!;
    for (const name of current) {
      if (!previous.has(name)) slot.outbox.sendEncoded(this.sectorMessage(name), this.logger);
    }
    for (const other of this.entities(slot.character.id)) {
      if (current.has(other.sector) && !previous.has(other.sector)) {
        slot.outbox.sendEncoded({ tag: 'entity', payload: other.entity }, this.logger);
      } else if (previous.has(other.sector) && !current.has(other.sector)) {
        slot.outbox.sendEncoded({ tag: 'leave', payload: { entityId: other.entity.id, leftGame: false } }, this.logger);
      }
    }
    for (const [id, other] of this.players) {
      if (id === slot.character.id || other.raise === undefined || !current.has(other.sector) || previous.has(other.sector)) continue;
      slot.outbox.sendEncoded(this.raisingMessage(other, 'holding', other.raise.holders), this.logger);
    }
    for (const monster of this.monsters.values()) {
      const wail = monster.boss?.wail;
      if (wail !== undefined && current.has(monster.sector) && !previous.has(monster.sector))
        slot.outbox.sendEncoded(this.telegraphMessage(monster, wail), this.logger);
    }
    for (const loot of this.loot.values()) {
      if (loot.ownerId !== undefined) continue;
      if (current.has(loot.sector) && !previous.has(loot.sector)) slot.outbox.sendEncoded(lootMessage(loot), this.logger);
      else if (previous.has(loot.sector) && !current.has(loot.sector))
        slot.outbox.sendEncoded({ tag: 'lootGone', payload: { lootId: loot.lootId } }, this.logger);
    }
    this.entityChangedSector(this.playerEntity(slot), from, slot.sector);
  }

  /** Tells every player whose view of the entity changed with its sector, including players standing still. */
  private entityChangedSector(entity: EntityMessage, from: string, to: string): void {
    for (const [id, viewer] of this.players) {
      if (id === entity.id) continue;
      const before = this.sees(viewer, from);
      const after = this.sees(viewer, to);
      if (after && !before) viewer.outbox.sendEncoded({ tag: 'entity', payload: entity }, this.logger);
      else if (before && !after) viewer.outbox.sendEncoded({ tag: 'leave', payload: { entityId: entity.id, leftGame: false } }, this.logger);
    }
  }

  /**
   * Says a line to everyone in the space within its reach, each hearing it as their distance from
   * the speaker allows; the speaker's own client renders its own bubble. A fallen dreamer speaks
   * too, which is how they call for help. A yell also goes to each door near enough that it is still
   * heard beyond it, and what comes back is for the router to carry through them.
   */
  handleSay(message: ClientSayMessage, entityId: string): YellThroughDoors | undefined {
    const slot = this.players.get(entityId);
    if (slot === undefined) return undefined;
    const { name, position } = slot.character;
    const utterance: Utterance = { voice: { entityId, name, kind: message.kind, line: { words: message.text } }, rolls: [] };
    this.speak(utterance, position, entityId);
    if (message.kind !== 'yell') return undefined;
    const voices = this.doorways.flatMap((doorway) => {
      const baseMetres = distance(position, doorway.near) + SPEECH.doorMuffleMetres;
      return baseMetres < SPEECH.yell.reachMetres ? [{ spaceId: doorway.spaceId, source: doorway.far, baseMetres }] : [];
    });
    return voices.length === 0 ? undefined : { utterance, voices };
  }

  /**
   * A yell from another space, coming out of this one's doors. Each listener hears it by the
   * shortest way, from that way's doorway. It is not relayed again.
   */
  hearThroughDoors(utterance: Utterance, voices: readonly DoorVoice[]): void {
    for (const listener of this.players.values()) {
      const position = listener.character.position;
      const ways = voices.map((door) => ({ source: door.source, metres: door.baseMetres + distance(position, door.source) }));
      const shortest = ways.reduce((best, way) => (way.metres < best.metres ? way : best));
      this.sayTo(listener, utterance, shortest.source, shortest.metres);
    }
  }

  /** Says a line from `source` to every player but `excluding`, each at their distance. Sector interest plays no part. */
  private speak(utterance: Utterance, source: Point, excluding?: string): void {
    for (const [id, listener] of this.players) {
      if (id !== excluding) this.sayTo(listener, utterance, source, distance(listener.character.position, source));
    }
  }

  /** The line as one listener `metres` along its way hears it, in their language; nothing past its reach. */
  private sayTo(listener: PlayerSlot, { voice, rolls }: Utterance, source: Point, metres: number): void {
    const clarity = speechClarity(voice.kind, metres);
    if (clarity === undefined) return;
    const { line } = voice;
    const said = 'words' in line ? line.words : localizedDialogLine(line.step, listener.locale, line.targetName);
    let next = 0;
    const text = crumble(said, clarity, () => {
      if (next === rolls.length) rolls.push(randomUnit(this.speechRandom));
      return rolls[next++]!;
    });
    listener.outbox.sendEncoded(
      {
        tag: 'serverSay',
        payload: { entityId: voice.entityId, name: voice.name, kind: voice.kind, text, clarity, x: source.x, z: source.z },
      },
      this.logger,
    );
  }

  /**
   * Wears an item the dreamer has in a slot its base fits, as `equipItem` chooses it: from the bag,
   * whatever that slot wore takes the item's place there, and a worn ring changes ring slots. The
   * inventory goes back to the player alone; everyone who sees them is shown only what their hands
   * now hold.
   */
  handleEquip(itemId: string, slot: EquipSlot | undefined, entityId: string): void {
    const player = this.players.get(entityId);
    this.changeInventory(player, player === undefined ? undefined : equipItem(player.inventory, itemId, slot));
  }

  /** Puts what the slot wears into the dreamer's bag, which a full bag refuses. */
  handleUnequip(slot: EquipSlot, entityId: string): void {
    const player = this.players.get(entityId);
    this.changeInventory(player, player === undefined ? undefined : unequipItem(player.inventory, slot));
  }

  /** Moves an item the dreamer has to a place in their bag, as `moveItem` rules it. */
  handleMoveItem(itemId: string, place: number, entityId: string): void {
    const player = this.players.get(entityId);
    this.changeInventory(player, player === undefined ? undefined : moveItem(player.inventory, itemId, place));
  }

  /**
   * Throws an item the dreamer carries or wears to the ground along `heading`, whole, for anyone to
   * pick up, where `throwLanding` lands it. A worn item leaves its slot as it goes, so it needs no
   * room in the bag. The thrown `loot` goes out before the `held` that empties the hand, so viewers
   * see the item leave the hand as the throw lets go. The checkpoint goes to `requestDropSave` at
   * once, so the item leaves the thrower's rows ahead of the next periodic pass.
   */
  handleDropItem(itemId: string, heading: number, entityId: string): void {
    const player = this.players.get(entityId);
    const item = player === undefined ? undefined : droppableItem(player.inventory, itemId);
    if (player === undefined || item === undefined || isFallen(player)) return;
    const hand = HANDS.find((worn) => player.inventory.equipped[worn]?.id === item.id);
    player.inventory = withoutItem(player.inventory, item.id);
    const { baseId, tier, rarity, affixes } = item;
    const contents: LootContents = { kind: 'item', item: { baseId, tier, rarity, affixes } };
    const from = player.character.position;
    const landing = throwLanding(this.collision, from, heading, THROW_DISTANCE, this.npcBodies);
    this.layLoot(undefined, landing, contents, { x: from.x, z: from.z, entityId, ...(hand === undefined ? {} : { hand }) });
    this.sendInventory(player, { dropped: lootContentsMessage(contents) });
    this.requestDropSave(this.checkpointOf(player, new Date()));
  }

  /**
   * Picks up a drop, from within pickup reach: one of their own, or an item a dreamer dropped, which
   * the first to ask takes. A fallen dreamer picks up nothing, and a full bag leaves an item where it
   * lies. An item comes into the bag under a new id, since a thrown item's old one may still stand in
   * the thrower's rows until their drop save lands. A trophy never enters the bag, and counts toward
   * each quest collecting it once the inventory has gone back to the dreamer saying what was picked
   * up.
   */
  handlePickUp(lootId: string, entityId: string): void {
    const player = this.players.get(entityId);
    const loot = this.loot.get(lootId);
    if (player === undefined || loot === undefined || isFallen(player)) return;
    if ((loot.ownerId ?? entityId) !== entityId || !withinPickupReach(player.character.position, loot.position)) return;
    const contents = loot.contents;
    if (contents.kind === 'item' && !bagHasRoom(player.inventory)) return;
    this.removeLoot(loot, true);
    if (loot.ownerId !== undefined) this.personalDrops.pickedUp(loot.ownerId, this, lootId);
    if (contents.kind === 'item') player.inventory = withItem(player.inventory, { id: newItemId(), ...contents.item });
    this.sendInventory(player, { pickedUp: lootContentsMessage(contents) });
    if (contents.kind === 'trophy') {
      this.advanceQuests(player, (objective, progress) =>
        objective.kind === 'collect' && objective.monsterKind === contents.monsterKind ? progress + 1 : progress,
      );
    }
  }

  /**
   * The drops the dreamers sharing a nightmare find where it was driven off, each sent to its owner
   * alone, scattered from where it stood and fanned round it, so several drops lie apart (`scatterLandings`).
   */
  private scatter(position: Point, drops: readonly { owner: PlayerSlot; contents: LootContents }[]): void {
    const landings = scatterLandings(this.collision, position, drops.length, this.npcBodies, () => randomUnit(this.lootRandom));
    drops.forEach(({ owner, contents }, index) => this.layLoot(owner.character.id, landings[index]!, contents, { x: position.x, z: position.z }));
  }

  /**
   * Lays a drop on the ground for `ownerId` alone, counted among their drops across the world, or
   * for anyone without one, for `SHARED_LOOT_SECONDS`, the space's oldest such drop going past
   * `MAX_SHARED_DROPS`. Shows it to whoever sees it, as thrown from `from`.
   */
  private layLoot(ownerId: string | undefined, position: Point, contents: LootContents, from: ThrownFromMessage): void {
    const loot: Loot = {
      lootId: `loot-${this.nextLootNumber++}`,
      ownerId,
      position: { x: position.x, z: position.z },
      sector: sectorAt(this.space, position)!.name,
      contents,
      expiresAt: ownerId === undefined ? this.now() + SHARED_LOOT_SECONDS * 1000 : undefined,
    };
    this.loot.set(loot.lootId, loot);
    this.sendToLootViewers(loot, lootMessage(loot, from));
    if (ownerId !== undefined) this.personalDrops.laid(ownerId, this, loot.lootId);
    else this.capSharedLoot();
  }

  /** Takes the oldest items dreamers dropped away while more than `MAX_SHARED_DROPS` lie in the space; the drops lie in the order they fell. */
  private capSharedLoot(): void {
    const shared = [...this.loot.values()].filter((loot) => loot.ownerId === undefined);
    for (const loot of shared.slice(0, Math.max(0, shared.length - MAX_SHARED_DROPS))) this.removeLoot(loot);
  }

  /** Takes the items dreamers dropped that have lain on the ground too long away. */
  private expireLoot(): void {
    const now = this.now();
    for (const loot of this.loot.values()) {
      if (loot.expiresAt !== undefined && now >= loot.expiresAt) this.removeLoot(loot);
    }
  }

  /** Ends every quest offer left unanswered past its time. */
  private expireOffers(): void {
    const now = this.now();
    for (const slot of this.players.values()) {
      if (slot.questOffer !== undefined && now >= slot.questOffer.endsAt) this.endOffer(slot, 'didNotTake');
    }
  }

  /** Takes a drop from a nightmare away as the world's ledger lets it go, telling its owner if they are here. */
  letGoDrop(lootId: string): void {
    const loot = this.loot.get(lootId);
    if (loot !== undefined) this.removeLoot(loot);
  }

  /** The drop is gone from the ground, and everyone it was shown to is told so, `taken` when a dreamer picked it up. */
  private removeLoot(loot: Loot, taken = false): void {
    this.loot.delete(loot.lootId);
    this.sendToLootViewers(loot, { tag: 'lootGone', payload: { lootId: loot.lootId, ...(taken ? { taken } : {}) } });
  }

  /** Whether the dreamer is shown the drop: their own wherever it lies, and one for anyone while they see its sector. */
  private seesLoot(viewer: PlayerSlot, loot: Loot): boolean {
    return loot.ownerId === undefined ? this.sees(viewer, loot.sector) : loot.ownerId === viewer.character.id;
  }

  /** Encode once and send to everyone shown the drop. */
  private sendToLootViewers(loot: Loot, message: SomnioMessage): void {
    const frame = encodeOrWarn(message, this.logger);
    if (frame === undefined) return;
    for (const viewer of this.players.values()) {
      if (this.seesLoot(viewer, loot)) viewer.outbox.send(frame);
    }
  }

  /**
   * Acting on a carrier counts as a visit to it. An NPC is asked to go on, and says the lines after
   * its greeting to the dreamer who asked. One with nothing beyond its greeting has nothing to go on
   * with. Its targeting flips once: a second ask while it is already targeting is a no-op, so it is
   * not retargeted mid-script. A fixture is only used, and its panel opens on the client. An ask
   * from outside speaking distance or from a fallen dreamer is dropped, so it cannot force per-call
   * writes through the step's reset path.
   */
  handleInteract(carrierId: string, entityId: string): void {
    const player = this.carrierNear(carrierId, entityId);
    if (player === undefined) return;
    this.visit(player, carrierId);
    const npc = this.npcs.get(carrierId);
    if (npc !== undefined && npc.targetingEntity === undefined && npc.dialogSteps.length >= 2) npc.targetingEntity = entityId;
  }

  /**
   * Chooses the entity a dreamer acts on, themselves included, or none. Choosing does nothing to
   * the entity. One out of their view is refused, and the refusal switches slot 1 off.
   */
  handleTarget(targetId: string | undefined, entityId: string): void {
    const player = this.players.get(entityId);
    if (player === undefined) return;
    if (targetId !== undefined && !this.seesEntity(player, targetId)) {
      player.engaged = false;
      return;
    }
    const previous = player.target;
    player.target = targetId;
    // Slot 1 stays on at a new target it can act on and goes off at anything else, as it does on the client.
    player.engaged &&= this.engagedAction(player) !== undefined;
    this.sendVitals(player);
    if (targetId === previous) return;
    this.sendTargetEffects(player);
    this.sendTargetChannel(player);
  }

  /**
   * Switches slot 1 on or off. Off is always taken. On is taken only from a standing dreamer whose
   * target slot 1 can act on at that moment (`engageAction`). A refusal is dropped silently.
   */
  handleEngage(on: boolean, entityId: string): void {
    const player = this.players.get(entityId);
    if (player === undefined) return;
    player.engaged = on && !isFallen(player) && this.engagedAction(player) !== undefined;
  }

  /**
   * Uses an ability on the belt where `abilityAllowed` lands it, by the dreamer's one target. Its
   * cost is spent, its own cooldown and the global one start, everyone who sees the dreamer is shown
   * it, and it does its deed, a channelled one only once its channel lands (`runChannels`). Slot 1 is
   * left as it was. A refusal is dropped silently. What a nightmare evades of it, harm or an effect,
   * is shown so (`evadesUse`). It is judged here, where the dreamer stands as they use it, so the
   * bolt or flick their client draws already knows it will miss.
   */
  handleUseAbility(abilityId: string, entityId: string): void {
    const player = this.players.get(entityId);
    if (player === undefined || !isAbilityId(abilityId)) return;
    const now = this.now();
    const lucidity = player.character.lucidity;
    const state = {
      caster: this.abilityBody(player, entityId)!,
      ranks: lucidity.ranks,
      hands: player.inventory.equipped,
      energy: player.character.energy,
      now,
      globalReadyAt: player.globalReadyAt,
      readyAt: player.readyAt,
      channelling: player.channel !== undefined,
    };
    const recipient = abilityAllowed(state, abilityId, this.abilityBody(player, player.target));
    if (recipient === undefined) return;
    const used = ability(abilityId);
    const rank = abilityRank(lucidity.ranks, abilityId);
    const energy = player.character.energy;
    const pool = POOL_FIELDS[used.pool].current;
    this.setEnergy(player, { ...energy, [pool]: energy[pool] - used.cost });
    player.globalReadyAt = now + GLOBAL_COOLDOWN_SECONDS * 1000;
    player.readyAt = { ...player.readyAt, [abilityId]: now + abilityCooldownSeconds(abilityId, rank) * 1000 };
    // The client reports a leap's moves at the gait it holds, toward where it draws the target.
    // So the way to the target at a walk goes into the pace credit, past its cap by one leap at most
    // however often Lunge is used, and recovery is held for the leap's time, not the reported gait's.
    if (used.does.kind === 'leap') {
      const metres = distance(player.character.position, recipient);
      this.refillPaceCredit(player, now);
      player.paceCredit = Math.min(player.paceCredit, PACE_CREDIT_CAP_SECONDS) + metres / gaitMetresPerSecond('walk');
      player.leap = { metres, metresPerSecond: used.does.metresPerSecond };
    }
    const channelSeconds = abilityChannelSeconds(abilityId, rank);
    const monster = this.monsters.get(recipient.id);
    const evaded = monster !== undefined && this.evadesUse(monster, used.does, player);
    if (channelSeconds !== undefined) {
      this.accrueRaisesHeldBy(player);
      player.channel = { abilityId, recipientId: recipient.id, rank, endsAt: now + channelSeconds * 1000 };
      this.broadcastChannel(player, 'start');
      this.broadcastRaisesHeldBy(player);
    } else {
      this.broadcast(
        { tag: 'ability', payload: { entityId, abilityId, ...(recipient.id === entityId ? {} : { targetId: recipient.id }), ...(evaded ? { evaded } : {}) } },
        player.sector,
      );
    }
    player.outbox.sendEncoded({ tag: 'cooldowns', payload: this.cooldownsLeft(player) }, this.logger);
    if (channelSeconds === undefined) this.deed(player, used, rank, used.aim === 'area' ? this.bodiesRound(player, used) : [recipient], evaded);
  }

  /**
   * The channel of the dreamer as it stands, at `phase`: with the seconds it has left on `start` and
   * on `channel`.
   */
  private channelMessage(caster: PlayerSlot, channel: Channel, phase: AbilityPhase): SomnioMessage {
    const entityId = caster.character.id;
    const timed = phase === 'start' || phase === 'channel';
    return {
      tag: 'ability',
      payload: {
        entityId,
        abilityId: channel.abilityId,
        ...(channel.recipientId === entityId ? {} : { targetId: channel.recipientId }),
        phase,
        ...(timed ? { seconds: secondsLeft(channel.endsAt, this.now()) } : {}),
      },
    };
  }

  /** Shows everyone who sees the dreamer their channel at `phase`. */
  private broadcastChannel(caster: PlayerSlot, phase: AbilityPhase): void {
    this.broadcast(this.channelMessage(caster, caster.channel!, phase), caster.sector);
  }

  /** Sends the dreamer the channel of the target they just chose, with the seconds it has left. They know their own. */
  private sendTargetChannel(slot: PlayerSlot): void {
    const target = slot.target === undefined || slot.target === slot.character.id ? undefined : this.players.get(slot.target);
    if (target?.channel === undefined) return;
    slot.outbox.sendEncoded(this.channelMessage(target, target.channel, 'channel'), this.logger);
  }

  /** Breaks off the dreamer's channel, if one is under way: it lands nothing, and everyone who sees them is shown so. */
  private breakChannel(caster: PlayerSlot): void {
    if (caster.channel === undefined) return;
    this.accrueRaisesHeldBy(caster);
    this.broadcastChannel(caster, 'broken');
    caster.channel = undefined;
    this.broadcastRaisesHeldBy(caster);
  }

  /** Breaks off every channel that would land on the dreamer, who falls or leaves. */
  private breakChannelsOn(recipient: PlayerSlot): void {
    for (const caster of this.players.values()) {
      if (caster.channel?.recipientId === recipient.character.id) this.breakChannel(caster);
    }
  }

  /**
   * Lands every channel whose time is up on its recipient, who stands in the caster's view. Its
   * deed is done after everyone who sees the caster is shown it landed.
   */
  private runChannels(): void {
    const now = this.now();
    for (const caster of this.players.values()) {
      const channel = caster.channel;
      if (channel === undefined || now < channel.endsAt) continue;
      const recipient = this.abilityBody(caster, channel.recipientId);
      if (recipient === undefined || recipient.fallen) {
        this.breakChannel(caster);
        continue;
      }
      this.broadcastChannel(caster, 'done');
      caster.channel = undefined;
      this.broadcastRaisesHeldBy(caster);
      this.deed(caster, ability(channel.abilityId), channel.rank, [recipient]);
    }
  }

  /**
   * Lands each bolt that has arrived on its nightmare through `harmNightmare`. One whose nightmare was
   * driven off, is gone, or walks home evading, or whose caster has left the space, lands nothing. A
   * caster who fell meanwhile still lands theirs, since it was already flying, and the nightmare
   * forgets them at its next step as it forgets every fallen dreamer.
   */
  private runBolts(): void {
    const now = this.now();
    const arrived = this.bolts.filter((bolt) => bolt.landsAt <= now);
    this.bolts = this.bolts.filter((bolt) => bolt.landsAt > now);
    for (const { caster, monster, damage } of arrived) {
      const lands =
        this.players.get(caster.character.id) === caster &&
        this.monsters.get(monster.id) === monster &&
        monster.lyingUntil === undefined &&
        !evadesAll(monster);
      if (lands) this.harmNightmare(monster, damage, caster);
    }
  }

  /**
   * An entity as an ability's rules see it, its kind being what it is to slot 1 too; `undefined`
   * for none, or for one the viewer does not see.
   */
  private abilityBody(viewer: PlayerSlot, entityId: string | undefined): (AbilityBody & { id: string }) | undefined {
    if (entityId === undefined || !this.seesEntity(viewer, entityId)) return undefined;
    const player = this.players.get(entityId);
    if (player !== undefined) {
      return { id: entityId, ...player.character.position, radius: SOMNIO_CONSTANTS.playerRadius, kind: 'dreamer', fallen: isFallen(player) };
    }
    const monster = this.monsters.get(entityId);
    if (monster !== undefined) {
      return {
        id: entityId,
        ...monster.position,
        radius: monster.kind.radius,
        kind: monster.lyingUntil === undefined ? 'nightmare' : undefined,
        fallen: false,
      };
    }
    return { id: entityId, ...this.npcs.get(entityId)!.position, radius: SOMNIO_CONSTANTS.npcRadius, kind: undefined, fallen: false };
  }

  /** The bodies an area ability of the dreamer's lands on round them, of those they see. */
  private bodiesRound(caster: PlayerSlot, ability: Ability): (AbilityBody & { id: string })[] {
    const bodies = [...this.players.keys(), ...this.monsters.keys()].flatMap((id) => this.abilityBody(caster, id) ?? []);
    return areaRecipients(ability, caster.character.position, bodies);
  }

  /**
   * What the ability does to the bodies it lands on. A strike swings at each nightmare among them a
   * swing meets, for its share of the caster's swing. Harm flies at each nightmare among them as a
   * bolt and lands as it arrives, unless `evaded`. An effect goes on each of them, and on a nightmare
   * it also puts the caster on its table, so it turns on them unless it holds more against another.
   * A nightmare that evades everything (`evadesAll`) takes no effect and no threat.
   * A restore gives each standing dreamer back some of a pool, and a heal gives each one health. A
   * calm cuts the caster's threat on every table and puts its effect on them. A leap does nothing
   * here: the caster's client moves them, and each move is judged as every move is, against the
   * pace credit the use granted.
   */
  private deed(caster: PlayerSlot, ability: Ability, rank: number, bodies: readonly (AbilityBody & { id: string })[], evaded = false): void {
    const does = ability.does;
    switch (does.kind) {
      case 'strike': {
        const { position, facing } = caster.character;
        const damage = swingFor(caster.inventory.equipped.mainHand, this.statsFor(caster))!.damage * scaled(does.damageShare, rank);
        for (const body of bodies) {
          const monster = this.monsters.get(body.id);
          if (monster !== undefined && swingMeets(position, facing, body)) this.blow(caster, monster, damage);
        }
        return;
      }
      case 'harm': {
        const damage = scaled(does.damage, rank);
        const now = this.now();
        for (const body of bodies) {
          const monster = this.monsters.get(body.id);
          const landsAt = now + boltFlightSeconds(distance(caster.character.position, body)) * 1000;
          if (monster !== undefined && !evaded) this.bolts.push({ caster, monster, damage, landsAt });
        }
        return;
      }
      case 'effect':
        for (const body of bodies) {
          const monster = this.monsters.get(body.id);
          if (monster !== undefined) {
            if (evadesAll(monster)) continue;
            addThreat(monster, caster, 0);
          }
          this.applyEffect(this.players.get(body.id) ?? monster!, does.effectId, rank, caster);
        }
        return;
      case 'leap':
        return;
      case 'restore': {
        const { current, max } = POOL_FIELDS[does.pool];
        const amount = wholeAmount(scaled(does.amount, rank));
        for (const body of bodies) {
          const dreamer = this.players.get(body.id);
          if (dreamer === undefined) continue;
          const energy = dreamer.character.energy;
          this.setEnergy(dreamer, { ...energy, [current]: Math.min(energy[max], energy[current] + amount) });
        }
        return;
      }
      case 'heal': {
        const amount = scaled(does.amount, rank);
        for (const body of bodies) {
          const dreamer = this.players.get(body.id);
          if (dreamer !== undefined) this.heal(caster.character.id, dreamer, amount);
        }
        return;
      }
      case 'calm': {
        const id = caster.character.id;
        for (const monster of this.monsters.values()) {
          const held = monster.threat.get(id);
          if (held !== undefined) monster.threat.set(id, held * does.threatKept);
        }
        this.applyEffect(caster, does.effectId, rank, caster);
        return;
      }
    }
  }

  /**
   * Puts the effect on its holder for its seconds at the rank given, or starts those seconds over on
   * a holder who has it. A shield is as strong as its source's stats make their wards.
   */
  private applyEffect(holder: PlayerSlot | MonsterRuntime, effectId: EffectId, rank: number, source: PlayerSlot): void {
    const now = this.now();
    const shield = effectAbsorb(effectId, rank) * wardShare(this.statsFor(source));
    const held = heldEffect(effectId, now + effectSeconds(effectId, rank) * 1000, source.character.id, rank, now, { shield });
    holder.effects = [...holder.effects.filter((other) => other.effectId !== effectId), held];
    this.sendEffects(holder);
  }

  /** Drops the holder's effects that `ends` picks, telling whoever is shown them when any went. */
  private endEffects(holder: PlayerSlot | MonsterRuntime, ends: (held: HeldEffect) => boolean): void {
    const kept = holder.effects.filter((held) => !ends(held));
    if (kept.length === holder.effects.length) return;
    holder.effects = kept;
    this.sendEffects(holder);
  }

  /**
   * Gives each heal over time's holder among `holders` the seconds of health due by now, its last at
   * its end, then ends every effect of theirs whose time is up.
   */
  private settleEffects(holders: readonly (PlayerSlot | MonsterRuntime)[]): void {
    const now = this.now();
    for (const holder of holders) {
      if (!('character' in holder)) continue;
      for (const held of holder.effects) {
        const heal = held.heal;
        if (heal === undefined) continue;
        while (heal.nextAt <= Math.min(now, held.endsAt)) {
          heal.nextAt += 1000;
          heal.owed += heal.perSecond;
          const whole = Math.floor(heal.owed);
          heal.owed -= whole;
          this.heal(held.sourceId, holder, whole);
        }
      }
    }
    for (const holder of holders) this.endEffects(holder, (held) => held.endsAt <= now);
  }

  /**
   * Puts each elite's renewing trait back on it whole, `renewSeconds` after the step that finds its
   * effect gone, as a spent shield grows back.
   */
  private renewTraits(): void {
    const now = this.now();
    for (const monster of this.monsters.values()) {
      const { trait } = monster;
      if (monster.lyingUntil !== undefined || trait === undefined) continue;
      const { effectId, renewSeconds } = eliteTrait(trait);
      if (renewSeconds === undefined || monster.effects.some((held) => held.effectId === effectId)) continue;
      if (monster.traitRenewsAt === undefined) {
        monster.traitRenewsAt = now + renewSeconds * 1000;
      } else if (now >= monster.traitRenewsAt) {
        monster.traitRenewsAt = undefined;
        monster.effects = [...monster.effects, traitEffect(trait, monster.id, now)];
        this.sendEffects(monster);
      }
    }
  }

  /** The effects the holder holds now, as the holder and each dreamer whose target it is are shown them. */
  private effectsMessage(holder: PlayerSlot | MonsterRuntime): EffectsMessage {
    const now = this.now();
    return {
      entityId: idOf(holder),
      effects: holder.effects.map(({ effectId, endsAt }) => ({ effectId, ...(Number.isFinite(endsAt) ? { seconds: secondsLeft(endsAt, now) } : {}) })),
    };
  }

  /** Tells the holder, and each dreamer whose target it is, every effect it holds now. */
  private sendEffects(holder: PlayerSlot | MonsterRuntime): void {
    const holderId = idOf(holder);
    const frame = encodeOrWarn({ tag: 'effects', payload: this.effectsMessage(holder) }, this.logger);
    if (frame === undefined) return;
    for (const [id, viewer] of this.players) {
      if (id === holderId || viewer.target === holderId) viewer.outbox.send(frame);
    }
  }

  /**
   * Sends the dreamer the effects of the target they just chose. An NPC holds none. A dreamer who
   * targets themselves is sent nothing here, since their own effects reach them as the holder.
   */
  private sendTargetEffects(slot: PlayerSlot): void {
    const target = slot.target;
    if (target === undefined || target === slot.character.id) return;
    const holder = this.players.get(target) ?? this.monsters.get(target);
    const payload = holder === undefined ? { entityId: target, effects: [] } : this.effectsMessage(holder);
    slot.outbox.sendEncoded({ tag: 'effects', payload }, this.logger);
  }

  /** The seconds left on the dreamer's global cooldown and on each of their abilities' own still running. */
  private cooldownsLeft(slot: PlayerSlot): Pick<PlayerTransient, 'globalSeconds' | 'cooldowns'> {
    const now = this.now();
    const running = (Object.keys(slot.readyAt) as AbilityId[]).filter((abilityId) => slot.readyAt[abilityId]! > now);
    return {
      globalSeconds: secondsLeft(slot.globalReadyAt, now),
      cooldowns: running.map((abilityId) => ({ abilityId, seconds: secondsLeft(slot.readyAt[abilityId]!, now) })),
    };
  }

  private inSpeakingDistance(npc: NPCRuntime, player: PlayerSlot): boolean {
    return withinSpeakingDistance(player.character.position, npc.position);
  }

  step(elapsedSeconds: number): TickDigest {
    this.reachBoardDay(boardDay(this.wallNow()));
    const digest: TickDigest = { dialogUpserts: [], dialogResets: [] };
    this.runNPCs(digest);
    this.runMonsterSpawns();
    this.settleEffects([...this.players.values(), ...this.monsters.values()]);
    this.renewTraits();
    this.runPlayers(elapsedSeconds);
    this.runMonsters(elapsedSeconds);
    this.expireLoot();
    this.expireOffers();
    this.dropUnseenTargets();
    for (const slot of this.players.values()) this.sendVitals(slot);
    return digest;
  }

  /** Batched `moves` frames per player for everything that moved in their view since the last flush, as many as the per-frame cap needs. */
  flushMoves(): void {
    if (this.moved.size === 0) return;
    const perFrame = SOMNIO_PROTOCOL_CONSTANTS.maxMovesPerFrame;
    for (const [id, viewer] of this.players) {
      const moves = [...this.moved.values()].filter((entry) => entry.move.id !== id && this.sees(viewer, entry.sector)).map((entry) => entry.move);
      for (let start = 0; start < moves.length; start += perFrame) {
        viewer.outbox.sendEncoded({ tag: 'moves', payload: { moves: moves.slice(start, start + perFrame) } }, this.logger);
      }
    }
    this.moved.clear();
  }

  private runMonsterSpawns(): void {
    const now = this.now();
    for (const timer of this.spawnTimers) {
      if (timer.alive >= timer.definition.maxAlive || now < timer.spawnAt) continue;
      // The deadline moves only once a monster materializes; a fully blocked area keeps the
      // timer due and retries next step rather than dropping a monster onto geometry.
      if (!this.spawnMonster(timer)) continue;
      timer.alive += 1;
      timer.spawnAt = now + monsterKind(timer.definition.kind).respawnSeconds * 1000;
    }
  }

  /** A nightmare of the spawn's kind at a free point of its area: a boss of a boss's kind, else an elite by the spawn's chance. */
  private spawnMonster(timer: MonsterSpawnTimer): boolean {
    const kind = monsterKind(timer.definition.kind);
    const { sector, definition } = timer;
    const area = spawnArea(sector, definition);
    const position = this.randomFreePoint(area, kind.radius, this.random);
    if (position === undefined) return false;
    const moves = bossMoves(definition.kind);
    const elite = moves === undefined && randomUnit(this.eliteRandom) < definition.eliteChance;
    const monster = this.addMonster(definition.kind, position, area, {
      timer,
      summoner: undefined,
      trait: elite ? ELITE_TRAIT_IDS[Math.floor(randomUnit(this.eliteRandom) * ELITE_TRAIT_IDS.length)] : undefined,
      moves,
    });
    this.broadcast({ tag: 'entity', payload: this.monsterEntity(monster) }, monster.sector);
    return true;
  }

  /** A nightmare of the kind standing at rest at `position` from now, at home in `area`, as a spawn or a boss brings it. Its arrival is for the caller to show. */
  private addMonster(
    kindId: MonsterKindId,
    position: Point,
    area: Rect,
    origin: Pick<MonsterRuntime, 'timer' | 'summoner' | 'trait'> & { moves: BossMoves | undefined },
  ): MonsterRuntime {
    const id = `monster:${this.nextMonsterNumber}`;
    this.nextMonsterNumber += 1;
    const now = this.now();
    const kind = monsterKind(kindId);
    const boss: Boss | undefined =
      origin.moves === undefined ? undefined : { moves: origin.moves, givesUpAt: undefined, wail: undefined, wailReadyAt: 0, callReadyAt: 0 };
    const health = nightmareHealth(kind, nightmareRankOf({ boss, trait: origin.trait }));
    const monster: MonsterRuntime = {
      id,
      kindId,
      kind,
      trait: origin.trait,
      traitRenewsAt: undefined,
      sector: sectorAt(this.space, position)!.name,
      position,
      facing: headingFromCardinal('south'),
      health,
      healthMax: health,
      condition: 'hale',
      strikeReadyAt: 0,
      timer: origin.timer,
      summoner: origin.summoner,
      boss,
      lyingUntil: undefined,
      area,
      phase: { at: 'rest' },
      wanderAt: this.nextWanderAt(),
      home: position,
      steerSide: 1,
      homeBest: 0,
      homeBestAt: now,
      homeNearedAt: now,
      effects: origin.trait === undefined ? [] : [traitEffect(origin.trait, id, now)],
      threat: new Map(),
      answerDue: new Set(),
    };
    this.monsters.set(id, monster);
    return monster;
  }

  /**
   * Centimetre-grid sampling inside an area of the space, validated against the world and live
   * entities but `except`, up to the retry cap. Rounding can carry a size with a fraction of a
   * centimetre past itself, so the offset is held to the size, which keeps the point inside the area.
   */
  private randomFreePoint(area: Rect, radius: number, random: RandomSource, except?: MonsterRuntime): Point | undefined {
    for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt += 1) {
      const candidate = {
        x: area.x + Math.min(area.width, randomInRange(random, 0, Math.round(area.width * 100)) / 100),
        z: area.z + Math.min(area.depth, randomInRange(random, 0, Math.round(area.depth * 100)) / 100),
      };
      if (isClear(this.collision, candidate, radius) && !this.overlapsEntity(candidate, radius, except)) return candidate;
    }
    return undefined;
  }

  /** When a nightmare settling now may next pick a point to wander to. */
  private nextWanderAt(): number {
    const { min, max } = NIGHTMARE_WANDER.everySeconds;
    return this.now() + randomInRange(this.wanderRandom, min, max) * 1000;
  }

  private runNPCs(digest: TickDigest): void {
    for (const npc of this.npcs.values()) {
      const action = this.resolveDialogAction(npc);
      switch (action.kind) {
        case 'holdCooldown':
          break;
        case 'resetTargeting':
          this.resetTargeting(npc, digest);
          break;
        case 'emit':
          this.emitDialogStep(npc, action.targetName, digest);
          break;
      }
      this.greetArrival(npc);
    }
  }

  /**
   * An NPC greets a dreamer who has come within speaking distance with the first line of its
   * script: once per approach, and not again within the greeting pause, so one who hovers at the
   * edge is not greeted over and over. While it is saying something else the arrivals wait, and
   * it greets one of them per line.
   */
  private greetArrival(npc: NPCRuntime): void {
    const greeting = npc.dialogSteps[0];
    if (greeting === undefined) return;
    for (const id of npc.near) {
      const slot = this.players.get(id);
      if (slot === undefined || !this.inSpeakingDistance(npc, slot)) npc.near.delete(id);
    }
    const now = this.now();
    if (npc.targetingEntity !== undefined || now < npc.readyAt || now < npc.greetReadyAt) return;
    for (const slot of this.players.values()) {
      const id = slot.character.id;
      if (npc.near.has(id) || !this.inSpeakingDistance(npc, slot)) continue;
      npc.near.add(id);
      const last = npc.greetedAt.get(id);
      if (last !== undefined && now - last < SOMNIO_CONSTANTS.npcGreetingPauseSeconds * 1000) continue;
      npc.greetedAt.set(id, now);
      this.speakAs(npc, greeting, slot.character.name);
      npc.greetReadyAt = now + SOMNIO_CONSTANTS.npcDialogCooldownSeconds * 1000;
      return;
    }
  }

  private resolveDialogAction(npc: NPCRuntime): NPCDialogAction {
    if (npc.targetingEntity === undefined) return { kind: 'holdCooldown' };
    const target = this.players.get(npc.targetingEntity);
    if (target === undefined) return { kind: 'resetTargeting' };
    if (!this.inSpeakingDistance(npc, target)) return { kind: 'resetTargeting' };
    if (this.now() < npc.readyAt) return { kind: 'holdCooldown' };
    return { kind: 'emit', targetName: target.character.name };
  }

  /**
   * Emits the current step, restarts the cooldown, and advances the cursor, wrapping (and clearing
   * targeting) at the last line. The first step is the greeting, so the cursor starts past it.
   */
  private emitDialogStep(npc: NPCRuntime, targetName: string, digest: TickDigest): void {
    const index = Math.max(npc.scriptStepIndex, 1);
    const step = npc.dialogSteps[index]!;
    this.speakAs(npc, step, targetName);
    npc.readyAt = this.now() + SOMNIO_CONSTANTS.npcDialogCooldownSeconds * 1000;
    const key = { sectorName: npc.sector, npcId: npc.definition.id };
    const nextIndex = index + 1;
    if (nextIndex >= npc.dialogSteps.length) {
      npc.scriptStepIndex = 0;
      npc.targetingEntity = undefined;
      digest.dialogResets.push(key);
    } else {
      npc.scriptStepIndex = nextIndex;
      digest.dialogUpserts.push({ ...key, scriptStep: nextIndex + 1 });
    }
  }

  /** An NPC talks like a dreamer: whoever it addresses stands within speaking distance and hears it whole, and bystanders by their distance. */
  private speakAs(npc: NPCRuntime, step: string, targetName: string): void {
    this.speak({ voice: { entityId: npc.id, name: npc.definition.name, kind: 'say', line: { step, targetName } }, rolls: [] }, npc.position);
  }

  private resetTargeting(npc: NPCRuntime, digest: TickDigest): void {
    npc.targetingEntity = undefined;
    npc.scriptStepIndex = 0;
    digest.dialogResets.push({ sectorName: npc.sector, npcId: npc.definition.id });
  }

  /**
   * Each nightmare acts by its phase (`MonsterPhase`), then is shown moved only when its position or
   * facing changed, so one standing still sends nothing.
   */
  private runMonsters(elapsedSeconds: number): void {
    for (const monster of this.monsters.values()) {
      const { position, facing } = monster;
      this.runMonster(monster, elapsedSeconds);
      if (this.monsters.get(monster.id) !== monster || (monster.position === position && monster.facing === facing)) continue;
      this.moved.set(monster.id, {
        sector: monster.sector,
        move: { id: monster.id, x: monster.position.x, z: monster.position.z, facing: monster.facing, gait: DEFAULT_GAIT },
      });
    }
  }

  /**
   * One nightmare's step. One driven off lies, doing nothing, and is gone once its lie is over. One
   * walking home evading (`evadesAll`) notices and strikes no one (`returnStep`).
   *
   * Any other forgets from its table every dreamer who left the space, fell, or is unseen, and a
   * confined one also those outside its area. It chases the foremost dreamer it notices (`notices`):
   * the challenger, else the one it holds the most threat against, else the nearest. Chasing puts the
   * dreamer on its table, so stepping out of its aggro radius ends nothing. The step a fight begins,
   * where it stands becomes the leash's anchor, and its neighbours at rest or wandering become aware
   * of it (`alertNeighbours`). One that is not confined gives up once its table is empty or it stands
   * farther from that anchor than its kind's leash. A boss gives up as `runBoss` says, and a minion
   * never does on its own: with no one to chase it holds where it stands. A bound one stays where it
   * stands, turning toward whom it chases.
   *
   * A follower stays still until its awareness comes, then follows its leader while its chain of
   * leaders leads to a fight (`leadsToFight`), and otherwise walks back to its home. At rest, one
   * that is not confined now and then wanders to a point of its area at half speed while some dreamer
   * sees its sector. With no one seeing it, it stands still.
   *
   * In a fight, on its own rhythm it strikes the dreamer it chases once it has reached them.
   * Otherwise it strikes the foremost dreamer in its reach, wherever they stand. Failing them, it
   * strikes the foremost who struck it from within its reach since its last turn, so a step in, a
   * blow, and a step out between two turns is still answered. A blow it cannot answer this turn it
   * forgets. A confined one at rest strikes the same way across its chamber's edge, without entering
   * a fight. No other strikes. It heals only on a return. A boss also wails and calls up minions
   * (`runBoss`), and holds still while it wails.
   */
  private runMonster(monster: MonsterRuntime, elapsedSeconds: number): void {
    const now = this.now();
    const answerDue = monster.answerDue;
    monster.answerDue = new Set();
    if (monster.lyingUntil !== undefined) {
      if (now >= monster.lyingUntil) this.removeMonster(monster, false);
      return;
    }
    if (monster.phase.at === 'return' && monster.phase.evading) {
      this.returnStep(monster, monster.phase, elapsedSeconds);
      return;
    }
    this.forgetThreat(monster);
    const chased = this.foremostDreamer(monster, (slot, away) => notices(monster, slot, away));
    if (chased !== undefined) {
      addThreat(monster, chased, 0);
      if (monster.phase.at !== 'fight') {
        if (monster.phase.at === 'rest' || monster.phase.at === 'wander') monster.home = monster.position;
        monster.phase = { at: 'fight', from: monster.position };
        if (monster.boss !== undefined) {
          monster.boss.wailReadyAt = now + monster.boss.moves.firstWailSeconds * 1000;
          monster.boss.callReadyAt = now;
        }
        this.alertNeighbours(monster);
      }
    }
    // A boss holding still for its wail neither moves, turns, nor strikes.
    if (monster.boss !== undefined && this.runBoss(monster, monster.boss, chased)) return;
    if (
      monster.phase.at === 'fight' &&
      !confined(monster) &&
      (chased === undefined || distance(monster.position, monster.phase.from) > monster.kind.leashMetres)
    ) {
      this.giveUp(monster);
    }
    const phase = monster.phase;
    switch (phase.at) {
      case 'fight':
        if (chased === undefined) break;
        if (rooted(monster))
          monster.facing = headingFromVector(chased.character.position.x - monster.position.x, chased.character.position.z - monster.position.z);
        else this.stepToward(monster, chased.character.position, elapsedSeconds, reachDistance(monster.kind.radius), false);
        break;
      case 'follow': {
        if (now < phase.from) break;
        if (!this.leadsToFight(monster)) {
          this.enterReturn(monster, false);
          break;
        }
        if (!phase.alerted) {
          phase.alerted = true;
          this.alertNeighbours(monster);
        }
        const leader = this.monsters.get(phase.leaderId)!;
        if (!rooted(monster)) this.stepToward(monster, leader.position, elapsedSeconds, monster.kind.radius + leader.kind.radius, false);
        break;
      }
      case 'return':
        if (!phase.evading) this.returnStep(monster, phase, elapsedSeconds);
        break;
      case 'wander': {
        if (rooted(monster)) break;
        const speed = monster.kind.metresPerSecond * NIGHTMARE_WANDER.speedShare;
        if (!this.inView(monster.sector) || !this.stepToward(monster, phase.to, elapsedSeconds, 0, false, speed)) this.settle(monster);
        break;
      }
      case 'rest': {
        if (confined(monster) || now < monster.wanderAt || !this.inView(monster.sector)) break;
        const to = this.randomFreePoint(monster.area, monster.kind.radius, this.wanderRandom, monster);
        if (to === undefined) this.settle(monster);
        else monster.phase = { at: 'wander', to };
        break;
      }
    }
    if (monster.phase.at !== 'fight' && !(monster.phase.at === 'rest' && confined(monster))) return;
    const body: Body = { ...monster.position, radius: monster.kind.radius };
    const struck =
      chased !== undefined && reaches(chased.character.position, body)
        ? chased
        : (this.foremostDreamer(monster, (slot) => reaches(slot.character.position, body)) ??
          this.foremostDreamer(monster, (slot) => answerDue.has(slot.character.id)));
    if (struck !== undefined && now >= monster.strikeReadyAt) {
      monster.facing = headingFromVector(struck.character.position.x - monster.position.x, struck.character.position.z - monster.position.z);
      this.strike(monster, struck);
    }
  }

  /**
   * A step of the nightmare's return to its `home`, which lies inside its area. A bound one holds,
   * which is no lack of progress.
   *
   * Outside the area, once it has come no nearer for `HOME_PROGRESS_SECONDS`, it stops evading and
   * keeps to the straight step, as `walkHome` does. With a body on its home it then takes the free
   * point of its area nearest that home as its home instead (`rehome`). Outside the area too, once it
   * has come no nearer home, the first or any it took, for `STUCK_RETURN_SECONDS`, it is walled off:
   * it leaves, and its spawn has a slot to refill.
   *
   * It heals a `giveUpHealSeconds`th of its maximum health a second all the while. The return ends,
   * back at rest, the step it stands whole at home, or whole inside its area with the way home
   * blocked for `HOME_PROGRESS_SECONDS`, so a body on its home never keeps it from resting.
   */
  private returnStep(monster: MonsterRuntime, phase: { evading: boolean }, elapsedSeconds: number): void {
    const now = this.now();
    const atHome = (): boolean => distance(monster.position, monster.home) <= EDGE_TOLERANCE;
    const inside = (): boolean => rectContains(monster.area, monster.position, EDGE_TOLERANCE);
    if (rooted(monster)) {
      monster.homeBestAt = now;
      monster.homeNearedAt = now;
    } else if (!atHome()) {
      if (!inside() && now - monster.homeNearedAt >= STUCK_RETURN_SECONDS * 1000) {
        this.freeSpawnSlot(monster);
        this.removeMonster(monster, false);
        return;
      }
      if (!inside() && now - monster.homeBestAt >= HOME_PROGRESS_SECONDS * 1000) {
        phase.evading = false;
        if (this.overlapsEntity(monster.home, monster.kind.radius, monster)) this.rehome(monster);
      }
      this.walkHome(monster, elapsedSeconds);
    }
    if (monster.health < monster.healthMax) {
      monster.health = Math.min(monster.healthMax, monster.health + (monster.healthMax / COMBAT.giveUpHealSeconds) * elapsedSeconds);
      this.setCondition(monster);
    }
    const blocked = !rooted(monster) && now - monster.homeBestAt >= HOME_PROGRESS_SECONDS * 1000;
    if (monster.health >= monster.healthMax && (atHome() || (inside() && blocked))) this.settle(monster);
  }

  /**
   * Gives a returning nightmare the free point of its area nearest its home as its home: of the
   * nearest ring out from home that holds one, the point nearest where it stands, so it need not walk
   * round what lies on its home. It steers for it afresh from now, from as far as it stands, while
   * `homeNearedAt` runs on. With none within `REHOME_METRES` its home stays as it was.
   */
  private rehome(monster: MonsterRuntime): void {
    const { home, position } = monster;
    const radius = monster.kind.radius;
    for (let ring = 1; ring * REHOME_RING_METRES <= REHOME_METRES; ring += 1) {
      let best: Point | undefined;
      for (let index = 0; index < REHOME_RING_POINTS; index += 1) {
        const radians = (index / REHOME_RING_POINTS) * 2 * Math.PI;
        const point = { x: home.x + Math.sin(radians) * ring * REHOME_RING_METRES, z: home.z + Math.cos(radians) * ring * REHOME_RING_METRES };
        if (!rectContains(monster.area, point, EDGE_TOLERANCE) || !isClear(this.collision, point, radius) || this.overlapsEntity(point, radius, monster))
          continue;
        if (best === undefined || distance(point, position) < distance(best, position)) best = point;
      }
      if (best !== undefined) {
        monster.home = best;
        monster.homeBest = distance(position, best);
        monster.homeBestAt = this.now();
        return;
      }
    }
  }

  /** Sets the nightmare walking back to its home, with its progress home counted afresh from now. */
  private enterReturn(monster: MonsterRuntime, evading: boolean): void {
    monster.phase = { at: 'return', evading };
    monster.homeBest = Number.POSITIVE_INFINITY;
    monster.homeBestAt = this.now();
    monster.homeNearedAt = monster.homeBestAt;
  }

  /** The nightmare gives its fight up: it forgets everyone and walks home evading. */
  private giveUp(monster: MonsterRuntime): void {
    monster.threat.clear();
    monster.answerDue.clear();
    this.enterReturn(monster, true);
  }

  /** The nightmare rests, and may wander again once a fresh while has passed. */
  private settle(monster: MonsterRuntime): void {
    monster.phase = { at: 'rest' };
    monster.wanderAt = this.nextWanderAt();
  }

  /**
   * Every other nightmare at rest or wandering within `NIGHTMARE_AWARENESS.radiusMetres` of the one
   * setting off, and not confined, becomes aware of it, and follows it once `delaySeconds` have passed.
   */
  private alertNeighbours(leader: MonsterRuntime): void {
    const from = this.now() + NIGHTMARE_AWARENESS.delaySeconds * 1000;
    for (const other of this.monsters.values()) {
      if (other === leader || confined(other) || other.lyingUntil !== undefined || (other.phase.at !== 'rest' && other.phase.at !== 'wander')) continue;
      if (distance(other.position, leader.position) > NIGHTMARE_AWARENESS.radiusMetres) continue;
      other.home = other.position;
      other.phase = { at: 'follow', leaderId: leader.id, from, alerted: false };
    }
  }

  /**
   * Whether the follower's chain of leaders, followed from leader to leader, reaches one in a fight.
   * It does not once a leader is gone, lying, or doing anything but following or fighting, or once
   * the chain comes back to a nightmare already in it.
   */
  private leadsToFight(follower: MonsterRuntime): boolean {
    const chain = new Set([follower]);
    let phase = follower.phase;
    while (phase.at === 'follow') {
      const leader = this.monsters.get(phase.leaderId);
      if (leader === undefined || chain.has(leader)) return false;
      chain.add(leader);
      phase = leader.phase;
    }
    return phase.at === 'fight';
  }

  private inView(sector: string): boolean {
    return [...this.players.values()].some((viewer) => this.sees(viewer, sector));
  }

  /**
   * A boss's own moves this step, which reports whether it holds still for its wail. Outside a fight
   * it has none. From the step it has no one to chase, wailing or not, it counts `giveUpSeconds`. A
   * wail under way strikes once its time is up, whoever it then finds in its circle, and the boss is
   * free again from the next step. With no one to chase, the boss holds where it stands, and once
   * the count has run out it gives its fight up: the minions it called up crumble, and it walks home
   * evading (`giveUp`). A dreamer it chases again before then finds its minions and its timers as
   * they were. Otherwise it calls up minions when they are due, and when its wail is due and a
   * dreamer stands in the circle it would strike, it begins one.
   */
  private runBoss(monster: MonsterRuntime, boss: Boss, chased: PlayerSlot | undefined): boolean {
    if (monster.phase.at !== 'fight') return false;
    const now = this.now();
    if (chased === undefined) boss.givesUpAt ??= now + boss.moves.giveUpSeconds * 1000;
    else boss.givesUpAt = undefined;
    if (boss.wail !== undefined) {
      if (now < boss.wail.endsAt) return true;
      const { centre } = boss.wail;
      boss.wail = undefined;
      boss.wailReadyAt = now + boss.moves.wailEverySeconds * 1000;
      for (const slot of this.caughtInWail(centre)) this.harmDreamer(slot, TELEGRAPHS.wail.damage, TELEGRAPHS.wail.balanceDamage, monster);
      // The strike is the step's deed: the dreamer it chose to chase may have fallen to it.
      return true;
    }
    if (boss.givesUpAt !== undefined) {
      if (now >= boss.givesUpAt) {
        this.dismissMinions(monster);
        boss.givesUpAt = undefined;
        this.giveUp(monster);
      }
      return false;
    }
    if (now >= boss.callReadyAt) {
      boss.callReadyAt = now + boss.moves.minions.callEverySeconds * 1000;
      this.callMinions(monster, boss.moves.minions);
    }
    if (now < boss.wailReadyAt || this.caughtInWail(monster.position).length === 0) return false;
    boss.wail = { id: `telegraph-${this.nextTelegraphNumber}`, centre: monster.position, endsAt: now + TELEGRAPHS.wail.seconds * 1000 };
    this.nextTelegraphNumber += 1;
    this.broadcast(this.telegraphMessage(monster, boss.wail), monster.sector);
    return true;
  }

  /** The dreamers a wail round `centre` strikes: each standing in its circle whom nightmares do not leave alone. */
  private caughtInWail(centre: Point): PlayerSlot[] {
    const now = this.now();
    return [...this.players.values()].filter((slot) => !leftAlone(slot, now) && distance(slot.character.position, centre) <= TELEGRAPHS.wail.radius);
  }

  /** The boss's wail as it stands, with the seconds left before it strikes. */
  private telegraphMessage(monster: MonsterRuntime, wail: NonNullable<Boss['wail']>): SomnioMessage {
    return {
      tag: 'telegraph',
      payload: {
        id: wail.id,
        casterId: monster.id,
        kind: 'wail',
        x: wail.centre.x,
        z: wail.centre.z,
        radius: TELEGRAPHS.wail.radius,
        seconds: secondsLeft(wail.endsAt, this.now()),
      },
    };
  }

  /**
   * Calls up minions round the boss, as many as `perCall` while fewer than `maxAlive` of its own
   * stand, each at a free point of its area near it, sharing that area and counted against no
   * spawn. Everyone who sees one arrive is shown that the boss called it, and it waits a strike's
   * time before its first.
   */
  private callMinions(boss: MonsterRuntime, minions: BossMoves['minions']): void {
    const kind = monsterKind(minions.kind);
    const standing = [...this.monsters.values()].filter((other) => other.summoner === boss && other.lyingUntil === undefined).length;
    for (let called = 0; called < Math.min(minions.perCall, minions.maxAlive - standing); called += 1) {
      const position = this.freePointNear(boss, minions.withinMetres, kind.radius);
      if (position === undefined) return;
      const minion = this.addMonster(minions.kind, position, boss.area, { timer: undefined, summoner: boss, trait: undefined, moves: undefined });
      minion.strikeReadyAt = this.now() + kind.strikeSeconds * 1000;
      this.broadcast({ tag: 'entity', payload: { ...this.monsterEntity(minion), summonedBy: boss.id } }, minion.sector);
    }
  }

  /** A point of the nightmare's area between `MINION_NEAREST_METRES` and `within` from it where a body of `radius` stands clear, up to the retry cap. */
  private freePointNear(monster: MonsterRuntime, within: number, radius: number): Point | undefined {
    for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt += 1) {
      const radians = randomUnit(this.random) * 2 * Math.PI;
      const away = MINION_NEAREST_METRES + randomUnit(this.random) * (within - MINION_NEAREST_METRES);
      const candidate = { x: monster.position.x + Math.sin(radians) * away, z: monster.position.z + Math.cos(radians) * away };
      if (rectContains(monster.area, candidate) && isClear(this.collision, candidate, radius) && !this.overlapsEntity(candidate, radius)) return candidate;
    }
    return undefined;
  }

  /**
   * The minions the boss called up crumble with its fight. Each standing one is gone at once, paying
   * no one and never fallen, and its viewers are sent its `leave` marked `crumbled`. One a dreamer
   * drove off lies as it was.
   */
  private dismissMinions(boss: MonsterRuntime): void {
    for (const minion of this.monsters.values()) {
      if (minion.summoner !== boss || minion.lyingUntil !== undefined) continue;
      this.removeMonster(minion, true);
    }
  }

  /** Takes the nightmare out of the space, and out of the step's moves, and tells everyone who sees it that it left, crumbling or not. */
  private removeMonster(monster: MonsterRuntime, crumbled: boolean): void {
    this.monsters.delete(monster.id);
    this.moved.delete(monster.id);
    this.broadcast({ tag: 'leave', payload: { entityId: monster.id, leftGame: false, ...(crumbled ? { crumbled } : {}) } }, monster.sector);
  }

  /**
   * Of the dreamers the nightmare may turn on whom `qualifies` accepts at their distance from it,
   * the one highest in its mind (`threatRank`), and the nearest among those standing equally high.
   */
  private foremostDreamer(monster: MonsterRuntime, qualifies: (slot: PlayerSlot, away: number) => boolean): PlayerSlot | undefined {
    const now = this.now();
    let foremost: PlayerSlot | undefined;
    let bestRank = Number.NEGATIVE_INFINITY;
    let bestAway = Number.POSITIVE_INFINITY;
    for (const slot of this.players.values()) {
      if (leftAlone(slot, now)) continue;
      const rank = threatRank(monster, slot.character.id) ?? Number.NEGATIVE_INFINITY;
      const away = distance(monster.position, slot.character.position);
      if (rank < bestRank || (rank === bestRank && away >= bestAway) || !qualifies(slot, away)) continue;
      foremost = slot;
      bestRank = rank;
      bestAway = away;
    }
    return foremost;
  }

  /**
   * Whether the nightmare evades harm from afar by the dreamer: it does while it walks home evading
   * everything (`evadesAll`), and a confined one whenever they stand outside its area, where it would
   * not chase them. A blow asks `evadesAll` alone, since the nightmare strikes back at whoever stands
   * in its reach.
   */
  private evades(monster: MonsterRuntime, source: PlayerSlot): boolean {
    return evadesAll(monster) || (confined(monster) && !rectContains(monster.area, source.character.position, EDGE_TOLERANCE));
  }

  /**
   * Whether the nightmare evades what a use by the dreamer does to it: harm from afar as `evades`
   * judges it, and an effect while it evades everything. A Cleave's blows ask `blow` instead.
   */
  private evadesUse(monster: MonsterRuntime, does: AbilityDeed, source: PlayerSlot): boolean {
    switch (does.kind) {
      case 'harm':
        return this.evades(monster, source);
      case 'effect':
        return evadesAll(monster);
      case 'strike':
      case 'leap':
      case 'restore':
      case 'heal':
      case 'calm':
        return false;
    }
  }

  /**
   * Drops from the nightmare's table every dreamer no longer in the space, fallen, or unseen, and for
   * a confined one also outside its area; a Challenge it holds runs on until it ends.
   */
  private forgetThreat(monster: MonsterRuntime): void {
    for (const id of monster.threat.keys()) {
      const slot = this.players.get(id);
      if (slot === undefined || isFallen(slot) || unseen(slot) || (confined(monster) && !rectContains(monster.area, slot.character.position, EDGE_TOLERANCE))) {
        monster.threat.delete(id);
      }
    }
  }

  /**
   * A step toward the nightmare's home. Once it has come no nearer for a while it holds, trying
   * only the straight step, and sets out again once that is free.
   */
  private walkHome(monster: MonsterRuntime, elapsedSeconds: number): void {
    const now = this.now();
    const resting = now - monster.homeBestAt >= HOME_PROGRESS_SECONDS * 1000;
    const moved = this.stepToward(monster, monster.home, elapsedSeconds, 0, resting);
    const away = distance(monster.position, monster.home);
    const neared = away <= monster.homeBest - HOME_PROGRESS_METRES;
    if (neared) monster.homeNearedAt = now;
    if (neared || (moved && resting)) {
      monster.homeBest = away;
      monster.homeBestAt = now;
    }
  }

  /**
   * One step toward `goal`, ending no nearer than `stopWithin` less the stop slack. Reports whether
   * it moved. When the straight step is blocked and `straightOnly` is unset, it tries headings turned
   * off the bearing, every angle on the side it last turned to before any on the other. A confined
   * one, and one wandering, keeps to its area. It steps round every body, the fallen too. A step that
   * leaves its overlap with the bodies no deeper is never refused for them. At its area's edge or
   * corner, though, every candidate can still deepen it, and then it stays. It faces its bearing to
   * `goal` even when blocked, except within `stopWithin` of it, where it does not turn.
   */
  private stepToward(
    monster: MonsterRuntime,
    goal: Point,
    elapsedSeconds: number,
    stopWithin: number,
    straightOnly: boolean,
    metresPerSecond = monster.kind.metresPerSecond,
  ): boolean {
    const from = monster.position;
    const away = distance(from, goal);
    if (away <= stopWithin) return false;
    const bearing = headingFromVector(goal.x - from.x, goal.z - from.z);
    monster.facing = bearing;
    const stride = Math.min(metresPerSecond * elapsedSeconds, away - Math.max(0, stopWithin - STOP_SLACK));
    if (stride <= 0) return false;
    const radius = monster.kind.radius;
    const bodies = this.bodiesAround(monster);
    const keepsToArea = confined(monster) || monster.phase.at === 'wander';
    const legal = (end: Point): boolean =>
      (!keepsToArea || rectContains(monster.area, end, EDGE_TOLERANCE)) &&
      isLegalMove(this.collision, from, end, radius, this.npcBodies) &&
      !bodiesBlock(from, end, radius, bodies);
    const straight = stride === away ? goal : { x: from.x + ((goal.x - from.x) * stride) / away, z: from.z + ((goal.z - from.z) * stride) / away };
    let end: Point | undefined = legal(straight) ? straight : undefined;
    if (end === undefined && !straightOnly) {
      for (const side of [monster.steerSide, monster.steerSide === 1 ? -1 : 1] as const) {
        for (const degrees of STEER_DEGREES) {
          const radians = headingRadians(bearing + side * degrees);
          const turned = { x: from.x + Math.sin(radians) * stride, z: from.z + Math.cos(radians) * stride };
          if (!legal(turned)) continue;
          end = turned;
          monster.steerSide = side;
          break;
        }
        if (end !== undefined) break;
      }
    }
    if (end === undefined) return false;
    const previous = monster.sector;
    monster.position = end;
    monster.sector = sectorAt(this.space, end)!.name;
    if (monster.sector !== previous) this.entityChangedSector(this.monsterEntity(monster), previous, monster.sector);
    return true;
  }

  /** Every body a nightmare steps round: each dreamer, fallen or standing, and every other nightmare not lying. */
  private bodiesAround(monster: MonsterRuntime): Body[] {
    const bodies: Body[] = [];
    for (const slot of this.players.values()) bodies.push({ ...slot.character.position, radius: SOMNIO_CONSTANTS.playerRadius });
    for (const other of this.monsters.values()) {
      if (other !== monster && other.lyingUntil === undefined) bodies.push({ ...other.position, radius: other.kind.radius });
    }
    return bodies;
  }

  /** A nightmare's strike at a dreamer it has reached. A hit takes health and a little balance. */
  private strike(monster: MonsterRuntime, target: PlayerSlot): void {
    monster.strikeReadyAt = this.now() + monster.kind.strikeSeconds * 1000;
    const energy = target.character.energy;
    const hit = randomUnit(this.random) < strikeChance(monster.kind, energy.balanceCurrent, energy.balanceMax, this.statsFor(target));
    this.broadcast({ tag: 'blow', payload: { attackerId: monster.id, targetId: target.character.id, hit } }, target.sector);
    if (hit) this.harmDreamer(target, monster.kind.damage, monster.kind.balanceDamage, monster);
  }

  /**
   * The one way harm reaches a dreamer. It lands as `shieldedHit` judges it and takes a little
   * balance besides, unless a shield took all of it. Harm that takes the last of their health is the
   * only way a dreamer falls, and a fall ends every heal over time they hold.
   */
  private harmDreamer(target: PlayerSlot, amount: number, balanceAmount: number, source: MonsterRuntime): void {
    const landed = this.shieldedHit(target, amount, source);
    if (landed === 0) return;
    const energy = target.character.energy;
    this.setEnergy(target, {
      ...energy,
      healthCurrent: Math.max(0, energy.healthCurrent - landed),
      balanceCurrent: Math.max(0, energy.balanceCurrent - balanceAmount),
    });
    if (!isFallen(target)) return;
    this.fallenChanged();
    this.endOffer(target, 'didNotTake');
    // Falling switches slot 1 off here and on their client alike, with no frame between them.
    target.engaged = false;
    this.breakChannel(target);
    this.breakChannelsOn(target);
    this.endEffects(target, (held) => effect(held.effectId).healthPerSecond !== undefined);
    this.advanceQuests(target, (_objective, progress, held) => (held.withoutFalling === true ? 0 : progress));
    // Their client stops reporting at once and may have predicted a little past the last accepted position.
    this.snapBack(target);
  }

  /**
   * The harm a hit of `amount` from `source` lands on `taker`, by the effects both hold. A shield the
   * taker holds takes what it can first, and ends once it has taken all it holds. A hit it takes all
   * of lands nothing.
   */
  private shieldedHit(taker: PlayerSlot | MonsterRuntime, amount: number, source: PlayerSlot | MonsterRuntime): number {
    const shield = taker.effects.find((held) => held.shield !== undefined);
    const { landed, absorbed } = shieldedHarm(amount, effectIds(source), effectIds(taker), shield?.shield ?? 0);
    if (shield !== undefined && absorbed > 0) {
      shield.shield! -= absorbed;
      if (shield.shield! <= 0) this.endEffects(taker, (held) => held === shield);
    }
    return landed;
  }

  /**
   * Every dreamer with slot 1 on acts on their target: swings at a nightmare, and a Healer touches
   * a dreamer. While a channel of theirs is under way it holds, and stays on. Slot 1 goes off once
   * the target is nothing it can act on: a nightmare driven off, an entity gone or out of view, a
   * nightmare once the main hand holds what does not swing, or a dreamer once the Moonstone leaves
   * the off hand.
   */
  private runEngaged(): void {
    for (const slot of this.players.values()) {
      if (!slot.engaged) continue;
      if (this.engagedAction(slot) === undefined) {
        slot.engaged = false;
        continue;
      }
      if (slot.channel !== undefined) continue;
      const monster = this.monsters.get(slot.target!);
      if (monster !== undefined) this.swing(slot, monster);
      else this.touch(slot, this.players.get(slot.target!)!);
    }
  }

  /** What slot 1 does at the dreamer's target as it stands: a nightmare not yet driven off, or a dreamer, in their view. */
  private engagedAction(slot: PlayerSlot): EngageAction | undefined {
    return engageAction(this.engageKind(slot), slot.character.lucidity.role, slot.inventory.equipped, slot.character.quests.active);
  }

  private engageKind(slot: PlayerSlot): EngageTarget | undefined {
    return this.abilityBody(slot, slot.target)?.kind;
  }

  /**
   * A dreamer's swing at the nightmare, at the swing rhythm, for the balance what they hold in the
   * main hand costs. It is made only while the nightmare stands in reach inside the arc of the facing
   * they last reported. With less balance than the cost, with something in the main hand that does not
   * swing, or while they hold a quest that forbids striking, no swing happens. A swing not made costs
   * nothing.
   */
  private swing(player: PlayerSlot, monster: MonsterRuntime): void {
    const now = this.now();
    if (now < player.swingReadyAt) return;
    if (!swingMeets(player.character.position, player.character.facing, { ...monster.position, radius: monster.kind.radius })) return;
    const energy = player.character.energy;
    const swing = swingAllowed(player.character.quests.active, player.inventory.equipped.mainHand, this.statsFor(player), energy.balanceCurrent);
    if (swing === undefined) return;
    player.swingReadyAt = now + swing.seconds * 1000;
    this.setEnergy(player, { ...energy, balanceCurrent: energy.balanceCurrent - swing.balanceCost });
    this.blow(player, monster, swing.damage);
  }

  /**
   * A dreamer's blow at a nightmare, shown to everyone who sees the dreamer, which harms it by
   * `damage` through `harmNightmare` when it hits. A blow struck from within the nightmare's reach
   * may be answered at its next turn, wherever the dreamer has stepped meanwhile (`runMonster`). One
   * at a nightmare that evades everything (`evadesAll`) is shown evaded, and harms and answers nothing.
   */
  private blow(player: PlayerSlot, monster: MonsterRuntime, damage: number): void {
    if (evadesAll(monster)) {
      this.broadcast({ tag: 'blow', payload: { attackerId: player.character.id, targetId: monster.id, hit: false, evaded: true } }, player.sector);
      return;
    }
    if (reaches(player.character.position, { ...monster.position, radius: monster.kind.radius })) monster.answerDue.add(player.character.id);
    const hit = randomUnit(this.random) < COMBAT.hitChance;
    this.broadcast({ tag: 'blow', payload: { attackerId: player.character.id, targetId: monster.id, hit } }, player.sector);
    if (hit) this.harmNightmare(monster, damage, player);
  }

  /**
   * The one way harm reaches a nightmare. It lands by the effects its source and the nightmare hold,
   * an elite's trait among them, and a shield the nightmare holds takes what it can first. It raises
   * the source's threat by what landed, and at none the nightmare is driven off.
   */
  private harmNightmare(monster: MonsterRuntime, amount: number, source: PlayerSlot): void {
    const landed = this.shieldedHit(monster, amount, source);
    addThreat(monster, source, landed);
    monster.health = Math.max(0, monster.health - landed);
    this.setCondition(monster);
    if (monster.health === 0) this.driveOff(monster, source);
  }

  /**
   * The one place a nightmare is driven off. It lies where it fell for its rank's `lieSeconds`. It is
   * set at rest, so whoever follows it goes back (`leadsToFight`). Its spawn, if it has one, has a
   * slot to refill after the kind's respawn time, counted from the fall. A boss's wail ends unstruck
   * and its minions crumble. The standing dreamers within the share radius, and the standing dreamer
   * whose harm drove it off from however far, split its bounty, and each earn the practice and its
   * count toward their quests in full. Each of them rolls for drops of their own, by the nightmare's
   * tier and rank, and finds its kind's trophy while a quest of theirs collects it. All their drops
   * scatter fanned round where it stood.
   */
  private driveOff(monster: MonsterRuntime, finisher: PlayerSlot): void {
    const now = this.now();
    monster.lyingUntil = now + COMBAT.lieSeconds[nightmareRankOf(monster) ?? 'nightmare'] * 1000;
    monster.phase = { at: 'rest' };
    this.freeSpawnSlot(monster);
    if (monster.boss !== undefined) {
      monster.boss.wail = undefined;
      this.dismissMinions(monster);
    }
    const near = [...this.players.values()].filter(
      (slot) => !isFallen(slot) && (slot === finisher || distance(slot.character.position, monster.position) <= COMBAT.shareRadius),
    );
    const share = Math.floor(monster.kind.bounty / near.length);
    const drops: { owner: PlayerSlot; contents: LootContents }[] = [];
    for (const slot of near) {
      if (share > 0) this.giveCoins(slot, share);
      for (const item of rollDrops(monster.kind.tier, nightmareRankOf(monster) ?? 'nightmare', slot.character.lucidity.role, () => randomUnit(this.lootRandom)))
        drops.push({ owner: slot, contents: { kind: 'item', item } });
      if (collectsTrophy(slot.character.quests, monster.kindId)) drops.push({ owner: slot, contents: { kind: 'trophy', monsterKind: monster.kindId } });
      this.addPractice(slot, PRACTICE.nightmare);
      this.advanceQuests(slot, (objective, progress) => (drivesOff(objective, monster.kindId, monster.sector) ? progress + 1 : progress));
    }
    this.scatter(monster.position, drops);
  }

  /** Frees a slot of the nightmare's spawn, if it has one, to refill after the kind's respawn time from now. */
  private freeSpawnSlot({ timer, kind }: MonsterRuntime): void {
    if (timer === undefined) return;
    timer.alive -= 1;
    timer.spawnAt = this.now() + kind.respawnSeconds * 1000;
  }

  /**
   * A Healer's Moonstone reaching their target: a standing dreamer within mend reach, themselves
   * included, is mended, and on a fallen one within touch the Healer takes hold, beginning a raise
   * or joining the one under way. A Healer never raises themselves, since a fallen one does not
   * wield the Moonstone. Beginning needs the raise's whole spirit cost on hand, so a lone Healer can
   * finish it. Joining needs a mend's worth, and room among the most Healers one raise holds. Taking
   * hold spends the touch, as a mend does, and that is the only limit on how often a Healer takes hold.
   */
  private touch(healer: PlayerSlot, target: PlayerSlot): void {
    if (!this.canMend(healer)) return;
    if (!isFallen(target)) {
      if (mendReaches(healer.character.position, target.character.position)) this.mend(healer, target);
      return;
    }
    if (!this.touches(healer, target)) return;
    const id = healer.character.id;
    const holders = target.raise?.holders ?? [];
    if (holders.includes(id) || holders.length >= SOMNIO_PROTOCOL_CONSTANTS.maxRaiseHealers) return;
    if (rankOf(healer.character.lucidity.ranks, 'drawing-back') === 0) return;
    const needed = target.raise === undefined ? COMBAT.raise.spiritCost : COMBAT.mend.spiritCost;
    if (healer.character.energy.spiritCurrent < needed) return;
    this.spendTouch(healer);
    target.raise ??= { work: 0, accruedAt: this.now(), holders: [], shares: new Map() };
    target.raise.holders.push(id);
    if (!target.raise.shares.has(id)) target.raise.shares.set(id, { seconds: 0, charged: 0 });
    this.broadcastRaising(target, 'holding', target.raise.holders);
  }

  /** Whether the dreamer is a standing Healer holding the Moonstone in the off hand. */
  private wieldsMoonstone(healer: PlayerSlot): boolean {
    return !isFallen(healer) && healer.character.lucidity.role === 'healer' && handAllows('moonstone', healer.inventory.equipped);
  }

  /** Whether the dreamer can use the Moonstone right now: they wield it, and the last touch is past. */
  private canMend(healer: PlayerSlot): boolean {
    return this.wieldsMoonstone(healer) && this.now() >= healer.mendReadyAt;
  }

  /** The Moonstone reaches no one again until the touch interval has passed. */
  private spendTouch(healer: PlayerSlot): void {
    healer.mendReadyAt = this.now() + COMBAT.mend.seconds * 1000;
  }

  /** Whether a Moonstone reaches from one dreamer to the other to raise them. */
  private touches(healer: PlayerSlot, target: PlayerSlot): boolean {
    return reaches(healer.character.position, { ...target.character.position, radius: SOMNIO_CONSTANTS.playerRadius });
  }

  /**
   * Restores part of a standing dreamer's health for the healer's spirit, and shows everyone who
   * sees them that it landed. A mend that would give nothing spends nothing.
   */
  private mend(healer: PlayerSlot, target: PlayerSlot): void {
    const missing = target.character.energy.healthMax - target.character.energy.healthCurrent;
    if (isFallen(target) || missing <= 0 || healer.character.energy.spiritCurrent < COMBAT.mend.spiritCost) return;
    this.spendTouch(healer);
    this.setEnergy(healer, { ...healer.character.energy, spiritCurrent: healer.character.energy.spiritCurrent - COMBAT.mend.spiritCost });
    this.heal(healer.character.id, target, mendAmount(this.statsFor(healer)));
    this.broadcast({ tag: 'mend', payload: { targetId: target.character.id } }, target.sector);
  }

  /**
   * The one way health reaches a standing dreamer from a Healer: as much of `amount`, made whole, as
   * they miss. Only the raise stands a fallen dreamer up, so a fallen one is given none. The threat
   * it raises against the Healer is shared among the nightmares not driven off that hold threat
   * against the dreamer, and the Healer earns practice by it: half for mending themselves, and quest
   * progress only for mending another. A Healer no longer in the space raises nothing and earns nothing.
   */
  private heal(healerId: string, target: PlayerSlot, amount: number): void {
    const energy = target.character.energy;
    const given = isFallen(target) ? 0 : Math.min(wholeAmount(amount), energy.healthMax - energy.healthCurrent);
    if (given <= 0) return;
    this.setEnergy(target, { ...energy, healthCurrent: energy.healthCurrent + given });
    const healer = this.players.get(healerId);
    if (healer === undefined) return;
    const fighting = [...this.monsters.values()].filter((monster) => monster.lyingUntil === undefined && monster.threat.has(target.character.id));
    for (const monster of fighting) addThreat(monster, healer, (given * COMBAT.threatPerHealthMended) / fighting.length);
    if (healer === target) {
      this.addPractice(healer, given * PRACTICE.perHealthMended * PRACTICE.selfMendShare);
      return;
    }
    this.addPractice(healer, given * PRACTICE.perHealthMended);
    this.advanceQuests(healer, (objective, progress) => (objective.kind === 'mend' ? progress + given : progress));
  }

  /**
   * Recovers each standing dreamer's pools, brings the raises under way up to now, drops out the
   * Healers who no longer hold on, lands the channels whose time is up and the bolts that arrive,
   * lets each dreamer with slot 1 on act, then advances the raises.
   *
   * Raises are brought up to now before anything changes who adds their pace, so each change counts
   * from now. A raise whose time is up completes only at the step's end, and drops no one meanwhile,
   * since one completed before slot 1 acts would have its dreamer mended in the step they rose. A
   * channel lands before slot 1 acts, so slot 1 acts again in the step its channel ends. Dropping
   * out comes before the touches, so a raise its last Healer dropped out of is broken before anyone
   * else can take hold. A Healer engaged on the dreamer can then only begin a new one, at its whole
   * spirit cost.
   */
  private runPlayers(elapsedSeconds: number): void {
    for (const slot of this.players.values()) {
      if (!isFallen(slot)) this.recover(slot, elapsedSeconds);
    }
    for (const target of this.players.values()) {
      if (target.raise === undefined) continue;
      this.accrueRaise(target.raise);
      this.releaseRaise(target, target.raise);
    }
    this.runChannels();
    this.runBolts();
    this.runEngaged();
    for (const target of this.players.values()) {
      if (target.raise !== undefined) this.advanceRaise(target, target.raise);
    }
  }

  private recover(slot: PlayerSlot, elapsedSeconds: number): void {
    const energy = slot.character.energy;
    const now = this.now();
    const stats = this.statsFor(slot);
    const balance = balancePerSecond(stats) * balancePace(motionOf(slot, now), slot.winded);
    const recovered: Energy = {
      ...energy,
      healthCurrent: accrue(slot.carry, 'health', COMBAT.healthPerSecond * elapsedSeconds, energy.healthCurrent, energy.healthMax),
      balanceCurrent: accrue(slot.carry, 'balance', balance * elapsedSeconds, energy.balanceCurrent, energy.balanceMax),
      spiritCurrent: accrue(slot.carry, 'spirit', spiritPerSecond(stats) * elapsedSeconds, energy.spiritCurrent, energy.spiritMax),
    };
    if (
      recovered.healthCurrent !== energy.healthCurrent ||
      recovered.balanceCurrent !== energy.balanceCurrent ||
      recovered.spiritCurrent !== energy.spiritCurrent
    ) {
      this.setEnergy(slot, recovered);
    }
  }

  private drainBalance(slot: PlayerSlot, amount: number): void {
    slot.carry.balance -= amount;
    const whole = Math.floor(-slot.carry.balance);
    if (whole < 1) return;
    slot.carry.balance += whole;
    const energy = slot.character.energy;
    if (energy.balanceCurrent > 0) this.setEnergy(slot, { ...energy, balanceCurrent: Math.max(0, energy.balanceCurrent - whole) });
  }

  /**
   * The one place a raise breaks, and the one place a Healer drops out of one. A Healer holds on
   * only while they stay attached, engaged on the dreamer, standing, holding the Moonstone, in touch,
   * and with spirit left. One who does not drops out, taking only their pace with them. Once the
   * last has dropped out, the raise breaks off and has to start over. A raise whose time is up
   * drops no one, since the step's end completes it. A raise whose fallen dreamer leaves the space
   * goes with their slot, unannounced.
   */
  private releaseRaise(target: PlayerSlot, raise: Raise): void {
    if (raise.work >= COMBAT.raise.seconds) return;
    const before = raise.holders;
    raise.holders = before.filter((id) => {
      const healer = this.players.get(id);
      return (
        healer !== undefined &&
        healer.engaged &&
        healer.target === target.character.id &&
        this.wieldsMoonstone(healer) &&
        healer.character.energy.spiritCurrent > 0 &&
        this.touches(healer, target)
      );
    });
    if (raise.holders.length === 0) {
      target.raise = undefined;
      this.broadcastRaising(target, 'broken', before);
    } else if (raise.holders.length < before.length) {
      this.broadcastRaising(target, 'holding', raise.holders);
    }
  }

  /**
   * The one place a raise completes, and the one place a Healer pays for it. It brings the raise up
   * to now, charges each Healer the spirit for the seconds they have held, and once its time is up,
   * stands the dreamer up. Each pays in whole units, so a lone Healer pays exactly the spirit
   * cost and a group never more. One whose channel runs holds on but adds no pace and pays nothing
   * until it ends, as slot 1 holds through a channel.
   *
   * Once it is done, every Healer who held on and is still in the space earns their share of the
   * practice. The raised dreamer is left alone by nightmares for the grace time. That is slot
   * state, so it ends when they leave the space, and nightmares do not follow through a door.
   */
  private advanceRaise(target: PlayerSlot, raise: Raise): void {
    this.accrueRaise(raise);
    for (const [id, share] of raise.shares) {
      const healer = this.players.get(id);
      const due = Math.floor((COMBAT.raise.spiritCost * (share.seconds + SUM_SLACK_SECONDS)) / COMBAT.raise.seconds);
      if (healer === undefined || due <= share.charged) continue;
      this.setEnergy(healer, { ...healer.character.energy, spiritCurrent: Math.max(0, healer.character.energy.spiritCurrent - (due - share.charged)) });
      share.charged = due;
    }
    if (raise.work < COMBAT.raise.seconds) return;
    target.raise = undefined;
    target.graceUntil = this.now() + COMBAT.raise.graceSeconds * 1000;
    const energy = target.character.energy;
    this.setEnergy(target, { ...energy, healthCurrent: Math.ceil(energy.healthMax * COMBAT.raise.healthFraction) });
    this.broadcastRaising(target, 'done', raise.holders);
    this.fallenChanged();
    const held = [...raise.shares.values()].reduce((sum, share) => sum + share.seconds, 0);
    for (const [id, share] of raise.shares) {
      const healer = this.players.get(id);
      if (healer !== undefined) this.addPractice(healer, (PRACTICE.raise * share.seconds) / held);
    }
  }

  /**
   * Brings the raise's work, and each Healer's seconds held, up to now (`raiseWorkNow`). It runs
   * before anything changes who adds their pace, so each change counts from the moment it happens.
   * Spirit and completion wait for `advanceRaise`.
   */
  private accrueRaise(raise: Raise): void {
    const { work, paced } = this.raiseWorkNow(raise);
    for (const [id, seconds] of paced) raise.shares.get(id)!.seconds += seconds;
    raise.work = work;
    raise.accruedAt = this.now();
  }

  /**
   * The raise's work as of now, and the seconds each Healer holding on has held it since `accruedAt`,
   * without changing either: each adds their pace from when their channel ends, and at once without
   * one (`raiseWorkOver`), until the work reaches the raise time. Every snapshot reads it, so a
   * snapshot shows the raise as of the moment it is sent.
   */
  private raiseWorkNow(raise: Raise): { work: number; paced: Map<string, number> } {
    const paused = raise.holders.map((id) => this.secondsToPace(id, raise.accruedAt));
    const until = Math.min((this.now() - raise.accruedAt) / 1000, raiseSecondsFor(COMBAT.raise.seconds - raise.work, paused));
    const work = raise.work + raiseWorkOver(paused, until);
    return {
      work: work + SUM_SLACK_SECONDS >= COMBAT.raise.seconds ? COMBAT.raise.seconds : work,
      paced: new Map(raise.holders.map((id, index) => [id, Math.max(0, until - paused[index]!)])),
    };
  }

  /** Every raise the Healer holds on to, with the dreamer it raises. */
  private *raisesHeldBy(healerId: string): Generator<[PlayerSlot, Raise]> {
    for (const target of this.players.values()) {
      if (target.raise?.holders.includes(healerId) === true) yield [target, target.raise];
    }
  }

  /** Brings every raise the Healer holds on to up to now, before their pace changes. */
  private accrueRaisesHeldBy(healer: PlayerSlot): void {
    for (const [, raise] of this.raisesHeldBy(healer.character.id)) this.accrueRaise(raise);
  }

  /** The seconds from `from` before a Healer holding on to a raise adds their pace to it: none unless a channel of theirs runs. */
  private secondsToPace(healerId: string, from = this.now()): number {
    const channel = this.players.get(healerId)!.channel;
    return channel === undefined ? 0 : secondsLeft(channel.endsAt, from);
  }

  private broadcastRaising(target: PlayerSlot, state: RaisingState, healerIds: readonly string[]): void {
    this.broadcast(this.raisingMessage(target, state, healerIds), target.sector);
  }

  /** Shows every raise the Healer holds on to anew, as their channel starting or ending changes its pace. */
  private broadcastRaisesHeldBy(healer: PlayerSlot): void {
    for (const [target, raise] of this.raisesHeldBy(healer.character.id)) this.broadcastRaising(target, 'holding', raise.holders);
  }

  /** The raise on the dreamer as it stands, or as it ended when `state` is an end. */
  private raisingMessage(target: PlayerSlot, state: RaisingState, healerIds: readonly string[]): SomnioMessage {
    const snapshot = { targetId: target.character.id, healerIds: [...healerIds], state };
    if (state !== 'holding') return { tag: 'raising', payload: { ...snapshot, progress: state === 'done' ? 1 : 0, seconds: 0 } };
    const raise = target.raise!;
    const { work } = this.raiseWorkNow(raise);
    const paused = raise.holders.map((id) => this.secondsToPace(id));
    return {
      tag: 'raising',
      payload: {
        ...snapshot,
        progress: work / COMBAT.raise.seconds,
        seconds: raiseSecondsFor(COMBAT.raise.seconds - work, paused),
        ...(paused.some((seconds) => seconds > 0) ? { pausedSeconds: paused } : {}),
      },
    };
  }

  /**
   * Every change to a dreamer's pools. `character.energy` is their only representation, so a
   * snapshot taken right after returns them. The dreamer is told, and anyone who sees them is told
   * when their condition changed band. Winded is folded over each balance sent, as the client
   * folds it over each `energy` frame, so both sides agree on it. Checking once a step after
   * recovery would miss a swing or a hit that took balance to exactly zero.
   */
  private setEnergy(slot: PlayerSlot, energy: Energy): void {
    slot.character = { ...slot.character, energy };
    slot.winded = windedAfter(slot.winded, energy.balanceCurrent);
    slot.outbox.sendEncoded({ tag: 'energy', payload: energy }, this.logger);
    this.setCondition(slot);
  }

  /** Announces an entity's condition when its health crossed into another band. This is all another player learns of anyone's health but their target's. */
  private setCondition(entity: PlayerSlot | MonsterRuntime): void {
    const condition = conditionOf(...healthOf(entity));
    if (condition === entity.condition) return;
    entity.condition = condition;
    this.broadcast({ tag: 'condition', payload: { entityId: idOf(entity), condition } }, entity.sector);
  }

  private dropUnseenTargets(): void {
    for (const slot of this.players.values()) {
      if (slot.target !== undefined && !this.seesEntity(slot, slot.target)) slot.target = undefined;
    }
  }

  /**
   * Sends the dreamer the health share of their target: at once for one newly targeted, then on a
   * change, no sooner than the vitals interval after the last. The dreamer's own `energy` already
   * tells them their health, so they are sent none of their own.
   */
  private sendVitals(slot: PlayerSlot): void {
    const watched = slot.target === slot.character.id ? undefined : slot.target;
    if (slot.vitals?.entityId !== watched) slot.vitals = undefined;
    if (watched === undefined) return;
    const now = this.now();
    const health = this.healthShare(watched);
    const last = slot.vitals;
    if (last !== undefined && (last.health === health || now - last.at < VITALS_INTERVAL_MS)) return;
    slot.vitals = { entityId: watched, health, at: now };
    slot.outbox.sendEncoded({ tag: 'vitals', payload: { entityId: watched, health } }, this.logger);
  }

  /** An entity's health as a share of its maximum, to two decimals. An NPC is always whole. */
  private healthShare(entityId: string): number {
    const entity = this.players.get(entityId) ?? this.monsters.get(entityId);
    if (entity === undefined) return 1;
    return Math.round(poolShare(...healthOf(entity)) * 100) / 100;
  }

  /** Whether the entity is in the space and stands where the viewer sees it. */
  private seesEntity(viewer: PlayerSlot, entityId: string): boolean {
    const sector = (this.players.get(entityId) ?? this.npcs.get(entityId) ?? this.monsters.get(entityId))?.sector;
    return sector !== undefined && this.sees(viewer, sector);
  }

  /**
   * Where each fallen dreamer in the space lies but the one sensing, nearest first, as many as one
   * frame carries.
   */
  private sensedMessage(slot: PlayerSlot): SomnioMessage {
    const from = slot.character.position;
    const fallen = [...this.players.values()]
      .filter((other) => other !== slot && isFallen(other))
      .sort((a, b) => distance(from, a.character.position) - distance(from, b.character.position))
      .slice(0, SOMNIO_PROTOCOL_CONSTANTS.maxSensedBearings);
    return {
      tag: 'sensed',
      payload: { bearings: fallen.map(({ character }) => ({ name: character.name, x: character.position.x, z: character.position.z })) },
    };
  }

  /**
   * Shows every dreamer who senses the fallen, but `excluding`, where each fallen dreamer lies now. A
   * fallen dreamer does not move, so only a fall, a raise, or a coming or going changes it.
   */
  private fallenChanged(excluding?: PlayerSlot): void {
    for (const slot of this.players.values()) {
      if (slot !== excluding && sensesFallen(slot)) slot.outbox.sendEncoded(this.sensedMessage(slot), this.logger);
    }
  }

  /** Whether the player lies fallen; `false` for anyone not in this space. */
  isFallen(entityId: string): boolean {
    const slot = this.players.get(entityId);
    return slot !== undefined && isFallen(slot);
  }

  /**
   * Replaces what the dreamer has grown into, and tells them. A new rank can raise a pool's
   * maximum, which then takes effect where the rank was earned. One that lets them sense the fallen
   * shows them at once where each lies.
   */
  private updateLucidity(slot: PlayerSlot, lucidity: Lucidity): void {
    const sensed = sensesFallen(slot);
    slot.character = { ...slot.character, lucidity };
    slot.outbox.sendEncoded({ tag: 'lucidity', payload: lucidityMessage(lucidity) }, this.logger);
    if (!sensed && sensesFallen(slot)) slot.outbox.sendEncoded(this.sensedMessage(slot), this.logger);
    this.settleMaxima(slot);
  }

  /** What the dreamer's ranks and everything they wear add to the rules. */
  private statsFor(slot: PlayerSlot): Stats {
    return statsOf(slot.inventory.equipped, slot.character.lucidity);
  }

  /** Brings the dreamer's pool maxima to what their ranks and gear give, once either has changed. */
  private settleMaxima(slot: PlayerSlot): void {
    const energy = slot.character.energy;
    const maxima = maxPools(this.statsFor(slot));
    if (maxima.healthMax !== energy.healthMax || maxima.balanceMax !== energy.balanceMax || maxima.spiritMax !== energy.spiritMax) {
      this.setEnergy(slot, withinMaxima(energy, maxima));
    }
  }

  /** Adds practice toward the next rank of the teaching studied, carrying over into further ranks. Nothing accrues with no teaching studied. */
  private addPractice(slot: PlayerSlot, amount: number): void {
    const lucidity = slot.character.lucidity;
    const study = lucidity.study;
    if (study === undefined) return;
    let rank = rankOf(lucidity.ranks, study);
    let practice = (lucidity.ranks.find((held) => held.teachingId === study)?.practice ?? 0) + amount;
    let mastered = false;
    while (!mastered && practice >= practiceNeeded(rank)) {
      practice -= practiceNeeded(rank);
      rank += 1;
      mastered = rank >= teaching(study).maxRank;
    }
    this.updateLucidity(slot, {
      ...lucidity,
      ranks: withRank(lucidity.ranks, { teachingId: study, rank, practice: mastered ? 0 : practice }),
      study: mastered ? undefined : study,
    });
  }

  /** The one sink of quest progress: moves each objective of each quest the dreamer holds to what `next` makes of it, within its goal. */
  private advanceQuests(slot: PlayerSlot, next: (objective: QuestObjective, progress: number, held: Quest) => number): void {
    const quests = advancedQuests(slot.character.quests, next);
    if (quests !== slot.character.quests) this.updateQuests(slot, quests);
  }

  /** Replaces the quests the dreamer holds and turned in, and tells them, with the day's bounties. */
  private updateQuests(slot: PlayerSlot, quests: QuestLog): void {
    slot.character = { ...slot.character, quests };
    slot.outbox.sendEncoded({ tag: 'quests', payload: questsMessage(quests, this.bounties) }, this.logger);
  }

  /**
   * On a later board day than the space has reached, the board offers that day's bounties, and every
   * dreamer in the space is told them. Every bounty of another day goes from their log, held or
   * turned in, and they are told how many they held ran out. An offer of a bounty the board no longer
   * offers ends untaken. A day already reached changes nothing.
   */
  private reachBoardDay(day: number): void {
    if (this.bountyDay !== undefined && day <= this.bountyDay) return;
    this.bountyDay = day;
    this.bounties = dayBounties(day, this.bountyLands);
    for (const slot of this.players.values()) {
      const offered = slot.questOffer?.questId;
      if (offered !== undefined && isBountyId(offered) && offeredBounty(this.bounties, offered) === undefined) this.endOffer(slot, 'didNotTake');
      const { log, ranOut } = withBoardDay(slot.character.quests, day);
      this.updateQuests(slot, log);
      if (ranOut > 0) slot.outbox.sendEncoded({ tag: 'bountiesRanOut', payload: { count: ranOut } }, this.logger);
    }
  }

  /** The dreamer stands at the carrier, by its id: a quest visiting it counts the visit. */
  private visit(slot: PlayerSlot, carrierId: string): void {
    this.advanceQuests(slot, (objective, progress) => (objective.kind === 'visit' && objective.carrier === carrierId ? 1 : progress));
  }

  private giveCoins(slot: PlayerSlot, coins: number): void {
    this.addCoins(slot, coins);
    this.sendInventory(slot);
  }

  private addCoins(slot: PlayerSlot, coins: number): void {
    slot.inventory = { ...slot.inventory, coins: slot.inventory.coins + coins };
  }

  /** Takes on what the dreamer's request made of their inventory and sends it, or drops a request it refused. */
  private changeInventory(slot: PlayerSlot | undefined, changed: Inventory | undefined): void {
    if (slot === undefined || changed === undefined || changed === slot.inventory) return;
    slot.inventory = changed;
    this.sendInventory(slot);
  }

  /** Every change to what a dreamer carries goes out here. Their pool maxima follow what they wear, and what others see in their hands follows the hands. */
  private sendInventory(slot: PlayerSlot, change?: InventoryChange): void {
    slot.outbox.sendEncoded({ tag: 'inventory', payload: inventoryMessage(slot.inventory, change, slot.soldToShop) }, this.logger);
    this.settleMaxima(slot);
    this.setHeld(slot);
  }

  /** Shows everyone who sees the dreamer what their hands hold, when that changed. */
  private setHeld(slot: PlayerSlot): void {
    const held = heldOf(slot.inventory);
    if (held.mainHand === slot.held.mainHand && held.offHand === slot.held.offHand) return;
    slot.held = held;
    this.broadcast({ tag: 'held', payload: { entityId: slot.character.id, held } }, slot.sector);
  }

  /** The NPC or the fixture of the space by its carrier id: where it stands, and the service its record names. */
  private carrier(carrierId: string): { position: Point; service: Service | undefined } | undefined {
    const npc = this.npcs.get(carrierId);
    if (npc !== undefined) return { position: npc.position, service: npc.definition.service };
    const fixture = this.fixtures.get(carrierId);
    return fixture === undefined ? undefined : { position: fixture.position, service: fixture.fixture.service };
  }

  /**
   * The standing dreamer within speaking distance of the named carrier, of a fixture's placement
   * centre; `undefined` for anything else, which is dropped silently.
   */
  private carrierNear(carrierId: string, entityId: string): PlayerSlot | undefined {
    const player = this.players.get(entityId);
    const position = this.carrier(carrierId)?.position;
    if (player === undefined || position === undefined || isFallen(player) || !withinSpeakingDistance(player.character.position, position)) return undefined;
    return player;
  }

  /** The service the named carrier offers a dreamer who stands within speaking distance of it. Anything else is dropped silently. */
  private serviceFor(carrierId: string, entityId: string): { player: PlayerSlot; service: Service } | undefined {
    const player = this.carrierNear(carrierId, entityId);
    const service = this.carrier(carrierId)?.service;
    return player === undefined || service === undefined ? undefined : { player, service };
  }

  /** The carrier by its id, as the quest rules see it: a bounty board gives and takes every bounty. */
  private questCarrier(carrierId: string): QuestCarrier {
    return { id: carrierId, service: this.carrier(carrierId)?.service };
  }

  /**
   * The carrier that gives a quest hands it to a dreamer standing at it who may take it on
   * (`mayAccept`): a trial to one with no role who holds no other trial, a gate's quest to one whose
   * teaching waits on it. A bounty board hands on one of the day's bounties, stored by what it is
   * (`mayTakeBounty`). Nothing is granted on taking a quest on. Asking counts as a visit to the
   * carrier, whatever the answer.
   */
  handleAcceptQuest(carrierId: string, questId: string, entityId: string): void {
    const player = this.carrierNear(carrierId, entityId);
    if (player === undefined) return;
    this.visit(player, carrierId);
    const carrier = this.questCarrier(carrierId);
    const { quests, lucidity } = player.character;
    if (isQuestId(questId)) {
      if (questCarriedBy(quest(questId).giver, carrier) && mayAccept(questId, quests, lucidity)) this.updateQuests(player, withAccepted(quests, questId));
      return;
    }
    const bounty = offeredBounty(this.bounties, questId);
    if (bounty !== undefined && questCarriedBy(bountyQuest(bounty).giver, carrier) && mayTakeBounty(bounty, quests)) {
      this.updateQuests(player, withAcceptedBounty(quests, bounty));
    }
  }

  /**
   * The carrier that takes a quest pays for it once every objective is met. A trial makes the
   * dreamer, still without a role, the role for good, teaches the role's first teaching and sets
   * them to study it, and gives a Healer their Moonstone and a Mystic a focus, into an empty off hand
   * or else the bag. A gate teaches the first rank of its teaching. The reward's coins, practice, and
   * gear are paid besides. While an item it gives has nowhere to go, nothing is granted and the
   * quest waits, done, until there is room. A bounty pays as its stored definition says, whatever
   * the spawns did since. Asking counts as a visit to the carrier first.
   */
  handleTurnInQuest(carrierId: string, questId: string, entityId: string): void {
    const player = this.carrierNear(carrierId, entityId);
    if (player === undefined) return;
    this.visit(player, carrierId);
    if (!isQuestId(questId) && !isBountyId(questId)) return;
    const { quests, lucidity } = player.character;
    const held = turnInFor(questId, quests, lucidity);
    if (held === undefined || !questCarriedBy(heldQuest(held).turnIn, this.questCarrier(carrierId))) return;
    const reward = heldQuest(held).reward;
    const { role, teaches, trialItem, paysInventory } = turnInGrant(held);
    const trialGift = trialItem === undefined ? undefined : plainInstance(trialItem);
    const given: Item[] = trialGift === undefined ? [] : [trialGift];
    let inventory: Inventory | undefined = trialGift === undefined ? player.inventory : grantItem(player.inventory, trialGift);
    if (inventory !== undefined && reward?.gear !== undefined) {
      const gear = { id: newItemId(), ...rollQuestGear(reward.gear, role ?? lucidity.role, () => randomUnit(this.lootRandom), reward.gearRarity) };
      inventory = bagHasRoom(inventory) ? withItem(inventory, gear) : undefined;
      given.push(gear);
    }
    if (inventory === undefined) return;
    this.updateQuests(player, withTurnedIn(quests, questId));
    if (teaches !== undefined) {
      this.updateLucidity(player, {
        role: role ?? lucidity.role,
        ranks: withRank(lucidity.ranks, { teachingId: teaches, rank: 1, practice: 0 }),
        study: role === undefined ? lucidity.study : teaches,
      });
    }
    if (reward?.practice !== undefined) this.addPractice(player, reward.practice);
    if (!paysInventory) return;
    player.inventory = inventory;
    if (reward?.coins !== undefined) this.addCoins(player, reward.coins);
    this.sendInventory(player, given.length === 0 ? undefined : { rewarded: given.map((item) => lootContentsMessage({ kind: 'item', item })) });
  }

  /** Gives up a quest held, wherever the dreamer is, fallen or not; what was done toward it is gone. */
  handleAbandonQuest(questId: string, entityId: string): void {
    const player = this.players.get(entityId);
    const held = player?.character.quests.active.find((candidate) => candidate.questId === questId);
    if (player === undefined || held === undefined) return;
    this.updateQuests(player, withoutQuest(player.character.quests, held.questId));
  }

  /**
   * Shares a quest the dreamer holds, any but a trial, with every other standing dreamer of the
   * space within a said line's reach. A bounty is shared only while the board offers it today. Each
   * who cannot take it on is answered for at once. Each who can is offered it for
   * `QUEST_OFFER_SECONDS`, in place of any offer they held, but one still waiting on this sharer's
   * offer of it is left as they are and not counted. The sharer is told how many were offered it,
   * ahead of the answers, or that none were when no other dreamer stands near. Otherwise nothing more
   * is said than the answers, if any. Anything else is dropped silently.
   */
  handleShareQuest(questId: string, entityId: string): void {
    const sharer = this.players.get(entityId);
    const held = sharer?.character.quests.active.find((candidate) => candidate.questId === questId);
    if (sharer === undefined || held === undefined || isFallen(sharer) || !mayShare(held.questId)) return;
    const bounty = offeredBounty(this.bounties, held.questId);
    if (isBountyId(held.questId) && bounty === undefined) return;
    const { name, position } = sharer.character;
    const near = [...this.players.values()].filter(
      (other) => other !== sharer && !isFallen(other) && distance(other.character.position, position) < SPEECH.say.reachMetres,
    );
    const answered = near
      .filter(({ questOffer }) => !(questOffer?.questId === held.questId && questOffer.fromId === entityId))
      .map((recipient) => ({ recipient, refused: shareOutcomeFor(held.questId, bounty, recipient.character.quests, recipient.character.lucidity) }));
    const offered = answered.filter(({ refused }) => refused === undefined).length;
    if (near.length === 0 || offered > 0) sharer.outbox.sendEncoded({ tag: 'questShared', payload: { reached: offered } }, this.logger);
    const endsAt = this.now() + QUEST_OFFER_SECONDS * 1000;
    for (const { recipient, refused } of answered) {
      if (refused !== undefined) {
        sharer.outbox.sendEncoded(
          { tag: 'questShareAnswer', payload: { questId: held.questId, name: recipient.character.name, outcome: refused } },
          this.logger,
        );
        continue;
      }
      this.endOffer(recipient, 'didNotTake');
      const offerId = this.newOfferId();
      recipient.questOffer = { offerId, questId: held.questId, fromId: entityId, endsAt };
      recipient.outbox.sendEncoded({ tag: 'questOffer', payload: { offerId, fromName: name, questId: held.questId } }, this.logger);
    }
  }

  /**
   * Settles the quest offer the dreamer holds under `offerId`, and no other. Taken, the quest goes
   * into their log as the share's rules still allow, a bounty only while the board offers it today;
   * otherwise the offer ends as those rules say. Let pass, or answered past its time, it ends
   * untaken. An answer to an offer already ended or replaced changes nothing.
   */
  handleAnswerQuestOffer(offerId: number, take: boolean, entityId: string): void {
    const receiver = this.players.get(entityId);
    const offer = receiver?.questOffer;
    if (receiver === undefined || offer?.offerId !== offerId) return;
    if (!take || this.now() >= offer.endsAt) {
      this.endOffer(receiver, 'didNotTake');
      return;
    }
    const { questId } = offer;
    const bounty = offeredBounty(this.bounties, questId);
    const { quests, lucidity } = receiver.character;
    const refused = shareOutcomeFor(questId, bounty, quests, lucidity);
    if (refused === undefined && isQuestId(questId)) this.updateQuests(receiver, withAccepted(quests, questId));
    if (refused === undefined && bounty !== undefined) this.updateQuests(receiver, withAcceptedBounty(quests, bounty));
    this.endOffer(receiver, refused ?? 'took');
  }

  /** The one end of a quest offer: the dreamer holds it no longer, and its sharer, while still here, is told how it came out. */
  private endOffer(receiver: PlayerSlot, outcome: QuestShareOutcome): void {
    const offer = receiver.questOffer;
    if (offer === undefined) return;
    receiver.questOffer = undefined;
    this.players
      .get(offer.fromId)
      ?.outbox.sendEncoded({ tag: 'questShareAnswer', payload: { questId: offer.questId, name: receiver.character.name, outcome } }, this.logger);
  }

  /** A master sets a dreamer of their role to study a teaching they may build on: its needs met, below its last rank, and past its gate if it has one. */
  handleStudy(carrierId: string, teachingId: string, entityId: string): void {
    const asked = this.serviceFor(carrierId, entityId);
    if (asked === undefined || !isTeachingId(teachingId)) return;
    const lucidity = asked.player.character.lucidity;
    if (lucidity.role === undefined || lucidity.role !== masterRole(asked.service) || teaching(teachingId).role !== lucidity.role) return;
    if (teachingStanding(lucidity.ranks, teachingId) !== 'open') return;
    this.updateLucidity(asked.player, { ...lucidity, study: teachingId });
  }

  /**
   * The shopkeeper sells a dreamer a plain one of a ware, for its price, into a bag with room. The
   * coins and the new item go out together in one `inventory` frame that says what was bought.
   * Anything else is dropped silently.
   */
  handleBuy(carrierId: string, baseId: string, entityId: string): void {
    const asked = this.serviceFor(carrierId, entityId);
    if (asked?.service !== 'shopkeeper' || !canBuy(asked.player.inventory, baseId)) return;
    const coins = price(baseId);
    const bought = plainInstance(baseId);
    this.addCoins(asked.player, -coins);
    asked.player.inventory = withItem(asked.player.inventory, bought);
    this.sendInventory(asked.player, { trade: { kind: 'bought', baseId, rarity: bought.rarity, coins } });
  }

  /**
   * The shopkeeper buys an item from the dreamer's bag, for its sale price, but never the Moonstone,
   * and holds it for them to buy back. Anything else is dropped silently.
   */
  handleSell(carrierId: string, itemId: string, entityId: string): void {
    const asked = this.serviceFor(carrierId, entityId);
    const sold = asked === undefined ? undefined : sellableItem(asked.player.inventory, itemId);
    if (asked?.service !== 'shopkeeper' || sold === undefined) return;
    const coins = salePrice(sold);
    asked.player.inventory = withoutItem(asked.player.inventory, sold.id);
    asked.player.soldToShop = soldToShopAfterSale(asked.player.soldToShop, sold);
    this.addCoins(asked.player, coins);
    this.sendInventory(asked.player, { trade: { kind: 'sold', baseId: sold.baseId, rarity: sold.rarity, coins } });
  }

  /**
   * The shopkeeper sells a dreamer back an item they sold him, as it was and under its own id, for
   * what he paid, into a bag with room. Anything else is dropped silently.
   */
  handleBuyBack(carrierId: string, itemId: string, entityId: string): void {
    const asked = this.serviceFor(carrierId, entityId);
    const item = asked === undefined ? undefined : buyBackable(asked.player.inventory, asked.player.soldToShop, itemId);
    if (asked?.service !== 'shopkeeper' || item === undefined) return;
    const coins = salePrice(item);
    asked.player.soldToShop = asked.player.soldToShop.filter((sold) => sold !== item);
    this.addCoins(asked.player, -coins);
    asked.player.inventory = withItem(asked.player.inventory, item);
    this.sendInventory(asked.player, { trade: { kind: 'boughtBack', baseId: item.baseId, rarity: item.rarity, coins } });
  }

  /** One snapshot per player, bumping `lastSeen` so the `last_seen` guard can order it against a racing snapshot of theirs. */
  snapshotForCheckpoint(): PlayerCheckpoint[] {
    const now = new Date();
    return [...this.players.values()].map((slot) => this.checkpointOf(slot, now));
  }

  snapshotForPlayer(entityId: string): PlayerCheckpoint | undefined {
    const slot = this.players.get(entityId);
    return slot === undefined ? undefined : this.checkpointOf(slot, new Date());
  }

  /** The player's checkpoint as of `now`, its `lastSeen` strictly after their last one's, so two taken in one millisecond still order. */
  private checkpointOf(slot: PlayerSlot, now: Date): PlayerCheckpoint {
    slot.character = { ...slot.character, lastSeen: nextLastSeen(slot.character.lastSeen, now) };
    return { character: slot.character, inventory: slot.inventory };
  }

  /** Whether a body of `radius` at the point would overlap a player, an NPC, or a monster but `except`. A fallen body still counts; a lying monster does not. */
  private overlapsEntity(point: Point, radius: number, except?: MonsterRuntime): boolean {
    for (const slot of this.players.values()) {
      if (distance(point, slot.character.position) < radius + SOMNIO_CONSTANTS.playerRadius) return true;
    }
    if (this.npcBodies.some((npc) => distance(point, npc) < radius + npc.radius)) return true;
    for (const monster of this.monsters.values()) {
      if (monster === except || monster.lyingUntil !== undefined) continue;
      if (distance(point, monster.position) < radius + monster.kind.radius) return true;
    }
    return false;
  }

  private sees(viewer: PlayerSlot, sector: string): boolean {
    return this.interest.get(viewer.sector)!.has(sector);
  }

  /** Encode once and fan out to every player who can see `sector`, but for `excluding`. */
  private broadcast(message: SomnioMessage, sector: string, excluding?: string): void {
    const frame = encodeOrWarn(message, this.logger);
    if (frame === undefined) return;
    for (const [id, viewer] of this.players) {
      if (id !== excluding && this.sees(viewer, sector)) viewer.outbox.send(frame);
    }
  }

  private sectorMessage(name: string): SomnioMessage {
    const sector = sectorView(this.space.sectors.find((held) => held.name === name)!);
    const outdoorDoorIds = this.outdoorDoorIds.get(name)!;
    return { tag: 'sector', payload: { sector, ...(outdoorDoorIds.length === 0 ? {} : { outdoorDoorIds }) } };
  }

  /** Every entity but the player `excluding`, with the sector it stands in. */
  private entities(excluding?: string): { sector: string; entity: EntityMessage }[] {
    const result: { sector: string; entity: EntityMessage }[] = [];
    for (const [id, slot] of this.players) {
      if (id !== excluding) result.push({ sector: slot.sector, entity: this.playerEntity(slot) });
    }
    for (const npc of this.npcs.values()) result.push({ sector: npc.sector, entity: this.npcEntity(npc) });
    for (const monster of this.monsters.values()) result.push({ sector: monster.sector, entity: this.monsterEntity(monster) });
    return result;
  }

  private playerEntity(slot: PlayerSlot): EntityMessage {
    return {
      id: slot.character.id,
      kind: 'player',
      characterModelId: this.playerModel,
      name: slot.character.name,
      radius: SOMNIO_CONSTANTS.playerRadius,
      x: slot.character.position.x,
      z: slot.character.position.z,
      facing: slot.character.facing,
      gait: slot.gait,
      condition: slot.condition,
      held: slot.held,
    };
  }

  private npcEntity(npc: NPCRuntime): EntityMessage {
    return {
      id: npc.id,
      kind: 'npc',
      characterModelId: npc.definition.characterModelId,
      name: npc.definition.name,
      radius: SOMNIO_CONSTANTS.npcRadius,
      x: npc.position.x,
      z: npc.position.z,
      facing: npc.definition.facing,
      gait: DEFAULT_GAIT,
      condition: 'hale',
      ...(npc.definition.service === undefined ? {} : { service: npc.definition.service }),
    };
  }

  private monsterEntity(monster: MonsterRuntime): EntityMessage {
    const rank = nightmareRankOf(monster);
    return {
      id: monster.id,
      kind: 'monster',
      characterModelId: monster.kind.characterModelId,
      name: monster.kind.name,
      radius: monster.kind.radius,
      x: monster.position.x,
      z: monster.position.z,
      facing: monster.facing,
      gait: DEFAULT_GAIT,
      condition: monster.condition,
      ...(rank === undefined ? {} : { rank }),
      ...(monster.trait === undefined ? {} : { trait: monster.trait }),
    };
  }
}

/** The space's live doors whose counterparts lie in other spaces, with both openings. A pair within one space carries no voice: it is already heard there. */
function doorwaysOut(world: LoadedWorld, space: Space<Sector>): Doorway[] {
  const doorways: Doorway[] = [];
  for (const sector of space.sectors) {
    for (const door of sector.doors) {
      const counterpart = counterpartOf(world, door);
      if (counterpart.spaceId === space.id) continue;
      doorways.push({ near: resolveDoor(sector, door, world.registry)!.doorway, spaceId: counterpart.spaceId, far: counterpart.resolved.doorway });
    }
  }
  return doorways;
}

/**
 * Adds `amount` to a pool's carry and returns the pool with the whole units moved into it, up to
 * `max`. At the maximum the units are dropped, so nothing banks up there.
 */
function accrue(carry: PlayerSlot['carry'], pool: keyof PlayerSlot['carry'], amount: number, current: number, max: number): number {
  carry[pool] += amount;
  const whole = Math.floor(carry[pool]);
  if (whole < 1) return current;
  carry[pool] -= whole;
  return Math.min(max, current + whole);
}
