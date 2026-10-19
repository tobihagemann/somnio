import { headingFromVector, sectorView } from '@somnio/core';
import type { Heading, ModelRegistry, Point } from '@somnio/core';
import type { Condition } from '@somnio/protocol';
import type { WorldScene } from '@/scene/worldScene';
import { bubbleLifetimeMs, wrapSpeech } from '@/scene/speechBubbleText';
import { DIP_SECONDS, SPLASH_REEL, pathPoint, shotFraming, shotWorldSeconds, stageReel } from './reel';
import type { SplashShot, StagedActor, StagedShot, Viewport } from './reel';
import { splashSectors } from './sectors';

/** What the director draws through: the scene, minus everything a session alone needs. */
export type SplashSurface = Pick<
  WorldScene,
  | 'showSplash'
  | 'addSector'
  | 'placeEntity'
  | 'removeEntity'
  | 'updatePosition'
  | 'updateCondition'
  | 'showBlow'
  | 'showRaising'
  | 'showSpeechBubble'
  | 'setClock'
  | 'frameShot'
>;

export interface SplashDirectorOptions {
  reducedMotion: boolean;
  /**
   * Whether a session is attached. The reel stops at the join, a little before the pre-login
   * screens give way, so it never frames or lights the world being joined.
   */
  attached: () => boolean;
  /** Overridable so a test can drive a small reel of its own. */
  reel?: readonly SplashShot[];
}

/** Where an actor of the shot on screen stands and how, as last drawn. */
interface ActorState {
  position: Point;
  facing: Heading;
  condition: Condition;
}

/**
 * Plays the splash reel on the scene behind the pre-login screens: each shot staged from the
 * committed sectors, its figures walked along their paths and its beats fired on time, joined to
 * the next by a dip to dark.
 *
 * `waiting` wants a start and `running` plays. `halted` follows an attached session or any throw,
 * and stays still until `restart`. A splash failure must never stand between a player and the
 * login card, so a throw leaves the empty splash rather than being retried each frame.
 */
export class SplashDirector {
  private readonly surface: SplashSurface;
  private readonly registry: ModelRegistry;
  private readonly measure: (line: string) => number;
  private readonly reducedMotion: boolean;
  private readonly attached: () => boolean;
  private readonly reel: readonly SplashShot[];
  private state: 'waiting' | 'running' | 'halted' = 'waiting';
  private shots: StagedShot[] = [];
  private index = 0;
  private seconds = 0;
  private firedBeats = 0;
  private dip = 0;
  /** `rising` toward the cut at the shot's end, `falling` after it. */
  private dipPhase: 'rising' | 'falling' | undefined;
  private space: string | undefined;
  private readonly actors = new Map<string, ActorState>();
  private viewport: Viewport = { width: 1, height: 1 };

  constructor(surface: SplashSurface, registry: ModelRegistry, measure: (line: string) => number, options: SplashDirectorOptions) {
    this.surface = surface;
    this.registry = registry;
    this.measure = measure;
    this.reducedMotion = options.reducedMotion;
    this.attached = options.attached;
    this.reel = options.reel ?? SPLASH_REEL;
  }

  /** How dark the dip lies over the world, 0 to 1. */
  get dipOpacity(): number {
    return this.state === 'running' ? this.dip : 0;
  }

  get currentShotId(): string | undefined {
    return this.state === 'running' ? this.shots[this.index]?.id : undefined;
  }

  /** The CSS-pixel viewport each shot is framed against. */
  setViewport(width: number, height: number): void {
    this.viewport = { width, height };
  }

  /** Called every frame once the models are warm. */
  update(seconds: number): void {
    if (this.halted()) return;
    this.guarded(() => {
      if (this.state === 'waiting') this.start();
      else this.tick(seconds);
    });
  }

  /** The scene was reset to the splash: the reel plays again from its first shot. */
  restart(): void {
    this.state = 'waiting';
  }

  /**
   * Plays the shot on screen again from its start, out of the dark unless motion is reduced. A
   * hidden tab paused the reel, while the bubbles and the raise ring kept running on wall time, so
   * the shot it left would no longer agree with itself.
   */
  replayShot(): void {
    // A hidden tab draws no frames, so a session can attach without a frame to halt the reel.
    if (this.halted() || this.state !== 'running') return;
    this.guarded(() => {
      const shot = this.shots[this.index]!;
      for (const actor of shot.actors) {
        const state = this.actors.get(actor.id)!;
        if (state.condition !== actor.condition) this.surface.updateCondition(actor.id, actor.condition);
        // A body that lay fallen as the shot opened has not moved since.
        if (actor.condition !== 'fallen') this.surface.updatePosition(actor.id, actor.start, actor.facing, undefined);
        this.actors.set(actor.id, { position: actor.start, facing: actor.facing, condition: actor.condition });
      }
      const raised = new Set(shot.beats.flatMap((beat) => (beat.kind === 'raise' ? [beat.target] : [])));
      for (const target of raised) this.surface.showRaising(target, undefined);
      this.seconds = 0;
      this.firedBeats = 0;
      this.dip = this.reducedMotion ? 0 : 1;
      this.dipPhase = this.reducedMotion ? undefined : 'falling';
      this.direct(shot);
    });
  }

  /** Whether the reel stands halted, halting it first once a session has attached. */
  private halted(): boolean {
    if (this.attached()) this.state = 'halted';
    return this.state === 'halted';
  }

  private guarded(run: () => void): void {
    try {
      run();
    } catch (error) {
      console.error('The splash reel stopped.', error);
      this.state = 'halted';
      this.dip = 0;
      this.dipPhase = undefined;
      try {
        this.surface.showSplash();
      } catch {
        // The empty splash is already the fallback; there is nothing further to fall back to.
      }
    }
  }

  private start(): void {
    this.shots = stageReel(this.reel, splashSectors(), this.registry);
    this.dip = 0;
    this.dipPhase = undefined;
    // The scene has been reset since the last staging, so nothing staged before is still on it.
    this.space = undefined;
    this.actors.clear();
    this.state = 'running';
    this.stage(0);
  }

  private stage(index: number): void {
    const shot = this.shots[index]!;
    this.index = index;
    this.seconds = 0;
    this.firedBeats = 0;
    if (shot.space !== this.space) {
      this.surface.showSplash();
      for (const sector of shot.sectors) this.surface.addSector(sectorView(sector));
      this.space = shot.space;
      this.actors.clear();
    } else {
      for (const id of [...this.actors.keys()]) {
        if (shot.actors.some((actor) => actor.id === id)) continue;
        this.surface.removeEntity(id);
        this.actors.delete(id);
      }
    }
    for (const actor of shot.actors) {
      if (actor.carried && this.actors.has(actor.id)) continue;
      this.place(actor);
    }
    this.direct(shot);
  }

  private place(actor: StagedActor): void {
    this.surface.placeEntity({
      id: actor.id,
      kind: actor.kind,
      characterModelId: actor.characterModelId,
      name: actor.name,
      radius: actor.radius,
      position: actor.start,
      facing: actor.facing,
      gait: actor.gait,
      condition: actor.condition,
      service: undefined,
    });
    this.actors.set(actor.id, { position: actor.start, facing: actor.facing, condition: actor.condition });
  }

  private tick(delta: number): void {
    const shot = this.shots[this.index]!;
    this.seconds += delta;
    this.fireBeats(shot);
    this.walk(shot);
    if (this.reducedMotion) {
      this.direct(shot);
      return;
    }
    const half = DIP_SECONDS / 2;
    if (this.dipPhase === 'falling') {
      this.dip = Math.max(1 - this.seconds / half, 0);
      if (this.dip === 0) this.dipPhase = undefined;
    } else if (this.seconds >= shot.seconds - half) {
      this.dipPhase = 'rising';
      this.dip = Math.min((this.seconds - (shot.seconds - half)) / half, 1);
    }
    if (this.dip === 1 && this.dipPhase === 'rising') {
      this.stage((this.index + 1) % this.shots.length);
      this.dipPhase = 'falling';
      return;
    }
    this.direct(shot);
  }

  private fireBeats(shot: StagedShot): void {
    while (this.firedBeats < shot.beats.length && shot.beats[this.firedBeats]!.at <= this.seconds) {
      const beat = shot.beats[this.firedBeats]!;
      this.firedBeats += 1;
      switch (beat.kind) {
        case 'blow':
          this.surface.showBlow(beat.attacker, beat.target, beat.hit);
          break;
        case 'condition':
          this.surface.updateCondition(beat.id, beat.condition);
          this.actors.get(beat.id)!.condition = beat.condition;
          break;
        case 'raise':
          this.surface.showRaising(beat.target, beat.raise);
          break;
        case 'speech': {
          const lines = wrapSpeech(beat.text(), this.measure);
          this.surface.showSpeechBubble({
            entityId: beat.speaker,
            source: this.actors.get(beat.speaker)!.position,
            lines,
            lifetimeMs: bubbleLifetimeMs(lines.length),
            kind: beat.speech,
            clarity: 1,
          });
          break;
        }
      }
    }
  }

  /** Each standing figure to where its path has it now, facing the way it goes, or whom it turns to once it stands. */
  private walk(shot: StagedShot): void {
    for (const actor of shot.actors) {
      const state = this.actors.get(actor.id)!;
      if (state.condition === 'fallen') continue;
      const position = pathPoint(actor, this.seconds);
      const step = { x: position.x - state.position.x, z: position.z - state.position.z };
      const moved = step.x !== 0 || step.z !== 0;
      const toward = actor.faces === undefined ? undefined : this.actors.get(actor.faces)?.position;
      const facing = moved
        ? headingFromVector(step.x, step.z)
        : toward === undefined
          ? state.facing
          : headingFromVector(toward.x - position.x, toward.z - position.z);
      if (!moved && facing === state.facing) continue;
      this.surface.updatePosition(actor.id, position, facing, moved ? facing : undefined);
      state.position = position;
      state.facing = facing;
    }
  }

  /** Frames the shot and lights it. A still camera under reduced motion keeps the shot's opening framing. */
  private direct(shot: StagedShot): void {
    const seconds = this.reducedMotion ? 0 : this.seconds;
    const framing = shotFraming(shot, seconds, this.viewport);
    this.surface.frameShot(framing.focus, framing.scale);
    this.surface.setClock(shotWorldSeconds(shot, this.seconds));
  }
}
