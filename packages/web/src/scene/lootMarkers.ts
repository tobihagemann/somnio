/**
 * The drops lying on the ground for the player, as Diablo draws them: the item's own model lying
 * where it fell, turned by a yaw of its own so neighbouring drops do not line up, and its name under
 * it on screen in its rarity's colour, through the world, since nothing has to be pressed to read it.
 * The name stands clear of the model, and below the feet of a body standing on the drop, so a press
 * on it reaches a drop under a body. A rare or an epic drop raises a beam of light in its colour, and an
 * uncommon, a rare, or an epic one glows on the ground under its model. A trophy lies as its kind's model the same way. A
 * drop draws its name alone while its model is not loaded, and for good when it has none.
 *
 * A drop shown as it falls is thrown there, as Diablo pops its loot: released from where it was
 * thrown from, it flies in an arc, turning over, and only as it lands shows its name and its light,
 * then hops once. A nightmare's drops burst out high and spinning; a dreamer's throw is a low
 * toss. An item thrown from a hand takes the place of the model the hand held: that model stays on
 * the hand until the release and goes from it then, and the drop's model leaves from where it was
 * drawn, turned as it was, and eases into the arc's turning over. A weapon's, a shield's, and a
 * focus's ground model is their hand model's own piece laid down, which the drop finds by matching
 * the two models' vertices, so one item leaves the hand.
 *
 * The markers come from a pool of fixed size, which draws the drops nearest the player. A drop lies
 * as long as the server says, so with more lying than the pool holds, those further off wait
 * without a marker. The pool is chosen again as a drop comes or goes, and on any frame a waiting
 * drop lies nearer than a drawn one by more than `RECHOOSE_MARGIN_METRES`, so a drop that comes
 * near, or one waiting when a far drop in the air lands, takes the marker of one now among the
 * furthest. A drop in the air keeps its marker until it lands, and one drawn from waiting lies
 * there without a flight. Every name draws with a clone of one material, every beam with one of two
 * materials, and every glow with one of three, which differ only in colour, so each program compiles
 * once, in the scene's prewarm, and none adds a light. A flight moves the model alone, so it compiles nothing.
 *
 * A drop picked up goes at once. Any other that goes fades out where it lay over
 * `LOOT_FADE_SECONDS`, drawn with clones of its materials (`fadeOut`), its name and its light with
 * it, and casts no shadow from halfway out.
 * Meanwhile it takes no press and presses no grass, and its marker draws nothing else until the fade
 * ends, which frees it for a drop waiting. Under reduced motion, and in a stalled tab, it goes at once.
 */
import * as THREE from 'three';
import type { LootContentsMessage, Rarity } from '@somnio/protocol';
import { hashString } from '@somnio/core';
import { GROUND_RING_LIFT } from './combatEffects';
import { fadeOut } from './fadeOut';
import type { FadeOut } from './fadeOut';
import { lightMaterial, whiteTexture } from './lightMaterials';
import { prototypeMeshesOf } from './modelAssets';
import { OVERLAY_METRES_PER_PIXEL, cssColor, renderNamePlaque } from './overlayArt';

/** The name of the group every drop hangs on. */
export const LOOT_MARKERS_NAME = 'somnio-loot';

/** The names of a drop's name, the glow under it, and the beam rising from it. */
export const LOOT_LABEL_NAME = 'somnio-loot-label';
export const LOOT_GLOW_NAME = 'somnio-loot-glow';
export const LOOT_BEAM_NAME = 'somnio-loot-beam';

/** How many drops are drawn at once. */
export const LOOT_MARKER_POOL_SIZE = 16;
/**
 * How much nearer the player a waiting drop must lie than a drawn one for the pool to choose again,
 * so two drops about as far do not trade the marker back and forth as the player shifts.
 */
const RECHOOSE_MARGIN_METRES = 0.25;

/** Each rarity's colour, in the name, the glow, and the beam, and on the HUD wherever an item is named: common white, uncommon green, rare blue, epic purple. */
export const RARITY_COLORS: Readonly<Record<Rarity, number>> = { common: 0xf2efe8, uncommon: 0x7aea4b, rare: 0x4998fe, epic: 0xd06fed };

/** How far round a drop's model, as it lies, a mouse press still lands on it. */
const LOOT_PICK_METRES = 0.1;
/** How far under its model on screen the top edge of a drop's name stands, in metres: past where a mouse press lands on the model. */
const LOOT_LABEL_GAP = 0.12;
const LOOT_LABEL_BACKGROUND = 'rgb(24, 22, 30)';
/** Drawn after every plaque, and through the world, as the target's plaque is. */
const LOOT_LABEL_ORDER = 9;
const GLOW_RADIUS = 0.4;
const GLOW_OPACITY = 0.55;
const BEAM_WIDTH = 0.42;
const BEAM_HEIGHT = 2.6;
const BEAM_OPACITY = 0.7;
/** How long a beam takes to brighten and dim again, and how far it dims. */
const BEAM_PULSE_SECONDS = 2.4;
const BEAM_PULSE_DEPTH = 0.25;
/**
 * How a drop flies: for how many seconds, how high its arc rises over the line it flies along, how
 * many times it turns over on the way, and how high it hops as it lands.
 */
interface Arc {
  seconds: number;
  rise: number;
  turns: number;
  bounce: number;
}

/** A dreamer's throw: a short toss from the hand, low over its line. */
export const THROW_ARC: Arc = { seconds: 0.45, rise: 0.35, turns: 1, bounce: 0.06 };
/** A nightmare's drops bursting out of it as it falls, as Diablo's loot does: high over the bodies, spinning, and longer. */
export const BURST_ARC: Arc = { seconds: 0.65, rise: 1, turns: 2, bounce: 0.1 };
/** How long a drop that goes takes to fade out. */
export const LOOT_FADE_SECONDS = 0.5;
/** How long a drop hops as it lands. */
const BOUNCE_SECONDS = 0.16;
/** How near each vertex of a ground model must come to its hand model's, moved by one transform, for the two to be one piece. */
const SAME_PIECE_METRES = 1e-4;
const UNIT_SCALE = new THREE.Vector3(1, 1, 1);
const IDENTITY = new THREE.Matrix4();

/** A drop as the scene draws it: where it lies, at the height a body there stands at, the item or trophy it is, and its name. */
export interface ShownLoot {
  lootId: string;
  at: { x: number; z: number; height: number };
  contents: LootContentsMessage;
  name: string;
}

/**
 * How a drop shown as it falls is thrown: `releaseIn` seconds from now, from the point in the world
 * `from` answers then, or, thrown from a hand, from where `prop`, the model that hand holds, is
 * drawn then, along `arc`.
 */
export interface LootThrow {
  releaseIn: number;
  from: () => THREE.Vector3;
  prop?: THREE.Object3D;
  arc: Arc;
}

/**
 * A drop in the air. `releaseAt` is when it is due to leave, on the markers' clock, and once it has
 * left, when it left. `offset` is where it left from, relative to where it lands. Thrown from a
 * hand, it also leaves turned by `turn` and sized by `size`, and eases from them into the arc.
 */
interface Flight {
  releaseAt: number;
  from: () => THREE.Vector3;
  /** The model on the hand the drop leaves, until the release takes it from the hand. */
  prop: THREE.Object3D | undefined;
  arc: Arc;
  offset: THREE.Vector3 | undefined;
  turn: THREE.Quaternion | undefined;
  size: THREE.Vector3 | undefined;
  /**
   * What the hand's model carried as it left that a turn and a size cannot say, the shear of a body
   * scaled unevenly and turned at the wrist, eased away with the turn and the size.
   */
  shear: THREE.Matrix4 | undefined;
  /** The level axis it turns over about, across the way it flies. */
  axis: THREE.Vector3;
}

interface Marker {
  root: THREE.Object3D;
  /** Carries the model through a flight; at rest where the drop lies. */
  toss: THREE.Object3D;
  /** Turns the model by the drop's yaw. */
  holder: THREE.Object3D;
  /** The model lying in the holder, or `undefined` while it has none. */
  model: THREE.Object3D | undefined;
  /** Where the model lies in the world, which a press lands on it within. */
  bounds: THREE.Box3;
  glow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  beam: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  label: THREE.Object3D;
  plate: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  /** The drop it draws, or `undefined` while it is free or fading. */
  loot: ShownLoot | undefined;
  flight: Flight | undefined;
  /** The fade of a drop gone, begun at `since` on the markers' clock, or `undefined` while none runs. */
  fading: { since: number; fade: FadeOut } | undefined;
}

/**
 * The yaw a drop lies at, in radians, the same for one drop every time it is drawn and scattered
 * from one drop to the next: a 32-bit hash of its id.
 */
function lootYaw(lootId: string): number {
  return (hashString(lootId) / 2 ** 32) * Math.PI * 2;
}

export class LootMarkers {
  readonly root = new THREE.Object3D();
  private readonly orientation: THREE.Quaternion;
  /** Up the screen, in the world: the way a name stands under its model. */
  private readonly screenUp: THREE.Vector3;
  /** A clone of the model a drop of the contents lies on the ground as, or `undefined` while there is none. */
  private readonly groundModel: (contents: LootContentsMessage) => THREE.Object3D | undefined;
  private readonly reducedMotion: boolean;
  /** Turns a beam about the vertical to face the camera, which looks from one fixed yaw. */
  private readonly beamYaw: number;
  private readonly plateGeometry = new THREE.PlaneGeometry(1, 1);
  private readonly glowGeometry = new THREE.PlaneGeometry(GLOW_RADIUS * 2, GLOW_RADIUS * 2).rotateX(-Math.PI / 2);
  private readonly beamGeometry = new THREE.PlaneGeometry(BEAM_WIDTH, BEAM_HEIGHT).translate(0, BEAM_HEIGHT / 2, 0);
  private readonly plateMaterial = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
  private readonly glowMaterials: Record<Exclude<Rarity, 'common'>, THREE.MeshBasicMaterial>;
  private readonly beamMaterials: Record<BeamRarity, THREE.MeshBasicMaterial>;
  private readonly markers: Marker[] = [];
  /** Every drop to draw, in the order it came, which breaks a tie between drops as near the player. */
  private readonly shown = new Map<string, ShownLoot>();
  /** Where the player stands, which the pool draws the drops nearest to; `undefined` while they stand nowhere. */
  private readonly viewpoint: () => { x: number; z: number } | undefined;
  private overlayScale = 1;
  /** The scene's clock as the last tick left it, which a flight is timed by. */
  private clock = 0;
  /** By base, the transform from its hand model's frame to its ground model's, or `undefined` where the two are not one piece. */
  private readonly laidDown = new Map<string, THREE.Matrix4 | undefined>();

  /** `orientation` turns a plane to face the camera, as the plaques are turned. */
  constructor(
    orientation: THREE.Quaternion,
    groundModel: (contents: LootContentsMessage) => THREE.Object3D | undefined,
    viewpoint: () => { x: number; z: number } | undefined,
    reducedMotion: boolean,
  ) {
    this.orientation = orientation;
    this.viewpoint = viewpoint;
    this.screenUp = new THREE.Vector3(0, 1, 0).applyQuaternion(orientation);
    this.groundModel = groundModel;
    this.reducedMotion = reducedMotion;
    this.beamYaw = new THREE.Euler().setFromQuaternion(orientation, 'YXZ').y;
    const glow = glowTexture();
    this.glowMaterials = {
      uncommon: lightMaterial(glow, RARITY_COLORS.uncommon, GLOW_OPACITY),
      rare: lightMaterial(glow, RARITY_COLORS.rare, GLOW_OPACITY),
      epic: lightMaterial(glow, RARITY_COLORS.epic, GLOW_OPACITY),
    };
    const beam = beamTexture();
    this.beamMaterials = { rare: lightMaterial(beam, RARITY_COLORS.rare, BEAM_OPACITY), epic: lightMaterial(beam, RARITY_COLORS.epic, BEAM_OPACITY) };
    this.root.name = LOOT_MARKERS_NAME;
  }

  /** Draws a drop lying where it fell, or, `thrown`, flying there from where it was thrown. */
  show(loot: ShownLoot, thrown?: LootThrow): void {
    this.shown.set(loot.lootId, loot);
    const marker = this.markerOf(loot.lootId);
    if (marker === undefined) this.drawNearest();
    else this.draw(marker, loot);
    const drawn = this.markerOf(loot.lootId);
    if (drawn !== undefined && thrown !== undefined) this.throw(drawn, thrown);
    else thrown?.prop?.removeFromParent();
  }

  /** Takes a drop away: at once when `taken` up, under reduced motion, or undrawn, and otherwise fading out where it lay. */
  remove(lootId: string, taken: boolean): void {
    this.shown.delete(lootId);
    const marker = this.markerOf(lootId);
    if (marker === undefined) return;
    if (taken || this.reducedMotion) {
      this.free(marker);
    } else {
      this.rest(marker);
      marker.loot = undefined;
      marker.fading = { since: this.clock, fade: fadeOut(marker.root) };
    }
    this.drawNearest();
  }

  clear(): void {
    this.shown.clear();
    for (const marker of this.markers) this.free(marker);
  }

  /** Lays the model of every drop drawn without one, now that the models are loaded. */
  refreshModels(): void {
    for (const marker of this.markers) if (marker.loot !== undefined && marker.model === undefined) this.layModel(marker, marker.loot);
  }

  /** How many times its size in metres a name is drawn, as the plaques are. */
  setOverlayScale(scale: number): void {
    this.overlayScale = scale;
    for (const marker of this.markers) marker.label.scale.setScalar(scale);
  }

  /**
   * Flies the drops in the air, fades the drops gone, and brightens and dims the beams, `seconds`
   * into the scene's clock; under reduced motion the beams hold steady. After a `stalled` tab, every
   * drop in the air lies where it falls, and every drop fading is gone. Then, with drops waiting,
   * chooses the pool again where a fade freed a marker or one lies nearer than a drawn drop, a drop
   * that has just landed included.
   */
  tick(seconds: number, stalled: boolean): void {
    this.clock = seconds;
    let freed = false;
    for (const marker of this.markers) {
      if (marker.fading !== undefined) {
        const k = (seconds - marker.fading.since) / LOOT_FADE_SECONDS;
        if (stalled || k >= 1) {
          this.free(marker);
          freed = true;
        } else {
          marker.fading.fade.to(k);
        }
      } else if (marker.flight !== undefined) {
        if (stalled) this.land(marker);
        else this.fly(marker, marker.flight);
      }
    }
    if (freed || this.waitingLiesNearer()) this.drawNearest();
    const pulse = this.reducedMotion ? 0 : (1 - Math.cos((seconds / BEAM_PULSE_SECONDS) * Math.PI * 2)) / 2;
    for (const material of Object.values(this.beamMaterials)) material.opacity = BEAM_OPACITY * (1 - BEAM_PULSE_DEPTH * pulse);
  }

  /**
   * The drops on the ground, lying where they landed or hopping as they land, each with its model
   * and a key for what the model is, one per base, tier, and line or trophy kind. A drop without a model, or
   * one in the air, is left out.
   */
  lying(): { key: string; model: THREE.Object3D }[] {
    return this.markers.flatMap(({ loot, model, flight }) =>
      loot === undefined || model === undefined || (flight !== undefined && !this.touchedDown(flight)) ? [] : [{ key: modelKey(loot.contents), model }],
    );
  }

  /** Whether a thrown drop has come down where it lies, its hop as it lands included. */
  private touchedDown(flight: Flight): boolean {
    return flight.offset !== undefined && this.clock - flight.releaseAt >= flight.arc.seconds;
  }

  /** The drop whose name the raycaster's ray meets first. A drop in the air shows none yet. */
  labelAt(raycaster: THREE.Raycaster): string | undefined {
    const drawn = this.drawn().filter((marker) => marker.label.visible);
    this.root.updateMatrixWorld(true);
    const [hit] = raycaster.intersectObjects(
      drawn.map((marker) => marker.plate),
      false,
    );
    return hit === undefined ? undefined : drawn.find((marker) => marker.plate === hit.object)?.loot?.lootId;
  }

  /** The drop whose model, as it lies, the ray meets nearest the camera, within `reach` round it or, by default, a mouse's reach. */
  modelAt(ray: THREE.Ray, reach = LOOT_PICK_METRES): string | undefined {
    let picked: string | undefined;
    let nearest = Number.POSITIVE_INFINITY;
    const hit = new THREE.Vector3();
    for (const { model, loot, bounds } of this.markers) {
      if (model === undefined || loot === undefined) continue;
      if (ray.intersectBox(bounds.clone().expandByScalar(reach), hit) === null) continue;
      const along = hit.distanceToSquared(ray.origin);
      if (along >= nearest) continue;
      picked = loot.lootId;
      nearest = along;
    }
    return picked;
  }

  /** Where in the world the middle of a drop's name, or of its model, is drawn; `undefined` for a drop not drawn, or for its model while it has none. */
  pointOf(lootId: string, part: 'label' | 'model'): THREE.Vector3 | undefined {
    const marker = this.markerOf(lootId);
    if (marker === undefined) return undefined;
    if (part === 'model') return marker.model === undefined ? undefined : marker.bounds.getCenter(new THREE.Vector3());
    this.root.updateMatrixWorld(true);
    return marker.plate.getWorldPosition(new THREE.Vector3());
  }

  /** Compiles the name's, the glow's, and the beam's programs, so the first drop compiles nothing. */
  async compile(renderer: Pick<THREE.WebGLRenderer, 'compileAsync'>, camera: THREE.Camera, scene: THREE.Scene): Promise<void> {
    if (this.markers.length === 0) this.markers.push(this.makeMarker());
    await renderer.compileAsync(this.root, camera, scene);
  }

  private markerOf(lootId: string): Marker | undefined {
    return this.markers.find((marker) => marker.loot?.lootId === lootId);
  }

  private drawn(): Marker[] {
    return this.markers.filter((marker) => marker.loot !== undefined);
  }

  /**
   * Whether the nearest waiting drop lies nearer the player, by more than `RECHOOSE_MARGIN_METRES`,
   * than the furthest drawn drop the pool could give up, one in the air being kept.
   */
  private waitingLiesNearer(): boolean {
    if (this.shown.size <= LOOT_MARKER_POOL_SIZE) return false;
    const viewpoint = this.viewpoint();
    if (viewpoint === undefined) return false;
    const away = ({ at }: ShownLoot): number => Math.hypot(at.x - viewpoint.x, at.z - viewpoint.z);
    let furthestDrawn = Number.NEGATIVE_INFINITY;
    const drawnIds = new Set<string>();
    for (const { loot, flight } of this.markers) {
      if (loot === undefined) continue;
      drawnIds.add(loot.lootId);
      if (flight === undefined) furthestDrawn = Math.max(furthestDrawn, away(loot));
    }
    for (const loot of this.shown.values()) if (!drawnIds.has(loot.lootId) && away(loot) + RECHOOSE_MARGIN_METRES < furthestDrawn) return true;
    return false;
  }

  /**
   * Gives the pool to the drops nearest the player, the older first of two as near, with every drop
   * in the air among them: frees the marker of a drop no longer among them, and draws each one
   * among them still waiting, while a marker is free or the pool can grow.
   */
  private drawNearest(): void {
    const viewpoint = this.viewpoint();
    const away = (loot: ShownLoot): number => (viewpoint === undefined ? 0 : Math.hypot(loot.at.x - viewpoint.x, loot.at.z - viewpoint.z));
    const flying = this.markers.flatMap(({ loot, flight }) => (loot !== undefined && flight !== undefined ? [loot.lootId] : []));
    const lying = [...this.shown.values()].filter((loot) => !flying.includes(loot.lootId)).sort((a, b) => away(a) - away(b));
    const chosen = new Set([...flying, ...lying.slice(0, LOOT_MARKER_POOL_SIZE - flying.length).map((loot) => loot.lootId)]);
    for (const marker of this.markers) if (marker.loot !== undefined && !chosen.has(marker.loot.lootId)) this.free(marker);
    for (const lootId of chosen) {
      if (this.markerOf(lootId) !== undefined) continue;
      const marker = this.markers.find((candidate) => candidate.loot === undefined && candidate.fading === undefined) ?? this.grow();
      if (marker === undefined) return;
      this.draw(marker, this.shown.get(lootId)!);
    }
  }

  private grow(): Marker | undefined {
    if (this.markers.length >= LOOT_MARKER_POOL_SIZE) return undefined;
    const marker = this.makeMarker();
    this.markers.push(marker);
    return marker;
  }

  private makeMarker(): Marker {
    const root = new THREE.Object3D();
    root.visible = false;
    const toss = new THREE.Object3D();
    const holder = new THREE.Object3D();
    toss.add(holder);
    const glow = new THREE.Mesh(this.glowGeometry, this.glowMaterials.uncommon);
    glow.name = LOOT_GLOW_NAME;
    glow.position.y = GROUND_RING_LIFT;
    const beam = new THREE.Mesh(this.beamGeometry, this.beamMaterials.rare);
    beam.name = LOOT_BEAM_NAME;
    beam.rotation.y = this.beamYaw;
    const label = new THREE.Object3D();
    label.name = LOOT_LABEL_NAME;
    label.quaternion.copy(this.orientation);
    label.scale.setScalar(this.overlayScale);
    const material = this.plateMaterial.clone();
    // A name is always drawn from a texture, so the program a first drop draws with is the one compiled.
    material.map = new THREE.CanvasTexture(document.createElement('canvas'));
    const plate = new THREE.Mesh(this.plateGeometry, material);
    plate.renderOrder = LOOT_LABEL_ORDER;
    label.add(plate);
    root.add(toss, glow, beam, label);
    this.root.add(root);
    return { root, toss, holder, model: undefined, bounds: new THREE.Box3(), glow, beam, label, plate, loot: undefined, flight: undefined, fading: undefined };
  }

  private draw(marker: Marker, loot: ShownLoot): void {
    this.rest(marker);
    marker.loot = loot;
    marker.root.position.set(loot.at.x, loot.at.height, loot.at.z);
    marker.holder.rotation.y = lootYaw(loot.lootId);
    this.layModel(marker, loot);
    this.showLanded(marker);
    const rarity = rarityOf(loot.contents);
    if (rarity !== 'common') marker.glow.material = this.glowMaterials[rarity];
    if (raisesBeam(rarity)) marker.beam.material = this.beamMaterials[rarity];
    const art = renderNamePlaque(loot.name, LOOT_LABEL_BACKGROUND, true, cssColor(RARITY_COLORS[rarity]));
    const texture = new THREE.CanvasTexture(art.canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    marker.plate.material.map?.dispose();
    marker.plate.material.map = texture;
    const width = art.widthPixels * OVERLAY_METRES_PER_PIXEL;
    const height = art.heightPixels * OVERLAY_METRES_PER_PIXEL;
    marker.plate.scale.set(width, height, 1);
    // Its top edge at the label's origin, centred under the drop.
    marker.plate.position.set(0, -height / 2, 0);
    marker.root.visible = true;
  }

  /** Takes the drop up into the air until its release; its name and its light wait for it to land. */
  private throw(marker: Marker, thrown: LootThrow): void {
    marker.flight = {
      releaseAt: this.clock + thrown.releaseIn,
      from: thrown.from,
      prop: thrown.prop,
      arc: thrown.arc,
      offset: undefined,
      turn: undefined,
      size: undefined,
      shear: undefined,
      axis: new THREE.Vector3(1, 0, 0),
    };
    marker.toss.visible = false;
    marker.label.visible = false;
    marker.glow.visible = false;
    marker.beam.visible = false;
  }

  /**
   * Poses a drop in the air: unseen until its release, then on a parabola from where it left to
   * where it lies, turning over about the level axis across its way, then a hop where it lands.
   */
  private fly(marker: Marker, flight: Flight): void {
    if (flight.offset === undefined) {
      if (this.clock < flight.releaseAt) return;
      this.release(marker, flight);
    }
    const { offset, arc } = flight;
    const elapsed = this.clock - flight.releaseAt;
    const share = elapsed / arc.seconds;
    if (share < 1) {
      const ease = share * share * (3 - 2 * share);
      marker.toss.position.copy(offset!).multiplyScalar(1 - share);
      marker.toss.position.y += arc.rise * 4 * share * (1 - share);
      marker.toss.quaternion.setFromAxisAngle(flight.axis, share * arc.turns * Math.PI * 2);
      if (flight.turn !== undefined) marker.toss.quaternion.slerpQuaternions(flight.turn, marker.toss.quaternion.clone(), ease);
      if (flight.size !== undefined) marker.toss.scale.lerpVectors(flight.size, UNIT_SCALE, ease);
      if (flight.shear !== undefined) shearToss(marker.toss, flight.shear, ease);
      return;
    }
    if (!marker.label.visible) this.showLanded(marker);
    const hop = (elapsed - arc.seconds) / BOUNCE_SECONDS;
    if (hop >= 1) {
      this.land(marker);
      return;
    }
    marker.toss.position.set(0, arc.bounce * Math.sin(hop * Math.PI), 0);
    marker.toss.quaternion.identity();
    marker.toss.matrixAutoUpdate = true;
  }

  /**
   * Lets the drop go, now: from where the hand's model is drawn and as it is turned, the hand's
   * model gone from the hand in the same frame, or else from the point `from` answers.
   */
  private release(marker: Marker, flight: Flight): void {
    flight.releaseAt = this.clock;
    const leaving = flight.prop === undefined ? undefined : this.tossOver(marker, flight.prop);
    if (leaving === undefined) {
      flight.offset = flight.from().sub(marker.root.position);
    } else {
      flight.offset = new THREE.Vector3();
      flight.turn = new THREE.Quaternion();
      flight.size = new THREE.Vector3();
      leaving.decompose(flight.offset, flight.turn, flight.size);
      flight.shear = new THREE.Matrix4().compose(flight.offset, flight.turn, flight.size).invert().multiply(leaving);
    }
    this.letGo(flight);
    if (flight.offset.x !== 0 || flight.offset.z !== 0) flight.axis.set(-flight.offset.z, 0, flight.offset.x).normalize();
    marker.toss.visible = true;
  }

  /**
   * How the toss sits under the drop's root for its model to be drawn where `prop`, the same piece
   * held in a hand, is drawn now, as a whole matrix, since a hand under a body scaled unevenly is
   * sheared as well as turned and sized; `undefined` while the drop has no model, the prop has left
   * the hand, or the two models are not one piece.
   */
  private tossOver(marker: Marker, prop: THREE.Object3D): THREE.Matrix4 | undefined {
    const { model, loot } = marker;
    if (model === undefined || loot?.contents.kind !== 'item' || prop.parent === null) return undefined;
    const { baseId } = loot.contents;
    if (!this.laidDown.has(baseId)) this.laidDown.set(baseId, laidDown(prop, model));
    const fromHand = this.laidDown.get(baseId);
    if (fromHand === undefined) return undefined;
    prop.updateWorldMatrix(true, false);
    marker.root.updateWorldMatrix(true, false);
    marker.holder.updateMatrix();
    model.updateMatrix();
    const underToss = marker.holder.matrix.clone().multiply(model.matrix);
    return marker.root.matrixWorld.clone().invert().multiply(prop.matrixWorld).multiply(fromHand.clone().invert()).multiply(underToss.invert());
  }

  /** Takes the hand's model the drop leaves from the hand, once. */
  private letGo(flight: Flight): void {
    flight.prop?.removeFromParent();
    flight.prop = undefined;
  }

  /** The drop lies where it landed, with its name and its light. */
  private land(marker: Marker): void {
    this.rest(marker);
    this.showLanded(marker);
  }

  /** Shows the drop's name, and the glow and the beam its rarity raises. */
  private showLanded(marker: Marker): void {
    const rarity = marker.loot === undefined ? 'common' : rarityOf(marker.loot.contents);
    marker.label.visible = true;
    marker.glow.visible = rarity !== 'common';
    marker.beam.visible = raisesBeam(rarity);
  }

  /** Ends any flight, taking a hand's model it has not let go of yet from the hand, and sets the model where the drop lies. */
  private rest(marker: Marker): void {
    if (marker.flight !== undefined) this.letGo(marker.flight);
    marker.flight = undefined;
    marker.toss.visible = true;
    settle(marker.toss);
  }

  /**
   * Puts the drop's model in the holder in place of any other, measures where it lies, and stands
   * the name under it. The model is the cache's clone, so it is let go, never disposed.
   */
  private layModel(marker: Marker, loot: ShownLoot): void {
    marker.model?.removeFromParent();
    marker.model = this.groundModel(loot.contents);
    if (marker.model !== undefined) {
      marker.holder.add(marker.model);
      // Measured where it lies, not where a flight has it; the next tick poses the flight again.
      settle(marker.toss);
      marker.root.updateMatrixWorld(true);
      marker.bounds.setFromObject(marker.model);
    }
    this.placeLabel(marker);
  }

  /** Stands the name's top edge `LOOT_LABEL_GAP` under the lowest point on screen of the drop's model, or of its point while it has none. */
  private placeLabel(marker: Marker): void {
    let below = 0;
    if (marker.model !== undefined) {
      const { min, max } = marker.bounds;
      const corner = new THREE.Vector3();
      for (const x of [min.x, max.x]) {
        for (const y of [min.y, max.y]) {
          for (const z of [min.z, max.z]) below = Math.max(below, -corner.set(x, y, z).sub(marker.root.position).dot(this.screenUp));
        }
      }
    }
    marker.label.position.copy(this.screenUp).multiplyScalar(-(below + LOOT_LABEL_GAP));
  }

  /** Lets the marker go, first ending any fade with every material it drew with put back, so the next drop draws whole. */
  private free(marker: Marker): void {
    marker.fading?.fade.end(true);
    marker.fading = undefined;
    this.rest(marker);
    marker.model?.removeFromParent();
    marker.model = undefined;
    marker.loot = undefined;
    marker.root.visible = false;
  }
}

/** Sets a drop's toss where the drop lies: no offset, no turn, no shear, and its own size. */
function settle(toss: THREE.Object3D): void {
  toss.position.set(0, 0, 0);
  toss.quaternion.identity();
  toss.scale.set(1, 1, 1);
  toss.matrixAutoUpdate = true;
}

/** Draws the toss as its offset, turn, and size say, sheared by `shear` eased `ease` of the way to none. */
function shearToss(toss: THREE.Object3D, shear: THREE.Matrix4, ease: number): void {
  const eased = shear.clone();
  for (const [index, value] of IDENTITY.elements.entries()) eased.elements[index] = eased.elements[index]! + (value - eased.elements[index]!) * ease;
  toss.matrixAutoUpdate = false;
  toss.matrix.compose(toss.position, toss.quaternion, toss.scale).multiply(eased);
  toss.matrixWorldNeedsUpdate = true;
}

/** An item's rarity; a trophy is common. */
function rarityOf(contents: LootContentsMessage): Rarity {
  return contents.kind === 'item' ? contents.rarity : 'common';
}

type BeamRarity = 'rare' | 'epic';

function raisesBeam(rarity: Rarity): rarity is BeamRarity {
  return rarity === 'rare' || rarity === 'epic';
}

function modelKey(contents: LootContentsMessage): string {
  return contents.kind === 'item' ? `item:${contents.baseId}:${contents.tier}:${contents.line ?? ''}` : `trophy:${contents.monsterKind}`;
}

/**
 * The transform from a hand model's frame to its ground model's where the ground model is the hand
 * model's own piece laid down: one transform, turning without mirroring, that moves every vertex of
 * the one, in order, onto the other's. `undefined` for two models that are not one piece so moved.
 */
function laidDown(hand: THREE.Object3D, ground: THREE.Object3D): THREE.Matrix4 | undefined {
  const held = verticesOf(hand);
  const lying = verticesOf(ground);
  if (held.length !== lying.length || held.length < 4) return undefined;
  const corners = spanningCorners(held);
  const frame = (points: readonly THREE.Vector3[]): THREE.Matrix4 => {
    const [origin, ...edges] = corners.map((index) => points[index]!);
    return new THREE.Matrix4()
      .makeBasis(...(edges.map((corner) => corner.clone().sub(origin!)) as [THREE.Vector3, THREE.Vector3, THREE.Vector3]))
      .setPosition(origin!);
  };
  const heldFrame = frame(held);
  if (Math.abs(heldFrame.determinant()) < 1e-12) return undefined;
  const fromHand = frame(lying).multiply(heldFrame.invert());
  if (fromHand.determinant() <= 0) return undefined;
  const moved = new THREE.Vector3();
  return held.every((vertex, index) => moved.copy(vertex).applyMatrix4(fromHand).distanceTo(lying[index]!) <= SAME_PIECE_METRES) ? fromHand : undefined;
}

/** Every vertex of a model, in the order its meshes and their geometry hold them, in the model's own frame. */
function verticesOf(root: THREE.Object3D): THREE.Vector3[] {
  return prototypeMeshesOf(root).flatMap(({ geometry, matrix }) => {
    const position = geometry.getAttribute('position');
    return Array.from({ length: position.count }, (_, index) => new THREE.Vector3().fromBufferAttribute(position, index).applyMatrix4(matrix));
  });
}

/**
 * Four vertices spread as far as the model goes: the first, the farthest from it, the farthest from
 * the line through both, and the farthest from their plane.
 */
function spanningCorners(points: readonly THREE.Vector3[]): [number, number, number, number] {
  const farthest = (distance: (point: THREE.Vector3) => number): number => {
    let best = 0;
    for (let index = 1; index < points.length; index += 1) if (distance(points[index]!) > distance(points[best]!)) best = index;
    return best;
  };
  const first = points[0]!;
  const second = farthest((point) => point.distanceToSquared(first));
  const line = new THREE.Line3(first, points[second]);
  const onLine = new THREE.Vector3();
  const third = farthest((point) => line.closestPointToPoint(point, false, onLine).distanceToSquared(point));
  const plane = new THREE.Plane().setFromCoplanarPoints(first, points[second]!, points[third]!);
  const fourth = farthest((point) => Math.abs(plane.distanceToPoint(point)));
  return [0, second, third, fourth];
}

/** A soft pool of light: white at its middle, gone at its rim. */
function glowTexture(): THREE.Texture {
  return whiteTexture(64, 64, (u, v) => (1 - Math.min(1, Math.hypot(u - 0.5, v - 0.5) * 2)) ** 2);
}

/** A shaft of light: brightest down its middle and at its foot, fading out to its sides and its top. */
function beamTexture(): THREE.Texture {
  return whiteTexture(16, 64, (u, v) => Math.sin(u * Math.PI) ** 2 * (1 - v) ** 1.5);
}
