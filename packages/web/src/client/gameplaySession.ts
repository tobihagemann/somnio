import { PROTOCOL_BYTE_CAPS, assertNever, truncateToUTF8Bytes } from '@somnio/protocol';
import type {
  AbilityPhase,
  Condition,
  CooldownsMessage,
  DoorRefusedMessage,
  Energy,
  EntityMove,
  EquipSlot,
  LootContentsMessage,
  LootMessage,
  LucidityMessage,
  RaisingMessage,
  SayMessage,
  SensedBearingMessage,
  Service,
  SomnioMessage,
  TelegraphMessage,
  TradeMessage,
} from '@somnio/protocol';
import {
  COMBAT,
  GLOBAL_COOLDOWN_SECONDS,
  PICKUP_REACH,
  SOMNIO_CONSTANTS,
  abilitiesTaught,
  ability,
  abilityCooldownSeconds,
  abilityRefusal,
  abilityRank,
  attackRefusal,
  bagHasRoom,
  bountiesOf,
  carriesQuests,
  doorOpenAt,
  droppableItem,
  engageAction,
  gaitAllowed,
  handAllows,
  heading,
  heldQuest,
  headingFromVector,
  inventoryOf,
  isAbilityId,
  isEffectId,
  isTeachingId,
  moveItem,
  NO_INVENTORY,
  NO_QUESTS,
  markerFor,
  objectiveLines,
  poolShare,
  quest,
  questComplete,
  questsOf,
  turnInGrant,
  windedAfter,
  windedOnJoin,
  withinSpeakingDistance,
} from '@somnio/core';
import type {
  AbilityId,
  AbilityRefusal,
  ActiveQuest,
  AttackRefusal,
  Bounty,
  EffectId,
  EngageAction,
  Inventory,
  ObjectiveLine,
  Point,
  QuestCarrier,
  QuestLog,
  QuestMarker,
  QuestOrBountyId,
} from '@somnio/core';
import { bubbleLifetimeMs, canvasWidthMeasurer, wrapSpeech } from '@/scene/speechBubbleText';
import { wheelDeltaToZoomDelta } from '@/scene/cameraRig';
import { committedNPCNames } from '@/splash/sectors';
import { parseChatInput } from './chatCommand';
import { abilityBody, drivenOff, engageKind } from './clientWorld';
import type { ClientEntity } from './clientWorld';
import type { RaiseProgress } from './renderSurface';
import { compassPoint } from './compass';
import type { ConnectionController, GameplayMessage } from './connectionController';
import { GameplayPredictor } from './predictor';
import { RemoteInterpolation } from './remoteInterpolation';
import { PlayerZoom } from './input';

/**
 * The gameplay half of the client: it owns the predictor, the input samplers, and every inbound
 * frame the controller forwards as a `GameplayMessage`.
 *
 * The split is explicit rather than implied. `ConnectionController` handles `hello`, the login and
 * register results, the two session-token frames, and the frames that build the space (`enterSpace`,
 * `sector`, `entity`, `leave`); everything else lands here. Leaving that boundary implicit is how a
 * tag ends up owned by neither half — which the exhaustive switch below and the controller's own
 * `assertNever` guard together make impossible.
 */

const ZERO_ENERGY: Energy = {
  healthCurrent: 0,
  healthMax: 1,
  balanceCurrent: 0,
  balanceMax: 1,
  spiritCurrent: 0,
  spiritMax: 1,
};

/**
 * What the player can act on for a service or a quest: an NPC in view, or a fixture of a held
 * sector, which is never an entity.
 */
export interface ServiceCarrier {
  id: string;
  /** An NPC's name; a fixture goes by its service. */
  name: string | undefined;
  /** Where it stands, a fixture at its placement's centre: speaking distance is measured from here. */
  position: Point;
  /** The service its record names. */
  service: Service | undefined;
}

/** Whether a carrier has a panel to open: a service of its own, or quests to give or take. */
export function offersService(carrier: ServiceCarrier): boolean {
  return carrier.service !== undefined || carriesQuests(carrier.id);
}

/** The lucidity frame of a dreamer who has grown into nothing yet, until the server sends theirs. */
export const NO_LUCIDITY_MESSAGE: LucidityMessage = { ranks: [] };

/** A cooldown on the session's clock, as the server last told of it: when it began and when it ends. */
export interface CooldownSpan {
  startedAtMs: number;
  endsAtMs: number;
  /** Whether it is the short wait every ability use starts, rather than an ability's own. */
  global: boolean;
}

/** What an ability's slot on the belt shows. */
export interface AbilitySlotState {
  abilityId: AbilityId;
  /** The rank the player holds of the teaching that teaches it. */
  rank: number;
  /** Why the server would not act on it now, but for its cooldowns; `undefined` when it would. */
  refusal: AbilityRefusal | undefined;
  /** The cooldown it waits on while one runs: the later-ending of its own and the global one. */
  cooldown: CooldownSpan | undefined;
}

/**
 * A channel an entity has under way, as the client keeps it on the session's clock: since when, as
 * far as it knows, and until when. A channel it learned of only under way counts from then.
 */
export interface ClientChannel {
  abilityId: AbilityId;
  startedAtMs: number;
  endsAtMs: number;
}

/**
 * A raise under way on a fallen dreamer, as its last snapshot states it, kept on the session's clock:
 * the Healers holding on whose names it knows, when the snapshot arrived, and when the raise will be
 * done at the pace it states.
 */
export interface ClientRaise extends RaiseProgress {
  healerNames: string[];
  atMs: number;
  endsAtMs: number;
}

/**
 * A quest turned in and what it paid, from the frames that answered the turn-in: the coins gained
 * and each item given, with the teaching studied as it was turned in, which its practice went toward.
 */
export interface QuestTurnedIn {
  held: ActiveQuest;
  study: string | undefined;
  coins: number | undefined;
  items: Extract<LootContentsMessage, { kind: 'item' }>[];
}

/**
 * What a `quests` frame after the baseline moved, for the HUD to show over the world: a quest taken
 * on, a line of a quest held that came further, a quest held that is now done, or one turned in.
 */
export type QuestNews =
  | { kind: 'accepted'; held: ActiveQuest }
  | { kind: 'progress'; held: ActiveQuest; line: ObjectiveLine }
  | { kind: 'done'; held: ActiveQuest }
  | ({ kind: 'turnedIn' } & QuestTurnedIn);

/** An effect an entity holds, as the client keeps it: when it ends on the session's clock, or never while its holder lasts. */
export interface ClientEffect {
  effectId: EffectId;
  endsAtMs?: number;
}

interface Cooldowns {
  global: CooldownSpan | undefined;
  abilities: Partial<Record<AbilityId, CooldownSpan>>;
}

const NO_COOLDOWNS: Cooldowns = { global: undefined, abilities: {} };

/** The whole seconds left until `endsAtMs`, rounded up, as a countdown shows them; never below 0. */
export function wholeSecondsLeft(endsAtMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((endsAtMs - nowMs) / 1000));
}

/** The share done and the schedule a `raising` snapshot states, without its Healers. */
function raiseProgress({ progress, seconds, pausedSeconds }: RaisingMessage): RaiseProgress {
  return { progress, seconds, ...(pausedSeconds === undefined ? {} : { pausedSeconds }) };
}

/** How long a press on the ground is held before the player steers toward the pointer rather than walking to where it lands. */
export const HOLD_TO_STEER_MS = 180;
/** How far on the page a press may wander and still be a tap; a press that moves further steers at once. */
export const TAP_SLOP_PX = 12;

/** How long the shop's buttons wait for a trade's answer. A refused trade gets none, so the lock gives way on its own. */
const TRADE_ANSWER_TIMEOUT_MS = 1500;
/** How long they stay locked after the answer, so a double click trades once. */
const TRADE_SETTLE_MS = 500;
/** How long an ability use waits for the server's `cooldowns` answer. A refused use gets none, so the wait gives way on its own. */
const ABILITY_ANSWER_TIMEOUT_MS = 1000;

export interface GameplaySessionOptions {
  controller: ConnectionController;
  send: (message: SomnioMessage) => void;
  /** Whether the pointer is a finger, which has no cursor to face. */
  coarsePointer?: boolean;
  /**
   * Text measurer for speech-bubble wrapping. Defaults to the canvas measurer, which the wrap
   * must agree with or lines overflow the balloon; injectable so a headless test needs no canvas.
   */
  measureText?: (line: string) => number;
  /** The clock remote reports are stamped with; the same timeline `runTick` is driven on. */
  now?: () => number;
}

export class GameplaySession {
  readonly predictor: GameplayPredictor;
  readonly zoom = new PlayerZoom();

  energy: Energy = ZERO_ENERGY;
  inventory: Inventory = NO_INVENTORY;
  lucidity: LucidityMessage = NO_LUCIDITY_MESSAGE;
  /** The quests the player holds and turned in, as the last `quests` frame said. */
  quests: QuestLog = NO_QUESTS;
  /** The bounties of the world day, as the last `quests` frame said. */
  bounties: Bounty[] = [];
  /** The marker each carrier shows the player, by its id, as the scene was last told: in view or not. */
  questMarkers: ReadonlyMap<string, QuestMarker> = new Map();
  /** Whether the player's balance gave out. Kept as the server keeps it: from each `energy` frame, in order. */
  winded = false;
  /** The carrier whose service panel is open. It does not close the input gate: the player walks away from it. */
  servicePanel: ServiceCarrier | undefined;
  /** The entity the player acts on, as the server was last told. */
  target: string | undefined;
  /**
   * Whether the player faces their target whatever the cursor does, on a fine pointer. A right
   * press on a body sets it, and it ends with the target, on a second right press on the target, or
   * on a right press on the ground. A right press on a body switches slot 1 with it, but the 1 key
   * switches slot 1 alone, and a right press on the ground ends the lock alone.
   */
  gazeLocked = false;
  /** Whether Run is on. A winded player walks whatever it says, and one an effect holds below a run jogs. */
  running = false;
  /**
   * Whether slot 1 is on, as the server keeps it. The server sends nothing when it switches slot 1
   * off, so the client applies the same rule: on at a new target it can act on, off at any other, at
   * the target lost, at a fall, and at a new space.
   */
  engaged = false;

  /**
   * What has arrived since `enterSpace`. The first frame of each kind in a space states what is,
   * so it sets `winded` from the balance alone and announces nothing; every later one is compared
   * with the one before.
   */
  private seen = { energy: false, inventory: false, lucidity: false, quests: false };
  /** A quest turned in whose news waits for the `inventory` frame of what it paid. */
  private turningIn: Omit<QuestTurnedIn, 'coins' | 'items'> | undefined;
  /** The fallen dreamers whose raise this player was last told they hold on to. */
  private readonly heldRaises = new Set<string>();
  /** Set from sending `wake` until the `enterSpace` that answers it, or until the player stands again because a raise came first. */
  private waking = false;
  /**
   * A press on the ground still down: where it landed, where on the ground it points now, when it
   * began, and whether it steers. It points nowhere from a new space's `enterSpace` until the
   * player stands there.
   */
  private hold: { landed: Point; point: Point | undefined; startedAtMs: number; steering: boolean } | undefined;
  /** Whether the press ring lies at the destination of the walk a press let go of, until that walk ends. */
  private destinationMarked = false;
  private slowedUntilMs = 0;
  /** When the shop's buttons give way, or 0 once the tick has redrawn them free. */
  private tradeLockedUntilMs = 0;

  private readonly controller: ConnectionController;
  private readonly send: (message: SomnioMessage) => void;
  private readonly measureText: (line: string) => number;
  private readonly now: () => number;
  private readonly interpolation = new RemoteInterpolation();
  private readonly coarsePointer: boolean;
  /** The point under the cursor the player aims at. */
  private aimPoint: Point | undefined;
  /** The health share last sent of the target. */
  private targetHealth: number | undefined;
  /** The effects the server last sent of the player and of their target, the only ones it sends. */
  private readonly heldEffects = new Map<string, ClientEffect[]>();
  /**
   * The cooldowns of the belt's abilities, from the server's last `cooldowns` frame. A new space
   * starts with none until the snapshot the join sends arrives.
   */
  private cooldowns: Cooldowns = NO_COOLDOWNS;
  /** Until when no ability is used again, from a use until the `cooldowns` frame that answers it, or 0 with none awaited. */
  private awaitingUseUntilMs = 0;
  /**
   * Whether the walk under way waits for the player's own channel, from its use until it lands or
   * breaks, or until its answer is overdue. A new press lets it go.
   */
  private walkWaitsForChannel = false;
  /** Each ability slot's refusal and whether a cooldown runs, as the tick last saw them, so the tick runs the state hook again only when one changes. */
  private shownAbilitySlots = '[]';
  /** The channels under way that the server has shown, by their user, until each lands or breaks. */
  private readonly channels = new Map<string, ClientChannel>();
  /** The raises under way in view, by the fallen dreamer, from each `raising` snapshot until it ends or they leave view. */
  private readonly raises = new Map<string, ClientRaise>();
  /** Where each fallen dreamer in the space lies, as the server last said; none for a player who does not sense the fallen. */
  sensed: readonly SensedBearingMessage[] = [];
  /**
   * The telegraphs told of in this space, by id, each with when it strikes. One goes with its caster
   * leaving view, and one that struck as the next arrives; `telegraphsUnderWay` reads only those still running.
   */
  private readonly telegraphs = new Map<string, TelegraphMessage & { endsAtMs: number }>();
  /** The drops lying on the ground for the player, or for anyone, by id, from each `loot` frame until its `lootGone` or a new space. */
  readonly loot = new Map<string, LootMessage>();

  constructor(options: GameplaySessionOptions) {
    this.controller = options.controller;
    this.send = options.send;
    this.coarsePointer = options.coarsePointer ?? false;
    this.measureText = options.measureText ?? canvasWidthMeasurer();
    this.now = options.now ?? (() => performance.now());
    this.predictor = new GameplayPredictor({
      session: this.controller,
      renderSurface: this.controller.renderSurface,
      interpolation: this.interpolation,
      send: this.send,
      lookAt: () => this.lookAt(),
      running: () => this.running,
      winded: () => this.winded,
      effects: () => this.ownEffects,
      fallen: () => this.fallen,
      slowed: (nowMs) => nowMs < this.slowedUntilMs,
      heldStill: () => this.walkWaitsForChannel,
    });

    this.controller.onGameplayMessage = (message) => this.dispatch(message);
    // Chat focus lets go of a held press here, so a stale hold cannot resume when focus returns.
    this.controller.onGateClosed = () => this.letGo();
    this.controller.onSpaceEntered = () => {
      this.resetSpaceState();
      // A press held through a door steers on in the space it leads to. What it pointed at belongs
      // to the space left, so it waits for the ground under the pointer there.
      if (this.hold !== undefined) this.hold = { ...this.hold, point: undefined, steering: true };
      this.aimPoint = undefined;
      if (this.waking) this.controller.appendChat({ kind: 'wokeWeakened' });
      this.waking = false;
    };
    this.controller.onEntityReset = (entityId) => {
      this.interpolation.delete(entityId);
      // The server lets go of a target leaving view as it leaves, so it is let go here on the same frame,
      // not on the next tick, by which time it may be back in view though no longer targeted there.
      if (entityId === this.target && !this.controller.entities.has(entityId)) this.select(undefined);
      // A fallen dreamer who leaves takes their raise along without a `raising` frame, so the player holds it no more.
      this.heldRaises.delete(entityId);
      if (!this.controller.entities.has(entityId)) {
        this.channels.delete(entityId);
        this.raises.delete(entityId);
        for (const [id, telegraph] of this.telegraphs) if (telegraph.casterId === entityId) this.telegraphs.delete(id);
      }
      // An NPC's marker is judged from its entity frame as it comes into view, before the scene places it,
      // and dropped as a marked carrier leaves.
      if (this.controller.entities.get(entityId)?.kind === 'npc' || this.questMarkers.has(entityId)) this.showQuestMarkers();
      // The player's own entity carries their condition, which is what the fallen notice follows.
      if (entityId === this.controller.selfId) this.onStateChanged?.();
    };
    this.controller.onSelfConditionChanged = (condition) => this.handleOwnCondition(condition);
    this.controller.onSectorArrived = () => this.showQuestMarkers();
    this.controller.onTeardown = () => {
      this.letGo();
      this.resetSpaceState();
      this.running = false;
      this.energy = ZERO_ENERGY;
      this.inventory = NO_INVENTORY;
      this.lucidity = NO_LUCIDITY_MESSAGE;
      this.quests = NO_QUESTS;
      this.bounties = [];
      this.questMarkers = new Map();
      this.controller.renderSurface.showQuestMarkers(this.questMarkers);
      this.winded = false;
      this.waking = false;
    };
  }

  /** Whether the player lies fallen. Their own entity's condition says so, never a health of zero in an `energy` frame. */
  get fallen(): boolean {
    const selfId = this.controller.selfId;
    return selfId !== undefined && this.controller.entities.get(selfId)?.condition === 'fallen';
  }

  /** Everything that belongs to the space being left, a pending door included. */
  private resetSpaceState(): void {
    this.predictor.reset();
    this.predictor.stop();
    this.liftDestinationMarker();
    this.predictor.releaseDoor(true);
    this.interpolation.clear();
    this.seen = { energy: false, inventory: false, lucidity: false, quests: false };
    this.turningIn = undefined;
    this.servicePanel = undefined;
    this.heldRaises.clear();
    this.slowedUntilMs = 0;
    this.tradeLockedUntilMs = 0;
    // The server holds the target per space, so a new space starts with nothing targeted there either.
    this.target = undefined;
    this.gazeLocked = false;
    this.engaged = false;
    this.targetHealth = undefined;
    // The join sends again the effects and cooldowns carried through a door or a wake.
    this.heldEffects.clear();
    this.channels.clear();
    this.raises.clear();
    this.sensed = [];
    this.telegraphs.clear();
    // A join sends again the dreamer's own drops lying in the space they enter and what lies for anyone in view.
    this.loot.clear();
    this.cooldowns = NO_COOLDOWNS;
    this.awaitingUseUntilMs = 0;
    this.walkWaitsForChannel = false;
    this.markTarget();
  }

  /** The per-frame body. Injected timestamp, so a test drives it directly. */
  runTick(timestampMs: number): void {
    if (this.hold !== undefined && timestampMs - this.hold.startedAtMs >= HOLD_TO_STEER_MS) this.hold.steering = true;
    if (this.hold?.steering === true && this.hold.point !== undefined) this.predictor.steerToward(this.hold.point);
    if (this.walkWaitsForChannel && !this.channelUnderWay) this.walkWaitsForChannel = false;
    this.predictor.runTick(timestampMs);
    // However the walk a press let go of ends, its ring goes with it.
    if (this.predictor.walk === undefined) this.liftDestinationMarker();
    this.closeServicePanelBeyondSpeakingDistance();
    if (this.gazeLocked && !this.gazeHolds) this.unlockGaze();
    if (this.engaged && !this.engageable) this.stopEngaging();
    if (this.tradeLockedUntilMs !== 0 && !this.tradeLocked()) {
      this.tradeLockedUntilMs = 0;
      this.onStateChanged?.();
    }
    // An ability comes in range or out of it as bodies move, and leaves its cooldown with time.
    const abilitySlots = JSON.stringify(this.abilitySlots().map(({ refusal, cooldown }) => [refusal ?? null, cooldown !== undefined]));
    if (abilitySlots !== this.shownAbilitySlots) {
      this.shownAbilitySlots = abilitySlots;
      this.onStateChanged?.();
    }
  }

  private get self(): ClientEntity | undefined {
    const selfId = this.controller.selfId;
    return selfId === undefined ? undefined : this.controller.entities.get(selfId);
  }

  /**
   * Whether a click acts on the world: attached, no overlay up, and the player standing in the
   * space. Until they stand in a space just entered, the camera still frames the one left.
   */
  private get acting(): boolean {
    return this.controller.connectionState === 'attached' && this.controller.presentedOverlay === undefined && this.self !== undefined && !this.fallen;
  }

  /**
   * A press on an entity's body, which never walks the player and makes the entity the target. An
   * NPC within speaking distance is also asked to go on, which opens what it offers.
   */
  pressEntity(entityId: string): void {
    const self = this.self;
    const entity = this.controller.entities.get(entityId);
    if (self === undefined || entity === undefined || !this.acting) return;
    this.select(entityId);
    if (entity.kind === 'npc' && withinSpeakingDistance(self.position, entity.position)) this.interact(entityId);
  }

  /**
   * A press on a fixture's drawn model. A fixture is no target, so the press walks the player into
   * speaking distance of its placement's centre and uses it there, after the final `move`. The
   * centre lies inside what the model blocks, so the walk stops short of it, wherever it comes in
   * range. From within speaking distance it is used at once.
   */
  pressFixture(carrierId: string): void {
    const self = this.self;
    const fixture = this.carrierOf(carrierId);
    if (self === undefined || fixture === undefined || !this.acting) return;
    if (withinSpeakingDistance(self.position, fixture.position)) {
      this.interact(carrierId);
      return;
    }
    this.liftDestinationMarker();
    this.walkWaitsForChannel = false;
    this.predictor.walkTo(fixture.position, { within: SOMNIO_CONSTANTS.speakingDistance, act: () => this.interact(carrierId) });
  }

  /** Acts on a carrier the player stands at, from where they stand, and opens its panel when it offers a service. */
  private interact(carrierId: string): void {
    const carrier = this.carrierOf(carrierId);
    if (carrier === undefined) return;
    this.predictor.flush();
    this.send({ tag: 'interact', payload: { carrierId } });
    if (offersService(carrier)) this.openServicePanel(carrier);
  }

  /** The NPC in view or the fixture of a held sector going by the carrier id. */
  private carrierOf(carrierId: string): ServiceCarrier | undefined {
    const npc = this.controller.entities.get(carrierId);
    if (npc?.kind === 'npc') return { id: carrierId, name: npc.name, position: npc.position, service: npc.service };
    const fixture = this.controller.world?.fixtures.find((candidate) => candidate.id === carrierId);
    return fixture === undefined ? undefined : { id: carrierId, name: undefined, position: fixture.position, service: fixture.fixture.service };
  }

  /**
   * A right press on an entity's body makes it the target and locks the player's facing on it, if it
   * is there to face, and switches slot 1 on wherever it can act on it. A right press on the target
   * already locked ends the lock and switches slot 1 off, and keeps the target. The player's own
   * body is ignored.
   */
  toggleGazeOn(entityId: string): void {
    if (!this.acting || entityId === this.controller.selfId || !this.controller.entities.has(entityId)) return;
    const locking = entityId !== this.target || !this.gazeLocked;
    if (locking) {
      this.select(entityId);
      if (!this.gazeHolds) return;
    }
    this.gazeLocked = locking;
    const engaging = locking && this.engageable;
    if (engaging !== this.engaged) {
      this.engaged = engaging;
      this.send({ tag: 'engage', payload: { on: engaging } });
    }
    this.markTarget();
    this.onStateChanged?.();
  }

  /** Ends the gaze lock: the player faces the cursor again, and keeps the target and slot 1 as they are. */
  unlockGaze(): void {
    if (!this.gazeLocked) return;
    this.gazeLocked = false;
    this.markTarget();
    this.onStateChanged?.();
  }

  /** Marks the target in the scene: in gold while slot 1 acts on it, and as a reticle while the gaze is locked on it. */
  private markTarget(): void {
    this.controller.renderSurface.showSelection(this.target, { locked: this.gazeLocked, acting: this.engaged });
  }

  /** Whether the target is still there to face: in view, and not a nightmare driven off. */
  private get gazeHolds(): boolean {
    const target = this.target === undefined ? undefined : this.controller.entities.get(this.target);
    return target !== undefined && !drivenOff(target);
  }

  /** A press on the player's own frame: they target themselves. */
  pressOwnFrame(): void {
    const selfId = this.controller.selfId;
    if (selfId !== undefined && this.acting) this.select(selfId);
  }

  /** A press on a name in the Players list: that dreamer becomes the target, while in view. */
  pressPlayerName(name: string): void {
    const dreamer = [...this.controller.entities.values()].find((entity) => entity.kind === 'peer' && entity.name === name);
    if (dreamer !== undefined && this.acting) this.select(dreamer.id);
  }

  /**
   * A press on open ground at `point`. A tap walks to where it landed; held past `HOLD_TO_STEER_MS`,
   * or moved past `TAP_SLOP_PX`, the player steers toward the ground under the pointer.
   */
  pressGround(point: Point, timestampMs: number): void {
    if (!this.acting) return;
    this.liftDestinationMarker();
    // A walk waiting for the player's channel ends, so the walk this press makes breaks the channel.
    if (this.walkWaitsForChannel) {
      this.walkWaitsForChannel = false;
      this.predictor.stop();
    }
    // The walk under way goes on until the press lets go, but no longer to pick anything up.
    this.predictor.dropArrival();
    this.hold = { landed: point, point, startedAtMs: timestampMs, steering: false };
    this.controller.renderSurface.showPressMarker(point);
  }

  /** Where on the ground the press still down points now. Before the player stands in a space just entered, it points nowhere yet. */
  moveHold(point: Point): void {
    const hold = this.hold;
    if (hold === undefined || this.self === undefined) return;
    hold.point = point;
    if (hold.steering) this.controller.renderSurface.showPressMarker(point);
  }

  /** The press still down moved too far to be a tap, so the player steers from now on. */
  steer(): void {
    if (this.hold !== undefined) this.hold.steering = true;
  }

  /**
   * A press on a drop, the player's own or one lying for anyone: they walk into pickup reach of it,
   * which may be short of where it lies, and pick it up as they arrive.
   */
  pressLoot(lootId: string): void {
    const loot = this.loot.get(lootId);
    if (loot === undefined || !this.acting) return;
    this.liftDestinationMarker();
    this.walkWaitsForChannel = false;
    this.predictor.walkTo({ x: loot.x, z: loot.z }, { within: PICKUP_REACH, act: () => this.pickUp(lootId) });
  }

  /** Asks for a drop still lying there. A full bag, which the server would refuse an item for, is said in chat instead, and the drop stays. */
  private pickUp(lootId: string): void {
    const loot = this.loot.get(lootId);
    if (loot === undefined) return;
    if (loot.contents.kind === 'item' && !bagHasRoom(this.inventory)) {
      this.controller.appendChat({ kind: 'bagFull' });
      return;
    }
    this.send({ tag: 'pickUp', payload: { lootId } });
  }

  /**
   * The press came up, with the pointer over `point` on the ground. A tap walks along a path to
   * where it landed, and a steer walks on to where it let go. The ring stays at that destination
   * until the walk ends.
   */
  release(point: Point | undefined): void {
    const hold = this.hold;
    if (hold === undefined) return;
    this.hold = undefined;
    const destination = !this.acting ? undefined : hold.steering ? (point ?? hold.point) : hold.landed;
    if (destination === undefined) {
      this.controller.renderSurface.liftPressMarker();
      return;
    }
    this.predictor.walkTo(destination);
    if (hold.steering) this.controller.renderSurface.showPressMarker(destination);
    this.destinationMarked = true;
  }

  private liftDestinationMarker(): void {
    if (!this.destinationMarked) return;
    this.destinationMarked = false;
    this.controller.renderSurface.liftPressMarker();
  }

  /** The pointer was lost, or the world gave up the input: a held press and a steer stop, and a walk along a path goes on. */
  letGo(): void {
    if (this.hold !== undefined) this.controller.renderSurface.liftPressMarker();
    this.hold = undefined;
    if (this.predictor.walk?.kind === 'steer') this.predictor.stop();
  }

  /** Run on or off. It holds across spaces until the session ends. */
  toggleRun(): void {
    this.running = !this.running;
    this.onStateChanged?.();
  }

  /** Whether an effect the player holds keeps them from running, whatever Run says. */
  get runHeldOff(): boolean {
    return gaitAllowed('run', this.ownEffects) !== 'run';
  }

  private get ownEffects(): EffectId[] {
    return this.effectsOf(this.controller.selfId).map(({ effectId }) => effectId);
  }

  /**
   * Whether the player's own channel runs, or a use of one waits for the server's answer. A refused
   * use gets no answer, so the wait ends with the use's own, after `ABILITY_ANSWER_TIMEOUT_MS`.
   */
  private get channelUnderWay(): boolean {
    const selfId = this.controller.selfId;
    return (selfId !== undefined && this.channels.has(selfId)) || this.now() < this.awaitingUseUntilMs;
  }

  /** The channel the entity has under way, as far as the server has shown it. */
  channelOf(entityId: string | undefined): ClientChannel | undefined {
    return entityId === undefined ? undefined : this.channels.get(entityId);
  }

  /**
   * Keeps an entity's channel as its frames tell it: from its start, or from the seconds left a
   * dreamer who targets its user is sent, until it lands or breaks.
   */
  private trackChannel(entityId: string, abilityId: AbilityId, phase: AbilityPhase, seconds: number | undefined): void {
    const now = this.now();
    switch (phase) {
      case 'start':
      case 'channel': {
        const known = this.channels.get(entityId);
        const startedAtMs = phase === 'channel' && known?.abilityId === abilityId ? known.startedAtMs : now;
        this.channels.set(entityId, { abilityId, startedAtMs, endsAtMs: now + (seconds ?? 0) * 1000 });
        break;
      }
      case 'done':
      case 'broken':
        this.channels.delete(entityId);
        break;
    }
    this.onStateChanged?.();
  }

  /** The telegraphs under way in view: each whose seconds still run, while its caster stands in view and is not driven off. */
  telegraphsUnderWay(): (TelegraphMessage & { endsAtMs: number })[] {
    const now = this.now();
    return [...this.telegraphs.values()].filter((telegraph) => {
      const caster = this.controller.entities.get(telegraph.casterId);
      return telegraph.endsAtMs > now && caster !== undefined && !drivenOff(caster);
    });
  }

  /** The raise under way on the fallen dreamer, as its last snapshot states it. */
  raiseOf(entityId: string | undefined): ClientRaise | undefined {
    return entityId === undefined ? undefined : this.raises.get(entityId);
  }

  /** Keeps a raise as its snapshots state it, until it is done or breaks. */
  private trackRaise(raising: RaisingMessage): void {
    if (raising.state !== 'holding') {
      this.raises.delete(raising.targetId);
      return;
    }
    const atMs = this.now();
    this.raises.set(raising.targetId, {
      ...raiseProgress(raising),
      healerNames: this.knownNames(raising.healerIds),
      atMs,
      endsAtMs: atMs + raising.seconds * 1000,
    });
  }

  /** The names of the entities this client knows, in order; one it does not know is left out. */
  private knownNames(entityIds: readonly string[]): string[] {
    return entityIds.flatMap((id) => this.controller.entities.get(id)?.name ?? []);
  }

  /** The effects the server last sent of an entity: of the player, or of their target, and none of any other. */
  effectsOf(entityId: string | undefined): readonly ClientEffect[] {
    return (entityId === undefined ? undefined : this.heldEffects.get(entityId)) ?? [];
  }

  /**
   * What slot 1 does at the target while the player stands, by the same `engageAction` rule the
   * server judges with; `undefined` for nothing.
   */
  engageAction(): EngageAction | undefined {
    const target = this.standingTarget();
    return target === undefined ? undefined : engageAction(engageKind(target), this.lucidity.role, this.inventory.equipped, this.quests.active);
  }

  /** What keeps slot 1 from attacking the target, a nightmare, by the `attackRefusal` rule `engageAction` reads; `undefined` at anything else. */
  attackRefusal(): AttackRefusal | undefined {
    const target = this.standingTarget();
    return target === undefined || engageKind(target) !== 'nightmare' ? undefined : attackRefusal(this.inventory.equipped, this.quests.active);
  }

  /** The target while the player stands. */
  private standingTarget(): ClientEntity | undefined {
    return this.fallen || this.target === undefined ? undefined : this.controller.entities.get(this.target);
  }

  /** Whether slot 1 can be switched on. */
  get engageable(): boolean {
    return this.engageAction() !== undefined;
  }

  /** Slot 1 on or off. On only while `engageable`, and it never walks the player toward the target. */
  toggleEngage(): void {
    if (this.engaged) {
      this.send({ tag: 'engage', payload: { on: false } });
      this.stopEngaging();
    } else if (this.engageable) {
      this.engaged = true;
      this.send({ tag: 'engage', payload: { on: true } });
      this.markTarget();
      this.onStateChanged?.();
    }
  }

  /** The abilities on the belt, in its order: those the player's ranks teach. */
  get abilities(): AbilityId[] {
    return abilitiesTaught(this.lucidity.ranks);
  }

  /** What each ability slot on the belt shows, in the belt's order. */
  abilitySlots(): AbilitySlotState[] {
    const now = this.now();
    const running = (span: CooldownSpan | undefined): CooldownSpan | undefined => (span !== undefined && now < span.endsAtMs ? span : undefined);
    const global = running(this.cooldowns.global);
    return this.abilities.map((abilityId) => {
      const own = running(this.cooldowns.abilities[abilityId]);
      const cooldown = own === undefined || (global !== undefined && global.endsAtMs > own.endsAtMs) ? global : own;
      const refusal = this.abilityRefusal(abilityId, { globalReadyAt: now, readyAt: {} });
      return { abilityId, rank: abilityRank(this.lucidity.ranks, abilityId), refusal, cooldown };
    });
  }

  /**
   * Why the server would not act on the ability if the player used it now, by the `abilityRefusal`
   * rule it judges with, or `undefined` when it would. The cooldowns are those the server last sent
   * unless `cooldowns` stands in for them. Before the player's own body is known, nothing would
   * receive it.
   */
  private abilityRefusal(abilityId: AbilityId, cooldowns?: { globalReadyAt: number; readyAt: Partial<Record<AbilityId, number>> }): AbilityRefusal | undefined {
    const self = this.self;
    if (self === undefined) return 'recipient';
    const target = this.target === undefined ? undefined : this.controller.entities.get(this.target);
    const state = {
      channelling: this.channels.has(self.id),
      caster: abilityBody(self, self.position),
      ranks: this.lucidity.ranks,
      hands: this.inventory.equipped,
      energy: this.energy,
      now: this.now(),
      ...(cooldowns ?? {
        globalReadyAt: Math.max(this.cooldowns.global?.endsAtMs ?? 0, this.awaitingUseUntilMs),
        readyAt: Object.fromEntries(Object.entries(this.cooldowns.abilities).map(([id, span]) => [id, span.endsAtMs])),
      }),
    };
    return abilityRefusal(state, abilityId, target === undefined ? undefined : abilityBody(target, target.position));
  }

  /**
   * Uses the ability, when the server would act on it. The server judges it where the player last
   * stood, so the report the heartbeat holds back goes first. The global cooldown starts here too.
   * No ability is used again until the server's `cooldowns` answer, or for `ABILITY_ANSWER_TIMEOUT_MS`
   * without one, so a second press inside the round trip sends nothing. A leap waits for the
   * server's yes, the player's own `ability` frame. A channel breaks once the player moves, so the
   * walk under way, a held press's steer included, waits until it lands or breaks and then goes on.
   * A new press ends that walk, and the walk it makes breaks the channel.
   */
  useAbility(abilityId: AbilityId): void {
    if (this.abilityRefusal(abilityId) !== undefined) return;
    this.predictor.flush();
    if (ability(abilityId).channelSeconds !== undefined) this.walkWaitsForChannel = true;
    this.send({ tag: 'useAbility', payload: { abilityId } });
    const now = this.now();
    this.cooldowns = { ...this.cooldowns, global: { startedAtMs: now, endsAtMs: now + GLOBAL_COOLDOWN_SECONDS * 1000, global: true } };
    this.awaitingUseUntilMs = now + ABILITY_ANSWER_TIMEOUT_MS;
    this.onStateChanged?.();
  }

  /** The player's own leap, once the server has taken it: toward its recipient where the client draws it now. */
  private leapOnAnswer(abilityId: AbilityId, targetId: string | undefined): void {
    const { does, range } = ability(abilityId);
    if (does.kind !== 'leap' || targetId === undefined) return;
    const recipient = this.controller.entities.get(targetId);
    if (recipient !== undefined) this.predictor.leapAt(abilityBody(recipient, recipient.position), range, does.metresPerSecond);
  }

  private stopEngaging(): void {
    this.engaged = false;
    this.markTarget();
    this.onStateChanged?.();
  }

  /** Acts on `entityId` from now on, or on nothing, marks it, and tells the server when that is a change. */
  select(entityId: string | undefined): void {
    if (entityId === this.target) return;
    if (this.target !== undefined && this.target !== this.controller.selfId) this.heldEffects.delete(this.target);
    this.targetHealth = undefined;
    this.target = entityId;
    this.gazeLocked = false;
    this.engaged &&= this.engageable;
    this.send({ tag: 'target', payload: entityId === undefined ? {} : { targetId: entityId } });
    this.markTarget();
    this.onStateChanged?.();
  }

  /**
   * The share of its health the server last sent for the target, or `undefined` before it has. The
   * server sends none of the player's own, so when they target themselves it comes from their own pools.
   */
  vitalsOf(entityId: string): number | undefined {
    if (entityId !== this.controller.selfId) return entityId === this.target ? this.targetHealth : undefined;
    if (!this.seen.energy || entityId !== this.target) return undefined;
    return poolShare(this.energy.healthCurrent, this.energy.healthMax);
  }

  private openServicePanel(carrier: ServiceCarrier): void {
    if (this.servicePanel?.id === carrier.id) return;
    this.servicePanel = carrier;
    this.onStateChanged?.();
  }

  closeServicePanel(): void {
    if (this.servicePanel === undefined) return;
    this.servicePanel = undefined;
    this.onStateChanged?.();
  }

  /** The panel belongs to standing at the carrier: walking out of speaking distance closes it, as the server would drop a request from there. */
  private closeServicePanelBeyondSpeakingDistance(): void {
    const self = this.self;
    const carrier = this.servicePanel;
    if (carrier === undefined) return;
    if (self === undefined || !withinSpeakingDistance(self.position, carrier.position)) this.closeServicePanel();
  }

  private handleOwnCondition(condition: Condition): void {
    if (condition === 'fallen') {
      this.servicePanel = undefined;
      // Falling switches slot 1 off here as it does on the server, which sends no frame to say so.
      this.engaged = false;
      this.markTarget();
      this.controller.appendChat({ kind: 'fell' });
    } else {
      // Standing again without an `enterSpace` means a raise came first, and the `wake` was dropped.
      this.waking = false;
    }
    this.onStateChanged?.();
  }

  /**
   * Lets go of a press whose `pointerup` a hidden page would never see, and resets the tick clock
   * so the first tick back measures no elapsed time, as a session's first tick does. A pending door
   * stays pending, since the server is still answering it.
   */
  handleVisibilityLoss(): void {
    this.letGo();
    this.predictor.reset();
  }

  /** The point under the cursor at body height, which the player faces on a fine pointer. */
  aimAt(point: Point | undefined): void {
    this.aimPoint = point;
  }

  /**
   * What the player faces: the cursor on a fine pointer, unless the gaze is locked on the target. A
   * finger has no cursor, so on a coarse pointer they face their target where it is drawn, or the
   * way they walk without one.
   */
  private lookAt(): Point | undefined {
    if (!this.coarsePointer && !this.gazeLocked) return this.aimPoint;
    return this.target === undefined ? undefined : this.controller.entities.get(this.target)?.position;
  }

  /**
   * Applies one wheel event.
   *
   * Both the sign and the *scale* have to be converted. Negated because the DOM's positive `deltaY`
   * scrolls down while the zoom's convention is positive for up; rescaled because a DOM pixel delta
   * is ~30x the notch-scale delta `PLAYER_ZOOM`'s gain is tuned against. `deltaMode`
   * matters too — Firefox reports lines where Chrome reports pixels.
   */
  applyScrollZoom(deltaY: number, deltaMode = 0): boolean {
    return this.zoom.applyScroll(-wheelDeltaToZoomDelta(deltaY, deltaMode));
  }

  /** Applies one step of a pinch whose fingers moved `ratio` times as far apart: spreading them magnifies. */
  applyPinchZoom(ratio: number): boolean {
    return this.zoom.applyPinch(ratio);
  }

  /**
   * Says a chat line plainly, or as the whisper or yell its command names. The text is capped in
   * **UTF-8 bytes**, not code units: the server rejects on byte length, so a string of 200 emoji
   * passes a `.length <= 256` check and is then refused. An unknown command sends nothing and is answered in chat.
   */
  submitChat(rawText: string): void {
    const self = this.self;
    if (this.controller.connectionState !== 'attached' || self === undefined) return;
    const input = parseChatInput(rawText);
    if (input === undefined) return;
    if ('unknownCommand' in input) {
      this.controller.appendChat({ kind: 'unknownCommand', command: input.unknownCommand });
      return;
    }
    const text = truncateToUTF8Bytes(input.text, PROTOCOL_BYTE_CAPS.say);
    this.send({ tag: 'clientSay', payload: { text, kind: input.kind } });
    this.controller.appendChat({
      kind: 'spokenByOwn',
      senderName: this.controller.selfDisplayName,
      message: text,
      speech: input.kind,
    });
    const lines = wrapSpeech(text, this.measureText);
    this.controller.renderSurface.showSpeechBubble({
      entityId: self.id,
      source: self.position,
      lines,
      lifetimeMs: bubbleLifetimeMs(lines.length),
      kind: input.kind,
      clarity: 1,
    });
  }

  /** Says the purse's coins in the chat. */
  tellPurse(): void {
    if (this.controller.connectionState !== 'attached') return;
    this.controller.appendChat({ kind: 'purseBalance', coins: this.inventory.coins });
  }

  /**
   * Wears an item in `slot`, or in the slot the server chooses for its base; from the bag, whatever
   * that slot wore takes its place there, and a worn ring changes ring slots.
   */
  equip(itemId: string, slot?: EquipSlot): void {
    if (this.controller.connectionState !== 'attached') return;
    this.send({ tag: 'equip', payload: { itemId, ...(slot === undefined ? {} : { slot }) } });
  }

  /** Puts what the slot wears into the bag, which a full bag refuses as the server does. */
  unequip(slot: EquipSlot): void {
    if (this.controller.connectionState !== 'attached' || !bagHasRoom(this.inventory)) return;
    this.send({ tag: 'unequip', payload: { slot } });
  }

  /** Moves an item to a place in the bag, a worn one put away there, as `moveItem` rules it on both sides. */
  moveItem(itemId: string, place: number): void {
    if (this.controller.connectionState !== 'attached' || moveItem(this.inventory, itemId, place) === undefined) return;
    this.send({ tag: 'moveItem', payload: { itemId, place } });
  }

  /**
   * Throws an item the player carries or wears to the ground: toward `toward`, else toward the
   * cursor on a fine pointer, else the way they face. They face the throw, and the held-back report
   * goes first, since the server throws from where it judges they stand. A fallen player throws
   * nothing. A worn item leaves its slot as it goes, so a full bag does not keep it.
   */
  dropItem(itemId: string, toward?: Point): void {
    const self = this.self;
    if (this.controller.connectionState !== 'attached' || this.fallen || self === undefined) return;
    if (droppableItem(this.inventory, itemId) === undefined) return;
    const aim = toward ?? (this.coarsePointer ? undefined : this.aimPoint);
    if (aim !== undefined && (aim.x !== self.position.x || aim.z !== self.position.z)) {
      self.facing = headingFromVector(aim.x - self.position.x, aim.z - self.position.z);
    }
    this.predictor.flush();
    this.send({ tag: 'dropItem', payload: { itemId, heading: self.facing } });
  }

  /** Takes the quest on from the carrier whose panel is open. */
  acceptQuest(questId: QuestOrBountyId): void {
    if (this.servicePanel !== undefined) this.send({ tag: 'acceptQuest', payload: { carrierId: this.servicePanel.id, questId } });
  }

  /** Turns the quest in at the carrier whose panel is open. */
  turnInQuest(questId: QuestOrBountyId): void {
    if (this.servicePanel !== undefined) this.send({ tag: 'turnInQuest', payload: { carrierId: this.servicePanel.id, questId } });
  }

  abandonQuest(questId: QuestOrBountyId): void {
    this.send({ tag: 'abandonQuest', payload: { questId } });
  }

  study(teachingId: string): void {
    if (this.servicePanel !== undefined) this.send({ tag: 'study', payload: { carrierId: this.servicePanel.id, teachingId } });
  }

  /** Asks the shopkeeper whose panel is open to sell one of a ware. */
  buy(baseId: string): void {
    this.trade((carrierId) => ({ tag: 'buy', payload: { carrierId, baseId } }));
  }

  /** Asks the shopkeeper whose panel is open to buy an item from the bag. */
  sell(itemId: string): void {
    this.trade((carrierId) => ({ tag: 'sell', payload: { carrierId, itemId } }));
  }

  /** Whether the shop's buttons are locked, from a trade until a moment after its answer. */
  tradeLocked(): boolean {
    return this.now() < this.tradeLockedUntilMs;
  }

  private trade(request: (carrierId: string) => SomnioMessage): void {
    const carrier = this.servicePanel;
    if (carrier?.service !== 'shopkeeper' || this.tradeLocked()) return;
    this.send(request(carrier.id));
    this.tradeLockedUntilMs = this.now() + TRADE_ANSWER_TIMEOUT_MS;
    this.onStateChanged?.();
  }

  /** Gives up: the server answers a fallen dreamer with the `enterSpace` of the wake-point. */
  wake(): void {
    if (!this.fallen) return;
    this.waking = true;
    this.send({ tag: 'wake', payload: {} });
  }

  private dispatch(message: GameplayMessage): void {
    switch (message.tag) {
      case 'moves':
        for (const move of message.payload.moves) this.handleMove(move);
        return;
      case 'correction':
        this.predictor.correct(message.payload);
        return;
      case 'doorRefused':
        this.predictor.releaseDoor(false);
        this.explainRefusedDoor(message.payload);
        return;
      case 'serverSay':
        this.handleServerSay(message.payload);
        return;
      case 'energy':
        this.winded = this.seen.energy ? windedAfter(this.winded, message.payload.balanceCurrent) : windedOnJoin(message.payload.balanceCurrent);
        this.seen.energy = true;
        this.energy = message.payload;
        this.onStateChanged?.();
        return;
      case 'inventory': {
        const { trade, dropped, pickedUp, rewarded } = message.payload;
        if (trade !== undefined) {
          // A trade is its own news: the coins it moved are not announced again.
          this.announceTrade(trade);
          this.tradeLockedUntilMs = this.now() + TRADE_SETTLE_MS;
        } else if (dropped !== undefined) {
          this.controller.appendChat({ kind: 'dropped', contents: dropped });
        } else if (pickedUp !== undefined) {
          this.controller.appendChat({ kind: 'pickedUp', contents: pickedUp });
        } else {
          const gained = message.payload.coins - this.inventory.coins;
          if (this.seen.inventory && gained > 0) this.controller.appendChat({ kind: 'coinsGained', coins: gained });
          // A turn-in's items after its coins, a line each.
          for (const contents of rewarded ?? []) this.controller.appendChat({ kind: 'rewarded', contents });
          const turnedIn = this.turningIn;
          this.turningIn = undefined;
          if (turnedIn !== undefined) {
            const items = (rewarded ?? []).flatMap((contents) => (contents.kind === 'item' ? [contents] : []));
            this.onQuestNews?.({ kind: 'turnedIn', ...turnedIn, coins: gained > 0 ? gained : undefined, items });
          }
        }
        this.seen.inventory = true;
        this.inventory = inventoryOf(message.payload);
        this.onStateChanged?.();
        return;
      }
      case 'loot':
        this.loot.set(message.payload.lootId, message.payload);
        this.controller.renderSurface.showLoot(message.payload);
        return;
      case 'lootGone':
        this.loot.delete(message.payload.lootId);
        this.controller.renderSurface.removeLoot(message.payload.lootId);
        return;
      case 'lucidity':
        if (this.seen.lucidity) this.announceLucidity(this.lucidity, message.payload);
        this.seen.lucidity = true;
        this.lucidity = message.payload;
        this.showQuestMarkers();
        this.onStateChanged?.();
        return;
      case 'quests': {
        const quests = questsOf(message.payload);
        if (this.seen.quests) this.announceQuests(this.quests, quests);
        this.seen.quests = true;
        this.quests = quests;
        this.bounties = bountiesOf(message.payload);
        this.showQuestMarkers();
        this.onStateChanged?.();
        return;
      }
      case 'blow':
        // The server chooses the moment of a swing, so its slow starts when the swing is shown.
        if (message.payload.attackerId === this.controller.selfId) this.slowedUntilMs = this.now() + COMBAT.swingSlow.seconds * 1000;
        this.controller.renderSurface.showBlow(message.payload.attackerId, message.payload.targetId, message.payload.hit);
        return;
      case 'raising':
        this.handleRaising(message.payload);
        return;
      case 'mend':
        this.controller.renderSurface.showMend(message.payload.targetId);
        return;
      case 'sensed':
        this.sensed = message.payload.bearings;
        this.controller.renderSurface.showSensed(this.sensed);
        return;
      case 'telegraph': {
        const now = this.now();
        for (const [id, telegraph] of this.telegraphs) if (telegraph.endsAtMs <= now) this.telegraphs.delete(id);
        this.telegraphs.set(message.payload.id, { ...message.payload, endsAtMs: now + message.payload.seconds * 1000 });
        this.controller.renderSurface.showTelegraph(message.payload);
        return;
      }
      case 'vitals': {
        const { entityId, health } = message.payload;
        if (entityId !== this.target) return;
        this.targetHealth = health;
        this.onStateChanged?.();
        return;
      }
      case 'effects': {
        const { entityId, effects } = message.payload;
        if (entityId !== this.controller.selfId && entityId !== this.target) return;
        const now = this.now();
        const known = effects.flatMap(({ effectId, seconds }) => (isEffectId(effectId) ? [{ effectId, ...(seconds === undefined ? {} : { seconds }) }] : []));
        this.heldEffects.set(
          entityId,
          known.map(({ effectId, seconds }) => ({ effectId, ...(seconds === undefined ? {} : { endsAtMs: now + seconds * 1000 }) })),
        );
        this.controller.renderSurface.showEffects(entityId, known);
        this.onStateChanged?.();
        return;
      }
      case 'ability': {
        const { entityId, abilityId, targetId, phase, seconds, evaded } = message.payload;
        if (!isAbilityId(abilityId)) return;
        if (entityId === this.controller.selfId) this.leapOnAnswer(abilityId, targetId);
        if (phase === undefined) {
          this.controller.renderSurface.showAbility(entityId, abilityId, targetId, evaded === true ? { evaded } : undefined);
          return;
        }
        this.trackChannel(entityId, abilityId, phase, seconds);
        this.controller.renderSurface.showAbility(entityId, abilityId, targetId, { phase, ...(seconds === undefined ? {} : { seconds }) });
        return;
      }
      case 'cooldowns':
        this.cooldowns = this.cooldownsFrom(message.payload);
        this.awaitingUseUntilMs = 0;
        this.onStateChanged?.();
        return;
      case 'adminSay':
        this.controller.appendChat({ kind: 'adminBroadcast', message: message.payload.text });
        return;
      default:
        // Exhaustive over `GameplayMessage`, so a tag added to that union without a case here is a
        // compile error rather than a silently dropped frame.
        assertNever(message, 'gameplay dispatch');
    }
  }

  onStateChanged: (() => void) | undefined;
  /** Hears each quest taken on, each line of a quest held that came further, each quest held that is now done, and each quest turned in with what it paid. */
  onQuestNews: ((news: QuestNews) => void) | undefined;

  /**
   * The cooldowns a `cooldowns` frame tells of, on the session's clock. Each began as long before
   * its end as it runs in all, which the ability's rank says, so a snapshot after a door shows it
   * part spent.
   */
  private cooldownsFrom({ globalSeconds, cooldowns }: CooldownsMessage): Cooldowns {
    const now = this.now();
    const span = (seconds: number, wholeSeconds: number, global: boolean): CooldownSpan => ({
      startedAtMs: now - Math.max(0, wholeSeconds - seconds) * 1000,
      endsAtMs: now + seconds * 1000,
      global,
    });
    const abilities: Cooldowns['abilities'] = {};
    for (const { abilityId, seconds } of cooldowns) {
      if (!isAbilityId(abilityId)) continue;
      // Ranks count from 1, so one the client does not hold yet reads as the first.
      const rank = Math.max(1, abilityRank(this.lucidity.ranks, abilityId));
      abilities[abilityId] = span(seconds, abilityCooldownSeconds(abilityId, rank), false);
    }
    return { global: globalSeconds > 0 ? span(globalSeconds, GLOBAL_COOLDOWN_SECONDS, true) : undefined, abilities };
  }

  private announceTrade({ kind, baseId, coins }: TradeMessage): void {
    this.controller.appendChat({ kind, baseId, coins });
  }

  /**
   * A door that opens only at night, refused while this client's clock has the sun up, is shut for
   * the day, and the player is told so. Any other refusal says nothing: the player stood too far
   * off, or lies fallen.
   */
  private explainRefusedDoor(refused: DoorRefusedMessage): void {
    const door = this.controller.world?.doors.find((candidate) => candidate.sector === refused.sector && candidate.doorId === refused.doorId);
    const worldSeconds = this.controller.worldSecondsAt(this.now());
    if (door !== undefined && worldSeconds !== undefined && !doorOpenAt(door, worldSeconds)) this.controller.appendChat({ kind: 'doorOpensAtNight' });
  }

  /** The chat lines for what changed from one `lucidity` frame to the next. */
  private announceLucidity(before: LucidityMessage, after: LucidityMessage): void {
    if (before.role === undefined && after.role !== undefined) this.controller.appendChat({ kind: 'becameRole', role: after.role });
    for (const held of after.ranks) {
      const had = before.ranks.find((other) => other.teachingId === held.teachingId)?.rank ?? 0;
      if (held.rank > had && isTeachingId(held.teachingId)) this.controller.appendChat({ kind: 'rankGained', teachingId: held.teachingId, rank: held.rank });
    }
  }

  /**
   * What changed from one `quests` frame to the next: a quest turned in, a quest taken on, a quest
   * held that is now done, with where to turn it in, and otherwise each line that came further. A
   * quest taken on says only that, however far it has come. The chat says the hidden places found
   * among those lines, never which.
   */
  private announceQuests(before: QuestLog, after: QuestLog): void {
    for (const held of before.active) if (after.done.includes(held.questId)) this.announceTurnIn(held);
    for (const held of after.active) {
      const had = before.active.find((candidate) => candidate.questId === held.questId);
      if (had === undefined) {
        this.onQuestNews?.({ kind: 'accepted', held });
        continue;
      }
      if (questComplete(held)) {
        if (!questComplete(had)) this.announceDone(held);
        continue;
      }
      const lines = objectiveLines(heldQuest(held), had.progress);
      for (const [index, line] of objectiveLines(heldQuest(held), held.progress).entries()) {
        const { objectives, done, goal } = line;
        if (done <= lines[index]!.done) continue;
        if (objectives.length > 1 && objectives.every(({ kind }) => kind === 'reach'))
          this.controller.appendChat({ kind: 'placeFound', found: done, total: goal });
        this.onQuestNews?.({ kind: 'progress', held, line });
      }
    }
  }

  /** A quest held that is now done, with where to turn it in: its carrier, or for a bounty a bounty board. */
  private announceDone(held: ActiveQuest): void {
    if (held.definition !== undefined) this.controller.appendChat({ kind: 'bountyDone' });
    else this.controller.appendChat({ kind: 'questDone', questId: held.questId, turnIn: this.carrierName(quest(held.questId).turnIn) });
    this.onQuestNews?.({ kind: 'done', held });
  }

  /**
   * A quest turned in, told to the HUD once what it paid is known. The server answers a turn-in with
   * the `quests` frame that marks it done, then any `lucidity` frames, and last, when it pays coins
   * or an item, the `inventory` frame carrying them, so such a turn-in waits for that frame. What it
   * teaches follows from the quest, and its practice goes toward the teaching studied now.
   */
  private announceTurnIn(held: ActiveQuest): void {
    const turnedIn = { held, study: this.lucidity.study };
    if (turnInGrant(held).paysInventory) this.turningIn = turnedIn;
    else this.onQuestNews?.({ kind: 'turnedIn', ...turnedIn, coins: undefined, items: [] });
  }

  /**
   * Marks every carrier by what it has for the player, by the `markerFor` rule: each NPC in view with
   * the service its entity frame names, and each fixture of the held sectors, a bounty board among them.
   */
  private showQuestMarkers(): void {
    const npcs = [...this.controller.entities.values()].filter((entity) => entity.kind === 'npc');
    const carriers: QuestCarrier[] = [
      ...npcs.map(({ id, service }) => ({ id, service })),
      ...(this.controller.world?.fixtures ?? []).map(({ id, fixture }) => ({ id, service: fixture.service })),
    ];
    const markers = new Map<string, QuestMarker>();
    for (const carrier of carriers) {
      const marker = markerFor(carrier, this.quests, this.lucidity, this.bounties);
      if (marker !== undefined) markers.set(carrier.id, marker);
    }
    this.questMarkers = markers;
    this.controller.renderSurface.showQuestMarkers(markers);
  }

  /** A carrier's name, by its entity id: as the entity in view is named, else as the committed world names it, else its id. */
  carrierName(carrierId: string): string {
    return this.controller.entities.get(carrierId)?.name ?? committedNPCNames().get(carrierId) ?? carrierId;
  }

  /** The scene shows every raise as it stands, and each unit frame shows the raise on whom it frames. */
  private handleRaising(raising: RaisingMessage): void {
    this.controller.renderSurface.showRaising(raising.targetId, raising.state === 'holding' ? raiseProgress(raising) : undefined);
    this.tellRaising(raising);
    this.trackRaise(raising);
    this.onStateChanged?.();
  }

  /**
   * A Healer is told when a raise they hold on to is done, and when they lose hold of it while
   * Mend is still on at the dreamer with the Moonstone in hand. The dreamer being raised is told when
   * it is done or breaks, before `trackRaise` lets it go.
   */
  private tellRaising(raising: RaisingMessage): void {
    const { targetId, healerIds, state } = raising;
    const selfId = this.controller.selfId;
    const named = selfId !== undefined && healerIds.includes(selfId);
    if (named || this.heldRaises.has(targetId)) {
      const targetName = this.controller.entities.get(targetId)?.name ?? '';
      const holding = state === 'holding' && named;
      if (state === 'done') {
        if (named) this.controller.appendChat({ kind: 'raisedOther', targetName });
      } else if (this.heldRaises.has(targetId) && !holding && this.engaged && this.target === targetId && handAllows('moonstone', this.inventory.equipped)) {
        // Mend still on at them with the Moonstone in hand means they did not let go. A switch-off, a
        // fall, and putting the Moonstone away each reach this client before the drop, so none of them
        // reads as a broken hold.
        this.controller.appendChat({ kind: 'raiseBrokenOther', targetName });
      }
      if (holding) this.heldRaises.add(targetId);
      else this.heldRaises.delete(targetId);
      return;
    }
    if (targetId !== selfId || state === 'holding') return;
    // The names kept from the last snapshot, which held the same Healers: one who left is out of view by now.
    const healerNames = this.raises.get(targetId)?.healerNames ?? this.knownNames(healerIds);
    this.controller.appendChat({ kind: state === 'done' ? 'raised' : 'raiseBroken', healerNames });
  }

  /**
   * One remote entity's report. The entity keeps the position it is drawn at; the report becomes
   * the target it glides to, which the predictor samples every tick. The local player never
   * appears here: its position is predicted, and the server's only word on it is `correction`.
   */
  private handleMove(move: EntityMove): void {
    const entity = this.controller.entities.get(move.id);
    if (entity === undefined || entity.id === this.controller.selfId) return;
    this.controller.entities.set(move.id, { ...entity, facing: heading(move.facing), gait: move.gait });
    this.controller.renderSurface.updateGait(move.id, move.gait);
    this.interpolation.retarget(move.id, entity.position, { x: move.x, z: move.z }, this.now());
  }

  /**
   * NPC dialog arrives here, not on a dedicated tag: there is no NPC-dialog verb. A voice comes from
   * the speaker's body when the client has one, and otherwise from where the server says (a speaker
   * out of view, or behind a door). The bubble follows the body once it arrives. When the scene pins
   * the bubble at the screen's edge, the chat line names the direction of the voice. The voice and
   * the direction are both taken from where the bodies stand as the line arrives. A hidden tab runs
   * no tick, so the positions last drawn there are stale.
   */
  private handleServerSay(say: SayMessage): void {
    this.predictor.drawRemoteEntities(this.now());
    const body = this.controller.entities.get(say.entityId);
    const voice = body?.position ?? { x: say.x, z: say.z };
    const lines = wrapSpeech(say.text, this.measureText);
    const pinned = this.controller.renderSurface.showSpeechBubble({
      entityId: say.entityId,
      source: voice,
      lines,
      lifetimeMs: bubbleLifetimeMs(lines.length),
      kind: say.kind,
      clarity: say.clarity,
    });
    const self = this.self;
    const direction = pinned && self !== undefined ? compassPoint(self.position, voice) : undefined;
    this.controller.appendChat({
      kind: body?.kind === 'npc' || body?.kind === 'monster' ? 'spokenByNPC' : 'spokenByPeer',
      senderName: say.name,
      message: say.text,
      speech: say.kind,
      ...(direction === undefined ? {} : { direction }),
    });
  }
}
