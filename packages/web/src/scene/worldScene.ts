/**
 * The Three.js world scene.
 */
import * as THREE from 'three';
import type { ClientEntity, ClientWorld } from '@/client/clientWorld';
import type { AbilityShown, RaiseProgress, SpeechBubbleRequest, TargetMark, WorldRenderSurface } from '@/client/renderSurface';
import {
  EDGE_TOLERANCE,
  clamp,
  closestOnRect,
  closestOnSegment,
  distance,
  distanceToRect,
  fixtureCarrierId,
  groundHeightAt,
  headingRadians,
  hourOfDay,
  itemLabelKey,
  neighbourSectors,
  nightmareLabelKey,
  objectModel,
  paddedRasterRect,
  rectContains,
  relativeDirection,
  resolveDoor,
  sectorAt,
  sectorOrigin,
  sectorRect,
  trophyLabelKey,
  worldSecondsAt,
  worldToModel,
} from '@somnio/core';
import type {
  AbilityId,
  EffectId,
  EliteTraitId,
  Heading,
  LightKind,
  ModelRegistry,
  Point,
  QuestMarker,
  Rect,
  ResolvedDoor,
  Size,
  SpaceCollision,
  WorldClockReading,
} from '@somnio/core';
import { CONDITIONS, HANDS } from '@somnio/protocol';
import type {
  Condition,
  Gait,
  Hand,
  Held,
  LootMessage,
  Placement,
  SectorView,
  SensedBearingMessage,
  TelegraphMessage,
  ThrownFromMessage,
} from '@somnio/protocol';
import { t } from '@/i18n';
import { CLIP_TRANSITION_DURATION, MAX_TICK_DELTA, MOTION_GRACE_WINDOW, movementPose, resolveClipName, resolveOneShotClipName } from './animation';
import type { AnimationPose, OneShot } from './animation';
import { ORTHO_RIG, applyFrustum, cameraPosition, clampedScale, frustumBounds, scaleForZoomFactor } from './cameraRig';
import { CRUMBLE_SECONDS, CombatEffects, GROUND_RING_LIFT, GROUND_RING_WIDTH, HELD_PROP, RAISE_COLOR, RAISE_RING_RADII, strikeDelay } from './combatEffects';
import { SUN_SHADOW, doorLightState, sunState } from './dayNightSun';
import { groundFieldKey, rasterizeGround } from './groundField';
import type { GroundField, GroundFieldInputs } from './groundField';
import { GROUND_MATERIAL_IDS, GROUND_RECIPES, groundFragmentChunks, groundMaterialChannel } from './groundMaterials';
import { defaultGroundRasterizer } from './groundRasterizer';
import type { GroundRasterizer } from './groundRasterizer';
import { FLAT_TILT, GrassSpring, IMPACT_PRESS_RATE } from './grassSpring';
import type { GrassBatch, GrassContact } from './grassSpring';
import { GRASS_MODEL_IDS, PEBBLE_MODEL_ID, scatterSector } from './scatter';
import type { ScatterTuft } from './scatter';
import { layoutBubbles, tailTip } from './bubbleLayout';
import { EliteAuras } from './eliteAuras';
import { QuestMarkers } from './questMarkers';
import { BURST_ARC, LootMarkers, THROW_ARC } from './lootMarkers';
import type { LootThrow } from './lootMarkers';
import type { BubbleMode, BubbleRequest, ScreenDisc, ScreenPoint, ScreenRect, ScreenSize } from './bubbleLayout';
import type { PlacedBubble, PlacedBubbles } from './bubbleLayer';
import {
  MISS_WORD,
  NAME_PLAQUE,
  OVERLAY_METRES_PER_PIXEL,
  PLAQUE_FEET_GAP,
  namePlaqueBackground,
  overlayMagnification,
  renderNamePlaque,
  renderOutlinedText,
  speechBubbleFrameSize,
} from './overlayArt';
import type { RasterArt } from './overlayArt';
import { CHARACTER_SCALE, PLACEHOLDER_HEIGHT, easedHeight, placeholderFootprint, placementElevation } from './placement';
import { PROP_LIGHT_COLOR, PROP_LIGHT_DECAY, PROP_LIGHT_DISTANCE, PROP_LIGHT_POOL_SIZE, PROP_LIGHT_PRESETS, flameFlicker, flamePhase } from './propLights';
import { prototypeMeshesOf } from './modelAssets';
import type { ModelAssets, PrototypeMesh } from './modelAssets';
import { PORTRAIT, PORTRAIT_LAYERS, PORTRAIT_SLOTS, PortraitPass, bodyFraming, portraitFraming, setPortraitLayer } from './portraits';
import type { DeviceRect, PortraitRenderer, PortraitSlot, PortraitSubject } from './portraits';
import { yawStep } from './yawSlew';

/**
 * Per-entity render state the scene mutates each frame.
 *
 * The entity record is a value rebuilt from every inbound frame, so the walk clock and the slewed
 * yaw cannot live there — they live here, keyed by entity id.
 */
interface EntityRenderState {
  /** Translation only. Overlays hang off this, so it must never carry the facing yaw. */
  node: THREE.Object3D;
  /** Between the node and the model holder: the stagger and the lift of the combat effects move it, render-only, so a move never fights them. */
  jolt: THREE.Object3D;
  /** Carries the yaw and the swappable model, so a post-prewarm swap never moves the overlays. */
  modelHolder: THREE.Object3D;
  mixer: THREE.AnimationMixer | undefined;
  action: THREE.AnimationAction | undefined;
  kind: ClientEntity['kind'];
  characterModelId: string;
  name: string;
  /** The trait an elite carries, which names it and colours its aura. */
  trait: EliteTraitId | undefined;
  radius: number;
  facing: Heading;
  gait: Gait;
  /** Where the entity stands on the ground plane; the node's height eases after it. */
  position: Point;
  travelHeading: Heading | undefined;
  currentYaw: number;
  lastMotionTime: number;
  pendingMotion: boolean;
  isPlaceholder: boolean;
  /**
   * How far above its node the model reaches standing, measured once when the model is put in, in
   * its idle pose. A skinned mesh keeps the bounds of the pose it was first measured in, so a first
   * measure of a body that lies fallen would come back low and stay low. `headPoint` is what follows
   * the pose.
   */
  headHeight: number;
  /** The model's head bone, which a fallen body's head is followed down by; `undefined` for a model without one. */
  headBone: THREE.Object3D | undefined;
  /** The bones that brush grass: the feet and toes on the ground, and the lower legs wading through it. */
  grassBones: { bone: THREE.Object3D; foot: boolean }[];
  /** How far above the node the head bone stands in the idle pose; always positive where `headBone` is set. */
  headBoneRest: number;
  /** Label under the feet. Created on first placement and rebuilt on a kind, name, or condition change, and when the pointer comes over a hale nightmare or leaves it. */
  namePlaque: THREE.Object3D | undefined;
  /** The plaque's own mesh, which carries its draw order. */
  namePlaquePlate: THREE.Mesh | undefined;
  pose: AnimationPose | undefined;
  condition: Condition;
  /** A clip playing once over the looping pose; `held` keeps its last frame until the entity stands again. */
  oneShot: { action: THREE.AnimationAction; held: boolean } | undefined;
  /** When the fall of a body that lies fallen starts, on the scene's clock, while it waits for the blow that felled it to land. */
  fallsAt: number | undefined;
  /** What the hands hold, and the models hung on their bones for it. */
  held: Held | undefined;
  heldProps: Partial<Record<Hand, THREE.Object3D>>;
}

/** A speech bubble, with what it was asked to show, so every frame can place it again. */
interface SpeechBubble {
  request: SpeechBubbleRequest;
  expiresAtMs: number;
  /** Its frame, a yell's teeth included, in metres of overlay art on the screen. */
  size: ScreenSize;
  mode: BubbleMode | undefined;
  /** The offset from its speaker's head it held last tick; `undefined` while it hung from no head. */
  spot: ScreenPoint | undefined;
  /** What it hung from last tick, and whether that was its speaker's head; `undefined` while it hung from nothing. */
  anchor: { at: ScreenPoint; head: boolean } | undefined;
  /** Where its middle is drawn, gliding after where the layout puts it; `undefined` before its first frame. */
  drawn: ScreenPoint | undefined;
}

/** How large a fallen dreamer's marker is drawn on the page, in CSS pixels: its badge, the arrow round it, and its name under it. */
export const SENSED_MARKER_PIXELS = { width: 96, height: 66 } as const;

/** A fallen dreamer's marker as the scene placed it: at the screen's edge toward where they lie, in metres of overlay art from the screen's middle. */
export interface PlacedMarker {
  name: string;
  /** Where they lie in the space. */
  at: Point;
  centre: ScreenPoint;
  /** The way they lie from the marker on the screen, in radians counter-clockwise from the right. */
  toward: number;
}

export interface PlacedMarkers {
  /** Half the screen's width and height. */
  halfSize: ScreenPoint;
  markers: readonly PlacedMarker[];
}

/** What a press on the play field lands on. */
export type PressTarget =
  { kind: 'loot'; lootId: string } | { kind: 'entity'; entityId: string } | { kind: 'fixture'; carrierId: string } | { kind: 'ground'; point: Point };

/** What the layout is asked about one bubble, and what its tail points at once it is placed. */
interface BubbleEntry {
  bubble: SpeechBubble;
  request: BubbleRequest;
  /** Whether its anchor is its speaker's head. */
  fromHead: boolean;
  /** What a fixed bubble's tail points toward: the wall the voice comes through. */
  wall: ScreenPoint | undefined;
}

/** The ring a press drops where it holds the ground, or on the body, fixture, or drop it walks the player to. It stays on the walk's destination, following a body as it moves, and lifts away when that walk ends. */
interface PressMarker {
  mesh: THREE.Mesh;
  /** Where it lies once down: a point of the space, at the height a body there stands at. */
  at: { x: number; z: number; height: number };
  droppedAtMs: number;
  /** When it begins to rise again; `undefined` while it is down. */
  liftsAtMs: number | undefined;
}

interface PlacedModel {
  node: THREE.Object3D;
  placement: Placement;
  isPlaceholder: boolean;
  /** The flame it carries in a room; `undefined` for a model with none, and for every placement outdoors. */
  emitter: Emitter | undefined;
}

/** A flame a room's placement carries. Its halo hangs on the placement's node, where the flame burns, so it moves and turns with it. */
interface Emitter {
  kind: LightKind;
  halo: THREE.Sprite;
  /** Where in its flicker it is, spread over the room's flames when the room is added. */
  phase: number;
}

interface DrawnSector {
  view: SectorView;
  /** The ids of its doors that open to the outdoors. */
  outdoorDoorIds: readonly string[];
  /** Stands at the sector's origin, so its records keep their sector-relative positions. */
  group: THREE.Object3D;
  placements: PlacedModel[];
  fixtures: DrawnFixture[];
}

/** A fixture as drawn: the node of the placement that carries it, and an unturned point at its foot that a quest mark hangs over. */
interface DrawnFixture {
  carrierId: string;
  node: THREE.Object3D;
  anchor: THREE.Object3D;
}

/**
 * A sector's painted ground. It hangs off the space root, not the sector's group, because it has to
 * outlive a re-add of the sector: the field drawn stays until the one for the sector's new inputs
 * arrives.
 */
interface DrawnGround {
  mesh: THREE.Mesh;
  /** What the drawn field was rasterized from; `undefined` while the flat background stands in. */
  key: string | undefined;
  field: GroundField | undefined;
  /** What the field asked for last was rasterized from; a field for anything else is stale. */
  pending: string | undefined;
  /** What grows on the ground, and what it was placed from: the field and the placements and doors here and next door. */
  scatter: { group: THREE.Object3D; key: string; batches: GrassBatch[] } | undefined;
}

const PLACEHOLDER_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 1 });

/** The heights up a fixture's bounds, as shares from its foot to its top, tried in turn for a point its model is drawn at. */
const FIXTURE_POINT_SHARES = [0.5, 0.65, 0.8, 0.35, 0.2];

/** Shared zero vector for basis construction; never mutated. */
const ORIGIN = new THREE.Vector3();

/** The renderer a world scene draws through. */
export function createWorldRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  configureWorldRenderer(renderer);
  return renderer;
}

/**
 * three.js does not shadow at all unless asked, and without shadows every prop and character
 * reads as floating. PCF, three's own default, softens each edge over a disc of `shadow.radius`
 * texels; the basic filter's hard edge reads as a cut-out. Tone mapping keeps a lit wall from
 * clipping to white, and the neutral curve keeps the painted colours' hue where a filmic one
 * would wash them toward grey.
 */
export function configureWorldRenderer(renderer: Pick<THREE.WebGLRenderer, 'shadowMap' | 'toneMapping' | 'toneMappingExposure'>): void {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1;
}

export function sizeWorldRenderer(renderer: THREE.WebGLRenderer, width: number, height: number): void {
  // `setPixelRatio` resizes the drawing buffer at the old size, so it runs only when the ratio changed.
  if (renderer.getPixelRatio() !== window.devicePixelRatio) renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(width, height, false);
}

/**
 * Calls `onChange` whenever the window is resized or `devicePixelRatio` changes. A window moved to a
 * display with another scale fires no `resize`, so a media query for the current ratio is watched as
 * well. That query only notices leaving its own ratio, so each change re-arms the watch with a query
 * for the new one.
 */
export function watchViewport(onChange: () => void): void {
  window.addEventListener('resize', onChange);
  watchPixelRatio(onChange);
}

function watchPixelRatio(onChange: () => void): void {
  window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
    'change',
    () => {
      onChange();
      watchPixelRatio(onChange);
    },
    { once: true },
  );
}

/**
 * Enrols a subtree in shadow casting.
 *
 * Called per added subtree rather than once over the scene, because models resolve asynchronously
 * — a single sweep after load would miss every clone the prewarm has not produced yet, and those
 * are exactly the props whose missing shadows read as floating.
 */
function enableShadows(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (!(object as THREE.Mesh).isMesh) return;
    object.castShadow = true;
    object.receiveShadow = true;
  });
}

/**
 * Three.js implementation of the render surface.
 *
 * Real 3D depth: placements and entities sit on the floor at their world XZ and the depth buffer
 * gives draw order for free — no painter's algorithm and no Y-flip.
 *
 * The scene draws whatever sectors it is given. The client hands them over through `enterSpace`
 * and its draw set; a consumer with no connection calls `addSector` and `removeSector` itself.
 */
export class WorldScene implements WorldRenderSurface {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  /** Whether the pointer is a finger, under which a body is picked by a wider capsule. */
  coarsePointer = false;

  private readonly assets: ModelAssets;
  private readonly registry: ModelRegistry;
  private readonly now: () => number;
  private readonly sun = new THREE.DirectionalLight(0xffffff, 1);
  /** The sky above and the ground's bounce below, so no side of anything drops to black. */
  private readonly fill = new THREE.HemisphereLight(0xffffff, 0xffffff, 1);
  /**
   * The pools of a room's flames: a fixed set, so the scene's light count, and with it every shader
   * program, never changes from room to room. The ones without a flame to light stand at 0.
   */
  private readonly propLights = Array.from(
    { length: PROP_LIGHT_POOL_SIZE },
    () => new THREE.PointLight(PROP_LIGHT_COLOR, 0, PROP_LIGHT_DISTANCE, PROP_LIGHT_DECAY),
  );
  /** The light falling in through a room's door, by the clock. */
  private readonly doorSpill = new THREE.SpotLight(0xffffff, 0, DOOR_SPILL.distance, DOOR_SPILL.angle, DOOR_SPILL.penumbra, DOOR_SPILL.decay);
  /**
   * Every halo is drawn with this one material, made with the first, and never freed: leaving a room
   * releases no program that the next one compiles again.
   */
  private haloMaterial: THREE.SpriteMaterial | undefined;
  /** The flames the pool lights, which during a held swap are still the outgoing space's. */
  private litEmitters: Emitter[] = [];
  /** Whether the space on screen has a door its light falls in through. */
  private litDoor = false;
  /** Holds the flames steady. */
  private readonly reducedMotion: boolean;
  /** Retained so `repositionSun` can re-anchor the light without recomputing the day/night state. */
  private readonly sunDirection = new THREE.Vector3(0, 1, 0);
  /** Holds every sector group and entity of the space on screen. */
  private spaceRoot = new THREE.Object3D();
  /** The outgoing space, parked on screen during a held swap. */
  private previousRoot: THREE.Object3D | undefined;
  private pendingPlayerReveal = false;
  private readonly sectors = new Map<string, DrawnSector>();
  private readonly grounds = new Map<string, DrawnGround>();
  /** Sectors whose ground may no longer match its inputs: added, changed, or beside one that was. */
  private readonly dirtyGrounds = new Set<string>();
  private readonly groundRasterizer: GroundRasterizer;
  /** Counts spaces, so a field asked for in the space before is dropped. */
  private groundGeneration = 0;
  /** Sectors whose scatter may no longer match what it was placed from. */
  private readonly scatterDue = new Set<string>();
  private readonly grass = new GrassSpring();
  private readonly bending = new Map<GrassBatch, THREE.InstancedBufferAttribute[]>();
  /** One bending copy of each prototype material grass is drawn with, shared by every batch and never freed. */
  private readonly bendingMaterials = new Map<THREE.Material, THREE.Material>();
  /** By base, how a hand's model and a ground model reach into grass, measured once each; `undefined` for a model with no mesh. */
  private readonly heldReaches = new Map<string, GrassReach | undefined>();
  private readonly lyingReaches = new Map<string, GrassReach | undefined>();
  /** The clock the wind sways the grass by. */
  private readonly wind = { value: 0 };
  private readonly entityStates = new Map<string, EntityRenderState>();
  /** The bodies of minions crumbling out of the scene: `from` is the node's height as it began, `depth` how far it sinks. */
  private crumbling: { node: THREE.Object3D; mixer: THREE.AnimationMixer | undefined; from: number; depth: number; startedAt: number }[] = [];
  private readonly bubbles = new Map<string, SpeechBubble>();
  /** The bubbles as last laid out. */
  private placed: PlacedBubble[] = [];
  /** Where each fallen dreamer the player senses lies. */
  private sensed: readonly SensedBearingMessage[] = [];
  /** The markers as last laid out, toward those of them off screen. */
  private markers: PlacedMarker[] = [];
  /** The outgoing space's bubbles, kept on screen with it during a held swap. */
  private heldBubbles: PlacedBubbles | undefined;
  private screenOccluders: readonly ScreenRect[] = [];
  /** The player's own bubble, carried through a door to be hung over them again in the space they enter. */
  private carriedBubble: Pick<SpeechBubble, 'request' | 'expiresAtMs'> | undefined;
  /** The ring round the player's target, as its mark says. Its id is the target whose plaque shows through the world. */
  private selection: { id: string; mesh: THREE.Mesh; mark: TargetMark } | undefined;
  /**
   * The rings presses dropped, the one held last and those still lifting away. They hang on the
   * scene rather than the space root, so a press held through a door keeps its ring.
   */
  private pressMarkers: PressMarker[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private ground: (() => SpaceCollision) | undefined;
  /** The world clock as last told, and when; `undefined` holds the light at noon. */
  private clock: WorldClockReading | undefined;
  /** The floor of the room being built, which a voice from its door is shown just beyond; `undefined` outdoors. */
  private room: Rect | undefined;
  /** The interior light level of the space being built; `undefined` outdoors. */
  private spaceBrightness: number | undefined;
  /** The level lighting what is on screen, which during a held swap is still the outgoing space's. */
  private litBrightness: number | undefined;
  private sceneClock = 0;
  private cameraFollowId: string | undefined;
  private focus = new THREE.Vector3();
  /** Scratch for `repositionSun`, which runs once a frame behind the camera follow. */
  private readonly shadowAnchor = new THREE.Vector3();
  private readonly shadowBasis = new THREE.Matrix4();
  private readonly shadowOrientation = new THREE.Quaternion();
  private readonly shadowOrientationInverse = new THREE.Quaternion();
  private zoomFactor = 1;
  /** The scale a splash shot is framed at, which outranks the zoom until the player lands. */
  private shotScale: number | undefined;
  private aspect = 1;
  /** The viewport's height in CSS pixels, once the host has told it. */
  private viewportHeight: number | undefined;
  /** How many times its size in metres the overlay art is drawn: the plaques, the miss marks, and the bubbles. */
  private overlayScale = 1;
  /** The entity whose body each portrait of the HUD shows. */
  private readonly portraitSubjects: Record<PortraitSlot, string | undefined> = { own: undefined, target: undefined, body: undefined };
  private portraitPass: PortraitPass | undefined;
  private readonly effects: CombatEffects;
  /** The drops lying on the ground for the player. They hang on the scene and go with each new space. */
  private readonly loot: LootMarkers;
  private readonly auras: EliteAuras;
  private readonly questMarkers: QuestMarkers;
  /** The mark each carrier of a quest shows the player, an NPC or a fixture by its carrier id, as the session last said. */
  private questMarkerOf: ReadonlyMap<string, QuestMarker> = new Map();
  /** Scratch for measuring a fixture's model as drawn. */
  private readonly fixtureBounds = new THREE.Box3();
  /** Where the screen shake puts the camera off where the rig placed it. */
  private readonly shake = new THREE.Vector3();

  constructor(
    assets: ModelAssets,
    registry: ModelRegistry,
    aspect: number,
    reducedMotion: boolean,
    now: () => number = () => performance.now(),
    groundRasterizer: GroundRasterizer = defaultGroundRasterizer(),
  ) {
    this.assets = assets;
    this.registry = registry;
    this.reducedMotion = reducedMotion;
    this.now = now;
    this.groundRasterizer = groundRasterizer;
    this.aspect = aspect;
    const bounds = frustumBounds(ORTHO_RIG.defaultScale, aspect);
    this.camera = new THREE.OrthographicCamera(bounds.left, bounds.right, bounds.top, bounds.bottom, ORTHO_RIG.nearClip, ORTHO_RIG.farClip);
    this.configureSunShadow();
    this.configureDoorSpill();
    this.loot = new LootMarkers(
      OVERLAY_ORIENTATION,
      (baseId) => {
        const model = this.assets.ground(baseId);
        if (model !== undefined) enableShadows(model);
        return model;
      },
      () => (this.cameraFollowId === undefined ? undefined : this.entityStates.get(this.cameraFollowId)?.position),
      reducedMotion,
    );
    this.auras = new EliteAuras(reducedMotion);
    this.questMarkers = new QuestMarkers(OVERLAY_ORIENTATION);
    this.effects = new CombatEffects(
      {
        body: (entityId) => this.entityStates.get(entityId),
        bodies: () => this.entityStates,
        playerId: () => this.cameraFollowId,
        playOneShot: (entityId, oneShot, landsIn) => {
          const state = this.entityStates.get(entityId);
          return state === undefined ? undefined : this.playOneShot(state, oneShot, landsIn);
        },
        endOneShot: (entityId) => {
          const state = this.entityStates.get(entityId);
          if (state?.oneShot !== undefined && !state.oneShot.held) this.endOneShot(state);
        },
        missWord,
        overlayScale: () => this.overlayScale,
        now: () => this.now(),
      },
      reducedMotion,
    );
    // The target's world matrix is what gives a directional or a spot light its direction, and an
    // object outside the graph never gets one updated.
    this.scene.add(
      this.sun,
      this.sun.target,
      this.fill,
      ...this.propLights,
      this.doorSpill,
      this.doorSpill.target,
      this.effects.root,
      this.loot.root,
      this.spaceRoot,
    );
    // The portraits draw under the world's own lights, so their light count and programs are the world's.
    for (const light of [this.sun, this.fill, ...this.propLights, this.doorSpill]) {
      for (const slot of PORTRAIT_SLOTS) light.layers.enable(PORTRAIT_LAYERS[slot]);
    }
    // What shows past the world's edge, tinted with the light by `relight`.
    this.scene.background = new THREE.Color();
    this.relight();
    this.focusCamera(new THREE.Vector3());
  }

  /**
   * Recomputes the frustum on resize holding the **vertical world extent constant**, letting
   * aspect drive width.
   *
   * This is a gameplay contract, not a rendering detail: every window size must show the same
   * vertical slice of world, so a bigger window magnifies rather than reveals. Tying the frustum
   * to pixel height or `devicePixelRatio` silently hands large-window players more visible world.
   * The height is used only to keep the overlay art at its smallest readable size (`overlayMagnification`).
   */
  setViewportSize(width: number, height: number): void {
    this.aspect = width / height;
    this.viewportHeight = height;
    this.applyFraming();
  }

  applyZoomFactor(factor: number): void {
    this.zoomFactor = factor;
    this.applyFraming();
  }

  /** Frames a shot with no player to follow: the camera looks at `focus` on the ground at `scale`, whatever the zoom. */
  frameShot(focus: Point, scale: number): void {
    this.shotScale = clampedScale(scale);
    this.applyFraming();
    this.focusCamera(new THREE.Vector3(focus.x, 0, focus.z));
  }

  private applyFraming(): void {
    const scale = this.shotScale ?? scaleForZoomFactor(this.zoomFactor);
    applyFrustum(this.camera, scale, this.aspect);
    this.overlayScale = this.viewportHeight === undefined ? 1 : overlayMagnification(scale, this.viewportHeight);
    for (const state of this.entityStates.values()) state.namePlaque?.scale.setScalar(this.overlayScale);
    this.loot.setOverlayScale(this.overlayScale);
    this.questMarkers.setOverlayScale(this.overlayScale);
  }

  /**
   * Warms the cache, then re-resolves everything still rendering a placeholder. Given the renderer,
   * it meanwhile compiles every combat effect's program, a drop's, an elite's aura's, and a quest
   * mark's, which a first use would compile mid-fight.
   */
  async prewarm(renderer?: Pick<THREE.WebGLRenderer, 'compileAsync'>): Promise<void> {
    await Promise.all([
      this.assets.prewarm(),
      renderer === undefined ? undefined : this.effects.compile(renderer, this.camera, this.scene),
      renderer === undefined ? undefined : this.loot.compile(renderer, this.camera, this.scene),
      renderer === undefined ? undefined : this.auras.compile(renderer, this.camera, this.scene),
      renderer === undefined ? undefined : this.questMarkers.compile(renderer, this.camera, this.scene),
    ]);
    this.refreshResolvedModels();
  }

  /**
   * The outgoing space is **held on screen** and the incoming one is built hidden, until
   * `placeEntity` places the local player and swaps atomically. Without the hold, a door shows a
   * frame of the new space with no character in it — brief, but exactly the kind of flash that
   * reads as a glitch.
   */
  enterSpace(world: ClientWorld): void {
    this.startSpace(true);
    this.ground = () => world.collision;
  }

  private startSpace(hold: boolean): void {
    const own = this.cameraFollowId === undefined ? undefined : this.bubbles.get(this.cameraFollowId);
    this.carriedBubble = hold && own !== undefined ? { request: own.request, expiresAtMs: own.expiresAtMs } : undefined;
    this.heldBubbles = hold ? this.placedBubbles() : undefined;
    disposeSubtree(this.previousRoot);
    if (hold) {
      this.previousRoot = this.spaceRoot;
    } else {
      disposeSubtree(this.spaceRoot);
      this.previousRoot = undefined;
      this.litBrightness = undefined;
    }
    this.sectors.clear();
    // The ground meshes go with the space root they hang in, as everything else of the space does.
    this.grounds.clear();
    this.dirtyGrounds.clear();
    this.groundGeneration += 1;
    this.scatterDue.clear();
    this.grass.clear();
    this.bending.clear();
    this.entityStates.clear();
    this.crumbling = [];
    this.bubbles.clear();
    this.placed = [];
    this.sensed = [];
    this.markers = [];
    this.effects.clear();
    this.loot.clear();
    this.auras.clear();
    this.questMarkers.clear();
    this.selection = undefined;
    this.cameraFollowId = undefined;
    this.spaceBrightness = undefined;
    this.room = undefined;
    this.spaceRoot = new THREE.Object3D();
    this.spaceRoot.visible = !hold;
    this.scene.add(this.spaceRoot);
    this.pendingPlayerReveal = hold;
    // The lights hang on the scene rather than the space root, so they outlive the space and are
    // given to the new one here. A held space keeps the old one's light until the reveal.
    if (!hold) this.lightDrawnSpace();
  }

  /**
   * Atomic swap once the local player lands: drop the held space and show the new one. The ground
   * under the player is painted first, here and now, so the space never appears on a flat floor.
   */
  private revealHeldSpaceIfPending(at: Point): void {
    if (!this.pendingPlayerReveal) return;
    this.paintGroundNow(at);
    disposeSubtree(this.previousRoot);
    this.previousRoot = undefined;
    this.heldBubbles = undefined;
    this.spaceRoot.visible = true;
    this.pendingPlayerReveal = false;
    // Here rather than at `enterSpace`, which would rescale the splash still on screen until now.
    this.shotScale = undefined;
    this.applyFraming();
    // Applied in the same frame the new space becomes visible, so the light change and the geometry
    // change land together rather than one flashing ahead of the other.
    this.litBrightness = this.spaceBrightness;
    this.lightDrawnSpace();
    this.relight();
  }

  /**
   * Draws a sector at its origin, replacing one already drawn under the same name. Its ground is
   * rasterized off the frame, and the ground drawn so far stays until the new one arrives.
   */
  addSector(sector: SectorView, outdoorDoorIds: readonly string[] = []): void {
    this.disposeSector(sector.name);
    const origin = sectorOrigin(sector);
    const group = new THREE.Object3D();
    group.position.set(origin.x, 0, origin.z);
    const placements = sector.placements.map((placement) => this.buildPlacement(placement, sector.kind));
    const emitters = placements.flatMap((placed) => placed.emitter ?? []);
    for (const [index, emitter] of emitters.entries()) emitter.phase = flamePhase(index, emitters.length);
    group.add(...placements.map((placed) => placed.node));
    const fixtures = sector.fixtures.flatMap((fixture): DrawnFixture[] => {
      const node = placements.find((placed) => placed.placement.id === fixture.placement)?.node;
      if (node === undefined) return [];
      const anchor = new THREE.Object3D();
      anchor.position.set(node.position.x, 0, node.position.z);
      group.add(anchor);
      return [{ carrierId: fixtureCarrierId(sector.name, fixture.id), node, anchor }];
    });
    this.spaceRoot.add(group);
    this.sectors.set(sector.name, { view: sector, outdoorDoorIds, group, placements, fixtures });
    for (const fixture of fixtures) this.questMarkers.show(fixture.carrierId, fixture.anchor, this.questMarkerOf.get(fixture.carrierId));
    if (!this.grounds.has(sector.name)) {
      const mesh = groundMesh(sector, { columns: 1, rows: 1 }, flatGroundWeights(sector));
      this.spaceRoot.add(mesh);
      this.grounds.set(sector.name, { mesh, key: undefined, field: undefined, pending: undefined, scatter: undefined });
    }
    this.markGroundDirty(sector.name);
    if (sector.kind === 'interior') this.room = sectorRect(sector);
    this.spaceBrightness = sector.brightness;
    // Held back while a space is parked on screen: lighting by the incoming interior now would
    // relight the still-visible outgoing space, which is the flash the hold exists to prevent.
    if (!this.pendingPlayerReveal) {
      this.litBrightness = sector.brightness;
      this.lightDrawnSpace();
      this.relight();
    }
  }

  removeSector(name: string): void {
    const touching = this.touchingSectors(name);
    this.disposeSector(name);
    this.sectors.delete(name);
    const ground = this.grounds.get(name);
    disposeSubtree(ground?.mesh);
    if (ground !== undefined) this.dropScatter(ground);
    this.grounds.delete(name);
    this.dirtyGrounds.delete(name);
    for (const neighbour of touching) this.dirtyGrounds.add(neighbour);
    if (!this.pendingPlayerReveal) this.lightDrawnSpace();
  }

  /** Whether every drawn sector's ground is painted for its current inputs and its scatter placed, so nothing drawn is still to change. */
  isSettled(): boolean {
    return (
      this.dirtyGrounds.size === 0 &&
      this.scatterDue.size === 0 &&
      [...this.grounds.values()].every((ground) => ground.field !== undefined && ground.pending === undefined)
    );
  }

  /** The sector's ground and the grounds of the drawn sectors touching it, whose border blend reads it. */
  private markGroundDirty(name: string): void {
    this.dirtyGrounds.add(name);
    for (const neighbour of this.touchingSectors(name)) this.dirtyGrounds.add(neighbour);
  }

  private touchingSectors(name: string): string[] {
    const views = [...this.sectors.values()].map((drawn) => drawn.view);
    if (views.find((view) => view.name === name)?.kind !== 'outdoor') return [];
    return neighbourSectors({ id: '', sectors: views.filter((view) => view.kind === 'outdoor') }, name).map((view) => view.name);
  }

  private groundInputs(sector: SectorView): GroundFieldInputs {
    return { sector, neighbours: this.touchingSectors(sector.name).map((name) => this.sectors.get(name)!.view) };
  }

  /** Asks for a field for every dirty sector whose ground no longer matches its inputs, the nearest the camera first. */
  private updateGrounds(): void {
    if (this.dirtyGrounds.size === 0) return;
    const names = [...this.dirtyGrounds].filter((name) => this.sectors.has(name)).sort((a, b) => this.distanceToSector(a) - this.distanceToSector(b));
    this.dirtyGrounds.clear();
    for (const name of names) {
      const ground = this.grounds.get(name)!;
      const inputs = this.groundInputs(this.sectors.get(name)!.view);
      const key = groundFieldKey(inputs);
      if (key === ground.key) {
        ground.pending = undefined;
        this.scatterDue.add(name);
        continue;
      }
      if (key === ground.pending) continue;
      ground.pending = key;
      const generation = this.groundGeneration;
      this.groundRasterizer.rasterize(inputs, (field) => {
        if (generation !== this.groundGeneration || this.grounds.get(name) !== ground || ground.pending !== key) return;
        this.installGround(name, ground, key, field);
      });
    }
  }

  /** Rasterizes the ground under `at` on the spot, when what is drawn there is not for its current inputs. */
  private paintGroundNow(at: Point): void {
    const views = [...this.sectors.values()].map((drawn) => drawn.view);
    const sector = sectorAt({ id: '', sectors: views }, at);
    const ground = sector === undefined ? undefined : this.grounds.get(sector.name);
    if (sector === undefined || ground === undefined) return;
    const inputs = this.groundInputs(sector);
    const key = groundFieldKey(inputs);
    if (key === ground.key) return;
    this.installGround(sector.name, ground, key, rasterizeGround(inputs));
  }

  private installGround(name: string, ground: DrawnGround, key: string, field: GroundField): void {
    const mesh = groundMesh(this.sectors.get(name)!.view, field.raster, field.weights);
    this.spaceRoot.add(mesh);
    disposeSubtree(ground.mesh);
    ground.mesh = mesh;
    ground.key = key;
    ground.field = field;
    ground.pending = undefined;
    this.scatterDue.add(name);
  }

  /**
   * Places the scatter of one sector that is due, the nearest the camera first. One a frame,
   * because a sector's scatter takes milliseconds, and a border crossing makes several due at once.
   */
  private growScatter(): void {
    const names = [...this.scatterDue].filter((name) => this.grounds.has(name));
    this.scatterDue.clear();
    if (names.length === 0) return;
    const nearest = names.reduce((best, name) => (this.distanceToSector(name) < this.distanceToSector(best) ? name : best));
    for (const name of names) if (name !== nearest) this.scatterDue.add(name);
    this.updateScatter(nearest, this.grounds.get(nearest)!);
  }

  private distanceToSector(name: string): number {
    return distanceToRect({ x: this.focus.x, z: this.focus.z }, sectorRect(this.sectors.get(name)!.view));
  }

  /**
   * Places the sector's scatter again when anything it was placed from changed: its field, or the
   * placements and doors of the sector and its touching neighbours, whose footprints and triggers it
   * keeps off. It waits for the field and for the scatter models to be cached.
   */
  private updateScatter(name: string, ground: DrawnGround): void {
    const field = ground.field;
    if (field === undefined) return;
    const sector = this.sectors.get(name)!.view;
    const neighbours = this.touchingSectors(name).map((neighbour) => this.sectors.get(neighbour)!.view);
    const key = JSON.stringify([ground.key, [sector, ...neighbours].map((each) => [each.name, sectorOrigin(each), each.placements, each.doors])]);
    if (key === ground.scatter?.key) return;
    const prototypes = new Map([...GRASS_MODEL_IDS, PEBBLE_MODEL_ID].map((id) => [id, this.assets.prototypeMeshes(id)] as const));
    if ([...prototypes.values()].some((meshes) => meshes === undefined)) return;
    const scatter = scatterSector({ sector, neighbours, field, registry: this.registry });
    const group = new THREE.Group();
    group.name = SCATTER_NAME;
    const batches: GrassBatch[] = [];
    for (const id of GRASS_MODEL_IDS) {
      const tufts = scatter.tufts.filter((tuft) => tuft.modelId === id);
      if (tufts.length === 0) continue;
      const footprint = objectModel(this.registry, id)?.footprint;
      const halfWidth = footprint === undefined ? 0.1 : Math.max(footprint.width, footprint.depth) / 2;
      batches.push(this.bend(this.instanced(group, prototypes.get(id)!, tufts, true), tufts, halfWidth));
    }
    if (scatter.pebbles.length > 0) this.instanced(group, prototypes.get(PEBBLE_MODEL_ID)!, scatter.pebbles, false);
    if (scatter.flowers.length > 0) batches.push(this.bend(this.flowers(group, scatter.flowers), scatter.flowers, FLOWER_HEAD_RADIUS));
    this.dropScatter(ground);
    this.spaceRoot.add(group);
    ground.scatter = { group, key, batches };
  }

  private dropScatter(ground: DrawnGround): void {
    if (ground.scatter === undefined) return;
    for (const batch of ground.scatter.batches) {
      this.grass.remove(batch);
      this.bending.delete(batch);
    }
    disposeSubtree(ground.scatter.group);
    ground.scatter = undefined;
  }

  /**
   * One instanced mesh per mesh of the model, each over its own clone of the prototype's geometry
   * with the mesh's place in the model baked in, so instances stand as a placed model does.
   */
  private instanced(group: THREE.Group, meshes: readonly PrototypeMesh[], items: readonly ScatterTuft[], bending: boolean): THREE.InstancedMesh[] {
    const matrix = new THREE.Matrix4();
    const rotation = new THREE.Quaternion();
    return meshes.map((prototype) => {
      const geometry = prototype.geometry.clone().applyMatrix4(prototype.matrix);
      const mesh = new THREE.InstancedMesh(geometry, bending ? this.bendingMaterial(prototype.material) : prototype.material, items.length);
      items.forEach((item, index) => {
        rotation.setFromAxisAngle(UP, THREE.MathUtils.degToRad(item.yaw));
        mesh.setMatrixAt(index, matrix.compose(new THREE.Vector3(item.x, 0, item.z), rotation, UNIT_SCALE));
      });
      return addScatterMesh(group, mesh);
    });
  }

  /** Flower clusters: a coloured head on a stem each. */
  private flowers(group: THREE.Group, flowers: readonly { x: number; z: number; colour: number; height: number }[]): THREE.InstancedMesh[] {
    const matrix = new THREE.Matrix4();
    const colour = new THREE.Color();
    const head = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(FLOWER_HEAD_RADIUS, 0), this.bendingMaterial(FLOWER_HEAD_MATERIAL), flowers.length);
    const stem = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.005, 0.005, 0.1, 4).translate(0, 0.05, 0),
      this.bendingMaterial(FLOWER_STEM_MATERIAL),
      flowers.length,
    );
    flowers.forEach((flower, index) => {
      head.setMatrixAt(index, matrix.makeTranslation(flower.x, flower.height, flower.z));
      head.setColorAt(index, colour.setHex(flower.colour));
      stem.setMatrixAt(index, matrix.makeScale(1, flower.height / 0.1, 1).setPosition(flower.x, 0, flower.z));
    });
    return [addScatterMesh(group, head), addScatterMesh(group, stem)];
  }

  /**
   * Bends the meshes' instances as one batch, rooted at the items: each mesh carries its own tilt
   * attribute over the batch's tilts, which the grass spring moves.
   */
  private bend(meshes: readonly THREE.InstancedMesh[], items: readonly Point[], halfWidth: number): GrassBatch {
    const tilts = new Float32Array(items.length * 2);
    const attributes = meshes.map((mesh) => {
      const attribute = new THREE.InstancedBufferAttribute(tilts, 2);
      attribute.setUsage(THREE.DynamicDrawUsage);
      mesh.geometry.setAttribute('aTilt', attribute);
      return attribute;
    });
    const batch = { roots: new Float32Array(items.flatMap((item) => [item.x, item.z])), halfWidths: new Float32Array(items.length).fill(halfWidth), tilts };
    this.grass.add(batch);
    this.bending.set(batch, attributes);
    return batch;
  }

  /**
   * A copy of the material whose vertex stage tilts each instance about its root by its `aTilt`
   * and a light wind, so a blade keeps its length as it leans.
   */
  private bendingMaterial(source: THREE.Material): THREE.Material {
    let bending = this.bendingMaterials.get(source);
    if (bending !== undefined) return bending;
    bending = source.clone();
    const wind = this.wind;
    bending.onBeforeCompile = (shader) => {
      shader.uniforms['uWindTime'] = wind;
      shader.vertexShader = `attribute vec2 aTilt;\nuniform float uWindTime;\n${shader.vertexShader.replace('#include <project_vertex>', BEND_VERTEX)}`;
    };
    bending.customProgramCacheKey = () => `${SCATTER_NAME}-${source.type}`;
    this.bendingMaterials.set(source, bending);
    return bending;
  }

  /**
   * The grass each body brushes this frame, with its legs and what its hands hold, and the grass
   * each drop lying in it presses flat, leaning and springing back.
   */
  private bendGrass(dt: number): void {
    this.wind.value = this.sceneClock;
    if (this.bending.size === 0) return;
    const contacts: GrassContact[] = [];
    const at = new THREE.Vector3();
    for (const state of this.entityStates.values()) {
      if (state.grassBones.length === 0) continue;
      state.node.updateMatrixWorld(true);
      for (const { bone, foot } of state.grassBones) {
        at.setFromMatrixPosition(bone.matrixWorld);
        if (foot && at.y - state.node.position.y > GRASS_FOOT_CONTACT_HEIGHT) continue;
        contacts.push({ x: at.x, z: at.z, radius: foot ? GRASS_FOOT_RADIUS : GRASS_LEG_RADIUS });
      }
      for (const hand of HANDS) {
        const prop = state.heldProps[hand];
        const baseId = state.held?.[hand];
        if (prop === undefined || baseId === undefined) continue;
        const contact = grassContact(prop, measuredReach(this.heldReaches, baseId, prop));
        if (contact !== undefined) contacts.push(contact);
      }
    }
    for (const { baseId, model } of this.loot.lying()) {
      model.updateWorldMatrix(true, false);
      const contact = grassContact(model, measuredReach(this.lyingReaches, baseId, model), FLAT_TILT, IMPACT_PRESS_RATE);
      if (contact !== undefined) contacts.push(contact);
    }
    for (const batch of this.grass.step(contacts, dt)) {
      for (const attribute of this.bending.get(batch) ?? []) attribute.needsUpdate = true;
    }
  }

  placeEntity(entity: ClientEntity): void {
    let state = this.entityStates.get(entity.id);
    if (state === undefined) {
      const node = new THREE.Object3D();
      const jolt = new THREE.Object3D();
      const modelHolder = new THREE.Object3D();
      node.add(jolt);
      jolt.add(modelHolder);
      this.spaceRoot.add(node);
      state = {
        node,
        jolt,
        modelHolder,
        mixer: undefined,
        action: undefined,
        kind: entity.kind,
        characterModelId: entity.characterModelId,
        name: entity.name,
        trait: entity.trait,
        radius: entity.radius,
        facing: entity.facing,
        gait: entity.gait,
        position: entity.position,
        travelHeading: undefined,
        currentYaw: headingRadians(entity.facing),
        lastMotionTime: Number.NEGATIVE_INFINITY,
        pendingMotion: false,
        isPlaceholder: true,
        headHeight: 0,
        headBone: undefined,
        grassBones: [],
        headBoneRest: 0,
        namePlaque: undefined,
        namePlaquePlate: undefined,
        pose: undefined,
        condition: entity.condition,
        oneShot: undefined,
        fallsAt: undefined,
        held: entity.held,
        heldProps: {},
      };
      this.entityStates.set(entity.id, state);
      this.resolveEntityModel(state);
      this.refreshPortraitLayers(entity.id, state);
    }
    // Captured before the branch below overwrites `state.kind`, because the plaque needs the *old*
    // kind to know it changed; reading `state.kind` after the assignment can only ever compare a
    // value to itself.
    const kindChanged = state.kind !== entity.kind;
    if (kindChanged || state.characterModelId !== entity.characterModelId) {
      state.kind = entity.kind;
      state.characterModelId = entity.characterModelId;
      state.radius = entity.radius;
      this.resolveEntityModel(state);
      this.refreshPortraitLayers(entity.id, state);
    }
    // Rebuilt on a kind, name, or trait change, because each picks the plaque's fill or its text.
    if (state.namePlaque === undefined || kindChanged || state.name !== entity.name || state.trait !== entity.trait) {
      state.name = entity.name;
      state.trait = entity.trait;
      this.rebuildNamePlaque(state, this.isTarget(entity.id));
    }
    this.auras.show(entity.id, state.jolt, entity.radius, entity.trait);
    this.questMarkers.show(entity.id, state.node, this.questMarkerOf.get(entity.id));
    if (state.condition !== entity.condition) this.updateCondition(entity.id, entity.condition);
    if (!sameHeld(state.held, entity.held)) this.updateHeld(entity.id, entity.held);

    state.facing = entity.facing;
    state.gait = entity.gait;
    if (entity.position.x !== state.position.x || entity.position.z !== state.position.z) {
      state.pendingMotion = true;
      state.position = entity.position;
    }
    // A placement stands at its ground height at once; only later steps are eased.
    state.node.position.set(entity.position.x, this.groundHeight(entity.position), entity.position.z);
    state.modelHolder.rotation.y = state.currentYaw;

    if (entity.kind === 'player') {
      this.cameraFollowId = entity.id;
      this.focusCamera(state.node.position);
      this.revealHeldSpaceIfPending(entity.position);
      this.hangCarriedBubble(entity);
    }
  }

  updatePosition(entityId: string, position: Point, facing: Heading, travel: Heading | undefined): void {
    const state = this.entityStates.get(entityId);
    if (state === undefined) return;
    if (position.x !== state.position.x || position.z !== state.position.z) {
      state.pendingMotion = true;
      state.position = position;
    }
    state.facing = facing;
    // Only overwrite on a real travel step: a stationary tick passes `undefined` so the last
    // direction persists across the grace window and the clip does not drop mid-glide.
    if (travel !== undefined) state.travelHeading = travel;
    state.node.position.x = position.x;
    state.node.position.z = position.z;
    if (entityId === this.cameraFollowId) this.focusCamera(state.node.position);
  }

  updateGait(entityId: string, gait: Gait): void {
    const state = this.entityStates.get(entityId);
    if (state !== undefined) state.gait = gait;
  }

  /**
   * The plaque takes the condition's tint, and a fallen entity drops and stays down until it stands
   * again. The server sends the blow that fells a body before its fall, so the body drops as the last
   * hit on its way to it lands (`CombatEffects.hitsLandIn`), as a nightmare's drops burst out
   * (`burstIn`), and at once with none on its way or under reduced motion.
   */
  updateCondition(entityId: string, condition: Condition): void {
    const state = this.entityStates.get(entityId);
    if (state === undefined) return;
    state.condition = condition;
    this.rebuildNamePlaque(state, this.isTarget(entityId));
    if (condition === 'fallen') {
      const landsIn = this.reducedMotion ? 0 : this.effects.hitsLandIn(entityId);
      if (landsIn > 0) state.fallsAt = this.sceneClock + landsIn;
      else this.playOneShot(state, 'fallen');
    } else {
      state.fallsAt = undefined;
      if (state.oneShot?.held === true) this.endOneShot(state);
    }
  }

  /** Hangs what the hands hold on their bones, and puts it on the portraits that show its holder, as a model put in afresh is. */
  updateHeld(entityId: string, held: Held | undefined): void {
    const state = this.entityStates.get(entityId);
    if (state === undefined || sameHeld(state.held, held)) return;
    state.held = held;
    this.hangHeldProps(state);
    this.refreshPortraitLayers(entityId, state);
  }

  showBlow(attackerId: string, targetId: string, hit: boolean): void {
    this.effects.blow(attackerId, targetId, hit);
  }

  showAbility(entityId: string, abilityId: AbilityId, targetId: string | undefined, shown?: AbilityShown): void {
    this.effects.ability(entityId, abilityId, targetId, shown);
  }

  showEffects(entityId: string, effects: readonly { effectId: EffectId; seconds?: number }[]): void {
    this.effects.hold(entityId, effects);
  }

  showRaising(targetId: string, raise: RaiseProgress | undefined): void {
    this.effects.raising(targetId, raise);
  }

  showMend(targetId: string): void {
    this.effects.mend(targetId);
  }

  showTelegraph(telegraph: TelegraphMessage): void {
    this.effects.telegraph(telegraph);
  }

  showSummoned(minionId: string, summonerId: string): void {
    this.effects.summon(minionId, summonerId);
  }

  showQuestMarkers(markers: ReadonlyMap<string, QuestMarker>): void {
    this.questMarkerOf = markers;
    for (const [entityId, state] of this.entityStates) this.questMarkers.show(entityId, state.node, markers.get(entityId));
    for (const fixture of this.drawnFixtures()) this.questMarkers.show(fixture.carrierId, fixture.anchor, markers.get(fixture.carrierId));
  }

  /** The mark over a carrier, an entity's head or a fixture's top, by its id, for a test or the debug surface. */
  questMarkerShown(carrierId: string): QuestMarker | undefined {
    return this.questMarkers.markerOf(carrierId);
  }

  showSensed(bearings: readonly SensedBearingMessage[]): void {
    this.sensed = bearings;
    this.layoutSpeechBubbles(0);
  }

  /**
   * A drop of a base or a trophy of a kind this build does not know is not drawn, so nothing can be
   * pressed for it. A trophy has no model, so its name alone is drawn, as plain. One shown as it
   * falls is thrown there. Under reduced motion or in a stalled tab it lies there at once, and a
   * hand it left empties with the `held` that follows.
   */
  showLoot({ lootId, x, z, contents, from }: LootMessage): void {
    const labelKey = contents.kind === 'item' ? itemLabelKey(contents.baseId) : trophyLabelKey(contents.monsterKind);
    if (labelKey === undefined) return;
    const item = contents.kind === 'item' ? contents : undefined;
    const thrown = from === undefined || this.effects.stalled(this.now()) ? undefined : this.throwFrom(from, item?.baseId);
    this.loot.show(
      { lootId, at: { x, z, height: this.groundHeight({ x, z }) }, baseId: item?.baseId, name: t(labelKey), rarity: item?.rarity ?? 'plain' },
      this.reducedMotion ? undefined : thrown,
    );
  }

  /**
   * How a drop leaves for where it falls: tossed from the hand of the dreamer who throws it, who
   * plays the throw cut short so it lets go within `THROW_WINDUP_SECONDS`, or bursting from the body
   * of the nightmare that stood there as the blow that drove it off lands (`burstIn`). An item that
   * leaves a hand drawn holding it is handed to the throw: it stays on the hand through the wind-up,
   * whatever the hands are shown holding meanwhile, and goes from it as the drop flies.
   */
  private throwFrom(from: ThrownFromMessage, baseId: string | undefined): LootThrow {
    const thrower = from.entityId === undefined ? undefined : this.entityStates.get(from.entityId);
    const clip = thrower === undefined ? undefined : this.playOneShot(thrower, 'throw', THROW_WINDUP_SECONDS);
    const hand = thrower?.modelHolder.getObjectByName(HAND_BONES[from.hand ?? 'mainHand']);
    const nightmare = from.entityId === undefined;
    const ground = new THREE.Vector3(from.x, this.groundHeight(from) + (nightmare ? BURST_FROM_HEIGHT : THROWN_FROM_HEIGHT), from.z);
    const prop =
      thrower === undefined || from.hand === undefined || baseId === undefined || this.reducedMotion ? undefined : this.handOver(thrower, from.hand, baseId);
    return {
      releaseIn: nightmare ? this.burstIn(from) : Math.min(strikeDelay(clip), THROW_WINDUP_SECONDS),
      from: () => hand?.getWorldPosition(new THREE.Vector3()) ?? ground,
      ...(prop === undefined ? {} : { prop }),
      arc: nightmare ? BURST_ARC : THROW_ARC,
    };
  }

  /**
   * Seconds until a nightmare's drops burst out: as the last blow on its way to the fallen nightmare
   * drawn nearest where it stood lands, so every drop it leaves pops out together as the killing blow
   * strikes. The server sends the nightmare's fall before its drops, so it already lies fallen. With
   * no blow on its way, as when a Dream-bolt drove it off, they burst at once.
   */
  private burstIn(from: Point): number {
    let nearest: { id: string; away: number } | undefined;
    for (const [id, state] of this.entityStates) {
      if (state.kind !== 'monster' || state.condition !== 'fallen') continue;
      const away = distance(state.position, from);
      if (nearest === undefined || away < nearest.away) nearest = { id, away };
    }
    return nearest === undefined ? 0 : this.effects.hitsLandIn(nearest.id);
  }

  /** Takes the model a hand holds of the base from what the hands hold, for a throw to let go of: `undefined` when the hand draws none of it. */
  private handOver(state: EntityRenderState, hand: Hand, baseId: string): THREE.Object3D | undefined {
    const prop = state.held?.[hand] === baseId ? state.heldProps[hand] : undefined;
    if (prop !== undefined) delete state.heldProps[hand];
    return prop;
  }

  removeLoot(lootId: string): void {
    this.loot.remove(lootId);
  }

  /** A hale nightmare has a plaque only while it is the target, so the plaques of the old target and the new are rebuilt. */
  showSelection(entityId: string | undefined, mark: TargetMark): void {
    const shown = this.selection?.mark;
    if (entityId !== undefined && this.selection?.id === entityId && shown?.locked === mark.locked && shown.acting === mark.acting) return;
    const previous = this.selection === undefined ? undefined : this.entityStates.get(this.selection.id);
    disposeSubtree(this.selection?.mesh);
    this.selection = undefined;
    const state = entityId === undefined ? undefined : this.entityStates.get(entityId);
    if (entityId !== undefined && state !== undefined) {
      const innerRadius = state.radius * SELECTION_RING_RADII;
      const color = mark.acting ? ACTING_RING_COLOR : SELECTION_RING_COLOR;
      const mesh = mark.locked ? lockReticleMesh(innerRadius, color) : groundRingMesh(innerRadius, color);
      state.node.add(mesh);
      this.selection = { id: entityId, mesh, mark: { ...mark } };
    }
    if (previous === state) return;
    for (const changed of new Set([previous, state])) {
      if (changed?.kind === 'monster' && changed.condition === 'hale') this.rebuildNamePlaque(changed, changed === state);
    }
  }

  showPressMarker(point: Point): void {
    const at = { ...point, height: this.groundHeight(point) };
    const held = this.pressMarkers.at(-1);
    if (held !== undefined && held.liftsAtMs === undefined) {
      held.at = at;
      this.posePressMarker(held, this.now());
      return;
    }
    const marker: PressMarker = { mesh: groundRingMesh(PRESS_MARKER_RADIUS, SELECTION_RING_COLOR), at, droppedAtMs: this.now(), liftsAtMs: undefined };
    this.scene.add(marker.mesh);
    this.pressMarkers.push(marker);
    this.posePressMarker(marker, marker.droppedAtMs);
  }

  /** A ring let go before it has landed lands first, so a tap shows it come down and go up again. */
  liftPressMarker(): void {
    const held = this.pressMarkers.at(-1);
    if (held === undefined || held.liftsAtMs !== undefined) return;
    held.liftsAtMs = Math.max(this.now(), held.droppedAtMs + PRESS_MARKER_SECONDS * 1000);
    this.posePressMarker(held, this.now());
  }

  /** Where a ring is and how strongly it shows at `nowMs`; `false` once it has lifted away. Under reduced motion it only fades. */
  private posePressMarker(marker: PressMarker, nowMs: number): boolean {
    const duration = PRESS_MARKER_SECONDS * 1000;
    const easeOut = (progress: number): number => 1 - (1 - clamp(progress, 0, 1)) ** 3;
    let down = easeOut((nowMs - marker.droppedAtMs) / duration);
    if (marker.liftsAtMs !== undefined) {
      if (nowMs - marker.liftsAtMs >= duration) return false;
      down = Math.min(down, easeOut(1 - (nowMs - marker.liftsAtMs) / duration));
    }
    const rise = this.reducedMotion ? 0 : (1 - down) * PRESS_MARKER_DROP_METRES;
    marker.mesh.position.set(marker.at.x, marker.at.height + GROUND_RING_LIFT + rise, marker.at.z);
    (marker.mesh.material as THREE.MeshBasicMaterial).opacity = RING_OPACITY * down;
    return true;
  }

  private isTarget(entityId: string): boolean {
    return this.selection?.id === entityId;
  }

  /**
   * What a press at a point of the viewport, in normalized device coordinates, lands on: a drop's
   * name first, then another body, a drop's model, a fixture's model, and the ground. A body is
   * picked up to its feet, so it covers a drop's model under it, and the name under the model is
   * what a press reaches the drop by. The player's own body is no part of it: a press there lands on
   * what lies under it. `undefined` before a space is entered and over nothing.
   */
  pressTargetAt(x: number, y: number): PressTarget | undefined {
    const label = this.loot.labelAt(this.raycasterAt(x, y));
    if (label !== undefined) return { kind: 'loot', lootId: label };
    const entityId = this.entityAt(x, y);
    if (entityId !== undefined) return { kind: 'entity', entityId };
    const model = this.loot.modelAt(this.rayAt(x, y), this.coarsePointer ? COARSE_PICK_METRES : undefined);
    if (model !== undefined) return { kind: 'loot', lootId: model };
    const carrierId = this.fixtureAt(x, y);
    if (carrierId !== undefined) return { kind: 'fixture', carrierId };
    const ground = this.groundPointAt(x, y);
    return ground === undefined ? undefined : { kind: 'ground', point: { x: ground.x, z: ground.z } };
  }

  /**
   * The entity drawn under a point of the viewport, in normalized device coordinates, other than
   * the one the camera follows. An entity is picked as a capsule from its feet to its head as drawn,
   * by the radius its body is drawn with, wider under a finger, and the one nearest the camera wins.
   */
  entityAt(x: number, y: number): string | undefined {
    const ray = this.rayAt(x, y);
    const onRay = new THREE.Vector3();
    let picked: string | undefined;
    let nearest = Number.POSITIVE_INFINITY;
    for (const [id, state] of this.entityStates) {
      if (id === this.cameraFollowId) continue;
      const feet = state.node.position;
      const top = this.headPoint(state);
      const reach = this.coarsePointer ? Math.max(state.radius, COARSE_PICK_METRES) : state.radius;
      if (ray.distanceSqToSegment(feet, top, onRay) > reach * reach) continue;
      const along = onRay.distanceToSquared(ray.origin);
      if (along >= nearest) continue;
      picked = id;
      nearest = along;
    }
    return picked;
  }

  /**
   * The fixture whose model is drawn under a point of the viewport, in normalized device
   * coordinates, by its carrier id: the meshes of the placement that carries it, as they are drawn,
   * the one nearest the camera. A footprint would not do, since the camera looks down on a tall
   * model's face, which is drawn well beyond the ground it stands on.
   */
  fixtureAt(x: number, y: number): string | undefined {
    const raycaster = this.raycasterAt(x, y);
    let picked: string | undefined;
    let nearest = Number.POSITIVE_INFINITY;
    for (const fixture of this.drawnFixtures()) {
      const hit = raycaster.intersectObject(fixture.node, true)[0];
      if (hit === undefined || hit.distance >= nearest) continue;
      picked = fixture.carrierId;
      nearest = hit.distance;
    }
    return picked;
  }

  /**
   * The ground drawn under a point of the viewport, in normalized device coordinates, as a point of
   * the space and the height it lies at: the top of a walk surface where the ray meets one, else the
   * floor. `undefined` before a space is entered.
   */
  groundPointAt(x: number, y: number): { x: number; z: number; height: number } | undefined {
    if (this.ground === undefined) return undefined;
    return groundHit(this.ground(), this.rayAt(x, y));
  }

  /**
   * The point of the space under a point of the viewport at body height over the player's feet, which
   * the player aims at: a body is drawn above its feet, so the floor under the cursor would lie
   * beyond a body the cursor points at. `undefined` before a space is entered.
   */
  aimPointAt(x: number, y: number): Point | undefined {
    if (this.ground === undefined) return undefined;
    const feet = this.cameraFollowId === undefined ? undefined : this.entityStates.get(this.cameraFollowId)?.node.position.y;
    return pointOnRayAt(this.rayAt(x, y), (feet ?? 0) + AIM_HEIGHT);
  }

  /** The camera's ray through a point of the viewport, in normalized device coordinates. */
  private rayAt(x: number, y: number): THREE.Ray {
    return this.raycasterAt(x, y).ray;
  }

  private raycasterAt(x: number, y: number): THREE.Raycaster {
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(new THREE.Vector2(x, y), this.camera);
    return this.raycaster;
  }

  setClock(worldSeconds: number): void {
    this.clock = { worldSeconds, atMs: this.now() };
    this.relight();
  }

  showSpeechBubble(request: SpeechBubbleRequest): boolean {
    this.bubbles.delete(request.entityId);
    if (request.lines.length === 0 || request.lifetimeMs <= 0) return false;
    const frame = speechBubbleFrameSize(request.lines, request.kind);
    const bubble: SpeechBubble = {
      request,
      expiresAtMs: this.now() + request.lifetimeMs,
      size: { width: frame.width * OVERLAY_METRES_PER_PIXEL, height: frame.height * OVERLAY_METRES_PER_PIXEL },
      mode: undefined,
      spot: undefined,
      anchor: undefined,
      drawn: undefined,
    };
    this.bubbles.set(request.entityId, bubble);
    this.layoutSpeechBubbles(0);
    return bubble.mode === 'pinned';
  }

  /** What covers the screen over the world, such as the panels, as rects in normalized device coordinates. */
  setScreenOccluders(rects: readonly ScreenRect[]): void {
    this.screenOccluders = rects;
  }

  /** The markers toward the fallen dreamers the player senses who lie off screen, as laid out this frame. */
  placedMarkers(): PlacedMarkers {
    const ndc = this.ndcPerOverlayMetre();
    return { halfSize: { x: 1 / ndc.x, y: 1 / ndc.y }, markers: this.pendingPlayerReveal ? [] : this.markers };
  }

  /** The bubbles to paint over the world this frame, in the order they were placed. */
  placedBubbles(): PlacedBubbles {
    if (this.pendingPlayerReveal && this.heldBubbles !== undefined) return this.heldBubbles;
    const ndc = this.ndcPerOverlayMetre();
    return { halfSize: { x: 1 / ndc.x, y: 1 / ndc.y }, bubbles: this.placed };
  }

  /**
   * Places every bubble at once, so they keep apart. A speaker drawn with their head on screen has
   * the bubble round that head. A speaker with no body here is heard through a door or from out of
   * view. Outdoors the bubble hangs by the spot the voice comes from at doorway height, on the
   * building over a door. In a room it goes just past the wall toward it, in the dark around the
   * floor. A bubble whose head or doorway is off screen, or whose spot past the wall is off screen or
   * taken, is pinned on the line from the player toward the voice, as near the screen's edge as is free.
   * A marker toward each fallen dreamer the player senses whose spot is off screen is pinned the same
   * way, before every bubble, so the bubbles keep clear of the markers.
   */
  private layoutSpeechBubbles(dt: number): void {
    const nowMs = this.now();
    for (const [id, bubble] of this.bubbles) {
      if (nowMs >= bubble.expiresAtMs) this.bubbles.delete(id);
    }
    this.camera.updateMatrixWorld();
    const ndc = this.ndcPerOverlayMetre();
    const toScreen = (point: THREE.Vector3): ScreenPoint => {
      const projected = point.clone().project(this.camera);
      return { x: projected.x / ndc.x, y: projected.y / ndc.y };
    };
    const onScreen = (point: ScreenPoint) => Math.abs(point.x * ndc.x) <= 1 && Math.abs(point.y * ndc.y) <= 1;
    const heads = new Map<string, ScreenDisc>();
    for (const [id, state] of this.entityStates) {
      const head = this.headDisc(state);
      heads.set(id, { centre: toScreen(head.centre), radius: head.radius / this.overlayScale });
    }
    const entries = [...this.bubbles].map(([id, bubble]): BubbleEntry => {
      const head = heads.get(id);
      const base = { size: bubble.size, fixed: undefined, held: undefined };
      if (head !== undefined) {
        const held = bubble.anchor?.head === true ? bubble.spot : undefined;
        return { bubble, request: { ...base, anchor: head, voice: head.centre, held }, fromHead: true, wall: undefined };
      }
      const source = bubble.request.source;
      const voice = toScreen(new THREE.Vector3(source.x, this.groundHeight(source), source.z));
      if (this.room !== undefined) {
        const beyond = this.beyondWall(this.room, source, bubble.size, toScreen);
        return { bubble, request: { ...base, anchor: undefined, fixed: beyond?.centre, voice }, fromHead: false, wall: beyond?.wall };
      }
      const doorway = toScreen(new THREE.Vector3(source.x, this.groundHeight(source) + DOORWAY_VOICE_HEIGHT, source.z));
      return { bubble, request: { ...base, anchor: { centre: doorway, radius: 0 }, voice }, fromHead: false, wall: undefined };
    });
    // Voices with no head on screen first: where they go is fixed by where the voice is.
    const headShown = (entry: BubbleEntry) => entry.fromHead && onScreen(entry.request.anchor!.centre);
    entries.sort((first, second) => Number(headShown(first)) - Number(headShown(second)));
    const markerSize = this.markerSize(ndc);
    const fallen = this.sensed.flatMap((bearing) => {
      const voice = toScreen(new THREE.Vector3(bearing.x, this.groundHeight(bearing), bearing.z));
      return onScreen(voice) ? [] : [{ bearing, request: { size: markerSize, anchor: undefined, fixed: undefined, voice, held: undefined } }];
    });
    const placements = layoutBubbles({
      halfSize: { x: 1 / ndc.x, y: 1 / ndc.y },
      covered: this.screenOccluders.map((rect) => ({ left: rect.left / ndc.x, bottom: rect.bottom / ndc.y, right: rect.right / ndc.x, top: rect.top / ndc.y })),
      heads: [...heads.values()],
      player: toScreen(this.focus),
      bubbles: [...fallen.map((marker) => marker.request), ...entries.map((entry) => entry.request)],
    });
    this.markers = fallen.map(({ bearing, request }, index) => {
      const { centre } = placements[index]!;
      return { name: bearing.name, at: { x: bearing.x, z: bearing.z }, centre, toward: Math.atan2(request.voice.y - centre.y, request.voice.x - centre.x) };
    });
    placements.splice(0, fallen.length);
    const glide = 1 - Math.exp(-dt / BUBBLE_GLIDE_SECONDS);
    this.placed = entries.map(({ bubble, request, fromHead, wall }, index) => {
      const { centre, mode } = placements[index]!;
      const anchor = mode === 'anchored' ? request.anchor : undefined;
      if (bubble.drawn === undefined) {
        bubble.drawn = centre;
      } else {
        // Carried along with what it hangs from, so only a change of spot glides.
        const carried = anchor !== undefined && bubble.anchor?.head === fromHead ? bubble.anchor.at : undefined;
        const from =
          anchor === undefined || carried === undefined
            ? bubble.drawn
            : { x: bubble.drawn.x + anchor.centre.x - carried.x, y: bubble.drawn.y + anchor.centre.y - carried.y };
        bubble.drawn = { x: from.x + (centre.x - from.x) * glide, y: from.y + (centre.y - from.y) * glide };
      }
      bubble.mode = mode;
      bubble.anchor = anchor === undefined ? undefined : { at: anchor.centre, head: fromHead };
      bubble.spot = anchor !== undefined && fromHead ? { x: centre.x - anchor.centre.x, y: centre.y - anchor.centre.y } : undefined;
      const target = anchor !== undefined ? { anchor } : { toward: mode === 'fixed' && wall !== undefined ? wall : request.voice };
      return {
        centre: bubble.drawn,
        size: bubble.size,
        tail: tailTip(bubble.drawn, bubble.size, target),
        lines: bubble.request.lines,
        kind: bubble.request.kind,
        opacity: FAINTEST_BUBBLE_OPACITY + (1 - FAINTEST_BUBBLE_OPACITY) * bubble.request.clarity,
        mode,
      };
    });
  }

  /**
   * In a room, a voice from its door is shown in the dark just past the wall it comes through, on
   * the screen side that wall lies on: the spot for the bubble's middle, and the wall's edge its
   * tail points back to. `undefined` when the wall has no side on screen to lie on.
   */
  private beyondWall(
    room: Rect,
    source: Point,
    size: ScreenSize,
    toScreen: (point: THREE.Vector3) => ScreenPoint,
  ): { centre: ScreenPoint; wall: ScreenPoint } | undefined {
    const inside = closestOnRect(source, room);
    const walls = [
      { x: room.x, z: inside.z },
      { x: room.x + room.width, z: inside.z },
      { x: inside.x, z: room.z },
      { x: inside.x, z: room.z + room.depth },
    ];
    const gaps = walls.map((wall) => distance(wall, inside));
    const wall = walls[gaps.indexOf(Math.min(...gaps))]!;
    const middle = toScreen(new THREE.Vector3(room.x + room.width / 2, 0, room.z + room.depth / 2));
    const fromMiddle = (point: THREE.Vector3) => {
      const drawn = toScreen(point);
      return { x: drawn.x - middle.x, y: drawn.y - middle.y };
    };
    const foot = fromMiddle(new THREE.Vector3(wall.x, 0, wall.z));
    const length = Math.hypot(foot.x, foot.y);
    if (length === 0) return undefined;
    const out = { x: foot.x / length, y: foot.y / length };
    // The wall's foot or its top, whichever is drawn further out: the wall itself is not the dark.
    const top = fromMiddle(new THREE.Vector3(wall.x, ROOM_WALL_HEIGHT, wall.z));
    const edge = top.x * out.x + top.y * out.y > length ? top : foot;
    const clearance = BEYOND_WALL_GAP + (Math.abs(out.x) * size.width) / 2 + (Math.abs(out.y) * size.height) / 2;
    return {
      centre: { x: middle.x + edge.x + out.x * clearance, y: middle.y + edge.y + out.y * clearance },
      wall: { x: middle.x + edge.x, y: middle.y + edge.y },
    };
  }

  /** A marker's size in metres of overlay art, from its size on the page and the canvas's height. */
  private markerSize(ndc: { x: number; y: number }): ScreenSize {
    const metresPerPixel = this.viewportHeight === undefined ? OVERLAY_METRES_PER_PIXEL : 2 / ndc.y / this.viewportHeight;
    return { width: SENSED_MARKER_PIXELS.width * metresPerPixel, height: SENSED_MARKER_PIXELS.height * metresPerPixel };
  }

  /** How far a metre of overlay art reaches across the screen, in normalized device coordinates. The bubbles are laid out and painted in these metres. */
  private ndcPerOverlayMetre(): { x: number; y: number } {
    return { x: (2 * this.overlayScale) / (this.camera.right - this.camera.left), y: (2 * this.overlayScale) / (this.camera.top - this.camera.bottom) };
  }

  /**
   * The top of the head as drawn. Standing, it is `headHeight` over the feet. While a fall holds the
   * body down, it follows the head bone, raised by the part of `headHeight` above that bone. That
   * part shrinks in the proportion the bone has come down by, so the point starts where the standing
   * head is and never jumps.
   */
  private headPoint(state: EntityRenderState): THREE.Vector3 {
    const feet = state.node.position;
    const bone = state.headBone;
    if (state.oneShot?.held !== true || bone === undefined) return new THREE.Vector3(feet.x, feet.y + state.headHeight, feet.z);
    // The mixer sets only local transforms, so the bone's world matrix is stale until asked for.
    bone.updateWorldMatrix(true, false);
    const point = bone.getWorldPosition(new THREE.Vector3());
    const share = clamp((point.y - feet.y) / state.headBoneRest, 0, 1);
    return point.setY(point.y + (state.headHeight - state.headBoneRest) * share);
  }

  /** The head as a ball for the bubbles to keep clear of, hanging from the top of the head as drawn. */
  private headDisc(state: EntityRenderState): { centre: THREE.Vector3; radius: number } {
    const radius = (HEAD_SHARE * state.headHeight) / 2;
    const centre = this.headPoint(state);
    return { centre: centre.setY(centre.y - radius), radius };
  }

  /**
   * How far above its node an entity's model reaches. Measures the model only — the persistent
   * name plaque hanging off the node would otherwise stretch the bounds and push an overlay up.
   * The bounds are in world space, so the node's own height comes back off: overlays hang from
   * the node, which may stand on raised ground.
   */
  private measureHeadHeight(state: EntityRenderState): number {
    state.node.updateWorldMatrix(true, false);
    // `updateMatrixWorld`, because only there does a skinned mesh re-read where it is bound, which its bounds are skinned against.
    state.jolt.updateMatrixWorld(true);
    return Math.max(new THREE.Box3().setFromObject(state.modelHolder).max.y - state.node.position.y, 0);
  }

  removeEntity(entityId: string): void {
    disposeSubtree(this.forgetEntity(entityId)?.node);
  }

  /**
   * A minion whose boss's fight ended crumbles into grave light where it stands
   * (`CombatEffects.crumble`) and its body, its plaque taken off, sinks out of sight over
   * `CRUMBLE_SECONDS`, playing on as it goes, before it is gone. It is no entity of the scene
   * meanwhile, so nothing picks, marks, or names it. Under reduced motion it is gone at once, and in
   * a stalled tab on the next tick.
   */
  crumbleEntity(entityId: string): void {
    this.effects.crumble(entityId);
    const state = this.forgetEntity(entityId);
    if (state === undefined) return;
    if (this.reducedMotion) {
      disposeSubtree(state.node);
      return;
    }
    disposeSubtree(state.namePlaque);
    this.crumbling.push({ node: state.node, mixer: state.mixer, from: state.node.position.y, depth: state.headHeight, startedAt: this.sceneClock });
  }

  /** Drops what the scene holds of an entity but its body, and returns its state for the caller to dispose of or sink. */
  private forgetEntity(entityId: string): EntityRenderState | undefined {
    const state = this.entityStates.get(entityId);
    this.auras.forget(entityId);
    this.questMarkers.forget(entityId);
    this.entityStates.delete(entityId);
    this.bubbles.delete(entityId);
    this.effects.forget(entityId);
    if (this.selection?.id === entityId) this.selection = undefined;
    return state;
  }

  /** Sinks each crumbling body a step further, easing in, and lets it go once under or once the tab stalled. */
  private sinkCrumbling(dt: number, stalled: boolean): void {
    this.crumbling = this.crumbling.filter((body) => {
      const k = (this.sceneClock - body.startedAt) / CRUMBLE_SECONDS;
      if (stalled || k >= 1) {
        disposeSubtree(body.node);
        return false;
      }
      body.node.position.y = body.from - body.depth * k * k;
      body.mixer?.update(dt);
      return true;
    });
  }

  showSplash(): void {
    // Also drops any space parked for a swap the splash interrupts (a Leave Game mid-door).
    this.startSpace(false);
    for (const marker of this.pressMarkers) disposeSubtree(marker.mesh);
    this.pressMarkers = [];
    this.ground = undefined;
    this.relight();
    this.focusCamera(new THREE.Vector3());
  }

  /** What the player was saying as they went through a door goes on over their head for the rest of its time. */
  private hangCarriedBubble(player: ClientEntity): void {
    const carried = this.carriedBubble;
    if (carried?.request.entityId !== player.id) return;
    this.carriedBubble = undefined;
    this.showSpeechBubble({ ...carried.request, source: player.position, lifetimeMs: carried.expiresAtMs - this.now() });
  }

  private groundHeight(position: Point): number {
    return this.ground === undefined ? 0 : groundHeightAt(this.ground(), position);
  }

  /** Pure accumulation over per-entity state, so yaw and pose behaviour is testable directly. */
  tick(deltaTimeSeconds: number): void {
    const dt = Math.min(deltaTimeSeconds, MAX_TICK_DELTA);
    this.sceneClock += dt;
    this.relight();
    this.updatePropLights();
    const stalled = this.effects.stalled(this.now());

    for (const [id, state] of this.entityStates) {
      // The simulation's height is discrete, a tread at a time; the rendered one eases after it.
      const ground = this.groundHeight(state.position);
      if (state.node.position.y !== ground) {
        state.node.position.y = easedHeight(state.node.position.y, ground, dt);
        if (id === this.cameraFollowId) this.focusCamera(state.node.position);
      }
      if (state.pendingMotion) {
        state.lastMotionTime = this.sceneClock;
        state.pendingMotion = false;
      }
      const isMoving = this.sceneClock - state.lastMotionTime < MOTION_GRACE_WINDOW;

      const targetYaw = headingRadians(state.facing);
      if (state.currentYaw !== targetYaw) {
        state.currentYaw = yawStep(state.currentYaw, targetYaw, dt);
        state.modelHolder.rotation.y = state.currentYaw;
      }

      // A stall drops the blow the fall waits for, so the fall goes on without it.
      if (state.fallsAt !== undefined && (stalled || this.sceneClock >= state.fallsAt)) {
        state.fallsAt = undefined;
        this.playOneShot(state, 'fallen');
      }
      const direction = state.travelHeading === undefined ? 'forward' : relativeDirection(state.travelHeading, state.facing);
      if (!this.oneShotIsPlaying(state)) this.applyPose(isMoving ? movementPose(state.kind, state.gait, direction) : 'idle', state);
      // A hit-pause holds the clip where it is, for the bodies a blow names alone.
      if (!this.effects.frozen(id)) state.mixer?.update(dt);
    }
    // After the clips move on, so a drop leaving a hand leaves it where this frame draws the hand.
    this.loot.tick(this.sceneClock, stalled);
    this.sinkCrumbling(dt, stalled);
    this.auras.tick(this.sceneClock);
    this.questMarkers.place((carrierId) => this.entityStates.get(carrierId)?.headHeight ?? this.fixtureTop(carrierId));
    this.effects.tick(dt);
    this.camera.position.sub(this.shake);
    this.effects.shakeOffset(this.camera, this.shake);
    this.camera.position.add(this.shake);

    this.updateGrounds();
    this.growScatter();
    this.bendGrass(dt);
    this.orderPlaques();
    // Overlays run out on wall time, not on the clamped frame delta: a hidden tab gets no frames, and a
    // line said before it was hidden must not hang on after it returns.
    this.layoutSpeechBubbles(dt);
    const nowMs = this.now();
    this.pressMarkers = this.pressMarkers.filter((marker) => {
      if (this.posePressMarker(marker, nowMs)) return true;
      disposeSubtree(marker.mesh);
      return false;
    });
  }

  /**
   * Plays a one-shot over the looping pose, and answers the clip played. A model that carries none
   * of its clips keeps its pose, and nothing interrupts a held fall.
   */
  private playOneShot(state: EntityRenderState, oneShot: OneShot, landsIn?: number): THREE.AnimationClip | undefined {
    if (state.mixer === undefined || state.oneShot?.held === true) return undefined;
    const clips = this.assets.clipsFor(state.modelHolder.children[0] ?? state.modelHolder);
    const name = resolveOneShotClipName(
      oneShot,
      clips.map((clip) => clip.name),
    );
    const clip = clips.find((candidate) => candidate.name === name);
    if (clip === undefined) return undefined;
    const next = state.mixer.clipAction(clip);
    next.setLoop(THREE.LoopOnce, 1);
    next.clampWhenFinished = true;
    this.fadeTo(state, next);
    if (landsIn !== undefined) next.time = Math.max(0, strikeDelay(clip) - landsIn);
    state.oneShot = { action: next, held: oneShot === 'fallen' };
    return clip;
  }

  /** Starts an action from its beginning, fading over from the one the entity was playing. */
  private fadeTo(state: EntityRenderState, next: THREE.AnimationAction): void {
    next.reset();
    if (state.action !== undefined && state.action !== next) next.crossFadeFrom(state.action, CLIP_TRANSITION_DURATION, false);
    next.play();
    state.action = next;
  }

  /** Whether a one-shot still owns the entity's animation. One that has run out hands back to the looping pose. */
  private oneShotIsPlaying(state: EntityRenderState): boolean {
    if (state.oneShot === undefined) return false;
    if (state.oneShot.held || state.oneShot.action.isRunning()) return true;
    this.endOneShot(state);
    return false;
  }

  /** Forgets the pose last applied, so the next tick fades the looping pose back in from the one-shot's last frame. */
  private endOneShot(state: EntityRenderState): void {
    state.oneShot = undefined;
    state.pose = undefined;
  }

  private applyPose(pose: AnimationPose, state: EntityRenderState): void {
    if (state.pose === pose || state.mixer === undefined) return;
    // Recorded before the lookup. A model whose clip library has
    // no name for this pose returns below without ever reaching the assignment otherwise, so the
    // guard above never latches and `clipsFor` plus `resolveClipName` re-run every frame for as
    // long as that entity holds the pose.
    state.pose = pose;
    const clips = this.assets.clipsFor(state.modelHolder.children[0] ?? state.modelHolder);
    const name = resolveClipName(
      pose,
      clips.map((clip) => clip.name),
    );
    if (name === undefined) return;
    const clip = clips.find((candidate) => candidate.name === name);
    if (clip === undefined) return;
    const next = state.mixer.clipAction(clip);
    // Clips are cadence-tuned as authored, so they loop verbatim with no rate scaling.
    next.setLoop(THREE.LoopRepeat, Infinity);
    this.fadeTo(state, next);
  }

  /**
   * Plaques are hidden by the world but never by each other's depth, so which draws over which is
   * their draw order: the target's, the more hurt over the less hurt, the player's own, then the
   * rest, nearer the camera over further. Only the target's shows through the world.
   */
  private orderPlaques(): void {
    for (const [id, state] of this.entityStates) {
      const plate = state.namePlaquePlate;
      if (plate === undefined) continue;
      plate.renderOrder = this.plaqueOrder(id, state.condition);
      (plate.material as THREE.MeshBasicMaterial).depthTest = !this.isTarget(id);
    }
  }

  private plaqueOrder(id: string, condition: Condition): number {
    if (this.isTarget(id)) return PLAQUE_ORDER.target;
    // `CONDITIONS` runs from hale to fallen.
    const band = CONDITIONS.indexOf(condition);
    if (band > 0) return PLAQUE_ORDER.hurt + band - 1;
    return id === this.cameraFollowId ? PLAQUE_ORDER.own : PLAQUE_ORDER.rest;
  }

  /** Players and NPCs get a plaque, and a nightmare one only while it is not hale or is the target; the local player's text is bold. */
  private rebuildNamePlaque(state: EntityRenderState, targeted: boolean): void {
    disposeSubtree(state.namePlaque);
    state.namePlaque = undefined;
    state.namePlaquePlate = undefined;
    const background = namePlaqueBackground(state.kind, state.condition, targeted);
    if (background === undefined) return;
    const ink = state.kind !== 'npc' && state.condition === 'fallen' ? NAME_PLAQUE.fallenInk : NAME_PLAQUE.ink;
    // A nightmare's name is its kind's catalog key, or an elite's; a dreamer's or an NPC's is their own.
    const name = state.kind === 'monster' ? t(nightmareLabelKey(state.name, state.trait)) : state.name;
    const { container, plate } = namePlaqueQuad(name, background, state.kind === 'player', ink);
    container.scale.setScalar(this.overlayScale);
    state.node.add(container);
    state.namePlaque = container;
    state.namePlaquePlate = plate;
  }

  /** Finds the model's head bone and how high it stands over the feet. The model must stand in its idle pose, the one `headHeight` is measured in. A bone at or below the feet is not kept. */
  private findHeadBone(state: EntityRenderState, model: THREE.Object3D): void {
    let bone: THREE.Object3D | undefined;
    model.traverse((object) => {
      if (bone === undefined && (object as THREE.Bone).isBone && object.name.toLowerCase() === 'head') bone = object;
    });
    const rest = bone === undefined ? 0 : bone.getWorldPosition(new THREE.Vector3()).y - state.node.position.y;
    state.headBone = rest > 0 ? bone : undefined;
    state.headBoneRest = rest;
  }

  private resolveEntityModel(state: EntityRenderState): void {
    // Disposed rather than merely detached: a placeholder owns its `BoxGeometry`, and a clone owns
    // its skeleton, so dropping either here would put it past the reach of any later cleanup.
    for (const child of [...state.modelHolder.children]) disposeSubtree(child);
    state.pose = undefined;
    state.action = undefined;
    state.oneShot = undefined;
    const model = this.assets.character(state.characterModelId);
    if (model === undefined) {
      state.modelHolder.scale.setScalar(1);
      const placeholder = entityPlaceholder(state.radius);
      enableShadows(placeholder);
      state.modelHolder.add(placeholder);
      state.isPlaceholder = true;
      state.mixer = undefined;
      state.headHeight = this.measureHeadHeight(state);
      state.headBone = undefined;
      state.grassBones = [];
      return;
    }
    enableShadows(model);
    state.modelHolder.add(model);
    state.modelHolder.scale.setScalar(CHARACTER_SCALE);
    state.mixer = new THREE.AnimationMixer(model);
    state.isPlaceholder = false;
    // Posed first: until a clip plays, a model's bones rest wherever its file left them, which need not be a pose at all.
    this.applyPose('idle', state);
    state.mixer.update(0);
    state.headHeight = this.measureHeadHeight(state);
    this.findHeadBone(state, model);
    state.grassBones = GRASS_BONES.flatMap(({ name, foot }) => {
      const bone = model.getObjectByName(name);
      return bone === undefined ? [] : [{ bone, foot }];
    });
    // After the head is measured, so a raised blade does not count toward the body's height.
    this.hangHeldProps(state);
    if (state.condition === 'fallen') this.playOneShot(state, 'fallen');
  }

  /**
   * Replaces the models hung on the hands' bones with those for what they hold now. A hand whose
   * item has no model, and a body without the bone (a placeholder, a nightmare), draws nothing there.
   */
  private hangHeldProps(state: EntityRenderState): void {
    for (const prop of Object.values(state.heldProps)) prop.removeFromParent();
    state.heldProps = {};
    const model = state.modelHolder.children[0];
    if (state.isPlaceholder || model === undefined) return;
    for (const hand of HANDS) {
      const baseId = state.held?.[hand];
      const bone = model.getObjectByName(HAND_BONES[hand]);
      if (baseId === undefined || bone === undefined) continue;
      const prop = this.assets.hand(baseId);
      if (prop === undefined) continue;
      enableShadows(prop);
      prop.traverse((object) => (object.userData[HELD_PROP] = true));
      bone.add(prop);
      state.heldProps[hand] = prop;
    }
  }

  /** The fixtures of the drawn sectors. */
  private drawnFixtures(): DrawnFixture[] {
    return [...this.sectors.values()].flatMap((sector) => sector.fixtures);
  }

  /** How high over the ground the fixture's model reaches as drawn, which its quest mark stands over; `undefined` for one not drawn. */
  private fixtureTop(carrierId: string): number | undefined {
    const fixture = this.drawnFixtures().find((candidate) => candidate.carrierId === carrierId);
    return fixture === undefined ? undefined : this.fixtureBounds.setFromObject(fixture.node).max.y;
  }

  /** Takes a drawn sector's group away, after the quest marks over its fixtures, which belong to the pool rather than to the sector. */
  private disposeSector(name: string): void {
    for (const fixture of this.sectors.get(name)?.fixtures ?? []) this.questMarkers.forget(fixture.carrierId);
    disposeSubtree(this.sectors.get(name)?.group);
  }

  /**
   * A placement stands at its record's position and yaw; the model's own origin is its
   * ground-footprint centre. In a room, a model that carries a flame hangs its halo where the flame
   * burns. Outdoors it stands unlit.
   */
  private buildPlacement(placement: Placement, kind: SectorView['kind']): PlacedModel {
    const rule = objectModel(this.registry, placement.modelId);
    const model = this.assets.object(placement.modelId);
    const node = new THREE.Object3D();
    node.add(model ?? placementPlaceholder(placeholderFootprint(rule)));
    enableShadows(node);
    node.position.set(placement.x, placementElevation(placement, rule), placement.z);
    node.rotation.y = THREE.MathUtils.degToRad(placement.yaw);
    const light = kind === 'interior' ? rule?.light : undefined;
    if (light === undefined) return { node, placement, isPlaceholder: model === undefined, emitter: undefined };
    this.haloMaterial ??= new THREE.SpriteMaterial({ map: flameHaloTexture(), blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    const halo = new THREE.Sprite(this.haloMaterial);
    halo.position.set(light.x, light.y, light.z);
    halo.scale.setScalar(PROP_LIGHT_PRESETS[light.kind].halo);
    node.add(halo);
    return { node, placement, isPlaceholder: model === undefined, emitter: { kind: light.kind, halo, phase: 0 } };
  }

  /**
   * Post-prewarm pass: swaps every placeholder for the now-cached model in place, so an arrival
   * that wins the race against prewarm self-heals instead of leaving permanent grey boxes.
   */
  private refreshResolvedModels(): void {
    for (const sector of this.sectors.values()) {
      for (const placed of sector.placements) {
        if (!placed.isPlaceholder) continue;
        const model = this.assets.object(placed.placement.modelId);
        if (model === undefined) continue;
        // The placeholder owns its `BoxGeometry`, so it is disposed rather than just unparented. The halo stays.
        for (const child of [...placed.node.children]) if (child !== placed.emitter?.halo) disposeSubtree(child);
        placed.node.add(model);
        enableShadows(model);
        placed.isPlaceholder = false;
      }
    }
    this.loot.refreshModels();
    // A sector whose scatter waited for its models is placed over the next frames, from the same fields.
    for (const name of this.grounds.keys()) this.scatterDue.add(name);
    for (const [id, state] of this.entityStates) {
      if (!state.isPlaceholder) continue;
      this.resolveEntityModel(state);
      this.refreshPortraitLayers(id, state);
    }
  }

  private configureSunShadow(): void {
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SUN_SHADOW.mapSize, SUN_SHADOW.mapSize);
    this.sun.shadow.normalBias = SUN_SHADOW.normalBias;
    const shadowCamera = this.sun.shadow.camera;
    shadowCamera.near = SUN_SHADOW.near;
    shadowCamera.far = SUN_SHADOW.far;
    shadowCamera.left = -SUN_SHADOW.orthographicScale;
    shadowCamera.right = SUN_SHADOW.orthographicScale;
    shadowCamera.top = SUN_SHADOW.orthographicScale;
    shadowCamera.bottom = -SUN_SHADOW.orthographicScale;
    shadowCamera.updateProjectionMatrix();
  }

  private configureDoorSpill(): void {
    this.doorSpill.castShadow = true;
    this.doorSpill.shadow.mapSize.set(DOOR_SPILL.shadowMapSize, DOOR_SPILL.shadowMapSize);
    this.doorSpill.shadow.normalBias = DOOR_SPILL.normalBias;
    // Drawn once even where it stays dark. three.js binds a casting light's shadow map to every lit
    // material. For a map never drawn it binds a stand-in that spot shadows cannot compare against,
    // so a scene that opens outdoors would draw nothing lit.
    this.doorSpill.shadow.needsUpdate = true;
  }

  /**
   * Gives the pool to the flames of the space on screen, and aims the door's light through the
   * first of its doors that opens to the outdoors and resolves. Outdoors, or in a room with no such
   * door, the door's light stays dark, and its shadow map is not drawn: three.js draws one for every
   * light that casts, whatever its intensity, unless told not to.
   */
  private lightDrawnSpace(): void {
    const drawn = [...this.sectors.values()];
    this.litEmitters = drawn.flatMap((sector) => sector.placements.flatMap((placed) => placed.emitter ?? [])).slice(0, PROP_LIGHT_POOL_SIZE);
    const door = this.spillDoor(drawn);
    this.litDoor = door !== undefined;
    this.doorSpill.shadow.autoUpdate = this.litDoor;
    if (door !== undefined) {
      // The door's facing is the heading an arriving body faces: into the room.
      const inward = headingRadians(door.facing);
      const along = { x: Math.sin(inward), z: Math.cos(inward) };
      this.doorSpill.position.set(door.doorway.x - along.x * DOOR_SPILL.outside, DOOR_SPILL.height, door.doorway.z - along.z * DOOR_SPILL.outside);
      this.doorSpill.target.position.set(door.doorway.x + along.x * DOOR_SPILL.reach, 0, door.doorway.z + along.z * DOOR_SPILL.reach);
    }
    this.updatePropLights();
  }

  private spillDoor(drawn: readonly DrawnSector[]): ResolvedDoor | undefined {
    for (const { view, outdoorDoorIds } of drawn) {
      if (view.kind !== 'interior') continue;
      for (const door of view.doors) {
        if (!outdoorDoorIds.includes(door.id)) continue;
        const resolved = resolveDoor(view, door, this.registry);
        if (resolved !== undefined) return resolved;
      }
    }
    return undefined;
  }

  /** Each lit flame's pool stands where its halo is drawn, so a moved lamp takes its light along, and both flicker together. */
  private updatePropLights(): void {
    this.propLights.forEach((light, index) => {
      const emitter = this.litEmitters[index];
      if (emitter === undefined) {
        light.intensity = 0;
        return;
      }
      const preset = PROP_LIGHT_PRESETS[emitter.kind];
      const flicker = this.reducedMotion ? 1 : flameFlicker(this.sceneClock, emitter.phase);
      emitter.halo.getWorldPosition(light.position);
      light.intensity = preset.intensity * flicker;
      emitter.halo.scale.setScalar(preset.halo * flicker);
    });
  }

  /**
   * Carries the sun's shadow volume with the camera focus.
   *
   * Both ends move together, which is the point: three.js derives a directional light's direction
   * from `position - target.position`, so anchoring the light at the world origin while the target
   * follows the player would swing the light angle further off the authored direction the further
   * the player walked from the space's origin.
   */
  private repositionSun(): void {
    // The shadow map's texel grid lives in the light's own view plane, so that is where the anchor
    // has to be quantized. Rounding world XYZ instead leaves a fractional-texel phase on every step
    // — 0.5 world units is 21.33 texels at this scale, and the projection into the light plane
    // scales it again by the direction cosines — so the map re-samples the same silhouette against a
    // different sub-texel phase each frame and the edge pixels flip. Standing still the anchor is
    // constant and the phase is fixed, which is why it only shows while walking.
    const texel = (2 * SUN_SHADOW.orthographicScale) / SUN_SHADOW.mapSize;
    // `Matrix4.lookAt` only uses `eye - target` normalized, so passing the direction against the
    // origin yields exactly the basis `DirectionalLightShadow` will build from the real position —
    // including its nudge for a light pointing straight down the up axis.
    this.shadowBasis.lookAt(this.sunDirection, ORIGIN, this.sun.up);
    this.shadowOrientation.setFromRotationMatrix(this.shadowBasis);
    const anchor = this.shadowAnchor.copy(this.focus);
    anchor.applyQuaternion(this.shadowOrientationInverse.copy(this.shadowOrientation).invert());
    // Only the two axes spanning the map. Quantizing depth as well would jitter the near/far range
    // against the geometry for no sampling benefit.
    anchor.x = Math.round(anchor.x / texel) * texel;
    anchor.y = Math.round(anchor.y / texel) * texel;
    anchor.applyQuaternion(this.shadowOrientation);

    this.sun.target.position.copy(anchor);
    this.sun.target.updateMatrixWorld();
    this.sun.position.copy(anchor).addScaledVector(this.sunDirection, SUN_SHADOW.distance);
  }

  /** Lights the scene for the world clock as it stands now. */
  private relight(): void {
    const clock = this.clock;
    const hour = clock === undefined ? 12 : hourOfDay(worldSecondsAt(clock, this.now()));
    const state = sunState(hour, this.litBrightness);
    this.sunDirection.set(state.direction.x, state.direction.y, state.direction.z);
    this.repositionSun();
    this.sun.intensity = state.sunIntensity;
    this.sun.color.setRGB(state.sunColor.r, state.sunColor.g, state.sunColor.b);
    this.fill.intensity = state.hemisphereIntensity;
    this.fill.color.setRGB(state.skyColor.r, state.skyColor.g, state.skyColor.b);
    this.fill.groundColor.setRGB(state.groundColor.r, state.groundColor.g, state.groundColor.b);
    const door = doorLightState(hour);
    this.doorSpill.intensity = this.litDoor ? door.intensity : 0;
    this.doorSpill.color.setRGB(door.color.r, door.color.g, door.color.b);
    (this.scene.background as THREE.Color).setRGB(state.backdropColor.r, state.backdropColor.g, state.backdropColor.b);
  }

  private focusCamera(focus: THREE.Vector3): void {
    this.focus.copy(focus);
    const position = cameraPosition({ x: focus.x, y: focus.y, z: focus.z });
    this.camera.position.set(position.x, position.y, position.z);
    this.camera.lookAt(focus);
    this.camera.position.add(this.shake);
    this.repositionSun();
  }

  /**
   * Re-anchors the sun's shadow volume on a ground point and leaves the camera alone, for a
   * consumer that frames the camera itself and places no player for the scene to follow.
   */
  anchorSunShadow(point: Point): void {
    this.focus.set(point.x, 0, point.z);
    this.repositionSun();
  }

  /** The drawn node of a placement, so a live drag can move and turn the real mesh. */
  placementNode(sectorName: string, placementId: string): THREE.Object3D | undefined {
    return this.sectors.get(sectorName)?.placements.find((placed) => placed.placement.id === placementId)?.node;
  }

  /** Has a portrait of the HUD show the body of `entityId`, or nothing. */
  setPortraitSubject(slot: PortraitSlot, entityId: string | undefined): void {
    const previous = this.portraitSubjects[slot];
    if (previous === entityId) return;
    this.portraitSubjects[slot] = entityId;
    const layer = PORTRAIT_LAYERS[slot];
    const left = previous === undefined ? undefined : this.entityStates.get(previous);
    if (left !== undefined) setPortraitLayer(left.modelHolder, layer, false);
    const next = entityId === undefined ? undefined : this.entityStates.get(entityId);
    if (next !== undefined) setPortraitLayer(next.modelHolder, layer, true);
  }

  /**
   * Draws each portrait in its place on the canvas, after the world, the Character window's body
   * turned `bodyTurn` radians round from its usual view. The hemisphere fill is lifted to a floor for
   * them alone, a uniform and not a light, so a body in a dim room still reads.
   */
  drawPortraits(renderer: PortraitRenderer, views: readonly { slot: PortraitSlot; viewport: DeviceRect }[], bodyTurn = 0): void {
    if (views.length === 0) return;
    this.portraitPass ??= new PortraitPass();
    const shots = views.map(({ slot, viewport }) => {
      const subject = this.portraitSubjectOf(this.portraitSubjects[slot]);
      const framing = subject === undefined ? undefined : slot === 'body' ? bodyFraming(subject, bodyTurn) : portraitFraming(subject);
      return { slot, viewport, framing };
    });
    const fill = this.fill.intensity;
    this.fill.intensity = Math.max(fill, PORTRAIT.fillFloor);
    this.portraitPass.draw(renderer, this.scene, shots);
    this.fill.intensity = fill;
  }

  private portraitSubjectOf(entityId: string | undefined): PortraitSubject | undefined {
    const state = entityId === undefined ? undefined : this.entityStates.get(entityId);
    if (state === undefined) return undefined;
    const head = this.headPoint(state);
    // Centred on the head as the model carries it, which need not stand over the feet.
    if (state.headBone !== undefined) {
      const bone = state.headBone.getWorldPosition(new THREE.Vector3());
      head.set(bone.x, head.y, bone.z);
    }
    return { head, feet: state.node.position, height: state.headHeight, yaw: state.currentYaw };
  }

  /** A model put in afresh carries the layers of the portraits that show its entity. */
  private refreshPortraitLayers(entityId: string, state: EntityRenderState): void {
    for (const slot of PORTRAIT_SLOTS) setPortraitLayer(state.modelHolder, PORTRAIT_LAYERS[slot], this.portraitSubjects[slot] === entityId);
  }

  /** Test seam: the scale the camera is currently framed at. */
  _cameraScale(): number {
    return clampedScale(this.camera.top);
  }

  /** Test seam: how many placements still render placeholders. */
  _placeholderObjectCount(): number {
    let count = 0;
    for (const sector of this.sectors.values()) count += sector.placements.filter((placed) => placed.isPlaceholder).length;
    return count;
  }

  /** Test seam: the pose last selected for an entity. */
  _poseFor(entityId: string): AnimationPose | undefined {
    return this.entityStates.get(entityId)?.pose;
  }

  /** Test seam: an entity node's world position, so the eased height is observable. */
  _positionFor(entityId: string): { x: number; y: number; z: number } | undefined {
    const node = this.entityStates.get(entityId)?.node;
    if (node === undefined) return undefined;
    return { x: node.position.x, y: node.position.y, z: node.position.z };
  }

  /** Test seam: the model holder's slewed yaw, which the overlays must never inherit. */
  _yawFor(entityId: string): number | undefined {
    return this.entityStates.get(entityId)?.modelHolder.rotation.y;
  }

  /**
   * Test seam: the entity node's own yaw, which must stay identity.
   *
   * The counterpart to `_yawFor`, and separate from it on purpose — the plaque and the miss mark
   * hang off this node, so a facing yaw reaching it tilts them with the character. Reading
   * the holder cannot see that: both would turn together and the holder's value would look right.
   */
  _nodeYawFor(entityId: string): number | undefined {
    return this.entityStates.get(entityId)?.node.rotation.y;
  }

  /** Where the middle of an entity's body is drawn, in normalized device coordinates: the point `entityAt` picks it at. */
  _viewportPointFor(entityId: string): { x: number; y: number } | undefined {
    const state = this.entityStates.get(entityId);
    if (state === undefined) return undefined;
    this.camera.updateMatrixWorld();
    const point = this.headPoint(state).add(state.node.position).multiplyScalar(0.5).project(this.camera);
    return { x: point.x, y: point.y };
  }

  /**
   * Where the middle of a drop's name or of its model is drawn, in normalized device coordinates: a
   * point `pressTargetAt` picks it at, unless a body covers its model.
   */
  _viewportPointOfLoot(lootId: string, part: 'label' | 'model'): { x: number; y: number } | undefined {
    this.camera.updateMatrixWorld();
    const point = this.loot.pointOf(lootId, part)?.project(this.camera);
    return point === undefined ? undefined : { x: point.x, y: point.y };
  }

  /**
   * Where a fixture's model is drawn, in normalized device coordinates: a point up the middle of its
   * bounds, as drawn, that `fixtureAt` picks it at. `undefined` for a fixture not drawn, or one that
   * `fixtureAt` picks at none of the heights `FIXTURE_POINT_SHARES` tries.
   */
  _viewportPointOfFixture(carrierId: string): { x: number; y: number } | undefined {
    const fixture = this.drawnFixtures().find((candidate) => candidate.carrierId === carrierId);
    if (fixture === undefined) return undefined;
    this.camera.updateMatrixWorld();
    const bounds = this.fixtureBounds.setFromObject(fixture.node);
    const centre = bounds.getCenter(new THREE.Vector3());
    for (const share of FIXTURE_POINT_SHARES) {
      const point = new THREE.Vector3(centre.x, THREE.MathUtils.lerp(bounds.min.y, bounds.max.y, share), centre.z).project(this.camera);
      if (this.fixtureAt(point.x, point.y) === carrierId) return { x: point.x, y: point.y };
    }
    return undefined;
  }

  /** Where a point of the space is drawn, on the ground a body there stands on, in normalized device coordinates. `groundPointAt` at that point picks it again. `undefined` before a space is entered. */
  _viewportPointOfGround(position: Point): { x: number; y: number } | undefined {
    if (this.ground === undefined) return undefined;
    this.camera.updateMatrixWorld();
    const point = new THREE.Vector3(position.x, this.groundHeight(position), position.z).project(this.camera);
    return { x: point.x, y: point.y };
  }
}

/**
 * Where a ray falling from the camera first meets the floor or the top of a walk surface inside its
 * rect. It falls as it goes, so the highest hit is the one nearest the camera. A model is tested
 * only when the ray passes within its reach between its highest surface and the floor.
 */
function groundHit(collision: SpaceCollision, ray: THREE.Ray): { x: number; z: number; height: number } {
  let hit = { ...pointOnRayAt(ray, 0), height: 0 };
  for (const model of collision.models) {
    if (model.walkSurfaces.length === 0) continue;
    const top = Math.max(...model.walkSurfaces.map((surface) => surface.height));
    if (distance(model.transform, closestOnSegment(model.transform, { a: pointOnRayAt(ray, top), b: pointOnRayAt(ray, 0) })) > model.reach + EDGE_TOLERANCE)
      continue;
    for (const surface of model.walkSurfaces) {
      if (surface.height <= hit.height) continue;
      const point = pointOnRayAt(ray, surface.height);
      if (rectContains(surface, worldToModel(model.transform, point), EDGE_TOLERANCE)) hit = { ...point, height: surface.height };
    }
  }
  return hit;
}

/** Where a ray falling from the camera crosses the level plane at `height`. */
function pointOnRayAt(ray: THREE.Ray, height: number): Point {
  const along = (height - ray.origin.y) / ray.direction.y;
  return { x: ray.origin.x + ray.direction.x * along, z: ray.origin.z + ray.direction.z * along };
}

function entityPlaceholder(radius: number): THREE.Object3D {
  const box = new THREE.Mesh(new THREE.BoxGeometry(2 * radius, CHARACTER_SCALE, radius), PLACEHOLDER_MATERIAL);
  // Own geometry, shared material — disposing `PLACEHOLDER_MATERIAL` would blank every other one.
  markOwned(box, { geometry: true, material: false });
  box.position.y = CHARACTER_SCALE / 2;
  return box;
}

function placementPlaceholder(footprint: Size): THREE.Object3D {
  const box = new THREE.Mesh(new THREE.BoxGeometry(footprint.width, PLACEHOLDER_HEIGHT, footprint.depth), PLACEHOLDER_MATERIAL);
  markOwned(box, { geometry: true, material: false });
  box.position.y = PLACEHOLDER_HEIGHT / 2;
  return box;
}

/**
 * Fixed screen-aligned orientation for overlay quads: the camera's **own** orientation.
 *
 * Constant because the rig is locked — only the camera's position follows the player. Rebuilding it
 * from `pitchDegrees`/`yawDegrees` as Euler angles instead looks right and is not: those describe
 * the rig's offset direction, not the look rotation, and a quad carrying them sits at a residual
 * yaw that foreshortens its width. The artwork then reads as squeezed, which looks like a
 * texture-mapping fault and is a rotation bug.
 */
const OVERLAY_ORIENTATION = (() => {
  const eye = cameraPosition({ x: 0, y: 0, z: 0 });
  // `Matrix4.lookAt` uses the camera convention (-Z forward). A `PlaneGeometry` faces +Z, so the
  // camera's rotation turns the plane's front back toward the eye.
  const matrix = new THREE.Matrix4().lookAt(new THREE.Vector3(eye.x, eye.y, eye.z), new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0));
  return new THREE.Quaternion().setFromRotationMatrix(matrix);
})();
/** How much of a speech bubble's opacity is left at the far end of the band, where speech crumbles away. */
const FAINTEST_BUBBLE_OPACITY = 0.15;
/** How long a bubble takes to glide most of the way to a new spot. */
const BUBBLE_GLIDE_SECONDS = 0.07;
/** How much of a figure's standing height its head takes up. */
const HEAD_SHARE = 0.4;
/** Plaque draw orders, a later one drawn over an earlier; the bands below full health take one each from `hurt` up, the least hurt first. */
const PLAQUE_ORDER = { rest: 1, own: 2, hurt: 3, target: 8 } as const;
/** How high over a doorway outdoors a voice through it hangs its bubble: on the building, above the door. */
const DOORWAY_VOICE_HEIGHT = 2.2;
/**
 * How high a room's full walls stand (`WALL_HEIGHT` in somnio-assets' `Pipeline/build_room_walls.py`),
 * so a bubble past any of its walls, the low front ones too, clears the top.
 */
const ROOM_WALL_HEIGHT = 1.728;
/**
 * The cone the light through a room's door falls in: shadowed, and narrow enough to make a wedge
 * through the gap rather than a wash over the low walls. It shines from `outside` metres beyond the
 * doorway and `height` up, at the floor `reach` metres inside. It shares the sun's `normalBias`, so
 * the walls it grazes do not self-shadow into stripes either.
 */
const DOOR_SPILL = {
  distance: 7,
  angle: 0.42,
  penumbra: 0.75,
  decay: 1.2,
  shadowMapSize: 1024,
  normalBias: SUN_SHADOW.normalBias,
  outside: 2.4,
  height: 2.6,
  reach: 1.6,
} as const;
/** The gap on screen, in metres, between a room's wall and a bubble past it. */
const BEYOND_WALL_GAP = 0.3;
const RING_SEGMENTS = 48;
const RING_OPACITY = 0.9;
/** The selection ring's inner radius in body radii, inside a raise's ring. */
const SELECTION_RING_RADII = RAISE_RING_RADII * 0.7;
/** A friendly green, bluer than the plaque of a grazed body beside it. */
const SELECTION_RING_COLOR = 0x8ef0b0;
/** The target's ring while slot 1 acts on it: a deeper gold than the raise ring, which lies further out. */
const ACTING_RING_COLOR = darker(RAISE_COLOR, 0.18);
/**
 * The locked target's reticle's four ticks, which point in at the ring from outside it: how far out
 * they reach past its outer edge, and how wide their base is, in metres.
 */
const LOCK_TICK_LENGTH = 0.2;
const LOCK_TICK_WIDTH = 0.14;
/** The inner radius of the ring a press on the ground drops, in metres. */
const PRESS_MARKER_RADIUS = 0.22;
/** How long it takes to drop onto the ground, and to rise off it again. */
const PRESS_MARKER_SECONDS = 0.15;
/** How far above the ground it drops from, and rises to. */
const PRESS_MARKER_DROP_METRES = 0.5;
/** The least radius of the capsule an entity is picked by under a finger, which need not land on the body itself. */
const COARSE_PICK_METRES = 0.6;
/** How far over the feet the cursor's aim is taken: about the middle of a body as drawn. */
const AIM_HEIGHT = 0.8;
/** The longest a thrower winds up before the item leaves the hand: their throw starts part-way in, so a drop asked for flies soon. */
const THROW_WINDUP_SECONDS = 0.25;
/** How high over the ground a dreamer's throw leaves from where no hand of theirs is drawn: about a hand's height. */
const THROWN_FROM_HEIGHT = 0.4;
/** How high over the ground a nightmare's drops burst out of it: about a Ghost's chest, its head standing 0.8 m. */
const BURST_FROM_HEIGHT = 0.55;
/** Advance past the point where the below-the-feet quad clears the floor plane. */
const PLAQUE_FLOOR_CLEARANCE = 0.15;

/**
 * `userData` keys marking which GPU resources a mesh allocated itself, and may therefore dispose.
 *
 * Two flags rather than one because ownership genuinely differs: the placeholders allocate their own
 * `BoxGeometry` but share the module-level `PLACEHOLDER_MATERIAL`, so disposing their material would
 * blank every other placeholder in the scene.
 */
const OWNS_GEOMETRY = 'somnioOwnsGeometry';
const OWNS_MATERIAL = 'somnioOwnsMaterial';
/** On a material's `userData`: textures it binds as uniforms rather than as its `map`, which it owns. */
const OWNED_TEXTURES = 'somnioOwnedTextures';

/** Marks a mesh's allocations as this file's to release. */
function markOwned(mesh: THREE.Mesh, options: { geometry: boolean; material: boolean }): void {
  mesh.userData[OWNS_GEOMETRY] = options.geometry;
  mesh.userData[OWNS_MATERIAL] = options.material;
}

/**
 * Releases the GPU resources a detached subtree owned, then detaches it.
 *
 * `removeFromParent()` alone drops the reference but leaves the geometry, material, and texture in
 * `WebGLRenderer`'s internal maps, so every door and every plaque rebuilt would accumulate VRAM
 * until the context is lost — the world going black with nothing the player can act on. Three.js
 * documents disposal as the caller's job for exactly this reason.
 *
 * A model clone's `geometry` and `material` are skipped, because `SkeletonUtils.clone` shares both
 * with the cached prototype and disposing a clone's would break every other clone *and* the cache
 * entry. Its **skeleton** is the exception, and the reason this traversal cannot key on the ownership
 * flags alone: `SkeletonUtils.clone` assigns `sourceMesh.skeleton.clone()`, so every clone gets its
 * own `Skeleton`, and `WebGLRenderer` lazily allocates a per-`Skeleton` bone `DataTexture` on first
 * render. Nothing in three.js reclaims it — there is no `FinalizationRegistry`, so collecting the JS
 * wrapper leaves the GL texture allocated, and `Skeleton.dispose()` is the only release path. A clone
 * therefore owns exactly one GPU resource while carrying neither flag.
 *
 * This is the single detach-and-dispose entry point on purpose. A bare `removeFromParent()` on a
 * flagged mesh puts it beyond the reach of any later cleanup, so the flags stop meaning
 * anything; every site that drops a node routes through here instead.
 */
function disposeSubtree(root: THREE.Object3D | undefined): void {
  if (root === undefined) return;
  root.traverse((object) => {
    const skinned = object as THREE.SkinnedMesh;
    if (skinned.isSkinnedMesh) skinned.skeleton?.dispose();
    // Frees the instance matrix and colour buffers, which belong to the mesh and not to its geometry.
    if ((object as THREE.InstancedMesh).isInstancedMesh) (object as THREE.InstancedMesh).dispose();
    const mesh = object as THREE.Mesh;
    if (mesh.userData[OWNS_GEOMETRY] === true) mesh.geometry.dispose();
    if (mesh.userData[OWNS_MATERIAL] !== true) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      // Safe to take the map with the material because every owned material's map is a texture this
      // file minted: each overlay rasterizes a fresh `CanvasTexture`.
      (material as THREE.MeshBasicMaterial).map?.dispose();
      for (const texture of (material.userData[OWNED_TEXTURES] as THREE.Texture[] | undefined) ?? []) texture.dispose();
      material.dispose();
    }
  });
  root.removeFromParent();
}

/** A flat quad drawing overlay art: its canvas texture on a plane as large as the art. */
type OverlayPlate = THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;

/**
 * Overlay quad with a **fixed** screen-aligned orientation rather than a billboard.
 *
 * A billboard aims each quad at the camera *point*, which under an orthographic projection
 * leaves off-centre entities visibly tilted — the camera rig is locked, so a constant
 * orientation is both correct and cheaper.
 *
 * Returns the container and the plate separately so the caller can position the plate inside the
 * screen-aligned frame, where +Y is camera-up and +Z is toward the camera.
 */
function overlayQuad(art: RasterArt): { container: THREE.Object3D; plate: OverlayPlate; size: THREE.Vector2 } {
  const container = new THREE.Object3D();
  container.quaternion.copy(OVERLAY_ORIENTATION);
  const { plate, size } = overlayPlate(art);
  container.add(plate);
  return { container, plate, size };
}

/** A plane as large as the art in metres, centred on its origin, drawing the art untouched by the scene's lighting. */
function overlayPlate(art: RasterArt): { plate: OverlayPlate; size: THREE.Vector2 } {
  const texture = new THREE.CanvasTexture(art.canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // Not tone-mapped, so the plaque's painted colours stay exactly as rasterized.
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false });
  const size = new THREE.Vector2(art.widthPixels * OVERLAY_METRES_PER_PIXEL, art.heightPixels * OVERLAY_METRES_PER_PIXEL);
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(size.x, size.y), material);
  // Every overlay quad allocates its own canvas texture, material, and geometry.
  markOwned(plate, { geometry: true, material: true });
  return { plate, size };
}

/**
 * Name plaque hanging just below the feet anchor.
 *
 * Hanging at negative Y alone would dip the quad below the floor plane, which always occludes
 * below-ground content under the downward 3/4 camera. The toward-camera Z advance compensates —
 * invisible under the orthographic projection, but it lifts the quad's world height above the
 * floor and draws it in front of the entity.
 */
function namePlaqueQuad(name: string, background: string, bold: boolean, ink: string): { container: THREE.Object3D; plate: THREE.Mesh } {
  const { container, plate, size } = overlayQuad(renderNamePlaque(name, background, bold, ink));
  const drop = size.y + PLAQUE_FEET_GAP;
  const pitch = (ORTHO_RIG.pitchDegrees * Math.PI) / 180;
  plate.position.set(0, -(size.y / 2 + PLAQUE_FEET_GAP), drop / Math.tan(pitch) + PLAQUE_FLOOR_CLEARANCE);
  // Never hidden by another plaque's depth; `orderPlaques` decides which shows.
  plate.material.depthWrite = false;
  return { container, plate };
}

/** The word over an entity a blow missed, facing the camera with its foot at its origin. */
function missWord(): OverlayPlate {
  const { plate, size } = overlayPlate(renderOutlinedText(t('miss'), MISS_WORD));
  plate.quaternion.copy(OVERLAY_ORIENTATION);
  plate.geometry.translate(0, size.y / 2, 0);
  return plate;
}

/** The colour with its lightness lowered by `by`, its hue and saturation kept. */
function darker(color: number, by: number): number {
  const hsl = new THREE.Color(color).getHSL({ h: 0, s: 0, l: 0 }, THREE.SRGBColorSpace);
  return new THREE.Color().setHSL(hsl.h, hsl.s, hsl.l - by, THREE.SRGBColorSpace).getHex();
}

/** A flat ring just above the ground round an entity's feet. */
function groundRingMesh(innerRadius: number, color: number): THREE.Mesh {
  const geometry = new THREE.RingGeometry(innerRadius, innerRadius + GROUND_RING_WIDTH, RING_SEGMENTS, 1);
  const material = new THREE.MeshBasicMaterial({
    color,
    side: THREE.DoubleSide,
    forceSinglePass: true,
    transparent: true,
    opacity: RING_OPACITY,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  markOwned(mesh, { geometry: true, material: true });
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = GROUND_RING_LIFT;
  return mesh;
}

/** The selection ring with a tick at each cardinal point pointing in at it, drawn with the ring's own material. */
function lockReticleMesh(innerRadius: number, color: number): THREE.Mesh {
  const ring = groundRingMesh(innerRadius, color);
  const tip = innerRadius + GROUND_RING_WIDTH / 2;
  const base = innerRadius + GROUND_RING_WIDTH + LOCK_TICK_LENGTH;
  const half = LOCK_TICK_WIDTH / 2;
  const positions: number[] = [];
  for (const [c, s] of [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ] as const) {
    positions.push(c * tip, s * tip, 0, c * base - s * half, s * base + c * half, 0, c * base + s * half, s * base - c * half, 0);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  // In the ring's own plane, so it lies flat with it; the ring owns the material.
  const ticks = new THREE.Mesh(geometry, ring.material);
  markOwned(ticks, { geometry: true, material: false });
  ring.add(ticks);
  return ring;
}

function flameHaloTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (context !== null) {
    const glow = context.createRadialGradient(32, 32, 0, 32, 32, 32);
    glow.addColorStop(0, 'rgba(255, 220, 150, 1)');
    glow.addColorStop(0.35, 'rgba(255, 170, 80, 0.55)');
    glow.addColorStop(1, 'rgba(255, 140, 40, 0)');
    context.fillStyle = glow;
    context.fillRect(0, 0, 64, 64);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** The flat background a sector draws on until its first field arrives: one texel of its own background. */
function flatGroundWeights(sector: SectorView): [Uint8Array, Uint8Array] {
  // A background with no recipe draws the first, as the field does.
  const material = groundMaterialChannel(sector.ground.backgroundMaterialId) ?? 0;
  const weights: [Uint8Array, Uint8Array] = [new Uint8Array(4), new Uint8Array(4)];
  weights[material < 4 ? 0 : 1][material % 4] = 255;
  return weights;
}

/** A scatter mesh joins its group owning its cloned geometry, never its shared material, and takes shadows. */
function addScatterMesh(group: THREE.Group, mesh: THREE.InstancedMesh): THREE.InstancedMesh {
  markOwned(mesh, { geometry: true, material: false });
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

const GROUND_PALETTE = GROUND_MATERIAL_IDS.flatMap((id) => GROUND_RECIPES[id].palette.map((hex) => new THREE.Color(hex)));
const GROUND_FRAGMENT = groundFragmentChunks();

/**
 * One plane over the sector's rect, painted by the floor recipes from the weight textures, which
 * cover the sector's padded raster. Every sector's ground shares one shader program.
 */
function groundMesh(sector: SectorView, size: { columns: number; rows: number }, weights: readonly [Uint8Array, Uint8Array]): THREE.Mesh {
  const textures = weights.map((bytes) => {
    const texture = new THREE.DataTexture(bytes, size.columns, size.rows, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    return texture;
  });
  const padded = paddedRasterRect(sector);
  const material = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
  material.userData[OWNED_TEXTURES] = textures;
  material.onBeforeCompile = (shader) => {
    shader.uniforms['uGroundWeights0'] = { value: textures[0] };
    shader.uniforms['uGroundWeights1'] = { value: textures[1] };
    shader.uniforms['uGroundOrigin'] = { value: new THREE.Vector2(padded.x, padded.z) };
    shader.uniforms['uGroundSize'] = { value: new THREE.Vector2(padded.width, padded.depth) };
    shader.uniforms['uGroundPalette'] = { value: GROUND_PALETTE };
    shader.vertexShader = `varying vec3 vGroundPosition;\n${shader.vertexShader.replace(
      '#include <project_vertex>',
      '#include <project_vertex>\nvGroundPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;',
    )}`;
    shader.fragmentShader = `${GROUND_FRAGMENT.declarations}\n${shader.fragmentShader.replace('vec4 diffuseColor = vec4( diffuse, opacity );', GROUND_FRAGMENT.colour)}`;
  };
  material.customProgramCacheKey = () => GROUND_NAME;
  const rect = sectorRect(sector);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(rect.width, rect.depth), material);
  markOwned(mesh, { geometry: true, material: true });
  mesh.name = GROUND_NAME;
  // Receives but does not cast: a ground plane casting into its own depth comparison is the
  // classic source of shadow acne, and there is nothing below it to catch a shadow anyway.
  mesh.receiveShadow = true;
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(rect.x + rect.width / 2, 0, rect.z + rect.depth / 2);
  return mesh;
}

/** The name every sector's ground mesh carries, and its shader program's cache key. */
const GROUND_NAME = 'somnio-ground';
/** The name of each sector's scatter group, and the stem of its bending programs' cache keys. */
const SCATTER_NAME = 'somnio-scatter';

const UP = new THREE.Vector3(0, 1, 0);
const UNIT_SCALE = new THREE.Vector3(1, 1, 1);
/** A flower head's radius, which is also how far a body reaches it to bend the flower. */
const FLOWER_HEAD_RADIUS = 0.03;
const FLOWER_HEAD_MATERIAL = new THREE.MeshStandardMaterial({ roughness: 0.8, flatShading: true });
const FLOWER_STEM_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x5f8f3a, roughness: 1 });

/** The bone each hand's model hangs from at identity, the rig's `handslot.r` and `handslot.l` as `GLTFLoader` names them (see `GRASS_BONES`). */
const HAND_BONES: Record<Hand, string> = { mainHand: 'handslotr', offHand: 'handslotl' };

function sameHeld(a: Held | undefined, b: Held | undefined): boolean {
  return a?.mainHand === b?.mainHand && a?.offHand === b?.offHand;
}

/**
 * The bones that brush grass, as `GLTFLoader` names them: it strips the dots from node names, so
 * the rig's `foot.l` is `footl`. A model without them, as the ghost is, bends nothing.
 */
const GRASS_BONES = [
  { name: 'footl', foot: true },
  { name: 'footr', foot: true },
  { name: 'toesl', foot: true },
  { name: 'toesr', foot: true },
  { name: 'lowerlegl', foot: false },
  { name: 'lowerlegr', foot: false },
] as const;
/** A foot or toe touches grass only this near the ground. */
const GRASS_FOOT_CONTACT_HEIGHT = 0.1;
const GRASS_FOOT_RADIUS = 0.06;
const GRASS_LEG_RADIUS = 0.05;
/** How tall the tallest tufts stand, which a held item reaches only below. */
const GRASS_HEIGHT = 0.4;

/**
 * How a model reaches into grass, in its own frame: a capsule along its longest extent, through
 * its middle, its radius half its greater other extent and its ends that far in from the model's.
 */
interface GrassReach {
  from: THREE.Vector3;
  to: THREE.Vector3;
  radius: number;
}

/** The model's reach, measured the first time its base asks and kept in `reaches` after. */
function measuredReach(reaches: Map<string, GrassReach | undefined>, baseId: string, model: THREE.Object3D): GrassReach | undefined {
  if (!reaches.has(baseId)) reaches.set(baseId, grassReach(model));
  return reaches.get(baseId);
}

function grassReach(model: THREE.Object3D): GrassReach | undefined {
  const box = new THREE.Box3();
  for (const { geometry, matrix } of prototypeMeshesOf(model)) {
    if (geometry.boundingBox === null) geometry.computeBoundingBox();
    box.union(geometry.boundingBox!.clone().applyMatrix4(matrix));
  }
  if (box.isEmpty()) return undefined;
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const [long, across] = [0, 1, 2].sort((a, b) => size.getComponent(b) - size.getComponent(a)) as [number, number, number];
  const radius = size.getComponent(across) / 2;
  const half = size.getComponent(long) / 2 - radius;
  return {
    from: centre.clone().setComponent(long, centre.getComponent(long) - half),
    to: centre.clone().setComponent(long, centre.getComponent(long) + half),
    radius,
  };
}

/**
 * Where a model touches grass this frame: its reach taken into the world by its world matrix, cut
 * where it rises out of the grass, and laid on the ground; `undefined` where it is all above it.
 */
function grassContact(model: THREE.Object3D, reach: GrassReach | undefined, lean?: number, pressRate?: number): GrassContact | undefined {
  if (reach === undefined) return undefined;
  const radius = reach.radius * model.matrixWorld.getMaxScaleOnAxis();
  const top = GRASS_HEIGHT + radius;
  const from = reach.from.clone().applyMatrix4(model.matrixWorld);
  const to = reach.to.clone().applyMatrix4(model.matrixWorld);
  if (from.y > top && to.y > top) return undefined;
  if (from.y > top) from.lerp(to, (from.y - top) / (from.y - to.y));
  else if (to.y > top) to.lerp(from, (to.y - top) / (to.y - from.y));
  return {
    x: from.x,
    z: from.z,
    end: { x: to.x, z: to.z },
    radius,
    ...(lean === undefined ? {} : { lean }),
    ...(pressRate === undefined ? {} : { pressRate }),
  };
}

/**
 * Tilts a vertex about its instance's root by the instance's tilt and a light wind, rather than
 * shearing it, so a blade keeps its length. The ground is at height 0 wherever scatter grows.
 */
const BEND_VERTEX = /* glsl */ `
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
mvPosition = instanceMatrix * mvPosition;
#endif
vec4 bendWorld = modelMatrix * mvPosition;
float bendHeight = max(bendWorld.y, 0.0);
vec2 wind = vec2(sin(uWindTime * 1.6 + bendWorld.x * 0.9 + bendWorld.z * 0.4), cos(uWindTime * 1.2 + bendWorld.z * 0.8)) * 0.06;
vec2 tilt = aTilt + wind;
float angle = min(length(tilt), ${FLAT_TILT.toFixed(2)});
vec2 tiltDirection = angle > 0.0001 ? tilt / length(tilt) : vec2(0.0);
bendWorld.xz += tiltDirection * bendHeight * sin(angle);
bendWorld.y = bendHeight * cos(angle);
mvPosition = viewMatrix * bendWorld;
gl_Position = projectionMatrix * mvPosition;
`;
