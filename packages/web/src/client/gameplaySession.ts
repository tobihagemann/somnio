import { PROTOCOL_BYTE_CAPS, assertNever, truncateToUTF8Bytes } from '@somnio/protocol';
import type { Energy, EntityMove, InventoryRowMessage, SomnioMessage } from '@somnio/protocol';
import { heading } from '@somnio/core';
import type { Heading, ItemId } from '@somnio/core';
import { bubbleLifetimeMs, canvasWidthMeasurer, wrapSpeech } from '@/scene/speechBubbleText';
import { wheelDeltaToZoomDelta } from '@/scene/cameraRig';
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
    });

    this.controller.onGameplayMessage = (message) => this.dispatch(message);
    // The controller owns the two predicates the gate reads, so it is also what reports the gate
    // closing. Clearing held keys there rather than in each DOM handler is what keeps a stale
    // held bit from resuming movement when focus returns.
    this.controller.onGateClosed = () => this.input.clearHeldKeys();
    this.controller.onSpaceEntered = () => {
      this.resetSpaceState();
      this.latestMouseFacing = undefined;
    };
    this.controller.onEntityReset = (entityId) => this.interpolation.delete(entityId);
    this.controller.onTeardown = () => {
      this.resetSpaceState();
      this.input.clearHeldKeys();
      this.energy = ZERO_ENERGY;
      this.inventory = [];
    };
  }

  /** Everything that belongs to the space being left, a pending door included. */
  private resetSpaceState(): void {
    this.predictor.reset();
    this.predictor.releaseDoor(true);
    this.interpolation.clear();
  }

  /** The per-frame body. Injected timestamp, so a test drives it directly. */
  runTick(timestampMs: number): void {
    this.predictor.runTick(timestampMs);
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
   * one — and the purse reports its balance to the chat log rather than equipping.
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
    }
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
        this.energy = message.payload;
        this.onStateChanged?.();
        return;
      case 'inventory':
        this.inventory = message.payload.rows;
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
