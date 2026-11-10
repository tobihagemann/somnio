/**
 * Combat's feedback in the world: the arcs of swings and Cleave, what a landed blow does to the
 * bodies it names, and the marks of the abilities. All of it is the client's own: it reads the
 * `blow`, `ability`, and `effects` frames and changes nothing that is sent.
 *
 * The arcs, rings, sparks, trails, and marks come from pools that stop growing at their size and
 * are reused oldest first, except that a Challenge mark waits for a free one. A body's flash and
 * outline hulls are built for its model and take the materials of hulls dropped. Each kind of mesh
 * draws with clones of one material, so a kind compiles its shader program when it first draws and
 * never again, and none adds a light. Everything hangs on the effects' own root, never in a model
 * holder, so no portrait shows it.
 */
import * as THREE from 'three';
import {
  ABILITIES,
  COMBAT,
  SOMNIO_CONSTANTS,
  angularDistance,
  areaRecipients,
  distance,
  effectSeconds,
  headingFromVector,
  headingRadians,
  reachDistance,
} from '@somnio/core';
import type { AbilityBody, AbilityId, EffectId, Heading } from '@somnio/core';
import type { Condition } from '@somnio/protocol';
import { abilityBody } from '@/client/clientWorld';
import type { ClientEntity } from '@/client/clientWorld';
import type { OneShot } from './animation';
import { offsetDirection } from './cameraRig';

/**
 * When the weapon lands, or the gesture peaks, as a share of each clip: measured off the clips' hand
 * bones, where the blade crosses the front, the chop comes down, the fist reaches furthest, and the
 * arms come up. A clip left out lands at once.
 */
export const STRIKE_AT: Readonly<Record<string, number>> = {
  Melee_1H_Attack_Slice_Horizontal: 0.2,
  Melee_1H_Attack_Jump_Chop: 0.57,
  Ranged_Magic_Raise: 0.26,
  Melee_Block: 0.32,
  Cheering: 0.1,
  Punch: 0.27,
};

/** A body as the effects read it: the entity's render state. */
export interface EffectBody {
  kind: ClientEntity['kind'];
  condition: Condition;
  /** Translation only: its position is the feet as drawn. */
  node: THREE.Object3D;
  /** Between the node and the model holder: what the stagger and the lift move, so a move never fights them. */
  jolt: THREE.Object3D;
  /** Carries the model, whose meshes a flash or an outline is drawn over. */
  modelHolder: THREE.Object3D;
  radius: number;
  facing: Heading;
  headHeight: number;
}

/** What the effects ask of the scene. */
export interface CombatEffectsHost {
  body(entityId: string): EffectBody | undefined;
  bodies(): Iterable<[string, EffectBody]>;
  /** The body the camera follows: the player's own. */
  playerId(): string | undefined;
  /** Plays a one-shot on the body and answers its clip, or `undefined` when none plays. */
  playOneShot(entityId: string, oneShot: OneShot): THREE.AnimationClip | undefined;
  /** A blow misses the body: the word over it. */
  markMiss(entityId: string): void;
  /** The wall clock, in milliseconds. */
  now(): number;
}

/** The pools' sizes. Past its size a pool hands out its oldest mesh again, but the marks' pool only a free one. */
export const EFFECT_POOL_SIZES = { swingArcs: 4, cleaveArcs: 4, rings: 40, sparks: 12, trails: 4, marks: 8 } as const;

/** The name of the group every effect hangs on. */
export const COMBAT_EFFECTS_NAME = 'somnio-combat-effects';

/**
 * The arc a swing draws: a band across the swing arc at the reach that sweeps across once and
 * fades, lifted to `height`. It reaches a little past the rule's reach, so it clears the body it
 * meets.
 */
const ARC_SHAPES = {
  swing: { inner: 0.3, outer: 1.2, height: 0.34, sweep: 0.11, hold: 0.04, fade: 0.22, trail: 0.4 },
  cleave: { inner: 0.25, outer: 1.65, height: 0.3, sweep: 0.17, hold: 0.06, fade: 0.32, trail: 0.55 },
} as const;
type ArcKind = keyof typeof ARC_SHAPES;

/** How a landed blow shows: the hit-pause, the shake when it names the player, and the sparks' size. */
interface Landing {
  pauseMs: number;
  shakeMetres: number;
  sparkScale: number;
}
const SWING_LANDING: Landing = { pauseMs: 60, shakeMetres: 0.04, sparkScale: 1 };
/** Each nightmare a Cleave meets pauses for less, since the sweep meets them one after another. */
const CLEAVE_LANDING: Landing = { pauseMs: 45, shakeMetres: 0.06, sparkScale: 1.25 };
const STRIKE_LANDING: Landing = { pauseMs: 45, shakeMetres: 0.035, sparkScale: 0.7 };
/** A blow on a braced dreamer: the brace takes it, and only the striker pauses. */
const BRACED_LANDING: Landing = { pauseMs: 50, shakeMetres: 0.02, sparkScale: 0.8 };

/**
 * How long the effects may go without a tick, on the wall clock, before they count as stalled. A
 * drawing tab ticks far more often, however slowly, so only a hidden one goes this long.
 */
const STALE_EFFECT_MS = 1500;
/** How long after a Cleave its blows arrive, at most: they follow its `ability` frame in the same batch. */
const CLEAVE_BLOW_WINDOW_MS = 100;
const FLASH_SECONDS = 0.14;
const KNOCK_METRES = 0.08;
const KNOCK_OUT_SECONDS = 0.05;
const KNOCK_BACK_SECONDS = 0.3;
const KNOCK_TILT = 0.22;
const SPARK_HEIGHT = 0.4;
const SPARK_SECONDS = 0.24;
const SHAKE_DECAY_SECONDS = 0.045;
const LINE_WIDTH = 0.045;
const RING_LIFT = 0.03;
/** The wave Challenge sends out reaches the centre of a body as wide as a dreamer at the edge of its range. */
const CHALLENGE_WAVE_RADIUS = 2 * SOMNIO_CONSTANTS.playerRadius + ABILITIES.challenge.range;
const CHALLENGE_WAVE_SECONDS = 0.42;
const CHALLENGE_PULSE_SECONDS = 0.9;
const CHALLENGE_PULSE_COLOR = 0xff7a5a;
const MARK_SIZE = 0.5;
const MARK_HEAD_GAP = 0.2;
/** A rally carries as far as a said line, centre to centre. */
const RALLY_WAVE_RADIUS = 2 * SOMNIO_CONSTANTS.playerRadius + ABILITIES.rally.range;
const RALLY_WAVE_SECONDS = 0.7;
const RALLY_LIFT_METRES = 0.13;
const RALLY_LIFT_SECONDS = 0.5;
const BRACE_THICKNESS = 0.028;
/** The rank-1 seconds of an effect, for a viewer the server tells nothing of it. */
const BRACED_SECONDS = effectSeconds('braced', 1);
const CHALLENGED_SECONDS = effectSeconds('challenged', 1);
const LUNGE_TRAIL_SAMPLES = 40;
const LUNGE_TRAIL_SECONDS = 0.4;
const LUNGE_DUST_METRES = 0.45;
const LUNGE_DUST_COLOR = 0xd9ccb4;
/** How long a lunge's burst waits for contact after the chop lands before it bursts where the leap stopped. */
const LUNGE_CONTACT_GRACE_SECONDS = 0.25;
const WHITE = 0xffffff;

const easeOut = (k: number): number => 1 - (1 - k) ** 3;

/** A pool that grows to its size, then hands out its oldest item again. */
class EffectPool<T extends THREE.Object3D> {
  readonly items: T[] = [];
  private next = 0;
  private readonly make: () => T;
  private readonly size: number;

  constructor(make: () => T, size: number) {
    this.make = make;
    this.size = size;
  }

  take(): T {
    if (this.items.length < this.size) {
      const item = this.make();
      this.items.push(item);
      return item;
    }
    const item = this.items[this.next]!;
    this.next = (this.next + 1) % this.size;
    return item;
  }

  /** A new item while the pool can grow, else one that `busy` says is free, or none. */
  takeFree(busy: (item: T) => boolean): T | undefined {
    if (this.items.length < this.size) return this.take();
    return this.items.find((item) => !busy(item));
  }
}

/** A mesh animating: `step` runs each frame with the seconds since it began, and it is hidden once `step` answers false. */
interface Running {
  start: number;
  step: (elapsed: number) => boolean;
}

/** What a landed blow left on a body: the hit-pause, the flash, the knock, and a rally's lift. */
interface Jolt {
  frozenUntil: number;
  flashStart: number | undefined;
  knock: { elapsed: number; heading: Heading; metres: number } | undefined;
  lift: { start: number; metres: number } | undefined;
}

/** The flash and the outline drawn over a body's meshes, built for the model it carries. */
interface Hulls {
  model: THREE.Object3D;
  flash: THREE.Mesh[];
  flashMaterial: THREE.MeshBasicMaterial;
  outline: THREE.Mesh[];
  outlineMaterial: THREE.MeshBasicMaterial;
  thickness: { value: number };
  /** Model units per metre, so the outline is as thick on every model. */
  unitsPerMetre: number;
}

/**
 * A timed look on a body, shown from `startsAt` until `until`, on the effects' clock, so it keeps
 * time with the clips and the waves. That clock catches up across a stall, so a look whose effect
 * ran out while the tab was hidden is gone on its return.
 */
interface Timed {
  startsAt: number;
  until: number;
}

interface Brace extends Timed {
  /** When the brace last took a blow, which swells the outline. */
  pulseAt: number;
}

interface ChallengeMark extends Timed {
  sprite: THREE.Sprite | undefined;
  /** When its next pulse goes out, or `undefined` before its first, which goes out as it shows. */
  nextPulse: number | undefined;
}

interface Lunge {
  targetId: string | undefined;
  heading: Heading;
  impactAt: number;
  impacted: boolean;
  trail: THREE.Mesh;
  samples: { x: number; z: number; at: number }[];
  travelled: number;
  nextDust: number;
}

interface PendingCleave {
  atMs: number;
  heading: Heading;
  /** When its arc begins to sweep, on the effects' clock. */
  sweepStart: number;
  struck: Set<string>;
}

export class CombatEffects {
  readonly root = new THREE.Group();

  private readonly host: CombatEffectsHost;
  private readonly reducedMotion: boolean;
  /**
   * The clock every effect runs on, in seconds: each tick moves it on by the frame's time, as the
   * clips are moved on, and the tick after a stall also by the time the stall lasted.
   */
  private clock = 0;
  /** Work waiting on the effects' clock. */
  private scheduled: { at: number; run: () => void }[] = [];
  /** The wall time of the last tick, or of construction before the first. */
  private lastTickMs: number;
  private readonly running = new Map<THREE.Object3D, Running>();
  private readonly arcs: Record<ArcKind, EffectPool<THREE.Mesh>>;
  private readonly rings: EffectPool<THREE.Mesh>;
  private readonly sparks: EffectPool<THREE.Mesh>;
  private readonly trails: EffectPool<THREE.Mesh>;
  private readonly marks: EffectPool<THREE.Sprite>;
  private readonly jolts = new Map<string, Jolt>();
  private readonly hulls = new Map<string, Hulls>();
  /**
   * The materials of hulls dropped, kept for the next: a disposed material releases its program,
   * which the next flash or brace would compile again.
   */
  private readonly spareHullMaterials: Pick<Hulls, 'flashMaterial' | 'outlineMaterial' | 'thickness'>[] = [];
  private readonly braces = new Map<string, Brace>();
  private readonly challenged = new Map<string, ChallengeMark>();
  private readonly lunges = new Map<string, Lunge>();
  private readonly cleaves = new Map<string, PendingCleave>();
  private shakeAmplitude = 0;

  constructor(host: CombatEffectsHost, reducedMotion: boolean) {
    this.host = host;
    this.reducedMotion = reducedMotion;
    this.lastTickMs = host.now();
    this.root.name = COMBAT_EFFECTS_NAME;
    this.arcs = {
      swing: this.pool(() => arcMesh('swing'), EFFECT_POOL_SIZES.swingArcs),
      cleave: this.pool(() => arcMesh('cleave'), EFFECT_POOL_SIZES.cleaveArcs),
    };
    this.rings = this.pool(ringMesh, EFFECT_POOL_SIZES.rings);
    this.sparks = this.pool(sparkMesh, EFFECT_POOL_SIZES.sparks);
    this.trails = this.pool(trailMesh, EFFECT_POOL_SIZES.trails);
    this.marks = this.pool(markSprite, EFFECT_POOL_SIZES.marks);
  }

  private pool<T extends THREE.Object3D>(make: () => T, size: number): EffectPool<T> {
    return new EffectPool(() => {
      const item = make();
      item.visible = false;
      item.frustumCulled = false;
      this.root.add(item);
      return item;
    }, size);
  }

  /**
   * One swing or strike. A Cleave's blows land as its sweep passes each body. Any other blow plays
   * the attacker's swing and lands when the clip's blade or fist does, and a dreamer's also draws its
   * arc. With no clip to time it by, it lands at once.
   */
  blow(attackerId: string, targetId: string, hit: boolean): void {
    if (this.stalled(this.host.now())) return;
    const cleaveDelay = this.cleaveDelay(attackerId, targetId);
    if (cleaveDelay !== undefined) {
      this.after(cleaveDelay, () => this.land(attackerId, targetId, hit, CLEAVE_LANDING));
      return;
    }
    const strikeIn = strikeDelay(this.host.playOneShot(attackerId, 'swing'));
    const attacker = this.host.body(attackerId);
    const target = this.host.body(targetId);
    if (attacker !== undefined && target !== undefined && attacker.kind !== 'monster') {
      const heading = headingBetween(attacker, target);
      this.after(strikeIn - Math.min(strikeIn, ARC_SHAPES.swing.sweep * 0.7), () => this.showArc('swing', attackerId, heading));
    }
    this.after(strikeIn, () => this.land(attackerId, targetId, hit, attacker?.kind === 'monster' ? STRIKE_LANDING : SWING_LANDING));
  }

  /** An ability used: its user plays it, and it shows as it lands. */
  ability(casterId: string, abilityId: AbilityId, targetId: string | undefined): void {
    if (this.stalled(this.host.now())) return;
    const strikeIn = strikeDelay(this.host.playOneShot(casterId, abilityId));
    switch (abilityId) {
      case 'cleave':
        this.cleave(casterId, strikeIn);
        return;
      case 'challenge':
        this.challenge(casterId, strikeIn);
        return;
      case 'brace':
        this.brace(casterId, strikeIn);
        return;
      case 'lunge':
        this.lunge(casterId, targetId, strikeIn);
        return;
      case 'rally':
        this.rally(casterId, strikeIn);
        return;
    }
  }

  /**
   * Every effect an entity holds, as the server last said. It is told only of the player's own and
   * of their target's. The brace's outline and the Challenge mark last as long as these say, and end
   * when a frame leaves them out. It is taken while stalled too, since it is the server's state
   * rather than a moment, and the next frame that changes it corrects it. Its seconds count from
   * now, past the catch-up the next tick makes for the stall so far.
   */
  hold(entityId: string, effects: readonly { effectId: EffectId; seconds?: number }[]): void {
    const now = this.host.now();
    const stalledFor = this.stalled(now) ? (now - this.lastTickMs) / 1000 : 0;
    const holds = (effectId: EffectId) => effects.find((effect) => effect.effectId === effectId);
    const braced = holds('braced');
    this.timeLook(this.braces, entityId, braced, stalledFor, () => ({ startsAt: this.clock, until: 0, pulseAt: Number.NEGATIVE_INFINITY }));
    const challenged = holds('challenged');
    this.timeLook(this.challenged, entityId, challenged, stalledFor, () => ({ startsAt: this.clock, until: 0, sprite: undefined, nextPulse: undefined }));
  }

  private timeLook<T extends Timed>(looks: Map<string, T>, entityId: string, held: { seconds?: number } | undefined, stalledFor: number, start: () => T): void {
    const look = looks.get(entityId);
    if (held === undefined) {
      if (look !== undefined) look.until = Math.min(look.until, this.clock);
      return;
    }
    const until = held.seconds === undefined ? Number.POSITIVE_INFINITY : this.clock + stalledFor + held.seconds;
    if (look !== undefined) look.until = until;
    else looks.set(entityId, { ...start(), until });
  }

  /** Whether a hit-pause holds the body's clip where it is. */
  frozen(entityId: string): boolean {
    return this.clock < (this.jolts.get(entityId)?.frozenUntil ?? Number.NEGATIVE_INFINITY);
  }

  /** Runs every effect on by `dt` seconds. */
  tick(dt: number): void {
    const now = this.host.now();
    if (this.stalled(now)) {
      this.dropInFlight();
      this.catchUp((now - this.lastTickMs) / 1000);
    }
    this.lastTickMs = now;
    this.clock += dt;
    const due = this.scheduled.filter((entry) => entry.at <= this.clock);
    this.scheduled = this.scheduled.filter((entry) => entry.at > this.clock);
    for (const entry of due) entry.run();
    for (const [object, run] of this.running) {
      if (run.step(this.clock - run.start)) continue;
      this.running.delete(object);
      object.visible = false;
    }
    for (const [id, cleave] of this.cleaves) if (now - cleave.atMs > CLEAVE_BLOW_WINDOW_MS) this.cleaves.delete(id);
    this.tickLunges();
    this.tickJolts(dt);
    this.tickBraces();
    this.tickChallenged();
    this.shakeAmplitude = this.shakeAmplitude > 0.0005 ? this.shakeAmplitude * Math.exp(-dt / SHAKE_DECAY_SECONDS) : 0;
  }

  /** Where the shake puts the camera off where the rig placed it, across the screen: written to `out`. */
  shakeOffset(camera: THREE.Camera, out: THREE.Vector3): void {
    out.set(0, 0, 0);
    if (this.shakeAmplitude === 0) return;
    camera.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    out.addScaledVector(right, (Math.random() * 2 - 1) * this.shakeAmplitude).addScaledVector(up, (Math.random() * 2 - 1) * this.shakeAmplitude);
  }

  /** Drops what the effects hold of an entity that leaves. */
  forget(entityId: string): void {
    this.jolts.delete(entityId);
    this.dropHulls(entityId);
    this.braces.delete(entityId);
    const mark = this.challenged.get(entityId);
    if (mark?.sprite !== undefined) this.stop(mark.sprite);
    this.challenged.delete(entityId);
    const lunge = this.lunges.get(entityId);
    if (lunge !== undefined) this.stop(lunge.trail);
    this.lunges.delete(entityId);
    this.cleaves.delete(entityId);
  }

  /** Ends every effect, for a new space. */
  clear(): void {
    this.dropInFlight();
    for (const id of [...this.hulls.keys()]) this.dropHulls(id);
    for (const object of [...this.running.keys()]) this.stop(object);
    this.braces.clear();
    this.challenged.clear();
    this.cleaves.clear();
  }

  private after(seconds: number, run: () => void): void {
    if (seconds <= 0) {
      run();
      return;
    }
    this.scheduled.push({ at: this.clock + seconds, run });
  }

  /**
   * Ends what a stall left queued or in flight, so none of it plays on the tab's return. That is the
   * work still queued unrun (a blow, sweep, or wave still to land), and every arc, ring, spark,
   * trail, lunge, stagger, flash, hit-pause, lift, and shake under way. The marks' sprites stay,
   * because a mark and an outline are timed looks, which the clock's catch-up ends when their effect
   * ran out while the tab was hidden. Until a tick runs again, `blow` and `ability` start nothing,
   * not even a clip, so the queue stays bounded while the tab stays hidden.
   */
  private dropInFlight(): void {
    this.scheduled = [];
    for (const object of [...this.running.keys()]) if (!this.marks.items.includes(object as THREE.Sprite)) this.stop(object);
    for (const lunge of this.lunges.values()) this.stop(lunge.trail);
    this.lunges.clear();
    for (const [id, jolt] of this.jolts) {
      const body = this.host.body(id);
      if (body === undefined) continue;
      resetJolt(body.jolt);
      if (jolt.flashStart !== undefined) this.setFlash(id, body, 0);
    }
    this.jolts.clear();
    this.shakeAmplitude = 0;
  }

  /**
   * Moves the clock on by the seconds a stall lasted, so what would have run out while the tab was
   * hidden has: a look whose effect ended, a brace's swell, a mark's pop. A Challenge pulse the stall
   * skipped is not sent late: the next goes out on the first beat after the clock.
   */
  private catchUp(seconds: number): void {
    this.clock += seconds;
    for (const mark of this.challenged.values()) {
      if (mark.nextPulse === undefined || mark.nextPulse > this.clock) continue;
      mark.nextPulse += CHALLENGE_PULSE_SECONDS * (Math.floor((this.clock - mark.nextPulse) / CHALLENGE_PULSE_SECONDS) + 1);
    }
  }

  /** Whether no tick has run for longer than `STALE_EFFECT_MS`: the tab is hidden, or was until this tick. */
  private stalled(now: number): boolean {
    return now - this.lastTickMs > STALE_EFFECT_MS;
  }

  private animate(object: THREE.Object3D, step: (elapsed: number) => boolean): void {
    object.visible = true;
    this.running.set(object, { start: this.clock, step });
    step(0);
  }

  private stop(object: THREE.Object3D): void {
    this.running.delete(object);
    object.visible = false;
  }

  /** A blow lands on the target or misses it. A braced dreamer's brace takes a landed blow instead of the body. */
  private land(attackerId: string, targetId: string, hit: boolean, landing: Landing): void {
    const target = this.host.body(targetId);
    if (target === undefined) return;
    if (!hit) {
      this.host.markMiss(targetId);
      return;
    }
    const attacker = this.host.body(attackerId);
    const heading = attacker === undefined ? target.facing : headingBetween(attacker, target);
    const namesPlayer = attackerId === this.host.playerId() || targetId === this.host.playerId();
    const brace = this.braces.get(targetId);
    if (brace !== undefined && brace.startsAt <= this.clock && this.clock < brace.until) {
      brace.pulseAt = this.clock;
      this.showSparks(target.node.position, heading, BRACED_LANDING.sparkScale);
      this.freeze([attackerId], BRACED_LANDING.pauseMs);
      if (namesPlayer) this.addShake(BRACED_LANDING.shakeMetres);
      return;
    }
    this.host.playOneShot(targetId, 'flinch');
    this.jolt(targetId).flashStart = this.clock;
    this.knock(targetId, heading, KNOCK_METRES);
    this.showSparks(target.node.position, heading, landing.sparkScale);
    this.freeze([attackerId, targetId], landing.pauseMs);
    if (namesPlayer) this.addShake(landing.shakeMetres);
  }

  /**
   * The delay before a blow of a Cleave lands, which the sweep reaches in turn, or `undefined` for
   * a blow that is no Cleave's. The server sends a Cleave's blows straight after its `ability` frame,
   * one to each body it meets, so the first blow at each target from the caster just after it is the
   * Cleave's. A blow at a target it already struck is slot 1's. Without the bodies to measure the
   * angle by, it lands at once.
   */
  private cleaveDelay(attackerId: string, targetId: string): number | undefined {
    const cleave = this.cleaves.get(attackerId);
    if (cleave === undefined || this.host.now() - cleave.atMs > CLEAVE_BLOW_WINDOW_MS || cleave.struck.has(targetId)) return undefined;
    cleave.struck.add(targetId);
    const attacker = this.host.body(attackerId);
    const target = this.host.body(targetId);
    if (attacker === undefined || target === undefined) return 0;
    const half = COMBAT.swingArcDegrees / 2;
    const passed = THREE.MathUtils.clamp((half - angularDistance(cleave.heading, headingBetween(attacker, target))) / COMBAT.swingArcDegrees, 0, 1);
    return Math.max(0, cleave.sweepStart + passed * ARC_SHAPES.cleave.sweep - this.clock);
  }

  private cleave(casterId: string, strikeIn: number): void {
    const caster = this.host.body(casterId);
    if (caster === undefined) return;
    const heading = caster.facing;
    const sweepIn = Math.max(0, strikeIn - ARC_SHAPES.cleave.sweep * 0.5);
    this.cleaves.set(casterId, { atMs: this.host.now(), heading, sweepStart: this.clock + sweepIn, struck: new Set() });
    this.after(sweepIn, () => this.showArc('cleave', casterId, heading));
  }

  /**
   * The wave goes out as far as the ability reaches, and marks each nightmare it reaches, judged
   * where the bodies are drawn as the ability arrives. A mark lasts the effect's seconds, or as long
   * as the server says for the player's target.
   */
  private challenge(casterId: string, strikeIn: number): void {
    const caster = this.host.body(casterId);
    if (caster === undefined) return;
    const reached = areaRecipients(ABILITIES.challenge, caster.node.position, this.abilityBodies());
    const until = this.clock + CHALLENGED_SECONDS;
    for (const body of reached) {
      const reach = Math.min(1, distance(caster.node.position, body) / CHALLENGE_WAVE_RADIUS);
      const startsAt = this.clock + strikeIn + CHALLENGE_WAVE_SECONDS * (1 - Math.cbrt(1 - reach));
      const mark = this.challenged.get(body.id);
      if (mark === undefined) this.challenged.set(body.id, { startsAt, until, sprite: undefined, nextPulse: undefined });
      else mark.until = Math.max(mark.until, until);
    }
    this.after(strikeIn, () => {
      const at = this.host.body(casterId)?.node.position ?? caster.node.position;
      this.showRing(at, {
        max: CHALLENGE_WAVE_RADIUS + 0.4,
        seconds: CHALLENGE_WAVE_SECONDS + 0.25,
        width: 0.05,
        shape: (_k, elapsed) => ({
          radius: CHALLENGE_WAVE_RADIUS * easeOut(Math.min(1, elapsed / CHALLENGE_WAVE_SECONDS)),
          alpha: 1 - Math.max(0, (elapsed - CHALLENGE_WAVE_SECONDS * 0.6) / (CHALLENGE_WAVE_SECONDS * 0.4 + 0.25)),
        }),
      });
      this.showRing(at, { max: 1, seconds: 0.3, width: LINE_WIDTH, follow: casterId, shape: (k) => ({ radius: 0.35 + 0.4 * easeOut(k), alpha: 1 - k }) });
    });
  }

  /** The outline holds from the block until the effect ends: for the rank-1 seconds, or as long as the server says for the player's own or their target's. */
  private brace(casterId: string, strikeIn: number): void {
    const brace = this.braces.get(casterId);
    const startsAt = this.clock + strikeIn;
    const until = this.clock + BRACED_SECONDS;
    if (brace === undefined) this.braces.set(casterId, { startsAt, until, pulseAt: Number.NEGATIVE_INFINITY });
    else Object.assign(brace, { startsAt: Math.min(brace.startsAt, startsAt), until: Math.max(brace.until, until) });
  }

  /** A trail behind the leap, and a burst once the leaper meets the body leapt at and the chop lands. */
  private lunge(casterId: string, targetId: string | undefined, strikeIn: number): void {
    const caster = this.host.body(casterId);
    if (caster === undefined) return;
    const previous = this.lunges.get(casterId);
    const target = targetId === undefined ? undefined : this.host.body(targetId);
    this.lunges.set(casterId, {
      targetId,
      heading: target === undefined ? caster.facing : headingBetween(caster, target),
      impactAt: this.clock + strikeIn,
      impacted: false,
      trail: previous?.trail ?? this.trails.take(),
      samples: [],
      travelled: 0,
      nextDust: 0,
    });
  }

  /** Rings rise round the one who rallies, a wave goes out as far as a said line, and each standing dreamer it reaches is lifted. */
  private rally(casterId: string, strikeIn: number): void {
    const caster = this.host.body(casterId);
    if (caster === undefined) return;
    const rallied = areaRecipients(ABILITIES.rally, caster.node.position, this.abilityBodies());
    this.after(strikeIn, () => {
      const at = this.host.body(casterId)?.node.position ?? caster.node.position;
      for (const delay of [0, 0.14]) {
        this.after(delay, () =>
          this.showRing(at, {
            max: 0.9,
            seconds: 0.75,
            width: 0.04,
            follow: casterId,
            shape: (k) => ({ radius: 0.42 + 0.22 * easeOut(k), rise: 1.05 * easeOut(k), alpha: 1 - k }),
          }),
        );
      }
      this.showRing(at, {
        max: RALLY_WAVE_RADIUS + 0.5,
        seconds: RALLY_WAVE_SECONDS + 0.3,
        width: 0.05,
        shape: (_k, elapsed) => ({
          radius: RALLY_WAVE_RADIUS * easeOut(Math.min(1, elapsed / RALLY_WAVE_SECONDS)),
          alpha: 0.85 * (1 - Math.max(0, (elapsed - RALLY_WAVE_SECONDS * 0.5) / (RALLY_WAVE_SECONDS * 0.5 + 0.3))),
        }),
      });
      for (const body of rallied) {
        const reach = body.id === casterId ? 0 : Math.min(1, distance(at, body) / RALLY_WAVE_RADIUS);
        this.after(body.id === casterId ? 0.05 : RALLY_WAVE_SECONDS * (1 - Math.cbrt(1 - reach)), () => {
          const lifted = this.host.body(body.id);
          if (lifted === undefined) return;
          if (!this.reducedMotion) this.jolt(body.id).lift = { start: this.clock, metres: RALLY_LIFT_METRES };
          this.showRing(lifted.node.position, {
            max: 0.8,
            seconds: 0.5,
            width: LINE_WIDTH,
            follow: body.id,
            shape: (k) => ({ radius: 0.32 + 0.2 * k, rise: 0.5 * easeOut(k), alpha: 1 - k }),
          });
        });
      }
    });
  }

  /** The bodies round the caster as an area ability's rules see them, where they are drawn. */
  private abilityBodies(): (AbilityBody & { id: string })[] {
    return [...this.host.bodies()].map(([id, body]) => ({ id, ...abilityBody(body, body.node.position) }));
  }

  private jolt(entityId: string): Jolt {
    let jolt = this.jolts.get(entityId);
    if (jolt === undefined) {
      jolt = { frozenUntil: Number.NEGATIVE_INFINITY, flashStart: undefined, knock: undefined, lift: undefined };
      this.jolts.set(entityId, jolt);
    }
    return jolt;
  }

  /** The hit-pause: the bodies' clips hold for a moment. Not under reduced motion. */
  private freeze(entityIds: readonly string[], ms: number): void {
    if (this.reducedMotion) return;
    for (const id of entityIds) {
      if (this.host.body(id) === undefined) continue;
      const jolt = this.jolt(id);
      jolt.frozenUntil = Math.max(jolt.frozenUntil, this.clock + ms / 1000);
    }
  }

  /** The body is knocked a little the way the blow travels and tips with it. Not under reduced motion. */
  private knock(entityId: string, heading: Heading, metres: number): void {
    if (this.reducedMotion) return;
    this.jolt(entityId).knock = { elapsed: 0, heading, metres };
  }

  private addShake(metres: number): void {
    if (this.reducedMotion) return;
    this.shakeAmplitude = Math.max(this.shakeAmplitude, metres);
  }

  /** The flash, the knock out fast and back slow, held through the hit-pause, and the lift with its stretch. */
  private tickJolts(dt: number): void {
    for (const [id, jolt] of this.jolts) {
      const body = this.host.body(id);
      if (body === undefined) {
        this.jolts.delete(id);
        continue;
      }
      const frozen = this.clock < jolt.frozenUntil;
      if (jolt.flashStart !== undefined) {
        const k = (this.clock - jolt.flashStart) / FLASH_SECONDS;
        this.setFlash(id, body, k >= 1 ? 0 : (1 - k) ** 1.4);
        if (k >= 1) jolt.flashStart = undefined;
      }
      // The node carries no yaw, so the jolt moves along the ground as the blow travels, and tips
      // about the axis across it, leaning the top of the body the same way.
      const along = { x: 0, z: 0 };
      let shove = 0;
      let tilt = 0;
      const knock = jolt.knock;
      if (knock !== undefined) {
        if (!frozen) knock.elapsed += dt;
        const t = knock.elapsed;
        const k = t < KNOCK_OUT_SECONDS ? easeOut(t / KNOCK_OUT_SECONDS) : Math.max(0, 1 - (t - KNOCK_OUT_SECONDS) / KNOCK_BACK_SECONDS) ** 2;
        const radians = headingRadians(knock.heading);
        along.x = Math.sin(radians);
        along.z = Math.cos(radians);
        shove = knock.metres * k;
        tilt = KNOCK_TILT * k * (knock.metres / KNOCK_METRES);
        if (t > KNOCK_OUT_SECONDS + KNOCK_BACK_SECONDS) jolt.knock = undefined;
      }
      let lift = 0;
      let stretch = 1;
      if (jolt.lift !== undefined) {
        const k = (this.clock - jolt.lift.start) / RALLY_LIFT_SECONDS;
        if (k >= 1) jolt.lift = undefined;
        else {
          lift = jolt.lift.metres * Math.sin(k * Math.PI);
          stretch = 1 + 0.08 * Math.sin(k * Math.PI);
        }
      }
      body.jolt.position.set(along.x * shove, lift, along.z * shove);
      body.jolt.rotation.set(along.z * tilt, 0, -along.x * tilt);
      body.jolt.scale.set(1 / Math.sqrt(stretch), stretch, 1 / Math.sqrt(stretch));
      if (!frozen && jolt.flashStart === undefined && jolt.knock === undefined && jolt.lift === undefined) {
        resetJolt(body.jolt);
        this.jolts.delete(id);
      }
    }
  }

  /** The outline pops on, flickers a little, swells when the brace takes a blow, and fades as the brace ends. */
  private tickBraces(): void {
    for (const [id, brace] of this.braces) {
      const body = this.host.body(id);
      const hulls = body === undefined ? undefined : this.hullsFor(id, body);
      const on = this.clock >= brace.startsAt && this.clock < brace.until;
      for (const mesh of hulls?.outline ?? []) mesh.visible = on;
      if (this.clock >= brace.until) {
        this.braces.delete(id);
        continue;
      }
      if (!on || hulls === undefined) continue;
      const intro = Math.min(1, (this.clock - brace.startsAt) / 0.2);
      const pop = intro < 1 && !this.reducedMotion ? 1 + 0.5 * Math.sin(intro * Math.PI) : 1;
      const outro = Math.min(1, (brace.until - this.clock) / 0.3);
      const pulse = Math.max(0, 1 - (this.clock - brace.pulseAt) / 0.25);
      const flicker = this.reducedMotion ? 0.85 : 0.75 + 0.2 * Math.sin(this.clock * 6);
      hulls.thickness.value = BRACE_THICKNESS * hulls.unitsPerMetre * intro * pop * (1 + 0.8 * pulse);
      hulls.outlineMaterial.opacity = flicker * outro + 0.25 * pulse;
    }
  }

  /** A "!" over each challenged nightmare's head and a pulse at its feet, until the mark ends or the nightmare is driven off. */
  private tickChallenged(): void {
    for (const [id, mark] of this.challenged) {
      const body = this.host.body(id);
      const ended = body === undefined || body.condition === 'fallen' || this.clock >= mark.until;
      if (ended) {
        if (mark.sprite !== undefined) this.stop(mark.sprite);
        this.challenged.delete(id);
        continue;
      }
      if (this.clock < mark.startsAt) continue;
      this.showMark(id, mark);
      const left = mark.until - this.clock;
      if (mark.sprite !== undefined) mark.sprite.material.opacity = left < 0.4 ? Math.max(0, left / 0.4) : 1;
      if (mark.nextPulse === undefined || this.clock >= mark.nextPulse) {
        const first = mark.nextPulse === undefined;
        mark.nextPulse = (mark.nextPulse ?? this.clock) + CHALLENGE_PULSE_SECONDS;
        this.showRing(body.node.position, {
          max: 0.9,
          seconds: 0.7,
          width: 0.04,
          color: CHALLENGE_PULSE_COLOR,
          follow: id,
          shape: (k) => ({ radius: 0.3 + 0.45 * easeOut(k), alpha: (first ? 1 : 0.75) * (1 - k) }),
        });
      }
    }
  }

  /**
   * Gives the mark a sprite if it lost or never had one and one is free. With every sprite on
   * another mark it waits, without one, for a mark to end: taking a sprite from another mark would
   * leave that one to take one back the next frame, and no mark would ever show.
   */
  private showMark(id: string, mark: ChallengeMark): void {
    if (mark.sprite !== undefined && this.running.has(mark.sprite)) return;
    const sprite = this.marks.takeFree((item) => this.running.has(item));
    for (const other of this.challenged.values()) if (other.sprite === sprite) other.sprite = undefined;
    mark.sprite = sprite;
    if (sprite === undefined) return;
    this.animate(sprite, (elapsed) => {
      const body = this.host.body(id);
      if (body === undefined || mark.sprite !== sprite) return false;
      const pop = elapsed < 0.22 && !this.reducedMotion ? 1 + 0.6 * Math.sin((elapsed / 0.22) * Math.PI) * (1 - elapsed / 0.22) : 1;
      const size = MARK_SIZE * pop * Math.min(1, elapsed / 0.08);
      sprite.scale.set(size, size, 1);
      const bob = this.reducedMotion ? 0 : 0.03 * Math.sin(elapsed * 5);
      const feet = body.node.position;
      sprite.position.set(feet.x, feet.y + body.headHeight + MARK_HEAD_GAP + MARK_SIZE / 2 + bob, feet.z);
      return true;
    });
  }

  /** A lunge's trail follows the leaper while it moves, with dust kicked up along the way, and bursts on contact once the chop lands. */
  private tickLunges(): void {
    for (const [id, lunge] of this.lunges) {
      const caster = this.host.body(id);
      if (caster === undefined) {
        this.stop(lunge.trail);
        this.lunges.delete(id);
        continue;
      }
      const at = caster.node.position;
      const target = lunge.targetId === undefined ? undefined : this.host.body(lunge.targetId);
      const last = lunge.samples.at(-1);
      if (!lunge.impacted && (last === undefined || last.x !== at.x || last.z !== at.z)) {
        if (last !== undefined) lunge.travelled += Math.hypot(at.x - last.x, at.z - last.z);
        lunge.samples.push({ x: at.x, z: at.z, at: this.clock });
        if (lunge.travelled >= lunge.nextDust) {
          lunge.nextDust += LUNGE_DUST_METRES;
          this.showRing(at, {
            max: 0.5,
            seconds: 0.35,
            width: LINE_WIDTH * 0.8,
            color: LUNGE_DUST_COLOR,
            shape: (k) => ({ radius: 0.12 + 0.3 * easeOut(k), alpha: 0.7 * (1 - k) }),
          });
        }
      }
      const contact = target !== undefined && distance(at, target.node.position) <= reachDistance(target.radius) + 0.1;
      if (!lunge.impacted && this.clock >= lunge.impactAt && (contact || this.clock >= lunge.impactAt + LUNGE_CONTACT_GRACE_SECONDS)) {
        lunge.impacted = true;
        this.lungeBurst(id, at, lunge, target);
      }
      lunge.samples = lunge.samples.filter((sample) => this.clock - sample.at <= LUNGE_TRAIL_SECONDS);
      if (!this.drawTrail(lunge) && lunge.impacted) this.lunges.delete(id);
    }
  }

  /** Lunge does no harm by the rules: the burst sells the arrival, not a hit. */
  private lungeBurst(casterId: string, at: THREE.Vector3, lunge: Lunge, target: EffectBody | undefined): void {
    this.showRing(at, { max: 1.8, seconds: 0.32, width: 0.05, shape: (k) => ({ radius: 0.25 + 1.3 * easeOut(k), alpha: 1 - k }) });
    if (target === undefined || lunge.targetId === undefined) return;
    const targetAt = target.node.position;
    this.showRing(targetAt, {
      max: 1,
      seconds: 0.26,
      width: LINE_WIDTH,
      follow: lunge.targetId,
      shape: (k) => ({ radius: 0.3 + 0.5 * easeOut(k), alpha: 1 - k }),
    });
    for (const turn of [-55, 0, 55]) this.showSparks(targetAt, lunge.heading + turn, 1.1);
    this.knock(lunge.targetId, lunge.heading, 0.12);
    this.host.playOneShot(lunge.targetId, 'flinch');
    this.freeze([casterId, lunge.targetId], 90);
  }

  /** Lays the trail's band along its samples, across the leap and facing the camera, tapering to the tail; false once nothing is left of it. */
  private drawTrail(lunge: Lunge): boolean {
    const samples = lunge.samples;
    const trail = lunge.trail;
    if (samples.length < 2) {
      this.stop(trail);
      return false;
    }
    trail.visible = true;
    const geometry = trail.geometry;
    const positions = geometry.getAttribute('position') as THREE.BufferAttribute;
    const ages = geometry.getAttribute('aAge') as THREE.BufferAttribute;
    const radians = headingRadians(lunge.heading);
    const side = new THREE.Vector3(Math.sin(radians), 0, Math.cos(radians)).cross(CAMERA_DIRECTION).normalize();
    for (let index = 0; index < LUNGE_TRAIL_SAMPLES; index += 1) {
      const sample = samples[Math.min(index, samples.length - 1)]!;
      const age = this.clock - sample.at;
      const half = 0.2 * (1 - Math.min(1, age / LUNGE_TRAIL_SECONDS));
      positions.setXYZ(index * 2, sample.x - side.x * half, 0.36 - side.y * half, sample.z - side.z * half);
      positions.setXYZ(index * 2 + 1, sample.x + side.x * half, 0.36 + side.y * half, sample.z + side.z * half);
      ages.setX(index * 2, age);
      ages.setX(index * 2 + 1, age);
    }
    positions.needsUpdate = true;
    ages.needsUpdate = true;
    return true;
  }

  /** Draws the arc at the body, round `heading`, sweeping once; Cleave's has a wider echo behind it. */
  private showArc(kind: ArcKind, entityId: string, heading: Heading): void {
    const body = this.host.body(entityId);
    if (body === undefined) return;
    const shape = ARC_SHAPES[kind];
    const feet = body.node.position;
    const total = shape.sweep + shape.hold + shape.fade;
    const arc = this.arcs[kind].take();
    const uniforms = (arc.material as THREE.ShaderMaterial).uniforms;
    arc.position.set(feet.x, feet.y + shape.height, feet.z);
    arc.rotation.set(0, headingRadians(heading), 0);
    arc.scale.setScalar(1);
    this.animate(arc, (elapsed) => {
      uniforms['uHead']!.value = Math.min(1, elapsed / shape.sweep);
      const fading = Math.max(0, (elapsed - shape.sweep - shape.hold) / shape.fade);
      uniforms['uFade']!.value = 1 - fading * fading;
      return elapsed < total;
    });
    if (kind !== 'cleave') return;
    const echo = this.arcs.cleave.take();
    const echoUniforms = (echo.material as THREE.ShaderMaterial).uniforms;
    echo.position.set(feet.x, feet.y + shape.height - 0.02, feet.z);
    echo.rotation.set(0, headingRadians(heading), 0);
    const lag = 0.06;
    this.animate(echo, (elapsed) => {
      const late = Math.max(0, elapsed - lag);
      echoUniforms['uHead']!.value = Math.min(1, late / shape.sweep);
      echo.scale.setScalar(1 + (this.reducedMotion ? 0 : 0.18 * easeOut(Math.min(1, late / (total - lag)))));
      echoUniforms['uFade']!.value = 0.45 * (1 - Math.max(0, (late - shape.sweep) / (shape.hold + shape.fade)));
      return elapsed < total + lag;
    });
  }

  /** A flat ring at `at` whose radius, rise, and strength follow `shape`, following an entity's feet when given one. */
  private showRing(
    at: THREE.Vector3,
    ring: {
      max: number;
      seconds: number;
      width: number;
      color?: number;
      follow?: string;
      shape: (k: number, elapsed: number) => { radius: number; alpha: number; rise?: number };
    },
  ): void {
    const mesh = this.rings.take();
    const uniforms = (mesh.material as THREE.ShaderMaterial).uniforms;
    uniforms['uMax']!.value = ring.max;
    uniforms['uWidth']!.value = ring.width;
    (uniforms['uColor']!.value as THREE.Color).set(ring.color ?? WHITE);
    mesh.scale.set(ring.max, ring.max, 1);
    const origin = at.clone();
    this.animate(mesh, (elapsed) => {
      const k = Math.min(1, elapsed / ring.seconds);
      const shape = ring.shape(k, elapsed);
      const feet = (ring.follow === undefined ? undefined : this.host.body(ring.follow)?.node.position) ?? origin;
      mesh.position.set(feet.x, feet.y + RING_LIFT + (shape.rise ?? 0), feet.z);
      uniforms['uRadius']!.value = shape.radius;
      uniforms['uAlpha']!.value = shape.alpha;
      return k < 1;
    });
  }

  /** Streaks flung from where a blow meets a body, the way it travels; shorter under reduced motion. */
  private showSparks(at: THREE.Vector3, heading: Heading, scale: number): void {
    const mesh = this.sparks.take();
    const uniforms = (mesh.material as THREE.ShaderMaterial).uniforms;
    const reach = this.reducedMotion ? 0.5 : 1;
    uniforms['uLen']!.value = 0.2 * scale * reach;
    uniforms['uTravel']!.value = 0.38 * scale * reach;
    mesh.position.set(at.x, at.y + SPARK_HEIGHT, at.z);
    mesh.rotation.set(0, headingRadians(heading), 0);
    mesh.rotateZ(Math.random() * Math.PI * 2);
    this.animate(mesh, (elapsed) => {
      const k = Math.min(1, elapsed / SPARK_SECONDS);
      uniforms['uT']!.value = k;
      return k < 1;
    });
  }

  /** The white over a body, `strength` from nothing to whole. */
  private setFlash(entityId: string, body: EffectBody, strength: number): void {
    const hulls = this.hullsFor(entityId, body);
    if (hulls === undefined) return;
    hulls.flashMaterial.opacity = strength;
    for (const mesh of hulls.flash) mesh.visible = strength > 0;
  }

  /**
   * The flash and the outline over the body's meshes, built the first time either is needed and
   * again when the body carries another model. They draw the model's own geometry, on its skeleton,
   * from the effects' root: a mesh there is on no portrait's layer.
   */
  private hullsFor(entityId: string, body: EffectBody): Hulls | undefined {
    const model = body.modelHolder.children[0];
    if (model === undefined) return undefined;
    const built = this.hulls.get(entityId);
    if (built?.model === model) return built;
    this.dropHulls(entityId);
    const sources: THREE.Mesh[] = [];
    model.traverse((object) => {
      if ((object as THREE.Mesh).isMesh) sources.push(object as THREE.Mesh);
    });
    const { flashMaterial, outlineMaterial, thickness } = this.spareHullMaterials.pop() ?? { flashMaterial: flashMaterialFor(), ...outlineFor() };
    const hulls: Hulls = {
      model,
      flash: sources.map((source) => this.hull(source, flashMaterial, 6)),
      flashMaterial,
      outline: sources.map((source) => this.hull(source, outlineMaterial, 3)),
      outlineMaterial,
      thickness,
      unitsPerMetre: unitsPerMetre(sources, body.headHeight),
    };
    this.hulls.set(entityId, hulls);
    return hulls;
  }

  private hull(source: THREE.Mesh, material: THREE.Material, renderOrder: number): THREE.Mesh {
    let hull: THREE.Mesh;
    const skinned = source as THREE.SkinnedMesh;
    if (skinned.isSkinnedMesh) {
      // Bound where the effects' root holds it, at the origin, so the bones alone place it, as they do the model.
      const bound = new THREE.SkinnedMesh(source.geometry, material);
      bound.bind(skinned.skeleton, skinned.bindMatrix);
      hull = bound;
    } else {
      hull = new THREE.Mesh(source.geometry, material);
      hull.matrixAutoUpdate = false;
      hull.matrixWorldAutoUpdate = false;
      hull.onBeforeRender = () => hull.matrixWorld.copy(source.matrixWorld);
    }
    hull.visible = false;
    hull.frustumCulled = false;
    hull.renderOrder = renderOrder;
    this.root.add(hull);
    return hull;
  }

  private dropHulls(entityId: string): void {
    const hulls = this.hulls.get(entityId);
    if (hulls === undefined) return;
    for (const mesh of [...hulls.flash, ...hulls.outline]) mesh.removeFromParent();
    // The geometry and the skeleton are the model's; only the materials are the hulls' own, kept for the next hulls.
    const { flashMaterial, outlineMaterial, thickness } = hulls;
    this.spareHullMaterials.push({ flashMaterial, outlineMaterial, thickness });
    this.hulls.delete(entityId);
  }
}

/** When the clip's blow lands, in seconds from its start; at once for no clip, or one whose moment is not known. */
function strikeDelay(clip: THREE.AnimationClip | undefined): number {
  return clip === undefined ? 0 : clip.duration * (STRIKE_AT[clip.name] ?? 0);
}

function headingBetween(from: EffectBody, to: EffectBody): Heading {
  return headingFromVector(to.node.position.x - from.node.position.x, to.node.position.z - from.node.position.z);
}

function resetJolt(jolt: THREE.Object3D): void {
  jolt.position.set(0, 0, 0);
  jolt.rotation.set(0, 0, 0);
  jolt.scale.set(1, 1, 1);
}

/** Model units per metre of the body's standing height, from its meshes' rest bounds, which share one bind space. */
function unitsPerMetre(meshes: readonly THREE.Mesh[], headHeight: number): number {
  const bounds = new THREE.Box3();
  for (const mesh of meshes) {
    mesh.geometry.computeBoundingBox();
    bounds.union(mesh.geometry.boundingBox!);
  }
  const height = bounds.isEmpty() ? 0 : Math.max(bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z);
  return height > 0 && headHeight > 0 ? height / headHeight : 1;
}

/** Where the camera looks from, which the trail's band faces. */
const CAMERA_DIRECTION = (() => {
  const direction = offsetDirection();
  return new THREE.Vector3(direction.x, direction.y, direction.z);
})();

/**
 * The arc's band, `segments` steps across `COMBAT.swingArcDegrees` from its left edge to its right,
 * with the share of the sweep and the radius at each vertex for the fragment stage.
 */
function arcGeometry(inner: number, outer: number): THREE.BufferGeometry {
  const segments = 48;
  const rings = 10;
  const span = THREE.MathUtils.degToRad(COMBAT.swingArcDegrees);
  const positions: number[] = [];
  const shares: number[] = [];
  const radii: number[] = [];
  const indices: number[] = [];
  for (let step = 0; step <= segments; step += 1) {
    const share = step / segments;
    const angle = span / 2 - share * span;
    for (let band = 0; band <= rings; band += 1) {
      const radius = inner + ((outer - inner) * band) / rings;
      positions.push(Math.sin(angle) * radius, 0, Math.cos(angle) * radius);
      shares.push(share);
      radii.push(radius);
    }
  }
  for (let step = 0; step < segments; step += 1) {
    for (let band = 0; band < rings; band += 1) {
      const a = step * (rings + 1) + band;
      const b = a + rings + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aShare', new THREE.Float32BufferAttribute(shares, 1));
  geometry.setAttribute('aRadius', new THREE.Float32BufferAttribute(radii, 1));
  geometry.setIndex(indices);
  return geometry;
}

/**
 * The arc in line art: a rim at the reach, a lighter one inside, the sweep's leading edge as a
 * line, and a faint wash behind it. Drawn over the bodies, as a slash is: at the game's scale the
 * near Ghost would hide most of a depth-tested arc.
 */
const ARC_MATERIAL = new THREE.ShaderMaterial({
  uniforms: {
    uHead: { value: 0 },
    uFade: { value: 1 },
    uInner: { value: 0.2 },
    uOuter: { value: 1 },
    uTrail: { value: 0.35 },
    uRim: { value: 0.045 },
    uSpan: { value: THREE.MathUtils.degToRad(COMBAT.swingArcDegrees) },
  },
  vertexShader: /* glsl */ `
    attribute float aShare; attribute float aRadius; varying float vShare; varying float vRadius;
    void main() { vShare = aShare; vRadius = aRadius; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform float uHead, uFade, uInner, uOuter, uTrail, uRim, uSpan;
    varying float vShare; varying float vRadius;
    void main() {
      float behind = uHead - vShare;
      if (behind < 0.0) discard;
      float near = 1.0 - smoothstep(0.0, uTrail, behind);
      float across = clamp((vRadius - uInner) / (uOuter - uInner), 0.0, 1.0);
      float rimOuter = 1.0 - smoothstep(uRim * 0.55, uRim, uOuter - vRadius);
      float rimInner = (1.0 - smoothstep(uRim * 0.3, uRim * 0.6, vRadius - uInner)) * 0.55;
      float headLine = (1.0 - smoothstep(uRim * 0.55, uRim, behind * uSpan * vRadius)) * smoothstep(0.0, 0.25, across);
      float wash = 0.16 * near * across;
      float alpha = max(max(rimOuter * mix(0.55, 1.0, near), rimInner * near), max(headLine * step(uHead, 0.999), wash));
      gl_FragColor = vec4(1.0, 1.0, 1.0, alpha * uFade);
      #include <colorspace_fragment>
    }`,
  transparent: true,
  depthWrite: false,
  depthTest: false,
  side: THREE.DoubleSide,
});

const ARC_GEOMETRIES = {
  swing: arcGeometry(ARC_SHAPES.swing.inner, ARC_SHAPES.swing.outer),
  cleave: arcGeometry(ARC_SHAPES.cleave.inner, ARC_SHAPES.cleave.outer),
} as const;

function arcMesh(kind: ArcKind): THREE.Mesh {
  const shape = ARC_SHAPES[kind];
  const material = ARC_MATERIAL.clone();
  material.uniforms['uInner']!.value = shape.inner;
  material.uniforms['uOuter']!.value = shape.outer;
  material.uniforms['uTrail']!.value = shape.trail;
  const mesh = new THREE.Mesh(ARC_GEOMETRIES[kind], material);
  mesh.renderOrder = 5;
  return mesh;
}

/** A flat band on one quad, for every wave, pulse, and puff of dust. */
const RING_MATERIAL = new THREE.ShaderMaterial({
  uniforms: {
    uRadius: { value: 0.5 },
    uWidth: { value: 0.05 },
    uMax: { value: 1 },
    uAlpha: { value: 1 },
    uColor: { value: new THREE.Color(WHITE) },
  },
  vertexShader: /* glsl */ `varying vec2 vPlane; void main() { vPlane = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform float uRadius, uWidth, uMax, uAlpha; uniform vec3 uColor; varying vec2 vPlane;
    void main() {
      float along = length(vPlane) * uMax;
      float soft = max(0.012, uWidth * 0.35);
      float alpha = 1.0 - smoothstep(uWidth * 0.5 - soft, uWidth * 0.5, abs(along - uRadius));
      if (alpha <= 0.003) discard;
      gl_FragColor = vec4(uColor, alpha * uAlpha);
      #include <colorspace_fragment>
    }`,
  transparent: true,
  depthWrite: false,
  side: THREE.DoubleSide,
});

const RING_QUAD = new THREE.PlaneGeometry(2, 2);

function ringMesh(): THREE.Mesh {
  const mesh = new THREE.Mesh(RING_QUAD, RING_MATERIAL.clone());
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 4;
  return mesh;
}

const SPARK_STREAKS = 9;

/** Streaks in a cone round +Z, the way the blow travels, lifted a little: a quad each, stretched along its direction in the vertex stage. */
const SPARK_GEOMETRY = (() => {
  const directions: number[] = [];
  const corners: number[] = [];
  const speeds: number[] = [];
  const indices: number[] = [];
  let seed = 3;
  const random = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let streak = 0; streak < SPARK_STREAKS; streak += 1) {
    const yaw = (random() - 0.5) * 2.2;
    const pitch = (random() - 0.25) * 1.1;
    const direction = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
    const speed = 0.55 + random() * 0.6;
    for (const corner of [
      [0, -1],
      [0, 1],
      [1, -1],
      [1, 1],
    ]) {
      directions.push(...direction);
      corners.push(...corner);
      speeds.push(speed);
    }
    const base = streak * 4;
    indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Array<number>(SPARK_STREAKS * 12).fill(0), 3));
  geometry.setAttribute('aDirection', new THREE.Float32BufferAttribute(directions, 3));
  geometry.setAttribute('aCorner', new THREE.Float32BufferAttribute(corners, 2));
  geometry.setAttribute('aSpeed', new THREE.Float32BufferAttribute(speeds, 1));
  geometry.setIndex(indices);
  return geometry;
})();

const SPARK_MATERIAL = new THREE.ShaderMaterial({
  uniforms: { uT: { value: 0 }, uLen: { value: 0.2 }, uWidth: { value: 0.035 }, uTravel: { value: 0.38 } },
  vertexShader: /* glsl */ `
    attribute vec3 aDirection; attribute vec2 aCorner; attribute float aSpeed;
    uniform float uT, uLen, uWidth, uTravel;
    void main() {
      float eased = 1.0 - pow(1.0 - uT, 3.0);
      float tail = 0.04 + uTravel * aSpeed * eased;
      float tip = tail + uLen * aSpeed * (1.0 - uT);
      vec4 viewed = modelViewMatrix * vec4(aDirection * mix(tail, tip, aCorner.x), 1.0);
      vec3 along = (modelViewMatrix * vec4(aDirection, 0.0)).xyz;
      vec2 across = normalize(vec2(-along.y, along.x) + 1e-5);
      viewed.xy += across * aCorner.y * uWidth * 0.5;
      gl_Position = projectionMatrix * viewed;
    }`,
  fragmentShader: /* glsl */ `
    uniform float uT;
    void main() {
      gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0 - uT * uT);
      #include <colorspace_fragment>
    }`,
  transparent: true,
  depthWrite: false,
  depthTest: false,
});

function sparkMesh(): THREE.Mesh {
  const mesh = new THREE.Mesh(SPARK_GEOMETRY, SPARK_MATERIAL.clone());
  mesh.renderOrder = 8;
  return mesh;
}

/** A lunge's trail: a band of two rows of vertices, its edges drawn as lines over a faint fill, fading with each sample's age. */
const TRAIL_MATERIAL = new THREE.ShaderMaterial({
  uniforms: { uLife: { value: LUNGE_TRAIL_SECONDS } },
  vertexShader: /* glsl */ `attribute float aSide; attribute float aAge; varying float vSide; varying float vAge; void main() { vSide = aSide; vAge = aAge; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform float uLife; varying float vSide; varying float vAge;
    void main() {
      float life = clamp(1.0 - vAge / uLife, 0.0, 1.0);
      float edge = max(1.0 - smoothstep(0.1, 0.18, vSide), smoothstep(0.82, 0.9, vSide));
      float alpha = max(edge, 0.2) * life;
      if (alpha <= 0.003) discard;
      gl_FragColor = vec4(1.0, 1.0, 1.0, alpha);
      #include <colorspace_fragment>
    }`,
  transparent: true,
  depthWrite: false,
  side: THREE.DoubleSide,
});

function trailMesh(): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(LUNGE_TRAIL_SAMPLES * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute(
    'aSide',
    new THREE.BufferAttribute(
      new Float32Array(LUNGE_TRAIL_SAMPLES * 2).map((_, index) => index % 2),
      1,
    ),
  );
  geometry.setAttribute('aAge', new THREE.BufferAttribute(new Float32Array(LUNGE_TRAIL_SAMPLES * 2), 1).setUsage(THREE.DynamicDrawUsage));
  const indices: number[] = [];
  for (let sample = 0; sample < LUNGE_TRAIL_SAMPLES - 1; sample += 1) {
    const a = sample * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  geometry.setIndex(indices);
  const mesh = new THREE.Mesh(geometry, TRAIL_MATERIAL.clone());
  mesh.renderOrder = 4;
  return mesh;
}

/** The "!" a challenged nightmare wears: white, outlined dark, drawn over everything. Made with the first mark and never freed. */
let markMaterial: THREE.SpriteMaterial | undefined;

function markTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  if (context !== null) {
    context.font = '900 104px system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.lineJoin = 'round';
    context.lineWidth = 22;
    context.strokeStyle = 'rgba(12, 10, 16, 0.92)';
    context.strokeText('!', 64, 68);
    context.fillStyle = '#ffffff';
    context.fillText('!', 64, 68);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function markSprite(): THREE.Sprite {
  markMaterial ??= new THREE.SpriteMaterial({ map: markTexture(), depthTest: false, depthWrite: false, transparent: true, toneMapped: false });
  const sprite = new THREE.Sprite(markMaterial.clone());
  sprite.renderOrder = 10;
  return sprite;
}

/** Whitens a body as a blow lands: lerped toward white by its opacity, laid just in front of the body's own surface. */
const FLASH_MATERIAL = new THREE.MeshBasicMaterial({
  color: WHITE,
  transparent: true,
  opacity: 0,
  depthWrite: false,
  toneMapped: false,
  polygonOffset: true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits: -1,
});

function flashMaterialFor(): THREE.MeshBasicMaterial {
  return FLASH_MATERIAL.clone();
}

/**
 * The brace's outline: the body's back faces pushed out along their normals by `thickness`, in
 * model units. Every body's outline shares one program by its cache key, each with its own thickness.
 */
function outlineFor(): Pick<Hulls, 'outlineMaterial' | 'thickness'> {
  const thickness = { value: 0 };
  const material = new THREE.MeshBasicMaterial({
    color: WHITE,
    side: THREE.BackSide,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    toneMapped: false,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms['uThickness'] = thickness;
    shader.vertexShader = `uniform float uThickness;\n${shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed += normalize(normal) * uThickness;')}`;
  };
  material.customProgramCacheKey = () => BRACE_OUTLINE_NAME;
  return { outlineMaterial: material, thickness };
}

const BRACE_OUTLINE_NAME = 'somnio-brace-outline';
