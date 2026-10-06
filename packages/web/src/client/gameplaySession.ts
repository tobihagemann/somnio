import { PROTOCOL_BYTE_CAPS, assertNever, truncateToUTF8Bytes } from '@somnio/protocol';
import type { Condition, Energy, EntityMove, InventoryRowMessage, LucidityMessage, RaisingMessage, SomnioMessage, TaskMessage } from '@somnio/protocol';
import {
  COMBAT,
  heading,
  isTeachingId,
  itemInHand,
  swingAllowed,
  swingTarget,
  taskGoal,
  taskSpec,
  windedAfter,
  windedOnJoin,
  withinSpeakingDistance,
} from '@somnio/core';
import type { Heading, ItemId, TaskSpec } from '@somnio/core';
import { bubbleLifetimeMs, canvasWidthMeasurer, wrapSpeech } from '@/scene/speechBubbleText';
import { wheelDeltaToZoomDelta } from '@/scene/cameraRig';
import type { ClientEntity } from './clientWorld';
import type { ConnectionController, GameplayMessage } from './connectionController';
import { GameplayPredictor } from './predictor';
import { RemoteInterpolation } from './remoteInterpolation';
import { KeyboardSampler, PlayerZoom, mouseFacingHeading } from './input';
import type { KeyCaptureSink } from './input';

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

/** What a task as the wire carries it asks for; `undefined` for a teaching this client does not know. */
export function taskSpecOf(task: TaskMessage): TaskSpec | undefined {
  if (task.teachingId !== undefined && !isTeachingId(task.teachingId)) return undefined;
  return taskSpec({ role: task.role, teachingId: task.teachingId });
}

/** Whether a task as the wire carries it is at its goal. A teaching this client does not know has no goal to reach. */
export function taskIsDone(task: TaskMessage): boolean {
  const spec = taskSpecOf(task);
  return spec !== undefined && task.progress >= taskGoal(spec);
}

/** What a left click on the play field does, by what it points at. */
export type ClickAction = 'talk' | 'tend' | 'swing';

function purseCoins(rows: readonly InventoryRowMessage[]): number {
  return rows.find((row) => row.itemId === ('purse' satisfies ItemId))?.quantity ?? 0;
}

export interface GameplaySessionOptions {
  controller: ConnectionController;
  send: (message: SomnioMessage) => void;
  /** Overridable so headless tests drive the tick without a keyboard or a DOM. */
  input?: KeyCaptureSink & { clearHeldKeys(): void };
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
  readonly input: KeyCaptureSink & { clearHeldKeys(): void };

  energy: Energy = ZERO_ENERGY;
  inventory: InventoryRowMessage[] = [];
  lucidity: LucidityMessage = NO_LUCIDITY;
  /** Whether the player's balance gave out. Kept as the server keeps it: from each `energy` frame, in order. */
  winded = false;
  /** The NPC whose service panel is open. It does not close the input gate: the player walks away from it. */
  servicePanel: ClientEntity | undefined;
  /** The dreamer a Heiler chose to tend, as the server was last told. */
  tending: string | undefined;
  /** The raise being given to the fallen player: who gives it, and the whole seconds left. */
  raise: { healerName: string; secondsLeft: number } | undefined;

  /**
   * What has arrived since `enterSpace`. The first frame of each kind in a space states what is,
   * so it sets `winded` from the balance alone and announces nothing; every later one is compared
   * with the one before.
   */
  private seen = { energy: false, inventory: false, lucidity: false };
  private raiseEndsAtMs = 0;
  /** Set from sending `wake` until the `enterSpace` that answers it, or until the player stands again because a raise came first. */
  private waking = false;
  /** Whether the button that began a swing is still down, which keeps swinging. */
  private swingHeld = false;
  /** The server's swing rhythm, kept here so a held button asks once a swing rather than once a tick. */
  private swingReadyAtMs = 0;
  private slowedUntilMs = 0;

  private readonly controller: ConnectionController;
  private readonly send: (message: SomnioMessage) => void;
  private readonly measureText: (line: string) => number;
  private readonly now: () => number;
  private readonly interpolation = new RemoteInterpolation();
  private latestMouseFacing: Heading | undefined;

  constructor(options: GameplaySessionOptions) {
    this.controller = options.controller;
    this.send = options.send;
    this.input = options.input ?? new KeyboardSampler();
    this.measureText = options.measureText ?? canvasWidthMeasurer();
    this.now = options.now ?? (() => performance.now());
    this.predictor = new GameplayPredictor({
      session: this.controller,
      input: this.input,
      renderSurface: this.controller.renderSurface,
      interpolation: this.interpolation,
      send: this.send,
      mouseFacing: () => this.latestMouseFacing,
      winded: () => this.winded,
      fallen: () => this.fallen,
      slowed: (nowMs) => nowMs < this.slowedUntilMs,
    });

    this.controller.onGameplayMessage = (message) => this.dispatch(message);
    // The controller owns the two predicates the gate reads, so it is also what reports the gate
    // closing. Clearing held keys there rather than in each DOM handler is what keeps a stale
    // held bit from resuming movement when focus returns.
    this.controller.onGateClosed = () => this.input.clearHeldKeys();
    this.controller.onSpaceEntered = () => {
      this.resetSpaceState();
      this.latestMouseFacing = undefined;
      if (this.waking) this.controller.appendChat({ kind: 'wokeWeakened' });
      this.waking = false;
    };
    this.controller.onEntityReset = (entityId) => {
      this.interpolation.delete(entityId);
      // The player's own entity carries their condition, which is what the fallen notice follows.
      if (entityId === this.controller.selfId) this.onStateChanged?.();
    };
    this.controller.onSelfConditionChanged = (condition) => this.handleOwnCondition(condition);
    this.controller.onTeardown = () => {
      this.resetSpaceState();
      this.input.clearHeldKeys();
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
    this.predictor.releaseDoor(true);
    this.interpolation.clear();
    this.seen = { energy: false, inventory: false, lucidity: false };
    this.servicePanel = undefined;
    this.raise = undefined;
    this.swingHeld = false;
    this.swingReadyAtMs = 0;
    this.slowedUntilMs = 0;
    // The server holds it per space, so a new space starts with no one tended there either.
    this.tending = undefined;
    this.controller.renderSurface.showSelection(undefined);
  }

  /** The per-frame body. Injected timestamp, so a test drives it directly. */
  runTick(timestampMs: number): void {
    this.predictor.runTick(timestampMs);
    this.closeServicePanelBeyondSpeakingDistance();
    this.countDownRaise(timestampMs);
    if (this.tending !== undefined && !this.controller.entities.has(this.tending)) this.tend(undefined);
    if (this.swingHeld) this.swing(timestampMs);
  }

  private get self(): ClientEntity | undefined {
    const selfId = this.controller.selfId;
    return selfId === undefined ? undefined : this.controller.entities.get(selfId);
  }

  /** Whether a click acts on the world: attached, no overlay up, and standing. */
  private get acting(): boolean {
    return this.controller.connectionState === 'attached' && this.controller.presentedOverlay === undefined && !this.fallen;
  }

  /**
   * What a left click at an entity, or at none, would do. An NPC is asked to go on from within
   * speaking distance, and from further away the click does nothing. A Heiler's click at another dreamer
   * tends them. Everything else is a swing toward the cursor.
   */
  clickAction(entityId: string | undefined): ClickAction | undefined {
    const self = this.self;
    if (self === undefined || !this.acting) return undefined;
    const entity = entityId === undefined ? undefined : this.controller.entities.get(entityId);
    if (entity?.kind === 'npc') return withinSpeakingDistance(self.position, entity.position) ? 'talk' : undefined;
    if (entity?.kind === 'peer' && this.lucidity.role === 'heiler') return 'tend';
    return 'swing';
  }

  /**
   * A left click on the play field at `entityId`, or at nothing. Clicking the dreamer tended lets
   * go of them, and so does a swing. A new press ends a swing still held from the one before it.
   */
  pressAt(entityId: string | undefined, timestampMs: number): void {
    this.swingHeld = false;
    switch (this.clickAction(entityId)) {
      case 'talk':
        this.send({ tag: 'talk', payload: { npcId: entityId! } });
        if (this.controller.entities.get(entityId!)?.service !== undefined) this.openServicePanel(entityId!);
        return;
      case 'tend':
        this.tend(entityId === this.tending ? undefined : entityId);
        return;
      case 'swing':
        this.tend(undefined);
        this.swingHeld = true;
        this.swing(timestampMs);
        return;
      case undefined:
        return;
    }
  }

  /** The button that began a swing came up, or the pointer was lost. */
  release(): void {
    this.swingHeld = false;
  }

  /** Tends `entityId` from now on, or no one, and tells the server when that is a change. */
  tend(entityId: string | undefined): void {
    if (entityId === this.tending) return;
    this.tending = entityId;
    this.send({ tag: 'tend', payload: entityId === undefined ? {} : { targetId: entityId } });
    this.controller.renderSurface.showSelection(entityId);
    this.onStateChanged?.();
  }

  /**
   * Asks for one swing when the server would make one: the swing rhythm has come round, what is in
   * hand swings, no task forbids it, and the balance covers it. The position is reported first, so
   * the server judges the reach from where the player stands. The swing slows the player at once,
   * without waiting for the `blow` that answers it.
   */
  private swing(nowMs: number): void {
    const self = this.self;
    if (self === undefined || !this.acting || nowMs < this.swingReadyAtMs) return;
    const task = this.lucidity.task === undefined ? undefined : taskSpecOf(this.lucidity.task);
    const swing = swingAllowed(task, itemInHand(this.inventory), this.lucidity.ranks, this.energy.balanceCurrent);
    if (swing === undefined) return;
    this.swingReadyAtMs = nowMs + swing.seconds * 1000;
    this.slowedUntilMs = nowMs + COMBAT.swingSlow.seconds * 1000;
    const nightmares = [...this.controller.entities.values()]
      .filter((entity) => entity.kind === 'monster' && entity.condition !== 'fallen')
      .map((entity) => ({ id: entity.id, x: entity.position.x, z: entity.position.z, radius: entity.radius }));
    const met = swingTarget(self.position, self.facing, nightmares);
    this.predictor.reportNow();
    this.send({ tag: 'swing', payload: met === undefined ? {} : { targetId: met.id } });
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

  private countDownRaise(timestampMs: number): void {
    if (this.raise === undefined) return;
    const secondsLeft = Math.max(0, Math.ceil((this.raiseEndsAtMs - timestampMs) / 1000));
    if (secondsLeft === this.raise.secondsLeft) return;
    this.raise = { ...this.raise, secondsLeft };
    this.onStateChanged?.();
  }

  private handleOwnCondition(condition: Condition): void {
    if (condition === 'fallen') {
      this.servicePanel = undefined;
      // Falling lets go of the dreamer tended, as the server does: nothing sent while fallen could.
      this.tending = undefined;
      this.controller.renderSurface.showSelection(undefined);
      this.controller.appendChat({ kind: 'fell' });
    } else {
      // Standing again without an `enterSpace` means a raise came first, and the `wake` was dropped.
      this.waking = false;
    }
    this.onStateChanged?.();
  }

  /**
   * Clears input state that a `keyup` delivered while the page was hidden would have left
   * populated, and drops the tick clock so the first tick back measures zero elapsed rather than
   * the whole hidden interval. The clamp already bounds that interval, but resetting is what makes
   * the resumed tick behave identically to the first tick of a session. A pending door stays
   * pending: the server is still answering it.
   */
  handleVisibilityLoss(): void {
    this.input.clearHeldKeys();
    this.swingHeld = false;
    this.predictor.reset();
  }

  updateMouseFacing(pointer: { x: number; y: number }, center: { x: number; y: number }): void {
    this.latestMouseFacing = mouseFacingHeading(pointer, center);
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

  /**
   * Sends a chat line. The text is capped in **UTF-8 bytes**, not code units: the server rejects
   * on byte length, so a string of 200 emoji passes a `.length <= 256` check and is then refused.
   */
  submitChat(rawText: string): void {
    const text = truncateToUTF8Bytes(rawText.trim(), PROTOCOL_BYTE_CAPS.say);
    const selfId = this.controller.selfId;
    if (text.length === 0 || this.controller.connectionState !== 'attached' || selfId === undefined) {
      return;
    }
    this.send({ tag: 'clientSay', payload: { text } });
    this.controller.appendChat({
      kind: 'spokenByOwn',
      senderName: this.controller.selfDisplayName,
      message: text,
    });
    const lines = wrapSpeech(text, this.measureText);
    this.controller.renderSurface.showSpeechBubble(selfId, lines, bubbleLifetimeMs(lines.length));
  }

  /**
   * Double-click activation. The cudgel toggles equip in its fixed hand — the player never picks
   * one — and the purse reports its balance to the chat log rather than equipping. The Mondstein
   * is taken in that same hand, which puts the cudgel away, and used once it is there.
   */
  activateInventoryRow(row: InventoryRowMessage): void {
    if (this.controller.connectionState !== 'attached') return;
    switch (row.itemId) {
      case 'purse' satisfies ItemId:
        this.controller.appendChat({ kind: 'purseBalance', coins: row.quantity });
        return;
      case 'cudgel' satisfies ItemId:
        // Re-toggling leaves the hand out to unequip; the server clears whatever else held it.
        this.send({ tag: 'equipToggle', payload: { slot: row.slot, ...(row.equippedHand === undefined ? { hand: 'right' } : {}) } });
        return;
      case 'mondstein' satisfies ItemId:
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
        this.handleServerSay(message.payload.entityId, message.payload.text);
        return;
      case 'energy':
        this.winded = this.seen.energy ? windedAfter(this.winded, message.payload.balanceCurrent) : windedOnJoin(message.payload.balanceCurrent);
        this.seen.energy = true;
        this.energy = message.payload;
        this.onStateChanged?.();
        return;
      case 'inventory': {
        const gained = purseCoins(message.payload.rows) - purseCoins(this.inventory);
        if (this.seen.inventory && gained > 0) this.controller.appendChat({ kind: 'coinsGained', coins: gained });
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
        this.controller.renderSurface.showBlow(message.payload.attackerId, message.payload.targetId, message.payload.hit);
        return;
      case 'raising':
        this.handleRaising(message.payload);
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

  private handleRaising(raising: RaisingMessage): void {
    this.controller.renderSurface.showRaising(raising.targetId, raising.state === 'begun' ? raising.seconds : undefined);
    if (raising.targetId !== this.controller.selfId) return;
    const healerName = this.controller.entities.get(raising.healerId)?.name ?? '';
    if (raising.state === 'begun') {
      this.raiseEndsAtMs = this.now() + raising.seconds * 1000;
      this.raise = { healerName, secondsLeft: Math.ceil(raising.seconds) };
    } else {
      this.raise = undefined;
      if (raising.state === 'done') this.controller.appendChat({ kind: 'raised', healerName });
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

  /** NPC dialog arrives here, not on a dedicated tag — there is no NPC-dialog verb. */
  private handleServerSay(entityId: string, text: string): void {
    const entity = this.controller.entities.get(entityId);
    if (entity === undefined) return;
    const kind = entity.kind === 'npc' || entity.kind === 'monster' ? 'spokenByNPC' : 'spokenByPeer';
    this.controller.appendChat({ kind, senderName: entity.name, message: text });
    const lines = wrapSpeech(text, this.measureText);
    this.controller.renderSurface.showSpeechBubble(entityId, lines, bubbleLifetimeMs(lines.length));
  }
}
