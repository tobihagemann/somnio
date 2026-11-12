import { clamp, raiseWorkOver } from '@somnio/core';
import type { AbilityId, EffectId, Heading, Point, QuestMarker } from '@somnio/core';
import type { AbilityPhase, Condition, Gait, Held, LootMessage, SectorView, SensedBearingMessage, SpeechKind, TelegraphMessage } from '@somnio/protocol';
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

/** Where a channelled ability stands, with the channel's length on `start` and its seconds left on `channel`. */
interface AbilityChannel {
  phase: AbilityPhase;
  seconds?: number;
}

/** What an `ability` frame says beyond who used what on whom: a channel's phase, or harm its nightmare evaded. */
export type AbilityShown = AbilityChannel | { evaded: true };

/** How the target is marked: in gold while slot 1 acts on it, and as a reticle while the player's facing is locked on it. */
export interface TargetMark {
  locked: boolean;
  acting: boolean;
}

/**
 * A raise under way as its last snapshot states it: the share done, the seconds left at the pace of
 * those holding on, and the seconds before each of them adds their pace, absent while every one
 * adds it now.
 */
export interface RaiseProgress {
  progress: number;
  seconds: number;
  pausedSeconds?: readonly number[];
}

/**
 * The share of a raise done `elapsedSeconds` after its snapshot, on the schedule the server paces it
 * by (`raiseWorkOver`): it holds while every Healer holding on is paused, and it is whole once its
 * seconds are up.
 */
export function raiseShownAt({ progress, seconds, pausedSeconds = [0] }: RaiseProgress, elapsedSeconds: number): number {
  const whole = raiseWorkOver(pausedSeconds, seconds);
  return whole === 0 ? progress : progress + ((1 - progress) * raiseWorkOver(pausedSeconds, clamp(elapsedSeconds, 0, seconds))) / whole;
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
  /** `outdoorDoorIds` names the sector's doors that open to the outdoors; a room lets the hour's light in through the first that resolves. */
  addSector(sector: SectorView, outdoorDoorIds?: readonly string[]): void;
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
  /** What a dreamer's hands hold, drawn in them. */
  updateHeld(entityId: string, held: Held | undefined): void;
  /** One swing or strike: the attacker swings, and as the swing lands the target flinches or is missed. */
  showBlow(attackerId: string, targetId: string, hit: boolean): void;
  /**
   * An ability used: its user plays it, and it shows where it lands. `targetId` is whom it landed
   * on, `undefined` for its user or an ability that lands round them. A channelled one comes once
   * per phase it reaches, with `shown.phase`, and harm its nightmare evaded comes with `evaded`.
   */
  showAbility(entityId: string, abilityId: AbilityId, targetId: string | undefined, shown?: AbilityShown): void;
  /** Every effect an entity holds, with the seconds each has left; told only of the player's own and their target's. */
  showEffects(entityId: string, effects: readonly { effectId: EffectId; seconds?: number }[]): void;
  /** A raise under way on a fallen entity; `undefined` ends it. */
  showRaising(targetId: string, raise: RaiseProgress | undefined): void;
  /** A mend landing on an entity: a ring swells from its feet and fades. */
  showMend(targetId: string): void;
  /**
   * A circle its caster strikes once its seconds have run: it fills as they run, and ends with its
   * caster, driven off or gone from view.
   */
  showTelegraph(telegraph: TelegraphMessage): void;
  /** A minion arriving at the call of the boss that summoned it, which plays its call. */
  showSummoned(minionId: string, summonerId: string): void;
  /** The mark each carrier of a quest shows the player, by its carrier id, over an NPC's head or a fixture's model while it is drawn; one not named shows none. */
  showQuestMarkers(markers: ReadonlyMap<string, QuestMarker>): void;
  /** Where each fallen dreamer in the space lies, for a player who senses the fallen; a new space starts with none. */
  showSensed(bearings: readonly SensedBearingMessage[]): void;
  /** A drop lying on the ground, the player's own or one for anyone: its model, with its name under it in its rarity's colour, until it is removed or a new space begins. */
  showLoot(loot: LootMessage): void;
  removeLoot(lootId: string): void;
  /** Marks the target as `mark` says; `undefined` marks none. */
  showSelection(entityId: string | undefined, mark: TargetMark): void;
  /** A ring where a press holds the ground, or where the walk it let go of heads: it drops onto `point` the first time, and follows it after. */
  showPressMarker(point: Point): void;
  /** The ring rises away from where it lies, once it has landed. */
  liftPressMarker(): void;
  /** The world clock at this moment; the renderer runs it forward by itself. */
  setClock(worldSeconds: number): void;
  /** Whether the bubble was pinned at the screen's edge rather than hung round a head or by the door its voice comes through. */
  showSpeechBubble(request: SpeechBubbleRequest): boolean;
  removeEntity(entityId: string): void;
  /** A minion whose boss's fight ended: it crumbles into grave light where it stands, sinking out of sight, and is then removed. */
  crumbleEntity(entityId: string): void;
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
  updateHeld: () => {},
  showBlow: () => {},
  showAbility: () => {},
  showEffects: () => {},
  showRaising: () => {},
  showMend: () => {},
  showTelegraph: () => {},
  showSummoned: () => {},
  showQuestMarkers: () => {},
  showSensed: () => {},
  showLoot: () => {},
  removeLoot: () => {},
  showSelection: () => {},
  showPressMarker: () => {},
  liftPressMarker: () => {},
  setClock: () => {},
  showSpeechBubble: () => false,
  removeEntity: () => {},
  crumbleEntity: () => {},
  showSplash: () => {},
};
