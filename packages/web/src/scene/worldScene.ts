/**
 * The Three.js world scene.
 */
import * as THREE from 'three';
import type { ClientEntity, ClientWorld } from '@/client/clientWorld';
import type { SpeechBubbleRequest, WorldRenderSurface } from '@/client/renderSurface';
import {
  WORLD_TIME_RATE,
  clamp,
  distance,
  groundHeightAt,
  headingRadians,
  hourOfDay,
  objectModel,
  relativeDirection,
  sectorOrigin,
  sectorRect,
} from '@somnio/core';
import type { Heading, ModelRegistry, Point, Rect, Size, SpaceCollision } from '@somnio/core';
import type { Condition, Gait, Placement, SectorView, SpeechKind } from '@somnio/protocol';
import { t } from '@/i18n';
import { CLIP_TRANSITION_DURATION, MAX_TICK_DELTA, MOTION_GRACE_WINDOW, movementPose, resolveClipName, resolveOneShotClipName } from './animation';
import type { AnimationPose, OneShot } from './animation';
import { ORTHO_RIG, cameraPosition, clampedScale, frustumBounds, scaleForZoomFactor } from './cameraRig';
import { ENVIRONMENT_FILL_INTENSITY, SUN_SHADOW, sunState } from './dayNightSun';
import { NAME_PLAQUE, namePlaqueBackground, renderNamePlaque, renderSpeechBubble, speechBubbleFrameSize } from './overlayArt';
import type { BubbleTail, RasterArt } from './overlayArt';
import {
  CHARACTER_SCALE,
  FLOOR_PATCH_LIFT,
  PLACEHOLDER_HEIGHT,
  easedHeight,
  floorUVRect,
  placeholderFootprint,
  placementElevation,
  textureAspect,
} from './placement';
import type { ModelAssets } from './modelAssets';
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
  /** Carries the yaw and the swappable model, so a post-prewarm swap never moves the overlays. */
  modelHolder: THREE.Object3D;
  mixer: THREE.AnimationMixer | undefined;
  action: THREE.AnimationAction | undefined;
  kind: ClientEntity['kind'];
  characterModelId: string;
  name: string;
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
   * How far above its node the model reaches, measured once when the model is put in, standing in
   * its idle pose. A skinned mesh keeps the bounds of the pose it was first measured in, so a first
   * measure of a body that lies fallen would come back low and stay low.
   */
  headHeight: number;
  /** Label under the feet; created once on first placement and rebuilt on a kind, name, or condition change. */
  namePlaque: THREE.Object3D | undefined;
  pose: AnimationPose | undefined;
  condition: Condition;
  /** A clip playing once over the looping pose; `held` keeps its last frame until the entity stands again. */
  oneShot: { action: THREE.AnimationAction; held: boolean } | undefined;
}

/** A speech bubble, with what it was asked to show, so every frame can place it again. */
interface SpeechBubble {
  request: SpeechBubbleRequest;
  node: THREE.Object3D;
  plate: THREE.Mesh;
  size: THREE.Vector2;
  /** The side its art points its tail to, which is redrawn only when it changes. */
  tail: BubbleTail;
  remaining: number;
}

/** Where a bubble goes this frame: over a head, by the door a voice comes through, or at the edge of the screen toward the voice. */
interface BubblePlacement {
  /** Pinned at the screen's edge toward the voice, because there is no room for the bubble where the voice is drawn. */
  atEdge: boolean;
  tail: BubbleTail;
  parent: THREE.Object3D;
  position: THREE.Vector3;
  /** Centred on its point, rather than hung from it by its tail tip. */
  centred: boolean;
}

/** A ring on the ground around a fallen body, drawn further round as the raise goes on. */
interface RaiseRing {
  mesh: THREE.Mesh;
  elapsed: number;
  seconds: number;
}

/** The base floor of a sector or one of its patches. */
interface FloorQuad {
  mesh: THREE.Mesh;
  /** The ground it covers in space coordinates, which is what fixes its texture phase. */
  rect: Rect;
  materialId: string;
  lift: number;
  isFallback: boolean;
}

interface PlacedModel {
  node: THREE.Object3D;
  placement: Placement;
  isPlaceholder: boolean;
}

interface DrawnSector {
  /** Stands at the sector's origin, so its records keep their sector-relative positions. */
  group: THREE.Object3D;
  floors: FloorQuad[];
  placements: PlacedModel[];
}

const PLACEHOLDER_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 1 });

/** Shared zero vector for basis construction; never mutated. */
const ORIGIN = new THREE.Vector3();

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

  private readonly assets: ModelAssets;
  private readonly registry: ModelRegistry;
  private readonly now: () => number;
  private readonly sun = new THREE.DirectionalLight(0xffffff, 1);
  private readonly ambient = new THREE.DirectionalLight(0xffffff, 1);
  private readonly environmentFill = new THREE.AmbientLight(0xffffff, ENVIRONMENT_FILL_INTENSITY);
  /** Retained so `repositionSun` can re-anchor the light without recomputing the day/night state. */
  private readonly sunDirection = new THREE.Vector3(0, 1, 0);
  /** Holds every sector group and entity of the space on screen. */
  private spaceRoot = new THREE.Object3D();
  /** The outgoing space, parked on screen during a held swap. */
  private previousRoot: THREE.Object3D | undefined;
  private pendingPlayerReveal = false;
  private readonly sectors = new Map<string, DrawnSector>();
  private readonly entityStates = new Map<string, EntityRenderState>();
  private readonly bubbles = new Map<string, SpeechBubble>();
  /** The player's own bubble, carried through a door to be hung over them again in the space they enter. */
  private carriedBubble: Pick<SpeechBubble, 'request' | 'remaining'> | undefined;
  /** The short-lived word over an entity a blow missed. */
  private readonly misses = new Map<string, { node: THREE.Object3D; remaining: number }>();
  private readonly raiseRings = new Map<string, RaiseRing>();
  /** The ring round the entity the player tends. */
  private selection: { id: string; mesh: THREE.Mesh } | undefined;
  private readonly raycaster = new THREE.Raycaster();
  private ground: (() => SpaceCollision) | undefined;
  /** The world clock as last told, and when; `undefined` holds the light at noon. */
  private clock: { worldSeconds: number; atMs: number } | undefined;
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
  private aspect = 1;

  constructor(assets: ModelAssets, registry: ModelRegistry, aspect = 1, now: () => number = () => performance.now()) {
    this.assets = assets;
    this.registry = registry;
    this.now = now;
    this.aspect = aspect;
    const bounds = frustumBounds(ORTHO_RIG.defaultScale, aspect);
    this.camera = new THREE.OrthographicCamera(bounds.left, bounds.right, bounds.top, bounds.bottom, ORTHO_RIG.nearClip, ORTHO_RIG.farClip);
    this.configureSunShadow();
    // A fixed low fill standing in for sky ambience, so the shadow side never drops to black.
    this.ambient.position.set(-0.3, 1, -0.4).multiplyScalar(30);
    // The target's world matrix is what gives a directional light its direction, and an object
    // outside the graph never gets one updated.
    this.scene.add(this.sun, this.sun.target, this.ambient, this.environmentFill, this.spaceRoot);
    // The void outside the floor, so every space sits on black rather than the default clear
    // colour — including during a swap.
    const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshBasicMaterial({ color: 0x000000 }));
    backdrop.rotation.x = -Math.PI / 2;
    backdrop.position.y = -0.005;
    this.scene.add(backdrop);
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
   */
  setViewportAspect(aspect: number): void {
    this.aspect = aspect;
    this.applyFraming();
  }

  applyZoomFactor(factor: number): void {
    this.zoomFactor = factor;
    this.applyFraming();
  }

  private applyFraming(): void {
    const bounds = frustumBounds(scaleForZoomFactor(this.zoomFactor), this.aspect);
    this.camera.left = bounds.left;
    this.camera.right = bounds.right;
    this.camera.top = bounds.top;
    this.camera.bottom = bounds.bottom;
    this.camera.updateProjectionMatrix();
  }

  /** Warms the cache, then re-resolves everything still rendering a placeholder. */
  async prewarm(): Promise<void> {
    await this.assets.prewarm();
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
    this.carriedBubble = hold && own !== undefined ? { request: own.request, remaining: own.remaining } : undefined;
    disposeSubtree(this.previousRoot);
    if (hold) {
      this.previousRoot = this.spaceRoot;
    } else {
      disposeSubtree(this.spaceRoot);
      this.previousRoot = undefined;
      this.litBrightness = undefined;
    }
    this.sectors.clear();
    this.entityStates.clear();
    this.bubbles.clear();
    this.misses.clear();
    this.raiseRings.clear();
    this.selection = undefined;
    this.cameraFollowId = undefined;
    this.spaceBrightness = undefined;
    this.room = undefined;
    this.spaceRoot = new THREE.Object3D();
    this.spaceRoot.visible = !hold;
    this.scene.add(this.spaceRoot);
    this.pendingPlayerReveal = hold;
  }

  /** Atomic swap once the local player lands: drop the held space and show the new one. */
  private revealHeldSpaceIfPending(): void {
    if (!this.pendingPlayerReveal) return;
    disposeSubtree(this.previousRoot);
    this.previousRoot = undefined;
    this.spaceRoot.visible = true;
    this.pendingPlayerReveal = false;
    // Applied in the same frame the new space becomes visible, so the light change and the geometry
    // change land together rather than one flashing ahead of the other.
    this.litBrightness = this.spaceBrightness;
    this.relight();
  }

  /** Draws a sector at its origin, replacing one already drawn under the same name. */
  addSector(sector: SectorView): void {
    this.removeSector(sector.name);
    const origin = sectorOrigin(sector);
    const group = new THREE.Object3D();
    group.position.set(origin.x, 0, origin.z);
    const floors = [
      this.buildFloorQuad(sectorRect(sector), sector.floorMaterialId, 0, origin),
      ...sector.floorPatches.map((patch) =>
        this.buildFloorQuad(
          { x: origin.x + patch.x, z: origin.z + patch.z, width: patch.width, depth: patch.depth },
          patch.floorMaterialId,
          FLOOR_PATCH_LIFT,
          origin,
        ),
      ),
    ];
    const placements = sector.placements.map((placement) => this.buildPlacement(placement));
    group.add(...floors.map((floor) => floor.mesh), ...placements.map((placed) => placed.node));
    this.spaceRoot.add(group);
    this.sectors.set(sector.name, { group, floors, placements });
    if (sector.kind === 'interior') this.room = sectorRect(sector);
    this.spaceBrightness = sector.brightness;
    // Held back while a space is parked on screen: lighting by the incoming interior now would
    // relight the still-visible outgoing space, which is the flash the hold exists to prevent.
    if (!this.pendingPlayerReveal) {
      this.litBrightness = sector.brightness;
      this.relight();
    }
  }

  removeSector(name: string): void {
    disposeSubtree(this.sectors.get(name)?.group);
    this.sectors.delete(name);
  }

  placeEntity(entity: ClientEntity): void {
    let state = this.entityStates.get(entity.id);
    if (state === undefined) {
      const node = new THREE.Object3D();
      const modelHolder = new THREE.Object3D();
      node.add(modelHolder);
      this.spaceRoot.add(node);
      state = {
        node,
        modelHolder,
        mixer: undefined,
        action: undefined,
        kind: entity.kind,
        characterModelId: entity.characterModelId,
        name: entity.name,
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
        namePlaque: undefined,
        pose: undefined,
        condition: entity.condition,
        oneShot: undefined,
      };
      this.entityStates.set(entity.id, state);
      this.resolveEntityModel(state);
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
    }
    // Rebuilt on a kind or name change, because both pick the plaque's fill and its width.
    if (state.namePlaque === undefined || kindChanged || state.name !== entity.name) {
      state.name = entity.name;
      this.rebuildNamePlaque(state);
    }
    if (state.condition !== entity.condition) this.updateCondition(entity.id, entity.condition);

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
      this.revealHeldSpaceIfPending();
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

  /** The plaque takes the condition's tint, and a fallen entity drops and stays down until it stands again. */
  updateCondition(entityId: string, condition: Condition): void {
    const state = this.entityStates.get(entityId);
    if (state === undefined) return;
    state.condition = condition;
    this.rebuildNamePlaque(state);
    if (condition === 'fallen') {
      this.playOneShot(state, 'fallen');
    } else if (state.oneShot?.held === true) {
      this.endOneShot(state);
    }
  }

  showBlow(attackerId: string, targetId: string | undefined, hit: boolean): void {
    const attacker = this.entityStates.get(attackerId);
    if (attacker !== undefined) this.playOneShot(attacker, 'swing');
    const target = targetId === undefined ? undefined : this.entityStates.get(targetId);
    if (targetId === undefined || target === undefined) return;
    if (hit) {
      this.playOneShot(target, 'flinch');
      return;
    }
    disposeSubtree(this.misses.get(targetId)?.node);
    const node = missQuad();
    node.position.set(0, target.headHeight + BUBBLE_HEAD_GAP, 0);
    target.node.add(node);
    this.misses.set(targetId, { node, remaining: MISS_SECONDS });
  }

  showRaising(targetId: string, seconds: number | undefined): void {
    disposeSubtree(this.raiseRings.get(targetId)?.mesh);
    this.raiseRings.delete(targetId);
    const state = this.entityStates.get(targetId);
    if (state === undefined || seconds === undefined) return;
    // It starts with nothing drawn: the tick widens its draw range as the raise goes on.
    const mesh = groundRingMesh(state.radius * RAISE_RING_RADII, RAISE_RING_COLOR);
    mesh.geometry.setDrawRange(0, 0);
    state.node.add(mesh);
    this.raiseRings.set(targetId, { mesh, elapsed: 0, seconds });
  }

  showSelection(entityId: string | undefined): void {
    disposeSubtree(this.selection?.mesh);
    this.selection = undefined;
    const state = entityId === undefined ? undefined : this.entityStates.get(entityId);
    if (entityId === undefined || state === undefined) return;
    const mesh = groundRingMesh(state.radius * SELECTION_RING_RADII, SELECTION_RING_COLOR);
    state.node.add(mesh);
    this.selection = { id: entityId, mesh };
  }

  /**
   * The entity drawn under a point of the viewport, in normalized device coordinates, other than
   * the one the camera follows. An entity is picked as an upright capsule from its feet to its
   * head, a little wider than its body, and the one nearest the camera wins.
   */
  entityAt(x: number, y: number): string | undefined {
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(new THREE.Vector2(x, y), this.camera);
    const ray = this.raycaster.ray;
    const top = new THREE.Vector3();
    const onRay = new THREE.Vector3();
    let picked: string | undefined;
    let nearest = Number.POSITIVE_INFINITY;
    for (const [id, state] of this.entityStates) {
      if (id === this.cameraFollowId) continue;
      const feet = state.node.position;
      top.copy(feet).setY(feet.y + state.headHeight);
      const reach = state.radius * PICK_RADII;
      if (ray.distanceSqToSegment(feet, top, onRay) > reach * reach) continue;
      const along = onRay.distanceToSquared(ray.origin);
      if (along >= nearest) continue;
      picked = id;
      nearest = along;
    }
    return picked;
  }

  setClock(worldSeconds: number): void {
    this.clock = { worldSeconds, atMs: this.now() };
    this.relight();
  }

  showSpeechBubble(request: SpeechBubbleRequest): boolean {
    // Disposed, not just detached: speaking twice inside one lifetime window would otherwise leak
    // a supersampled canvas texture per message, which is unbounded within a single space.
    disposeSubtree(this.bubbles.get(request.entityId)?.node);
    this.bubbles.delete(request.entityId);
    if (request.lines.length === 0) return false;
    const placement = this.bubblePlacement(request);
    const bubble: SpeechBubble = { request, remaining: request.lifetimeMs / 1000, ...speechBubbleQuad(request, placement.tail) };
    this.bubbles.set(request.entityId, bubble);
    this.placeBubble(bubble, placement);
    return placement.atEdge;
  }

  /**
   * A speaker drawn on screen with room above their head has the bubble hung over it, which is also
   * where it goes once a speaker not yet drawn arrives. A speaker with no body here is heard through
   * a door or from out of view, so the bubble goes by the spot the voice comes from. Outdoors it
   * hangs over that spot at doorway height, on the building over a door. In a room it goes just past
   * the wall toward it, in the dark around the floor. Where that spot is off screen or has no room,
   * the bubble is pinned where the line from the player toward the voice leaves the screen.
   */
  private bubblePlacement(request: SpeechBubbleRequest): BubblePlacement {
    this.camera.updateMatrixWorld();
    const state = this.entityStates.get(request.entityId);
    const lineCount = request.lines.length;
    if (state !== undefined) {
      const feet = state.node.position;
      const head = new THREE.Vector3(feet.x, feet.y + state.headHeight + BUBBLE_HEAD_GAP, feet.z);
      if (this.hasRoomAbove(head, lineCount, request.kind)) {
        return { atEdge: false, tail: 'down', parent: state.node, position: head.sub(feet), centred: false };
      }
      return this.edgePlacement(feet.clone(), lineCount, request.kind);
    }
    const source = new THREE.Vector3(request.source.x, this.groundHeight(request.source), request.source.z);
    if (this.room !== undefined)
      return this.beyondWallPlacement(this.room, request.source, lineCount, request.kind) ?? this.edgePlacement(source, lineCount, request.kind);
    const doorway = source.clone().setY(source.y + DOORWAY_VOICE_HEIGHT);
    if (this.hasRoomAbove(doorway, lineCount, request.kind)) {
      return { atEdge: false, tail: 'down', parent: this.spaceRoot, position: doorway, centred: false };
    }
    return this.edgePlacement(source, lineCount, request.kind);
  }

  /**
   * Pinned where the line from the player toward `voice` leaves the screen, inset so the whole
   * bubble shows. That line is taken on screen rather than on the ground, because the camera's yaw
   * and pitch turn every ground bearing.
   */
  private edgePlacement(voice: THREE.Vector3, lineCount: number, kind: SpeechKind): BubblePlacement {
    const from = this.focus.clone().project(this.camera);
    const toward = voice.project(this.camera);
    let dx = toward.x - from.x;
    let dy = toward.y - from.y;
    // A voice on the player's own spot has no direction; it is pinned to the top, its tail down onto the player.
    const ownSpot = Math.hypot(dx, dy) < SAME_SPOT_NDC;
    if (ownSpot) [dx, dy] = [0, 1];
    const half = this.ndcPerMetre();
    const size = pinnedBubbleSize(lineCount, kind);
    // Where the bubble is larger than the screen on an axis, the inset would invert: it is centred there instead.
    const limitX = 1 - (size.width / 2) * half.x;
    const limitY = 1 - (size.height / 2) * half.y;
    const reachX = limitX > 0 && dx !== 0 ? (Math.sign(dx) * limitX - from.x) / dx : Number.POSITIVE_INFINITY;
    const reachY = limitY > 0 && dy !== 0 ? (Math.sign(dy) * limitY - from.y) / dy : Number.POSITIVE_INFINITY;
    const reach = Math.min(reachX, reachY);
    const along = (start: number, delta: number, limit: number): number =>
      limit <= 0 ? 0 : clamp(Number.isFinite(reach) ? start + delta * reach : start, -limit, limit);
    return {
      atEdge: true,
      tail: ownSpot ? 'down' : tailToward(reachX <= reachY, dx, dy),
      parent: this.spaceRoot,
      position: new THREE.Vector3(along(from.x, dx, limitX), along(from.y, dy, limitY), from.z).unproject(this.camera),
      centred: true,
    };
  }

  /**
   * In a room, a voice from its door is shown in the dark just past the wall it comes through, on
   * the screen side that wall lies on, with its tail toward the wall. `undefined` when that spot is
   * not on screen.
   */
  private beyondWallPlacement(room: Rect, source: Point, lineCount: number, kind: SpeechKind): BubblePlacement | undefined {
    const inside = { x: clamp(source.x, room.x, room.x + room.width), z: clamp(source.z, room.z, room.z + room.depth) };
    const walls = [
      { x: room.x, z: inside.z },
      { x: room.x + room.width, z: inside.z },
      { x: inside.x, z: room.z },
      { x: inside.x, z: room.z + room.depth },
    ];
    const gaps = walls.map((wall) => distance(wall, inside));
    const wall = walls[gaps.indexOf(Math.min(...gaps))]!;
    const middle = new THREE.Vector3(room.x + room.width / 2, 0, room.z + room.depth / 2).project(this.camera);
    const half = this.ndcPerMetre();
    // Directions on screen are taken in metres, so the screen's aspect does not bend them.
    const metres = (point: THREE.Vector3) => ({ x: (point.x - middle.x) / half.x, y: (point.y - middle.y) / half.y });
    const foot = metres(new THREE.Vector3(wall.x, 0, wall.z).project(this.camera));
    const length = Math.hypot(foot.x, foot.y);
    if (length === 0) return undefined;
    const out = { x: foot.x / length, y: foot.y / length };
    // The wall's foot or its top, whichever is drawn further out: the wall itself is not the dark.
    const top = metres(new THREE.Vector3(wall.x, ROOM_WALL_HEIGHT, wall.z).project(this.camera));
    const edge = top.x * out.x + top.y * out.y > length ? top : foot;
    const size = pinnedBubbleSize(lineCount, kind);
    const clearance = BEYOND_WALL_GAP + (Math.abs(out.x) * size.width) / 2 + (Math.abs(out.y) * size.height) / 2;
    const centre = { x: middle.x + (edge.x + out.x * clearance) * half.x, y: middle.y + (edge.y + out.y * clearance) * half.y };
    if (Math.abs(centre.x) > 1 - (size.width / 2) * half.x || Math.abs(centre.y) > 1 - (size.height / 2) * half.y) return undefined;
    return {
      atEdge: false,
      tail: tailToward(Math.abs(out.x) >= Math.abs(out.y), -out.x, -out.y),
      parent: this.spaceRoot,
      position: new THREE.Vector3(centre.x, centre.y, this.focus.clone().project(this.camera).z).unproject(this.camera),
      centred: true,
    };
  }

  /**
   * Whether `anchor` is on screen with room above it for the whole of a bubble hung from it, and
   * to either side for at most a quarter of the screen, so a narrow window keeps bubbles overhead.
   */
  private hasRoomAbove(anchor: THREE.Vector3, lineCount: number, kind: SpeechKind): boolean {
    const drawn = anchor.clone().project(this.camera);
    const half = this.ndcPerMetre();
    const size = speechBubbleFrameSize(lineCount, 'down', kind);
    const marginX = Math.min((size.width / 2) * OVERLAY_METRES_PER_PIXEL * half.x, MAX_SIDE_MARGIN_NDC);
    const marginY = size.height * OVERLAY_METRES_PER_PIXEL * half.y;
    return Math.abs(drawn.x) <= 1 - marginX && drawn.y >= -1 && drawn.y <= 1 - marginY;
  }

  /** How far a metre reaches across the screen, in normalized device coordinates. */
  private ndcPerMetre(): { x: number; y: number } {
    return { x: 2 / (this.camera.right - this.camera.left), y: 2 / (this.camera.top - this.camera.bottom) };
  }

  /** Moves a bubble to its placement, redrawing its art when the tail changes side. */
  private placeBubble(bubble: SpeechBubble, placement: BubblePlacement): void {
    if (bubble.tail !== placement.tail) {
      disposeSubtree(bubble.node);
      Object.assign(bubble, speechBubbleQuad(bubble.request, placement.tail));
    }
    if (bubble.node.parent !== placement.parent) placement.parent.add(bubble.node);
    bubble.node.position.copy(placement.position);
    // Hung from a point, the tail tip is the anchor and the body rises above it.
    bubble.plate.position.y = placement.centred ? 0 : bubble.size.y / 2;
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
    state.modelHolder.updateMatrixWorld(true);
    return Math.max(new THREE.Box3().setFromObject(state.modelHolder).max.y - state.node.position.y, 0);
  }

  removeEntity(entityId: string): void {
    const state = this.entityStates.get(entityId);
    disposeSubtree(state?.node);
    this.entityStates.delete(entityId);
    // A pinned bubble hangs off the space rather than the entity's node, so it goes on its own.
    disposeSubtree(this.bubbles.get(entityId)?.node);
    this.bubbles.delete(entityId);
    this.misses.delete(entityId);
    this.raiseRings.delete(entityId);
    if (this.selection?.id === entityId) this.selection = undefined;
  }

  showSplash(): void {
    // Also drops any space parked for a swap the splash interrupts (a Leave Game mid-door).
    this.startSpace(false);
    this.ground = undefined;
    this.relight();
    this.focusCamera(new THREE.Vector3());
  }

  /** What the player was saying as they went through a door goes on over their head for the rest of its time. */
  private hangCarriedBubble(player: ClientEntity): void {
    const carried = this.carriedBubble;
    if (carried?.request.entityId !== player.id) return;
    this.carriedBubble = undefined;
    this.showSpeechBubble({ ...carried.request, source: player.position, lifetimeMs: carried.remaining * 1000 });
  }

  private groundHeight(position: Point): number {
    return this.ground === undefined ? 0 : groundHeightAt(this.ground(), position);
  }

  /** Pure accumulation over per-entity state, so yaw and pose behaviour is testable directly. */
  tick(deltaTimeSeconds: number): void {
    const dt = Math.min(deltaTimeSeconds, MAX_TICK_DELTA);
    this.sceneClock += dt;
    this.relight();

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

      const direction = state.travelHeading === undefined ? 'forward' : relativeDirection(state.travelHeading, state.facing);
      if (!this.oneShotIsPlaying(state)) this.applyPose(isMoving ? movementPose(state.kind, state.gait, direction) : 'idle', state);
      state.mixer?.update(dt);
    }

    for (const bubble of this.bubbles.values()) this.placeBubble(bubble, this.bubblePlacement(bubble.request));
    for (const overlays of [this.bubbles, this.misses]) {
      for (const [id, overlay] of overlays) {
        overlay.remaining -= dt;
        if (overlay.remaining <= 0) {
          disposeSubtree(overlay.node);
          overlays.delete(id);
        }
      }
    }

    for (const ring of this.raiseRings.values()) {
      ring.elapsed = Math.min(ring.elapsed + dt, ring.seconds);
      ring.mesh.geometry.setDrawRange(0, Math.floor((ring.elapsed / ring.seconds) * RING_SEGMENTS) * 6);
    }
  }

  /**
   * Plays a one-shot over the looping pose. A model that carries none of its clips keeps its
   * pose, and nothing interrupts a held fall.
   */
  private playOneShot(state: EntityRenderState, oneShot: OneShot): void {
    if (state.mixer === undefined || state.oneShot?.held === true) return;
    const clips = this.assets.clipsFor(state.modelHolder.children[0] ?? state.modelHolder);
    const name = resolveOneShotClipName(
      oneShot,
      clips.map((clip) => clip.name),
    );
    const clip = clips.find((candidate) => candidate.name === name);
    if (clip === undefined) return;
    const next = state.mixer.clipAction(clip);
    next.setLoop(THREE.LoopOnce, 1);
    next.clampWhenFinished = true;
    this.fadeTo(state, next);
    state.oneShot = { action: next, held: oneShot === 'fallen' };
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

  /** Players and NPCs get a plaque, and a nightmare one only while it is not hale; the local player's text is bold. */
  private rebuildNamePlaque(state: EntityRenderState): void {
    disposeSubtree(state.namePlaque);
    state.namePlaque = undefined;
    const background = namePlaqueBackground(state.kind, state.condition);
    if (background === undefined) return;
    const ink = state.kind !== 'npc' && state.condition === 'fallen' ? NAME_PLAQUE.fallenInk : NAME_PLAQUE.ink;
    const plaque = namePlaqueQuad(state.name, background, state.kind === 'player', ink);
    state.node.add(plaque);
    state.namePlaque = plaque;
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
    if (state.condition === 'fallen') this.playOneShot(state, 'fallen');
  }

  /**
   * One textured quad on the ground: a sector's base floor, or a patch lifted just above it.
   * `origin` is the sector group's position, which the mesh is placed relative to.
   */
  private buildFloorQuad(rect: Rect, materialId: string, lift: number, origin: Point): FloorQuad {
    const texture = this.assets.floorTexture(materialId);
    const geometry = new THREE.PlaneGeometry(rect.width, rect.depth);
    const uv = floorUVRect(rect, textureAspect(texture?.image as { width: number; height: number } | undefined));
    // V is **negated**. `PlaneGeometry` emits indices 0/1 as the local +Y row, which
    // `rotation.x = -pi/2` maps to world -Z — the smaller z. So V has to decrease as z grows, and
    // negating makes it a function of z alone: with an intercept that depended on the quad's own
    // position and depth, each quad would mirror about its own centre and abutting rects would
    // meet at two different phases.
    const attribute = geometry.getAttribute('uv') as THREE.BufferAttribute;
    const corners = [
      [uv.origin.x, -uv.origin.y],
      [uv.origin.x + uv.span.x, -uv.origin.y],
      [uv.origin.x, -(uv.origin.y + uv.span.y)],
      [uv.origin.x + uv.span.x, -(uv.origin.y + uv.span.y)],
    ];
    corners.forEach(([u, v], index) => attribute.setXY(index, u!, v!));
    attribute.needsUpdate = true;

    // Cloned because the mesh owns its material, and disposal takes the material's map with it.
    // Handing over the cache entry itself would leave the next quad that paints this material
    // re-uploading the texture and regenerating its mipmaps on the first drawn frame.
    const map = texture?.clone();
    if (map !== undefined) map.needsUpdate = true;
    const material = new THREE.MeshStandardMaterial({
      roughness: 1,
      metalness: 0,
      ...(map === undefined ? { color: new THREE.Color(0x808080) } : { map }),
    });
    const mesh = new THREE.Mesh(geometry, material);
    markOwned(mesh, { geometry: true, material: true });
    // Receives but does not cast: a ground plane casting into its own depth comparison is the
    // classic source of shadow acne, and there is nothing below it to catch a shadow anyway.
    mesh.receiveShadow = true;
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(rect.x - origin.x + rect.width / 2, lift, rect.z - origin.z + rect.depth / 2);
    return { mesh, rect, materialId, lift, isFallback: texture === undefined };
  }

  /** A placement stands at its record's position and yaw; the model's own origin is its ground-footprint centre. */
  private buildPlacement(placement: Placement): PlacedModel {
    const rule = objectModel(this.registry, placement.modelId);
    const model = this.assets.object(placement.modelId);
    const node = new THREE.Object3D();
    node.add(model ?? placementPlaceholder(placeholderFootprint(rule)));
    enableShadows(node);
    node.position.set(placement.x, placementElevation(placement, rule), placement.z);
    node.rotation.y = THREE.MathUtils.degToRad(placement.yaw);
    return { node, placement, isPlaceholder: model === undefined };
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
        // The placeholder owns its `BoxGeometry`, so it is disposed rather than just unparented.
        for (const child of [...placed.node.children]) disposeSubtree(child);
        placed.node.add(model);
        enableShadows(model);
        placed.isPlaceholder = false;
      }
      // Floors heal like every placed model rather than staying grey. Rebuilt rather than
      // re-textured in place: the UVs depend on the texture's aspect, so the attribute has to be
      // recomputed alongside the map.
      sector.floors = sector.floors.map((floor) => {
        if (!floor.isFallback || this.assets.floorTexture(floor.materialId) === undefined) return floor;
        const rebuilt = this.buildFloorQuad(floor.rect, floor.materialId, floor.lift, { x: sector.group.position.x, z: sector.group.position.z });
        sector.group.add(rebuilt.mesh);
        disposeSubtree(floor.mesh);
        return rebuilt;
      });
    }
    for (const state of this.entityStates.values()) {
      if (state.isPlaceholder) this.resolveEntityModel(state);
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
    const hour = clock === undefined ? 12 : hourOfDay(clock.worldSeconds + ((this.now() - clock.atMs) / 1000) * WORLD_TIME_RATE);
    const state = sunState(hour, this.litBrightness);
    this.sunDirection.set(state.direction.x, state.direction.y, state.direction.z);
    this.repositionSun();
    this.sun.intensity = state.sunIntensity / 1000;
    this.sun.color.setRGB(state.sunColor.r, state.sunColor.g, state.sunColor.b);
    this.ambient.intensity = state.ambientIntensity / 1000;
  }

  private focusCamera(focus: THREE.Vector3): void {
    this.focus.copy(focus);
    const position = cameraPosition({ x: focus.x, y: focus.y, z: focus.z });
    this.camera.position.set(position.x, position.y, position.z);
    this.camera.lookAt(focus);
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

  /**
   * The drawn node of a placement, so a live drag can move and turn the real mesh. Floor
   * patches have no counterpart: their texture phase is baked into their geometry.
   */
  placementNode(sectorName: string, placementId: string): THREE.Object3D | undefined {
    return this.sectors.get(sectorName)?.placements.find((placed) => placed.placement.id === placementId)?.node;
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
   * The counterpart to `_yawFor`, and separate from it on purpose — the plaque and the speech
   * bubble hang off this node, so a facing yaw reaching it tilts them with the character. Reading
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
    const feet = state.node.position;
    const point = new THREE.Vector3(feet.x, feet.y + state.headHeight / 2, feet.z).project(this.camera);
    return { x: point.x, y: point.y };
  }

  /**
   * Test seam: a speaker's live speech-bubble node.
   *
   * The bubble is the scene's highest-frequency allocator — one supersampled `CanvasTexture` per
   * chat line — and it is replaced, expired, and torn down through three separate paths. Reaching it
   * by name is what lets a test spy on the texture it is about to lose; searching the graph for it
   * cannot distinguish a bubble from the name plaque hanging off the same node.
   */
  _bubbleNodeFor(entityId: string): THREE.Object3D | undefined {
    return this.bubbles.get(entityId)?.node;
  }
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

/** World metres per pixel of overlay artwork. */
const OVERLAY_METRES_PER_PIXEL = 0.016;

/**
 * Fixed screen-aligned orientation for overlay quads: the camera's **own** orientation.
 *
 * Constant because the rig is locked — only the camera's position follows the player. Rebuilding it
 * from `pitchDegrees`/`yawDegrees` as Euler angles instead looks right and is not: those describe
 * the rig's offset direction, not the look rotation, and a quad carrying them sits at a residual
 * yaw that foreshortens its width. The artwork then reads as a squeezed balloon with its last word
 * apparently cut off, which is a texture-mapping symptom of a rotation bug.
 */
const OVERLAY_ORIENTATION = (() => {
  const eye = cameraPosition({ x: 0, y: 0, z: 0 });
  // `Matrix4.lookAt` uses the camera convention (-Z forward). A `PlaneGeometry` faces +Z, so the
  // camera's rotation turns the plane's front back toward the eye.
  const matrix = new THREE.Matrix4().lookAt(new THREE.Vector3(eye.x, eye.y, eye.z), new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0));
  return new THREE.Quaternion().setFromRotationMatrix(matrix);
})();
/** Gap between the speaker's head and the balloon's tail tip. */
const BUBBLE_HEAD_GAP = 0.2;
/** How much of a speech bubble's opacity is left at the far end of the band, where speech crumbles away. */
const FAINTEST_BUBBLE_OPACITY = 0.15;
/** The most of the screen a head needs to either side to keep its bubble, in normalized device coordinates. */
const MAX_SIDE_MARGIN_NDC = 0.5;
/** How close on screen a voice is to the player before it has no direction. */
const SAME_SPOT_NDC = 1e-3;
/** Drawn after the world, so nothing at a bubble's spot of the screen covers it. */
const BUBBLE_RENDER_ORDER = 10;
/** How high over a doorway outdoors a voice through it hangs its bubble: on the building, above the door. */
const DOORWAY_VOICE_HEIGHT = 2.2;
/** How high a room's walls are taken to be drawn, so a bubble past one clears its top. */
const ROOM_WALL_HEIGHT = 2.5;
/** The gap on screen, in metres, between a room's wall and a bubble past it. */
const BEYOND_WALL_GAP = 0.3;
/** How long the word over a missed entity stays up. */
const MISS_SECONDS = 0.8;
const RING_SEGMENTS = 48;
const RAISE_RING_COLOR = 0xc9a6ff;
/** A ring's inner radius in body radii: the raise ring clears a body lying down, the selection ring sits inside it. */
const RAISE_RING_RADII = 2;
const SELECTION_RING_RADII = 1.4;
const SELECTION_RING_COLOR = 0xffe9a3;
/** How much wider than its body an entity is to the cursor. */
const PICK_RADII = 1.5;
/** Gap between the feet anchor and the top of the name plaque. */
const PLAQUE_FEET_GAP = 0.15;
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

/** Marks a mesh's allocations as this file's to release. */
function markOwned(mesh: THREE.Mesh, options: { geometry: boolean; material: boolean }): void {
  mesh.userData[OWNS_GEOMETRY] = options.geometry;
  mesh.userData[OWNS_MATERIAL] = options.material;
}

/**
 * Releases the GPU resources a detached subtree owned, then detaches it.
 *
 * `removeFromParent()` alone drops the reference but leaves the geometry, material, and texture in
 * `WebGLRenderer`'s internal maps, so every door and every chat bubble would accumulate VRAM
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
    const mesh = object as THREE.Mesh;
    if (mesh.userData[OWNS_GEOMETRY] === true) mesh.geometry.dispose();
    if (mesh.userData[OWNS_MATERIAL] !== true) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      // Safe to take the map with the material because every owned material holds a texture this
      // file minted: the floor and its patches clone their cached entry, and each overlay rasterizes
      // a fresh `CanvasTexture`. Disposing a cache entry directly would corrupt nothing, but
      // `WebGLTextures` clears its `__version` unconditionally, so the next quad using that
      // material would pay a full re-upload and mipmap regeneration on its first drawn frame.
      (material as THREE.MeshBasicMaterial).map?.dispose();
      material.dispose();
    }
  });
  root.removeFromParent();
}

/**
 * Overlay quad with a **fixed** screen-aligned orientation rather than a billboard.
 *
 * A billboard aims each quad at the camera *point*, which under an orthographic projection
 * leaves off-centre speakers visibly tilted — the camera rig is locked, so a constant
 * orientation is both correct and cheaper.
 *
 * Returns the container and the plate separately so the caller can position the plate inside the
 * screen-aligned frame, where +Y is camera-up and +Z is toward the camera.
 */
function overlayQuad(art: RasterArt): { container: THREE.Object3D; plate: THREE.Mesh; size: THREE.Vector2 } {
  const container = new THREE.Object3D();
  container.quaternion.copy(OVERLAY_ORIENTATION);
  const texture = new THREE.CanvasTexture(art.canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true });
  const size = new THREE.Vector2(art.widthPixels * OVERLAY_METRES_PER_PIXEL, art.heightPixels * OVERLAY_METRES_PER_PIXEL);
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(size.x, size.y), material);
  // Every overlay quad allocates its own canvas texture, material, and geometry.
  markOwned(plate, { geometry: true, material: true });
  container.add(plate);
  return { container, plate, size };
}

/**
 * A balloon in the request's style, its tail on `tail`, as faint as the line was heard. It draws
 * over everything, so a building, a tree, or a wall nearer the camera cannot hide what was said.
 */
function speechBubbleQuad(request: SpeechBubbleRequest, tail: BubbleTail): Pick<SpeechBubble, 'node' | 'plate' | 'size' | 'tail'> {
  const { container, plate, size } = overlayQuad(renderSpeechBubble(request.lines, tail, request.kind));
  const material = plate.material as THREE.MeshBasicMaterial;
  material.opacity = FAINTEST_BUBBLE_OPACITY + (1 - FAINTEST_BUBBLE_OPACITY) * request.clarity;
  material.depthTest = false;
  material.depthWrite = false;
  plate.renderOrder = BUBBLE_RENDER_ORDER;
  return { node: container, plate, size, tail };
}

/** The largest a bubble of `lineCount` lines placed on the screen is, in metres, whichever side its tail points to. */
function pinnedBubbleSize(lineCount: number, kind: SpeechKind): { width: number; height: number } {
  const below = speechBubbleFrameSize(lineCount, 'down', kind);
  const beside = speechBubbleFrameSize(lineCount, 'right', kind);
  return { width: Math.max(below.width, beside.width) * OVERLAY_METRES_PER_PIXEL, height: Math.max(below.height, beside.height) * OVERLAY_METRES_PER_PIXEL };
}

function tailToward(horizontal: boolean, x: number, y: number): BubbleTail {
  if (horizontal) return x > 0 ? 'right' : 'left';
  return y > 0 ? 'up' : 'down';
}

/**
 * Name plaque hanging just below the feet anchor.
 *
 * Hanging at negative Y alone would dip the quad below the floor plane, which always occludes
 * below-ground content under the downward 3/4 camera. The toward-camera Z advance compensates —
 * invisible under the orthographic projection, but it lifts the quad's world height above the
 * floor and draws it in front of the speaker.
 */
function namePlaqueQuad(name: string, background: string, bold: boolean, ink: string): THREE.Object3D {
  const { container, plate, size } = overlayQuad(renderNamePlaque(name, background, bold, ink));
  const drop = size.y + PLAQUE_FEET_GAP;
  const pitch = (ORTHO_RIG.pitchDegrees * Math.PI) / 180;
  plate.position.set(0, -(size.y / 2 + PLAQUE_FEET_GAP), drop / Math.tan(pitch) + PLAQUE_FLOOR_CLEARANCE);
  return container;
}

/** The word over an entity a blow missed, standing where a speech bubble's tail would. */
function missQuad(): THREE.Object3D {
  const { container, plate, size } = overlayQuad(renderNamePlaque(t('miss'), NAME_PLAQUE.playerBackground, false));
  plate.position.y = size.y / 2;
  return container;
}

/** A flat ring just above the ground round an entity's feet. */
function groundRingMesh(innerRadius: number, color: number): THREE.Mesh {
  const geometry = new THREE.RingGeometry(innerRadius, innerRadius + 0.08, RING_SEGMENTS, 1);
  const material = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthWrite: false });
  const mesh = new THREE.Mesh(geometry, material);
  markOwned(mesh, { geometry: true, material: true });
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.03;
  return mesh;
}
