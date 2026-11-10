import type { AbilityId, EffectId, Heading, Point } from '@somnio/core';
import type { Condition, Gait, SectorView, SpeechKind } from '@somnio/protocol';
import type { ClientEntity, ClientWorld } from './clientWorld';

/** A line to show as a bubble: round its speaker's head while that is drawn on screen, and placed toward the voice otherwise. */
export interface SpeechBubbleRequest {
  /** The speaker, whose body the bubble follows once it is drawn. A second line from them replaces the first. */
  entityId: string;
  /** Where the voice comes from while the speaker has no body drawn. */
  source: Point;
  lines: string[];
  lifetimeMs: number;
  kind: SpeechKind;
  /** How clearly the line was heard: a fainter bubble the lower it is. */
  clarity: number;
}

/** A raise under way as its last snapshot states it: the share done, and the seconds left at the pace of those holding on. */
export interface RaiseProgress {
  progress: number;
  seconds: number;
}

/**
 * The world render surface — the contract the Three.js scene implements. Declared here rather
 * than in the scene module so the controller can drive a renderer or a test spy without importing
 * any WebGL.
 */
export interface WorldRenderSurface {
  /**
   * Starts a new space, empty until its sectors are added. The outgoing space stays on screen
   * until the local player is placed, avoiding a frame of the new space with no character in it.
   */
  enterSpace(world: ClientWorld): void;
  addSector(sector: SectorView): void;
  removeSector(name: string): void;
  placeEntity(entity: ClientEntity): void;
  /**
   * `travel` is the heading of this step's movement (`undefined` when the entity did not move),
   * letting the renderer pick backpedal/strafe clips; `undefined` must not overwrite the last
   * one, or the clip drops mid-glide.
   */
  updatePosition(entityId: string, position: Point, facing: Heading, travel: Heading | undefined): void;
  updateGait(entityId: string, gait: Gait): void;
  updateCondition(entityId: string, condition: Condition): void;
  /** One swing or strike: the attacker swings, and as the swing lands the target flinches or is missed. */
  showBlow(attackerId: string, targetId: string, hit: boolean): void;
  /** An ability used: its user plays it, and it shows where it lands. `targetId` is whom it landed on, `undefined` for its user or an ability that lands round them. */
  showAbility(entityId: string, abilityId: AbilityId, targetId: string | undefined): void;
  /** Every effect an entity holds, with the seconds each has left; told only of the player's own and their target's. */
  showEffects(entityId: string, effects: readonly { effectId: EffectId; seconds?: number }[]): void;
  /** A raise under way on a fallen entity; `undefined` ends it. */
  showRaising(targetId: string, raise: RaiseProgress | undefined): void;
  /** A mend landing on an entity: a ring swells from its feet and fades. */
  showMend(targetId: string): void;
  /** Marks the target, as a reticle while the player's facing is locked on it; `undefined` marks none. */
  showSelection(entityId: string | undefined, locked: boolean): void;
  /** A ring where a press holds the ground, or where the walk it let go of heads: it drops onto `point` the first time, and follows it after. */
  showPressMarker(point: Point): void;
  /** The ring rises away from where it lies, once it has landed. */
  liftPressMarker(): void;
  /** The world clock at this moment; the renderer runs it forward by itself. */
  setClock(worldSeconds: number): void;
  /** Whether the bubble was pinned at the screen's edge rather than hung round a head or by the door its voice comes through. */
  showSpeechBubble(request: SpeechBubbleRequest): boolean;
  removeEntity(entityId: string): void;
  showSplash(): void;
}

/** No-op surface for headless tests and for the window between boot and first render. */
export const noopRenderSurface: WorldRenderSurface = {
  enterSpace: () => {},
  addSector: () => {},
  removeSector: () => {},
  placeEntity: () => {},
  updatePosition: () => {},
  updateGait: () => {},
  updateCondition: () => {},
  showBlow: () => {},
  showAbility: () => {},
  showEffects: () => {},
  showRaising: () => {},
  showMend: () => {},
  showSelection: () => {},
  showPressMarker: () => {},
  liftPressMarker: () => {},
  setClock: () => {},
  showSpeechBubble: () => false,
  removeEntity: () => {},
  showSplash: () => {},
};
