import { PROTOCOL_BYTE_CAPS, assertNever, truncateToUTF8Bytes } from '@somnio/protocol';
import type {
  Condition,
  CooldownsMessage,
  Energy,
  EntityMove,
  InventoryRowMessage,
  LucidityMessage,
  RaisingMessage,
  SayMessage,
  SomnioMessage,
  TaskMessage,
  TradeMessage,
} from '@somnio/protocol';
import {
  COMBAT,
  GLOBAL_COOLDOWN_SECONDS,
  abilitiesTaught,
  ability,
  abilityAllowed,
  abilityCooldownSeconds,
  abilityRank,
  engageAction,
  gaitAllowed,
  heading,
  isAbilityId,
  isEffectId,
  isTeachingId,
  itemInHand,
  itemWeapon,
  poolShare,
  purseCoins,
  taskGoal,
  taskSpec,
  windedAfter,
  windedOnJoin,
  withinSpeakingDistance,
} from '@somnio/core';
import type { AbilityId, EffectId, EngageAction, ItemId, Point, TaskSpec } from '@somnio/core';
import { bubbleLifetimeMs, canvasWidthMeasurer, wrapSpeech } from '@/scene/speechBubbleText';
import { wheelDeltaToZoomDelta } from '@/scene/cameraRig';
import { parseChatInput } from './chatCommand';
import { abilityBody, drivenOff, engageKind } from './clientWorld';
import type { ClientEntity } from './clientWorld';
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

const NO_LUCIDITY: LucidityMessage = { ranks: [] };

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
  /** Whether the server would act on it now, but for its cooldowns. */
  usable: boolean;
  /** The cooldown it waits on while one runs: the later-ending of its own and the global one. */
  cooldown: CooldownSpan | undefined;
}

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

/** What a task as the wire carries it asks for; `undefined` for a teaching this client does not know or one without a gate. */
export function taskSpecOf(task: TaskMessage): TaskSpec | undefined {
  if (task.teachingId !== undefined && !isTeachingId(task.teachingId)) return undefined;
  return taskSpec({ role: task.role, teachingId: task.teachingId });
}

/** The whole seconds left until `endsAtMs`, rounded up, as a countdown shows them; never below 0. */
export function wholeSecondsLeft(endsAtMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((endsAtMs - nowMs) / 1000));
}

/** Whether a task as the wire carries it is at its goal. A task this client cannot read has no goal to reach. */
export function taskIsDone(task: TaskMessage): boolean {
  const spec = taskSpecOf(task);
  return spec !== undefined && task.progress >= taskGoal(spec);
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
  inventory: InventoryRowMessage[] = [];
  lucidity: LucidityMessage = NO_LUCIDITY;
  /** Whether the player's balance gave out. Kept as the server keeps it: from each `energy` frame, in order. */
  winded = false;
  /** The NPC whose service panel is open. It does not close the input gate: the player walks away from it. */
  servicePanel: ClientEntity | undefined;
  /** The entity the player acts on, as the server was last told. */
  target: string | undefined;
  /**
   * Whether the player faces their target whatever the cursor does, on a fine pointer. A right
   * press on a body sets it, and it ends with the target, on a second right press on the target, or
   * on a right press on the ground.
   */
  gazeLocked = false;
  /** The raise being given to the fallen player: the Healers holding on, and the whole seconds left. */
  raise: { healerNames: string[]; secondsLeft: number } | undefined;
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
  private seen = { energy: false, inventory: false, lucidity: false };
  private raiseEndsAtMs = 0;
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
  /** Each ability slot's usable flag and whether a cooldown runs, as the tick last saw them, so the tick runs the state hook again only when one changes. */
  private shownAbilitySlots = '[]';

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
      // The player's own entity carries their condition, which is what the fallen notice follows.
      if (entityId === this.controller.selfId) this.onStateChanged?.();
    };
    this.controller.onSelfConditionChanged = (condition) => this.handleOwnCondition(condition);
    this.controller.onTeardown = () => {
      this.letGo();
      this.resetSpaceState();
      this.running = false;
      this.energy = ZERO_ENERGY;
      this.inventory = [];
      this.lucidity = NO_LUCIDITY;
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
    this.seen = { energy: false, inventory: false, lucidity: false };
    this.servicePanel = undefined;
    this.raise = undefined;
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
    this.cooldowns = NO_COOLDOWNS;
    this.awaitingUseUntilMs = 0;
    this.controller.renderSurface.showSelection(undefined, false);
  }

  /** The per-frame body. Injected timestamp, so a test drives it directly. */
  runTick(timestampMs: number): void {
    if (this.hold !== undefined && timestampMs - this.hold.startedAtMs >= HOLD_TO_STEER_MS) this.hold.steering = true;
    if (this.hold?.steering === true && this.hold.point !== undefined) this.predictor.steerToward(this.hold.point);
    this.predictor.runTick(timestampMs);
    // However the walk a press let go of ends, its ring goes with it.
    if (this.predictor.walk === undefined) this.liftDestinationMarker();
    this.closeServicePanelBeyondSpeakingDistance();
    this.countDownRaise(timestampMs);
    if (this.gazeLocked && !this.gazeHolds) this.unlockGaze();
    if (this.engaged && !this.engageable) this.stopEngaging();
    if (this.tradeLockedUntilMs !== 0 && !this.tradeLocked()) {
      this.tradeLockedUntilMs = 0;
      this.onStateChanged?.();
    }
    // An ability comes in range or out of it as bodies move, and leaves its cooldown with time.
    const abilitySlots = JSON.stringify(this.abilitySlots().map(({ usable, cooldown }) => [usable, cooldown !== undefined]));
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
    if (entity.kind === 'npc' && withinSpeakingDistance(self.position, entity.position)) {
      this.send({ tag: 'talk', payload: { npcId: entityId } });
      if (entity.service !== undefined) this.openServicePanel(entityId);
    }
  }

  /**
   * A right press on an entity's body makes it the target and locks the player's facing on it, if it
   * is there to face. A right press on the target already locked ends the lock and keeps the target.
   * The player's own body is ignored.
   */
  toggleGazeOn(entityId: string): void {
    if (!this.acting || entityId === this.controller.selfId || !this.controller.entities.has(entityId)) return;
    if (entityId === this.target && this.gazeLocked) {
      this.unlockGaze();
      return;
    }
    this.select(entityId);
    if (!this.gazeHolds) return;
    this.gazeLocked = true;
    this.controller.renderSurface.showSelection(this.target, true);
    this.onStateChanged?.();
  }

  /** Ends the gaze lock: the player faces the cursor again, and keeps the target. */
  unlockGaze(): void {
    if (!this.gazeLocked) return;
    this.gazeLocked = false;
    this.controller.renderSurface.showSelection(this.target, false);
    this.onStateChanged?.();
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

  /** A left press on the player's own body: they stop where they stand. */
  pressSelf(): void {
    this.predictor.stop();
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

  /** The effects the server last sent of an entity: of the player, or of their target, and none of any other. */
  effectsOf(entityId: string | undefined): readonly ClientEffect[] {
    return (entityId === undefined ? undefined : this.heldEffects.get(entityId)) ?? [];
  }

  /**
   * What slot 1 does at the target while the player stands, by the same `engageAction` rule the
   * server judges with; `undefined` for nothing.
   */
  engageAction(): EngageAction | undefined {
    const target = this.target === undefined ? undefined : this.controller.entities.get(this.target);
    if (this.fallen || target === undefined) return undefined;
    return engageAction(engageKind(target), this.lucidity.role, itemInHand(this.inventory));
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
      return { abilityId, usable: this.abilityUsable(abilityId, { globalReadyAt: now, readyAt: {} }), cooldown };
    });
  }

  /**
   * Whether the server would act on the ability if the player used it now, by the `abilityAllowed`
   * rule it judges with. The cooldowns are those the server last sent unless `cooldowns` stands in
   * for them.
   */
  private abilityUsable(abilityId: AbilityId, cooldowns?: { globalReadyAt: number; readyAt: Partial<Record<AbilityId, number>> }): boolean {
    const self = this.self;
    if (self === undefined) return false;
    const target = this.target === undefined ? undefined : this.controller.entities.get(this.target);
    const state = {
      caster: abilityBody(self, self.position),
      ranks: this.lucidity.ranks,
      itemInHand: itemInHand(this.inventory),
      energy: this.energy,
      now: this.now(),
      ...(cooldowns ?? {
        globalReadyAt: Math.max(this.cooldowns.global?.endsAtMs ?? 0, this.awaitingUseUntilMs),
        readyAt: Object.fromEntries(Object.entries(this.cooldowns.abilities).map(([id, span]) => [id, span.endsAtMs])),
      }),
    };
    return abilityAllowed(state, abilityId, target === undefined ? undefined : abilityBody(target, target.position)) !== undefined;
  }

  /**
   * Uses the ability, when the server would act on it. The server judges it where the player last
   * stood, so the report the heartbeat holds back goes first. The global cooldown starts here too.
   * No ability is used again until the server's `cooldowns` answer, or for `ABILITY_ANSWER_TIMEOUT_MS`
   * without one, so a second press inside the round trip sends nothing. A leap waits for the
   * server's yes, the player's own `ability` frame.
   */
  useAbility(abilityId: AbilityId): void {
    if (!this.abilityUsable(abilityId)) return;
    this.predictor.flush();
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
    this.controller.renderSurface.showSelection(entityId, false);
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

  private openServicePanel(npcId: string): void {
    if (this.servicePanel?.id === npcId) return;
    this.servicePanel = this.controller.entities.get(npcId);
    this.onStateChanged?.();
  }

  closeServicePanel(): void {
    if (this.servicePanel === undefined) return;
    this.servicePanel = undefined;
    this.onStateChanged?.();
  }

  /** The panel belongs to standing with the NPC: walking out of speaking distance closes it, as the server would drop a request from there. */
  private closeServicePanelBeyondSpeakingDistance(): void {
    const self = this.self;
    const npc = this.servicePanel;
    if (npc === undefined) return;
    if (self === undefined || !withinSpeakingDistance(self.position, npc.position)) this.closeServicePanel();
  }

  /**
   * Counts the raise down between snapshots, and never up: a frame's timestamp can lie a little
   * before the moment the last snapshot arrived, which would otherwise read a whole second more.
   */
  private countDownRaise(timestampMs: number): void {
    if (this.raise === undefined) return;
    const secondsLeft = Math.min(this.raise.secondsLeft, wholeSecondsLeft(this.raiseEndsAtMs, timestampMs));
    if (secondsLeft === this.raise.secondsLeft) return;
    this.raise = { ...this.raise, secondsLeft };
    this.onStateChanged?.();
  }

  private handleOwnCondition(condition: Condition): void {
    if (condition === 'fallen') {
      this.servicePanel = undefined;
      // Falling switches slot 1 off here as it does on the server, which sends no frame to say so.
      this.engaged = false;
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

  /**
   * Double-click activation. A weapon toggles equip in its fixed hand — the player never picks
   * one — and the purse reports its balance to the chat log rather than equipping. The Moonstone
   * is taken in that same hand, which puts the weapon away, and used once it is there.
   */
  activateInventoryRow(row: InventoryRowMessage): void {
    if (this.controller.connectionState !== 'attached') return;
    if (itemWeapon(row.itemId) !== undefined) {
      // Re-toggling leaves the hand out to unequip; the server clears whatever else held it.
      this.send({ tag: 'equipToggle', payload: { slot: row.slot, ...(row.equippedHand === undefined ? { hand: 'right' } : {}) } });
      return;
    }
    switch (row.itemId) {
      case 'purse' satisfies ItemId:
        this.controller.appendChat({ kind: 'purseBalance', coins: row.quantity });
        return;
      case 'moonstone' satisfies ItemId:
        if (row.equippedHand === 'right') this.send({ tag: 'useItem', payload: { slot: row.slot } });
        else this.send({ tag: 'equipToggle', payload: { slot: row.slot, hand: 'right' } });
        return;
    }
  }

  /** Asks the master whose panel is open for a task: their trial, or the one that gates `teachingId`. */
  askTask(teachingId?: string): void {
    if (this.servicePanel === undefined) return;
    this.send({ tag: 'askTask', payload: { npcId: this.servicePanel.id, ...(teachingId === undefined ? {} : { teachingId }) } });
  }

  completeTask(): void {
    if (this.servicePanel !== undefined) this.send({ tag: 'completeTask', payload: { npcId: this.servicePanel.id } });
  }

  abandonTask(): void {
    this.send({ tag: 'abandonTask', payload: {} });
  }

  study(teachingId: string): void {
    if (this.servicePanel !== undefined) this.send({ tag: 'study', payload: { npcId: this.servicePanel.id, teachingId } });
  }

  /** Asks the shopkeeper whose panel is open to sell one of a ware. */
  buy(itemId: string): void {
    this.trade('buy', itemId);
  }

  /** Asks the shopkeeper whose panel is open to buy back a ware. */
  sell(itemId: string): void {
    this.trade('sell', itemId);
  }

  /** Whether the shop's buttons are locked, from a trade until a moment after its answer. */
  tradeLocked(): boolean {
    return this.now() < this.tradeLockedUntilMs;
  }

  private trade(tag: 'buy' | 'sell', itemId: string): void {
    const npc = this.servicePanel;
    if (npc?.service !== 'shopkeeper' || this.tradeLocked()) return;
    this.send({ tag, payload: { npcId: npc.id, itemId } });
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
        const trade = message.payload.trade;
        if (trade !== undefined) {
          // A trade is its own news: the coins it moved are not announced again.
          this.announceTrade(trade);
          this.tradeLockedUntilMs = this.now() + TRADE_SETTLE_MS;
        } else {
          const gained = purseCoins(message.payload.rows) - purseCoins(this.inventory);
          if (this.seen.inventory && gained > 0) this.controller.appendChat({ kind: 'coinsGained', coins: gained });
        }
        this.seen.inventory = true;
        this.inventory = message.payload.rows;
        this.onStateChanged?.();
        return;
      }
      case 'lucidity':
        if (this.seen.lucidity) this.announceLucidity(this.lucidity, message.payload);
        this.seen.lucidity = true;
        this.lucidity = message.payload;
        this.onStateChanged?.();
        return;
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
        const { entityId, abilityId, targetId } = message.payload;
        if (!isAbilityId(abilityId)) return;
        if (entityId === this.controller.selfId) this.leapOnAnswer(abilityId, targetId);
        this.controller.renderSurface.showAbility(entityId, abilityId, targetId);
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

  private announceTrade({ kind, itemId, coins }: TradeMessage): void {
    switch (kind) {
      case 'bought':
        this.controller.appendChat({ kind, itemId, coins });
        break;
      case 'sold': {
        const emptiedHand = itemInHand(this.inventory) === itemId;
        this.controller.appendChat({ kind, itemId, coins, emptiedHand });
        break;
      }
    }
  }

  /** The chat lines for what changed from one `lucidity` frame to the next. */
  private announceLucidity(before: LucidityMessage, after: LucidityMessage): void {
    if (before.role === undefined && after.role !== undefined) this.controller.appendChat({ kind: 'becameRole', role: after.role });
    for (const held of after.ranks) {
      const had = before.ranks.find((other) => other.teachingId === held.teachingId)?.rank ?? 0;
      if (held.rank > had && isTeachingId(held.teachingId)) this.controller.appendChat({ kind: 'rankGained', teachingId: held.teachingId, rank: held.rank });
    }
    if (before.task !== undefined && after.task !== undefined && !taskIsDone(before.task) && taskIsDone(after.task)) {
      this.controller.appendChat({ kind: 'taskDone' });
    }
  }

  /**
   * The scene shows every raise as it stands. A Healer is told when a raise they hold on to is
   * done, and when they lose hold of it while Mend is still on at the dreamer with the Moonstone in hand.
   * The dreamer being raised is shown who draws them back and for how long, and told when it is
   * done or breaks.
   */
  private handleRaising(raising: RaisingMessage): void {
    const { targetId, healerIds, state } = raising;
    this.controller.renderSurface.showRaising(targetId, state === 'holding' ? { progress: raising.progress, seconds: raising.seconds } : undefined);
    const selfId = this.controller.selfId;
    const named = selfId !== undefined && healerIds.includes(selfId);
    if (named || this.heldRaises.has(targetId)) {
      const targetName = this.controller.entities.get(targetId)?.name ?? '';
      const holding = state === 'holding' && named;
      if (state === 'done') {
        if (named) this.controller.appendChat({ kind: 'raisedOther', targetName });
      } else if (
        this.heldRaises.has(targetId) &&
        !holding &&
        this.engaged &&
        this.target === targetId &&
        itemInHand(this.inventory) === ('moonstone' satisfies ItemId)
      ) {
        // Mend still on at them with the Moonstone in hand means they did not let go. A switch-off, a
        // fall, and putting the Moonstone away each reach this client before the drop, so none of them
        // reads as a broken hold.
        this.controller.appendChat({ kind: 'raiseBrokenOther', targetName });
      }
      if (holding) this.heldRaises.add(targetId);
      else this.heldRaises.delete(targetId);
      return;
    }
    if (targetId !== selfId) return;
    const names = healerIds.map((id) => this.controller.entities.get(id)?.name ?? '');
    if (state === 'holding') {
      this.raiseEndsAtMs = this.now() + raising.seconds * 1000;
      this.raise = { healerNames: names, secondsLeft: Math.ceil(raising.seconds) };
    } else {
      // The names kept from the last snapshot, which held the same Healers: one who left is out of view by now.
      const healerNames = this.raise?.healerNames ?? names;
      this.raise = undefined;
      this.controller.appendChat({ kind: state === 'done' ? 'raised' : 'raiseBroken', healerNames });
    }
    this.onStateChanged?.();
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
