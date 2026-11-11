/**
 * Combat's feedback in the world: the arcs of swings and Cleave, what a landed blow does to the
 * bodies it names, the word over a body a blow missed, the light of a mend and of a raise, the
 * Mystic's shells, bolts, bindings, and mist, and the marks of the abilities. All of it is the
 * client's own: it reads the `blow`, `ability`, `effects`, `mend`, and `raising` frames and changes
 * nothing that is sent.
 *
 * The arcs, rings, sparks, trails, motes, bolts, cracks, domes, and miss words come from pools that
 * stop growing at their size and are reused oldest first. What lasts as long as the server says (a
 * Challenge mark, a channel's beam and stream, a raise's ring, a ward's shell, a binding's runes and
 * tethers) waits for a free one instead. A body's flash and outline hulls are built for its model
 * and take the materials of hulls dropped. Each kind of mesh draws with clones of one material, so
 * a kind's program compiles once, in the scene's prewarm, and none adds a light. Everything hangs
 * on the effects' own root, never in a model holder, so no portrait shows it.
 */
import * as THREE from 'three';
import {
  ABILITIES,
  COMBAT,
  SOMNIO_CONSTANTS,
  angularDistance,
  areaRecipients,
  boltFlightSeconds,
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
import { raiseShownAt } from '@/client/renderSurface';
import type { AbilityShown, RaiseProgress } from '@/client/renderSurface';
import type { OneShot } from './animation';
import { offsetDirection } from './cameraRig';

/**
 * When the weapon lands, or the gesture peaks, as a share of each clip: measured off the clips' hand
 * bones, where the blade crosses the front, the chop comes down, the fist and the casting hand reach
 * furthest, the arms come up, the circling hands sink lowest, the long cast's hand pushes out at its
 * end, and the throwing hand lets go, coming forward fastest. A clip left out lands at once.
 */
export const STRIKE_AT: Readonly<Record<string, number>> = {
  Melee_1H_Attack_Slice_Horizontal: 0.2,
  Melee_1H_Attack_Jump_Chop: 0.57,
  Ranged_Magic_Raise: 0.26,
  Melee_Block: 0.32,
  Cheering: 0.1,
  Punch: 0.27,
  Ranged_Magic_Shoot: 0.35,
  Ranged_Magic_Spellcasting: 0.5,
  Ranged_Magic_Spellcasting_Long: 0.63,
  Throw: 0.53,
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
  /**
   * Plays a one-shot on the body and answers its clip, or `undefined` when none plays. With
   * `landsIn`, the clip starts as far in as puts its landing that many seconds off.
   */
  playOneShot(entityId: string, oneShot: OneShot, landsIn?: number): THREE.AnimationClip | undefined;
  /** Ends the one-shot the body plays, so its looping pose fades back in. */
  endOneShot(entityId: string): void;
  /** The word over a body a blow missed, drawn as the plaques are; made once for each in its pool. */
  missWord(): THREE.Object3D;
  /** How many times its size in metres the overlay art is drawn, which the miss word follows. */
  overlayScale(): number;
  /** The wall clock, in milliseconds. */
  now(): number;
}

/**
 * The pools' sizes. Past its size a pool hands out its oldest mesh again, but the marks', streams',
 * beams', raise rings', shells', runes', and tethers' pools only a free one, since what they draw
 * lasts as long as the server says.
 */
export const EFFECT_POOL_SIZES = {
  swingArcs: 4,
  cleaveArcs: 4,
  rings: 40,
  sparks: 12,
  trails: 4,
  marks: 8,
  motes: 16,
  streams: 4,
  beams: 4,
  raiseRings: 6,
  misses: 6,
  shells: 6,
  bolts: 4,
  cracks: 4,
  runes: 4,
  tethers: 4,
  domes: 2,
} as const;

/** The name of the group every effect hangs on. */
export const COMBAT_EFFECTS_NAME = 'somnio-combat-effects';

/**
 * The `userData` key marking a mesh hung on a body that is no part of it, a model in a hand. The
 * flash and the outline cover the body alone, so swapping what a hand holds leaves them as built.
 */
export const HELD_PROP = 'somnioHeldProp';

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

/** How a landed blow shows: the hit-pause, the shake when it names the player, the sparks' size, and how long the body flashes and how far it staggers. */
interface Landing {
  pauseMs: number;
  shakeMetres: number;
  sparkScale: number;
  flashSeconds: number;
  knockMetres: number;
}
const FLASH_SECONDS = 0.14;
const KNOCK_METRES = 0.08;
const SWING_LANDING: Landing = { pauseMs: 60, shakeMetres: 0.04, sparkScale: 1, flashSeconds: FLASH_SECONDS, knockMetres: KNOCK_METRES };
/** Each nightmare a Cleave meets pauses for less, since the sweep meets them one after another. */
const CLEAVE_LANDING: Landing = { pauseMs: 45, shakeMetres: 0.06, sparkScale: 1.25, flashSeconds: FLASH_SECONDS, knockMetres: KNOCK_METRES };
const STRIKE_LANDING: Landing = { pauseMs: 45, shakeMetres: 0.035, sparkScale: 0.7, flashSeconds: FLASH_SECONDS, knockMetres: KNOCK_METRES };
/** A blow on a braced or warded dreamer: the brace or the ward takes it, and only the striker pauses. */
const SHIELDED_LANDING: Landing = { pauseMs: 50, shakeMetres: 0.02, sparkScale: 0.8, flashSeconds: FLASH_SECONDS, knockMetres: KNOCK_METRES };
/** A Dream-bolt bursting on a nightmare: a longer pause, a harder shake, a longer flash, and a further stagger than a swing's. */
const BOLT_LANDING: Landing = { pauseMs: 80, shakeMetres: 0.06, sparkScale: 1.3, flashSeconds: 0.22, knockMetres: 0.13 };

/**
 * How long the effects may go without a tick, on the wall clock, before they count as stalled. A
 * drawing tab ticks far more often, however slowly, so only a hidden one goes this long.
 */
const STALE_EFFECT_MS = 1500;
/** How long after a Cleave its blows arrive, at most: they follow its `ability` frame in the same batch. */
const CLEAVE_BLOW_WINDOW_MS = 100;
const KNOCK_OUT_SECONDS = 0.05;
const KNOCK_BACK_SECONDS = 0.3;
const KNOCK_TILT = 0.22;
const SPARK_HEIGHT = 0.4;
const SPARK_SECONDS = 0.24;
/** How far a Dream-bolt's shards drop by the end of their flight. */
const SHARD_FALL_METRES = 0.35;
const SHAKE_DECAY_SECONDS = 0.045;
const LINE_WIDTH = 0.045;
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
/** The Moonstone's light, in which every mend and heal shows, apart from the health colours and the raise's gold. */
export const MOONLIGHT = 0xd8e6ff;
export const RAISE_COLOR = 0xffd27a;
/** Calm's cool blue, apart from the moonlight of a heal. */
const CALM_COLOR = 0x9fd8ff;
/** Gap between a body's head and the word over it a blow missed, and how long the word stays up. */
const MISS_HEAD_GAP = 0.2;
const MISS_SECONDS = 0.8;
/** A raise's ring lies round a fallen body at this many body radii, clear of it lying down. */
export const RAISE_RING_RADII = 2;
/** The width of the rings drawn flat on the ground: the selection ring, the lock's reticle, the press marker, and a raise's ring. */
export const GROUND_RING_WIDTH = 0.08;
/** How far above a body's feet every ring on the ground under it lies. */
export const GROUND_RING_LIFT = 0.03;
/** The share of its brightness the rest of a raise's ring shows at, so how far it has gone reads from the start. */
const RAISE_TRACK = 0.25;
/** How high on a body the light of a mend gathers, and how far it rises. */
const CHEST_HEIGHT = 0.8;
/** How long a channel's look holds past its end when neither its landing nor its break arrives. */
const CHANNEL_GRACE_SECONDS = 0.5;
/** How long a channel's beam and stream take to fade once it lands or breaks. */
const CHANNEL_FADE_SECONDS = 0.18;
/** A heal over time gives its health once a second, and its holder's light pulses with it. */
const RENEW_PULSE_SECONDS = 1;
const RENEWING_SECONDS = effectSeconds('renewing', 1);
/** Radiance reaches the centre of a body as wide as a dreamer at the edge of its range. */
const RADIANCE_WAVE_RADIUS = 2 * SOMNIO_CONSTANTS.playerRadius + ABILITIES.radiance.range;
const RADIANCE_WAVE_SECONDS = 0.5;
const RADIANCE_LIFT_METRES = 0.1;
const CALMED_SECONDS = effectSeconds('calmed', 1);
const CALM_THICKNESS = 0.02;
/** The Mystic's dream violet, in which every ward, curse, and binding shows. */
export const DREAM_COLOR = 0xc4a8ff;
/** The harsher violet a Dream-bolt's edges, crack, and shards burn in, round a white-hot core. */
const BOLT_COLOR = 0xa13cff;
/** The mist a Veil hides dreamers in. */
const MIST_COLOR = 0xbdb6d8;
const WARDED_SECONDS = effectSeconds('warded', 1);
const WEAKENED_SECONDS = effectSeconds('weakened', 1);
const BOUND_SECONDS = effectSeconds('bound', 1);
const VEILED_SECONDS = effectSeconds('veiled', 1);
/** A ward's shell round a body: its middle and its half height as shares of the body's standing height, and its half width. */
const SHELL_MIDDLE = 0.5;
const SHELL_HALF_HEIGHT = 0.6;
const SHELL_HALF_WIDTH = 0.55;
/** How long a shell takes to form, facet by facet, and to fly apart once spent. */
const SHELL_FORM_SECONDS = 0.3;
const SHELL_SHATTER_SECONDS = 0.5;
/** The share of a shell's facets each blow it takes knocks out. */
const SHELL_CRACK_SHARE = 0.14;
/** A ward the server ends this long or more before its time was spent by a blow, and shatters rather than fading. */
const SHELL_SPENT_SECONDS = 0.3;
/** How high on its caster a bolt leaves, as a share of their standing height, and how far in front. */
const BOLT_HAND = 0.62;
const BOLT_REACH_OUT = 0.35;
const BOLT_TRAIL_METRES = 1.6;
/** How high over the straight line a bolt arcs at its middle. */
const BOLT_ARC_METRES = 0.06;
/** How long the crack a bolt leaves on the body takes to shoot out, and how long it lasts. */
const CRACK_GROW_SECONDS = 0.05;
const CRACK_SECONDS = 0.25;
/** A weakened nightmare's sap sinks out of it this often while the curse holds. */
const WEAKEN_PULSE_SECONDS = 1.4;
const WEAKEN_THICKNESS = 0.016;
/** A binding's runes lie round the bound body's feet this far out, and its tethers take hold of it this high, as a share of its height. */
const BIND_RUNE_RADIUS = 0.85;
const BIND_GRIP = 0.45;
/** How long the tethers take to snap up from the runes to the body. */
const BIND_SNAP_SECONDS = 0.14;
/** Veil's mist reaches the centre of a body as wide as a dreamer at the edge of its range. */
const VEIL_DOME_RADIUS = 2 * SOMNIO_CONSTANTS.playerRadius + ABILITIES.veil.range;
const VEIL_RISE_SECONDS = 0.45;
const VEIL_DOME_SECONDS = 1.6;
/** How strongly the mist dims a veiled body, and how often mist rises off it. */
const VEIL_SHADE = 0.42;
const VEIL_PULSE_SECONDS = 1.2;

const easeOut = (k: number): number => 1 - (1 - k) ** 3;

/** How long a wave going out to `radius` over `seconds`, easing out, takes to reach a body `metres` off: `easeOut` run backwards. */
const waveArrival = (metres: number, radius: number, seconds: number): number => seconds * (1 - Math.cbrt(1 - Math.min(1, metres / radius)));

/** A wave's ring: out to `radius` over `seconds`, at `alpha`, fading from `fadeFrom` seconds in until `tail` seconds after it arrives. */
interface Wave {
  radius: number;
  seconds: number;
  fadeFrom: number;
  tail: number;
  alpha: number;
  width: number;
  color?: number;
}

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
  flash: { start: number; seconds: number } | undefined;
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

/** A look that pulses on its body while it holds: a renewal's light, a weakened nightmare's sinking sap, a veil's mist. */
interface Pulsing extends Timed {
  /** When its next pulse goes out, or `undefined` before its first, which goes out as it shows. */
  nextPulse: number | undefined;
}

/**
 * A ward's shell: cracked by each blow it takes, and shattering once a blow spends it. It takes
 * blows from `heldFrom`, when it is put on, and its shell forms from `startsAt`, which is later
 * for a ward put on over one still flying apart.
 */
interface Ward extends Timed {
  heldFrom: number;
  shell: THREE.Mesh | undefined;
  cracks: number;
  crackAt: number;
  /** Spent by a blow still on its way, which shatters it as it lands. */
  spent: boolean;
  /**
   * The blows on their way that land before the one that spent it, which it still takes: the
   * server lands a step's blows in order, so the last on its way when it ends the ward spent it.
   */
  takesFirst: number;
  shatterAt: number | undefined;
  /** The ward used up, spent or shattering, that this one was put on over, whose shell flies apart before this one's forms. */
  replaces: Ward | undefined;
}

/** A binding's runes round the bound body's feet and the tethers from them to it. */
interface Binding extends Timed {
  runes: THREE.Mesh | undefined;
  tethers: THREE.Mesh | undefined;
}

/* How each kind of timed look starts from its time alone, one for a cast and an `effects` frame alike. */
const startBrace = (timed: Timed): Brace => ({ ...timed, pulseAt: Number.NEGATIVE_INFINITY });
const startMark = (timed: Timed): ChallengeMark => ({ ...timed, sprite: undefined, nextPulse: undefined });
const startPulsing = (timed: Timed): Pulsing => ({ ...timed, nextPulse: undefined });
const startCalm = (timed: Timed): Timed => ({ ...timed });
const startWard = (timed: Timed): Ward => ({
  ...timed,
  heldFrom: timed.startsAt,
  shell: undefined,
  cracks: 0,
  crackAt: Number.NEGATIVE_INFINITY,
  spent: false,
  takesFirst: 0,
  shatterAt: undefined,
  replaces: undefined,
});
const startBinding = (timed: Timed): Binding => ({ ...timed, runes: undefined, tethers: undefined });

/**
 * A channel's look: a beam from its user to whom it lands on, unless that is the user, light
 * gathering round the recipient, and a ring drawing in under the user. It holds until the channel
 * lands or breaks, which sets `endedAt`, or past `until` when neither arrives.
 */
interface ChannelLook {
  until: number;
  endedAt: number | undefined;
}

/** A raise's ring as its last snapshot states it, from `anchoredAt` on the effects' clock. */
interface RaiseRing extends RaiseProgress {
  mesh: THREE.Mesh | undefined;
  anchoredAt: number;
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
  /** Work waiting on the effects' clock, and the body a blow among it lands on as a hit. */
  private scheduled: { at: number; run: () => void; hits: string | undefined }[] = [];
  /** The wall time of the last tick, or of construction before the first. */
  private lastTickMs: number;
  private readonly running = new Map<THREE.Object3D, Running>();
  private readonly pools: EffectPool<THREE.Object3D>[] = [];
  private readonly arcs: Record<ArcKind, EffectPool<THREE.Mesh>>;
  private readonly rings: EffectPool<THREE.Mesh>;
  private readonly sparks: EffectPool<THREE.Mesh>;
  private readonly trails: EffectPool<THREE.Mesh>;
  private readonly marks: EffectPool<THREE.Sprite>;
  private readonly motes: EffectPool<THREE.Mesh>;
  private readonly streams: EffectPool<THREE.Mesh>;
  private readonly beams: EffectPool<THREE.Mesh>;
  private readonly raiseRingMeshes: EffectPool<THREE.Mesh>;
  private readonly misses: EffectPool<THREE.Object3D>;
  private readonly shells: EffectPool<THREE.Mesh>;
  private readonly bolts: EffectPool<THREE.Mesh>;
  private readonly cracks: EffectPool<THREE.Mesh>;
  private readonly runes: EffectPool<THREE.Mesh>;
  private readonly tethers: EffectPool<THREE.Mesh>;
  private readonly domes: EffectPool<THREE.Mesh>;
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
  private readonly renewals = new Map<string, Pulsing>();
  private readonly calms = new Map<string, Timed>();
  private readonly channels = new Map<string, ChannelLook>();
  private readonly raises = new Map<string, RaiseRing>();
  private readonly wards = new Map<string, Ward>();
  private readonly weakens = new Map<string, Pulsing>();
  private readonly binds = new Map<string, Binding>();
  private readonly veils = new Map<string, Pulsing>();
  /** How each effect's look is held to what the server says of it, so an effect with no look is a choice made here. */
  private readonly effectLooks: Record<EffectId, (entityId: string, held: { seconds?: number } | undefined, stalledFor: number) => void> = {
    braced: (entityId, held, stalledFor) => this.timeLook(this.braces, entityId, held, stalledFor, startBrace),
    challenged: (entityId, held, stalledFor) => this.timeLook(this.challenged, entityId, held, stalledFor, startMark),
    renewing: (entityId, held, stalledFor) => this.timeLook(this.renewals, entityId, held, stalledFor, startPulsing),
    calmed: (entityId, held, stalledFor) => this.timeLook(this.calms, entityId, held, stalledFor, startCalm),
    warded: (entityId, held, stalledFor) => this.holdWard(entityId, held, stalledFor),
    weakened: (entityId, held, stalledFor) => this.timeLook(this.weakens, entityId, held, stalledFor, startPulsing),
    bound: (entityId, held, stalledFor) => this.timeLook(this.binds, entityId, held, stalledFor, startBinding),
    veiled: (entityId, held, stalledFor) => this.timeLook(this.veils, entityId, held, stalledFor, startPulsing),
  };
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
    this.motes = this.pool(moteMesh, EFFECT_POOL_SIZES.motes);
    this.streams = this.pool(moteMesh, EFFECT_POOL_SIZES.streams);
    this.beams = this.pool(beamMesh, EFFECT_POOL_SIZES.beams);
    this.raiseRingMeshes = this.pool(raiseRingMesh, EFFECT_POOL_SIZES.raiseRings);
    this.misses = this.pool(() => host.missWord(), EFFECT_POOL_SIZES.misses);
    this.shells = this.pool(shellMesh, EFFECT_POOL_SIZES.shells);
    this.bolts = this.pool(boltMesh, EFFECT_POOL_SIZES.bolts);
    this.cracks = this.pool(crackMesh, EFFECT_POOL_SIZES.cracks);
    this.runes = this.pool(ringMesh, EFFECT_POOL_SIZES.runes);
    this.tethers = this.pool(tetherMesh, EFFECT_POOL_SIZES.tethers);
    this.domes = this.pool(domeMesh, EFFECT_POOL_SIZES.domes);
  }

  private pool<T extends THREE.Object3D>(make: () => T, size: number): EffectPool<T> {
    const pool = new EffectPool(() => {
      const item = make();
      item.visible = false;
      item.frustumCulled = false;
      this.root.add(item);
      return item;
    }, size);
    this.pools.push(pool);
    return pool;
  }

  /**
   * Compiles the program of every kind the effects draw, in `scene`'s light, so none compiles on its
   * first use mid-fight: a first item of each pool, and a flash and an outline over a rigid and a
   * skinned mesh, whose materials the first body's hulls then take. Those meshes carry positions and
   * normals, as a body's do, since the program reads both.
   */
  async compile(renderer: Pick<THREE.WebGLRenderer, 'compileAsync'>, camera: THREE.Camera, scene: THREE.Scene): Promise<void> {
    for (const pool of this.pools) pool.take();
    const materials = { flashMaterial: flashMaterialFor(), ...outlineFor() };
    const geometry = new THREE.PlaneGeometry();
    const hulls = [new THREE.Mesh(geometry), skinnedMesh(geometry)].flatMap((source) => [
      this.hull(source, materials.flashMaterial, 6),
      this.hull(source, materials.outlineMaterial, 3),
    ]);
    await renderer.compileAsync(this.root, camera, scene);
    for (const hull of hulls) hull.removeFromParent();
    this.spareHullMaterials.push(materials);
  }

  /**
   * One swing or strike. A Cleave's blows land as its sweep passes each body. Any other blow plays
   * the attacker's swing and lands when the clip's blade or fist does, and a dreamer's also draws its
   * arc. With no clip to time it by, it lands at once.
   */
  blow(attackerId: string, targetId: string, hit: boolean): void {
    if (this.stalled(this.host.now())) return;
    const cleaveDelay = this.cleaveDelay(attackerId, targetId);
    const hits = hit ? targetId : undefined;
    if (cleaveDelay !== undefined) {
      this.after(cleaveDelay, () => this.land(attackerId, targetId, hit, CLEAVE_LANDING), hits);
      return;
    }
    const strikeIn = strikeDelay(this.host.playOneShot(attackerId, 'swing'));
    const attacker = this.host.body(attackerId);
    const target = this.host.body(targetId);
    if (attacker !== undefined && target !== undefined && attacker.kind !== 'monster') {
      const heading = headingBetween(attacker, target);
      this.after(strikeIn - Math.min(strikeIn, ARC_SHAPES.swing.sweep * 0.7), () => this.showArc('swing', attackerId, heading));
    }
    this.after(strikeIn, () => this.land(attackerId, targetId, hit, attacker?.kind === 'monster' ? STRIKE_LANDING : SWING_LANDING), hits);
  }

  /**
   * An ability used: its user plays it, and it shows as it lands. A channel shows from its start, or
   * from when the player learns of it under way, until it lands or breaks. Its landing or its break
   * ends its look while stalled too, since that is the server's state, but only shows while drawing.
   */
  ability(casterId: string, abilityId: AbilityId, targetId: string | undefined, shown?: AbilityShown): void {
    const channel = shown !== undefined && 'phase' in shown ? shown : undefined;
    const stalled = this.stalled(this.host.now());
    if (channel?.phase === 'done' || channel?.phase === 'broken') {
      this.endChannel(casterId, targetId ?? casterId, channel.phase === 'done', !stalled);
      return;
    }
    if (stalled) return;
    if (channel !== undefined) {
      this.channel(casterId, abilityId, targetId ?? casterId, channel.seconds ?? 0);
      return;
    }
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
      case 'renewal':
        this.renewal(casterId, targetId ?? casterId, strikeIn);
        return;
      case 'radiance':
        this.radiance(casterId, strikeIn);
        return;
      case 'calm':
        this.calm(casterId, strikeIn);
        return;
      case 'ward':
        this.ward(casterId, targetId ?? casterId, strikeIn);
        return;
      case 'weaken':
        this.weaken(casterId, targetId, strikeIn);
        return;
      case 'bind':
        this.bind(casterId, targetId, strikeIn);
        return;
      case 'dream-bolt':
        this.dreamBolt(casterId, targetId, strikeIn, shown !== undefined && 'evaded' in shown);
        return;
      case 'veil':
        this.veil(casterId, strikeIn);
        return;
      case 'deep-mend':
        // A channel always comes with its phase.
        return;
    }
  }

  /** A mend lands on the body: the Moonstone's light swells from its feet and rises through it. */
  mend(targetId: string): void {
    if (this.stalled(this.host.now())) return;
    const target = this.host.body(targetId);
    if (target === undefined) return;
    this.healLight(targetId, target.node.position, 1);
  }

  /**
   * A raise under way on a fallen body, as its last snapshot states it, or `undefined` once it
   * ends: a gold ring round the body, drawn as far round as the raise has gone and running on by its
   * schedule (`raiseShownAt`). It is the server's state, so it is kept while stalled, and the clock's
   * catch-up carries it on.
   */
  raising(targetId: string, raise: RaiseProgress | undefined): void {
    const ring = this.raises.get(targetId);
    if (raise === undefined) {
      if (ring?.mesh !== undefined) this.stop(ring.mesh);
      this.raises.delete(targetId);
      return;
    }
    const now = this.host.now();
    // Counted from when it arrived, between two ticks, as the bar counts it, so a tick does not run it ahead.
    const anchoredAt = this.clock + (now - this.lastTickMs) / 1000;
    this.raises.set(targetId, { ...raise, mesh: ring?.mesh, anchoredAt });
  }

  /**
   * Every effect an entity holds, as the server last said. It is told only of the player's own and
   * of their target's. Each effect's look lasts as long as these say and ends when a frame leaves it
   * out, except that a ward a blow spent shatters as that blow lands (`holdWard`). It is taken while
   * stalled too, since it is the server's state rather than a moment, and the next frame that
   * changes it corrects it. Its seconds count from now, past the catch-up the next tick makes for
   * the stall so far.
   */
  hold(entityId: string, effects: readonly { effectId: EffectId; seconds?: number }[]): void {
    const now = this.host.now();
    const stalledFor = this.stalled(now) ? (now - this.lastTickMs) / 1000 : 0;
    for (const effectId of Object.keys(this.effectLooks) as EffectId[]) {
      this.effectLooks[effectId](
        entityId,
        effects.find((effect) => effect.effectId === effectId),
        stalledFor,
      );
    }
  }

  /**
   * A ward the server ends well before its time was spent by a blow, and its shell shatters as that
   * blow lands, or at once with none on its way to its holder. One that ran out fades. A ward used
   * up, spent or shattering, holds through every later frame until that ends it, and a ward the
   * frame names anew renews it at once (`renewWard`).
   */
  private holdWard(entityId: string, held: { seconds?: number } | undefined, stalledFor: number): void {
    const ward = this.wards.get(entityId);
    const usedUp = ward !== undefined && (ward.spent || ward.shatterAt !== undefined);
    if (held === undefined && ward !== undefined) {
      if (usedUp) return;
      if (ward.until - this.clock >= SHELL_SPENT_SECONDS) {
        const onTheirWay = this.scheduled.filter((entry) => entry.hits === entityId).length;
        if (onTheirWay > 0) Object.assign(ward, { spent: true, takesFirst: onTheirWay - 1 });
        else this.shatter(ward);
        return;
      }
    }
    if (held !== undefined && ward !== undefined && usedUp) {
      this.renewWard(entityId, ward, { startsAt: this.clock, until: this.heldUntil(held, stalledFor) });
      return;
    }
    this.timeLook(this.wards, entityId, held, stalledFor, startWard);
  }

  /**
   * Puts a ward on anew over one used up, if any. It takes blows from `timed.startsAt` on, but its
   * shell forms only once the old one has flown apart: a shattering one at its end, and a spent one
   * once the blow on its way, which is still that ward's, has landed and shattered it
   * (`shatterSpent`).
   */
  private renewWard(entityId: string, old: Ward | undefined, timed: Timed): void {
    const formsAt = old?.spent === true ? Number.POSITIVE_INFINITY : Math.max(timed.startsAt, old?.until ?? timed.startsAt);
    this.wards.set(entityId, { ...startWard(timed), startsAt: formsAt, replaces: old });
  }

  /** The spent ward on a body: its own, or the one a ward put on anew was put on over, until the blow that spent it lands. */
  private spentOf(ward: Ward | undefined): Ward | undefined {
    if (ward?.spent === true) return ward;
    return ward?.replaces?.spent === true ? ward.replaces : undefined;
  }

  /** Shatters the body's spent ward, and has a ward put on over it form once it has flown apart. */
  private shatterSpent(ward: Ward, spent: Ward): void {
    this.shatter(spent);
    if (spent !== ward) ward.startsAt = spent.until;
  }

  private shatter(ward: Ward): void {
    ward.spent = false;
    ward.shatterAt = this.clock;
    ward.until = this.clock + SHELL_SHATTER_SECONDS;
  }

  /**
   * Starts a timed look on the body cast from `timed.startsAt` until `timed.until`, or, on one it
   * already shows, keeps the earlier start and the later end, so a cast again only ever lengthens it.
   */
  private extendLook<T extends Timed>(looks: Map<string, T>, entityId: string, timed: Timed, start: (timed: Timed) => T): void {
    const look = looks.get(entityId);
    if (look === undefined) {
      looks.set(entityId, start(timed));
      return;
    }
    look.startsAt = Math.min(look.startsAt, timed.startsAt);
    look.until = Math.max(look.until, timed.until);
  }

  private timeLook<T extends Timed>(
    looks: Map<string, T>,
    entityId: string,
    held: { seconds?: number } | undefined,
    stalledFor: number,
    start: (timed: Timed) => T,
  ): void {
    const look = looks.get(entityId);
    if (held === undefined) {
      if (look !== undefined) look.until = Math.min(look.until, this.clock);
      return;
    }
    const until = this.heldUntil(held, stalledFor);
    if (look !== undefined) look.until = until;
    else looks.set(entityId, start({ startsAt: this.clock, until }));
  }

  /** When a look the server holds ends: its seconds from now, past the stall so far, or never for one lasting as long as its holder. */
  private heldUntil(held: { seconds?: number }, stalledFor: number): number {
    return held.seconds === undefined ? Number.POSITIVE_INFINITY : this.clock + stalledFor + held.seconds;
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
    this.tickOutlines();
    this.tickChallenged();
    this.tickRenewals();
    this.tickChannels();
    this.tickRaises();
    this.tickWards();
    this.tickWeakens();
    this.tickBinds();
    this.tickVeils();
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
    this.renewals.delete(entityId);
    this.calms.delete(entityId);
    this.channels.delete(entityId);
    this.raising(entityId, undefined);
    const ward = this.wards.get(entityId);
    if (ward !== undefined) this.stopShells(ward);
    this.wards.delete(entityId);
    this.weakens.delete(entityId);
    const binding = this.binds.get(entityId);
    for (const mesh of [binding?.runes, binding?.tethers]) if (mesh !== undefined) this.stop(mesh);
    this.binds.delete(entityId);
    this.veils.delete(entityId);
  }

  /** Ends every effect, for a new space. */
  clear(): void {
    this.dropInFlight();
    for (const id of [...this.hulls.keys()]) this.dropHulls(id);
    for (const object of [...this.running.keys()]) this.stop(object);
    this.braces.clear();
    this.challenged.clear();
    this.cleaves.clear();
    this.renewals.clear();
    this.calms.clear();
    this.channels.clear();
    this.raises.clear();
    this.wards.clear();
    this.weakens.clear();
    this.binds.clear();
    this.veils.clear();
  }

  private after(seconds: number, run: () => void, hits?: string): void {
    if (seconds <= 0) {
      run();
      return;
    }
    this.scheduled.push({ at: this.clock + seconds, run, hits });
  }

  /**
   * Ends what a stall left queued or in flight, so none of it plays on the tab's return: the work
   * still queued unrun (a blow, sweep, or wave still to land), and every arc, ring, spark, mote,
   * bolt, crack, dome, miss word, trail, lunge, stagger, flash, hit-pause, lift, and shake under way.
   * The marks, a channel's beam and stream, a raise's ring, a ward's shell, and a binding's runes
   * and tethers stay, because they last as long as the server says, as an outline does; the clock's
   * catch-up ends those whose time ran out while the tab was hidden. A ward spent by a blow dropped
   * here shatters now, so the catch-up ends it too. Until a tick runs again, `blow`, `ability`, and
   * `mend` start nothing, not even a clip, so the queue stays bounded while the tab stays hidden.
   */
  private dropInFlight(): void {
    this.scheduled = [];
    const kept = new Set<THREE.Object3D>([
      ...this.marks.items,
      ...this.streams.items,
      ...this.beams.items,
      ...this.raiseRingMeshes.items,
      ...this.shells.items,
      ...this.runes.items,
      ...this.tethers.items,
    ]);
    for (const object of [...this.running.keys()]) if (!kept.has(object)) this.stop(object);
    for (const ward of this.wards.values()) {
      const spent = this.spentOf(ward);
      if (spent !== undefined) this.shatterSpent(ward, spent);
    }
    for (const lunge of this.lunges.values()) this.stop(lunge.trail);
    this.lunges.clear();
    for (const [id, jolt] of this.jolts) {
      const body = this.host.body(id);
      if (body === undefined) continue;
      resetJolt(body.jolt);
      if (jolt.flash !== undefined) this.setFlash(id, body, 0);
    }
    this.jolts.clear();
    this.shakeAmplitude = 0;
  }

  /**
   * Moves the clock on by the seconds a stall lasted, so what would have run out while the tab was
   * hidden has: a look whose effect ended, a brace's swell, a mark's pop. A pulse the stall skipped,
   * a Challenge mark's, a Renewal's, a Weaken's, or a Veil's, is not sent late: the next goes out on
   * the first beat after the clock.
   */
  private catchUp(seconds: number): void {
    this.clock += seconds;
    const skip = (look: { nextPulse: number | undefined }, beat: number) => {
      if (look.nextPulse === undefined || look.nextPulse > this.clock) return;
      look.nextPulse += beat * (Math.floor((this.clock - look.nextPulse) / beat) + 1);
    };
    for (const mark of this.challenged.values()) skip(mark, CHALLENGE_PULSE_SECONDS);
    for (const renewal of this.renewals.values()) skip(renewal, RENEW_PULSE_SECONDS);
    for (const weaken of this.weakens.values()) skip(weaken, WEAKEN_PULSE_SECONDS);
    for (const veil of this.veils.values()) skip(veil, VEIL_PULSE_SECONDS);
  }

  /** Whether no tick has run for longer than `STALE_EFFECT_MS`: the tab is hidden, or was until this tick. */
  stalled(now: number): boolean {
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

  /** A mesh of the pool that is not animating, for a look that waits for one rather than taking another's. */
  private takeIdle<T extends THREE.Object3D>(pool: EffectPool<T>): T | undefined {
    return pool.takeFree((item) => this.running.has(item));
  }

  /**
   * A blow lands on the target or misses it. A warded dreamer's shell, or a braced one's brace, takes
   * a landed blow instead of the body, unless the blow spent the ward: it cracks the shell a last
   * time, shatters it, and lands on the body.
   */
  private land(attackerId: string, targetId: string, hit: boolean, landing: Landing): void {
    const target = this.host.body(targetId);
    if (target === undefined) return;
    if (!hit) {
      this.showMiss(targetId);
      return;
    }
    const attacker = this.host.body(attackerId);
    const heading = attacker === undefined ? target.facing : headingBetween(attacker, target);
    const namesPlayer = attackerId === this.host.playerId() || targetId === this.host.playerId();
    const ward = this.wards.get(targetId);
    const spent = this.spentOf(ward);
    if (ward !== undefined && spent !== undefined) {
      spent.cracks += 1;
      spent.crackAt = this.clock;
      if (spent.takesFirst > 0) {
        spent.takesFirst -= 1;
        this.landShielded(attackerId, target, heading, namesPlayer);
        return;
      }
      this.shatterSpent(ward, spent);
    } else if (ward !== undefined && ward.shatterAt === undefined && ward.heldFrom <= this.clock && this.clock < ward.until) {
      ward.cracks += 1;
      ward.crackAt = this.clock;
      this.landShielded(attackerId, target, heading, namesPlayer);
      return;
    }
    const brace = this.braces.get(targetId);
    if (brace !== undefined && brace.startsAt <= this.clock && this.clock < brace.until) {
      brace.pulseAt = this.clock;
      this.landShielded(attackerId, target, heading, namesPlayer);
      return;
    }
    this.showSparks(target.node.position, heading, landing.sparkScale);
    this.hitBody(targetId, heading, landing, [attackerId, targetId], namesPlayer);
  }

  /** A blow a brace or a ward takes in the body's place: it sparks off them, and only the striker pauses. */
  private landShielded(attackerId: string, target: EffectBody, heading: Heading, namesPlayer: boolean): void {
    this.showSparks(target.node.position, heading, SHIELDED_LANDING.sparkScale);
    this.freeze([attackerId], SHIELDED_LANDING.pauseMs);
    if (namesPlayer) this.addShake(SHIELDED_LANDING.shakeMetres);
  }

  /** What lands on the body: it flinches, flashes, and staggers by `landing`, the bodies `frozen` hold, and the camera shakes when it names the player. */
  private hitBody(targetId: string, heading: Heading, landing: Landing, frozen: readonly string[], namesPlayer: boolean): void {
    this.host.playOneShot(targetId, 'flinch');
    this.jolt(targetId).flash = { start: this.clock, seconds: landing.flashSeconds };
    this.knock(targetId, heading, landing.knockMetres);
    this.freeze(frozen, landing.pauseMs);
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
      const startsAt = this.clock + strikeIn + waveArrival(distance(caster.node.position, body), CHALLENGE_WAVE_RADIUS, CHALLENGE_WAVE_SECONDS);
      this.extendLook(this.challenged, body.id, { startsAt, until }, startMark);
    }
    this.after(strikeIn, () => {
      const at = this.host.body(casterId)?.node.position ?? caster.node.position;
      this.showWave(at, {
        radius: CHALLENGE_WAVE_RADIUS,
        seconds: CHALLENGE_WAVE_SECONDS,
        fadeFrom: CHALLENGE_WAVE_SECONDS * 0.6,
        tail: 0.25,
        alpha: 1,
        width: 0.05,
      });
      this.showRing(at, { max: 1, seconds: 0.3, width: LINE_WIDTH, follow: casterId, shape: (k) => ({ radius: 0.35 + 0.4 * easeOut(k), alpha: 1 - k }) });
    });
  }

  /** The outline holds from the block until the effect ends: for the rank-1 seconds, or as long as the server says for the player's own or their target's. */
  private brace(casterId: string, strikeIn: number): void {
    const timed = { startsAt: this.clock + strikeIn, until: this.clock + BRACED_SECONDS };
    this.extendLook(this.braces, casterId, timed, startBrace);
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
      this.showWave(at, { radius: RALLY_WAVE_RADIUS, seconds: RALLY_WAVE_SECONDS, fadeFrom: RALLY_WAVE_SECONDS * 0.5, tail: 0.3, alpha: 0.85, width: 0.05 });
      for (const body of rallied) {
        this.after(body.id === casterId ? 0.05 : waveArrival(distance(at, body), RALLY_WAVE_RADIUS, RALLY_WAVE_SECONDS), () => {
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

  /**
   * Deep mend's channel: the Healer's long cast, started as far in as puts its push at the
   * channel's end, a beam from their hand to whom it lands on, light gathering round that dreamer,
   * and a ring drawing in under the Healer. One the player learns of under way shows for the seconds
   * it has left.
   */
  private channel(casterId: string, abilityId: AbilityId, recipientId: string, seconds: number): void {
    const caster = this.host.body(casterId);
    if (caster === undefined) return;
    this.host.playOneShot(casterId, abilityId, seconds);
    const look: ChannelLook = { until: this.clock + seconds + CHANNEL_GRACE_SECONDS, endedAt: undefined };
    this.channels.set(casterId, look);
    const fade = (): number => (look.endedAt === undefined ? 1 : 1 - (this.clock - look.endedAt) / CHANNEL_FADE_SECONDS);
    const holds = (): boolean => this.channels.get(casterId) === look && this.clock < look.until && fade() > 0;
    const stream = this.takeIdle(this.streams);
    if (stream !== undefined) {
      this.showMotes(stream, recipientId, { spread: 0.5, rise: 1.3, life: 0.9, size: 0.07, stream: true, color: MOONLIGHT }, () => (holds() ? fade() : 0));
    }
    const beam = recipientId === casterId ? undefined : this.takeIdle(this.beams);
    if (beam !== undefined) this.showBeam(beam, casterId, recipientId, MOONLIGHT, () => (holds() ? fade() : 0));
    this.showRing(caster.node.position, {
      max: 1.1,
      seconds,
      width: 0.045,
      color: MOONLIGHT,
      follow: casterId,
      holds,
      shape: (k) => ({ radius: 1 - 0.6 * easeOut(k), alpha: 0.75 * fade() * Math.min(1, k * 6) }),
    });
  }

  /**
   * A channel lands or breaks: its beam and stream fade out. One that lands bursts on whom it lands
   * on, lifting them; one that breaks puffs out at its user, whose cast gives way to their pose.
   */
  private endChannel(casterId: string, recipientId: string, landed: boolean, shows: boolean): void {
    const look = this.channels.get(casterId);
    if (look !== undefined && look.endedAt === undefined) look.endedAt = this.clock;
    if (!landed) this.host.endOneShot(casterId);
    if (!shows) return;
    if (!landed) {
      const caster = this.host.body(casterId);
      if (caster !== undefined) {
        this.showRing(caster.node.position, {
          max: 0.8,
          seconds: 0.3,
          width: LINE_WIDTH,
          follow: casterId,
          shape: (k) => ({ radius: 0.3 + 0.35 * easeOut(k), alpha: 0.6 * (1 - k) }),
        });
      }
      return;
    }
    const recipient = this.host.body(recipientId);
    if (recipient === undefined) return;
    this.healLight(recipientId, recipient.node.position, 1.6);
    this.showRing(recipient.node.position, {
      max: 2,
      seconds: 0.55,
      width: 0.07,
      color: MOONLIGHT,
      follow: recipientId,
      shape: (k) => ({ radius: 0.4 + 1.3 * easeOut(k), alpha: 1 - k }),
    });
    if (!this.reducedMotion) this.jolt(recipientId).lift = { start: this.clock, metres: RADIANCE_LIFT_METRES };
  }

  /** Renewal: as the casting hand reaches out, light blooms on whom it lands on, which pulses there for as long as it holds. */
  private renewal(casterId: string, recipientId: string, strikeIn: number): void {
    const timed = { startsAt: this.clock + strikeIn, until: this.clock + RENEWING_SECONDS };
    this.extendLook(this.renewals, recipientId, timed, startPulsing);
    this.after(strikeIn, () => {
      const recipient = this.host.body(recipientId);
      if (recipient === undefined) return;
      for (const delay of [0, 0.12]) {
        this.after(delay, () =>
          this.showRing(recipient.node.position, {
            max: 0.9,
            seconds: 0.6,
            width: 0.04,
            color: MOONLIGHT,
            follow: recipientId,
            shape: (k) => ({ radius: 0.5 - 0.15 * easeOut(k), rise: 1.1 * easeOut(k), alpha: 1 - k }),
          }),
        );
      }
      this.showMotes(this.motes.take(), recipientId, { spread: 0.45, rise: 1.2, life: 0.8, size: 0.07, stream: false, color: MOONLIGHT });
      if (casterId !== recipientId)
        this.showRing(this.host.body(casterId)?.node.position ?? recipient.node.position, {
          max: 0.7,
          seconds: 0.3,
          width: LINE_WIDTH,
          color: MOONLIGHT,
          follow: casterId,
          shape: (k) => ({ radius: 0.3 + 0.3 * k, rise: 1, alpha: 0.8 * (1 - k) }),
        });
    });
  }

  /** Radiance: light rises from the Healer and a wave goes out as far as it reaches, lifting each standing dreamer it reaches as it passes. */
  private radiance(casterId: string, strikeIn: number): void {
    const caster = this.host.body(casterId);
    if (caster === undefined) return;
    const reached = areaRecipients(ABILITIES.radiance, caster.node.position, this.abilityBodies());
    this.after(strikeIn, () => {
      const at = this.host.body(casterId)?.node.position ?? caster.node.position;
      for (const [delay, alpha] of [
        [0, 1],
        [0.1, 0.5],
      ] as const) {
        this.after(delay, () =>
          this.showWave(at, {
            radius: RADIANCE_WAVE_RADIUS,
            seconds: RADIANCE_WAVE_SECONDS,
            fadeFrom: RADIANCE_WAVE_SECONDS * 0.6,
            tail: 0.25,
            alpha,
            width: 0.07,
            color: MOONLIGHT,
          }),
        );
      }
      this.showRing(at, {
        max: 1,
        seconds: 0.6,
        width: 0.05,
        color: MOONLIGHT,
        follow: casterId,
        shape: (k) => ({ radius: 0.4 + 0.45 * easeOut(k), rise: 1.4 * easeOut(k), alpha: 1 - k }),
      });
      this.showMotes(this.motes.take(), casterId, { spread: 0.75, rise: 1.8, life: 0.9, size: 0.08, stream: false, color: MOONLIGHT });
      for (const body of reached) {
        if (body.id === casterId) continue;
        this.after(waveArrival(distance(at, body), RADIANCE_WAVE_RADIUS, RADIANCE_WAVE_SECONDS), () => {
          const lit = this.host.body(body.id);
          if (lit !== undefined) this.healLight(body.id, lit.node.position, 1);
          if (lit !== undefined && !this.reducedMotion) this.jolt(body.id).lift = { start: this.clock, metres: RADIANCE_LIFT_METRES };
        });
      }
    });
  }

  /** Calm: two cool ripples draw in to the Healer as the circling hands sink, and a thin cool outline breathes on them while it holds. */
  private calm(casterId: string, strikeIn: number): void {
    this.extendLook(this.calms, casterId, { startsAt: this.clock + strikeIn, until: this.clock + CALMED_SECONDS }, startCalm);
    this.after(strikeIn, () => {
      const at = this.host.body(casterId)?.node.position;
      if (at === undefined) return;
      for (const delay of [0, 0.16]) {
        this.after(delay, () =>
          this.showRing(at, {
            max: 2,
            seconds: 0.6,
            width: 0.05,
            color: CALM_COLOR,
            follow: casterId,
            shape: (k) => ({ radius: 1.8 - 1.45 * easeOut(k), alpha: Math.min(1, k * 4) * (1 - k * k) }),
          }),
        );
      }
    });
  }

  /**
   * The Moonstone's light on a healed body, `strength` times a mend's: a ring swelling from its feet,
   * another rising up through it, and motes of light rising round it.
   */
  private healLight(entityId: string, at: THREE.Vector3, strength: number): void {
    this.showRing(at, {
      max: 1.3 * strength,
      seconds: 0.5,
      width: 0.06,
      color: MOONLIGHT,
      follow: entityId,
      shape: (k) => ({ radius: 0.42 + 0.6 * strength * easeOut(k), alpha: 1 - k }),
    });
    this.showRing(at, {
      max: 0.6,
      seconds: 0.45,
      width: 0.045,
      color: MOONLIGHT,
      follow: entityId,
      shape: (k) => ({ radius: 0.38 - 0.1 * k, rise: CHEST_HEIGHT * 1.4 * easeOut(k), alpha: 0.8 * (1 - k) }),
    });
    this.showMotes(this.motes.take(), entityId, {
      spread: 0.4 + 0.15 * strength,
      rise: 1.1 * strength,
      life: 0.7,
      size: 0.06 + 0.015 * strength,
      stream: false,
      color: MOONLIGHT,
    });
  }

  /** The word over a body a blow missed, a gap above its standing head, for a moment, as large as the plaques are drawn. */
  private showMiss(entityId: string): void {
    const word = this.misses.take();
    this.animate(word, (elapsed) => {
      const body = this.host.body(entityId);
      if (body === undefined) return false;
      const feet = body.node.position;
      word.position.set(feet.x, feet.y + body.headHeight + MISS_HEAD_GAP, feet.z);
      word.scale.setScalar(this.host.overlayScale());
      return elapsed < MISS_SECONDS;
    });
  }

  /** A soft ring and a few motes of light at a renewed body each second while it holds, until it ends or the body falls or goes. */
  private tickRenewals(): void {
    for (const [id, renewal] of this.renewals) {
      const body = this.host.body(id);
      if (body === undefined || body.condition === 'fallen' || this.clock >= renewal.until) {
        this.renewals.delete(id);
        continue;
      }
      if (this.clock < renewal.startsAt || (renewal.nextPulse !== undefined && this.clock < renewal.nextPulse)) continue;
      renewal.nextPulse = (renewal.nextPulse ?? this.clock) + RENEW_PULSE_SECONDS;
      this.showRing(body.node.position, {
        max: 0.9,
        seconds: 0.8,
        width: 0.04,
        color: MOONLIGHT,
        follow: id,
        shape: (k) => ({ radius: 0.32 + 0.4 * easeOut(k), alpha: 0.65 * (1 - k) }),
      });
      this.showMotes(this.motes.take(), id, { spread: 0.38, rise: 0.95, life: 0.9, size: 0.055, stream: false, color: MOONLIGHT, alpha: 0.7 });
    }
  }

  /** Forgets each channel's look once it has faded, or once its time is past with neither its landing nor its break arriving. */
  private tickChannels(): void {
    for (const [id, look] of this.channels) {
      const faded = look.endedAt !== undefined && this.clock - look.endedAt >= CHANNEL_FADE_SECONDS;
      if (faded || this.clock >= look.until) this.channels.delete(id);
    }
  }

  /** Draws each raise's ring as far round as the raise has gone by now, giving it a mesh when one is free. */
  private tickRaises(): void {
    for (const [id, raise] of this.raises) {
      if (raise.mesh !== undefined && this.running.has(raise.mesh)) continue;
      const mesh = this.takeIdle(this.raiseRingMeshes);
      raise.mesh = mesh;
      if (mesh === undefined) continue;
      const body = this.host.body(id);
      const uniforms = (mesh.material as THREE.ShaderMaterial).uniforms;
      const radius = (body?.radius ?? SOMNIO_CONSTANTS.playerRadius) * RAISE_RING_RADII + GROUND_RING_WIDTH / 2;
      uniforms['uMax']!.value = radius + GROUND_RING_WIDTH;
      uniforms['uWidth']!.value = GROUND_RING_WIDTH;
      uniforms['uRadius']!.value = radius;
      uniforms['uAlpha']!.value = 0.9;
      uniforms['uTrack']!.value = RAISE_TRACK;
      (uniforms['uColor']!.value as THREE.Color).set(RAISE_COLOR);
      mesh.scale.set(radius + GROUND_RING_WIDTH, radius + GROUND_RING_WIDTH, 1);
      this.animate(mesh, () => {
        const held = this.raises.get(id);
        const at = this.host.body(id)?.node.position;
        if (held?.mesh !== mesh || at === undefined) return false;
        uniforms['uArc']!.value = raiseShownAt(held, this.clock - held.anchoredAt);
        mesh.position.set(at.x, at.y + GROUND_RING_LIFT, at.z);
        return true;
      });
    }
  }

  /**
   * Motes of light round a body, rising and fading from `from` over its feet: a burst rises once, a
   * stream keeps rising for as long as `strength` answers above 0, at that share of its brightness. A
   * negative rise sinks them.
   */
  private showMotes(
    mesh: THREE.Mesh,
    entityId: string,
    motes: { spread: number; rise: number; life: number; size: number; stream: boolean; color: number; alpha?: number; from?: number },
    strength: () => number = () => 1,
  ): void {
    const uniforms = (mesh.material as THREE.ShaderMaterial).uniforms;
    uniforms['uSpread']!.value = motes.spread;
    uniforms['uRise']!.value = motes.rise;
    uniforms['uLife']!.value = motes.life;
    uniforms['uSize']!.value = motes.size;
    uniforms['uStream']!.value = motes.stream ? 1 : 0;
    (uniforms['uColor']!.value as THREE.Color).set(motes.color);
    const origin = this.host.body(entityId)?.node.position.clone();
    this.animate(mesh, (elapsed) => {
      const feet = this.host.body(entityId)?.node.position ?? origin;
      const shown = strength();
      if (feet === undefined || shown <= 0) return false;
      mesh.position.set(feet.x, feet.y + (motes.from ?? 0.1), feet.z);
      uniforms['uT']!.value = elapsed;
      uniforms['uAlpha']!.value = (motes.alpha ?? 1) * shown;
      return motes.stream || elapsed < motes.life * MOTE_LONGEST_LIFE;
    });
  }

  /** A beam from one body's hand to another's chest, its light flowing toward the second, for as long as `strength` answers above 0. */
  private showBeam(mesh: THREE.Mesh, fromId: string, toId: string, color: number, strength: () => number): void {
    const uniforms = (mesh.material as THREE.ShaderMaterial).uniforms;
    (uniforms['uColor']!.value as THREE.Color).set(color);
    this.animate(mesh, (elapsed) => {
      const from = this.host.body(fromId);
      const to = this.host.body(toId);
      const shown = strength();
      if (from === undefined || to === undefined || shown <= 0) return false;
      (uniforms['uFrom']!.value as THREE.Vector3).set(from.node.position.x, from.node.position.y + from.headHeight * 0.6, from.node.position.z);
      (uniforms['uTo']!.value as THREE.Vector3).set(to.node.position.x, to.node.position.y + CHEST_HEIGHT * 0.8, to.node.position.z);
      uniforms['uT']!.value = elapsed;
      uniforms['uAlpha']!.value = shown * Math.min(1, elapsed / 0.15);
      return true;
    });
  }

  /** The bodies round the caster as an area ability's rules see them, where they are drawn. */
  private abilityBodies(): (AbilityBody & { id: string })[] {
    return [...this.host.bodies()].map(([id, body]) => ({ id, ...abilityBody(body, body.node.position) }));
  }

  private jolt(entityId: string): Jolt {
    let jolt = this.jolts.get(entityId);
    if (jolt === undefined) {
      jolt = { frozenUntil: Number.NEGATIVE_INFINITY, flash: undefined, knock: undefined, lift: undefined };
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
      if (jolt.flash !== undefined) {
        const k = (this.clock - jolt.flash.start) / jolt.flash.seconds;
        this.setFlash(id, body, k >= 1 ? 0 : (1 - k) ** 1.4);
        if (k >= 1) jolt.flash = undefined;
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
      if (!frozen && jolt.flash === undefined && jolt.knock === undefined && jolt.lift === undefined) {
        resetJolt(body.jolt);
        this.jolts.delete(id);
      }
    }
  }

  /**
   * A body's one outline, a brace's, a calm's, or a curse's, in that order. A brace's pops on in
   * white, flickers a little, swells when the brace takes a blow, and fades as the brace ends. A
   * calm's is a thin cool line that breathes slowly, and a weakened nightmare's a thinner, dimmer
   * violet one, each steady under reduced motion and fading as its effect ends.
   */
  private tickOutlines(): void {
    for (const id of new Set([...this.braces.keys(), ...this.calms.keys(), ...this.weakens.keys()])) {
      const body = this.host.body(id);
      const hulls = body === undefined ? undefined : this.hullsFor(id, body);
      const brace = this.braces.get(id);
      const calm = this.calms.get(id);
      const weaken = this.weakens.get(id);
      if (brace !== undefined && this.clock >= brace.until) this.braces.delete(id);
      if (calm !== undefined && this.clock >= calm.until) this.calms.delete(id);
      const shows = (look: Timed | undefined): look is Timed => look !== undefined && this.clock >= look.startsAt && this.clock < look.until;
      const shown = shows(brace) ? brace : shows(calm) ? calm : shows(weaken) ? weaken : undefined;
      for (const mesh of hulls?.outline ?? []) mesh.visible = shown !== undefined;
      if (shown === undefined || hulls === undefined) continue;
      const intro = Math.min(1, (this.clock - shown.startsAt) / 0.2);
      const outro = Math.min(1, (shown.until - this.clock) / 0.3);
      if (shown === calm) {
        hulls.outlineMaterial.color.set(CALM_COLOR);
        hulls.thickness.value = CALM_THICKNESS * hulls.unitsPerMetre * intro;
        hulls.outlineMaterial.opacity = (this.reducedMotion ? 0.55 : 0.45 + 0.2 * Math.sin(this.clock * 2.2)) * outro;
        continue;
      }
      if (shown === weaken) {
        hulls.outlineMaterial.color.set(DREAM_COLOR);
        hulls.thickness.value = WEAKEN_THICKNESS * hulls.unitsPerMetre * intro;
        hulls.outlineMaterial.opacity = (this.reducedMotion ? 0.4 : 0.32 + 0.12 * Math.sin(this.clock * 1.6)) * outro;
        continue;
      }
      const pop = intro < 1 && !this.reducedMotion ? 1 + 0.5 * Math.sin(intro * Math.PI) : 1;
      const pulse = Math.max(0, 1 - (this.clock - brace!.pulseAt) / 0.25);
      const flicker = this.reducedMotion ? 0.85 : 0.75 + 0.2 * Math.sin(this.clock * 6);
      hulls.outlineMaterial.color.set(WHITE);
      hulls.thickness.value = BRACE_THICKNESS * hulls.unitsPerMetre * intro * pop * (1 + 0.8 * pulse);
      hulls.outlineMaterial.opacity = flicker * outro + 0.25 * pulse;
    }
  }

  /**
   * Ward: the casting hand reaches out, a violet flick leaps to whom it lands on unless that is the
   * Mystic, and a faceted shell forms round them facet by facet, which holds while the ward does.
   * A ward put on again is whole again. One put on a used-up ward forms once the other has flown apart.
   */
  private ward(casterId: string, recipientId: string, strikeIn: number): void {
    const until = this.clock + WARDED_SECONDS;
    const ward = this.wards.get(recipientId);
    if (ward === undefined || ward.spent || ward.shatterAt !== undefined) {
      this.renewWard(recipientId, ward, { startsAt: this.clock + strikeIn, until });
    } else {
      Object.assign(ward, { until: Math.max(ward.until, until), cracks: 0 });
    }
    this.castFlick(casterId, recipientId, strikeIn);
    this.after(strikeIn, () => {
      const recipient = this.host.body(recipientId);
      if (recipient === undefined) return;
      this.showRing(recipient.node.position, {
        max: 1.4,
        seconds: 0.4,
        width: 0.05,
        color: DREAM_COLOR,
        follow: recipientId,
        shape: (k) => ({ radius: 1.2 - 0.7 * easeOut(k), alpha: Math.min(1, k * 5) * (1 - k) }),
      });
    });
  }

  /**
   * Weaken: a violet flick to the nightmare, then a hex sinks over it from above its head to its
   * feet, closing in, and its sap drips out of it. A thin violet outline and a slow drip hold on it
   * while the curse does.
   */
  private weaken(casterId: string, targetId: string | undefined, strikeIn: number): void {
    if (targetId === undefined) return;
    const timed = { startsAt: this.clock + strikeIn, until: this.clock + WEAKENED_SECONDS };
    this.extendLook(this.weakens, targetId, timed, startPulsing);
    this.castFlick(casterId, targetId, strikeIn);
    this.after(strikeIn, () => {
      const target = this.host.body(targetId);
      if (target === undefined) return;
      const over = target.headHeight + 0.3;
      for (const delay of [0, 0.12]) {
        this.after(delay, () =>
          this.showRing(target.node.position, {
            max: 1.1,
            seconds: 0.55,
            width: 0.055,
            color: DREAM_COLOR,
            follow: targetId,
            shape: (k) => ({ radius: 0.9 - 0.5 * easeOut(k), rise: over * (1 - easeOut(k)), alpha: Math.min(1, k * 5) * (1 - k * k) }),
          }),
        );
      }
      this.showMotes(this.motes.take(), targetId, {
        spread: 0.45,
        rise: -target.headHeight,
        life: 0.7,
        size: 0.065,
        stream: false,
        color: DREAM_COLOR,
        from: target.headHeight,
      });
    });
  }

  /**
   * Bind: a violet flick to the nightmare as the circling hands sink, a ring slams down round its
   * feet, and runes lie there while tethers snap up from them to hold it, for as long as it is bound.
   */
  private bind(casterId: string, targetId: string | undefined, strikeIn: number): void {
    if (targetId === undefined) return;
    const timed = { startsAt: this.clock + strikeIn, until: this.clock + BOUND_SECONDS };
    this.extendLook(this.binds, targetId, timed, startBinding);
    this.castFlick(casterId, targetId, strikeIn);
    this.after(strikeIn, () => {
      const target = this.host.body(targetId);
      if (target === undefined) return;
      this.showRing(target.node.position, {
        max: 1.9,
        seconds: 0.3,
        width: 0.08,
        color: DREAM_COLOR,
        follow: targetId,
        shape: (k) => ({ radius: 1.7 - (1.7 - BIND_RUNE_RADIUS) * easeOut(k), alpha: 1 - 0.7 * k }),
      });
    });
  }

  /**
   * Dream-bolt: as the casting hand pushes out, a shard of dream flies from it to the nightmare,
   * crackling, and bursts on it as the server lands its harm: `boltFlightSeconds` after the use, by
   * the distance between the bodies as the ability arrives. One the nightmare `evaded` flies all the
   * same and shows the miss word where it would have burst.
   */
  private dreamBolt(casterId: string, targetId: string | undefined, strikeIn: number, evaded: boolean): void {
    if (targetId === undefined) return;
    const caster = this.host.body(casterId);
    const target = this.host.body(targetId);
    if (caster === undefined || target === undefined) return;
    const flightSeconds = Math.max(1e-3, boltFlightSeconds(distance(caster.node.position, target.node.position)) - strikeIn);
    const bolt = this.bolts.take();
    this.after(strikeIn, () => this.launchBolt(bolt, casterId, targetId, flightSeconds, evaded));
  }

  /**
   * The bolt flies from its caster's hand to the nightmare's chest in `flightSeconds`, near
   * straight, following the nightmare as it moves. Its trail runs on into the body as it bursts.
   */
  private launchBolt(bolt: THREE.Mesh, casterId: string, targetId: string, flightSeconds: number, evaded: boolean): void {
    const caster = this.host.body(casterId);
    const target = this.host.body(targetId);
    if (caster === undefined || target === undefined) return;
    const heading = headingBetween(caster, target);
    const radians = headingRadians(heading);
    const feet = caster.node.position;
    const from = new THREE.Vector3(
      feet.x + Math.sin(radians) * BOLT_REACH_OUT,
      feet.y + caster.headHeight * BOLT_HAND,
      feet.z + Math.cos(radians) * BOLT_REACH_OUT,
    );
    const aim = new THREE.Vector3();
    const point = (k: number, out: THREE.Vector3) => out.lerpVectors(from, aim, k).setY(out.y + Math.sin(Math.PI * k) * BOLT_ARC_METRES);
    const uniforms = (bolt.material as THREE.ShaderMaterial).uniforms;
    (uniforms['uColor']!.value as THREE.Color).set(BOLT_COLOR);
    let landed = false;
    this.animate(bolt, (elapsed) => {
      const at = this.host.body(targetId)?.node.position;
      if (at !== undefined) aim.set(at.x, at.y + CHEST_HEIGHT * 0.8, at.z);
      const length = Math.max(from.distanceTo(aim), 1e-3);
      const flown = elapsed / flightSeconds;
      const head = Math.min(1, flown);
      const tail = Math.min(1, Math.max(0, flown - BOLT_TRAIL_METRES / length));
      point(head, uniforms['uHead']!.value as THREE.Vector3);
      point(tail, uniforms['uTail']!.value as THREE.Vector3);
      (uniforms['uAxis']!.value as THREE.Vector3).subVectors(aim, from);
      uniforms['uT']!.value = this.reducedMotion ? 0 : elapsed;
      uniforms['uAlpha']!.value = 1 - tail ** 4;
      if (head >= 1 && !landed) {
        landed = true;
        if (evaded) this.showMiss(targetId);
        else this.boltBurst(casterId, targetId, heading);
      }
      return tail < 1;
    });
  }

  /**
   * The bolt bursts on the nightmare harder than a blade lands: it flashes white for longer,
   * staggers further, and holds longer, a crack splits across its chest, a ring snaps in on it, and
   * shards fly off it and fall.
   */
  private boltBurst(casterId: string, targetId: string, heading: Heading): void {
    const target = this.host.body(targetId);
    if (target === undefined) return;
    const at = target.node.position;
    for (const turn of [-90, 0, 90]) {
      this.showSparks(at, heading + turn, BOLT_LANDING.sparkScale, { color: BOLT_COLOR, fall: SHARD_FALL_METRES, height: CHEST_HEIGHT * 0.8 });
    }
    this.showCrack(targetId);
    this.showRing(at, {
      max: 1,
      seconds: 0.16,
      width: 0.035,
      color: BOLT_COLOR,
      follow: targetId,
      shape: (k) => ({ radius: 0.9 - 0.7 * easeOut(k), rise: CHEST_HEIGHT * 0.8, alpha: 1 - k * k }),
    });
    this.hitBody(targetId, heading, BOLT_LANDING, [targetId], casterId === this.host.playerId() || targetId === this.host.playerId());
  }

  /** A jagged crack across the body's chest, facing the camera, that shoots out and is gone in a moment, turned anew each time. */
  private showCrack(entityId: string): void {
    const mesh = this.cracks.take();
    const uniforms = (mesh.material as THREE.ShaderMaterial).uniforms;
    uniforms['uSpin']!.value = Math.random() * Math.PI * 2;
    const origin = this.host.body(entityId)?.node.position.clone();
    this.animate(mesh, (elapsed) => {
      const feet = this.host.body(entityId)?.node.position ?? origin;
      if (feet === undefined) return false;
      mesh.position.set(feet.x, feet.y + CHEST_HEIGHT * 0.8, feet.z);
      uniforms['uGrow']!.value = Math.min(1, elapsed / CRACK_GROW_SECONDS);
      uniforms['uAlpha']!.value = 1 - Math.max(0, (elapsed - CRACK_GROW_SECONDS) / (CRACK_SECONDS - CRACK_GROW_SECONDS)) ** 2;
      return elapsed < CRACK_SECONDS;
    });
  }

  /**
   * Veil: as the arms come up a dome of mist rises over the Mystic as far as it reaches, and each
   * standing dreamer under it fades into the mist as the dome passes them, for its rank-1 seconds,
   * or as long as the server says. Under reduced motion the dome fades in rather than rising.
   */
  private veil(casterId: string, strikeIn: number): void {
    const caster = this.host.body(casterId);
    if (caster === undefined) return;
    for (const body of areaRecipients(ABILITIES.veil, caster.node.position, this.abilityBodies())) {
      const startsAt = this.clock + strikeIn + waveArrival(distance(caster.node.position, body), VEIL_DOME_RADIUS, VEIL_RISE_SECONDS);
      this.extendLook(this.veils, body.id, { startsAt, until: this.clock + VEILED_SECONDS }, startPulsing);
    }
    this.after(strikeIn, () => {
      const at = (this.host.body(casterId)?.node.position ?? caster.node.position).clone();
      const dome = this.domes.take();
      const uniforms = (dome.material as THREE.ShaderMaterial).uniforms;
      dome.position.copy(at);
      this.animate(dome, (elapsed) => {
        const rise = Math.min(1, elapsed / VEIL_RISE_SECONDS);
        const height = this.reducedMotion ? 1 : easeOut(rise);
        dome.scale.set(VEIL_DOME_RADIUS, VEIL_DOME_RADIUS * 0.55 * Math.max(height, 0.02), VEIL_DOME_RADIUS);
        uniforms['uT']!.value = this.reducedMotion ? 0 : elapsed;
        uniforms['uAlpha']!.value = (this.reducedMotion ? rise : 1) * Math.min(1, (VEIL_DOME_SECONDS - elapsed) / 0.6);
        return elapsed < VEIL_DOME_SECONDS;
      });
      this.showWave(at, {
        radius: VEIL_DOME_RADIUS,
        seconds: VEIL_RISE_SECONDS,
        fadeFrom: VEIL_RISE_SECONDS,
        tail: 0.4,
        alpha: 0.9,
        width: 0.06,
        color: MIST_COLOR,
      });
    });
  }

  /** A short violet flick from the Mystic's hand to whom their spell lands on, as the hand reaches out; none on the Mystic themselves. */
  private castFlick(casterId: string, recipientId: string, strikeIn: number): void {
    if (casterId === recipientId) return;
    this.after(Math.max(0, strikeIn - 0.05), () => {
      const beam = this.takeIdle(this.beams);
      if (beam === undefined) return;
      const start = this.clock;
      this.showBeam(beam, casterId, recipientId, DREAM_COLOR, () => 1 - ((this.clock - start) / 0.3) ** 2);
    });
  }

  /**
   * Gives each ward its shell from its moment on, and forgets each once its time is past or its body
   * is gone or fallen. The ward one replaces stands, spent, until its blow lands, then flies apart
   * until the new shell forms.
   */
  private tickWards(): void {
    for (const [id, ward] of this.wards) {
      const body = this.host.body(id);
      if (body === undefined || body.condition === 'fallen' || this.clock >= ward.until) {
        this.stopShells(ward);
        this.wards.delete(id);
        continue;
      }
      const replaced = ward.replaces;
      if (replaced !== undefined && this.clock >= Math.min(ward.startsAt, replaced.until)) {
        if (replaced.shell !== undefined) this.stop(replaced.shell);
        ward.replaces = undefined;
      }
      if (this.clock >= ward.startsAt) this.showShell(id, ward);
    }
  }

  /** Stops the ward's shell, and the shell of the ward it replaces. */
  private stopShells(ward: Ward): void {
    for (const shell of [ward.shell, ward.replaces?.shell]) if (shell !== undefined) this.stop(shell);
  }

  /**
   * Gives the ward a shell if it lost or never had one and one is free. The shell forms facet by
   * facet, flashes and loses facets with each blow it takes, shimmers while it holds, and flies apart
   * once spent, or fades as it runs out. Under reduced motion it neither shimmers nor flies apart,
   * only fades.
   */
  private showShell(id: string, ward: Ward): void {
    if (ward.shell !== undefined && this.running.has(ward.shell)) return;
    const shell = this.takeIdle(this.shells);
    for (const other of this.wards.values()) if (other.shell === shell) other.shell = undefined;
    ward.shell = shell;
    if (shell === undefined) return;
    const uniforms = (shell.material as THREE.ShaderMaterial).uniforms;
    (uniforms['uColor']!.value as THREE.Color).set(DREAM_COLOR);
    uniforms['uFly']!.value = this.reducedMotion ? 0 : 1;
    this.animate(shell, () => {
      const body = this.host.body(id);
      const current = this.wards.get(id);
      if (body === undefined || ward.shell !== shell || (current !== ward && current?.replaces !== ward)) return false;
      const feet = body.node.position;
      const form = Math.min(1, (this.clock - ward.startsAt) / SHELL_FORM_SECONDS);
      const breathe = this.reducedMotion ? 1 : 1 + 0.025 * Math.sin(this.clock * 3);
      const swell = (0.85 + 0.15 * easeOut(form)) * breathe;
      shell.position.set(feet.x, feet.y + body.headHeight * SHELL_MIDDLE, feet.z);
      shell.scale.set(SHELL_HALF_WIDTH * swell, body.headHeight * SHELL_HALF_HEIGHT * swell, SHELL_HALF_WIDTH * swell);
      uniforms['uForm']!.value = form;
      uniforms['uCrack']!.value = ward.cracks * SHELL_CRACK_SHARE;
      uniforms['uFlash']!.value = Math.max(0, 1 - (this.clock - ward.crackAt) / 0.25);
      uniforms['uBurst']!.value = ward.shatterAt === undefined ? 0 : Math.min(1, (this.clock - ward.shatterAt) / SHELL_SHATTER_SECONDS);
      uniforms['uAlpha']!.value = ward.shatterAt === undefined ? Math.min(1, (ward.until - this.clock) / 0.3) : 1;
      return true;
    });
  }

  /** A weakened nightmare's sap drips out of it on each beat while the curse holds, until it ends or the nightmare is driven off. */
  private tickWeakens(): void {
    for (const [id, weaken] of this.weakens) {
      const body = this.host.body(id);
      if (body === undefined || this.clock >= weaken.until) {
        this.weakens.delete(id);
        continue;
      }
      // Its outline goes the next tick, as the time it now holds until is past.
      if (body.condition === 'fallen') weaken.until = this.clock;
      if (this.clock < weaken.startsAt || this.clock >= weaken.until || (weaken.nextPulse !== undefined && this.clock < weaken.nextPulse)) continue;
      weaken.nextPulse = (weaken.nextPulse ?? this.clock) + WEAKEN_PULSE_SECONDS;
      this.showRing(body.node.position, {
        max: 0.8,
        seconds: 0.8,
        width: 0.035,
        color: DREAM_COLOR,
        follow: id,
        shape: (k) => ({ radius: 0.5 - 0.15 * k, rise: CHEST_HEIGHT * (1 - easeOut(k)), alpha: 0.6 * Math.min(1, k * 4) * (1 - k) }),
      });
      this.showMotes(this.motes.take(), id, {
        spread: 0.35,
        rise: -CHEST_HEIGHT,
        life: 0.9,
        size: 0.05,
        stream: false,
        color: DREAM_COLOR,
        alpha: 0.6,
        from: CHEST_HEIGHT,
      });
    }
  }

  /** Lays each binding's runes and tethers from its moment on, and forgets each once its time is past or its body is gone or driven off. */
  private tickBinds(): void {
    for (const [id, binding] of this.binds) {
      const body = this.host.body(id);
      if (body === undefined || body.condition === 'fallen' || this.clock >= binding.until) {
        for (const mesh of [binding.runes, binding.tethers]) if (mesh !== undefined) this.stop(mesh);
        this.binds.delete(id);
        continue;
      }
      if (this.clock >= binding.startsAt) this.showBinding(id, binding);
    }
  }

  /**
   * Gives the binding its runes and its tethers when each is free. The runes turn slowly round the
   * body's feet, still under reduced motion, and the tethers snap up from them to grip it, flicker
   * while they hold, and fade as the binding ends.
   */
  private showBinding(id: string, binding: Binding): void {
    const outro = (): number => Math.min(1, (binding.until - this.clock) / 0.25);
    if (binding.runes === undefined || !this.running.has(binding.runes)) {
      const runes = this.takeIdle(this.runes);
      binding.runes = runes;
      if (runes !== undefined) {
        const uniforms = (runes.material as THREE.ShaderMaterial).uniforms;
        uniforms['uMax']!.value = BIND_RUNE_RADIUS + 0.1;
        uniforms['uWidth']!.value = 0.07;
        uniforms['uRadius']!.value = BIND_RUNE_RADIUS;
        uniforms['uDash']!.value = 16;
        (uniforms['uColor']!.value as THREE.Color).set(DREAM_COLOR);
        runes.scale.set(BIND_RUNE_RADIUS + 0.1, BIND_RUNE_RADIUS + 0.1, 1);
        this.animate(runes, () => {
          const feet = this.host.body(id)?.node.position;
          if (feet === undefined || binding.runes !== runes || this.binds.get(id) !== binding) return false;
          runes.position.set(feet.x, feet.y + GROUND_RING_LIFT, feet.z);
          uniforms['uSpin']!.value = this.reducedMotion ? 0 : this.clock * 0.25;
          uniforms['uAlpha']!.value = 0.9 * Math.min(1, (this.clock - binding.startsAt) / 0.15) * outro();
          return true;
        });
      }
    }
    if (binding.tethers === undefined || !this.running.has(binding.tethers)) {
      const tethers = this.takeIdle(this.tethers);
      binding.tethers = tethers;
      if (tethers === undefined) return;
      const uniforms = (tethers.material as THREE.ShaderMaterial).uniforms;
      (uniforms['uColor']!.value as THREE.Color).set(DREAM_COLOR);
      this.animate(tethers, () => {
        const body = this.host.body(id);
        if (body === undefined || binding.tethers !== tethers || this.binds.get(id) !== binding) return false;
        (uniforms['uCentre']!.value as THREE.Vector3).copy(body.node.position);
        uniforms['uRadius']!.value = BIND_RUNE_RADIUS;
        uniforms['uGrip']!.value = body.radius * 0.8;
        uniforms['uHeight']!.value = body.headHeight * BIND_GRIP;
        uniforms['uReach']!.value = easeOut(Math.min(1, (this.clock - binding.startsAt) / BIND_SNAP_SECONDS));
        uniforms['uT']!.value = this.reducedMotion ? 0 : this.clock;
        uniforms['uAlpha']!.value = outro();
        return true;
      });
    }
  }

  /**
   * Each veiled dreamer fades into the mist from when the dome passes them: the mist tints their body
   * over its whole surface and breathes slowly, and mist rises off them on each beat, until the veil
   * ends. A blow's flash takes the body's surface while it lasts. Under reduced motion the mist holds
   * steady.
   */
  private tickVeils(): void {
    for (const [id, veil] of this.veils) {
      const body = this.host.body(id);
      const ended = body === undefined || body.condition === 'fallen' || this.clock >= veil.until;
      const flashing = this.jolts.get(id)?.flash !== undefined;
      if (ended) {
        if (body !== undefined && !flashing) this.setFlash(id, body, 0);
        this.veils.delete(id);
        continue;
      }
      if (this.clock < veil.startsAt) continue;
      const hulls = flashing ? undefined : this.hullsFor(id, body);
      if (hulls !== undefined) {
        const intro = Math.min(1, (this.clock - veil.startsAt) / 0.3);
        const outro = Math.min(1, (veil.until - this.clock) / 0.4);
        const breathe = this.reducedMotion ? 1 : 0.85 + 0.15 * Math.sin(this.clock * 2.4);
        hulls.flashMaterial.color.set(MIST_COLOR);
        hulls.flashMaterial.opacity = VEIL_SHADE * intro * outro * breathe;
        for (const mesh of hulls.flash) mesh.visible = true;
      }
      if (veil.nextPulse !== undefined && this.clock < veil.nextPulse) continue;
      veil.nextPulse = (veil.nextPulse ?? this.clock) + VEIL_PULSE_SECONDS;
      this.showMotes(this.motes.take(), id, { spread: 0.5, rise: 1.4, life: 1.2, size: 0.07, stream: false, color: MIST_COLOR, alpha: 0.55 });
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
    const sprite = this.takeIdle(this.marks);
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

  /** A wave's ring going out from `at`, as `waveArrival` times what it reaches. */
  private showWave(at: THREE.Vector3, wave: Wave): void {
    const end = wave.seconds + wave.tail;
    this.showRing(at, {
      max: wave.radius + 0.5,
      seconds: end,
      width: wave.width,
      ...(wave.color === undefined ? {} : { color: wave.color }),
      shape: (_k, elapsed) => ({
        radius: wave.radius * easeOut(Math.min(1, elapsed / wave.seconds)),
        alpha: wave.alpha * (1 - Math.max(0, (elapsed - wave.fadeFrom) / (end - wave.fadeFrom))),
      }),
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
      /** Whether it still shows, for a ring that ends with what it belongs to. */
      holds?: () => boolean;
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
      mesh.position.set(feet.x, feet.y + GROUND_RING_LIFT + (shape.rise ?? 0), feet.z);
      uniforms['uRadius']!.value = shape.radius;
      uniforms['uAlpha']!.value = shape.alpha;
      return k < 1 && (ring.holds?.() ?? true);
    });
  }

  /**
   * Streaks flung from where a blow meets a body, the way it travels, `height` over its feet: white,
   * cooling to `color` as they die, and dropping by `fall`. Shorter under reduced motion.
   */
  private showSparks(
    at: THREE.Vector3,
    heading: Heading,
    scale: number,
    { color = WHITE, fall = 0, height = SPARK_HEIGHT }: { color?: number; fall?: number; height?: number } = {},
  ): void {
    const mesh = this.sparks.take();
    const uniforms = (mesh.material as THREE.ShaderMaterial).uniforms;
    const reach = this.reducedMotion ? 0.5 : 1;
    uniforms['uLen']!.value = 0.2 * scale * reach;
    uniforms['uTravel']!.value = 0.38 * scale * reach;
    uniforms['uFall']!.value = fall * reach;
    (uniforms['uColor']!.value as THREE.Color).set(color);
    mesh.position.set(at.x, at.y + height, at.z);
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
    hulls.flashMaterial.color.set(WHITE);
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
      if ((object as THREE.Mesh).isMesh && object.userData[HELD_PROP] !== true) sources.push(object as THREE.Mesh);
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
export function strikeDelay(clip: THREE.AnimationClip | undefined): number {
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

/**
 * A flat band on one quad, for every wave, pulse, and puff of dust. For a raise's ring it is drawn as
 * far round as `uArc` says from its north, clockwise seen from above, over the rest at `uTrack` of
 * its brightness. For a binding's runes it is broken into `uDash` strokes, turned round by `uSpin`
 * of a turn.
 */
const RING_MATERIAL = new THREE.ShaderMaterial({
  uniforms: {
    uRadius: { value: 0.5 },
    uWidth: { value: 0.05 },
    uMax: { value: 1 },
    uAlpha: { value: 1 },
    uArc: { value: 1 },
    uTrack: { value: 0 },
    uDash: { value: 0 },
    uSpin: { value: 0 },
    uColor: { value: new THREE.Color(WHITE) },
  },
  vertexShader: /* glsl */ `varying vec2 vPlane; void main() { vPlane = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform float uRadius, uWidth, uMax, uAlpha, uArc, uTrack, uDash, uSpin; uniform vec3 uColor; varying vec2 vPlane;
    void main() {
      float turn = fract(atan(vPlane.x, vPlane.y) / 6.2831853 + 1.0);
      float drawn = uArc < 1.0 && turn > uArc ? uTrack : 1.0;
      if (drawn <= 0.0) discard;
      if (uDash > 0.0 && fract((turn + uSpin) * uDash) > 0.6) discard;
      float along = length(vPlane) * uMax;
      float soft = max(0.012, uWidth * 0.35);
      float alpha = 1.0 - smoothstep(uWidth * 0.5 - soft, uWidth * 0.5, abs(along - uRadius));
      if (alpha <= 0.003) discard;
      gl_FragColor = vec4(uColor, alpha * uAlpha * drawn);
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

/** A raise's ring, its north turned away from the camera, so its arc starts where no body lying in it or standing by covers it. */
function raiseRingMesh(): THREE.Mesh {
  const mesh = ringMesh();
  mesh.rotation.z = Math.atan2(CAMERA_DIRECTION.x, CAMERA_DIRECTION.z);
  return mesh;
}

const MOTES = 14;
/** The slowest mote takes this many times its cloud's life to rise, so a burst runs that long. */
const MOTE_LONGEST_LIFE = 1.6;

/**
 * Motes of light round +Y: a quad each, at its own bearing, distance, pace, and start, rising and
 * drawing in a little as it goes, each a small cross of light with a bright core.
 */
const MOTE_GEOMETRY = (() => {
  const corners: number[] = [];
  const seeds: number[] = [];
  const indices: number[] = [];
  let seed = 11;
  const random = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let mote = 0; mote < MOTES; mote += 1) {
    const angle = ((mote + random() * 0.6) / MOTES) * Math.PI * 2;
    const reach = 0.45 + random() * 0.55;
    const pace = 0.7 + random() * 0.6;
    const start = random();
    for (const corner of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ]) {
      corners.push(...corner);
      seeds.push(angle, reach, pace, start);
    }
    const base = mote * 4;
    indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Array<number>(MOTES * 12).fill(0), 3));
  geometry.setAttribute('aCorner', new THREE.Float32BufferAttribute(corners, 2));
  geometry.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 4));
  geometry.setIndex(indices);
  return geometry;
})();

/** Drawn over the bodies, as the light rising through a body has to read through it. */
const MOTE_MATERIAL = new THREE.ShaderMaterial({
  uniforms: {
    uT: { value: 0 },
    uLife: { value: 1 },
    uSpread: { value: 0.5 },
    uRise: { value: 1 },
    uSize: { value: 0.06 },
    uStream: { value: 0 },
    uAlpha: { value: 1 },
    uColor: { value: new THREE.Color(MOONLIGHT) },
  },
  vertexShader: /* glsl */ `
    attribute vec2 aCorner; attribute vec4 aSeed;
    uniform float uT, uLife, uSpread, uRise, uSize, uStream;
    varying vec2 vCorner; varying float vFade;
    void main() {
      float burst = clamp(uT / uLife * aSeed.z - aSeed.w * 0.35, 0.0, 1.0);
      float k = uStream > 0.5 ? fract(uT / uLife * aSeed.z + aSeed.w) : burst;
      float r = uSpread * aSeed.y * (1.0 - 0.35 * k);
      vec4 viewed = modelViewMatrix * vec4(cos(aSeed.x) * r, uRise * k, sin(aSeed.x) * r, 1.0);
      viewed.xy += aCorner * uSize * (1.0 - 0.45 * k);
      gl_Position = projectionMatrix * viewed;
      vCorner = aCorner;
      vFade = sin(k * 3.14159265);
    }`,
  fragmentShader: /* glsl */ `
    uniform float uAlpha; uniform vec3 uColor; varying vec2 vCorner; varying float vFade;
    void main() {
      vec2 c = abs(vCorner);
      float cross = max((1.0 - smoothstep(0.12, 0.24, c.x)) * (1.0 - smoothstep(0.7, 1.0, c.y)), (1.0 - smoothstep(0.12, 0.24, c.y)) * (1.0 - smoothstep(0.7, 1.0, c.x)));
      float core = 1.0 - smoothstep(0.18, 0.38, length(vCorner));
      float alpha = max(cross, core) * vFade * uAlpha;
      if (alpha <= 0.003) discard;
      gl_FragColor = vec4(mix(uColor, vec3(1.0), core * 0.6), alpha);
      #include <colorspace_fragment>
    }`,
  transparent: true,
  depthWrite: false,
  depthTest: false,
});

function moteMesh(): THREE.Mesh {
  const mesh = new THREE.Mesh(MOTE_GEOMETRY, MOTE_MATERIAL.clone());
  mesh.renderOrder = 7;
  return mesh;
}

const BEAM_SAMPLES = 24;

/** A band between two points, `aAlong` from one to the other and `aSide` across it, which the vertex stage lays out. */
const BEAM_GEOMETRY = (() => {
  const along: number[] = [];
  const side: number[] = [];
  const indices: number[] = [];
  for (let sample = 0; sample < BEAM_SAMPLES; sample += 1) {
    along.push(sample / (BEAM_SAMPLES - 1), sample / (BEAM_SAMPLES - 1));
    side.push(-1, 1);
    if (sample < BEAM_SAMPLES - 1) indices.push(sample * 2, sample * 2 + 2, sample * 2 + 1, sample * 2 + 1, sample * 2 + 2, sample * 2 + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Array<number>(BEAM_SAMPLES * 6).fill(0), 3));
  geometry.setAttribute('aAlong', new THREE.Float32BufferAttribute(along, 1));
  geometry.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
  geometry.setIndex(indices);
  return geometry;
})();

/**
 * A beam in line art: two edges arching a little over the line between its ends, facing the
 * camera, with dashes of light flowing along it toward its far end. Drawn over the bodies, which
 * stand between a Healer and whom they mend as often as not.
 */
const BEAM_MATERIAL = new THREE.ShaderMaterial({
  uniforms: {
    uFrom: { value: new THREE.Vector3() },
    uTo: { value: new THREE.Vector3() },
    uT: { value: 0 },
    uAlpha: { value: 1 },
    uWidth: { value: 0.09 },
    uArch: { value: 0.25 },
    uColor: { value: new THREE.Color(MOONLIGHT) },
  },
  vertexShader: /* glsl */ `
    attribute float aAlong; attribute float aSide;
    uniform vec3 uFrom, uTo; uniform float uWidth, uArch;
    varying float vAlong; varying float vSide;
    void main() {
      vec3 at = mix(uFrom, uTo, aAlong) + vec3(0.0, sin(aAlong * 3.14159265) * uArch, 0.0);
      vec4 viewed = viewMatrix * vec4(at, 1.0);
      vec2 along = (viewMatrix * vec4(uTo - uFrom, 0.0)).xy;
      vec2 across = normalize(vec2(-along.y, along.x) + 1e-5);
      viewed.xy += across * aSide * uWidth * 0.5 * (0.6 + 0.4 * sin(aAlong * 3.14159265));
      gl_Position = projectionMatrix * viewed;
      vAlong = aAlong;
      vSide = aSide;
    }`,
  fragmentShader: /* glsl */ `
    uniform float uT, uAlpha; uniform vec3 uColor; varying float vAlong; varying float vSide;
    void main() {
      float edge = smoothstep(0.55, 0.85, abs(vSide));
      float flow = fract(vAlong * 5.0 - uT * 2.2);
      float dash = smoothstep(0.0, 0.12, flow) * (1.0 - smoothstep(0.3, 0.45, flow)) * (1.0 - smoothstep(0.2, 0.6, abs(vSide)));
      float ends = smoothstep(0.0, 0.08, vAlong) * smoothstep(0.0, 0.08, 1.0 - vAlong);
      float alpha = max(edge * 0.75, max(dash, 0.12)) * ends * uAlpha;
      if (alpha <= 0.003) discard;
      gl_FragColor = vec4(mix(uColor, vec3(1.0), dash * 0.5), alpha);
      #include <colorspace_fragment>
    }`,
  transparent: true,
  depthWrite: false,
  depthTest: false,
  side: THREE.DoubleSide,
});

function beamMesh(): THREE.Mesh {
  const mesh = new THREE.Mesh(BEAM_GEOMETRY, BEAM_MATERIAL.clone());
  mesh.renderOrder = 6;
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

/** Sparks fly out along their streaks and drop by `uFall` over the ground's up, whichever way the mesh is turned. */
const SPARK_MATERIAL = new THREE.ShaderMaterial({
  uniforms: {
    uT: { value: 0 },
    uLen: { value: 0.2 },
    uWidth: { value: 0.035 },
    uTravel: { value: 0.38 },
    uFall: { value: 0 },
    uColor: { value: new THREE.Color(WHITE) },
  },
  vertexShader: /* glsl */ `
    attribute vec3 aDirection; attribute vec2 aCorner; attribute float aSpeed;
    uniform float uT, uLen, uWidth, uTravel, uFall;
    void main() {
      float eased = 1.0 - pow(1.0 - uT, 3.0);
      float tail = 0.04 + uTravel * aSpeed * eased;
      float tip = tail + uLen * aSpeed * (1.0 - uT);
      vec4 placed = modelMatrix * vec4(aDirection * mix(tail, tip, aCorner.x), 1.0);
      placed.y -= uFall * uT * uT;
      vec4 viewed = viewMatrix * placed;
      vec3 along = (modelViewMatrix * vec4(aDirection, 0.0)).xyz;
      vec2 across = normalize(vec2(-along.y, along.x) + 1e-5);
      viewed.xy += across * aCorner.y * uWidth * 0.5;
      gl_Position = projectionMatrix * viewed;
    }`,
  fragmentShader: /* glsl */ `
    uniform float uT; uniform vec3 uColor;
    void main() {
      gl_FragColor = vec4(mix(vec3(1.0), uColor, min(1.0, uT * 1.6)), 1.0 - uT * uT);
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

/**
 * A ward's shell: a sphere of facets, each face carrying its corners' share of it (`aBary`), its
 * middle (`aCentre`), and a draw of its own (`aFacet`) that orders when it forms and when a blow
 * knocks it out.
 */
const SHELL_GEOMETRY = (() => {
  const geometry = new THREE.IcosahedronGeometry(1, 1);
  const position = geometry.getAttribute('position');
  const bary: number[] = [];
  const centres: number[] = [];
  const facets: number[] = [];
  let seed = 5;
  const random = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const corner = new THREE.Vector3();
  for (let face = 0; face < position.count / 3; face += 1) {
    const centre = new THREE.Vector3();
    for (let index = 0; index < 3; index += 1) centre.add(corner.fromBufferAttribute(position, face * 3 + index));
    centre.divideScalar(3);
    const facet = random();
    for (let index = 0; index < 3; index += 1) {
      bary.push(index === 0 ? 1 : 0, index === 1 ? 1 : 0, index === 2 ? 1 : 0);
      centres.push(centre.x, centre.y, centre.z);
      facets.push(facet);
    }
  }
  geometry.setAttribute('aBary', new THREE.Float32BufferAttribute(bary, 3));
  geometry.setAttribute('aCentre', new THREE.Float32BufferAttribute(centres, 3));
  geometry.setAttribute('aFacet', new THREE.Float32BufferAttribute(facets, 1));
  return geometry;
})();

/**
 * The shell in line art: each facet's edges, brighter where the shell turns away from the camera,
 * over a faint fill, its far side dimmer. The facets drawn are those formed (`uForm`) and not yet
 * knocked out (`uCrack`); a blow flashes it (`uFlash`), and spent, its facets fly out (`uBurst`,
 * moved by `uFly`) as it fades. Drawn over the bodies, round the one it shields.
 */
const SHELL_MATERIAL = new THREE.ShaderMaterial({
  uniforms: {
    uAlpha: { value: 1 },
    uForm: { value: 1 },
    uCrack: { value: 0 },
    uFlash: { value: 0 },
    uBurst: { value: 0 },
    uFly: { value: 1 },
    uColor: { value: new THREE.Color(DREAM_COLOR) },
  },
  vertexShader: /* glsl */ `
    attribute vec3 aBary; attribute vec3 aCentre; attribute float aFacet;
    uniform float uBurst, uFly;
    varying vec3 vBary; varying float vFacet; varying float vRim;
    void main() {
      vec3 outward = normalize(aCentre);
      vec3 shrunk = mix(position, aCentre, uBurst * 0.6) + outward * uBurst * uFly * (0.5 + aFacet);
      vec3 normal = normalize(mat3(modelMatrix) * outward);
      vec3 toCamera = normalize(vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]));
      vRim = 1.0 - abs(dot(normal, toCamera));
      vBary = aBary;
      vFacet = aFacet;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(shrunk, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform float uAlpha, uForm, uCrack, uFlash, uBurst; uniform vec3 uColor;
    varying vec3 vBary; varying float vFacet; varying float vRim;
    void main() {
      if (vFacet > uForm || vFacet < uCrack) discard;
      float edge = 1.0 - smoothstep(0.03, 0.075, min(min(vBary.x, vBary.y), vBary.z));
      float fill = 0.05 + 0.2 * vRim * vRim;
      float side = gl_FrontFacing ? 1.0 : 0.45;
      float alpha = (max(edge * (0.5 + 0.5 * vRim), fill) + uFlash * (0.3 + 0.4 * edge)) * side * uAlpha * (1.0 - uBurst);
      if (alpha <= 0.003) discard;
      gl_FragColor = vec4(mix(uColor, vec3(1.0), min(1.0, edge * 0.55 + uFlash * 0.6)), alpha);
      #include <colorspace_fragment>
    }`,
  transparent: true,
  depthWrite: false,
  depthTest: false,
  side: THREE.DoubleSide,
});

function shellMesh(): THREE.Mesh {
  const mesh = new THREE.Mesh(SHELL_GEOMETRY, SHELL_MATERIAL.clone());
  mesh.renderOrder = 6;
  return mesh;
}

const BOLT_SAMPLES = 16;

/**
 * A bolt: a band from its tail (`aStretch` 0) to its head (1), `aSide` across it, and a quad at its
 * head (`aHead`), each corner at `aCorner`, which the vertex stage lays along its flight, facing the camera.
 */
const BOLT_GEOMETRY = (() => {
  const stretch: number[] = [];
  const side: number[] = [];
  const head: number[] = [];
  const corners: number[] = [];
  const indices: number[] = [];
  for (let sample = 0; sample < BOLT_SAMPLES; sample += 1) {
    const along = sample / (BOLT_SAMPLES - 1);
    stretch.push(along, along);
    side.push(-1, 1);
    head.push(0, 0);
    corners.push(0, 0, 0, 0);
    if (sample < BOLT_SAMPLES - 1) indices.push(sample * 2, sample * 2 + 2, sample * 2 + 1, sample * 2 + 1, sample * 2 + 2, sample * 2 + 3);
  }
  const base = BOLT_SAMPLES * 2;
  for (const corner of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]) {
    stretch.push(1);
    side.push(0);
    head.push(1);
    corners.push(...corner);
  }
  indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Array<number>((base + 4) * 3).fill(0), 3));
  geometry.setAttribute('aStretch', new THREE.Float32BufferAttribute(stretch, 1));
  geometry.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
  geometry.setAttribute('aHead', new THREE.Float32BufferAttribute(head, 1));
  geometry.setAttribute('aCorner', new THREE.Float32BufferAttribute(corners, 2));
  geometry.setIndex(indices);
  return geometry;
})();

/**
 * A bolt in line art: a trail that crackles, its samples thrown across it at random and thrown
 * again many times a second, its segments flickering, thinning to nothing at its tail, under a shard
 * at its head pointing the way it flies, white-hot at its core and harsh violet at its edges. Drawn
 * over the bodies, which stand between a Mystic and the nightmare as often as not.
 */
const BOLT_MATERIAL = new THREE.ShaderMaterial({
  uniforms: {
    uHead: { value: new THREE.Vector3() },
    uTail: { value: new THREE.Vector3() },
    uAxis: { value: new THREE.Vector3(1, 0, 0) },
    uWidth: { value: 0.16 },
    uJag: { value: 0.09 },
    uLength: { value: 0.7 },
    uSize: { value: 0.13 },
    uT: { value: 0 },
    uAlpha: { value: 1 },
    uColor: { value: new THREE.Color(BOLT_COLOR) },
  },
  vertexShader: /* glsl */ `
    attribute float aStretch; attribute float aSide; attribute float aHead; attribute vec2 aCorner;
    uniform vec3 uHead, uTail, uAxis; uniform float uWidth, uJag, uLength, uSize, uT;
    varying float vStretch; varying float vSide; varying float vHead; varying vec2 vCorner;
    float hash(float n) { return fract(sin(n) * 43758.5453); }
    void main() {
      vec4 viewed = viewMatrix * vec4(mix(uTail, uHead, aStretch), 1.0);
      vec2 axis = normalize((viewMatrix * vec4(uAxis, 0.0)).xy + 1e-5);
      vec2 across = vec2(-axis.y, axis.x);
      if (aHead > 0.5) {
        viewed.xy += axis * (aCorner.x * 0.5 - 0.5) * uLength + across * aCorner.y * uSize;
      } else {
        float joint = floor(aStretch * ${(BOLT_SAMPLES - 1).toFixed(1)} + 0.5);
        float jag = (hash(joint * 12.9898 + floor(uT * 30.0) * 78.233) * 2.0 - 1.0) * uJag * min(1.0, (1.0 - aStretch) * 4.0);
        viewed.xy += across * (jag + aSide * uWidth * 0.5 * pow(aStretch, 0.7));
      }
      gl_Position = projectionMatrix * viewed;
      vStretch = aStretch;
      vSide = aSide;
      vHead = aHead;
      vCorner = aCorner;
    }`,
  fragmentShader: /* glsl */ `
    uniform float uT, uAlpha; uniform vec3 uColor;
    varying float vStretch; varying float vSide; varying float vHead; varying vec2 vCorner;
    float hash(float n) { return fract(sin(n) * 43758.5453); }
    void main() {
      float alpha;
      float white;
      if (vHead > 0.5) {
        float along = vCorner.x * 0.5 + 0.5;
        float half_ = along < 0.3 ? along / 0.3 : pow((1.0 - along) / 0.7, 1.3);
        float d = abs(vCorner.y) / max(half_, 1e-3);
        alpha = 1.0 - smoothstep(0.85, 1.0, d);
        white = (1.0 - smoothstep(0.15, 0.6, d)) * smoothstep(0.05, 0.35, along);
      } else {
        float segment = floor(vStretch * ${(BOLT_SAMPLES - 1).toFixed(1)});
        float flicker = 0.3 + 0.7 * step(0.3, hash(segment * 7.13 + floor(uT * 30.0) * 3.71));
        float core = 1.0 - smoothstep(0.0, 0.7, abs(vSide));
        alpha = (0.45 + 0.55 * core) * flicker * pow(vStretch, 0.6);
        white = 0.9 * core;
      }
      alpha *= uAlpha;
      if (alpha <= 0.003) discard;
      gl_FragColor = vec4(mix(uColor, vec3(1.0), white), alpha);
      #include <colorspace_fragment>
    }`,
  transparent: true,
  depthWrite: false,
  depthTest: false,
  side: THREE.DoubleSide,
});

function boltMesh(): THREE.Mesh {
  const mesh = new THREE.Mesh(BOLT_GEOMETRY, BOLT_MATERIAL.clone());
  mesh.renderOrder = 8;
  return mesh;
}

const CRACK_RAYS = 7;
const CRACK_JOINTS = 3;

/**
 * A crack's rays out from its middle, in the plane facing the camera: each a run of straight
 * segments kinked at its joints and thinning to its tip, a quad per segment with its corners at
 * `aPoint`, `aReach` the share of its ray's length from the middle, and `aSide` across it.
 */
const CRACK_GEOMETRY = (() => {
  const points: number[] = [];
  const reaches: number[] = [];
  const sides: number[] = [];
  const indices: number[] = [];
  let seed = 7;
  const random = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let ray = 0; ray < CRACK_RAYS; ray += 1) {
    let angle = ((ray + random() * 0.5) / CRACK_RAYS) * Math.PI * 2;
    const step = (0.3 + random() * 0.3) / CRACK_JOINTS;
    let x = 0;
    let y = 0;
    for (let joint = 0; joint < CRACK_JOINTS; joint += 1) {
      const from = joint / CRACK_JOINTS;
      const to = (joint + 1) / CRACK_JOINTS;
      const nextX = x + Math.cos(angle) * step;
      const nextY = y + Math.sin(angle) * step;
      const sideX = -Math.sin(angle);
      const sideY = Math.cos(angle);
      const halfFrom = 0.03 * (1 - 0.8 * from);
      const halfTo = 0.03 * (1 - 0.8 * to);
      const base = points.length / 2;
      points.push(x - sideX * halfFrom, y - sideY * halfFrom, x + sideX * halfFrom, y + sideY * halfFrom);
      points.push(nextX - sideX * halfTo, nextY - sideY * halfTo, nextX + sideX * halfTo, nextY + sideY * halfTo);
      reaches.push(from, from, to, to);
      sides.push(-1, 1, -1, 1);
      indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
      x = nextX;
      y = nextY;
      angle += (random() - 0.5) * 1.1;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Array<number>((points.length / 2) * 3).fill(0), 3));
  geometry.setAttribute('aPoint', new THREE.Float32BufferAttribute(points, 2));
  geometry.setAttribute('aReach', new THREE.Float32BufferAttribute(reaches, 1));
  geometry.setAttribute('aSide', new THREE.Float32BufferAttribute(sides, 1));
  geometry.setIndex(indices);
  return geometry;
})();

/**
 * A crack in line art: its rays drawn out to `uGrow` of their length, turned by `uSpin`, white down
 * their middles and violet at their edges, the white cooling toward their tips. Drawn over the body
 * it splits.
 */
const CRACK_MATERIAL = new THREE.ShaderMaterial({
  uniforms: { uGrow: { value: 1 }, uSpin: { value: 0 }, uAlpha: { value: 1 }, uColor: { value: new THREE.Color(BOLT_COLOR) } },
  vertexShader: /* glsl */ `
    attribute vec2 aPoint; attribute float aReach; attribute float aSide;
    uniform float uSpin;
    varying float vReach; varying float vSide;
    void main() {
      vec4 viewed = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
      viewed.xy += mat2(cos(uSpin), sin(uSpin), -sin(uSpin), cos(uSpin)) * aPoint;
      gl_Position = projectionMatrix * viewed;
      vReach = aReach;
      vSide = aSide;
    }`,
  fragmentShader: /* glsl */ `
    uniform float uGrow, uAlpha; uniform vec3 uColor; varying float vReach; varying float vSide;
    void main() {
      if (vReach > uGrow) discard;
      float core = 1.0 - smoothstep(0.15, 0.7, abs(vSide));
      float alpha = (1.0 - 0.5 * smoothstep(0.7, 1.0, abs(vSide))) * uAlpha;
      if (alpha <= 0.003) discard;
      gl_FragColor = vec4(mix(uColor, vec3(1.0), core * (1.0 - 0.6 * vReach)), alpha);
      #include <colorspace_fragment>
    }`,
  transparent: true,
  depthWrite: false,
  depthTest: false,
  side: THREE.DoubleSide,
});

function crackMesh(): THREE.Mesh {
  const mesh = new THREE.Mesh(CRACK_GEOMETRY, CRACK_MATERIAL.clone());
  mesh.renderOrder = 8;
  return mesh;
}

const TETHERS = 6;
const TETHER_SAMPLES = 10;

/** A binding's tethers: `aTether` says which, `aLength` how far from its runes up to its grip, and `aSide` across it. */
const TETHER_GEOMETRY = (() => {
  const tethers: number[] = [];
  const lengths: number[] = [];
  const sides: number[] = [];
  const indices: number[] = [];
  for (let tether = 0; tether < TETHERS; tether += 1) {
    const base = tether * TETHER_SAMPLES * 2;
    for (let sample = 0; sample < TETHER_SAMPLES; sample += 1) {
      const length = sample / (TETHER_SAMPLES - 1);
      tethers.push(tether, tether);
      lengths.push(length, length);
      sides.push(-1, 1);
      const at = base + sample * 2;
      if (sample < TETHER_SAMPLES - 1) indices.push(at, at + 2, at + 1, at + 1, at + 2, at + 3);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Array<number>(TETHERS * TETHER_SAMPLES * 6).fill(0), 3));
  geometry.setAttribute('aTether', new THREE.Float32BufferAttribute(tethers, 1));
  geometry.setAttribute('aLength', new THREE.Float32BufferAttribute(lengths, 1));
  geometry.setAttribute('aSide', new THREE.Float32BufferAttribute(sides, 1));
  geometry.setIndex(indices);
  return geometry;
})();

/**
 * Tethers in line art, each from a point on the runes round the feet (`uCentre`, `uRadius`) up to a
 * grip on the body (`uGrip` out, `uHeight` up), reaching as far as `uReach` of the way: two edges and
 * the links of a chain, each tether flickering on its own beat while `uT` runs. Drawn over the
 * bodies, so the tethers behind one still show.
 */
const TETHER_MATERIAL = new THREE.ShaderMaterial({
  uniforms: {
    uCentre: { value: new THREE.Vector3() },
    uRadius: { value: 0.85 },
    uGrip: { value: 0.25 },
    uHeight: { value: 0.8 },
    uReach: { value: 1 },
    uWidth: { value: 0.07 },
    uT: { value: 0 },
    uAlpha: { value: 1 },
    uColor: { value: new THREE.Color(DREAM_COLOR) },
  },
  vertexShader: /* glsl */ `
    attribute float aTether; attribute float aLength; attribute float aSide;
    uniform vec3 uCentre; uniform float uRadius, uGrip, uHeight, uReach, uWidth;
    varying float vLength; varying float vSide; varying float vTether;
    void main() {
      float angle = (aTether + 0.25) * 6.2831853 / ${TETHERS.toFixed(1)};
      vec3 out_ = vec3(cos(angle), 0.0, sin(angle));
      vec3 anchor = uCentre + out_ * uRadius;
      vec3 grip = uCentre + out_ * uGrip + vec3(0.0, uHeight, 0.0);
      vec4 viewed = viewMatrix * vec4(mix(anchor, grip, aLength * uReach), 1.0);
      vec2 axis = (viewMatrix * vec4(grip - anchor, 0.0)).xy;
      vec2 across = normalize(vec2(-axis.y, axis.x) + 1e-5);
      viewed.xy += across * aSide * uWidth * 0.5;
      gl_Position = projectionMatrix * viewed;
      vLength = aLength;
      vSide = aSide;
      vTether = aTether;
    }`,
  fragmentShader: /* glsl */ `
    uniform float uT, uAlpha; uniform vec3 uColor;
    varying float vLength; varying float vSide; varying float vTether;
    void main() {
      float edge = smoothstep(0.5, 0.85, abs(vSide));
      float link = 1.0 - smoothstep(0.06, 0.14, abs(fract(vLength * 6.0) - 0.5));
      float flicker = 0.85 + 0.15 * sin(uT * 13.0 + vTether * 2.3);
      float alpha = max(edge * 0.9, 0.2 + 0.55 * link) * flicker * uAlpha;
      if (alpha <= 0.003) discard;
      gl_FragColor = vec4(mix(uColor, vec3(1.0), 0.45 * edge + 0.35 * link), alpha);
      #include <colorspace_fragment>
    }`,
  transparent: true,
  depthWrite: false,
  depthTest: false,
  side: THREE.DoubleSide,
});

function tetherMesh(): THREE.Mesh {
  const mesh = new THREE.Mesh(TETHER_GEOMETRY, TETHER_MATERIAL.clone());
  mesh.renderOrder = 6;
  return mesh;
}

/** A dome over the ground, a half sphere one unit round and high, which the mesh's scale sizes. */
const DOME_GEOMETRY = new THREE.SphereGeometry(1, 40, 10, 0, Math.PI * 2, 0, Math.PI / 2);

/**
 * Veil's mist in line art: bands of mist drifting up the dome, thinning toward its top, and faint
 * lines down it from its crown. Drawn over the bodies, as the dreamers it hides stand inside it.
 */
const DOME_MATERIAL = new THREE.ShaderMaterial({
  uniforms: { uT: { value: 0 }, uAlpha: { value: 1 }, uColor: { value: new THREE.Color(MIST_COLOR) } },
  vertexShader: /* glsl */ `varying vec3 vLocal; void main() { vLocal = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform float uT, uAlpha; uniform vec3 uColor; varying vec3 vLocal;
    void main() {
      float band = 1.0 - smoothstep(0.03, 0.07, abs(fract(vLocal.y * 4.0 - uT * 0.6) - 0.5));
      float line = 1.0 - smoothstep(0.02, 0.05, abs(fract(atan(vLocal.z, vLocal.x) / 6.2831853 * 16.0) - 0.5));
      float alpha = (0.85 * band + 0.25 * line + 0.06) * (1.0 - 0.6 * vLocal.y) * uAlpha;
      if (alpha <= 0.003) discard;
      gl_FragColor = vec4(mix(uColor, vec3(1.0), 0.5 * band), alpha);
      #include <colorspace_fragment>
    }`,
  transparent: true,
  depthWrite: false,
  depthTest: false,
  side: THREE.DoubleSide,
});

function domeMesh(): THREE.Mesh {
  const mesh = new THREE.Mesh(DOME_GEOMETRY, DOME_MATERIAL.clone());
  mesh.renderOrder = 3;
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

/** A skinned mesh on one bone, which a hull's skinned program compiles over as over a body's. */
function skinnedMesh(geometry: THREE.BufferGeometry): THREE.SkinnedMesh {
  const mesh = new THREE.SkinnedMesh(geometry);
  const bone = new THREE.Bone();
  mesh.add(bone);
  mesh.bind(new THREE.Skeleton([bone]));
  return mesh;
}
