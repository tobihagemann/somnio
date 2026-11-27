import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import * as THREE from 'three';
import { WorldScene, configureWorldRenderer, sizeWorldRenderer, watchViewport } from '@/scene/worldScene';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { HttpModelAssets, prototypeMeshesOf } from '@/scene/modelAssets';
import type { ModelAssets } from '@/scene/modelAssets';
import { ORTHO_RIG, PLAYER_ZOOM, cameraPosition, frustumBounds, offsetDirection, scaleForZoomFactor } from '@/scene/cameraRig';
import { SUN_SHADOW, doorLightState, sunState } from '@/scene/dayNightSun';
import { PROP_LIGHT_POOL_SIZE, PROP_LIGHT_PRESETS } from '@/scene/propLights';
import { CLIP_TRANSITION_DURATION, MAX_TICK_DELTA } from '@/scene/animation';
import { STRIKE_AT } from '@/scene/combatEffects';
import { ELITE_AURA_NAME, ELITE_AURA_POOL_SIZE, ELITE_TRAIT_COLORS } from '@/scene/eliteAuras';
import { QUEST_MARKER_NAME, QUEST_MARKER_POOL_SIZE } from '@/scene/questMarkers';
import { PORTRAIT_LAYERS } from '@/scene/portraits';
import { LOOT_BEAM_NAME, LOOT_FADE_SECONDS, LOOT_GLOW_NAME, LOOT_MARKERS_NAME, LOOT_MARKER_POOL_SIZE, LootMarkers, RARITY_COLORS } from '@/scene/lootMarkers';
import { CHARACTER_SCALE, PLACEHOLDER_HEIGHT } from '@/scene/placement';
import { GrassSpring } from '@/scene/grassSpring';
import { rasterizeGround } from '@/scene/groundField';
import type { GroundRasterizer } from '@/scene/groundRasterizer';
import { PEBBLE_MODEL_ID, scatterSector } from '@/scene/scatter';
import type { Scatterer } from '@/scene/scatterer';
import {
  NAME_PLAQUE,
  OVERLAY_METRES_PER_PIXEL,
  OVERLAY_MIN_SCREEN_PIXELS,
  baselineBelowBoxTop,
  baselineInCenteredBox,
  namePlaqueBackground,
  lineBoxHeight,
  overlayMagnification,
  paintSpeechBubble,
  renderNamePlaque,
  speechBubbleFrameSize,
} from '@/scene/overlayArt';
import { paintBubbles } from '@/scene/bubbleLayer';
import type { PlacedBubble } from '@/scene/bubbleLayer';
import { tailTip } from '@/scene/bubbleLayout';
import type { ScreenPoint } from '@/scene/bubbleLayout';
import { PEOPLES, groundHeightAt, parseModelRegistry } from '@somnio/core';
import type { Point } from '@somnio/core';
import { RARITIES } from '@somnio/protocol';
import type { LootMessage, Rarity, SectorView, SpeechKind } from '@somnio/protocol';
import { ClientWorld } from '@/client';
import type { ClientEntity, SpeechBubbleRequest, TargetMark } from '@/client';
import { TEST_REGISTRY, interiorSector, outdoorSector } from '../../core/test/support/worldFixture.ts';
import { heldJobs } from './helpers/heldJobs';
import { recordingCompiler } from './helpers/programVariants';
import { clientEntity, outfit } from './helpers/worldFixture';
import { setLocale } from '@/i18n';

/**
 * Graph-level coverage. Pixels are not unit-testable without a GPU, but the placement, framing,
 * and self-heal decisions all live in the scene graph and are.
 */

/** Assets that resolve nothing, so everything renders a placeholder until `resolving()` swaps in. */
function emptyAssets(): ModelAssets {
  return {
    prewarm: async () => {},
    character: () => undefined,
    hand: () => undefined,
    ground: () => undefined,
    trophy: () => undefined,
    object: () => undefined,
    wear: () => Promise.resolve(undefined),
    retryWear: () => {},
    clipsFor: () => [],
    prototypeMeshes: () => undefined,
  };
}

function resolvingAssets(): ModelAssets {
  return {
    prewarm: async () => {},
    character: () => new THREE.Object3D(),
    hand: () => undefined,
    ground: () => undefined,
    trophy: () => undefined,
    object: () => new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)),
    wear: () => Promise.resolve(undefined),
    retryWear: () => {},
    clipsFor: () => [],
    prototypeMeshes: () => undefined,
  };
}

function makeScene(assets: ModelAssets = emptyAssets(), now?: () => number, rasterizer?: GroundRasterizer, scatterer?: Scatterer): WorldScene {
  return new WorldScene(assets, TEST_REGISTRY, 1, false, now, rasterizer, scatterer);
}

function sector(overrides: Partial<SectorView> = {}): SectorView {
  return outdoorSector('EdariaSquare', { x: 0, z: 0 }, overrides);
}

function placement(id: string, modelId: string, overrides: Partial<SectorView['placements'][number]> = {}): SectorView['placements'][number] {
  return { id, modelId, x: 4, z: 6, yaw: 0, elevation: 0, ...overrides };
}

function player(overrides: Partial<ClientEntity> = {}): ClientEntity {
  return clientEntity({ name: 'Saibot', ...overrides });
}

function world(spaceId = 'outdoors'): ClientWorld {
  return new ClientWorld(spaceId, TEST_REGISTRY);
}

/** A clear said line from a speaker the scene draws no body of, coming from `source`. */
function voiced(entityId: string, lines: string[], source: Point, overrides: Partial<SpeechBubbleRequest> = {}): SpeechBubbleRequest {
  return { entityId, source, lines, lifetimeMs: 3000, kind: 'say', clarity: 1, ...overrides };
}

/** A clear said line from the entity `entityId`. */
function said(entityId: string, lines: string[], lifetimeMs: number, overrides: Partial<SpeechBubbleRequest> = {}): SpeechBubbleRequest {
  return voiced(entityId, lines, { x: 10, z: 10 }, { lifetimeMs, ...overrides });
}

/** Where a world point is drawn, in metres on the screen from its middle, as `placedBubbles` reports bubbles. */
function screenOf(scene: WorldScene, point: THREE.Vector3): ScreenPoint {
  scene.camera.updateMatrixWorld();
  const drawn = point.clone().project(scene.camera);
  const { halfSize } = scene.placedBubbles();
  return { x: drawn.x * halfSize.x, y: drawn.y * halfSize.y };
}

/** The bubble whose first line is `line`. */
function bubbleSaying(scene: WorldScene, line: string): PlacedBubble | undefined {
  return scene.placedBubbles().bubbles.find((bubble) => bubble.lines[0] === line);
}

/** How much of a figure's standing height its head is taken to fill. */
const HEAD_SHARE = 0.4;

/** The top of the rim of a standing head, `headHeight` over `feet`, as drawn. A bubble straight over the head ends its tail there. */
function standingHeadTop(scene: WorldScene, feet: THREE.Vector3, headHeight: number): ScreenPoint {
  const radius = (HEAD_SHARE * headHeight) / 2;
  const centre = screenOf(scene, feet.clone().setY(feet.y + headHeight - radius));
  return { x: centre.x, y: centre.y + radius };
}

/** A sector whose dais, a step (0.2 m) up, covers x and z 4..6. */
const daisSector = sector({ placements: [placement('dais-1', 'dais', { x: 5, z: 5 })] });

/** A scene that entered a world holding `daisSector` and draws it, hidden until a player is placed. */
function sceneWithGround(): WorldScene {
  const scene = makeScene();
  const entered = world();
  scene.enterSpace(entered);
  entered.addSector(daisSector);
  scene.addSector(daisSector);
  return scene;
}

/** Every sector's ground mesh in the scene. */
function groundMeshes(scene: WorldScene): THREE.Mesh[] {
  const found: THREE.Mesh[] = [];
  scene.scene.traverse((object) => {
    if ((object as THREE.Mesh).isMesh && object.name === 'somnio-ground') found.push(object as THREE.Mesh);
  });
  return found;
}

/** The ground mesh drawn over the sector whose rect is centred on (x, z) in its space. */
function groundAt(scene: WorldScene, x: number, z: number): THREE.Mesh | undefined {
  return groundMeshes(scene).find((mesh) => Math.abs(mesh.position.x - x) < 1e-9 && Math.abs(mesh.position.z - z) < 1e-9);
}

/** The weight textures a ground mesh's material owns. */
function weightTextures(mesh: THREE.Mesh): THREE.DataTexture[] {
  return (mesh.material as THREE.Material).userData['somnioOwnedTextures'] as THREE.DataTexture[];
}

function planeSize(mesh: THREE.Mesh): { width: number; height: number } {
  const { width, height } = (mesh.geometry as THREE.PlaneGeometry).parameters;
  return { width, height };
}

/** The target's mark with slot 1 off and the gaze free. */
const PLAIN_MARK: TargetMark = { locked: false, acting: false };

/** Every ground ring in the scene: round the target, round a fallen body being raised, a mend's pulse, and a press's ring. */
function rings(scene: WorldScene): THREE.Mesh[] {
  const found: THREE.Mesh[] = [];
  scene.scene.traverse((object) => {
    if ((object as THREE.Mesh).geometry?.type === 'RingGeometry') found.push(object as THREE.Mesh);
  });
  return found;
}

/**
 * A skinned model with its own skeleton, matching what `SkeletonUtils.clone` hands back: a box
 * one unit tall standing on its node, or the `geometry` given, every vertex bound to the one bone.
 * A `head` bone under it stands 0.9 units up, as the pack's models carry one.
 */
function skinnedModel(geometry: THREE.BufferGeometry = new THREE.BoxGeometry(0.2, 1, 0.2).translate(0, 0.5, 0)): {
  root: THREE.Object3D;
  skeleton: THREE.Skeleton;
  bone: THREE.Bone;
  head: THREE.Bone;
} {
  const bone = new THREE.Bone();
  const head = new THREE.Bone();
  head.name = 'head';
  head.position.y = 0.9;
  bone.add(head);
  const skeleton = new THREE.Skeleton([bone]);
  const vertices = geometry.getAttribute('position').count;
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array<number>(vertices * 4).fill(0), 4));
  geometry.setAttribute(
    'skinWeight',
    new THREE.Float32BufferAttribute(
      Array.from({ length: vertices * 4 }, (_, index) => (index % 4 === 0 ? 1 : 0)),
      4,
    ),
  );
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  mesh.add(bone);
  mesh.bind(skeleton);
  const root = new THREE.Object3D();
  root.add(mesh);
  return { root, skeleton, bone, head };
}

function boxes(scene: WorldScene): THREE.Mesh[] {
  const found: THREE.Mesh[] = [];
  scene.scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry instanceof THREE.BoxGeometry) found.push(mesh);
  });
  return found;
}

/**
 * Space roots, identified by holding a sector's ground. The scene also holds the
 * lights, so a bare `children.length` cannot tell a parked root from the furniture.
 */
function spaceRootCount(scene: WorldScene): number {
  return scene.scene.children.filter((root) => root.children.some((child) => child.name === 'somnio-ground')).length;
}

function sun(scene: WorldScene): THREE.DirectionalLight {
  return scene.scene.getObjectByProperty('isDirectionalLight', true) as THREE.DirectionalLight;
}

function hemisphere(scene: WorldScene): THREE.HemisphereLight {
  return scene.scene.getObjectByProperty('isHemisphereLight', true) as THREE.HemisphereLight;
}

function linearColor(color: { r: number; g: number; b: number }): THREE.Color {
  return new THREE.Color(color.r, color.g, color.b);
}

/** Direction the light actually shines from, which is what shading reads. */
function sunDirection(scene: WorldScene): THREE.Vector3 {
  return sun(scene).position.clone().sub(sun(scene).target.position).normalize();
}

/** The focus the camera is framed on: the camera sits at its rig offset from it. */
function cameraFocus(scene: WorldScene): THREE.Vector3 {
  const offset = cameraPosition({ x: 0, y: 0, z: 0 });
  return scene.camera.position.clone().sub(new THREE.Vector3(offset.x, offset.y, offset.z));
}

describe('camera framing', () => {
  it('starts at the default scale as a half-height', () => {
    const scene = makeScene();
    expect(scene.camera.top).toBe(ORTHO_RIG.defaultScale);
    expect(scene.camera.bottom).toBe(-ORTHO_RIG.defaultScale);
  });

  /**
   * The MMO-fairness contract: resizing must not reveal more world vertically, only wider. A
   * handler that tied the frustum to pixel height would hand large-window players extra view.
   */
  it('holds the vertical extent constant across resizes and only widens', () => {
    const scene = makeScene();
    const verticalBefore = scene.camera.top - scene.camera.bottom;
    const widthBefore = scene.camera.right - scene.camera.left;

    scene.setViewportSize(2500, 1000);

    expect(scene.camera.top - scene.camera.bottom).toBe(verticalBefore);
    expect(scene.camera.right - scene.camera.left).toBeGreaterThan(widthBefore);
  });

  it('magnifies on zoom rather than revealing more world', () => {
    const scene = makeScene();
    scene.applyZoomFactor(1.4);
    expect(scene.camera.top).toBe(5);
  });

  /**
   * A consumer with no player positions the camera itself, and the client's camera follows the
   * player across sector borders: a sector coming into the draw set must not pull the view to it.
   */
  it('leaves the camera alone when a sector is added', () => {
    const scene = makeScene();
    const before = scene.camera.position.clone();

    scene.addSector(outdoorSector('NorthMeadow', { x: 5.12, z: -30.72 }));

    expect(scene.camera.position).toEqual(before);
  });

  it('centres on the local player when it is placed, and follows it', () => {
    const scene = makeScene();
    scene.addSector(sector());

    scene.placeEntity(player({ position: { x: 12, z: 7 } }));
    expect(cameraFocus(scene).x).toBeCloseTo(12, 9);
    expect(cameraFocus(scene).z).toBeCloseTo(7, 9);

    scene.updatePosition('self', { x: 13, z: 5 }, 0, undefined);
    expect(cameraFocus(scene).x).toBeCloseTo(13, 9);
    expect(cameraFocus(scene).z).toBeCloseTo(5, 9);
  });

  /** The first frame of the game is at the player's zoom, while the splash held on screen until then keeps its shot. */
  it('frames a splash shot at its own scale whatever the zoom, until the player lands', () => {
    const scene = makeScene();
    scene.frameShot({ x: 12, z: 7 }, 6);
    expect(scene.camera.top).toBe(6);
    expect(cameraFocus(scene).x).toBeCloseTo(12, 9);
    expect(cameraFocus(scene).z).toBeCloseTo(7, 9);
    scene.applyZoomFactor(1.4);
    expect(scene.camera.top).toBe(6);

    scene.enterSpace(world());
    scene.addSector(sector());
    expect(scene._cameraScale()).toBe(6);
    scene.placeEntity(player());

    expect(scene._cameraScale()).toBe(scaleForZoomFactor(1.4));
  });

  it('does not follow anyone else', () => {
    const scene = makeScene();
    scene.addSector(sector());
    scene.placeEntity(player({ position: { x: 12, z: 7 } }));

    scene.placeEntity(player({ id: 'peer', kind: 'peer', position: { x: 2, z: 2 } }));
    scene.updatePosition('peer', { x: 3, z: 3 }, 0, undefined);

    expect(cameraFocus(scene).x).toBeCloseTo(12, 9);
  });
});

describe('sectors', () => {
  it('builds one ground over the sector and one node per placement', () => {
    const scene = makeScene();

    scene.addSector(sector({ placements: [placement('box-1', 'box'), placement('rug-1', 'rug', { x: 8, yaw: 90 })] }));

    expect(groundMeshes(scene)).toHaveLength(1);
    expect(planeSize(groundMeshes(scene)[0]!)).toEqual({ width: 20, height: 20 });
    expect(groundMeshes(scene)[0]!.getWorldPosition(new THREE.Vector3())).toEqual(new THREE.Vector3(10, 0, 10));
    expect(scene._placeholderObjectCount()).toBe(2);
  });

  it('draws a sector with no placements without handing three nothing to add', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => error.mockRestore());
    const scene = makeScene();

    scene.addSector(sector({ placements: [] }));

    expect(groundMeshes(scene)).toHaveLength(1);
    expect(error).not.toHaveBeenCalled();
  });

  it('stands a sector at its origin and a placement at its own position, yaw, and elevation within it', () => {
    const scene = makeScene();

    scene.addSector(
      outdoorSector('NorthMeadow', { x: 5.12, z: -30.72 }, { placements: [placement('rug-1', 'rug', { x: 4, z: 6, yaw: 270, elevation: 0.4 })] }),
    );

    const node = scene.placementNode('NorthMeadow', 'rug-1')!;
    expect(node.position).toEqual(new THREE.Vector3(4, 0.4, 6));
    // Degrees counter-clockwise seen from above is the sense of a rotation about +Y.
    expect(node.rotation.y).toBeCloseTo((270 * Math.PI) / 180, 12);
    const inSpace = node.getWorldPosition(new THREE.Vector3());
    expect(inSpace.x).toBeCloseTo(9.12, 9);
    expect(inSpace.y).toBeCloseTo(0.4, 9);
    expect(inSpace.z).toBeCloseTo(-24.72, 9);
  });

  /** Bodies walk on those surfaces at their registry heights, so a lifted mesh would float above its own collision. */
  it('draws a model with walk surfaces on the ground whatever elevation its record carries', () => {
    const scene = makeScene();

    scene.addSector(sector({ placements: [placement('dais-1', 'dais', { elevation: 0.4 })] }));

    expect(scene.placementNode('EdariaSquare', 'dais-1')!.position.y).toBe(0);
  });

  it('finds a placement node by sector and id, and nothing for either unknown', () => {
    const scene = makeScene();
    scene.addSector(sector({ placements: [placement('box-1', 'box')] }));
    scene.addSector(outdoorSector('NorthMeadow', { x: 0, z: -20 }, { placements: [placement('box-1', 'box', { x: 1 })] }));

    // The same id in two sectors is two placements.
    expect(scene.placementNode('EdariaSquare', 'box-1')!.position.x).toBe(4);
    expect(scene.placementNode('NorthMeadow', 'box-1')!.position.x).toBe(1);
    expect(scene.placementNode('EdariaSquare', 'box-2')).toBeUndefined();
    expect(scene.placementNode('NorthWood', 'box-1')).toBeUndefined();
  });

  it('removes one sector and leaves the others drawn', () => {
    const scene = makeScene();
    scene.addSector(sector({ placements: [placement('box-1', 'box')] }));
    scene.addSector(outdoorSector('NorthMeadow', { x: 0, z: -20 }, { placements: [placement('box-1', 'box')] }));
    const removed = groundAt(scene, 10, 10)!;
    const geometryDispose = vi.spyOn(removed.geometry, 'dispose');
    const textureDisposes = weightTextures(removed).map((texture) => vi.spyOn(texture, 'dispose'));

    scene.removeSector('EdariaSquare');

    expect(groundMeshes(scene)).toHaveLength(1);
    for (const spy of textureDisposes) expect(spy).toHaveBeenCalled();
    expect(scene.placementNode('EdariaSquare', 'box-1')).toBeUndefined();
    expect(scene.placementNode('NorthMeadow', 'box-1')).toBeDefined();
    expect(geometryDispose).toHaveBeenCalled();
  });

  it('replaces a sector added again under the same name', () => {
    const scene = makeScene();
    scene.addSector(sector({ placements: [placement('box-1', 'box')] }));

    scene.addSector(sector({ placements: [placement('box-1', 'box', { x: 9 })] }));

    expect(groundMeshes(scene)).toHaveLength(1);
    expect(scene._placeholderObjectCount()).toBe(1);
    expect(scene.placementNode('EdariaSquare', 'box-1')!.position.x).toBe(9);
  });
});

describe('the painted ground', () => {
  const road = {
    id: 'road',
    materialId: 'dirt-path',
    opacity: 1,
    shape: {
      kind: 'stroke' as const,
      radius: 1.6,
      points: [
        { x: 4, z: 10 },
        { x: 19.6, z: 10 },
      ],
    },
  };
  const west = (marks: SectorView['ground']['marks'] = []): SectorView =>
    outdoorSector('West', { x: 0, z: 0 }, { ground: { backgroundMaterialId: 'grass', marks } });
  const east = (): SectorView => outdoorSector('East', { x: 20, z: 0 }, { ground: { backgroundMaterialId: 'forest-floor', marks: [] } });

  it('rasterizes a new sector and each sector it joins, once each, nearest the camera first', () => {
    const held = heldJobs(rasterizeGround);
    const scene = makeScene(emptyAssets(), undefined, { rasterize: held.run });
    scene.addSector(west());
    scene.tick(0.016);
    held.release();

    scene.addSector(east());
    scene.tick(0.016);
    scene.tick(0.016);

    expect(held.jobs.map((job) => job.inputs.sector.name)).toEqual(['West', 'East']);
    expect(held.jobs.map((job) => job.inputs.neighbours.map((neighbour) => neighbour.name))).toEqual([['East'], ['West']]);
  });

  it('draws the field it has until the next one arrives, and drops a field for inputs that changed since it was asked', () => {
    const held = heldJobs(rasterizeGround);
    const scene = makeScene(emptyAssets(), undefined, { rasterize: held.run });
    scene.addSector(west());
    scene.tick(0.016);
    const flat = groundAt(scene, 10, 10)!;
    expect(weightTextures(flat).map((texture) => texture.image.width)).toEqual([1, 1]);
    const stale = held.jobs.splice(0);

    scene.addSector(west([road]));
    scene.tick(0.016);
    expect(groundAt(scene, 10, 10)).toBe(flat);
    stale[0]!.done(rasterizeGround(stale[0]!.inputs));
    expect(groundAt(scene, 10, 10)).toBe(flat);

    const flatDisposes = weightTextures(flat).map((texture) => vi.spyOn(texture, 'dispose'));
    held.release();
    const painted = groundAt(scene, 10, 10)!;
    expect(painted).not.toBe(flat);
    expect(weightTextures(painted)[0]!.image.width).toBeGreaterThan(1);
    for (const spy of flatDisposes) expect(spy).toHaveBeenCalled();
  });

  it('re-rasterizes a sector and its neighbour when a mark reaches across their border, and again when it is undone', () => {
    const held = heldJobs(rasterizeGround);
    const scene = makeScene(emptyAssets(), undefined, { rasterize: held.run });
    scene.addSector(west());
    scene.addSector(east());
    scene.tick(0.016);
    held.release();

    scene.addSector(west([road]));
    scene.tick(0.016);
    expect(held.jobs.map((job) => job.inputs.sector.name).sort()).toEqual(['East', 'West']);
    held.release();

    scene.addSector(west());
    scene.tick(0.016);
    expect(held.jobs.map((job) => job.inputs.sector.name).sort()).toEqual(['East', 'West']);
  });

  it('asks nothing again for a sector re-added with its ground and its neighbours unchanged', () => {
    const held = heldJobs(rasterizeGround);
    const scene = makeScene(emptyAssets(), undefined, { rasterize: held.run });
    scene.addSector(west());
    scene.tick(0.016);
    held.release();

    scene.addSector({ ...west(), placements: [placement('box-1', 'box')] });
    scene.tick(0.016);

    expect(held.jobs).toEqual([]);
  });

  it('rasterizes inline during the tick where there is no worker and none was injected', () => {
    const scene = makeScene();
    scene.addSector(west([road]));
    expect(weightTextures(groundAt(scene, 10, 10)!)[0]!.image.width).toBe(1);

    scene.tick(0.016);

    expect(weightTextures(groundAt(scene, 10, 10)!)[0]!.image.width).toBeGreaterThan(1);
  });

  it('draws a new sector flat in its own background until its field arrives, in the first recipe for one with none', () => {
    const held = heldJobs(rasterizeGround);
    const scene = makeScene(emptyAssets(), undefined, { rasterize: held.run });
    scene.addSector(outdoorSector('Forest', { x: 0, z: 0 }, { ground: { backgroundMaterialId: 'forest-floor', marks: [] } }));
    scene.addSector(outdoorSector('Lava', { x: 40, z: 0 }, { ground: { backgroundMaterialId: 'lava', marks: [] } }));
    scene.addSector(outdoorSector('Wood', { x: 80, z: 0 }, { ground: { backgroundMaterialId: 'wood-warm', marks: [] } }));
    const texels = (x: number, z: number): number[][] => weightTextures(groundAt(scene, x, z)!).map((texture) => [...(texture.image.data as Uint8Array)]);

    expect(texels(10, 10)).toEqual([
      [0, 255, 0, 0],
      [0, 0, 0, 0],
    ]);
    expect(texels(50, 10)).toEqual([
      [255, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    // Channels past the fourth are in the second texture.
    expect(texels(90, 10)).toEqual([
      [0, 0, 0, 0],
      [0, 255, 0, 0],
    ]);
  });

  it('drops a field that arrives for a sector no longer drawn', () => {
    const held = heldJobs(rasterizeGround);
    const scene = makeScene(emptyAssets(), undefined, { rasterize: held.run });
    scene.addSector(west());
    scene.tick(0.016);
    expect(held.jobs).toHaveLength(1);

    scene.removeSector('West');
    expect(() => held.release()).not.toThrow();
    expect(groundMeshes(scene)).toEqual([]);
  });

  it('asks nothing again for a sector re-added unchanged while its field is still on the way', () => {
    const held = heldJobs(rasterizeGround);
    const scene = makeScene(emptyAssets(), undefined, { rasterize: held.run });
    scene.addSector(west());
    scene.tick(0.016);
    scene.addSector(west());
    scene.tick(0.016);

    expect(held.jobs).toHaveLength(1);
  });

  /** A door transfer or a login shows painted ground at once: the field under the player is rasterized on the spot. */
  it('reveals a held space with the ground under the player painted, and drops the field the worker answers later', () => {
    const held = heldJobs(rasterizeGround);
    const scene = makeScene(emptyAssets(), undefined, { rasterize: held.run });
    scene.addSector(sector());
    scene.placeEntity(player());
    scene.tick(0.016);
    held.release();

    scene.enterSpace(world('EdariaInn'));
    scene.addSector(interiorSector('EdariaInn'));
    scene.tick(0.016);
    expect(held.jobs).toHaveLength(1);
    scene.placeEntity(player({ position: { x: 5, z: 5 } }));

    const revealed = groundMeshes(scene).find((mesh) => mesh.parent!.visible)!;
    expect(weightTextures(revealed)[0]!.image.width).toBeGreaterThan(1);
    held.release();
    expect(groundMeshes(scene).find((mesh) => mesh.parent!.visible)).toBe(revealed);
    expect(cameraFocus(scene).x).toBeCloseTo(5, 9);
  });

  it('frees the outgoing ground of a held door transfer at the reveal, not at the transfer', () => {
    const scene = makeScene();
    scene.addSector(sector());
    scene.placeEntity(player());
    scene.tick(0.016);
    const outgoing = groundMeshes(scene)[0]!;
    const disposes = weightTextures(outgoing).map((texture) => vi.spyOn(texture, 'dispose'));

    scene.enterSpace(world('EdariaInn'));
    scene.addSector(interiorSector('EdariaInn'));
    for (const spy of disposes) expect(spy).not.toHaveBeenCalled();

    scene.placeEntity(player({ position: { x: 5, z: 5 } }));
    for (const spy of disposes) expect(spy).toHaveBeenCalled();
  });
});

describe('placeholders', () => {
  it('sizes a placement placeholder from the registry footprint', () => {
    const scene = makeScene();
    scene.addSector(sector({ placements: [placement('box-1', 'box')] }));

    // Width and depth are distinct in the fixture, so a swapped axis cannot pass.
    expect((boxes(scene)[0]!.geometry as THREE.BoxGeometry).parameters).toMatchObject({ width: 2, height: PLACEHOLDER_HEIGHT, depth: 1 });
  });

  it('draws a model the registry does not know as a small box, and keeps counting it', async () => {
    const scene = makeScene();
    scene.addSector(sector({ placements: [placement('mystery-1', 'mystery')] }));
    await scene.prewarm();

    expect((boxes(scene)[0]!.geometry as THREE.BoxGeometry).parameters).toMatchObject({
      width: PLACEHOLDER_HEIGHT,
      height: PLACEHOLDER_HEIGHT,
      depth: PLACEHOLDER_HEIGHT,
    });
    expect(scene._placeholderObjectCount()).toBe(1);
  });

  it('sizes an entity placeholder from its body radius and the character height', () => {
    const scene = makeScene();
    scene.placeEntity(player({ radius: 0.4 }));

    const box = boxes(scene)[0]!;
    expect((box.geometry as THREE.BoxGeometry).parameters).toMatchObject({ width: 0.8, height: CHARACTER_SCALE, depth: 0.4 });
    expect(box.position.y).toBe(CHARACTER_SCALE / 2);
  });

  it('scales a resolved character model by the one character scale', () => {
    const model = new THREE.Object3D();
    const scene = makeScene({ ...emptyAssets(), character: () => model });

    scene.placeEntity(player());

    expect(model.parent!.scale).toEqual(new THREE.Vector3(CHARACTER_SCALE, CHARACTER_SCALE, CHARACTER_SCALE));
  });

  it('asks the assets for the character model the entity names', () => {
    const asked: string[] = [];
    const scene = makeScene({
      ...emptyAssets(),
      character: (id) => {
        asked.push(id);
        return undefined;
      },
    });

    scene.placeEntity(player({ id: 'monster:1', kind: 'monster', characterModelId: 'ghost' }));

    expect(asked).toEqual(['ghost']);
  });

  it('hangs what each hand holds on its handslot bone, as the entity comes and as it changes, and nothing for an item without a model', () => {
    const model = new THREE.Object3D();
    const bones = { mainHand: Object.assign(new THREE.Bone(), { name: 'handslotr' }), offHand: Object.assign(new THREE.Bone(), { name: 'handslotl' }) };
    model.add(bones.mainHand, bones.offHand);
    const scene = makeScene({
      ...emptyAssets(),
      character: () => model,
      hand: (baseId) => (baseId === 'unknown' ? undefined : Object.assign(new THREE.Object3D(), { name: baseId })),
    });
    const held = () => ({ mainHand: bones.mainHand.children.map(({ name }) => name), offHand: bones.offHand.children.map(({ name }) => name) });

    scene.placeEntity(player({ outfit: outfit({ mainHand: 'sword', offHand: 'shield' }) }));
    expect(held()).toEqual({ mainHand: ['sword'], offHand: ['shield'] });

    scene.updateOutfit('self', outfit({ mainHand: 'mace' }));
    expect(held()).toEqual({ mainHand: ['mace'], offHand: [] });

    scene.placeEntity(player({ outfit: outfit({ offHand: 'unknown' }) }));
    expect(held()).toEqual({ mainHand: [], offHand: [] });
  });

  it('dresses the body again only when what it wears changes, slot, base, or tier, and leaves it dressed when only the hands change', () => {
    const model = new THREE.Object3D();
    const bone = Object.assign(new THREE.Bone(), { name: 'handslotr' });
    model.add(bone);
    const scene = makeScene({ ...emptyAssets(), character: () => model, hand: (baseId) => Object.assign(new THREE.Object3D(), { name: baseId }) });
    scene.placeEntity(player({ outfit: outfit({ mainHand: 'sword', chest: 'tunic' }) }));
    const dressBody = vi.spyOn(scene as unknown as { dressBody: (state: unknown) => void }, 'dressBody');

    scene.updateOutfit('self', outfit({ mainHand: 'mace', chest: 'tunic' }));
    expect(bone.children.map(({ name }) => name)).toEqual(['mace']);
    expect(dressBody).not.toHaveBeenCalled();

    scene.updateOutfit('self', [...outfit({ mainHand: 'mace' }), { slot: 'chest', baseId: 'tunic', tier: 3 }]);
    scene.placeEntity(player({ outfit: outfit({ mainHand: 'mace', chest: 'tunic', feet: 'boots' }) }));
    scene.updateOutfit('self', outfit({ mainHand: 'mace', feet: 'boots' }));
    expect(dressBody).toHaveBeenCalledTimes(3);
    expect(bone.children.map(({ name }) => name)).toEqual(['mace']);
  });
});

describe('held space swap', () => {
  /**
   * Without the hold, a door shows one frame of the new space with no character in it.
   */
  it('keeps the incoming space hidden until the player is placed', () => {
    const scene = makeScene();
    scene.addSector(sector());
    scene.placeEntity(player());

    scene.enterSpace(world('EdariaInn'));
    scene.addSector(interiorSector('EdariaInn'));
    const hidden = scene.scene.children.filter((child) => child.visible === false);
    expect(hidden).toHaveLength(1);
    expect(spaceRootCount(scene)).toBe(2);

    scene.placeEntity(player());
    expect(scene.scene.children.filter((child) => child.visible === false)).toHaveLength(0);
    // And the outgoing root is *gone*, not merely revealed alongside: a parked root is visible, so
    // a `visible === false` filter alone passes while both spaces render on top of each other.
    expect(spaceRootCount(scene)).toBe(1);
  });

  it('drops a parked space when a splash interrupts the swap', () => {
    const scene = makeScene();
    // Both spaces carry a placement, so the placeholder count can actually fall to zero — with
    // empty sectors it reads 0 before the splash as well, and the assertion measures nothing.
    scene.addSector(sector({ placements: [placement('box-1', 'box')] }));
    scene.enterSpace(world('EdariaInn'));
    scene.addSector(interiorSector('EdariaInn', { placements: [placement('box-1', 'box')] }));
    expect(scene._placeholderObjectCount()).toBeGreaterThan(0);

    scene.showSplash();

    expect(scene._placeholderObjectCount()).toBe(0);
    expect(spaceRootCount(scene)).toBe(0);
    expect(boxes(scene)).toEqual([]);
  });

  /**
   * The incoming interior's light must not reach the outgoing space still on screen: the town
   * square dimming to the inn's key for the frames before the swap is the flash the hold prevents.
   */
  it('lights the held space by its own light until the reveal', () => {
    const scene = makeScene();
    scene.addSector(sector());
    scene.placeEntity(player());
    const outdoors = sun(scene).intensity;

    scene.enterSpace(world('EdariaInn'));
    scene.addSector(interiorSector('EdariaInn', { brightness: 50 }));
    scene.tick(0.016);
    expect(sun(scene).intensity).toBe(outdoors);

    scene.placeEntity(player());
    expect(sun(scene).intensity).toBeCloseTo(sunState(12, 50).sunIntensity, 12);
    expect(sun(scene).intensity).not.toBe(outdoors);
  });

  it('returns to the outdoor light when the next space is outdoors', () => {
    const scene = makeScene();
    scene.addSector(interiorSector('EdariaInn', { brightness: 50 }));
    scene.placeEntity(player());

    scene.enterSpace(world());
    scene.addSector(sector());
    scene.placeEntity(player());

    expect(sun(scene).intensity).toBeCloseTo(sunState(12, undefined).sunIntensity, 12);
  });
});

describe('the world clock', () => {
  /** Seconds since the start of a day for a fractional hour; the day and year do not matter to the light. */
  const at = (hour: number): number => hour * 3600;

  it('holds the light at noon until it is told the time', () => {
    let nowMs = 0;
    const scene = makeScene(emptyAssets(), () => nowMs);
    scene.addSector(sector());

    nowMs += 3_600_000;
    scene.tick(0.016);

    expect(sun(scene).intensity).toBeCloseTo(sunState(12, undefined).sunIntensity, 12);
  });

  it('lights the scene for the time it is told', () => {
    const scene = makeScene(emptyAssets(), () => 0);
    scene.addSector(sector());

    scene.setClock(at(7));

    expect(sun(scene).intensity).toBeCloseTo(sunState(7, undefined).sunIntensity, 12);
  });

  /**
   * From wall time, not from the frames it was ticked: a hidden tab gets no frames, and a clock
   * that only advanced with them would come back as far behind as the tab was away.
   */
  it('runs forward at four world seconds a second of wall time, however few frames it gets', () => {
    let nowMs = 1000;
    const scene = makeScene(emptyAssets(), () => nowMs);
    scene.addSector(sector());
    scene.setClock(at(7));

    // Fifteen minutes of wall time is one world hour.
    nowMs += 15 * 60 * 1000;
    scene.tick(0.016);

    expect(sun(scene).intensity).toBeCloseTo(sunState(8, undefined).sunIntensity, 9);
    expect(sun(scene).intensity).not.toBeCloseTo(sunState(7, undefined).sunIntensity, 3);
  });

  it('does not let the clock change an interior', () => {
    let nowMs = 0;
    const scene = makeScene(emptyAssets(), () => nowMs);
    scene.addSector(interiorSector('EdariaInn', { brightness: 80 }));
    scene.setClock(at(23));

    nowMs += 3_600_000;
    scene.tick(0.016);

    expect(sun(scene).intensity).toBeCloseTo(sunState(12, 80).sunIntensity, 12);
  });

  /** The whole state reaches the lights: where the sun stands and its tint, the hemisphere fill, and the backdrop. */
  it('points and tints the sun and sets the fill and the backdrop for a night hour, and again for an interior', () => {
    const scene = makeScene(emptyAssets(), () => 0);
    scene.addSector(sector());

    scene.setClock(at(23));
    const night = sunState(23, undefined);
    expect(sunDirection(scene).distanceTo(new THREE.Vector3(night.direction.x, night.direction.y, night.direction.z))).toBeLessThan(1e-9);
    expect(sun(scene).color).toEqual(linearColor(night.sunColor));
    expect(hemisphere(scene).intensity).toBeCloseTo(night.hemisphereIntensity, 9);
    expect(hemisphere(scene).color).toEqual(linearColor(night.skyColor));
    expect(hemisphere(scene).groundColor).toEqual(linearColor(night.groundColor));
    expect(scene.scene.background).toEqual(linearColor(night.backdropColor));

    scene.addSector(interiorSector('EdariaInn', { brightness: 50 }));
    const interior = sunState(23, 50);
    expect(sunDirection(scene).distanceTo(new THREE.Vector3(interior.direction.x, interior.direction.y, interior.direction.z))).toBeLessThan(1e-9);
    expect(interior.direction).not.toEqual(night.direction);
    expect(sun(scene).color).toEqual(linearColor(interior.sunColor));
    expect(hemisphere(scene).intensity).toBeCloseTo(interior.hemisphereIntensity, 9);
    expect(scene.scene.background).toEqual(linearColor(interior.backdropColor));
  });

  /** One sky-and-ground fill keyed to the clock, beside the sun and the rooms' fixed pool and door light. The backdrop is the scene's background rather than a mesh. */
  it('fills with the hemisphere and paints the backdrop by the clock', () => {
    let nowMs = 0;
    const scene = makeScene(emptyAssets(), () => nowMs);
    scene.addSector(sector());

    expect(lightTypes(scene)).toEqual(FIXED_LIGHTS);
    expect(scene.scene.children.some((child) => (child as THREE.Mesh).isMesh)).toBe(false);

    scene.setClock(at(12));
    const noon = (scene.scene.background as THREE.Color).clone();
    nowMs += 10 * 15 * 60 * 1000;
    scene.tick(0.016);
    expect(scene.scene.background).toEqual(linearColor(sunState(22, undefined).backdropColor));
    expect(scene.scene.background).not.toEqual(noon);
  });
});

/** The scene's lights, which never change in number or kind: a change would compile every program again. */
const FIXED_LIGHTS = ['DirectionalLight', 'HemisphereLight', ...Array<string>(PROP_LIGHT_POOL_SIZE).fill('PointLight'), 'SpotLight'].sort();

function lightTypes(scene: WorldScene): string[] {
  return scene.scene.children
    .filter((child) => (child as THREE.Light).isLight)
    .map((light) => light.type)
    .sort();
}

describe('room lights', () => {
  const prop = (stem: string) => ({ stem, expectedClips: [] });
  /** A candle, a lamp, and a torch, and a threshold whose door opens into the room it stands in. */
  const registry = parseModelRegistry({
    characterModels: [{ id: 'hero', model: { stem: 'Hero', expectedClips: ['Idle'] } }],
    peoples: PEOPLES.map((people) => ({ people, model: 'hero', scale: [1, 1, 1] })),
    objectModels: [
      { id: 'candle', model: prop('Candle'), footprint: { width: 0.2, depth: 0.2 }, colliders: [], light: { x: 0.05, y: 0.4, z: 0, kind: 'candle' } },
      { id: 'lamp', model: prop('Lamp'), footprint: { width: 0.4, depth: 0.4 }, light: { x: 0, y: 0.9, z: 0, kind: 'lamp' } },
      { id: 'torch', model: prop('Torch'), footprint: { width: 0.2, depth: 0.3 }, colliders: [], light: { x: 0, y: 0.4, z: 0.1, kind: 'torch' } },
      {
        id: 'threshold',
        model: prop('Threshold'),
        footprint: { width: 2.28, depth: 0.24 },
        colliders: [],
        doors: [{ id: 'main', x: 0, z: -0.12, facing: 180, width: 2 }],
      },
    ],
  });

  function litScene(options: { assets?: ModelAssets; now?: () => number; reducedMotion?: boolean } = {}): WorldScene {
    return new WorldScene(options.assets ?? emptyAssets(), registry, 1, options.reducedMotion ?? false, options.now);
  }

  /** A 10 m room lit by a candle, a lamp, and a torch, whose door gap is on the south wall at x 5. */
  function room(name: string, overrides: Partial<SectorView> = {}): SectorView {
    return interiorSector(name, {
      placements: [
        placement('candle-1', 'candle', { x: 2, z: 2 }),
        placement('lamp-1', 'lamp', { x: 5, z: 3 }),
        placement('torch-1', 'torch', { x: 8, z: 0.15 }),
        placement('door-1', 'threshold', { x: 5, z: 10.12 }),
      ],
      doors: [{ id: 'exit', placement: 'door-1', anchor: 'main', target: { sector: 'EdariaSquare', door: 'to-room' } }],
      ...overrides,
    });
  }

  function pool(scene: WorldScene): THREE.PointLight[] {
    return scene.scene.children.filter((child): child is THREE.PointLight => (child as THREE.PointLight).isPointLight === true);
  }

  function lit(scene: WorldScene): THREE.PointLight[] {
    return pool(scene).filter((light) => light.intensity > 0);
  }

  function spill(scene: WorldScene): THREE.SpotLight {
    return scene.scene.getObjectByProperty('isSpotLight', true) as THREE.SpotLight;
  }

  function halos(scene: WorldScene): THREE.Sprite[] {
    const found: THREE.Sprite[] = [];
    scene.scene.traverse((object) => {
      if ((object as THREE.Sprite).isSprite) found.push(object as THREE.Sprite);
    });
    return found;
  }

  it('keeps the same lights outdoors and in every room', () => {
    const scene = litScene();
    scene.addSector(sector({ placements: [placement('candle-1', 'candle')] }));
    expect(lightTypes(scene)).toEqual(FIXED_LIGHTS);
    for (const name of ['EdariaInn', 'EdariaShop']) {
      scene.enterSpace(world(name));
      scene.addSector(room(name));
      scene.placeEntity(player({ position: { x: 5, z: 5 } }));
      expect(lightTypes(scene)).toEqual(FIXED_LIGHTS);
    }
  });

  it('lights every flame of a room and draws its halo, and leaves a flame outdoors unlit with none', () => {
    const outdoors = litScene();
    outdoors.addSector(sector({ placements: [placement('candle-1', 'candle'), placement('lamp-1', 'lamp', { x: 8 })] }));
    outdoors.tick(0.016);
    expect(halos(outdoors)).toEqual([]);
    expect(lit(outdoors)).toEqual([]);

    const inside = litScene({ reducedMotion: true });
    inside.addSector(room('EdariaInn'));
    expect(halos(inside)).toHaveLength(3);
    expect(lit(inside).map((light) => light.intensity)).toEqual([
      PROP_LIGHT_PRESETS.candle.intensity,
      PROP_LIGHT_PRESETS.lamp.intensity,
      PROP_LIGHT_PRESETS.torch.intensity,
    ]);
    const lamp = inside.placementNode('EdariaInn', 'lamp-1')!;
    expect(lit(inside).some((light) => light.position.distanceTo(lamp.localToWorld(new THREE.Vector3(0, 0.9, 0))) < 1e-9)).toBe(true);
  });

  it('flickers its flames, and holds them steady for reduced motion', () => {
    const intensities = (reducedMotion: boolean): number[] => {
      const scene = litScene({ reducedMotion });
      scene.addSector(room('EdariaInn'));
      return [0.2, 0.2, 0.2].map((dt) => {
        scene.tick(dt);
        return lit(scene)[0]!.intensity;
      });
    };
    expect(new Set(intensities(false)).size).toBe(3);
    expect(intensities(true)).toEqual(Array<number>(3).fill(PROP_LIGHT_PRESETS.candle.intensity));
  });

  it('flickers each flame on a beat of its own', () => {
    const scene = litScene();
    scene.addSector(room('EdariaInn', { placements: [placement('candle-1', 'candle', { x: 2, z: 5 }), placement('candle-2', 'candle', { x: 2, z: 5 })] }));
    scene.tick(0.2);
    const [first, second] = lit(scene).map((light) => light.intensity);
    expect(first).not.toBe(second);
  });

  it('keeps the halo of a placement drawn as a placeholder once its model resolves', async () => {
    const assets = emptyAssets();
    const scene = litScene({ assets });
    scene.addSector(room('EdariaInn'));
    const halo = halos(scene).find((sprite) => sprite.parent === scene.placementNode('EdariaInn', 'lamp-1'))!;

    const warm = resolvingAssets();
    assets.object = (id) => warm.object(id);
    await scene.prewarm();

    expect(scene._placeholderObjectCount()).toBe(0);
    expect(halo.parent).toBe(scene.placementNode('EdariaInn', 'lamp-1'));
  });

  it("takes a moved lamp's halo along, and its pool on the next tick", () => {
    const scene = litScene();
    scene.addSector(room('EdariaInn'));
    const lamp = scene.placementNode('EdariaInn', 'lamp-1')!;
    const halo = halos(scene).find((sprite) => sprite.parent === lamp)!;

    lamp.position.set(7, 0, 6);
    expect(halo.getWorldPosition(new THREE.Vector3())).toEqual(new THREE.Vector3(7, 0.9, 6));
    scene.tick(0.016);
    expect(lit(scene).some((light) => light.position.equals(new THREE.Vector3(7, 0.9, 6)))).toBe(true);
  });

  it('draws every halo with one material, which leaving a room for another does not free', () => {
    const scene = litScene();
    scene.addSector(room('EdariaInn'));
    const material = halos(scene)[0]!.material;
    const dispose = vi.spyOn(material, 'dispose');
    expect(new Set(halos(scene).map((halo) => halo.material))).toEqual(new Set([material]));

    scene.placeEntity(player({ position: { x: 5, z: 5 } }));
    scene.enterSpace(world());
    scene.addSector(sector());
    scene.placeEntity(player());
    scene.enterSpace(world('EdariaShop'));
    scene.addSector(room('EdariaShop'));
    scene.placeEntity(player({ position: { x: 5, z: 5 } }));

    expect(dispose).not.toHaveBeenCalled();
    expect(halos(scene).every((halo) => halo.material === material)).toBe(true);
  });

  it('lets the light of the hour in through the door, and draws its shadow only in a room', () => {
    const scene = litScene({ now: () => 0 });
    // A door outdoors resolves as well as a room's, and still lets no light in, whatever it is said to open to.
    scene.addSector(
      sector({
        placements: [placement('door-1', 'threshold', { x: 5, z: 10 })],
        doors: [{ id: 'to-room', placement: 'door-1', anchor: 'main', target: { sector: 'EdariaInn', door: 'exit' } }],
      }),
      ['to-room'],
    );
    scene.setClock(12 * 3600);
    expect(spill(scene).intensity).toBe(0);
    expect(spill(scene).shadow.autoUpdate).toBe(false);
    // Drawn once all the same, so every lit material has its map to bind. Without it a scene opening outdoors draws nothing lit.
    expect(spill(scene).shadow.needsUpdate).toBe(true);

    scene.enterSpace(world('EdariaInn'));
    scene.addSector(room('EdariaInn'), ['exit']);
    scene.placeEntity(player({ position: { x: 5, z: 5 } }));
    expect(spill(scene).intensity).toBe(doorLightState(12).intensity);
    expect(spill(scene).color).toEqual(linearColor(doorLightState(12).color));
    expect(spill(scene).shadow.autoUpdate).toBe(true);
    // Lifted off the surfaces it grazes, so they do not self-shadow into stripes.
    expect(spill(scene).shadow.normalBias).toBeGreaterThan(0);
    // From outside the gap and up, down onto the floor inside it.
    expect(spill(scene).position).toEqual(new THREE.Vector3(5, 2.6, 12.4));
    expect(spill(scene).target.position).toEqual(new THREE.Vector3(5, 0, 8.4));

    scene.setClock(0);
    expect(spill(scene).intensity).toBe(doorLightState(0).intensity);
  });

  it('aims the light through a door on the east wall west into the room', () => {
    const scene = litScene();
    scene.addSector(
      room('EdariaInn', {
        placements: [placement('door-1', 'threshold', { x: 10.12, z: 5, yaw: 90 })],
      }),
      ['exit'],
    );
    const { position, target } = spill(scene);
    expect([position.x, position.y, position.z]).toEqual([expect.closeTo(12.4, 9), 2.6, expect.closeTo(5, 9)]);
    expect([target.position.x, target.position.y, target.position.z]).toEqual([expect.closeTo(8.4, 9), 0, expect.closeTo(5, 9)]);
  });

  it('leaves the door dark in a room with no door that resolves, whatever room came before', () => {
    const scene = litScene();
    scene.addSector(room('EdariaInn'), ['exit']);
    expect(spill(scene).intensity).toBeGreaterThan(0);

    scene.removeSector('EdariaInn');
    scene.addSector(room('EdariaInn', { doors: [] }));
    expect(spill(scene).intensity).toBe(0);
    expect(spill(scene).shadow.autoUpdate).toBe(false);

    scene.addSector(room('EdariaInn', { doors: [{ id: 'exit', placement: 'door-1', anchor: 'side', target: { sector: 'EdariaSquare', door: 'to-room' } }] }), [
      'exit',
    ]);
    expect(spill(scene).intensity).toBe(0);
  });

  it('lets no light of the hour into a room whose doors all lead to other rooms', () => {
    const scene = litScene({ now: () => 0 });
    scene.setClock(12 * 3600);
    scene.addSector(room('Chamber', { doors: [{ id: 'exit', placement: 'door-1', anchor: 'main', target: { sector: 'Crypt', door: 'to-chamber' } }] }));

    expect(spill(scene).intensity).toBe(0);
    expect(spill(scene).shadow.autoUpdate).toBe(false);
    // Its flames still light it.
    expect(lit(scene)).toHaveLength(3);
  });

  it('lets the light in through the first door that opens to the outdoors, past one to another room', () => {
    const scene = litScene();
    scene.addSector(
      room('Crypt', {
        placements: [...room('Crypt').placements, placement('door-2', 'threshold', { x: 10.12, z: 5, yaw: 90 })],
        doors: [
          { id: 'to-chamber', placement: 'door-1', anchor: 'main', target: { sector: 'Chamber', door: 'exit' } },
          { id: 'exit', placement: 'door-2', anchor: 'main', target: { sector: 'Graveyard', door: 'to-crypt' } },
        ],
      }),
      ['exit'],
    );

    expect(spill(scene).intensity).toBeGreaterThan(0);
    // Through the east wall's door, west into the room, not the south wall's.
    const { position } = spill(scene);
    expect([position.x, position.z]).toEqual([expect.closeTo(12.4, 9), expect.closeTo(5, 9)]);
  });

  it('lights a room drawn with no swap at once, and puts every light out when the splash comes back', () => {
    const scene = litScene();
    scene.addSector(room('EdariaInn'));
    expect(lit(scene)).toHaveLength(3);

    scene.showSplash();
    expect(lit(scene)).toEqual([]);
    expect(spill(scene).intensity).toBe(0);
    scene.addSector(sector());
    scene.tick(0.016);
    expect(lit(scene)).toEqual([]);
  });

  it("keeps the held room's flames lit until the reveal, and lights the next room's with it", () => {
    const scene = litScene();
    scene.addSector(room('EdariaInn', { placements: room('EdariaInn').placements.filter((each) => each.id === 'candle-1' || each.id === 'door-1') }));
    scene.placeEntity(player({ position: { x: 5, z: 5 } }));
    expect(lit(scene)).toHaveLength(1);

    scene.enterSpace(world('EdariaShop'));
    scene.addSector(room('EdariaShop'));
    scene.tick(0.016);
    expect(lit(scene)).toHaveLength(1);

    scene.placeEntity(player({ position: { x: 5, z: 5 } }));
    expect(lit(scene)).toHaveLength(3);
  });
});

describe('ground height', () => {
  const ON_DAIS = { x: 5, z: 5 };
  const ON_FLOOR = { x: 12, z: 12 };

  it('stands a placed entity on the ground under it at once', () => {
    const scene = sceneWithGround();

    scene.placeEntity(player({ position: ON_DAIS }));

    expect(scene._positionFor('self')).toEqual({ x: 5, y: 0.2, z: 5 });
  });

  it('eases a step up over the following frames and lands exactly on it', () => {
    const scene = sceneWithGround();
    scene.placeEntity(player({ position: ON_FLOOR }));

    scene.updatePosition('self', ON_DAIS, 0, undefined);
    // The simulation is already on the step; the rendered height has not moved yet.
    expect(scene._positionFor('self')).toEqual({ x: 5, y: 0, z: 5 });

    scene.tick(0.016);
    const first = scene._positionFor('self')!.y;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(0.2);

    for (let frame = 0; frame < 60; frame += 1) scene.tick(0.016);
    expect(scene._positionFor('self')!.y).toBe(0.2);
  });

  it('eases a step down the same way', () => {
    const scene = sceneWithGround();
    scene.placeEntity(player({ position: ON_DAIS }));

    scene.updatePosition('self', ON_FLOOR, 0, undefined);
    scene.tick(0.016);

    expect(scene._positionFor('self')!.y).toBeGreaterThan(0);
    expect(scene._positionFor('self')!.y).toBeLessThan(0.2);
  });

  it('keeps the camera on the rendered height of the player', () => {
    const scene = sceneWithGround();
    scene.placeEntity(player({ position: ON_FLOOR }));
    scene.updatePosition('self', ON_DAIS, 0, undefined);

    scene.tick(0.016);
    expect(cameraFocus(scene).y).toBeCloseTo(scene._positionFor('self')!.y, 12);
    expect(cameraFocus(scene).y).toBeGreaterThan(0);

    for (let frame = 0; frame < 60; frame += 1) scene.tick(0.016);
    expect(cameraFocus(scene).y).toBeCloseTo(0.2, 12);
  });

  it('keeps everything on the floor when it has no ground to read', () => {
    const scene = makeScene();
    scene.addSector(daisSector);

    scene.placeEntity(player({ position: ON_DAIS }));
    scene.tick(0.016);

    expect(scene._positionFor('self')!.y).toBe(0);
  });

  /** The client's collision is rebuilt whenever a sector arrives, so the scene reads it afresh rather than keeping the one it was handed. */
  it('reads the entered world as its sectors arrive', () => {
    const scene = makeScene();
    const entered = world();
    scene.enterSpace(entered);

    entered.addSector(daisSector);
    scene.placeEntity(player({ position: ON_DAIS }));

    expect(scene._positionFor('self')!.y).toBe(0.2);
  });

  /**
   * One clamped frame and a ten-second frame must ease by exactly the same amount, which is only
   * true while the clamp is in place; and the entity is genuinely mid-step rather than both having
   * landed, which would make the equality hold trivially.
   */
  it('never advances more than the max delta in one frame', () => {
    const stalled = sceneWithGround();
    const clamped = sceneWithGround();
    for (const scene of [stalled, clamped]) {
      scene.placeEntity(player({ position: ON_FLOOR }));
      scene.updatePosition('self', ON_DAIS, 0, undefined);
    }

    stalled.tick(10);
    clamped.tick(MAX_TICK_DELTA);

    expect(stalled._positionFor('self')).toEqual(clamped._positionFor('self'));
    expect(clamped._positionFor('self')!.y).toBeGreaterThan(0);
    expect(clamped._positionFor('self')!.y).toBeLessThan(0.2);
  });
});

describe('the ground under a point of the viewport', () => {
  const FOCUS = { x: 10, z: 10 };

  /** A scene looking at `FOCUS` at the default scale over a world holding `view`. */
  function framed(view: SectorView): { scene: WorldScene; entered: ClientWorld } {
    const scene = makeScene();
    const entered = world();
    scene.enterSpace(entered);
    entered.addSector(view);
    scene.frameShot(FOCUS, ORTHO_RIG.defaultScale);
    return { scene, entered };
  }

  function viewportOf(scene: WorldScene, x: number, y: number, z: number): THREE.Vector3 {
    scene.camera.updateMatrixWorld();
    return new THREE.Vector3(x, y, z).project(scene.camera);
  }

  /** Where the camera's line through a point `height` up comes down on the floor. */
  function floorBehind(point: Point, height: number): Point {
    const toCamera = offsetDirection();
    return { x: point.x - (height * toCamera.x) / toCamera.y, z: point.z - (height * toCamera.z) / toCamera.y };
  }

  /** The hall's porch, 1.03 m up, runs x 11.42..12.42 and z 9.73..13.35. */
  const hallSector = sector({ placements: [placement('hall-1', 'hall', { x: 10, z: 10 })] });

  it('finds nothing before a space is entered', () => {
    expect(makeScene().groundPointAt(0, 0)).toBeUndefined();
  });

  it('meets flat ground where the frustum puts it', () => {
    const { scene } = framed(sector());
    const bounds = frustumBounds(ORTHO_RIG.defaultScale, 1);
    const pitch = (ORTHO_RIG.pitchDegrees * Math.PI) / 180;
    const yaw = (ORTHO_RIG.yawDegrees * Math.PI) / 180;

    const centre = scene.groundPointAt(0, 0)!;
    expect(centre.x).toBeCloseTo(FOCUS.x, 9);
    expect(centre.z).toBeCloseTo(FOCUS.z, 9);
    expect(centre.height).toBe(0);

    // Up the screen runs away from the camera, stretched over the floor by the pitch.
    const up = scene.groundPointAt(0, 0.5)!;
    const away = (0.5 * bounds.top) / Math.sin(pitch);
    expect(up.x).toBeCloseTo(FOCUS.x - away * Math.sin(yaw), 9);
    expect(up.z).toBeCloseTo(FOCUS.z - away * Math.cos(yaw), 9);

    const right = scene.groundPointAt(0.5, 0)!;
    const across = 0.5 * bounds.right;
    expect(right.x).toBeCloseTo(FOCUS.x + across * Math.cos(yaw), 9);
    expect(right.z).toBeCloseTo(FOCUS.z - across * Math.sin(yaw), 9);
  });

  it('meets the top of a raised tread by its far edge, where the floor on the same line lies a metre beyond it', () => {
    const { scene, entered } = framed(hallSector);
    const onPorch = { x: 11.9, z: 9.8 };
    const drawn = viewportOf(scene, onPorch.x, 1.03, onPorch.z);

    const picked = scene.groundPointAt(drawn.x, drawn.y)!;

    expect(picked.x).toBeCloseTo(onPorch.x, 9);
    expect(picked.z).toBeCloseTo(onPorch.z, 9);
    expect(picked.height).toBe(1.03);
    const floor = floorBehind(onPorch, 1.03);
    expect(Math.hypot(floor.x - onPorch.x, floor.z - onPorch.z)).toBeCloseTo(1.03, 9);
    expect(groundHeightAt(entered.collision, floor)).toBe(0);
  });

  it('falls to the floor on a line passing just beyond the edge of the tread', () => {
    const { scene } = framed(hallSector);
    const pastEdge = { x: 11.9, z: 9.6 };
    const drawn = viewportOf(scene, pastEdge.x, 1.03, pastEdge.z);

    const picked = scene.groundPointAt(drawn.x, drawn.y)!;

    const floor = floorBehind(pastEdge, 1.03);
    expect(picked.x).toBeCloseTo(floor.x, 9);
    expect(picked.z).toBeCloseTo(floor.z, 9);
    expect(picked.height).toBe(0);
  });

  it('meets the surface nearest the camera where two lie on one line, whatever order they were placed in', () => {
    const dais = placement('dais-1', 'dais', { x: 5, z: 5 });
    const stage = placement('stage-1', 'stage', { x: 5, z: 5 });
    for (const placements of [
      [dais, stage],
      [stage, dais],
    ]) {
      const { scene } = framed(sector({ placements }));
      const drawn = viewportOf(scene, 5, 0.25, 5);

      const picked = scene.groundPointAt(drawn.x, drawn.y)!;

      expect(picked.x).toBeCloseTo(5, 9);
      expect(picked.z).toBeCloseTo(5, 9);
      expect(picked.height).toBe(0.25);
    }
  });

  /** The cursor 0.8 m over a body's feet, once with both bodies on the floor and once with both up on the porch. */
  it('faces the feet of the body drawn under the cursor, on the floor and up on the porch', () => {
    const pairs: [Point, Point][] = [
      [FOCUS, { x: 12, z: 9 }],
      [
        { x: 11.9, z: 13 },
        { x: 11.9, z: 10 },
      ],
    ];
    for (const [own, other] of pairs) {
      const { scene, entered } = framed(hallSector);
      scene.placeEntity(player({ position: own }));
      scene.placeEntity(player({ id: 'peer', kind: 'peer', position: other }));
      const drawn = viewportOf(scene, other.x, groundHeightAt(entered.collision, other) + 0.8, other.z);

      const aimed = scene.cursorFacingAt(drawn.x, drawn.y)!;

      expect(aimed.x).toBeCloseTo(other.x, 9);
      expect(aimed.z).toBeCloseTo(other.z, 9);
    }
  });

  /** The cursor 0.8 m over the player's feet passes 0.4 m over the feet of a body standing 0.4 m behind them. */
  it("faces nothing over the player's own body though a body is drawn behind it, and over no body the ground the walk steers to", () => {
    const { scene } = framed(hallSector);
    scene.placeEntity(player({ position: FOCUS }));
    scene.placeEntity(player({ id: 'peer', kind: 'peer', position: floorBehind(FOCUS, 0.4) }));
    const own = viewportOf(scene, FOCUS.x, 0.8, FOCUS.z);

    expect(scene.entityAt(own.x, own.y)).toBe('peer');
    expect(scene.cursorFacingAt(own.x, own.y)).toBeUndefined();

    const onPorch = viewportOf(scene, 11.9, 1.03, 9.8);
    const ground = scene.groundPointAt(onPorch.x, onPorch.y)!;
    expect(ground.height).toBe(1.03);
    expect(scene.cursorFacingAt(onPorch.x, onPorch.y)).toEqual({ x: ground.x, z: ground.z });
  });

  /** Where a Ghost overlapping a body at `FOCUS` stands: 0.28 m to its right and 0.1 m nearer the camera. */
  function overlappingGhost(scene: WorldScene): Point {
    scene.camera.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(scene.camera.matrixWorld, 0);
    const toCamera = new THREE.Vector2(offsetDirection().x, offsetDirection().z).normalize();
    return { x: FOCUS.x + 0.28 * right.x + 0.1 * toCamera.x, z: FOCUS.z + 0.28 * right.z + 0.1 * toCamera.y };
  }

  /**
   * A Ghost overlaps the player. The cursor 0.4 m over the player's feet passes the Ghost's middle
   * nearer the camera than the player's. But across the ground it meets the Ghost's front only
   * 0.21 m before the player's middle, and the player's front 0.3 m before it.
   */
  it("faces nothing over the player's own body where an overlapping body's middle lies nearer the camera but its front lies behind theirs", () => {
    const { scene } = framed(sector());
    scene.placeEntity(player({ position: FOCUS }));
    scene.placeEntity(player({ id: 'monster:1', kind: 'monster', name: 'Ghost', position: overlappingGhost(scene) }));
    const own = viewportOf(scene, FOCUS.x, 0.4, FOCUS.z);

    expect(scene.cursorFacingAt(own.x, own.y)).toBeUndefined();
  });

  /** As above with a peer where the player stood, and the player, whom a press passes through, well away. */
  it("presses the body whose front lies first where an overlapping body's middle lies nearer the camera", () => {
    const { scene } = framed(sector());
    scene.placeEntity(player({ position: { x: 6, z: 6 } }));
    scene.placeEntity(player({ id: 'peer', kind: 'peer', position: FOCUS }));
    scene.placeEntity(player({ id: 'monster:1', kind: 'monster', name: 'Ghost', position: overlappingGhost(scene) }));
    const peer = viewportOf(scene, FOCUS.x, 0.4, FOCUS.z);

    expect(scene.entityAt(peer.x, peer.y)).toBe('peer');
  });

  it('draws a point of the space where the pick finds it again, on the floor and on a raised tread', () => {
    expect(makeScene()._viewportPointOfGround(FOCUS)).toBeUndefined();
    const { scene } = framed(hallSector);
    for (const point of [
      { x: 8, z: 12 },
      { x: 11.9, z: 9.8 },
    ]) {
      const drawn = scene._viewportPointOfGround(point)!;

      const picked = scene.groundPointAt(drawn.x, drawn.y)!;

      expect(picked.x).toBeCloseTo(point.x, 9);
      expect(picked.z).toBeCloseTo(point.z, 9);
    }
  });
});

describe('post-prewarm self-heal', () => {
  /**
   * An arrival that wins the race against prewarm must not keep grey boxes for the session.
   */
  it('swaps placeholders for real models once the cache warms', async () => {
    const assets = emptyAssets();
    const scene = makeScene(assets);
    scene.addSector(sector({ placements: [placement('box-1', 'box')] }));
    expect(scene._placeholderObjectCount()).toBe(1);

    // The placeholder owns its `BoxGeometry`, so the swap has to free it rather than merely
    // unparenting it — once detached it is past the reach of any later cleanup, and a
    // membership assertion alone cannot tell the two apart.
    const placeholders = boxes(scene);
    expect(placeholders).toHaveLength(1);
    const placeholderDispose = vi.spyOn(placeholders[0]!.geometry, 'dispose');

    const warm = resolvingAssets();
    // Wrapped rather than assigned directly so the methods stay bound to `warm`.
    assets.object = (id) => warm.object(id);
    await scene.prewarm();

    expect(scene._placeholderObjectCount()).toBe(0);
    expect(placeholderDispose).toHaveBeenCalledTimes(1);
  });

  /**
   * The yaw lives on the placement's node, not on what hangs under it, so a model that resolves
   * later stands exactly as one that was there from the start: a door faces the same way for a
   * player whose sector loaded before its models did.
   */
  it('keeps the placement where it stood and as it was turned when its model resolves', async () => {
    const assets = emptyAssets();
    const scene = makeScene(assets);
    scene.addSector(sector({ placements: [placement('door-1', 'door', { yaw: 270 })] }));
    const node = scene.placementNode('EdariaSquare', 'door-1')!;
    const before = { position: node.position.clone(), yaw: node.rotation.y };

    const warm = resolvingAssets();
    assets.object = (id) => warm.object(id);
    await scene.prewarm();

    expect(scene.placementNode('EdariaSquare', 'door-1')).toBe(node);
    expect(node.position).toEqual(before.position);
    expect(node.rotation.y).toBe(before.yaw);
    expect(node.children).toHaveLength(1);
    // The model itself is not turned a second time.
    expect(node.children[0]!.rotation.y).toBe(0);
  });
});

describe('the model pack', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Every floor is a recipe, so a pack without floor textures is complete. */
  it('fetches models and no floor texture', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      requested.push(String(input instanceof Request ? input.url : input));
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await new HttpModelAssets(TEST_REGISTRY).prewarm();

    expect(requested.length).toBeGreaterThan(0);
    expect(requested.every((url) => url.includes('/assets/Models/'))).toBe(true);
  });

  /**
   * three keeps one program per material and checks it against each mesh it draws, and the shadow
   * pass draws every caster with one depth material, so a switch between a skinned and a rigid mesh
   * rebuilds a program's parameters, as many times a frame as they alternate.
   */
  it("gives a model's rigid meshes their own copy of a material its skinned meshes draw with, and its skinned meshes one depth material", async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(skinnedGLB())));
    const registry = { ...TEST_REGISTRY, characterModels: [{ id: 'hero', model: { stem: 'Hero', expectedClips: [] } }], objectModels: [] };
    const assets = new HttpModelAssets(registry);
    await assets.prewarm();

    const meshes = (root: THREE.Object3D): THREE.Mesh[] => {
      const found: THREE.Mesh[] = [];
      root.traverse((object) => {
        if ((object as THREE.Mesh).isMesh) found.push(object as THREE.Mesh);
      });
      return found;
    };
    const [first, second] = [assets.character('hero')!, assets.character('hero')!].map(meshes);
    const [body, helmet, cape] = first!;
    expect([(body as THREE.SkinnedMesh).isSkinnedMesh, (helmet as THREE.SkinnedMesh).isSkinnedMesh, (cape as THREE.SkinnedMesh).isSkinnedMesh]).toEqual([
      true,
      undefined,
      true,
    ]);
    expect(helmet!.material).not.toBe(body!.material);
    expect((helmet!.material as THREE.Material).type).toBe((body!.material as THREE.Material).type);
    expect(body!.customDepthMaterial).toBeInstanceOf(THREE.MeshDepthMaterial);
    expect(second![0]!.customDepthMaterial).toBe(body!.customDepthMaterial);
    expect(helmet!.customDepthMaterial).toBeUndefined();
    // A cut-out's depth must test its alpha, which three's own depth variant for it does.
    expect(cape!.customDepthMaterial).toBeUndefined();
  });

  it('gives a trophy the model its kind lies as, and a kind with none no model', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      requested.push(String(input instanceof Request ? input.url : input));
      return Promise.resolve(new Response(skinnedGLB()));
    });
    const assets = new HttpModelAssets({
      ...TEST_REGISTRY,
      characterModels: [],
      handModels: [],
      groundModels: [],
      trophyModels: [{ id: 'ghost', stem: 'GroundGhostlyWisp' }],
      objectModels: [],
    });
    await assets.prewarm();

    expect(requested).toEqual([expect.stringContaining('/assets/Models/GroundGhostlyWisp.glb')]);
    const meshes: THREE.Mesh[] = [];
    assets.trophy('ghost')!.traverse((object) => {
      if ((object as THREE.Mesh).isMesh) meshes.push(object as THREE.Mesh);
    });
    expect(meshes).toHaveLength(3);
    expect(assets.trophy('wolf')).toBeUndefined();
  });

  it("lays armour as its design at the tier it rolled at, and a weapon as its base's ground model", async () => {
    vi.stubGlobal('fetch', (input: RequestInfo | URL) =>
      Promise.resolve(
        String(input instanceof Request ? input.url : input).includes('GroundTunic.glb') ? new Response(null, { status: 404 }) : new Response(skinnedGLB()),
      ),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const assets = new HttpModelAssets({
      ...TEST_REGISTRY,
      characterModels: [],
      handModels: [],
      // The tier-1 alias does not load, so a tier that fell back to it would lie as nothing.
      groundModels: [
        { id: 'dagger', stem: 'GroundDagger' },
        { id: 'tunic', stem: 'GroundTunic' },
      ],
      wardrobe: [{ base: 'tunic', tier: 3, ground: 'GroundTunicT3', covers: [], wear: { default: 'WearTunicT3' } }],
      trophyModels: [],
      objectModels: [],
    });
    await assets.prewarm();

    expect([assets.ground('tunic', 3), assets.ground('tunic', 1), assets.ground('dagger', 3)].map((model) => model !== undefined)).toEqual([true, false, true]);
  });

  it("loads a worn piece again under a URL of its own on a retry, and answers every wait for it with the newer load's model, however late the first comes", async () => {
    const requested: string[] = [];
    let answerFirst!: () => void;
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      requested.push(String(input instanceof Request ? input.url : input));
      if (requested.length > 1) return Promise.resolve(new Response(skinnedGLB()));
      return new Promise<Response>((resolve) => (answerFirst = () => resolve(new Response(skinnedGLB()))));
    });
    const assets = new HttpModelAssets(TEST_REGISTRY);

    const first = assets.wear('WearCapT1Vigils');
    assets.retryWear(['WearCapT1Vigils']);
    // The first request still stalls: the wait asked for before the retry is answered by the retry.
    const retried = await first;
    answerFirst();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requested).toEqual([
      expect.stringMatching(/\/assets\/Models\/WearCapT1Vigils\.glb$/),
      expect.stringMatching(/\/assets\/Models\/WearCapT1Vigils\.glb\?retry=1$/),
    ]);
    expect(retried).toBeInstanceOf(THREE.Object3D);
    expect(await assets.wear('WearCapT1Vigils')).toBe(retried);
  });

  it("answers a wait with the retry's model when the first request fails while the retry is still on its way", async () => {
    const answers: (() => void)[] = [];
    vi.stubGlobal('fetch', () => {
      const failing = answers.length === 0;
      return new Promise<Response>((resolve) => answers.push(() => resolve(failing ? new Response('', { status: 404 }) : new Response(skinnedGLB()))));
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const assets = new HttpModelAssets(TEST_REGISTRY);

    const wait = assets.wear('WearCapT1Vigils');
    assets.retryWear(['WearCapT1Vigils']);
    answers[0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    answers[1]!();

    expect(await wait).toBeInstanceOf(THREE.Object3D);
  });

  it('answers a wait with no model when its only request fails', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('', { status: 404 })));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const assets = new HttpModelAssets(TEST_REGISTRY);

    expect(await assets.wear('WearCapT1Vigils')).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"WearCapT1Vigils" unavailable'));
  });
});

/**
 * A binary glTF of one bone and three meshes over one triangle: a body skinned to the bone, a
 * helmet that is not, sharing the body's material, and a skinned cape whose material cuts out.
 */
function skinnedGLB(): ArrayBuffer {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const joints = new Uint8Array(12);
  const weights = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  const inverseBind = new Float32Array(new THREE.Matrix4().toArray());
  const binary = new Uint8Array(positions.byteLength + joints.byteLength + weights.byteLength + inverseBind.byteLength);
  const views = [positions, joints, weights, inverseBind].map((array) => new Uint8Array(array.buffer));
  let offset = 0;
  const bufferViews = views.map((view) => {
    binary.set(view, offset);
    const entry = { buffer: 0, byteOffset: offset, byteLength: view.byteLength };
    offset += view.byteLength;
    return entry;
  });
  const skinned = { attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 } };
  const document = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ children: [1, 2, 3, 4] }, { name: 'bone' }, { mesh: 0, skin: 0 }, { mesh: 1 }, { mesh: 2, skin: 0 }],
    meshes: [
      { primitives: [{ ...skinned, material: 0 }] },
      { primitives: [{ attributes: { POSITION: 0 }, material: 0 }] },
      { primitives: [{ ...skinned, material: 1 }] },
    ],
    materials: [{ name: 'body' }, { name: 'cape', alphaMode: 'MASK' }],
    skins: [{ joints: [1], inverseBindMatrices: 3 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5121, count: 3, type: 'VEC4' },
      { bufferView: 2, componentType: 5126, count: 3, type: 'VEC4' },
      { bufferView: 3, componentType: 5126, count: 1, type: 'MAT4' },
    ],
    bufferViews,
    buffers: [{ byteLength: binary.byteLength }],
  };
  // A chunk's length is a multiple of 4 bytes, the JSON padded with spaces.
  const text = JSON.stringify(document);
  const json = new TextEncoder().encode(text.padEnd(Math.ceil(text.length / 4) * 4, ' '));
  const glb = new Uint8Array(12 + 8 + json.byteLength + 8 + binary.byteLength);
  const header = new DataView(glb.buffer);
  header.setUint32(0, 0x46546c67, true);
  header.setUint32(4, 2, true);
  header.setUint32(8, glb.byteLength, true);
  header.setUint32(12, json.byteLength, true);
  header.setUint32(16, 0x4e4f534a, true);
  glb.set(json, 20);
  header.setUint32(20 + json.byteLength, binary.byteLength, true);
  header.setUint32(24 + json.byteLength, 0x004e4942, true);
  glb.set(binary, 28 + json.byteLength);
  return glb.buffer;
}

describe('an entity placed again', () => {
  /** Where every entity placeholder reachable from the scene's root stands. */
  function drawnAt(scene: WorldScene): THREE.Vector3[] {
    return boxes(scene).map((box) => box.parent!.getWorldPosition(new THREE.Vector3()));
  }

  /** What the scene held about an entity of the space being left belongs to a root that is on its way out. */
  it('is drawn in the new space after a space change', () => {
    const scene = makeScene();
    scene.placeEntity(player());

    scene.enterSpace(world('EdariaInn'));
    scene.placeEntity(player({ position: { x: 3, z: 4 } }));

    expect(drawnAt(scene)).toEqual([new THREE.Vector3(3, 0, 4)]);
  });

  it('is drawn again after it was removed', () => {
    const scene = makeScene();
    scene.placeEntity(player({ id: 'peer', kind: 'peer' }));
    scene.removeEntity('peer');
    expect(drawnAt(scene)).toEqual([]);

    scene.placeEntity(player({ id: 'peer', kind: 'peer', position: { x: 3, z: 4 } }));

    expect(drawnAt(scene)).toEqual([new THREE.Vector3(3, 0, 4)]);
  });
});

describe('overlay quads', () => {
  /** The overlay quads whose size is measurable without a GPU: planes textured from a canvas. */
  function overlayPlates(scene: WorldScene): THREE.Mesh[] {
    const plates: THREE.Mesh[] = [];
    scene.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      const material = mesh.material as THREE.MeshBasicMaterial | undefined;
      if (mesh.isMesh && material?.map?.image instanceof HTMLCanvasElement && mesh.geometry instanceof THREE.PlaneGeometry) plates.push(mesh);
    });
    return plates;
  }

  it('scales overlay artwork to 1.6 cm a pixel', () => {
    const scene = makeScene();
    scene.placeEntity(player());

    // The same inputs the scene passes for a player plaque, so the artwork dimensions match.
    const art = renderNamePlaque(player().name, NAME_PLAQUE.playerBackground, true);
    const size = planeSize(overlayPlates(scene)[0]!);
    expect(size.width).toBeCloseTo(art.widthPixels * 0.016, 12);
    expect(size.height).toBeCloseTo(art.heightPixels * 0.016, 12);
  });

  /** Tone mapping would shift the painted plaque and the rings off the colours they mean. */
  it('keeps the plaques and the rings out of tone mapping', () => {
    const scene = makeScene();
    scene.placeEntity(player());
    scene.placeEntity(clientEntity({ id: 'peer-1', kind: 'peer', name: 'Mira' }));
    scene.showSelection('peer-1', PLAIN_MARK);

    const materials = [...overlayPlates(scene), ...rings(scene)].map((mesh) => mesh.material as THREE.MeshBasicMaterial);
    expect(materials.length).toBeGreaterThanOrEqual(3);
    for (const material of materials) expect(material.toneMapped).toBe(false);
  });

  it('hangs the plaque a gap below the feet and advances it toward the camera to clear the floor', () => {
    const scene = makeScene();
    scene.placeEntity(player());

    const plate = overlayPlates(scene)[0]!;
    const height = planeSize(plate).height;
    expect(plate.position.y).toBeCloseTo(-(height / 2 + 0.15), 12);
    // At the rig's 45-degree pitch the advance equals the drop, plus the clearance.
    expect(plate.position.z).toBeCloseTo(height + 0.15 + 0.15, 9);
  });

  /**
   * A bubble over a head ends its tail on the head's rim. The head is measured off the model
   * holder's bounds, relative to the entity's own feet: on raised ground the bounds are higher in
   * the world, and the head is drawn from a node that is already up there.
   */
  it.each([
    ['on the floor', { x: 12, z: 12 }, 0],
    ['on raised ground', { x: 5, z: 5 }, 0.2],
  ])('ends the tail of a speech balloon on the head of a speaker %s', (_name, position, ground) => {
    const scene = sceneWithGround();
    scene.placeEntity(player({ position }));

    scene.showSpeechBubble(said('self', ['Hallo'], 3000));

    expectTailAt(scene, standingHeadTop(scene, new THREE.Vector3(position.x, ground, position.z), CHARACTER_SCALE));
  });

  /** Until a clip plays, a model's bones rest wherever its file left them: for one model of the pack, far below its feet. */
  it('measures a model standing in its idle pose, not where its bones rest', () => {
    const { root, bone } = skinnedModel();
    bone.name = 'Root';
    bone.position.y = -15;
    const idle = new THREE.AnimationClip('Idle', 1, [new THREE.VectorKeyframeTrack('Root.position', [0], [0, 0, 0])]);
    const scene = makeScene({ ...emptyAssets(), character: () => root, clipsFor: () => [idle] });
    scene.placeEntity(player());

    scene.showSpeechBubble(said('self', ['Hallo'], 3000));

    expectTailAt(scene, standingHeadTop(scene, new THREE.Vector3(10, 0, 10), CHARACTER_SCALE));
  });

  /** The model that replaces a placeholder has a height of its own, and stands wherever the entity already does. */
  it('measures again when a model replaces the placeholder of an entity on raised ground', async () => {
    const assets = emptyAssets();
    const scene = makeScene(assets);
    const entered = world();
    scene.enterSpace(entered);
    entered.addSector(daisSector);
    scene.addSector(daisSector);
    scene.placeEntity(player({ position: { x: 5, z: 5 } }));
    scene.showSpeechBubble(said('self', ['Hallo'], 3000));
    const feet = new THREE.Vector3(5, 0.2, 5);
    expectTailAt(scene, standingHeadTop(scene, feet, CHARACTER_SCALE));

    // Twice as tall as the placeholder it replaces.
    const { root } = skinnedModel();
    root.scale.y = 2;
    assets.character = () => root;
    await scene.prewarm();
    scene.showSpeechBubble(said('self', ['Hallo'], 3000));

    expectTailAt(scene, standingHeadTop(scene, feet, 2 * CHARACTER_SCALE));
  });

  /**
   * A skinned mesh keeps the bounds of the pose it is first measured in, so the head is followed
   * down by its bone instead. The fall carries the head well past where the upright body would be
   * picked, so the bubble and the pick both have to follow it.
   */
  describe('a fallen body', () => {
    /** A peer at (12, 10) whose fall lowers its head bone to near the ground, 1.2 units east of its feet. */
    function fallenPeer(): { scene: WorldScene; head: THREE.Bone } {
      const { root, head } = skinnedModel();
      const idle = new THREE.AnimationClip('Idle', 1, []);
      const fall = new THREE.AnimationClip('Death_A', 1, [new THREE.VectorKeyframeTrack('head.position', [0, 1], [0, 0.9, 0, 1.2, 0.2, 0])]);
      const scene = makeScene({ ...emptyAssets(), character: (id) => (id === 'fallen' ? root : undefined), clipsFor: () => [idle, fall] });
      scene.placeEntity(player());
      scene.placeEntity(player({ id: 'peer', kind: 'peer', characterModelId: 'fallen', position: { x: 12, z: 10 } }));
      scene.updateCondition('peer', 'fallen');
      for (let elapsed = 0; elapsed < 2; elapsed += MAX_TICK_DELTA) scene.tick(MAX_TICK_DELTA);
      return { scene, head };
    }

    function lyingHead(head: THREE.Bone): THREE.Vector3 {
      head.updateWorldMatrix(true, false);
      return head.getWorldPosition(new THREE.Vector3());
    }

    it('ends the tail of its bubble where the head lies, and at the standing head once it stands', () => {
      const { scene, head } = fallenPeer();
      const standing = standingHeadTop(scene, new THREE.Vector3(12, 0, 10), CHARACTER_SCALE);
      const lying = screenOf(scene, lyingHead(head));
      expect(Math.hypot(lying.x - standing.x, lying.y - standing.y)).toBeGreaterThan(0.6);

      scene.showSpeechBubble(said('peer', ['Hallo'], 3000));
      const tail = bubbleSaying(scene, 'Hallo')!.tail!;
      expect(Math.hypot(tail.x - lying.x, tail.y - lying.y)).toBeLessThan(0.15);

      scene.updateCondition('peer', 'hale');
      scene.tick(MAX_TICK_DELTA);
      expectTailAt(scene, standing);
    });

    /** A point 0.25 m on past the head along the body lies in the round end of its capsule alone. */
    it('is picked where the head lies and a little past it, and not where its head would stand', () => {
      const { scene, head } = fallenPeer();
      scene.camera.updateMatrixWorld();
      const lyingAt = lyingHead(head);
      const lying = lyingAt.clone().project(scene.camera);
      const alongBody = new THREE.Vector3().subVectors(lyingAt, new THREE.Vector3(12, 0, 10)).normalize();
      const past = lyingAt.clone().addScaledVector(alongBody, 0.25).project(scene.camera);
      const upright = new THREE.Vector3(12, CHARACTER_SCALE, 10).project(scene.camera);

      expect(scene.entityAt(lying.x, lying.y)).toBe('peer');
      expect(scene.entityAt(past.x, past.y)).toBe('peer');
      expect(scene.entityAt(upright.x, upright.y)).toBeUndefined();
    });

    it('reports its screen point where it lies, and a click there picks it', () => {
      const { scene } = fallenPeer();
      scene.camera.updateMatrixWorld();
      const point = scene._viewportPointFor('peer')!;
      const upright = new THREE.Vector3(12, CHARACTER_SCALE / 2, 10).project(scene.camera);

      expect(scene.entityAt(point.x, point.y)).toBe('peer');
      expect(Math.hypot(point.x - upright.x, point.y - upright.y)).toBeGreaterThan(0.04);
    });
  });
});

/** The one bubble on screen ends its tail at `expected`. */
function expectTailAt(scene: WorldScene, expected: ScreenPoint): void {
  const [bubble] = scene.placedBubbles().bubbles;
  // The bounds come from Float32 vertex data, hence the looser match.
  expect(bubble!.tail!.x).toBeCloseTo(expected.x, 5);
  expect(bubble!.tail!.y).toBeCloseTo(expected.y, 5);
}

describe('what a pointer is over, and the target', () => {
  /** Where a point of the world lands in the viewport, in normalized device coordinates. */
  function viewportOf(scene: WorldScene, x: number, y: number, z: number): THREE.Vector3 {
    scene.camera.updateMatrixWorld();
    return new THREE.Vector3(x, y, z).project(scene.camera);
  }

  it('picks the entity drawn under a point by its body from feet to head, and never the player', () => {
    const scene = makeScene();
    scene.placeEntity(player());
    scene.placeEntity(player({ id: 'peer', kind: 'peer', position: { x: 12, z: 10 } }));

    const body = viewportOf(scene, 12, CHARACTER_SCALE / 2, 10);
    expect(scene.entityAt(body.x, body.y)).toBe('peer');
    const feet = viewportOf(scene, 12, 0, 10);
    expect(scene.entityAt(feet.x, feet.y)).toBe('peer');
    const drawn = scene._viewportPointFor('peer')!;
    expect(drawn.x).toBeCloseTo(body.x, 6);
    expect(drawn.y).toBeCloseTo(body.y, 6);
    expect(scene._viewportPointFor('nobody')).toBeUndefined();
    const own = viewportOf(scene, 10, CHARACTER_SCALE / 2, 10);
    expect(scene.entityAt(own.x, own.y)).toBeUndefined();
    const ground = viewportOf(scene, 12, 0, 13);
    expect(scene.entityAt(ground.x, ground.y)).toBeUndefined();
  });

  /**
   * A point `metres` up the screen from a point of the world, which lies that far from it beside the
   * camera's ray: the camera's up crosses the ray.
   */
  function upScreenOf(scene: WorldScene, point: THREE.Vector3, metres: number): THREE.Vector3 {
    scene.camera.updateMatrixWorld();
    const up = new THREE.Vector3().setFromMatrixColumn(scene.camera.matrixWorld, 1);
    return point.clone().addScaledVector(up, metres).project(scene.camera);
  }

  /**
   * The capsule's side reaches 0.21 m up the screen past the top of the head, and down past the feet,
   * the rim of its end seen at the camera's 45° pitch. Its round ends reach the radius, 0.3 m.
   */
  it('picks a body by the round ends of its capsule, past the top of its head and below its feet', () => {
    const scene = makeScene();
    scene.placeEntity(player());
    scene.placeEntity(player({ id: 'peer', kind: 'peer', position: { x: 12, z: 10 } }));

    const overHead = upScreenOf(scene, new THREE.Vector3(12, CHARACTER_SCALE, 10), 0.25);
    expect(scene.entityAt(overHead.x, overHead.y)).toBe('peer');
    const underFeet = upScreenOf(scene, new THREE.Vector3(12, 0, 10), -0.25);
    expect(scene.entityAt(underFeet.x, underFeet.y)).toBe('peer');
  });

  /**
   * A body twice as tall stands 0.48 m behind a peer. The cursor 0.25 m up the screen past the top of
   * the peer's head passes over the peer's side, enters its head's round end 0.17 m before it passes
   * nearest that head, and enters the tall body's side as it passes there, before leaving the peer's head.
   */
  it("picks a body the ray enters by its head's round end ahead of the side of a taller body behind it", () => {
    const { root } = skinnedModel();
    root.scale.y = 2;
    const scene = makeScene({ ...emptyAssets(), character: (id) => (id === 'tall' ? root : undefined) });
    scene.placeEntity(player());
    scene.camera.updateMatrixWorld();
    const away = new THREE.Vector3().setFromMatrixColumn(scene.camera.matrixWorld, 2).setY(0).normalize().multiplyScalar(-0.48);
    scene.placeEntity(player({ id: 'peer', kind: 'peer', position: { x: 12, z: 10 } }));
    scene.placeEntity(player({ id: 'tall', kind: 'peer', characterModelId: 'tall', position: { x: 12 + away.x, z: 10 + away.z } }));

    const overHead = upScreenOf(scene, new THREE.Vector3(12, CHARACTER_SCALE, 10), 0.25);
    expect(scene.entityAt(overHead.x, overHead.y)).toBe('peer');
  });

  it('passes over a nightmare driven off to the ground it lies on', () => {
    const scene = makeScene();
    scene.enterSpace(world());
    scene.placeEntity(player());
    scene.placeEntity(player({ id: 'monster:1', kind: 'monster', name: 'Ghost', position: { x: 12, z: 10 } }));
    scene.updateCondition('monster:1', 'fallen');

    const feet = viewportOf(scene, 12, 0, 10);
    expect(scene.entityAt(feet.x, feet.y)).toBeUndefined();
    expect(scene.pressTargetAt(feet.x, feet.y)).toMatchObject({ kind: 'ground' });
  });

  /**
   * A point beside a body's middle by `metres` across the screen, which lies that far from the
   * capsule a body is picked by: the camera's right is level, so it crosses both the ray and the body.
   */
  function besideBody(scene: WorldScene, at: { x: number; z: number }, metres: number): THREE.Vector3 {
    scene.camera.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(scene.camera.matrixWorld, 0);
    return viewportOf(scene, at.x + right.x * metres, CHARACTER_SCALE / 2 + right.y * metres, at.z + right.z * metres);
  }

  /** A body is picked by the radius it is drawn with. A finger covers more than a body is wide, so under one it is picked from 0.6 m round it. */
  it.each([
    ['a mouse', false, 0.3],
    ['a finger', true, 0.6],
  ])('picks a body from as far beside it as its pick radius under %s, and no further', (_label, coarse, radius) => {
    const scene = makeScene();
    scene.coarsePointer = coarse;
    scene.placeEntity(player());
    scene.placeEntity(player({ id: 'peer', kind: 'peer', position: { x: 13, z: 10 } }));
    for (const [side, inside] of [
      [1, 0.98],
      [-1, 0.98],
      [1, 1.02],
    ] as const) {
      const besidePeer = besideBody(scene, { x: 13, z: 10 }, side * inside * radius);
      expect(scene.entityAt(besidePeer.x, besidePeer.y)).toBe(inside < 1 ? 'peer' : undefined);
    }
  });

  /**
   * A body bound 0.1 m round that its idle pose spreads to 0.5 m, as a wolf's snout and tail reach
   * past its 0.3 m radius, is picked as far out as it is drawn standing, and no further. The blade
   * its hand holds out 1 m is no part of the body, and a press near its tip passes the body by.
   */
  it('picks a body whose idle pose reaches past its radius as far beside it as the model is drawn, its held blade aside', () => {
    const { root, bone } = skinnedModel(new THREE.CylinderGeometry(0.1 / CHARACTER_SCALE, 0.1 / CHARACTER_SCALE, 1).translate(0, 0.5, 0));
    bone.name = 'Root';
    const hand = Object.assign(new THREE.Bone(), { name: 'handslotr' });
    hand.position.y = 0.5;
    root.add(hand);
    const idle = new THREE.AnimationClip('Idle', 1, [new THREE.VectorKeyframeTrack('Root.scale', [0], [5, 1, 5])]);
    const blade = (): THREE.Object3D => new THREE.Mesh(new THREE.BoxGeometry(1 / CHARACTER_SCALE, 0.02, 0.02).translate(0.5 / CHARACTER_SCALE, 0, 0));
    const scene = makeScene({ ...emptyAssets(), character: (id) => (id === 'wide' ? root : undefined), hand: blade, clipsFor: () => [idle] });
    scene.placeEntity(player());
    scene.placeEntity(player({ id: 'peer', kind: 'peer', characterModelId: 'wide', position: { x: 13, z: 10 }, outfit: outfit({ mainHand: 'sword' }) }));
    for (const [metres, picked] of [
      [0.45, 'peer'],
      [-0.45, 'peer'],
      [0.55, undefined],
      [0.95, undefined],
    ] as const) {
      const besidePeer = besideBody(scene, { x: 13, z: 10 }, metres);
      expect(scene.entityAt(besidePeer.x, besidePeer.y)).toBe(picked);
    }
  });

  describe('a fixture', () => {
    const BOARD = 'fixture:EdariaSquare/fixture-1';
    /** A notice board's face: a board 1.4 m wide raised 1 m on its posts, which stand on no more ground than the face is thick. */
    const boardFace = (): THREE.Object3D => new THREE.Mesh(new THREE.BoxGeometry(1.4, 1, 0.1).translate(0, 1.5, 0));
    const boardSector = sector({
      placements: [placement('notice-board-1', 'box', { x: 4, z: 6 })],
      fixtures: [{ id: 'fixture-1', placement: 'notice-board-1', service: 'bountyBoard' }],
    });

    /** The player at (10, 10), and the board standing at (4, 6). */
    function boardScene(): WorldScene {
      const scene = makeScene({ ...emptyAssets(), object: boardFace });
      const entered = world();
      scene.enterSpace(entered);
      entered.addSector(boardSector);
      scene.addSector(boardSector);
      scene.placeEntity(player());
      return scene;
    }

    it('is pressed by its drawn face, whose ray meets the ground well beyond where it stands, and not beside it', () => {
      const scene = boardScene();
      const face = scene._viewportPointOfFixture(BOARD)!;
      expect(scene.pressTargetAt(face.x, face.y)).toEqual({ kind: 'fixture', carrierId: BOARD });
      const beyond = scene.groundPointAt(face.x, face.y)!;
      expect(Math.hypot(beyond.x - 4, beyond.z - 6)).toBeGreaterThan(1);
      const beside = viewportOf(scene, 6, 1.5, 6);
      expect(scene.pressTargetAt(beside.x, beside.y)).toMatchObject({ kind: 'ground' });
      expect(scene._viewportPointOfFixture('fixture:EdariaSquare/nothing')).toBeUndefined();
    });

    it('is pressed after a body drawn over it', () => {
      const scene = boardScene();
      const face = scene._viewportPointOfFixture(BOARD)!;
      const under = scene.groundPointAt(face.x, face.y)!;
      scene.placeEntity(player({ id: 'bren', kind: 'peer', position: { x: under.x, z: under.z } }));
      expect(scene.pressTargetAt(face.x, face.y)).toEqual({ kind: 'entity', entityId: 'bren' });
    });

    it('is no longer pressed once its sector is no longer drawn', () => {
      const scene = boardScene();
      const face = scene._viewportPointOfFixture(BOARD)!;
      scene.removeSector('EdariaSquare');
      expect(scene.fixtureAt(face.x, face.y)).toBeUndefined();
    });
  });

  describe('a drop', () => {
    const drop = (lootId: string, x: number, z: number, rarity: Rarity = 'rare'): LootMessage => ({
      lootId,
      x,
      z,
      contents: { kind: 'item', baseId: 'dagger', tier: 1, rarity },
    });

    /** A dagger as its ground model lies: low and long, its ground bounds centred on its origin. */
    function lyingDagger(): THREE.Mesh {
      return new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.05, 0.1).translate(0, 0.025, 0));
    }

    /** The player at (10, 10), a Ghost standing on a drop at (13, 10), and a drop on open ground at (10, 13). */
    function dropsAround(scene = makeScene({ ...emptyAssets(), ground: lyingDagger })): WorldScene {
      scene.enterSpace(world());
      scene.placeEntity(player());
      scene.placeEntity(player({ id: 'monster:1', kind: 'monster', name: 'Ghost', position: { x: 13, z: 10 } }));
      scene.showLoot(drop('under', 13, 10));
      scene.showLoot(drop('open', 10, 13));
      return scene;
    }

    /** The visible meshes of the drops named `name`. */
    function shown(scene: WorldScene, name: string): THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[] {
      const meshes: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[] = [];
      scene.scene.getObjectByName(LOOT_MARKERS_NAME)!.traverseVisible((object) => {
        if (object.name === name) meshes.push(object as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>);
      });
      return meshes;
    }

    it("is pressed by its name before a body, a body before its model, and its model before the ground, the player's own body no part of it", () => {
      const scene = dropsAround();
      // A body standing on the ground under the name is drawn over it, and the name still takes the press.
      const label = scene._viewportPointOfLoot('under', 'label')!;
      const underName = scene.groundPointAt(label.x, label.y)!;
      scene.placeEntity(player({ id: 'bren', kind: 'peer', position: { x: underName.x, z: underName.z } }));
      expect(scene.entityAt(label.x, label.y)).toBe('bren');
      expect(scene.pressTargetAt(label.x, label.y)).toEqual({ kind: 'loot', lootId: 'under' });
      scene.removeEntity('bren');

      const under = scene._viewportPointOfLoot('under', 'model')!;
      expect(scene.pressTargetAt(under.x, under.y)).toEqual({ kind: 'entity', entityId: 'monster:1' });
      const open = scene._viewportPointOfLoot('open', 'model')!;
      expect(scene.pressTargetAt(open.x, open.y)).toEqual({ kind: 'loot', lootId: 'open' });
      const body = viewportOf(scene, 10, CHARACTER_SCALE / 2, 10);
      const underBody = scene.groundPointAt(body.x, body.y)!;
      expect(scene.pressTargetAt(body.x, body.y)).toEqual({ kind: 'ground', point: { x: underBody.x, z: underBody.z } });
      scene.showLoot(drop('own', 10, 10));
      const own = scene._viewportPointOfLoot('own', 'model')!;
      expect(scene.pressTargetAt(own.x, own.y)).toEqual({ kind: 'loot', lootId: 'own' });
      const ground = viewportOf(scene, 7, 0, 13);
      expect(scene.pressTargetAt(ground.x, ground.y)).toMatchObject({ kind: 'ground', point: { x: expect.closeTo(7, 5), z: expect.closeTo(13, 5) } });
    });

    /** How far up the screen a mesh is drawn, lowest and highest, in viewport units. */
    function screenSpan(scene: WorldScene, mesh: THREE.Mesh): [number, number] {
      mesh.updateWorldMatrix(true, false);
      const position = mesh.geometry.getAttribute('position');
      const heights = Array.from({ length: position.count }, (_, index) => {
        const vertex = new THREE.Vector3().fromBufferAttribute(position, index).applyMatrix4(mesh.matrixWorld);
        return viewportOf(scene, vertex.x, vertex.y, vertex.z).y;
      });
      return [Math.min(...heights), Math.max(...heights)];
    }

    it('stands its name centred under its model on screen, its top edge clear of the model, whatever way the model lies', () => {
      const laid: THREE.Mesh[] = [];
      const scene = dropsAround(makeScene({ ...emptyAssets(), ground: () => laid[laid.push(lyingDagger()) - 1] }));
      const plates: THREE.Mesh[] = [];
      scene.scene.getObjectByName(LOOT_MARKERS_NAME)!.traverseVisible((object) => {
        if ((object as THREE.Mesh).isMesh && ((object as THREE.Mesh).material as THREE.Material).depthTest === false) plates.push(object as THREE.Mesh);
      });
      expect(plates).toHaveLength(2);
      for (const [index, lootId] of ['under', 'open'].entries()) {
        const label = scene._viewportPointOfLoot(lootId, 'label')!;
        const model = scene._viewportPointOfLoot(lootId, 'model')!;
        expect(label.x).toBeCloseTo(model.x, 6);
        const [modelBottom] = screenSpan(scene, laid[index]!);
        const [, plateTop] = screenSpan(scene, plates[index]!);
        expect(plateTop, lootId).toBeLessThan(modelBottom);
        expect(scene.pressTargetAt(label.x, plateTop - 0.001)).toEqual({ kind: 'loot', lootId });
      }
    });

    it('lies at a yaw of its own, the same each time it is drawn', () => {
      const laid: THREE.Object3D[] = [];
      const scene = dropsAround(makeScene({ ...emptyAssets(), ground: () => laid[laid.push(lyingDagger()) - 1] }));
      const [under, open] = laid.map((model) => model.parent!.rotation.y);
      expect(Math.abs(under! - open!)).toBeGreaterThan(0.1);
      scene.removeLoot('under', false);
      scene.showLoot(drop('under', 13, 10));
      expect(laid.at(-1)!.parent!.rotation.y).toBe(under);
    });

    it('draws its name alone while it has no model, and lays its model once the models are loaded', async () => {
      let loaded = false;
      const scene = dropsAround(makeScene({ ...emptyAssets(), ground: () => (loaded ? lyingDagger() : undefined) }));
      expect(scene._viewportPointOfLoot('open', 'model')).toBeUndefined();
      const label = scene._viewportPointOfLoot('open', 'label')!;
      expect(scene.pressTargetAt(label.x, label.y)).toEqual({ kind: 'loot', lootId: 'open' });

      loaded = true;
      await scene.prewarm();
      const model = scene._viewportPointOfLoot('open', 'model')!;
      expect(scene.pressTargetAt(model.x, model.y)).toEqual({ kind: 'loot', lootId: 'open' });
    });

    it("lays armour as its design's ground model at the tier it rolled, a set piece as its line's", () => {
      const scene = makeScene({ ...emptyAssets(), ground: (baseId, tier, line) => Object.assign(lyingDagger(), { name: `${baseId}:${tier}:${line ?? ''}` }) });
      scene.enterSpace(world());
      scene.placeEntity(player());
      scene.showLoot({ lootId: 'tunic', x: 13, z: 10, contents: { kind: 'item', baseId: 'tunic', tier: 1, rarity: 'common' } });
      scene.showLoot({ lootId: 'raincoat', x: 10, z: 13, contents: { kind: 'item', baseId: 'tunic', tier: 3, rarity: 'common' } });
      scene.showLoot({ lootId: 'hood', x: 7, z: 10, contents: { kind: 'item', baseId: 'cap', tier: 3, rarity: 'uncommon' } });
      scene.showLoot({ lootId: 'wimple', x: 10, z: 7, contents: { kind: 'item', baseId: 'cap', tier: 3, rarity: 'epic', line: 'healer' } });
      expect(['tunic:1:', 'tunic:3:', 'cap:3:', 'cap:3:healer'].map((name) => shown(scene, name).length)).toEqual([1, 1, 1, 1]);
    });

    it("names a drop of armour after its design at the tier it rolled, a set piece after its line's", () => {
      const named = vi.spyOn(LootMarkers.prototype, 'show');
      const scene = makeScene(emptyAssets());
      scene.enterSpace(world());
      scene.placeEntity(player());
      scene.showLoot({ lootId: 'raincoat', x: 10, z: 13, contents: { kind: 'item', baseId: 'tunic', tier: 3, rarity: 'common' } });
      scene.showLoot({ lootId: 'wimple', x: 13, z: 10, contents: { kind: 'item', baseId: 'cap', tier: 3, rarity: 'epic', line: 'healer' } });
      expect(named.mock.calls.map(([drop]) => drop.name)).toEqual(["Ferryman's raincoat", 'Linen wimple']);
    });

    it("lays a trophy as its kind's model, and one whose kind has none as its name alone", () => {
      const scene = makeScene({ ...emptyAssets(), trophy: (monsterKind) => (monsterKind === 'ghost' ? lyingDagger() : undefined) });
      scene.enterSpace(world());
      scene.placeEntity(player());
      scene.showLoot({ lootId: 'wisp', x: 13, z: 10, contents: { kind: 'trophy', monsterKind: 'ghost' } });
      scene.showLoot({ lootId: 'fang', x: 10, z: 13, contents: { kind: 'trophy', monsterKind: 'wolf' } });
      const wisp = scene._viewportPointOfLoot('wisp', 'model')!;
      expect(scene.pressTargetAt(wisp.x, wisp.y)).toEqual({ kind: 'loot', lootId: 'wisp' });
      expect(scene._viewportPointOfLoot('fang', 'model')).toBeUndefined();
      const fang = scene._viewportPointOfLoot('fang', 'label')!;
      expect(scene.pressTargetAt(fang.x, fang.y)).toEqual({ kind: 'loot', lootId: 'fang' });
    });

    it('raises a beam from a rare and an epic drop, glows under an uncommon, a rare, and an epic one, and names each, all in its colour, a trophy as a common drop', () => {
      expect(RARITY_COLORS).toEqual({ common: 0xf2efe8, uncommon: 0x7aea4b, rare: 0x4998fe, epic: 0xd06fed });
      const scene = makeScene({ ...emptyAssets(), ground: lyingDagger, trophy: lyingDagger });
      scene.enterSpace(world());
      scene.placeEntity(player());
      const inks: unknown[] = [];
      const context = {
        fillStyle: '',
        scale() {},
        fillRect() {},
        strokeRect() {},
        measureText: () => ({ width: 14 }),
        fillText() {
          inks.push(this.fillStyle);
        },
      };
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
      try {
        for (const [index, rarity] of RARITIES.entries()) scene.showLoot(drop(rarity, 4 + index * 3, 4, rarity));
        scene.showLoot({ lootId: 'wisp', x: 16, z: 4, contents: { kind: 'trophy', monsterKind: 'ghost' } });
      } finally {
        vi.restoreAllMocks();
      }
      expect(shown(scene, LOOT_BEAM_NAME).map((beam) => [beam.parent!.position.x, beam.material.color.getHex()])).toEqual([
        [10, RARITY_COLORS.rare],
        [13, RARITY_COLORS.epic],
      ]);
      expect(shown(scene, LOOT_GLOW_NAME).map((glow) => [glow.parent!.position.x, glow.material.color.getHex()])).toEqual([
        [7, RARITY_COLORS.uncommon],
        [10, RARITY_COLORS.rare],
        [13, RARITY_COLORS.epic],
      ]);
      expect(inks).toEqual([...RARITIES, 'common' as const].map((rarity) => `#${RARITY_COLORS[rarity].toString(16)}`));
    });

    it('brightens and dims a rare and an epic beam together, and holds them steady under reduced motion', () => {
      for (const reducedMotion of [false, true]) {
        const scene = new WorldScene({ ...emptyAssets(), ground: lyingDagger }, TEST_REGISTRY, 1, reducedMotion);
        scene.enterSpace(world());
        scene.placeEntity(player());
        scene.showLoot(drop('rare', 12, 10));
        scene.showLoot(drop('epic', 14, 10, 'epic'));
        const opacities = [0.3, 0.6, 0.6].map((seconds) => {
          scene.tick(seconds);
          const [rare, epic] = shown(scene, LOOT_BEAM_NAME).map((beam) => beam.material.opacity);
          expect(epic).toBe(rare);
          return rare;
        });
        expect(new Set(opacities).size, `reduced motion ${reducedMotion}`).toBe(reducedMotion ? 1 : 3);
      }
    });

    /** `dropsAround`, its ground models in `laid` ('under' first, then 'open'), on a wall clock that `tick` moves in steps of 50 ms and `hide` moves alone. */
    function fading(reducedMotion = false): {
      scene: WorldScene;
      laid: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[];
      tick: (seconds: number) => void;
      hide: (ms: number) => void;
    } {
      let wallMs = 0;
      const laid: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[] = [];
      const ground = (): THREE.Mesh => laid[laid.push(lyingDagger() as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>) - 1]!;
      const scene = dropsAround(new WorldScene({ ...emptyAssets(), ground }, TEST_REGISTRY, 1, reducedMotion, () => wallMs));
      const tick = (seconds: number): void => {
        for (let elapsed = 0; elapsed < seconds - 1e-9; elapsed += 0.05) {
          wallMs += 50;
          scene.tick(0.05);
        }
      };
      return { scene, laid, tick, hide: (ms) => (wallMs += ms) };
    }

    /** Whether `object` is drawn among the drops. */
    function drawn(scene: WorldScene, object: THREE.Object3D): boolean {
      let found = false;
      scene.scene.getObjectByName(LOOT_MARKERS_NAME)!.traverseVisible((each) => {
        if (each === object) found = true;
      });
      return found;
    }

    /** The marker a drop's model lies in: the model's holder's toss's parent. */
    const markerOf = (model: THREE.Object3D): THREE.Object3D => model.parent!.parent!.parent!;

    /** Every mesh drawn in a marker, by name, with its material's opacity. */
    function opacities(marker: THREE.Object3D): [string, number][] {
      const meshes: [string, number][] = [];
      marker.traverseVisible((object) => {
        const mesh = object as THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
        if (mesh.isMesh) meshes.push([mesh.name, mesh.material.opacity]);
      });
      return meshes;
    }

    it('fades out where it lay once gone, taking no press meanwhile, and is gone once clear', () => {
      const { scene, laid, tick } = fading();
      const model = laid[1]!;
      const { material } = model;
      const pressed = [scene._viewportPointOfLoot('open', 'model')!, scene._viewportPointOfLoot('open', 'label')!];
      scene.removeLoot('open', false);
      expect(scene._viewportPointOfLoot('open', 'model')).toBeUndefined();
      for (const point of pressed) expect(scene.pressTargetAt(point.x, point.y)).toMatchObject({ kind: 'ground' });
      const clone = model.material;
      expect(clone).not.toBe(material);

      tick(LOOT_FADE_SECONDS - 0.05);
      expect(drawn(scene, model)).toBe(true);
      expect(shown(scene, LOOT_BEAM_NAME)).toHaveLength(2);
      expect(clone.opacity).toBeGreaterThan(0);
      expect(clone.opacity).toBeLessThan(1);
      expect(material.opacity).toBe(1);
      for (const point of pressed) expect(scene.pressTargetAt(point.x, point.y)).toMatchObject({ kind: 'ground' });

      tick(0.1);
      expect(drawn(scene, model)).toBe(false);
      expect(shown(scene, LOOT_BEAM_NAME)).toHaveLength(1);
      expect(model.material).toBe(material);
    });

    it('is gone at once, with nothing fading, once a dreamer picks it up', () => {
      const { scene, laid } = fading();
      const model = laid[1]!;
      const { material } = model;
      scene.removeLoot('open', true);
      expect(scene._viewportPointOfLoot('open', 'model')).toBeUndefined();
      expect(drawn(scene, model)).toBe(false);
      expect(shown(scene, LOOT_BEAM_NAME)).toHaveLength(1);
      expect(model.material).toBe(material);
    });

    it('draws a drop shown again under the same id while it fades whole, beside the fading one', () => {
      const { scene, laid, tick } = fading();
      const faded = markerOf(laid[0]!);
      scene.removeLoot('under', false);
      tick(0.25);
      scene.showLoot(drop('under', 13, 10));
      const again = markerOf(laid.at(-1)!);
      expect(again).not.toBe(faded);
      expect(opacities(again)).toEqual(opacities(markerOf(laid[1]!)));

      tick(LOOT_FADE_SECONDS);
      expect(opacities(again)).toEqual(opacities(markerOf(laid[1]!)));
      expect(scene._viewportPointOfLoot('under', 'label')).toBeDefined();
    });

    it('is gone on the tick a stall ends', () => {
      const { scene, laid, tick, hide } = fading();
      const { material } = laid[1]!;
      scene.removeLoot('open', false);
      tick(0.2);
      const cloneDispose = vi.spyOn(laid[1]!.material, 'dispose');
      hide(2000);
      scene.tick(0.01);
      expect(drawn(scene, laid[1]!)).toBe(false);
      expect(cloneDispose).toHaveBeenCalled();
      expect(laid[1]!.material).toBe(material);
    });

    it('puts back what a fading drop drew with and disposes its clones as a new space starts, so the next drop in its marker draws whole', () => {
      const { scene, laid, tick } = fading();
      const marker = markerOf(laid[0]!);
      const parts = [laid[0]!, marker.getObjectByName(LOOT_BEAM_NAME)!, marker.getObjectByName(LOOT_GLOW_NAME)!] as THREE.Mesh<
        THREE.BufferGeometry,
        THREE.Material
      >[];
      marker.traverse((object) => {
        const mesh = object as THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
        if (mesh.isMesh && mesh.material.depthTest === false) parts.push(mesh);
      });
      expect(parts).toHaveLength(4);
      const materials = parts.map((part) => part.material);
      scene.removeLoot('under', false);
      tick(0.25);
      const disposes = parts.map((part) => vi.spyOn(part.material, 'dispose'));

      const restored = (): boolean => parts.every((part, index) => part.material === materials[index]);

      scene.enterSpace(world('EdariaInn'));
      expect(restored()).toBe(true);
      for (const dispose of disposes) expect(dispose).toHaveBeenCalled();

      scene.placeEntity(player());
      scene.showLoot(drop('next', 10, 12));
      expect(markerOf(laid.at(-1)!)).toBe(marker);
      expect(drawn(scene, parts[1]!)).toBe(true);
      expect(restored()).toBe(true);
    });

    it('waits for a free marker beyond the pool, the newer of two drops as far from the player, and takes the first one freed, once its drop has faded or at once under reduced motion', () => {
      for (const reducedMotion of [false, true]) {
        const scene = new WorldScene(emptyAssets(), TEST_REGISTRY, 1, reducedMotion, () => 0);
        scene.enterSpace(world());
        scene.placeEntity(player());
        for (let index = 0; index <= LOOT_MARKER_POOL_SIZE; index += 1) scene.showLoot(drop(`loot-${index}`, 2 + index, 4));
        const waiting = `loot-${LOOT_MARKER_POOL_SIZE}`;
        expect(scene._viewportPointOfLoot(waiting, 'label')).toBeUndefined();
        scene.removeLoot('loot-3', false);
        expect(scene._viewportPointOfLoot('loot-3', 'label')).toBeUndefined();
        if (!reducedMotion) {
          expect(scene._viewportPointOfLoot(waiting, 'label')).toBeUndefined();
          for (let elapsed = 0; elapsed < LOOT_FADE_SECONDS - 0.1; elapsed += 0.05) scene.tick(0.05);
          expect(scene._viewportPointOfLoot(waiting, 'label')).toBeUndefined();
          scene.tick(0.1);
        }
        expect(scene._viewportPointOfLoot(waiting, 'label'), `reduced motion ${reducedMotion}`).toBeDefined();
      }
    });

    it('draws the drops nearest the player while more lie than the pool holds, and chooses them again as the player walks', () => {
      const scene = makeScene({ ...emptyAssets(), ground: lyingDagger });
      scene.enterSpace(world());
      scene.placeEntity(player());
      // The pool's worth of older drops lie along the north edge, the first furthest from the player at (10, 10).
      for (let index = 0; index < LOOT_MARKER_POOL_SIZE; index += 1) scene.showLoot(drop(`far-${index}`, 1 + index, 1));
      scene.showLoot(drop('near', 11, 10));
      const drawn = (): string[] =>
        ['near', ...Array.from({ length: LOOT_MARKER_POOL_SIZE }, (_, index) => `far-${index}`)].filter(
          (lootId) => scene._viewportPointOfLoot(lootId, 'label') !== undefined,
        );

      expect(drawn()).toHaveLength(LOOT_MARKER_POOL_SIZE);
      expect(drawn()).not.toContain('far-0');
      for (const part of ['label', 'model'] as const) {
        const near = scene._viewportPointOfLoot('near', part)!;
        expect(scene.pressTargetAt(near.x, near.y), part).toEqual({ kind: 'loot', lootId: 'near' });
      }

      // Walking toward the first of them hands it the marker of the one now furthest.
      scene.updatePosition('self', { x: 2, z: 3 }, 0, 270);
      scene.tick(1 / 60);
      expect(drawn()).toHaveLength(LOOT_MARKER_POOL_SIZE);
      expect(drawn()).toContain('far-0');
      expect(drawn()).not.toContain('far-15');
      const first = scene._viewportPointOfLoot('far-0', 'label')!;
      expect(scene.pressTargetAt(first.x, first.y)).toEqual({ kind: 'loot', lootId: 'far-0' });
    });

    it('chooses the drops it draws again once a waiting one lies a quarter metre nearer than a drawn one, and trades no marker over less', () => {
      const scene = makeScene({ ...emptyAssets(), ground: lyingDagger });
      scene.enterSpace(world());
      scene.placeEntity(player());
      for (let index = 0; index < LOOT_MARKER_POOL_SIZE - 1; index += 1)
        scene.showLoot(drop(`near-${index}`, 9 + (index % 5) * 0.5, 11 + Math.floor(index / 5) * 0.5));
      // As far from the player at (10, 10) as each other: the older takes the last marker.
      scene.showLoot(drop('west', 5, 10));
      scene.showLoot(drop('east', 15, 10));
      const drawn = (): [boolean, boolean] => [
        scene._viewportPointOfLoot('west', 'label') !== undefined,
        scene._viewportPointOfLoot('east', 'label') !== undefined,
      ];
      expect(drawn()).toEqual([true, false]);

      // Shifting either way by a tenth of a metre, the east drop is at most 0.2 m nearer, inside the margin, and the marker stays.
      for (const x of [10.1, 9.9, 10.1, 10, 10.1]) {
        scene.updatePosition('self', { x, z: 10 }, 0, 90);
        scene.tick(1 / 60);
        expect(drawn(), `at ${x}`).toEqual([true, false]);
      }

      // At (10.2, 10) it is 0.4 m nearer, and takes the marker.
      scene.updatePosition('self', { x: 10.2, z: 10 }, 0, 90);
      scene.tick(1 / 60);
      expect(drawn()).toEqual([false, true]);
      // Back a tenth, the west drop is no nearer, and nothing trades back.
      for (const x of [10.1, 10.2, 10.1]) {
        scene.updatePosition('self', { x, z: 10 }, 0, 270);
        scene.tick(1 / 60);
        expect(drawn(), `at ${x}`).toEqual([false, true]);
      }
    });

    it('draws a drop that comes to the feet of a player among a cluster of drops once it lies a margin nearer than a drawn one', () => {
      const scene = makeScene({ ...emptyAssets(), ground: lyingDagger });
      scene.enterSpace(world());
      scene.placeEntity(player());
      // Thrown drops lie about a metre round the player at (10, 10): one more than the pool holds, the newest waiting.
      const ring = Array.from({ length: LOOT_MARKER_POOL_SIZE + 1 }, (_, index) => {
        const angle = (index / (LOOT_MARKER_POOL_SIZE + 1)) * Math.PI * 2;
        return drop(`ring-${index}`, 10 + Math.cos(angle) * (1 + index * 0.01), 10 + Math.sin(angle) * (1 + index * 0.01));
      });
      for (const loot of ring) scene.showLoot(loot);
      const waiting = ring.at(-1)!;
      expect(scene._viewportPointOfLoot(waiting.lootId, 'label')).toBeUndefined();

      // Six tenths of a metre toward it, it lies 0.56 m away and every drawn drop beyond it lies further.
      const toward = Math.atan2(waiting.z - 10, waiting.x - 10);
      scene.updatePosition('self', { x: 10 + Math.cos(toward) * 0.6, z: 10 + Math.sin(toward) * 0.6 }, 0, 0);
      scene.tick(1 / 60);
      const label = scene._viewportPointOfLoot(waiting.lootId, 'label')!;
      expect(scene.pressTargetAt(label.x, label.y)).toEqual({ kind: 'loot', lootId: waiting.lootId });
    });

    it('hands the marker a far drop in the air held to a nearer drop waiting once it lands, the player standing still', () => {
      for (const stall of [false, true]) {
        let now = 0;
        const scene = makeScene({ ...emptyAssets(), ground: lyingDagger }, () => now);
        scene.enterSpace(world());
        scene.placeEntity(player());
        for (let index = 0; index < LOOT_MARKER_POOL_SIZE - 1; index += 1)
          scene.showLoot(drop(`near-${index}`, 9 + (index % 5) * 0.5, 11 + Math.floor(index / 5) * 0.5));
        scene.showLoot({ ...drop('thrown', 2, 2), from: { x: 2.5, z: 2 } });
        scene.showLoot(drop('waiting', 10, 14));
        expect(scene._viewportPointOfLoot('thrown', 'label')).toBeDefined();
        expect(scene._viewportPointOfLoot('waiting', 'label')).toBeUndefined();

        if (stall) {
          // A hidden tab draws no frame for two seconds; the drop lies where it fell on the first frame back.
          now = 2000;
          scene.tick(2);
        } else {
          for (let frame = 0; frame < 60; frame += 1) {
            now += 1000 / 60;
            scene.tick(1 / 60);
          }
        }
        expect(scene._viewportPointOfLoot('thrown', 'label'), `stalled ${stall}`).toBeUndefined();
        expect(scene._viewportPointOfLoot('waiting', 'label'), `stalled ${stall}`).toBeDefined();
      }
    });

    it('keeps the marker of a drop in the air until it lands, whatever comes nearer meanwhile', () => {
      const scene = makeScene({ ...emptyAssets(), ground: lyingDagger });
      scene.enterSpace(world());
      scene.placeEntity(player());
      scene.showLoot({ ...drop('thrown', 4, 4), from: { x: 4.5, z: 4 } });
      for (let index = 0; index < LOOT_MARKER_POOL_SIZE; index += 1)
        scene.showLoot(drop(`near-${index}`, 10 + (index % 4) * 0.5, 11 + Math.floor(index / 4) * 0.5));
      expect(scene._viewportPointOfLoot('thrown', 'label')).toBeDefined();
      expect(scene._viewportPointOfLoot('near-15', 'label')).toBeUndefined();

      for (let frame = 0; frame < 60; frame += 1) scene.tick(1 / 60);
      scene.updatePosition('self', { x: 10, z: 11 }, 0, 0);
      scene.tick(1 / 60);
      expect(scene._viewportPointOfLoot('thrown', 'label')).toBeUndefined();
      expect(scene._viewportPointOfLoot('near-15', 'label')).toBeDefined();
    });
  });

  it('rings the target, and frees the ring when another is chosen, none is, or the entity leaves', () => {
    const scene = makeScene();
    scene.placeEntity(player());
    scene.placeEntity(player({ id: 'bren', kind: 'peer', position: { x: 12, z: 10 } }));
    scene.placeEntity(player({ id: 'cara', kind: 'peer', position: { x: 8, z: 10 } }));

    scene.showSelection('bren', PLAIN_MARK);
    expect(rings(scene).map((ring) => ring.parent?.position.x)).toEqual([12]);

    scene.showSelection('cara', PLAIN_MARK);
    expect(rings(scene).map((ring) => ring.parent?.position.x)).toEqual([8]);
    scene.showSelection(undefined, PLAIN_MARK);
    expect(rings(scene)).toEqual([]);

    scene.showSelection('nobody', PLAIN_MARK);
    expect(rings(scene)).toEqual([]);
    scene.showSelection('bren', PLAIN_MARK);
    scene.removeEntity('bren');
    expect(rings(scene)).toEqual([]);
  });

  it('draws the target in green, in gold while slot 1 acts on it, and as a reticle with four ticks pointing in while the gaze is locked, swapping at once each way', () => {
    const scene = makeScene();
    scene.placeEntity(player());
    scene.placeEntity(player({ id: 'bren', kind: 'peer', position: { x: 12, z: 10 } }));
    const colorOf = (mesh: THREE.Mesh): number => (mesh.material as THREE.MeshBasicMaterial).color.getHex();

    scene.showSelection('bren', PLAIN_MARK);
    const [plain] = rings(scene);
    expect(plain!.children).toEqual([]);
    scene.showSelection('bren', { ...PLAIN_MARK });
    expect(rings(scene)).toEqual([plain]);

    const disposePlain = vi.spyOn(plain!.geometry, 'dispose');
    scene.showSelection('bren', { locked: true, acting: false });
    const [reticle] = rings(scene);
    expect(disposePlain).toHaveBeenCalled();
    expect(reticle).not.toBe(plain);
    expect(reticle!.parent?.position.x).toBe(12);
    expect(colorOf(reticle!)).toBe(colorOf(plain!));
    const [ticks] = reticle!.children as THREE.Mesh[];
    expect(reticle!.children).toHaveLength(1);
    expect(ticks!.material).toBe(reticle!.material);
    expect(ticks!.geometry.getAttribute('position').count).toBe(12);
    const ring = reticle!.geometry as THREE.RingGeometry;
    const outer = ring.parameters.outerRadius;
    const inner = ring.parameters.innerRadius;
    const position = ticks!.geometry.getAttribute('position');
    for (let tick = 0; tick < 4; tick += 1) {
      const radius = (vertex: number): number => Math.hypot(position.getX(tick * 3 + vertex), position.getY(tick * 3 + vertex));
      // The tip lies on the ring's band and the base outside it, so each tick points in.
      expect(radius(0)).toBeGreaterThan(inner);
      expect(radius(0)).toBeLessThan(outer);
      expect(Math.min(radius(1), radius(2))).toBeGreaterThan(outer);
    }

    scene.showSelection('bren', { locked: true, acting: true });
    const [acting] = rings(scene);
    expect(acting!.children).toHaveLength(1);
    expect(colorOf(acting!)).not.toBe(colorOf(plain!));

    const disposeTicks = vi.spyOn((acting!.children[0] as THREE.Mesh).geometry, 'dispose');
    const disposeMaterial = vi.spyOn(acting!.material as THREE.Material, 'dispose');
    scene.showSelection('bren', { locked: false, acting: true });
    expect(rings(scene)).toHaveLength(1);
    expect(rings(scene)[0]!.children).toEqual([]);
    expect(colorOf(rings(scene)[0]!)).toBe(colorOf(acting!));
    expect(disposeTicks).toHaveBeenCalled();
    expect(disposeMaterial).toHaveBeenCalledTimes(1);
  });
});

describe('the queue behind the target', () => {
  /** A dot of the trail is a flat octagon 0.05 m in radius, drawn as six triangles. */
  const DOT_VERTICES = 18;
  const DOT_RADIUS = 0.05;
  const LIFT = 0.03;

  const colorOf = (mesh: THREE.Mesh): number => (mesh.material as THREE.MeshBasicMaterial).color.getHex();

  /** A scene over `daisSector` with the player at (10, 10) and a Ghost at each of `ghosts`, by id. */
  function queueing(ghosts: Record<string, Point>): WorldScene {
    const scene = sceneWithGround();
    scene.placeEntity(player());
    for (const [id, position] of Object.entries(ghosts)) scene.placeEntity(player({ id, kind: 'monster', name: 'Ghost', position }));
    return scene;
  }

  /** The trail from the target through the queue: a mesh hung straight on the scene whose dots are written in place. */
  function trails(scene: WorldScene): THREE.Mesh[] {
    return scene.scene.children.filter(
      (child): child is THREE.Mesh =>
        (child as THREE.Mesh).isMesh && ((child as THREE.Mesh).geometry.getAttribute('position') as THREE.BufferAttribute).usage === THREE.DynamicDrawUsage,
    );
  }

  /** How far a ring reaches from its middle: its outer edge, or for a reticle the tips of its ticks. */
  function reachOf(ring: THREE.Mesh): number {
    const tick = ring.children[0] as THREE.Mesh | undefined;
    if (tick === undefined) return (ring.geometry as THREE.RingGeometry).parameters.outerRadius;
    const corners = tick.geometry.getAttribute('position');
    let reach = 0;
    for (let vertex = 0; vertex < corners.count; vertex += 1) reach = Math.max(reach, Math.hypot(corners.getX(vertex), corners.getY(vertex)));
    return reach;
  }

  /**
   * Whether the trail's bounding sphere, which three culls it by, holds every corner the trail draws,
   * and stands at the middle of its dots, which three sorts it by.
   */
  function expectBoundedByDots(trail: THREE.Mesh): void {
    const sphere = trail.geometry.boundingSphere!;
    const centre = new THREE.Box3().setFromPoints(dots(trail)).getCenter(new THREE.Vector3());
    expect(sphere.center.distanceTo(centre)).toBeCloseTo(0, 5);
    const position = trail.geometry.getAttribute('position');
    const { start, count } = trail.geometry.drawRange;
    for (let vertex = start; vertex < start + count; vertex += 1) {
      expect(new THREE.Vector3().fromBufferAttribute(position, vertex).distanceTo(sphere.center)).toBeLessThanOrEqual(sphere.radius + 1e-5);
    }
  }

  /** The middle of each dot the trail draws, its octagon's corners lying round it at its height. */
  function dots(trail: THREE.Mesh): THREE.Vector3[] {
    const position = trail.geometry.getAttribute('position');
    const { start, count } = trail.geometry.drawRange;
    const found: THREE.Vector3[] = [];
    for (let first = start; first < start + count; first += DOT_VERTICES) {
      const box = new THREE.Box3();
      for (let vertex = first; vertex < first + DOT_VERTICES; vertex += 1) box.expandByPoint(new THREE.Vector3().fromBufferAttribute(position, vertex));
      found.push(box.getCenter(new THREE.Vector3()));
    }
    return found;
  }

  it("rings each queued nightmare faintly in the target ring's colour, keeping the ring of one still queued", () => {
    const scene = queueing({ 'monster:1': { x: 12, z: 10 }, 'monster:2': { x: 12, z: 13 }, 'monster:3': { x: 8, z: 13 } });
    const drawn = (): { at: number[]; opacity: number; color: number }[] =>
      rings(scene).map((ring) => ({
        at: [ring.parent!.position.x, ring.parent!.position.z],
        opacity: (ring.material as THREE.MeshBasicMaterial).opacity,
        color: colorOf(ring),
      }));
    scene.showSelection('monster:1', PLAIN_MARK);
    const green = colorOf(rings(scene)[0]!);

    scene.showQueue(['monster:2', 'monster:3']);
    expect(drawn()).toEqual([
      { at: [12, 10], opacity: 0.9, color: green },
      { at: [12, 13], opacity: expect.closeTo(0.36, 9), color: green },
      { at: [8, 13], opacity: expect.closeTo(0.36, 9), color: green },
    ]);

    const [, dropped, kept] = rings(scene);
    const disposeDropped = vi.spyOn(dropped!.geometry, 'dispose');
    scene.showQueue(['monster:3']);
    expect(rings(scene).slice(1)).toEqual([kept]);
    expect(disposeDropped).toHaveBeenCalled();

    scene.tick(0.016);
    const [trail] = trails(scene);
    expect(colorOf(trail!)).toBe(green);
    scene.showSelection('monster:1', { locked: false, acting: true });
    const gold = colorOf(rings(scene)[0]!);
    expect(gold).not.toBe(green);
    expect(colorOf(kept!)).toBe(gold);
    expect(colorOf(trail!)).toBe(gold);
    scene.showSelection('monster:1', PLAIN_MARK);
    expect(colorOf(kept!)).toBe(green);
    expect(colorOf(trail!)).toBe(green);
  });

  /**
   * The leg runs 5.8 m along z = 5 across the dais at x 4..6, from a locked target, whose reticle's
   * ticks reach 0.7 m out, to a queued nightmare, whose faint ring ends 0.5 m out.
   */
  it("lays the trail as one mesh drawing and bounded by only its dots, each on the ground under it and clear of the reticle's ticks", () => {
    const scene = queueing({ 'monster:1': { x: 2, z: 5 }, 'monster:2': { x: 7.8, z: 5 } });
    scene.showSelection('monster:1', { locked: true, acting: false });
    scene.showQueue(['monster:2']);
    expect(trails(scene)).toEqual([]);

    scene.tick(0.016);

    expect(trails(scene)).toHaveLength(1);
    const [trail] = trails(scene);
    expect(trail!.geometry.drawRange.start).toBe(0);
    expect(trail!.geometry.drawRange.count).toBe(15 * DOT_VERTICES);
    const laid = dots(trail!);
    for (const [index, dot] of laid.entries()) {
      expect(dot.z).toBeCloseTo(5, 5);
      expect(dot.y).toBeCloseTo((dot.x > 4 && dot.x < 6 ? 0.2 : 0) + LIFT, 5);
      if (index > 0) expect(dot.x - laid[index - 1]!.x).toBeCloseTo(0.3, 5);
    }
    expect(laid.filter((dot) => dot.y > 0.1)).toHaveLength(7);
    expect(laid[0]!.x - 2 - DOT_RADIUS).toBeGreaterThan(reachOf(rings(scene)[0]!));
    expectBoundedByDots(trail!);

    scene.updatePosition('monster:2', { x: 11, z: 8 }, 0, 0);
    scene.tick(0.016);

    expectBoundedByDots(trail!);
  });

  it("moves the trail's first dot clear of the reticle's ticks as the target's lock comes, and back as it goes, with no body moving", () => {
    const scene = queueing({ 'monster:1': { x: 2, z: 5 }, 'monster:2': { x: 7.8, z: 5 } });
    scene.showSelection('monster:1', PLAIN_MARK);
    scene.showQueue(['monster:2']);
    scene.tick(0.016);
    const firstEdge = (): number => dots(trails(scene)[0]!)[0]!.x - 2 - DOT_RADIUS;
    const plain = firstEdge();

    scene.showSelection('monster:1', { locked: true, acting: false });
    scene.tick(0.016);

    const reach = reachOf(rings(scene)[0]!);
    expect(plain).toBeLessThan(reach);
    expect(firstEdge()).toBeGreaterThan(reach);

    scene.showSelection('monster:1', PLAIN_MARK);
    scene.tick(0.016);

    expect(firstEdge()).toBeCloseTo(plain, 9);
  });

  /** The leg from the target at x 1 to the nightmare queued first, at x 9, runs through the one queued after it, at x 5. */
  it('keeps the trail clear of a queued ring standing on a leg between two other marks', () => {
    const scene = queueing({ 'monster:1': { x: 1, z: 15 }, 'monster:2': { x: 9, z: 15 }, 'monster:3': { x: 5, z: 15 } });
    scene.showSelection('monster:1', PLAIN_MARK);
    scene.showQueue(['monster:2', 'monster:3']);
    scene.tick(0.016);

    const middle = rings(scene).find((ring) => ring.parent!.position.x === 5)!;
    const laid = dots(trails(scene)[0]!);
    expect(laid.length).toBeGreaterThan(0);
    for (const dot of laid) expect(Math.hypot(dot.x - 5, dot.z - 15) - DOT_RADIUS).toBeGreaterThan(reachOf(middle));
  });

  /**
   * The 1.44 m from a locked target to the nightmare queued behind it are their two clearances, 0.82 m and 0.62 m, end to end.
   * From x 10 to x 11.44 the leg rounds to a hair under them, about 4.4e-16 m.
   */
  it.each([
    [1, 2.44],
    [10, 11.44],
  ])('lays the one dot that fits on the edge of both ends of a leg from x %d to x %d', (from, to) => {
    const scene = queueing({ 'monster:1': { x: from, z: 15 }, 'monster:2': { x: to, z: 15 } });
    scene.showSelection('monster:1', { locked: true, acting: false });
    scene.showQueue(['monster:2']);

    scene.tick(0.016);

    expect(trails(scene)).toHaveLength(1);
    expect(dots(trails(scene)[0]!)).toHaveLength(1);
  });

  /** 25 m between the target and the nightmare queued behind it take more dots than the 64 the trail's buffer first holds. */
  it("grows the trail's buffer to hold every dot of a long leg", () => {
    const scene = queueing({ 'monster:1': { x: 0, z: 15 }, 'monster:2': { x: 25, z: 15 } });
    scene.showSelection('monster:1', PLAIN_MARK);
    scene.showQueue(['monster:2']);
    scene.tick(0.016);

    const [trail] = trails(scene);
    const laid = dots(trail!);
    expect(laid.length).toBeGreaterThan(64);
    expect(trail!.geometry.drawRange.count).toBe(laid.length * DOT_VERTICES);
    const last = laid.at(-1)!;
    expect(last.z).toBeCloseTo(15, 5);
    expect(25 - last.x - DOT_RADIUS).toBeGreaterThan(reachOf(rings(scene)[1]!));
    expect(25 - last.x).toBeLessThan(reachOf(rings(scene)[1]!) + 0.5);
  });

  /** From an unlocked target at x 1.2, a dot of the leg lies at x 3.98 until the queued end moves 0.08 m on, shifting it to 4.02. */
  it('lifts a dot onto the dais on the frame a moved end of its leg carries it across the edge', () => {
    const scene = queueing({ 'monster:1': { x: 1.2, z: 5 }, 'monster:2': { x: 8.26, z: 5 } });
    scene.showSelection('monster:1', PLAIN_MARK);
    scene.showQueue(['monster:2']);
    scene.tick(0.016);
    const nearEdge = (from: number, to: number): THREE.Vector3[] => dots(trails(scene)[0]!).filter((dot) => dot.x > from && dot.x < to);
    expect(nearEdge(3.9, 4).map((dot) => [dot.x, dot.y])).toEqual([[expect.closeTo(3.98, 5), expect.closeTo(LIFT, 5)]]);
    expect(nearEdge(4, 4.1)).toEqual([]);

    scene.updatePosition('monster:2', { x: 8.34, z: 5 }, 0, 0);
    scene.tick(0.016);

    expect(nearEdge(4, 4.1).map((dot) => [dot.x, dot.y])).toEqual([[expect.closeTo(4.02, 5), expect.closeTo(0.2 + LIFT, 5)]]);
  });

  it('lets a queued ring go with its nightmare, and every ring and the trail with the space', () => {
    const scene = queueing({ 'monster:1': { x: 12, z: 10 }, 'monster:2': { x: 12, z: 13 }, 'monster:3': { x: 8, z: 13 } });
    scene.showSelection('monster:1', PLAIN_MARK);
    scene.showQueue(['monster:2', 'monster:3']);
    scene.tick(0.016);
    const [, gone, kept] = rings(scene);
    const disposeGone = vi.spyOn(gone!.geometry, 'dispose');

    scene.removeEntity('monster:2');
    scene.tick(0.016);

    expect(rings(scene).slice(1)).toEqual([kept]);
    expect(disposeGone).toHaveBeenCalled();
    // The trail now runs straight from the target to the one left queued.
    const straight = dots(trails(scene)[0]!);
    expect(straight.length).toBeGreaterThan(0);
    for (const dot of straight) expect(Math.abs(3 * (dot.x - 12) + 4 * (dot.z - 10))).toBeLessThan(1e-4);

    const disposeKept = vi.spyOn(kept!.geometry, 'dispose');
    scene.enterSpace(world());
    expect(trails(scene)).toEqual([]);
    scene.placeEntity(player());
    expect(disposeKept).toHaveBeenCalled();
    expect(rings(scene)).toEqual([]);

    scene.placeEntity(player({ id: 'monster:3', kind: 'monster', name: 'Ghost', position: { x: 8, z: 13 } }));
    scene.showQueue(['monster:3']);
    const [again] = rings(scene);
    expect(rings(scene)).toHaveLength(1);
    expect(again).not.toBe(kept);
    scene.tick(0.016);
    expect(trails(scene)).toEqual([]);
  });
});

describe('the ring a press on the ground drops', () => {
  const ON_DAIS = { x: 5, z: 5 };
  const ON_FLOOR = { x: 12, z: 12 };
  const LIFT = 0.03;

  /** A scene over `daisSector` on a clock the test moves, and its press rings. */
  function pressing(reducedMotion = false): { scene: WorldScene; clock: { ms: number }; markers: () => THREE.Mesh[] } {
    const clock = { ms: 0 };
    const scene = new WorldScene(emptyAssets(), TEST_REGISTRY, 1, reducedMotion, () => clock.ms);
    const entered = world();
    scene.enterSpace(entered);
    entered.addSector(daisSector);
    scene.addSector(daisSector);
    return { scene, clock, markers: () => rings(scene) };
  }

  function at(scene: WorldScene, clock: { ms: number }, ms: number): void {
    clock.ms = ms;
    scene.tick(0.016);
  }

  const opacityOf = (mesh: THREE.Mesh): number => (mesh.material as THREE.MeshBasicMaterial).opacity;

  it('drops onto the ground a press holds, on the top of a walk surface, follows it, and lifts away', () => {
    const { scene, clock, markers } = pressing();

    scene.showPressMarker(ON_DAIS);
    const [ring] = markers();
    expect(markers()).toHaveLength(1);
    expect(ring!.parent).toBe(scene.scene);
    expect(ring!.material).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect(ring!.position.y).toBeGreaterThan(0.2 + LIFT + 0.4);
    expect(opacityOf(ring!)).toBe(0);

    at(scene, clock, 50);
    const falling = ring!.position.y;
    expect(falling).toBeGreaterThan(0.2 + LIFT);
    expect(falling).toBeLessThan(0.2 + LIFT + 0.4);
    expect(opacityOf(ring!)).toBeGreaterThan(0);
    at(scene, clock, 150);
    expect(ring!.position.toArray()).toEqual([5, 0.2 + LIFT, 5]);
    expect(opacityOf(ring!)).toBe(0.9);

    scene.showPressMarker(ON_FLOOR);
    at(scene, clock, 200);
    expect(markers()).toEqual([ring]);
    expect(ring!.position.toArray()).toEqual([12, LIFT, 12]);

    scene.liftPressMarker();
    at(scene, clock, 275);
    expect(ring!.position.x).toBe(12);
    expect(ring!.position.y).toBeGreaterThan(LIFT);
    expect(opacityOf(ring!)).toBeGreaterThan(0);
    expect(opacityOf(ring!)).toBeLessThan(0.9);

    const dispose = vi.spyOn(ring!.geometry, 'dispose');
    at(scene, clock, 350);
    expect(markers()).toEqual([]);
    expect(dispose).toHaveBeenCalled();
  });

  it('lands before it lifts when the press comes up at once, and lifts where it lies when let go of', () => {
    const { scene, clock, markers } = pressing();
    scene.showPressMarker(ON_FLOOR);

    scene.liftPressMarker();
    at(scene, clock, 100);
    const [ring] = markers();
    const landing = ring!.position.y;
    at(scene, clock, 150);
    expect(ring!.position.y).toBeLessThan(landing);
    expect(ring!.position.toArray()).toEqual([12, LIFT, 12]);
    at(scene, clock, 225);
    expect(ring!.position.y).toBeGreaterThan(LIFT);
    at(scene, clock, 300);
    expect(markers()).toEqual([]);
  });

  it('drops a new ring for the next press while the last still lifts', () => {
    const { scene, clock, markers } = pressing();
    scene.showPressMarker(ON_FLOOR);
    at(scene, clock, 150);
    scene.liftPressMarker();

    at(scene, clock, 200);
    scene.showPressMarker(ON_DAIS);
    expect(markers().map((ring) => ring.position.x)).toEqual([12, 5]);
    at(scene, clock, 300);
    expect(markers().map((ring) => ring.position.x)).toEqual([5]);
  });

  it('only fades under reduced motion', () => {
    const { scene, clock, markers } = pressing(true);
    scene.showPressMarker(ON_FLOOR);
    const [ring] = markers();
    const heights: number[] = [ring!.position.y];

    for (const ms of [50, 150]) {
      at(scene, clock, ms);
      heights.push(ring!.position.y);
    }
    expect(opacityOf(ring!)).toBe(0.9);
    scene.liftPressMarker();
    at(scene, clock, 200);
    heights.push(ring!.position.y);
    expect(opacityOf(ring!)).toBeLessThan(0.9);

    expect(heights).toEqual([LIFT, LIFT, LIFT, LIFT]);
  });

  it('goes with the splash', () => {
    const { scene, markers } = pressing();
    scene.showPressMarker(ON_FLOOR);

    scene.showSplash();

    expect(markers()).toEqual([]);
  });
});

describe('shadow casting survives every path a model can reach the scene by', () => {
  /**
   * `enableShadows` is called on four paths. The heal is the one that matters most:
   * `refreshResolvedModels` exists precisely for the race where an entity or placement is drawn
   * before its glTF finishes prewarming, and a clone that misses the enrolment renders shadowless —
   * which reads as the prop floating above the floor.
   */
  it('enrols a character model resolved on the cold path', () => {
    // `resolvingAssets().character` answers a bare `Object3D` with no mesh under it, which nothing
    // can cast a shadow from — so this needs a rig that actually carries geometry.
    const scene = makeScene({ ...resolvingAssets(), character: () => new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)) });
    scene.placeEntity(player());

    expect(boxes(scene).some((mesh) => mesh.castShadow)).toBe(true);
  });

  it('enrols a placeholder standing in for an unresolved model', () => {
    const scene = makeScene();
    scene.placeEntity(player());

    expect(boxes(scene).map((mesh) => mesh.castShadow)).toEqual([true]);
  });

  it('enrols a placement model that resolves through the heal, not only on a cold load', async () => {
    const assets = emptyAssets();
    const scene = makeScene(assets);
    scene.addSector(sector({ placements: [placement('door-1', 'door')] }));
    expect(scene._placeholderObjectCount()).toBe(1);

    const warm = resolvingAssets();
    assets.object = (id) => warm.object(id);
    await scene.prewarm();

    // The healed clone replaces the placeholder, so the one box left is the resolved model.
    expect(boxes(scene).map((mesh) => mesh.castShadow)).toEqual([true]);
  });
});

describe('entity yaw slews on the model holder only', () => {
  /**
   * The overlays hang off the stable node, so the facing yaw must live on the model holder. A
   * yaw on the node would tilt the name plaque and the miss mark with the character.
   */
  it('leaves the entity node unrotated while the holder turns', () => {
    const scene = makeScene();
    scene.placeEntity(player());

    scene.updatePosition('self', { x: 10, z: 10 }, 90, undefined);
    for (let step = 0; step < 30; step += 1) scene.tick(1 / 60);

    expect(scene._yawFor('self')).toBe(Math.PI / 2);
    // The half that carries the contract: reading only the holder passes even if the node turns
    // too, because both would hold the same value and the overlays would tilt unnoticed.
    expect(scene._nodeYawFor('self')).toBe(0);
  });

  it('stands an entity at the yaw of its facing when it is placed', () => {
    const scene = makeScene();

    scene.placeEntity(player({ facing: 270 }));

    expect(scene._yawFor('self')).toBe(1.5 * Math.PI);
    expect(scene._nodeYawFor('self')).toBe(0);
  });

  it('holds an idle pose when nothing moved', () => {
    const scene = makeScene();
    scene.placeEntity(player());

    scene.tick(0.5);

    // No model resolved, so no mixer and no pose is selected — but the tick must not throw.
    expect(scene._poseFor('self')).toBeUndefined();
  });
});

describe('movement poses', () => {
  /** A model with one clip per pose, so the selected pose is observable through the mixer. */
  function animatedScene(): WorldScene {
    const clips = ['Idle', 'Walking_A', 'Running_A', 'Sneaking', 'Walking_Backwards'].map((name) => new THREE.AnimationClip(name, 1, []));
    return makeScene({ ...emptyAssets(), character: () => new THREE.Object3D(), clipsFor: () => clips });
  }

  it('walks while the position keeps changing and idles a grace window after it stops', () => {
    const scene = animatedScene();
    scene.placeEntity(player({ id: 'peer', kind: 'peer' }));
    scene.tick(0.016);
    expect(scene._poseFor('peer')).toBe('idle');

    scene.updatePosition('peer', { x: 10.1, z: 10 }, 90, 90);
    scene.tick(0.016);
    expect(scene._poseFor('peer')).toBe('walking');

    // The same position again is not movement.
    for (let frame = 0; frame < 12; frame += 1) {
      scene.updatePosition('peer', { x: 10.1, z: 10 }, 90, undefined);
      scene.tick(0.016);
    }
    expect(scene._poseFor('peer')).toBe('idle');
  });

  it('picks the clip from the gait and from the travel against the facing', () => {
    const scene = animatedScene();
    scene.placeEntity(player());

    scene.updateGait('self', 'run');
    scene.updatePosition('self', { x: 10.1, z: 10 }, 90, 90);
    scene.tick(0.016);
    expect(scene._poseFor('self')).toBe('running');

    // Facing east while travelling west is a backpedal, whatever the gait.
    scene.updatePosition('self', { x: 10, z: 10 }, 90, 270);
    scene.tick(0.016);
    expect(scene._poseFor('self')).toBe('backpedal');

    // Facing south while travelling east is a step to the character's own left.
    scene.updatePosition('self', { x: 10.1, z: 10 }, 0, 90);
    scene.tick(0.016);
    expect(scene._poseFor('self')).toBe('strafeLeft');
  });

  it('walks an NPC whatever its gait and its travel against its facing', () => {
    const scene = animatedScene();
    scene.placeEntity(player({ id: 'npc:EdariaSquare/libus', kind: 'npc', name: 'Libus' }));

    scene.updateGait('npc:EdariaSquare/libus', 'run');
    scene.updatePosition('npc:EdariaSquare/libus', { x: 9.9, z: 10 }, 90, 270);
    scene.tick(0.016);

    expect(scene._poseFor('npc:EdariaSquare/libus')).toBe('walking');
  });

  /** A stationary tick passes no travel; overwriting the last one would drop the backpedal clip mid-glide. */
  it('keeps the last travel direction when a step carries none', () => {
    const scene = animatedScene();
    scene.placeEntity(player());
    scene.updatePosition('self', { x: 9.9, z: 10 }, 90, 270);
    scene.tick(0.016);

    scene.updatePosition('self', { x: 9.8, z: 10 }, 90, undefined);
    scene.tick(0.016);

    expect(scene._poseFor('self')).toBe('backpedal');
  });
});

describe('blows, falls, and raises', () => {
  const CLIP_SECONDS = 1;
  const SLICE = 'Melee_1H_Attack_Slice_Horizontal';
  const BLADE_LANDS = CLIP_SECONDS * STRIKE_AT[SLICE]!;

  afterEach(() => vi.restoreAllMocks());

  /** A scene whose character model carries `names` as clips, and the action of every clip started on it, in order. */
  function fightingScene(
    names = ['Idle', SLICE, 'Hit_A', 'Death_A'],
    now?: () => number,
  ): { scene: WorldScene; actions: () => THREE.AnimationAction[]; started: () => string[]; last: () => THREE.AnimationAction } {
    const clips = names.map((name) => new THREE.AnimationClip(name, CLIP_SECONDS, []));
    const scene = makeScene({ ...emptyAssets(), character: () => new THREE.Object3D(), clipsFor: () => clips }, now);
    const play = vi.spyOn(THREE.AnimationAction.prototype, 'play');
    const actions = (): THREE.AnimationAction[] => play.mock.contexts as THREE.AnimationAction[];
    return { scene, actions, started: () => actions().map((action) => action.getClip().name), last: () => actions().at(-1)! };
  }

  /** Runs the scene for `seconds`, in steps under the tick's own clamp. */
  function run(scene: WorldScene, seconds: number): void {
    for (let elapsed = 0; elapsed < seconds; elapsed += MAX_TICK_DELTA) scene.tick(MAX_TICK_DELTA);
  }

  it('plays a swing once over the pose, then fades the pose back in', () => {
    const { scene, started, last } = fightingScene();
    scene.placeEntity(player());
    scene.tick(0.016);
    expect(started()).toEqual(['Idle']);

    const idle = last();
    scene.showBlow('self', 'monster:1', false);
    expect(started()).toEqual(['Idle', SLICE]);
    expect(last().loop).toBe(THREE.LoopOnce);
    // Half-way through the fade the pose has given half its weight to the swing.
    scene.tick(CLIP_TRANSITION_DURATION / 2);
    expect(idle.getEffectiveWeight()).toBeCloseTo(0.5, 6);
    expect(last().getEffectiveWeight()).toBeCloseTo(0.5, 6);

    run(scene, CLIP_SECONDS / 2);
    expect(started()).toEqual(['Idle', SLICE]);
    run(scene, CLIP_SECONDS);
    expect(started()).toEqual(['Idle', SLICE, 'Idle']);
  });

  it('makes the one hit flinch, and the one missed not, as the blade lands', () => {
    const { scene, started } = fightingScene();
    scene.placeEntity(player());
    scene.placeEntity(player({ id: 'monster:1', kind: 'monster', position: { x: 11, z: 10 } }));
    scene.tick(0.016);

    scene.showBlow('self', 'monster:1', true);
    expect(started().at(-1)).toBe(SLICE);
    run(scene, BLADE_LANDS);
    expect(started().slice(-2)).toEqual([SLICE, 'Hit_A']);

    scene.showBlow('self', 'monster:1', false);
    expect(started().at(-1)).toBe(SLICE);
    run(scene, BLADE_LANDS);
    expect(started().at(-1)).toBe(SLICE);
  });

  it('drops a fallen entity once and keeps it down, whatever strikes it, until it stands again', () => {
    const { scene, started, last } = fightingScene();
    scene.placeEntity(player({ id: 'peer', kind: 'peer' }));
    scene.tick(0.016);

    const idle = last();
    scene.updateCondition('peer', 'fallen');
    expect(started()).toEqual(['Idle', 'Death_A']);
    expect(last().clampWhenFinished).toBe(true);
    // It falls from the clip's start, fading over from the pose it stood in.
    expect(last().time).toBe(0);
    scene.tick(CLIP_TRANSITION_DURATION / 2);
    expect(idle.getEffectiveWeight()).toBeCloseTo(0.5, 6);
    run(scene, CLIP_SECONDS * 3);
    scene.showBlow('monster:1', 'peer', true);
    expect(started()).toEqual(['Idle', 'Death_A']);

    scene.updateCondition('peer', 'failing');
    scene.tick(0.016);
    expect(started()).toEqual(['Idle', 'Death_A', 'Idle']);
  });

  it("lays down an entity that comes into view already fallen, at its fall's last frame and without falling again", () => {
    const { scene, actions, started } = fightingScene();
    scene.placeEntity(player({ id: 'peer', kind: 'peer', condition: 'fallen' }));
    scene.tick(0.016);
    // Posed once to be measured standing, then down.
    expect(started()).toEqual(['Idle', 'Death_A']);
    const [idle, fall] = actions() as [THREE.AnimationAction, THREE.AnimationAction];
    expect(fall.time).toBe(CLIP_SECONDS);
    expect(fall.getEffectiveWeight()).toBe(1);
    expect(idle.isRunning()).toBe(false);
    run(scene, CLIP_SECONDS * 2);
    expect(started()).toEqual(['Idle', 'Death_A']);
  });

  it('drops a body whose model is swapped while its fall waits for the blow as the blow lands, and only once', () => {
    const { scene, started } = fightingScene();
    const monster = player({ id: 'monster:1', kind: 'monster', position: { x: 11, z: 10 } });
    scene.placeEntity(player());
    scene.placeEntity(monster);
    scene.tick(0.016);

    scene.showBlow('self', 'monster:1', true);
    scene.updateCondition('monster:1', 'fallen');
    scene.placeEntity({ ...monster, characterModelId: 'skeleton-minion', condition: 'fallen' });
    scene.tick(0.016);
    expect(started()).not.toContain('Death_A');

    run(scene, BLADE_LANDS);
    expect(started().filter((name) => name === 'Death_A')).toHaveLength(1);
  });

  it('keeps the pose of a model that carries none of the clips', () => {
    const { scene, started } = fightingScene(['Idle']);
    scene.placeEntity(player());
    scene.tick(0.016);

    scene.showBlow('self', 'monster:1', false);
    scene.updateCondition('self', 'fallen');
    run(scene, CLIP_SECONDS * 2);

    expect(started()).toEqual(['Idle']);
  });

  it("plays an ability's own clip once, and on a model without it keeps the pose rather than swinging", () => {
    const { scene, started, last } = fightingScene(['Idle', 'Melee_Block']);
    scene.placeEntity(player());
    scene.tick(0.016);

    scene.showAbility('self', 'brace', undefined);
    expect(started()).toEqual(['Idle', 'Melee_Block']);
    expect(last().loop).toBe(THREE.LoopOnce);
    run(scene, CLIP_SECONDS * 2);

    scene.showAbility('self', 'cleave', undefined);
    run(scene, CLIP_SECONDS);
    expect(started()).toEqual(['Idle', 'Melee_Block', 'Idle']);
  });

  it('holds the authored direction as the focus moves across the world', () => {
    const scene = makeScene();

    scene.placeEntity(player({ position: { x: 0, z: 0 } }));
    const nearOrigin = sunDirection(scene);

    scene.placeEntity(player({ position: { x: 80, z: -80 } }));
    const farAway = sunDirection(scene);

    expect(farAway.angleTo(nearOrigin)).toBeLessThan(1e-6);
  });

  /**
   * The anti-swim guard, and the axes it is measured on are the whole point.
   *
   * The shadow map's grid lives in the light's view plane, so quantizing world XYZ is not the same
   * thing: 0.5 world units is 21.33 texels at this scale, and projecting into the light plane scales
   * it again by the direction cosines, leaving a fractional-texel phase on every step. The map then
   * re-samples the same silhouette against a different phase each frame and the edge pixels flip —
   * only while the focus moves, since a still anchor holds one phase.
   *
   * Walked across many steps rather than sampled once: a single position lands on a texel boundary
   * for plenty of wrong bases by luck.
   */
  it('quantizes the shadow anchor to whole texels of the light plane as the focus moves', () => {
    const scene = makeScene();
    const texel = (2 * SUN_SHADOW.orthographicScale) / SUN_SHADOW.mapSize;

    const phases: number[] = [];
    for (let step = 0; step < 40; step += 1) {
      scene.placeEntity(player({ position: { x: 10 + step * 0.14, z: 10 + step * 0.06 } }));
      // Derived from the light's own placement, not from the scene's internals, so a wrong basis in
      // `repositionSun` cannot cancel itself out here.
      const direction = sunDirection(scene);
      const intoLight = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(direction, new THREE.Vector3(), sun(scene).up)).invert();
      const local = sun(scene).target.position.clone().applyQuaternion(intoLight);
      phases.push(local.x / texel, local.y / texel);
    }

    for (const multiple of phases) {
      expect(Math.abs(multiple - Math.round(multiple))).toBeLessThan(1e-4);
    }
  });

  /**
   * The quantization test above cannot see a *wrong* anchor, and neither can the direction test:
   * `sun.position - sun.target.position` cancels the anchor exactly, and an anchor parked at the
   * origin has zero texel phase on every sample. Both stay green with the anchor pinned to (0,0,0),
   * which is the shape that matters — the shadow volume stops following the player, so every prop
   * more than half a shadow map from the origin loses its shadow entirely.
   *
   * So this observes the endpoint itself: it must move with the focus, and land within one texel
   * of it rather than anywhere at all.
   */
  it('anchors the shadow volume on the focus, within a texel, as the focus moves', () => {
    const scene = makeScene();
    const texel = (2 * SUN_SHADOW.orthographicScale) / SUN_SHADOW.mapSize;

    scene.placeEntity(player({ position: { x: 6, z: 6 } }));
    const near = sun(scene).target.position.clone();

    scene.placeEntity(player({ position: { x: 60, z: 60 } }));
    const far = sun(scene).target.position.clone();

    // The anchor must travel the same distance the player did — quantized to whole texels, hence
    // the tolerance. An anchor pinned to the origin travels 0 and fails the first assertion; one
    // that tracks something other than the focus fails the second.
    expect(near.distanceTo(far)).toBeGreaterThan(1);
    expect(Math.abs(near.distanceTo(far) - Math.hypot(54, 54))).toBeLessThanOrEqual(2 * texel);
  });

  /** The editor frames the camera itself and places no player, so it names the point to anchor on. */
  it('anchors the shadow volume on a named ground point, within a texel, without moving the camera', () => {
    const scene = makeScene();
    const texel = (2 * SUN_SHADOW.orthographicScale) / SUN_SHADOW.mapSize;
    const camera = scene.camera.position.clone();

    scene.anchorSunShadow({ x: 6, z: 6 });
    const near = sun(scene).target.position.clone();
    scene.anchorSunShadow({ x: 60, z: -60 });
    const far = sun(scene).target.position.clone();

    expect(near.distanceTo(new THREE.Vector3(6, 0, 6))).toBeLessThanOrEqual(2 * texel);
    expect(far.distanceTo(new THREE.Vector3(60, 0, -60))).toBeLessThanOrEqual(2 * texel);
    expect(scene.camera.position).toEqual(camera);
    // A later frame relights from the same anchor rather than falling back to the origin.
    scene.tick(0.016);
    expect(sun(scene).target.position.distanceTo(far)).toBe(0);
  });

  it('casts shadows from the sun onto the floor', () => {
    const scene = makeScene();
    scene.addSector(sector({ placements: [placement('box-1', 'box')] }));
    expect(sun(scene).castShadow).toBe(true);

    // Per mesh, not `some(...)`: the prop both casts and receives, so a bare "something receives"
    // would hold even with the floor's flag removed — and the floor is the only surface a shadow
    // lands on.
    const floor = groundMeshes(scene)[0];
    expect(floor).toBeDefined();
    expect(floor!.receiveShadow).toBe(true);
    // A ground plane casting into its own depth comparison is the classic source of shadow acne,
    // and there is nothing below it to catch a shadow anyway.
    expect(floor!.castShadow).toBe(false);

    expect(boxes(scene).map((mesh) => mesh.castShadow)).toEqual([true]);
  });
});

describe('overlay artwork', () => {
  /** The body grows a line at a time and its two paddings are fixed, so the frame is `lines * 12 + 10` tall. */
  it.each([
    [1, 22],
    [2, 34],
    [4, 58],
  ])('frames %i bubble line(s) at %ipx tall', (count, height) => {
    expect(speechBubbleFrameSize(Array<string>(count).fill('Hallo'), 'say').height).toBe(height);
  });

  /** An empty balloon still has a body. */
  it('never frames a bubble shorter than one line', () => {
    expect(speechBubbleFrameSize([], 'say').height).toBe(speechBubbleFrameSize(['Ja.'], 'say').height);
  });

  /**
   * As wide as its widest line, between three corner radii and a full line's width.
   * Without a canvas to measure on, a character is taken as 6.6px wide.
   */
  it('fits the width of a bubble to its text', () => {
    expect(speechBubbleFrameSize(['Ja'], 'say').width).toBe(24);
    const short = speechBubbleFrameSize(['Hallo'], 'say').width;
    const longer = speechBubbleFrameSize(['Hallo', 'Hallo Welt'], 'say').width;
    expect(short).toBeGreaterThan(24);
    expect(longer).toBeGreaterThan(short);
    expect(longer).toBeLessThan(150);
    expect(speechBubbleFrameSize(['Hallo Welt, wie geht es dir heute?'], 'say').width).toBe(150);
  });

  /** A yell's teeth stand 5px out on every side. */
  it('frames a yell with room for its teeth', () => {
    expect(speechBubbleFrameSize(['Hallo Welt, wie geht es dir heute?'], 'yell')).toEqual({ width: 160, height: 32 });
  });

  it.each([
    ['player', NAME_PLAQUE.playerBackground],
    ['peer', NAME_PLAQUE.playerBackground],
    ['npc', NAME_PLAQUE.npcBackground],
  ] as const)('gives a hale %s a plaque', (kind, background) => {
    expect(namePlaqueBackground(kind, 'hale', false)).toBe(background);
  });

  it('gives a hale monster a plaque only while it is the target', () => {
    expect(namePlaqueBackground('monster', 'hale', false)).toBeUndefined();
    expect(namePlaqueBackground('monster', 'hale', true)).toBe(NAME_PLAQUE.playerBackground);
  });

  it.each(['grazed', 'wounded', 'hurt', 'failing'] as const)('tints a %s player, peer, and monster alike, and leaves an NPC as it is', (condition) => {
    const tint = NAME_PLAQUE.conditionBackground[condition];
    expect(namePlaqueBackground('player', condition, false)).toBe(tint);
    expect(namePlaqueBackground('peer', condition, false)).toBe(tint);
    expect(namePlaqueBackground('monster', condition, false)).toBe(tint);
    expect(namePlaqueBackground('npc', condition, false)).toBe(NAME_PLAQUE.npcBackground);
  });

  it('tints a fallen player and peer, leaves an NPC as it is, and gives a nightmare driven off no plaque', () => {
    const tint = NAME_PLAQUE.conditionBackground.fallen;
    expect(namePlaqueBackground('player', 'fallen', false)).toBe(tint);
    expect(namePlaqueBackground('peer', 'fallen', false)).toBe(tint);
    expect(namePlaqueBackground('npc', 'fallen', false)).toBe(NAME_PLAQUE.npcBackground);
    expect(namePlaqueBackground('monster', 'fallen', true)).toBeUndefined();
  });

  it('gives each band its own tint', () => {
    expect(new Set(Object.values(NAME_PLAQUE.conditionBackground)).size).toBe(5);
  });

  /**
   * Both baselines follow the **line box**, whose two numbers are recorded in `LINE_BOX` from an
   * ink-row measurement.
   */
  it('places a bubble line one baseline offset below its box top', () => {
    expect(baselineBelowBoxTop(5, 10)).toBe(15);
    // A second line advances by `lineHeight`, and the baseline follows rigidly, so consecutive
    // baselines are exactly `lineHeight` apart.
    expect(baselineBelowBoxTop(5 + 12, 10)).toBe(27);
  });

  it('sizes the line box a pixel deeper than canvas metrics report', () => {
    // The line box measures 13 at size 10 and 14 at size 11; `fontBoundingBoxDescent` reports 2 rather
    // than 3, so reading it leaves the plaque box a pixel short and the text riding half a pixel up.
    expect(lineBoxHeight(10)).toBe(13);
    expect(lineBoxHeight(11)).toBe(14);
  });

  it('centres a plaque line box rather than its em box', () => {
    // `ceil(14 + 4)` is an 18-tall box around a 14-tall line box: 2 above, baseline at 2 + 11.
    expect(baselineInCenteredBox(18, 11)).toBe(13);
    // `textBaseline: 'middle'` at `height / 2` would put it at 9 — low by the half-difference
    // between the two boxes, which is the shift that made the plaque text look off.
    expect(baselineInCenteredBox(18, 11)).not.toBe(18 / 2);
  });
});

describe('elite auras', () => {
  function auras(scene: WorldScene): THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[] {
    const found: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[] = [];
    scene.scene.traverse((object) => {
      if (object.name === ELITE_AURA_NAME) found.push(object as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>);
    });
    return found;
  }
  const elite = (id: string, trait: ClientEntity['trait'], x = 4): ClientEntity =>
    player({ id, kind: 'monster', name: 'Ghost', position: { x, z: 6 }, rank: 'elite', trait });

  it("stands round an elite where it stands, in its trait's colour, and round no ordinary nightmare", () => {
    const scene = makeScene();
    scene.placeEntity(player({ id: 'monster:1', kind: 'monster', name: 'Ghost' }));
    expect(auras(scene)).toEqual([]);
    scene.placeEntity(elite('monster:2', 'shielded'));
    const [aura] = auras(scene);
    expect(aura!.material.color.getHex()).toBe(ELITE_TRAIT_COLORS.shielded);
    const at = aura!.getWorldPosition(new THREE.Vector3());
    expect([at.x, at.z]).toEqual([4, 6]);
  });

  it('goes when the elite leaves or loses its trait, and serves the next elite then', () => {
    const scene = makeScene();
    for (let index = 0; index < ELITE_AURA_POOL_SIZE + 1; index += 1) scene.placeEntity(elite(`monster:${index}`, 'stony', index));
    const pool = auras(scene);
    expect(pool).toHaveLength(ELITE_AURA_POOL_SIZE);
    scene.removeEntity('monster:0');
    scene.placeEntity(elite('monster:1', undefined));
    expect(auras(scene)).toHaveLength(ELITE_AURA_POOL_SIZE - 2);
    scene.placeEntity(elite('monster:20', 'stony', 20));
    scene.placeEntity(elite('monster:21', 'stony', 21));
    expect(new Set(auras(scene))).toEqual(new Set(pool));
  });

  it('goes as the elite is driven off', () => {
    const scene = makeScene();
    scene.placeEntity(elite('monster:1', 'stony'));
    scene.updateCondition('monster:1', 'fallen');
    expect(auras(scene)).toEqual([]);
  });

  it('stands round no elite first seen lying driven off', () => {
    const scene = makeScene();
    scene.placeEntity({ ...elite('monster:1', 'stony'), condition: 'fallen' });
    expect(auras(scene)).toEqual([]);
  });

  it.each([
    [false, true],
    [true, false],
  ])('breathes while reduced motion is %s: %s', (reducedMotion, breathes) => {
    const scene = new WorldScene(emptyAssets(), TEST_REGISTRY, 1, reducedMotion);
    scene.placeEntity(elite('monster:1', 'stony'));
    const opacities = [0.4, 0.8, 0.8].map((seconds) => {
      scene.tick(seconds);
      return auras(scene)[0]!.material.opacity;
    });
    expect(new Set(opacities).size > 1).toBe(breathes);
  });
});

describe('quest marks', () => {
  function marks(scene: WorldScene): THREE.Mesh[] {
    const found: THREE.Mesh[] = [];
    scene.scene.traverse((object) => {
      if (object.name === QUEST_MARKER_NAME) found.push(object as THREE.Mesh);
    });
    return found;
  }
  const npc = (id: string, x = 4): ClientEntity => player({ id, kind: 'npc', name: 'Pugnax', position: { x, z: 6 } });

  it('hangs over the head of a carrier the session marks, outside its model holder, whether it comes into view before or after', () => {
    const scene = makeScene();
    scene.placeEntity(npc('npc:Hall/pugnax'));
    expect(marks(scene)).toEqual([]);
    scene.showQuestMarkers(new Map([['npc:Hall/pugnax', 'offer']]));
    const [mark] = marks(scene);
    expect(scene.questMarkerShown('npc:Hall/pugnax')).toBe('offer');
    scene.tick(0.1);
    const at = mark!.getWorldPosition(new THREE.Vector3());
    expect([at.x, at.z]).toEqual([4, 6]);
    expect(at.y).toBeGreaterThan(0);
    // No portrait shows it, even of the carrier it marks.
    scene.setPortraitSubject('target', 'npc:Hall/pugnax');
    for (const layer of Object.values(PORTRAIT_LAYERS)) expect(mark!.layers.isEnabled(layer)).toBe(false);

    scene.showQuestMarkers(new Map([['npc:Hall/sana', 'turnIn']]));
    expect(marks(scene)).toEqual([]);
    scene.placeEntity(npc('npc:Hall/sana', 8));
    expect([scene.questMarkerShown('npc:Hall/sana'), marks(scene)]).toEqual(['turnIn', [mark]]);
  });

  it('draws a quest not finished yet as the ? in grey, in a material of its own beside the gold', () => {
    const scene = makeScene();
    scene.placeEntity(npc('npc:Hall/pugnax'));
    scene.placeEntity(npc('npc:Hall/sana', 8));
    const filled: [string, unknown][] = [];
    const context = {
      fillStyle: '',
      scale() {},
      strokeText() {},
      measureText: () => ({ width: 14 }),
      fillText(glyph: string) {
        filled.push([glyph, this.fillStyle]);
      },
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    try {
      scene.showQuestMarkers(
        new Map([
          ['npc:Hall/pugnax', 'inProgress'],
          ['npc:Hall/sana', 'turnIn'],
        ]),
      );
      expect([scene.questMarkerShown('npc:Hall/pugnax'), scene.questMarkerShown('npc:Hall/sana')]).toEqual(['inProgress', 'turnIn']);
      expect(filled).toEqual([
        ['!', '#ffcf40'],
        ['?', '#ffcf40'],
        ['?', '#b8b8b8'],
      ]);
      const [grey, gold] = marks(scene).map((mesh) => mesh.material as THREE.MeshBasicMaterial);
      expect(grey).not.toBe(gold);
      expect((grey!.map!.image as HTMLCanvasElement).width).toBe((gold!.map!.image as HTMLCanvasElement).width);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("stands over the top of a fixture's model the session marks, unturned with it, and goes with its sector", () => {
    const scene = makeScene({ ...emptyAssets(), object: () => new THREE.Mesh(new THREE.BoxGeometry(1.4, 2.2, 0.1).translate(0, 1.1, 0)) });
    const boardSector = sector({
      placements: [placement('notice-board-1', 'box', { x: 4, z: 6, yaw: 35 })],
      fixtures: [{ id: 'fixture-1', placement: 'notice-board-1', service: 'bountyBoard' }],
    });
    scene.enterSpace(world());
    scene.showQuestMarkers(new Map([['fixture:EdariaSquare/fixture-1', 'offer']]));
    scene.addSector(boardSector);
    expect(scene.questMarkerShown('fixture:EdariaSquare/fixture-1')).toBe('offer');
    scene.tick(0.1);
    const [mark] = marks(scene);
    const at = mark!.getWorldPosition(new THREE.Vector3());
    expect([at.x, at.z]).toEqual([4, 6]);
    expect(at.y).toBeGreaterThan(2.2);
    expect(mark!.getWorldQuaternion(new THREE.Quaternion()).angleTo(npcMarkOrientation())).toBeCloseTo(0, 6);

    scene.removeSector('EdariaSquare');
    expect(marks(scene)).toEqual([]);
    expect(scene.questMarkerShown('fixture:EdariaSquare/fixture-1')).toBeUndefined();
  });

  /** How a mark over a carrier's head is turned: toward the camera, whatever the carrier faces. */
  function npcMarkOrientation(): THREE.Quaternion {
    const scene = makeScene();
    scene.placeEntity(npc('npc:Hall/pugnax'));
    scene.showQuestMarkers(new Map([['npc:Hall/pugnax', 'offer']]));
    return marks(scene)[0]!.getWorldQuaternion(new THREE.Quaternion());
  }

  it('comes from a pool of fixed size, and goes when its carrier leaves view', () => {
    const scene = makeScene();
    const ids = Array.from({ length: QUEST_MARKER_POOL_SIZE + 1 }, (_, index) => `npc:Hall/n${index}`);
    scene.showQuestMarkers(new Map(ids.map((id) => [id, 'offer'])));
    ids.forEach((id, index) => scene.placeEntity(npc(id, index)));
    expect(marks(scene)).toHaveLength(QUEST_MARKER_POOL_SIZE);
    expect(scene.questMarkerShown(ids.at(-1)!)).toBeUndefined();
    scene.removeEntity(ids[0]!);
    expect(marks(scene)).toHaveLength(QUEST_MARKER_POOL_SIZE - 1);
  });
});

describe('name plaques hang off the entity node', () => {
  /** Plaque canvases: screen-aligned planes textured from a canvas. */
  function plaqueCanvases(scene: WorldScene): HTMLCanvasElement[] {
    const canvases: HTMLCanvasElement[] = [];
    scene.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      const material = mesh.material as THREE.MeshBasicMaterial | undefined;
      if (mesh.isMesh && material?.map?.image instanceof HTMLCanvasElement) canvases.push(material.map.image);
    });
    return canvases;
  }

  it('gives players and NPCs a plaque and monsters none', () => {
    const scene = makeScene();

    scene.placeEntity(player());
    expect(plaqueCanvases(scene)).toHaveLength(1);

    scene.placeEntity(player({ id: 'npc:EdariaSquare/libus', kind: 'npc', name: 'Libus' }));
    expect(plaqueCanvases(scene)).toHaveLength(2);

    scene.placeEntity(player({ id: 'monster:1', kind: 'monster', name: 'Ghost' }));
    expect(plaqueCanvases(scene)).toHaveLength(2);
  });

  it('gives a nightmare a plaque while it is not hale, and takes it away when it is', () => {
    const scene = makeScene();
    scene.placeEntity(player({ id: 'monster:1', kind: 'monster', name: 'Ghost' }));
    expect(plaqueCanvases(scene)).toHaveLength(0);

    scene.updateCondition('monster:1', 'hurt');
    expect(plaqueCanvases(scene)).toHaveLength(1);
    scene.updateCondition('monster:1', 'failing');
    expect(plaqueCanvases(scene)).toHaveLength(1);

    scene.updateCondition('monster:1', 'hale');
    expect(plaqueCanvases(scene)).toHaveLength(0);
  });

  it("names a nightmare in the reader's language, and a dreamer as they are called", () => {
    const written: string[] = [];
    const context = { scale() {}, fillRect() {}, strokeRect() {}, measureText: () => ({ width: 40 }), fillText: (text: string) => written.push(text) };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    setLocale('de');
    try {
      const scene = makeScene();
      scene.placeEntity(player({ id: 'monster:1', kind: 'monster', name: 'Ghost', condition: 'hurt' }));
      scene.placeEntity(player({ id: 'peer', kind: 'peer', name: 'Ghost' }));
      expect(written).toEqual(['Gespenst', 'Ghost']);
    } finally {
      setLocale('en');
      vi.restoreAllMocks();
    }
  });

  it("names an elite by its trait and its kind, in the reader's language, and again once its trait changes", () => {
    const written: string[] = [];
    const context = { scale() {}, fillRect() {}, strokeRect() {}, measureText: () => ({ width: 40 }), fillText: (text: string) => written.push(text) };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    try {
      const scene = makeScene();
      const ghost = { id: 'monster:1', kind: 'monster', name: 'Ghost', condition: 'hurt' } as const;
      scene.placeEntity(player({ ...ghost, rank: 'elite', trait: 'stony' }));
      setLocale('de');
      scene.placeEntity(player({ ...ghost, rank: 'elite', trait: 'shielded' }));
      scene.placeEntity(player({ ...ghost, rank: undefined, trait: undefined }));
      expect(written).toEqual(['Stony Ghost', 'Schildbewehrtes Gespenst', 'Gespenst']);
    } finally {
      setLocale('en');
      vi.restoreAllMocks();
    }
  });

  it("redraws a player's plaque when their condition changes, and takes the condition an entity is placed with", () => {
    const scene = makeScene();
    scene.placeEntity(player());
    const [hale] = plaqueCanvases(scene);

    scene.updateCondition('self', 'wounded');
    const [wounded] = plaqueCanvases(scene);
    expect(wounded).not.toBe(hale);
    expect(plaqueCanvases(scene)).toHaveLength(1);

    scene.placeEntity(player({ condition: 'fallen' }));
    expect(plaqueCanvases(scene)).toHaveLength(1);
    expect(plaqueCanvases(scene)[0]).not.toBe(wounded);
  });

  /** Re-placing the same entity must not stack a new plaque on each pass. */
  it('does not accumulate plaques across repeated placements', () => {
    const scene = makeScene();
    for (let index = 0; index < 5; index += 1) scene.placeEntity(player());
    expect(plaqueCanvases(scene)).toHaveLength(1);
  });

  /**
   * Counting proves no plaque was *added*; it cannot see that the old one was kept. Dropping the
   * name term from the rebuild condition leaves the stale text on screen with the count unchanged.
   */
  it('rebuilds the plaque when the name changes', () => {
    const scene = makeScene();
    scene.placeEntity(player());
    const [before] = plaqueCanvases(scene);

    scene.placeEntity(player({ name: 'Renamed' }));

    expect(plaqueCanvases(scene)).toHaveLength(1);
    expect(plaqueCanvases(scene)[0]).not.toBe(before);
  });

  /**
   * The kind drives the plaque's fill and its bold flag, so a peer promoted to `player` keeps the
   * wrong styling if `kindChanged` is dropped — and the name is unchanged, so the name term cannot
   * cover for it. This is why the source captures the kind *before* the assignment that overwrites
   * it; nothing observed that ordering.
   */
  it('rebuilds the plaque when only the kind changes', () => {
    const scene = makeScene();
    scene.placeEntity(player({ kind: 'peer', name: 'Same' }));
    const [before] = plaqueCanvases(scene);

    scene.placeEntity(player({ kind: 'player', name: 'Same' }));

    expect(plaqueCanvases(scene)).toHaveLength(1);
    expect(plaqueCanvases(scene)[0]).not.toBe(before);
  });

  /**
   * A rebuilt plaque owns a `PlaneGeometry` and a `CanvasTexture`-backed material that no later
   * cleanup can reach once it is detached, so a bare `removeFromParent()` leaks both on
   * every rename or kind change.
   */
  it('disposes the plaque it replaces rather than only detaching it', () => {
    const scene = makeScene();
    scene.placeEntity(player());

    const disposed: string[] = [];
    scene.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      const material = mesh.material as THREE.MeshBasicMaterial | undefined;
      if (!mesh.isMesh || !(material?.map?.image instanceof HTMLCanvasElement)) return;
      vi.spyOn(mesh.geometry, 'dispose').mockImplementation(() => disposed.push('geometry'));
      vi.spyOn(material, 'dispose').mockImplementation(() => disposed.push('material'));
    });

    scene.placeEntity(player({ name: 'Renamed' }));

    expect(disposed).toContain('geometry');
    expect(disposed).toContain('material');
  });

  describe('which plaque shows over which', () => {
    /** The plaque plate of the entity standing at `x`. */
    function plateAt(scene: WorldScene, x: number): THREE.Mesh | undefined {
      let found: THREE.Mesh | undefined;
      scene.scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        const material = mesh.material as THREE.MeshBasicMaterial | undefined;
        if (mesh.isMesh && material?.map?.image instanceof HTMLCanvasElement && mesh.parent?.parent?.position.x === x) found = mesh;
      });
      return found;
    }

    function depthTested(plate: THREE.Mesh): boolean {
      return (plate.material as THREE.MeshBasicMaterial).depthTest;
    }

    /** The player at 10, and peers at 8 (hale), 11 (the target), and 12 (hurt). */
    function crowd(): WorldScene {
      const scene = makeScene();
      scene.placeEntity(player());
      scene.placeEntity(player({ id: 'hale', kind: 'peer', position: { x: 8, z: 10 } }));
      scene.placeEntity(player({ id: 'target', kind: 'peer', position: { x: 11, z: 10 } }));
      scene.placeEntity(player({ id: 'hurt', kind: 'peer', condition: 'hurt', position: { x: 12, z: 10 } }));
      scene.showSelection('target', PLAIN_MARK);
      scene.tick(0.016);
      return scene;
    }

    function orders(scene: WorldScene): number[] {
      return [11, 12, 10, 8].map((x) => plateAt(scene, x)!.renderOrder);
    }

    it("draws the target's plaque over a hurt one, a hurt one over the own, and the own over the rest, none hidden by another", () => {
      const scene = crowd();

      const [target, hurt, own, hale] = orders(scene);
      expect(target).toBeGreaterThan(hurt!);
      expect(hurt).toBeGreaterThan(own!);
      expect(own).toBeGreaterThan(hale!);
      for (const x of [8, 10, 11, 12]) expect((plateAt(scene, x)!.material as THREE.MeshBasicMaterial).depthWrite).toBe(false);
    });

    it('draws a more hurt plaque over a less hurt one', () => {
      const scene = makeScene();
      scene.placeEntity(player());
      scene.placeEntity(player({ id: 'grazed', kind: 'peer', condition: 'grazed', position: { x: 8, z: 10 } }));
      scene.placeEntity(player({ id: 'failing', kind: 'peer', condition: 'failing', position: { x: 12, z: 10 } }));
      scene.tick(0.016);

      expect(plateAt(scene, 12)!.renderOrder).toBeGreaterThan(plateAt(scene, 8)!.renderOrder);
      expect(plateAt(scene, 8)!.renderOrder).toBeGreaterThan(plateAt(scene, 10)!.renderOrder);
    });

    it("draws the target's plaque over even a fallen one", () => {
      const scene = crowd();
      scene.placeEntity(player({ id: 'down', kind: 'peer', condition: 'fallen', position: { x: 6, z: 10 } }));
      scene.tick(0.016);

      expect(plateAt(scene, 11)!.renderOrder).toBeGreaterThan(plateAt(scene, 6)!.renderOrder);
      expect(plateAt(scene, 6)!.renderOrder).toBeGreaterThan(plateAt(scene, 12)!.renderOrder);
    });

    it("shows only the target's plaque through the world, and the plaque of the one it was no longer", () => {
      const scene = crowd();
      expect([8, 10, 11, 12].map((x) => depthTested(plateAt(scene, x)!))).toEqual([true, true, false, true]);

      scene.showSelection('hale', PLAIN_MARK);
      scene.tick(0.016);
      expect(plateAt(scene, 8)!.renderOrder).toBeGreaterThan(plateAt(scene, 12)!.renderOrder);
      expect([8, 10, 11, 12].map((x) => depthTested(plateAt(scene, x)!))).toEqual([false, true, true, true]);
      expect(plateAt(scene, 11)!.renderOrder).toBeLessThan(plateAt(scene, 10)!.renderOrder);
    });

    it('shows the name of a hale nightmare only while it is the target', () => {
      const scene = makeScene();
      scene.placeEntity(player());
      scene.placeEntity(player({ id: 'monster:1', kind: 'monster', name: 'Ghost', position: { x: 12, z: 10 } }));
      expect(plateAt(scene, 12)).toBeUndefined();

      scene.showSelection('monster:1', PLAIN_MARK);
      expect(plateAt(scene, 12)).toBeDefined();

      // Struck and healed again while targeted, it keeps its name.
      scene.updateCondition('monster:1', 'grazed');
      scene.updateCondition('monster:1', 'hale');
      expect(plateAt(scene, 12)).toBeDefined();

      scene.showSelection(undefined, PLAIN_MARK);
      expect(plateAt(scene, 12)).toBeUndefined();
    });
  });
});

/**
 * GPU-resource lifetime. `removeFromParent()` leaves geometry, materials, and textures in
 * `WebGLRenderer`'s internal maps, so a long session of doors, border crossings, and peer churn
 * would accumulate VRAM until the context is lost. Nothing about that is visible in a graph
 * assertion, which is why these spy on `dispose` directly — and why they assert both directions:
 * freeing what this file allocated, and *not* freeing what the asset cache lent it.
 */
describe('overlay art keeps a readable size', () => {
  /** A landscape phone. */
  const PHONE = { width: 844, height: 390 };

  /** How many times its size in metres the scene draws a plaque and a bubble. */
  function magnifications(scene: WorldScene): { plaque: number; bubble: number } {
    let plate: THREE.Object3D | undefined;
    scene.scene.traverse((object) => {
      const material = (object as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
      if ((object as THREE.Mesh).isMesh && material?.map?.image instanceof HTMLCanvasElement) plate = object;
    });
    return { plaque: plate!.parent!.scale.y, bubble: scene.camera.top / scene.placedBubbles().halfSize.y };
  }

  it('draws an overlay pixel across its smallest readable size on a phone at the farthest zoom', () => {
    const scale = scaleForZoomFactor(PLAYER_ZOOM.minFactor);
    const natural = (OVERLAY_METRES_PER_PIXEL * PHONE.height) / (2 * scale);

    expect(natural).toBeLessThan(OVERLAY_MIN_SCREEN_PIXELS);
    expect(natural * overlayMagnification(scale, PHONE.height)).toBeCloseTo(OVERLAY_MIN_SCREEN_PIXELS, 9);
  });

  it('draws overlay art at its size in metres where that is already readable', () => {
    expect(overlayMagnification(scaleForZoomFactor(PLAYER_ZOOM.maxFactor), 1440)).toBe(1);
  });

  it('magnifies the plaques and the bubbles alike, following the zoom and the window', () => {
    const scene = makeScene();
    scene.placeEntity(player());
    scene.setViewportSize(PHONE.width, PHONE.height);
    scene.applyZoomFactor(PLAYER_ZOOM.minFactor);
    const far = overlayMagnification(scene.camera.top, PHONE.height);
    expect(far).toBeGreaterThan(1);
    expect(magnifications(scene).plaque).toBeCloseTo(far, 9);
    expect(magnifications(scene).bubble).toBeCloseTo(far, 9);

    scene.setViewportSize(2560, 1440);
    scene.applyZoomFactor(PLAYER_ZOOM.maxFactor);
    expect(magnifications(scene)).toEqual({ plaque: 1, bubble: 1 });
  });
});

describe('scatter', () => {
  /** A tuft-shaped prop under a scaled, moved parent, as the pipeline's `SomnioNormalize` node stands over every prop `normalize_props.py` stages. */
  function tuftModel(): THREE.Object3D {
    const root = new THREE.Group();
    const normalize = new THREE.Group();
    normalize.scale.setScalar(0.5);
    normalize.position.set(0.1, 0, -0.05);
    normalize.add(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.6, 0.2).translate(0, 0.3, 0), new THREE.MeshStandardMaterial()));
    root.add(normalize);
    return root;
  }

  /** Assets whose every object is the tuft model, drawn instanced from one cached prototype. */
  function scatterAssets(): ModelAssets & { prototype: THREE.Object3D } {
    const prototype = tuftModel();
    return {
      ...emptyAssets(),
      prototype,
      object: () => prototype.clone(),
      prototypeMeshes: () => prototypeMeshesOf(prototype),
    };
  }

  function scatterGroups(scene: WorldScene): THREE.Object3D[] {
    return scene.scene.children.flatMap((root) => root.children.filter((child) => child.name === 'somnio-scatter'));
  }

  /** A character whose one foot bone stands `height` metres above its root. */
  function footed(height: number): THREE.Object3D {
    const root = new THREE.Object3D();
    const foot = new THREE.Object3D();
    foot.name = 'footl';
    foot.position.y = height / CHARACTER_SCALE;
    root.add(foot);
    return root;
  }

  function tilts(group: THREE.Object3D): THREE.InstancedBufferAttribute[] {
    return group.children.flatMap((mesh) => {
      const attribute = (mesh as THREE.Mesh).geometry.getAttribute('aTilt') as THREE.InstancedBufferAttribute | undefined;
      return attribute === undefined ? [] : [attribute];
    });
  }

  function instancesNear(group: THREE.Object3D, point: { x: number; z: number }, radius: number): number {
    const matrix = new THREE.Matrix4();
    const at = new THREE.Vector3();
    let count = 0;
    for (const mesh of group.children as THREE.InstancedMesh[]) {
      for (let index = 0; index < mesh.count; index += 1) {
        mesh.getMatrixAt(index, matrix);
        at.setFromMatrixPosition(matrix);
        if (Math.hypot(at.x - point.x, at.z - point.z) < radius) count += 1;
      }
    }
    return count;
  }

  it('is settled only once every sector it draws has its field and its scatter placed', () => {
    const held = heldJobs(rasterizeGround);
    const scene = makeScene(scatterAssets(), undefined, { rasterize: held.run });
    scene.addSector(sector());
    scene.addSector(outdoorSector('NorthMeadow', { x: 0, z: -20 }));
    expect(scene.isSettled()).toBe(false);
    scene.tick(0.016);
    expect(scene.isSettled()).toBe(false);

    held.release();
    expect(scene.isSettled()).toBe(false);
    scene.tick(0.016);
    expect(scatterGroups(scene)).toHaveLength(1);
    expect(scene.isSettled()).toBe(false);
    scene.tick(0.016);
    expect(scatterGroups(scene)).toHaveLength(2);
    expect(scene.isSettled()).toBe(true);
  });

  /** A sector's scatter takes milliseconds, so it is placed off the frame, as the ground's field is. */
  it('keeps the last scatter drawn, and the scene unsettled, until the next is placed, asking once', () => {
    const held = heldJobs(scatterSector);
    const scene = makeScene(scatterAssets(), undefined, undefined, { scatter: held.run });
    const west = outdoorSector('West', { x: 0, z: 0 });
    scene.addSector(west);
    scene.tick(0.016);
    expect(scatterGroups(scene)).toEqual([]);
    expect(scene.isSettled()).toBe(false);
    held.release();
    const [first] = scatterGroups(scene);
    expect(first).toBeDefined();
    expect(scene.isSettled()).toBe(true);

    const boxed = { ...west, placements: [placement('box-1', 'box', { x: 10, z: 10 })] };
    scene.addSector(boxed);
    scene.tick(0.016);
    // The same sector again while its scatter is still on the way asks for nothing more.
    scene.addSector(boxed);
    scene.tick(0.016);
    expect(held.jobs).toHaveLength(1);
    expect(scatterGroups(scene)).toEqual([first]);
    expect(scene.isSettled()).toBe(false);
    held.release();
    expect(scatterGroups(scene)).toHaveLength(1);
    expect(scatterGroups(scene)[0]).not.toBe(first);
    expect(instancesNear(scatterGroups(scene)[0]!, { x: 10, z: 10 }, 0.4)).toBe(0);
  });

  /** A door transfer or a login shows what grows under the player at once, as it does the ground. */
  it("reveals a held space with the player's own sector's scatter placed, and drops the one the worker answers later", () => {
    const held = heldJobs(scatterSector);
    const scene = makeScene(scatterAssets(), undefined, undefined, { scatter: held.run });
    scene.enterSpace(world());
    scene.addSector(outdoorSector('West', { x: 0, z: 0 }));
    scene.tick(0.016);
    expect(held.jobs).toHaveLength(1);
    expect(scatterGroups(scene)).toEqual([]);

    scene.placeEntity(player({ position: { x: 5, z: 5 } }));
    const [placed] = scatterGroups(scene);
    expect(placed?.parent?.visible).toBe(true);
    held.release();
    expect(scatterGroups(scene)).toEqual([placed]);
  });

  it("places the player's own sector's scatter at a reveal whose field the worker still holds", () => {
    const fields = heldJobs(rasterizeGround);
    const scatters = heldJobs(scatterSector);
    const scene = makeScene(scatterAssets(), undefined, { rasterize: fields.run }, { scatter: scatters.run });
    scene.enterSpace(world());
    scene.addSector(outdoorSector('West', { x: 0, z: 0 }));
    scene.tick(0.016);
    expect([fields.jobs.length, scatters.jobs.length, scatterGroups(scene).length]).toEqual([1, 0, 0]);

    scene.placeEntity(player({ position: { x: 5, z: 5 } }));
    const [placed] = scatterGroups(scene);
    expect(placed?.parent?.visible).toBe(true);
    fields.release();
    scene.tick(0.016);
    scatters.release();
    expect(scatterGroups(scene)).toEqual([placed]);
  });

  /** A program compiled on its first draw stalls the frame it draws in. */
  it("compiles the programs the ground, what grows on it, a prop, a drop and a trophy lying on it, and a tap's ring draw in the prewarm, and keeps them past a door", async () => {
    // Each kind drawn with a material of its own type, so each is a program of its own.
    const model = (material: THREE.Material): THREE.Object3D => new THREE.Group().add(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.6, 0.2), material));
    const grass = model(new THREE.MeshLambertMaterial());
    const pebble = model(new THREE.MeshPhongMaterial());
    const lying = model(new THREE.MeshToonMaterial());
    const trophy = model(new THREE.MeshMatcapMaterial());
    const assets = {
      ...scatterAssets(),
      ground: () => lying.clone(),
      trophy: () => trophy.clone(),
      prototypeMeshes: (id: string) => prototypeMeshesOf(id === PEBBLE_MODEL_ID ? pebble : grass),
    };
    const scene = new WorldScene(
      assets,
      { ...TEST_REGISTRY, groundModels: [{ id: 'cap', stem: 'Cap' }], trophyModels: [{ id: 'ghost', stem: 'GroundGhostlyWisp' }] },
      1,
      false,
    );
    const { compileAsync, uncompiled, released } = recordingCompiler();
    await scene.prewarm({ compileAsync });

    // A meadow grows grass and flowers, a wood grass and pebbles.
    scene.addSector(outdoorSector('West', { x: 0, z: 0 }, { placements: [placement('box-1', 'box', { x: 10, z: 10 })] }));
    scene.addSector(outdoorSector('Wood', { x: 20, z: 0 }, { ground: { backgroundMaterialId: 'forest-floor', marks: [] } }));
    scene.showLoot({ lootId: 'cap', x: 12, z: 12, contents: { kind: 'item', baseId: 'cap', tier: 1, rarity: 'common' } });
    scene.showLoot({ lootId: 'wisp', x: 14, z: 12, contents: { kind: 'trophy', monsterKind: 'ghost' } });
    scene.showPressMarker({ x: 5, z: 5 });
    for (let frame = 0; frame < 3; frame += 1) scene.tick(0.016);
    expect(scatterGroups(scene)).toHaveLength(2);
    expect(uncompiled(scene.scene)).toEqual([]);

    // A door disposes every ground of the space left, and a lifted ring its own material.
    scene.liftPressMarker();
    for (let frame = 0; frame < 30; frame += 1) scene.tick(0.016);
    scene.enterSpace(world());
    scene.addSector(outdoorSector('West', { x: 0, z: 0 }));
    scene.placeEntity(player({ position: { x: 5, z: 5 } }));
    scene.showPressMarker({ x: 6, z: 6 });
    scene.showLoot({ lootId: 'wisp-2', x: 7, z: 7, contents: { kind: 'trophy', monsterKind: 'ghost' } });
    scene.tick(0.016);
    expect(groundMeshes(scene).length).toBeGreaterThan(0);
    expect(released(scene.scene)).toEqual([]);
  });

  it('drops a scatter placed for what its ground no longer is, or for a sector gone', () => {
    const held = heldJobs(scatterSector);
    const scene = makeScene(scatterAssets(), undefined, undefined, { scatter: held.run });
    const west = outdoorSector('West', { x: 0, z: 0 });
    scene.addSector(west);
    scene.tick(0.016);
    const stale = held.jobs.splice(0);
    scene.addSector({ ...west, placements: [placement('box-1', 'box', { x: 10, z: 10 })] });
    scene.tick(0.016);
    for (const job of stale) job.done(scatterSector(job.inputs));
    expect(scatterGroups(scene)).toEqual([]);
    held.release();
    const boxed = scatterGroups(scene)[0]!;
    expect(instancesNear(boxed, { x: 10, z: 10 }, 0.4)).toBe(0);

    // Changed and changed back before the scatter for the change is placed.
    scene.addSector(west);
    scene.tick(0.016);
    scene.addSector({ ...west, placements: [placement('box-1', 'box', { x: 10, z: 10 })] });
    scene.tick(0.016);
    held.release();
    expect(scatterGroups(scene)).toEqual([boxed]);

    scene.addSector(west);
    scene.tick(0.016);
    expect(held.jobs).toHaveLength(1);
    scene.removeSector('West');
    held.release();
    expect(scatterGroups(scene)).toEqual([]);
  });

  it('bends every mesh of a batch over one set of tilts, and lets every scatter mesh take shadows', () => {
    const prototype = new THREE.Group();
    prototype.add(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.4, 0.2), new THREE.MeshStandardMaterial()));
    prototype.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.6, 0.1).translate(0, 0.3, 0), new THREE.MeshStandardMaterial()));
    const scene = makeScene({
      ...emptyAssets(),
      object: () => prototype.clone(),
      prototypeMeshes: () => prototypeMeshesOf(prototype),
      character: () => footed(0),
    });
    scene.addSector(sector());
    scene.tick(0.016);

    const meshes = scatterGroups(scene)[0]!.children as THREE.InstancedMesh[];
    expect(meshes.every((mesh) => mesh.receiveShadow)).toBe(true);
    const meshesPerTilts = new Map<ArrayLike<number>, THREE.InstancedBufferAttribute[]>();
    for (const mesh of meshes) {
      const tilt = mesh.geometry.getAttribute('aTilt') as THREE.InstancedBufferAttribute | undefined;
      if (tilt !== undefined) meshesPerTilts.set(tilt.array, [...(meshesPerTilts.get(tilt.array) ?? []), tilt]);
    }
    expect(meshesPerTilts.size).toBeGreaterThan(0);
    // Each grass model and the flowers draw two meshes, both bending as one.
    expect([...meshesPerTilts.values()].map((attributes) => attributes.length)).toEqual(Array.from({ length: meshesPerTilts.size }, () => 2));

    // A foot in one tuft flags both meshes' tilts for upload on every frame it moves them.
    const tufted = meshes.find((mesh) => mesh.geometry.getAttribute('aTilt') !== undefined)!;
    const matrix = new THREE.Matrix4();
    tufted.getMatrixAt(0, matrix);
    const root = new THREE.Vector3().setFromMatrixPosition(matrix);
    scene.placeEntity(player({ id: 'peer-1', kind: 'peer', position: { x: root.x + 0.02, z: root.z } }));
    for (let frame = 0; frame < 10; frame += 1) scene.tick(1 / 60);
    const attributes = meshesPerTilts.get(tufted.geometry.getAttribute('aTilt').array)!;
    expect([...(attributes[0]!.array as Float32Array)].some((value) => Math.abs(value) > 0.1)).toBe(true);
    expect(attributes.map((attribute) => attribute.version)).toEqual([10, 10]);
  });

  it('gives each of two sectors growing the same grass its own tilts', () => {
    const scene = makeScene(scatterAssets());
    scene.addSector(sector());
    scene.addSector(outdoorSector('NorthMeadow', { x: 0, z: -20 }));
    scene.tick(0.016);
    expect(scatterGroups(scene)).toHaveLength(1);
    scene.tick(0.016);

    const [first, second] = scatterGroups(scene);
    expect(tilts(first!).length).toBeGreaterThan(0);
    for (const attribute of tilts(first!)) expect(tilts(second!).map((other) => other.array)).not.toContain(attribute.array);
  });

  it('stands an instance at the size and origin of a placed model, the parent node included', () => {
    const assets = scatterAssets();
    const scene = makeScene(assets);
    scene.addSector(sector());
    scene.tick(0.016);

    const instanced = scatterGroups(scene)[0]!.children[0] as THREE.InstancedMesh;
    const placed = new THREE.Box3().setFromObject(assets.prototype);
    instanced.geometry.computeBoundingBox();
    const box = instanced.geometry.boundingBox!;
    expect(box.min.toArray().map((value) => value.toFixed(6))).toEqual(placed.min.toArray().map((value) => value.toFixed(6)));
    expect(box.max.toArray().map((value) => value.toFixed(6))).toEqual(placed.max.toArray().map((value) => value.toFixed(6)));
  });

  it('frees its clones and instance buffers with its sector, and leaves the prototype alone', () => {
    const assets = scatterAssets();
    const scene = makeScene(assets);
    scene.addSector(sector());
    scene.tick(0.016);
    const meshes = scatterGroups(scene)[0]!.children as THREE.InstancedMesh[];
    const disposes = meshes.flatMap((mesh) => [vi.spyOn(mesh.geometry, 'dispose'), vi.spyOn(mesh, 'dispose')]);
    const prototypeGeometry = (assets.prototype.children[0]!.children[0] as THREE.Mesh).geometry;
    const prototypeDispose = vi.spyOn(prototypeGeometry, 'dispose');

    scene.removeSector('EdariaSquare');

    for (const spy of disposes) expect(spy).toHaveBeenCalled();
    expect(prototypeDispose).not.toHaveBeenCalled();
    expect(prototypeGeometry.getAttribute('position')).toBeDefined();
    expect(scatterGroups(scene)).toEqual([]);
  });

  it('grows again away from a moved placement without rasterizing either ground again', () => {
    const held = heldJobs(rasterizeGround);
    const scene = makeScene(scatterAssets(), undefined, { rasterize: held.run });
    const west = outdoorSector('West', { x: 0, z: 0 });
    const east = outdoorSector('East', { x: 20, z: 0 });
    scene.addSector(west);
    scene.addSector(east);
    scene.tick(0.016);
    held.release();
    scene.tick(0.016);
    scene.tick(0.016);
    expect(instancesNear(scatterGroups(scene)[0]!, { x: 10, z: 10 }, 0.4)).toBeGreaterThan(0);

    scene.addSector({ ...west, placements: [placement('box-1', 'box', { x: 10, z: 10 })] });
    scene.tick(0.016);
    scene.tick(0.016);

    expect(held.jobs).toEqual([]);
    const westGroup = scatterGroups(scene).find((group) => instancesNear(group, { x: 5, z: 5 }, 5) > 0)!;
    expect(instancesNear(westGroup, { x: 10, z: 10 }, 0.4)).toBe(0);
  });

  it("keeps off a neighbour's placement whose footprint crosses the border, and off a neighbour's door moved with its placement", () => {
    const scene = makeScene(scatterAssets());
    const west = outdoorSector('West', { x: 0, z: 0 });
    scene.addSector(west);
    scene.addSector(outdoorSector('East', { x: 20, z: 0 }, { placements: [placement('box-1', 'box', { x: 0.2, z: 5 })] }));
    scene.tick(0.016);
    const westGroup = (): THREE.Object3D => scatterGroups(scene).find((group) => instancesNear(group, { x: 5, z: 5 }, 5) > 0)!;
    expect(instancesNear(westGroup(), { x: 19.6, z: 5 }, 0.3)).toBe(0);

    const doorAt = (x: number): SectorView =>
      outdoorSector(
        'East',
        { x: 20, z: 0 },
        {
          placements: [placement('door-1', 'door', { x, z: 10, yaw: 90 })],
          doors: [{ id: 'in', placement: 'door-1', anchor: 'main', target: { sector: 'Room', door: 'out' } }],
        },
      );
    scene.addSector(doorAt(5));
    scene.tick(0.016);
    expect(instancesNear(westGroup(), { x: 19.7, z: 10 }, 0.3)).toBeGreaterThan(0);
    scene.addSector(doorAt(0.3));
    scene.tick(0.016);
    expect(instancesNear(westGroup(), { x: 19.7, z: 10 }, 0.3)).toBe(0);
  });

  it('grows on a sector drawn before its models were cached once they are', async () => {
    const assets = scatterAssets();
    let cached = false;
    const scene = makeScene({ ...assets, prototypeMeshes: (id) => (cached ? assets.prototypeMeshes(id) : undefined) });
    scene.addSector(sector());
    scene.tick(0.016);
    expect(scatterGroups(scene)).toEqual([]);

    cached = true;
    await scene.prewarm();
    scene.tick(0.016);

    expect(scatterGroups(scene)).toHaveLength(1);
  });

  it('bends the grass a foot on the ground touches, and none for a foot lifted 0.2 m', () => {
    for (const [height, bends] of [
      [0, true],
      [0.2, false],
    ] as const) {
      const assets = scatterAssets();
      const scene = makeScene({ ...assets, character: () => footed(height) });
      scene.addSector(sector());
      scene.tick(0.016);
      const group = scatterGroups(scene)[0]!;
      const matrix = new THREE.Matrix4();
      (group.children[0] as THREE.InstancedMesh).getMatrixAt(0, matrix);
      const root = new THREE.Vector3().setFromMatrixPosition(matrix);
      scene.placeEntity(player({ id: 'peer-1', kind: 'peer', position: { x: root.x + 0.02, z: root.z } }));
      for (let frame = 0; frame < 10; frame += 1) scene.tick(1 / 60);
      const bent = tilts(group).some((attribute) => [...(attribute.array as Float32Array)].some((value) => Math.abs(value) > 0.1));
      expect(bent, `foot at ${height} m`).toBe(bends);
    }
  });

  /** A scene grown with grass, and the root of its first tuft, whose lean `tilt` reads. */
  function grown(assets: Partial<ModelAssets>): { scene: WorldScene; root: THREE.Vector3; tilt: () => number; bent: () => boolean } {
    const scene = makeScene({ ...scatterAssets(), ...assets });
    scene.addSector(sector());
    scene.tick(0.016);
    const group = scatterGroups(scene)[0]!;
    const first = group.children[0] as THREE.InstancedMesh;
    const matrix = new THREE.Matrix4();
    first.getMatrixAt(0, matrix);
    const array = first.geometry.getAttribute('aTilt').array as Float32Array;
    return {
      scene,
      root: new THREE.Vector3().setFromMatrixPosition(matrix),
      tilt: () => Math.hypot(array[0]!, array[1]!),
      bent: () => tilts(group).some((attribute) => [...(attribute.array as Float32Array)].some((value) => Math.abs(value) > 0.1)),
    };
  }

  it('bends the grass a held sword hanging into it passes through, and none for one held above it', () => {
    for (const [handHeight, bends] of [
      [0.5, true],
      [1.5, false],
    ] as const) {
      // A foot lifted clear of the grass, so only the sword can bend it.
      const model = footed(0.2);
      const hand = Object.assign(new THREE.Bone(), { name: 'handslotr' });
      hand.position.y = handHeight / CHARACTER_SCALE;
      model.add(hand);
      const sword = (): THREE.Object3D => new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.6, 0.04).translate(0, -0.3, 0));
      const { scene, root, bent } = grown({ character: () => model, hand: sword });
      scene.placeEntity(player({ id: 'peer-1', kind: 'peer', position: { x: root.x + 0.02, z: root.z }, outfit: outfit({ mainHand: 'sword' }) }));
      for (let frame = 0; frame < 10; frame += 1) scene.tick(1 / 60);
      expect(bent(), `hand at ${handHeight} m`).toBe(bends);
    }
  });

  /** A dagger as its ground model lies: low and long. */
  const lyingDagger = (): THREE.Object3D => new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.05, 0.1).translate(0, 0.025, 0));
  const dagger = (lootId: string, at: { x: number; z: number }, overrides: Partial<LootMessage> = {}): LootMessage => ({
    lootId,
    x: at.x,
    z: at.z,
    contents: { kind: 'item', baseId: 'dagger', tier: 1, rarity: 'common' },
    ...overrides,
  });

  it('presses the grass under a lying drop flat, and lets it spring back as the drop starts to fade', () => {
    const { scene, root, tilt } = grown({ ground: lyingDagger });
    scene.showLoot(dagger('loot-1', root));
    for (let frame = 0; frame < 30; frame += 1) scene.tick(1 / 60);
    expect(tilt()).toBeGreaterThan(1.45);

    scene.removeLoot('loot-1', false);
    // Half way through the fade, the drop still drawn.
    for (let frame = 0; frame < 15; frame += 1) scene.tick(1 / 60);
    expect(tilt()).toBeLessThan(1);
    for (let frame = 0; frame < 165; frame += 1) scene.tick(1 / 60);
    expect(tilt()).toBeLessThan(0.05);
  });

  /** A trophy as its ground model lies: low and round, as wide as it is long. */
  const lyingWisp = (): THREE.Object3D => new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.05, 0.3).translate(0, 0.025, 0));
  const wisp = (lootId: string, at: { x: number; z: number }): LootMessage => ({
    lootId,
    x: at.x,
    z: at.z,
    contents: { kind: 'trophy', monsterKind: 'ghost' },
  });

  it("presses the grass under a trophy lying as its kind's model flat", () => {
    const { scene, root, tilt } = grown({ trophy: (monsterKind) => (monsterKind === 'ghost' ? lyingWisp() : undefined) });
    scene.showLoot(wisp('wisp', root));
    for (let frame = 0; frame < 30; frame += 1) scene.tick(1 / 60);
    expect(tilt()).toBeGreaterThan(1.45);
  });

  /** Another kind's trophy as its ground model lies: low, round, and wider than a wisp. */
  const lyingFang = (): THREE.Object3D => new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 0.5).translate(0, 0.025, 0));

  /** A tunic as its design lies at the tier: low and square, a further tier's wider. */
  const lyingTunic = (tier: number): THREE.Object3D => new THREE.Mesh(new THREE.BoxGeometry(0.2 * tier, 0.05, 0.2 * tier).translate(0, 0.025, 0));

  /**
   * Each lying model is measured under its own key, an item's apart from a trophy's, one kind's
   * trophy apart from another's, and one tier's design apart from another's, so none takes another's reach.
   */
  it("presses the grass by each lying model's own reach, a dagger, two kinds of trophy, and a tunic at two tiers at once", () => {
    const { scene } = grown({
      ground: (baseId, tier) => (baseId === 'tunic' ? lyingTunic(tier) : lyingDagger()),
      trophy: (monsterKind) => (monsterKind === 'wolf' ? lyingFang() : lyingWisp()),
    });
    scene.showLoot(dagger('dagger', { x: 2, z: 4 }));
    scene.showLoot(wisp('wisp', { x: 5, z: 4 }));
    scene.showLoot({ ...wisp('fang', { x: 8, z: 4 }), contents: { kind: 'trophy', monsterKind: 'wolf' } });
    scene.showLoot(dagger('tunic', { x: 11, z: 4 }, { contents: { kind: 'item', baseId: 'tunic', tier: 1, rarity: 'common' } }));
    scene.showLoot(dagger('raincoat', { x: 14, z: 4 }, { contents: { kind: 'item', baseId: 'tunic', tier: 3, rarity: 'common' } }));
    const step = vi.spyOn(GrassSpring.prototype, 'step');
    scene.tick(1 / 60);
    const [contacts] = step.mock.calls[0]!;
    step.mockRestore();
    expect(contacts.map(({ x, radius }) => ({ x: Math.round(x), radius }))).toEqual([
      { x: 2, radius: expect.closeTo(0.05, 6) },
      { x: 5, radius: expect.closeTo(0.15, 6) },
      { x: 8, radius: expect.closeTo(0.25, 6) },
      { x: 11, radius: expect.closeTo(0.1, 6) },
      { x: 14, radius: expect.closeTo(0.3, 6) },
    ]);
  });

  it('presses nothing with a drop in the air, until it lands', () => {
    const { scene, root, tilt } = grown({ ground: lyingDagger });
    scene.showLoot(dagger('loot-1', root, { from: { x: root.x + 1, z: root.z } }));
    for (let frame = 0; frame < 24; frame += 1) scene.tick(1 / 60);
    expect(tilt()).toBe(0);

    for (let frame = 0; frame < 30; frame += 1) scene.tick(1 / 60);
    expect(tilt()).toBeGreaterThan(1);
  });

  it('presses the grass flat as a thrown drop touches down, while it still hops, as an impact does', () => {
    const { scene, root, tilt } = grown({ ground: lyingDagger });
    scene.showLoot(dagger('loot-1', root, { from: { x: root.x + 1, z: root.z } }));
    // Still in the air at 38 frames of a nightmare's 0.65 s burst.
    for (let frame = 0; frame < 38; frame += 1) scene.tick(1 / 60);
    expect(tilt()).toBe(0);

    // Four frames later it is down and hopping, and the grass under it already lies flat.
    for (let frame = 0; frame < 4; frame += 1) scene.tick(1 / 60);
    expect(tilt()).toBeGreaterThan(1.2);
  });

  it('touches the grass once for each held item and each drop drawn, however many lie', () => {
    const model = footed(0.2);
    model.add(Object.assign(new THREE.Bone(), { name: 'handslotr' }), Object.assign(new THREE.Bone(), { name: 'handslotl' }));
    const { scene, root } = grown({ ground: lyingDagger, character: () => model, hand: () => new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1)) });
    scene.placeEntity(player({ id: 'peer-1', kind: 'peer', position: { x: root.x, z: root.z }, outfit: outfit({ mainHand: 'sword', offHand: 'shield' }) }));
    for (let index = 0; index <= LOOT_MARKER_POOL_SIZE; index += 1) scene.showLoot(dagger(`loot-${index}`, { x: 2 + index, z: 4 }));
    const step = vi.spyOn(GrassSpring.prototype, 'step');
    scene.tick(1 / 60);
    const [contacts] = step.mock.calls[0]!;
    step.mockRestore();
    expect(contacts).toHaveLength(2 + LOOT_MARKER_POOL_SIZE);
  });
});

describe('GPU resource disposal', () => {
  it.each([
    ['its sector leaves the draw set', (scene: WorldScene) => scene.removeSector('EdariaSquare')],
    [
      'the next space is revealed',
      (scene: WorldScene) => {
        scene.enterSpace(world('EdariaInn'));
        scene.placeEntity(player());
      },
    ],
    ['the splash takes the space down', (scene: WorldScene) => scene.showSplash()],
  ])('disposes the ground and its weight textures when %s', (_name, leave) => {
    const scene = makeScene();
    scene.addSector(sector());
    scene.tick(0.016);

    const [ground] = groundMeshes(scene);
    const disposes = [ground!.geometry, ground!.material as THREE.Material, ...weightTextures(ground!)].map((resource) => vi.spyOn(resource, 'dispose'));

    leave(scene);

    for (const spy of disposes) expect(spy).toHaveBeenCalled();
  });

  it('leaves a cached model geometry and material alone when its holder is dropped', () => {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshBasicMaterial();
    const geometryDispose = vi.spyOn(geometry, 'dispose');
    const materialDispose = vi.spyOn(material, 'dispose');
    const scene = makeScene({ ...emptyAssets(), object: () => new THREE.Mesh(geometry, material) });
    scene.addSector(sector({ placements: [placement('box-1', 'box')] }));
    expect(scene._placeholderObjectCount()).toBe(0);

    scene.removeSector('EdariaSquare');

    // `SkeletonUtils.clone` shares both with the prototype, so disposing either would blank every
    // other instance built from the same cache entry.
    expect(geometryDispose).not.toHaveBeenCalled();
    expect(materialDispose).not.toHaveBeenCalled();
  });

  /**
   * The one GPU resource a model clone *does* own. `SkeletonUtils.clone` gives each clone its own
   * `Skeleton`, and `WebGLRenderer` allocates a per-`Skeleton` bone texture that nothing in three.js
   * reclaims — there is no `FinalizationRegistry`, so GC of the wrapper leaks the GL texture.
   */
  it('disposes a cloned skeleton when its entity leaves', () => {
    const { root, skeleton } = skinnedModel();
    const skeletonDispose = vi.spyOn(skeleton, 'dispose');
    const scene = makeScene({ ...emptyAssets(), character: () => root });
    scene.placeEntity(player());

    scene.removeEntity('self');

    expect(skeletonDispose).toHaveBeenCalled();
  });

  it('disposes a cloned skeleton when the splash takes the space down', () => {
    const { root, skeleton } = skinnedModel();
    const skeletonDispose = vi.spyOn(skeleton, 'dispose');
    const scene = makeScene({ ...emptyAssets(), character: () => root });
    scene.placeEntity(player());

    scene.showSplash();

    expect(skeletonDispose).toHaveBeenCalled();
  });

  /** An entity of the space being left hangs off the parked root, so the reveal is what frees it. */
  it('disposes a cloned skeleton of the held space once the new one is revealed', () => {
    const { root, skeleton } = skinnedModel();
    const skeletonDispose = vi.spyOn(skeleton, 'dispose');
    let handedOut = false;
    const scene = makeScene({
      ...emptyAssets(),
      character: () => {
        if (handedOut) return undefined;
        handedOut = true;
        return root;
      },
    });
    scene.placeEntity(player());

    scene.enterSpace(world('EdariaInn'));
    expect(skeletonDispose).not.toHaveBeenCalled();

    scene.placeEntity(player());
    expect(skeletonDispose).toHaveBeenCalled();
  });
});

describe('a nightmare fading out', () => {
  /**
   * Two Ghosts cloned from one prototype, as the pack hands them out: each clone shares the
   * prototype's material and its map. The wall clock runs on with each tick, and `hide` moves it on
   * with no tick, as a hidden tab's does.
   */
  function haunted(reducedMotion = false) {
    const prototype = skinnedModel().root;
    const material = new THREE.MeshStandardMaterial({ map: new THREE.DataTexture() });
    (prototype.children[0] as THREE.SkinnedMesh).material = material;
    const models: THREE.Object3D[] = [];
    let wallMs = 0;
    const scene = new WorldScene(
      {
        ...emptyAssets(),
        character: () => {
          const model = cloneSkinned(prototype);
          models.push(model);
          return model;
        },
      },
      TEST_REGISTRY,
      1,
      reducedMotion,
      () => wallMs,
    );
    const tick = (seconds: number): void => {
      for (let elapsed = 0; elapsed < seconds - 1e-9; elapsed += 0.05) {
        wallMs += 50;
        scene.tick(0.05);
      }
    };
    scene.placeEntity(player({ id: 'monster:1', kind: 'monster', name: 'Ghost', characterModelId: 'ghost', condition: 'fallen' }));
    scene.placeEntity(player({ id: 'monster:2', kind: 'monster', name: 'Ghost', characterModelId: 'ghost', position: { x: 12, z: 10 } }));
    tick(0.05);
    const meshOf = (model: THREE.Object3D): THREE.SkinnedMesh => model.children[0] as THREE.SkinnedMesh;
    return { scene, material, models, meshOf, tick, hide: (ms: number) => (wallMs += ms) };
  }

  const inScene = (scene: WorldScene, model: THREE.Object3D): boolean => scene.scene.getObjectById(model.id) !== undefined;

  it('fades its body to clear where it lies over the seconds, leaving every other body of its kind as it is, and is then gone', () => {
    const { scene, material, models, meshOf, tick } = haunted();
    scene.fadeEntity('monster:1');
    const clone = meshOf(models[0]!).material as THREE.MeshStandardMaterial;
    const cloneDispose = vi.spyOn(clone, 'dispose');
    expect(clone).not.toBe(material);
    expect(clone.transparent).toBe(true);
    expect(clone.map).toBe(material.map);

    const opacities: number[] = [];
    while (opacities.length < 28) {
      tick(0.05);
      opacities.push(clone.opacity);
      expect([material.transparent, material.opacity]).toEqual([false, 1]);
    }
    expect(inScene(scene, models[0]!)).toBe(true);
    expect(opacities.every((opacity, index) => opacity < (opacities[index - 1] ?? 1))).toBe(true);
    expect(clone.opacity).toBeGreaterThan(0);
    expect(clone.opacity).toBeLessThan(1);
    expect(meshOf(models[1]!).material).toBe(material);

    tick(0.2);
    expect(inScene(scene, models[0]!)).toBe(false);
    expect(cloneDispose).toHaveBeenCalled();
    expect([material.transparent, material.opacity]).toEqual([false, 1]);
    expect(meshOf(models[1]!).material).toBe(material);
  });

  it('takes the body at once under reduced motion', () => {
    const { scene, material, models, meshOf } = haunted(true);
    scene.fadeEntity('monster:1');
    expect(inScene(scene, models[0]!)).toBe(false);
    expect(meshOf(models[0]!).material).toBe(material);
  });

  it('takes the body on the tick a stall ends', () => {
    const { scene, models, meshOf, tick, hide } = haunted();
    scene.fadeEntity('monster:1');
    tick(0.5);
    const cloneDispose = vi.spyOn(meshOf(models[0]!).material as THREE.Material, 'dispose');
    hide(2000);
    scene.tick(0.01);
    expect(inScene(scene, models[0]!)).toBe(false);
    expect(cloneDispose).toHaveBeenCalled();
  });

  it("disposes its clones as a new space starts, and leaves the prototype's material and map", () => {
    const { scene, material, models, meshOf, tick } = haunted();
    scene.fadeEntity('monster:1');
    tick(0.5);
    const cloneDispose = vi.spyOn(meshOf(models[0]!).material as THREE.Material, 'dispose');
    const materialDispose = vi.spyOn(material, 'dispose');
    const mapDispose = vi.spyOn(material.map!, 'dispose');

    scene.enterSpace(world('EdariaInn'));

    expect(cloneDispose).toHaveBeenCalled();
    expect(inScene(scene, models[0]!)).toBe(false);
    expect(materialDispose).not.toHaveBeenCalled();
    expect(mapDispose).not.toHaveBeenCalled();
  });

  it('takes a crumbling body as well as a fading one as a new space starts', () => {
    const { scene, models, tick } = haunted();
    const height = (model: THREE.Object3D): number => model.getWorldPosition(new THREE.Vector3()).y;
    const standing = height(models[1]!);
    scene.fadeEntity('monster:1');
    scene.crumbleEntity('monster:2');
    tick(0.3);
    expect(models.map((model) => inScene(scene, model))).toEqual([true, true]);
    const sunk = height(models[1]!);
    expect(sunk).toBeLessThan(standing);

    scene.enterSpace(world('EdariaInn'));

    expect(models.map((model) => inScene(scene, model))).toEqual([false, false]);
    tick(0.3);
    expect(height(models[1]!)).toBe(sunk);
  });

  it.each([
    ['fades', (scene: WorldScene) => scene.fadeEntity('monster:1')],
    ['crumbles', (scene: WorldScene) => scene.crumbleEntity('monster:1')],
  ] as const)('takes the portrait off the body of a target that %s as it leaves', (_label, depart) => {
    const { scene, models, tick } = haunted();
    const layersOf = (model: THREE.Object3D): boolean[] => {
      const enabled: boolean[] = [];
      model.traverse((object) => enabled.push(...Object.values(PORTRAIT_LAYERS).map((layer) => object.layers.isEnabled(layer))));
      return enabled;
    };
    scene.setPortraitSubject('target', 'monster:1');
    expect(models[0]!.layers.isEnabled(PORTRAIT_LAYERS.target)).toBe(true);

    depart(scene);
    tick(0.1);

    expect(inScene(scene, models[0]!)).toBe(true);
    expect(layersOf(models[0]!).some(Boolean)).toBe(false);
  });
});

describe('speech bubbles leave as they are replaced and expire', () => {
  function sceneWithEntity(now?: () => number): WorldScene {
    const scene = makeScene(emptyAssets(), now);
    scene.placeEntity(player());
    return scene;
  }

  function lines(scene: WorldScene): string[] {
    return scene.placedBubbles().bubbles.map((bubble) => bubble.lines[0]!);
  }

  it('keeps one bubble per speaker, and drops it when it runs out or its speaker leaves', () => {
    let nowMs = 0;
    const scene = sceneWithEntity(() => nowMs);
    scene.placeEntity(player({ id: 'peer', kind: 'peer', position: { x: 12, z: 10 } }));
    scene.showSpeechBubble(said('self', ['first'], 5000));
    scene.showSpeechBubble(said('self', ['second'], 1000));
    scene.showSpeechBubble(said('peer', ['mid-sentence'], 5000));
    expect(lines(scene)).toEqual(['second', 'mid-sentence']);

    nowMs = 1000;
    scene.tick(MAX_TICK_DELTA);
    expect(lines(scene)).toEqual(['mid-sentence']);

    scene.removeEntity('peer');
    scene.tick(MAX_TICK_DELTA);
    expect(lines(scene)).toEqual([]);
  });

  it('runs a bubble out on the clock however few frames were drawn, counting from when it was said', () => {
    let nowMs = 0;
    const scene = sceneWithEntity(() => nowMs);
    scene.placeEntity(player({ id: 'peer', kind: 'peer' }));
    scene.showSpeechBubble(said('self', ['before the tab was hidden'], 3000));
    scene.tick(MAX_TICK_DELTA);

    nowMs = 60_000;
    scene.showSpeechBubble(said('peer', ['while it was hidden'], 3000));
    nowMs = 61_000;
    scene.tick(0);

    expect(lines(scene)).toEqual(['while it was hidden']);
  });

  /** A carried bubble whose time ran out on the way through the door. */
  it('shows nothing for a line with no time left', () => {
    const scene = sceneWithEntity();

    expect(scene.showSpeechBubble(said('self', ['too late'], 0))).toBe(false);

    expect(lines(scene)).toEqual([]);
  });

  /** Placed around a bubble that has run out but was not yet swept, the new one would be pushed off its own head. */
  it('places a line around the bubbles still showing, not one that ran out without a frame drawn', () => {
    let nowMs = 0;
    const scene = sceneWithEntity(() => nowMs);
    scene.placeEntity(player({ id: 'bren', kind: 'peer', position: { x: 12, z: 10 } }));
    scene.placeEntity(player({ id: 'cara', kind: 'peer', position: { x: 12, z: 10 } }));
    scene.showSpeechBubble(said('bren', ['Hallo'], 1000));
    const over = bubbleSaying(scene, 'Hallo')!.centre;

    nowMs = 5000;
    scene.showSpeechBubble(said('cara', ['Tschüss'], 3000));

    expect(lines(scene)).toEqual(['Tschüss']);
    expect(bubbleSaying(scene, 'Tschüss')!.centre.x).toBeCloseTo(over.x, 9);
    expect(bubbleSaying(scene, 'Tschüss')!.centre.y).toBeCloseTo(over.y, 9);
  });
});

describe('the fallen a Mystic senses', () => {
  function sensing(): WorldScene {
    const scene = makeScene();
    scene.placeEntity(player());
    scene.setViewportSize(800, 800);
    return scene;
  }

  it('marks none lying on screen, and pins a marker toward each lying off it, inside the screen', () => {
    const scene = sensing();
    scene.showSensed([
      { name: 'Ida', x: 11, z: 10 },
      { name: 'Mira', x: 40, z: 10 },
    ]);
    const { halfSize, markers } = scene.placedMarkers();
    expect(markers.map(({ name }) => name)).toEqual(['Mira']);
    const [marker] = markers;
    const toward = screenOf(scene, new THREE.Vector3(40, 0, 10));
    expect(Math.atan2(marker!.centre.y, marker!.centre.x)).toBeCloseTo(Math.atan2(toward.y, toward.x), 6);
    expect(marker!.toward).toBeCloseTo(Math.atan2(toward.y - marker!.centre.y, toward.x - marker!.centre.x), 9);
    expect(Math.abs(marker!.centre.x)).toBeLessThan(halfSize.x);
    expect(Math.max(Math.abs(marker!.centre.x) / halfSize.x, Math.abs(marker!.centre.y) / halfSize.y)).toBeGreaterThan(0.5);
  });

  it('keeps a marker clear of what covers the screen, and a voice pinned the same way clear of the marker', () => {
    const scene = sensing();
    scene.showSensed([{ name: 'Mira', x: 40, z: 10 }]);
    const open = scene.placedMarkers().markers[0]!.centre;
    const { halfSize } = scene.placedMarkers();
    const panel = { left: open.x - 0.3, bottom: open.y - 0.3, right: open.x + 0.3, top: open.y + 0.3 };
    scene.setScreenOccluders([
      { left: panel.left / halfSize.x, bottom: panel.bottom / halfSize.y, right: panel.right / halfSize.x, top: panel.top / halfSize.y },
    ]);
    scene.showSpeechBubble(voiced('bren', ['Hallo'], { x: 40, z: 10 }));
    scene.tick(MAX_TICK_DELTA);

    const marker = scene.placedMarkers().markers[0]!.centre;
    expect(Math.hypot(marker.x - open.x, marker.y - open.y)).toBeGreaterThan(0.3);
    const bubble = bubbleSaying(scene, 'Hallo')!;
    expect(Math.hypot(bubble.centre.x - marker.x, bubble.centre.y - marker.y)).toBeGreaterThan(0.3);
  });

  it('marks nothing in a new space until the server says again', () => {
    const scene = sensing();
    scene.showSensed([{ name: 'Mira', x: 40, z: 10 }]);
    scene.enterSpace(world('Hall'));
    expect(scene.placedMarkers().markers).toEqual([]);
  });
});

describe('speech bubbles hang round a head on screen and are pinned at the edge otherwise', () => {
  /** A line as wide as a bubble gets. */
  const LONG = 'Hallo Welt, wie geht es dir heute?';

  /** The player at (10, 10), and a peer `x` metres along. */
  function sceneWithPeer(x: number, aspect = 1, now?: () => number): WorldScene {
    const scene = new WorldScene(emptyAssets(), TEST_REGISTRY, aspect, false, now);
    scene.placeEntity(player());
    scene.placeEntity(player({ id: 'peer', kind: 'peer', position: { x, z: 10 } }));
    return scene;
  }

  function bodyOf(bubble: PlacedBubble): { left: number; bottom: number; right: number; top: number } {
    const { centre, size } = bubble;
    return { left: centre.x - size.width / 2, bottom: centre.y - size.height / 2, right: centre.x + size.width / 2, top: centre.y + size.height / 2 };
  }

  function insideScreen(scene: WorldScene, bubble: PlacedBubble): boolean {
    const { halfSize } = scene.placedBubbles();
    const body = bodyOf(bubble);
    return body.left >= -halfSize.x && body.right <= halfSize.x && body.bottom >= -halfSize.y && body.top <= halfSize.y;
  }

  /** Runs the scene long enough for every bubble to settle where it is going. */
  function settle(scene: WorldScene): void {
    for (let frame = 0; frame < 20; frame += 1) scene.tick(MAX_TICK_DELTA);
  }

  it('hangs the bubble of a speaker on screen over their head', () => {
    const scene = sceneWithPeer(11);

    expect(scene.showSpeechBubble(said('peer', ['Hallo'], 3000))).toBe(false);

    const bubble = bubbleSaying(scene, 'Hallo')!;
    const head = screenOf(scene, new THREE.Vector3(11, CHARACTER_SCALE, 10));
    expect(bubble.mode).toBe('anchored');
    expect(bubble.centre.x).toBeCloseTo(head.x, 9);
    expect(bodyOf(bubble).bottom).toBeGreaterThan(head.y);
  });

  /** It looks for the spot round the head afresh rather than keeping the offset it had while pinned. */
  it('pins the bubble of a speaker off screen at the edge, and hangs it on their head once they walk into view', () => {
    const scene = sceneWithPeer(40);

    expect(scene.showSpeechBubble(said('peer', ['Hallo'], 3000))).toBe(true);

    const pinned = bubbleSaying(scene, 'Hallo')!;
    const { halfSize } = scene.placedBubbles();
    expect(pinned.mode).toBe('pinned');
    expect(Math.max(Math.abs(pinned.centre.x) / halfSize.x, Math.abs(pinned.centre.y) / halfSize.y)).toBeGreaterThan(0.5);
    expect(insideScreen(scene, pinned)).toBe(true);

    scene.updatePosition('peer', { x: 11, z: 10 }, 0, undefined);
    scene.tick(MAX_TICK_DELTA);
    expect(bubbleSaying(scene, 'Hallo')!.mode).toBe('anchored');
    settle(scene);
    expect(bubbleSaying(scene, 'Hallo')!.centre.x).toBeCloseTo(screenOf(scene, new THREE.Vector3(11, CHARACTER_SCALE, 10)).x, 6);
  });

  /** The camera is turned 35 degrees, so a voice due east is not drawn straight to the right. */
  it('pins a voice with no body toward where its source is drawn', () => {
    const scene = sceneWithPeer(11);
    const source = { x: 40, z: 10 };

    expect(scene.showSpeechBubble(voiced('bren', ['Hallo'], source))).toBe(true);

    const toward = screenOf(scene, new THREE.Vector3(source.x, 0, source.z));
    const pinned = bubbleSaying(scene, 'Hallo')!.centre;
    expect(Math.abs(toward.y)).toBeGreaterThan(0.1);
    expect(Math.atan2(pinned.y, pinned.x)).toBeCloseTo(Math.atan2(toward.y, toward.x), 6);
  });

  /** Zoomed in all the way in a window 160 px tall, four lines held at their smallest readable size are taller than the screen above the player's head. */
  it("hangs the player's own bubble beside their head when the screen has no room above it", () => {
    const scene = sceneWithPeer(11);
    scene.applyZoomFactor(1.4);
    scene.setViewportSize(160, 160);

    expect(scene.showSpeechBubble(said('self', ['one', 'two', 'three', 'four'], 3000))).toBe(false);

    const bubble = bubbleSaying(scene, 'one')!;
    expect(bubble.mode).toBe('anchored');
    expect(insideScreen(scene, bubble)).toBe(true);
  });

  /** 6.3 m across the screen is drawn 0.9 of the way to its edge. */
  it.each([1, -1])('slides the bubble of a speaker drawn near the screen edge on side %i inward', (side) => {
    const yaw = (ORTHO_RIG.yawDegrees * Math.PI) / 180;
    const across = { x: 10 + side * 6.3 * Math.cos(yaw), z: 10 - side * 6.3 * Math.sin(yaw) };
    const scene = makeScene();
    scene.placeEntity(player());
    scene.placeEntity(player({ id: 'peer', kind: 'peer', position: across }));
    const feet = screenOf(scene, new THREE.Vector3(across.x, 0, across.z));
    expect((side * feet.x) / scene.placedBubbles().halfSize.x).toBeCloseTo(0.9, 6);

    expect(scene.showSpeechBubble(said('peer', [LONG], 3000))).toBe(false);

    const bubble = bubbleSaying(scene, LONG)!;
    expect(bubble.mode).toBe('anchored');
    expect(insideScreen(scene, bubble)).toBe(true);
  });

  /** A 160 x 1000 window shows 2.24 m across, narrower than the 2.4 m of a full bubble. */
  it('keeps the bubble of a speaker beside the player overhead in a window narrower than a bubble', () => {
    const scene = sceneWithPeer(10.5, 0.16);
    expect(speechBubbleFrameSize([LONG], 'say').width * 0.016).toBeGreaterThan(2 * scene.placedBubbles().halfSize.x);

    expect(scene.showSpeechBubble(said('peer', [LONG], 3000))).toBe(false);

    expect(bubbleSaying(scene, LONG)!.mode).toBe('anchored');
  });

  /** Outdoors a voice with no body hangs its bubble over its spot at doorway height, on the building over a door. */
  it('hangs the bubble of a voice through a door over the doorway when it is on screen', () => {
    const scene = sceneWithPeer(11);

    expect(scene.showSpeechBubble(voiced('bren', ['Hilfe!'], { x: 11, z: 9 }, { kind: 'yell' }))).toBe(false);

    const bubble = bubbleSaying(scene, 'Hilfe!')!;
    const doorway = screenOf(scene, new THREE.Vector3(11, 2.2, 9));
    expect(bubble.mode).toBe('anchored');
    expect(bubble.centre.x).toBeCloseTo(doorway.x, 9);
    expect(bodyOf(bubble).bottom).toBeGreaterThan(doorway.y);
    expect(bubble.tail!.y).toBeCloseTo(doorway.y, 9);
  });

  it('keeps a bubble clear of what covers the screen over its speaker', () => {
    const scene = sceneWithPeer(11);
    const head = screenOf(scene, new THREE.Vector3(11, CHARACTER_SCALE, 10));
    const { halfSize } = scene.placedBubbles();
    const panel = { left: head.x - 0.6, bottom: head.y + 0.05, right: head.x + 0.6, top: head.y + 1 };
    scene.setScreenOccluders([
      { left: panel.left / halfSize.x, bottom: panel.bottom / halfSize.y, right: panel.right / halfSize.x, top: panel.top / halfSize.y },
    ]);

    expect(scene.showSpeechBubble(said('peer', ['Hallo'], 3000))).toBe(false);

    const body = bodyOf(bubbleSaying(scene, 'Hallo')!);
    expect(body.left >= panel.right || body.right <= panel.left || body.bottom >= panel.top || body.top <= panel.bottom).toBe(true);
  });

  it('keeps the bubbles of two speakers standing together apart', () => {
    const scene = sceneWithPeer(12);
    scene.placeEntity(player({ id: 'bren', kind: 'peer', position: { x: 12, z: 10 } }));

    scene.showSpeechBubble(said('peer', ['Hallo'], 3000));
    scene.showSpeechBubble(said('bren', ['Wer kommt mit?'], 3000));
    settle(scene);

    const first = bodyOf(bubbleSaying(scene, 'Hallo')!);
    const second = bodyOf(bubbleSaying(scene, 'Wer kommt mit?')!);
    expect(first.left >= second.right || first.right <= second.left || first.bottom >= second.top || first.top <= second.bottom).toBe(true);
  });

  describe('in a room', () => {
    /** The player in the middle of a 10 x 10 m room, zoomed by `zoom`, in a window `aspect` times as wide as it is tall. */
    function roomScene(zoom: number, aspect = 1): WorldScene {
      const scene = new WorldScene(emptyAssets(), TEST_REGISTRY, aspect, false);
      const entered = world('Hall');
      scene.enterSpace(entered);
      const room = interiorSector('Hall');
      entered.addSector(room);
      scene.addSector(room);
      scene.placeEntity(player({ position: { x: 5, z: 5 } }));
      scene.applyZoomFactor(zoom);
      return scene;
    }

    it('shows a voice from the door just past the wall, in the dark, with its tail toward the wall', () => {
      const scene = roomScene(0.78);

      expect(scene.showSpeechBubble(voiced('bren', ['Hilfe!'], { x: 5, z: 0 }, { kind: 'yell' }))).toBe(false);

      const bubble = bubbleSaying(scene, 'Hilfe!')!;
      expect(bubble.mode).toBe('fixed');
      expect(bodyOf(bubble).bottom).toBeGreaterThan(screenOf(scene, new THREE.Vector3(5, 1.728, 0)).y);
      expect(insideScreen(scene, bubble)).toBe(true);
      expect(bubble.tail!.y).toBeLessThan(bodyOf(bubble).bottom);
    });

    /** A side wall leaves room for a bubble beside it only in a wide window. */
    it.each([
      [{ x: 10, z: 5 }, 'east'],
      [{ x: 0, z: 5 }, 'west'],
      [{ x: 5, z: 10 }, 'south'],
    ] as const)('points the tail of a voice from the door at %j back toward its %s wall', (source, _wall) => {
      const scene = roomScene(0.78, 2);

      expect(scene.showSpeechBubble(voiced('bren', ['Hilfe!'], source))).toBe(false);

      const bubble = bubbleSaying(scene, 'Hilfe!')!;
      const body = bodyOf(bubble);
      const tail = bubble.tail!;
      const wall = screenOf(scene, new THREE.Vector3(source.x, 1.25, source.z));
      expect(bubble.mode).toBe('fixed');
      expect(tail.x < body.left || tail.x > body.right || tail.y < body.bottom || tail.y > body.top).toBe(true);
      expect(Math.hypot(tail.x - wall.x, tail.y - wall.y)).toBeLessThan(Math.hypot(bubble.centre.x - wall.x, bubble.centre.y - wall.y));
    });

    /** Its spot past the wall is the one place it can go, and a bubble round a head can go anywhere round it, so it takes its spot first. */
    it('places a voice from the door before a bubble round a head that spoke earlier', () => {
      const scene = roomScene(0.78);
      scene.placeEntity(player({ id: 'aya', kind: 'peer', position: { x: 5, z: 1 } }));
      scene.showSpeechBubble(voiced('aya', ['Hallo'], { x: 5, z: 1 }));

      scene.showSpeechBubble(voiced('bren', ['Hilfe!'], { x: 5, z: 0 }, { kind: 'yell' }));
      scene.tick(MAX_TICK_DELTA);

      expect(scene.placedBubbles().bubbles.map((bubble) => [bubble.lines[0], bubble.mode])).toEqual([
        ['Hilfe!', 'fixed'],
        ['Hallo', 'anchored'],
      ]);
    });

    it('hangs it over the yeller once they come in through the door', () => {
      const scene = roomScene(0.78);
      scene.showSpeechBubble(voiced('bren', ['Hilfe!'], { x: 5, z: 0 }, { kind: 'yell' }));
      expect(bubbleSaying(scene, 'Hilfe!')!.mode).toBe('fixed');

      scene.placeEntity(player({ id: 'bren', kind: 'peer', position: { x: 5, z: 1 } }));
      scene.tick(MAX_TICK_DELTA);

      expect(bubbleSaying(scene, 'Hilfe!')!.mode).toBe('anchored');
    });

    it('pins it at the edge of the screen when the wall is off screen', () => {
      const scene = roomScene(1.4, 0.2);
      expect(speechBubbleFrameSize([LONG], 'say').width * 0.016).toBeGreaterThan(2 * scene.placedBubbles().halfSize.x);

      expect(scene.showSpeechBubble(voiced('bren', [LONG], { x: 0, z: 5 }))).toBe(true);
    });
  });

  /** At the closest zoom a 200 x 1000 window shows 2 m across, less than the 2.4 m a full bubble is wide. */
  it('centres a pinned bubble across a window too narrow for it', () => {
    const scene = sceneWithPeer(40, 0.2);
    scene.applyZoomFactor(1.4);
    expect(speechBubbleFrameSize([LONG], 'say').width * 0.016).toBeGreaterThan(2 * scene.placedBubbles().halfSize.x);

    expect(scene.showSpeechBubble(said('peer', [LONG], 3000))).toBe(true);

    expect(bubbleSaying(scene, LONG)!.centre.x).toBe(0);
  });

  it("keeps the bubbles with the outgoing space until the player lands, then carries the player's own through the door for the rest of its time", () => {
    let nowMs = 0;
    const scene = sceneWithPeer(11, 1, () => nowMs);
    scene.showSpeechBubble(said('self', ['Hallo'], 3000));
    scene.showSpeechBubble(said('peer', ['Tschüss'], 3000));
    nowMs = 1000;
    scene.tick(MAX_TICK_DELTA);

    scene.enterSpace(world('EdariaInn'));
    scene.tick(MAX_TICK_DELTA);
    expect(scene.placedBubbles().bubbles.map((bubble) => bubble.lines[0])).toEqual(['Hallo', 'Tschüss']);

    scene.placeEntity(player({ position: { x: 2, z: 2 } }));
    scene.placeEntity(player({ id: 'peer', kind: 'peer', position: { x: 3, z: 2 } }));
    expect(scene.placedBubbles().bubbles.map((bubble) => bubble.lines[0])).toEqual(['Hallo']);
    expect(bubbleSaying(scene, 'Hallo')!.centre.x).toBeCloseTo(screenOf(scene, new THREE.Vector3(2, 0, 2)).x, 6);
    nowMs = 2999;
    scene.tick(MAX_TICK_DELTA);
    expect(bubbleSaying(scene, 'Hallo')).toBeDefined();
    nowMs = 3000;
    scene.tick(MAX_TICK_DELTA);
    expect(scene.placedBubbles().bubbles).toEqual([]);
  });

  it('carries no bubble to the splash', () => {
    const scene = sceneWithPeer(11);
    scene.showSpeechBubble(said('self', ['Hallo'], 3000));

    scene.showSplash();
    scene.placeEntity(player());

    expect(scene.placedBubbles().bubbles).toEqual([]);
  });

  it.each([
    [1, 1],
    [0.5, 0.575],
  ])('draws a line heard at clarity %f at opacity %f', (clarity, opacity) => {
    const scene = sceneWithPeer(11);

    scene.showSpeechBubble(said('peer', ['Hallo'], 3000, { clarity }));

    expect(bubbleSaying(scene, 'Hallo')!.opacity).toBeCloseTo(opacity, 12);
  });

  it('draws each kind of speech in its own style, its tail toward the head it hangs over or the edge it is pinned to', () => {
    const scene = sceneWithPeer(11);

    scene.showSpeechBubble(said('peer', ['psst'], 3000, { kind: 'whisper' }));
    // Straight away from the camera, which is drawn straight up the screen.
    const yaw = (ORTHO_RIG.yawDegrees * Math.PI) / 180;
    const away = { x: 10 - 40 * Math.sin(yaw), z: 10 - 40 * Math.cos(yaw) };
    scene.showSpeechBubble(voiced('bren', ['Hilfe!'], away, { kind: 'yell' }));

    const whisper = bubbleSaying(scene, 'psst')!;
    const yell = bubbleSaying(scene, 'Hilfe!')!;
    expect([whisper.kind, yell.kind]).toEqual(['whisper', 'yell']);
    expect(whisper.tail!.y).toBeLessThan(bodyOf(whisper).bottom);
    expect(yell.mode).toBe('pinned');
    expect(yell.tail!.y).toBeGreaterThan(bodyOf(yell).top);
  });
});

describe('speech balloon art', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A path recording the points it passes through, the rects added to it, and whether it was closed. */
  class RecordedPath {
    points: { x: number; y: number }[] = [];
    rects: number[][] = [];
    closed = false;
    moveTo(x: number, y: number): void {
      this.points.push({ x, y });
    }
    lineTo(x: number, y: number): void {
      this.points.push({ x, y });
    }
    arcTo(): void {}
    rect(...args: number[]): void {
      this.rects.push(args);
    }
    closePath(): void {
      this.closed = true;
    }
  }

  /** A 2D context that records what is drawn on it. `events` is the order of its calls. */
  function recordingContext(): {
    context: CanvasRenderingContext2D;
    strokes: { color: unknown; width: unknown; dash: number[] }[];
    stroked: RecordedPath[];
    fills: RecordedPath[];
    fillAlphas: number[];
    clips: { path: RecordedPath; rule: string | undefined }[];
    clears: number[][];
    transforms: number[][];
    copies: { alpha: number; image: unknown; rects: number[] }[];
    events: string[];
  } {
    const strokes: { color: unknown; width: unknown; dash: number[] }[] = [];
    const stroked: RecordedPath[] = [];
    const fills: RecordedPath[] = [];
    const fillAlphas: number[] = [];
    const clips: { path: RecordedPath; rule: string | undefined }[] = [];
    const clears: number[][] = [];
    const transforms: number[][] = [];
    const copies: { alpha: number; image: unknown; rects: number[] }[] = [];
    const events: string[] = [];
    let dash: number[] = [];
    const context = {
      canvas: { width: 0, height: 0 },
      strokeStyle: '',
      lineWidth: 1,
      globalAlpha: 1,
      save() {
        events.push('save');
      },
      restore() {
        events.push('restore');
      },
      clip(path: RecordedPath, rule?: string) {
        clips.push({ path, rule });
        events.push('clip');
      },
      setTransform(...matrix: number[]) {
        transforms.push(matrix);
        events.push('transform');
      },
      clearRect(...rect: number[]) {
        clears.push(rect);
        events.push('clear');
      },
      fillText() {
        events.push('text');
      },
      drawImage(image: unknown, ...rects: number[]) {
        copies.push({ alpha: context.globalAlpha, image, rects });
        events.push('copy');
      },
      fill(path: RecordedPath) {
        fills.push(path);
        fillAlphas.push(context.globalAlpha);
        events.push('fill');
      },
      setLineDash(next: number[]) {
        dash = next;
      },
      stroke(path: RecordedPath) {
        stroked.push(path);
        strokes.push({ color: context.strokeStyle, width: context.lineWidth, dash });
      },
    };
    vi.stubGlobal('Path2D', RecordedPath);
    return { context: context as unknown as CanvasRenderingContext2D, strokes, stroked, fills, fillAlphas, clips, clears, transforms, copies, events };
  }

  it.each([
    ['whisper', [{ color: '#000000', width: 1, dash: [3, 2] }]],
    ['say', [{ color: '#000000', width: 1, dash: [] }]],
    [
      'yell',
      [
        { color: '#000000', width: 3.6, dash: [] },
        { color: 'rgb(255, 222, 0)', width: 1.6, dash: [] },
      ],
    ],
  ] as const)('outlines a %s balloon with %j', (kind, strokes) => {
    const recorded = recordingContext();

    paintSpeechBubble(recorded.context, ['Hallo'], kind, undefined);

    expect(recorded.strokes).toEqual(strokes);
  });

  it("bursts a yell's outline into teeth", () => {
    const edges = (kind: SpeechKind): number => {
      const recorded = recordingContext();
      paintSpeechBubble(recorded.context, ['Hallo'], kind, undefined);
      return recorded.fills[0]!.points.length;
    };

    expect(edges('yell')).toBeGreaterThan(4 * edges('say'));
  });

  /** Stroked as two lines, a tail and its body meet as two cut-off ends that never quite join. */
  it.each(['whisper', 'say', 'yell'] as const)('fills and strokes a %s body and its tail as one closed outline through the tip', (kind) => {
    const recorded = recordingContext();
    const tip = { x: 70, y: 60 };

    paintSpeechBubble(recorded.context, ['Hallo'], kind, tip);

    const [outline] = recorded.fills;
    expect(recorded.fills).toHaveLength(1);
    expect(outline!.closed).toBe(true);
    expect(outline!.points).toContainEqual(tip);
    expect(recorded.stroked.every((path) => path === outline)).toBe(true);
  });

  /**
   * Where the tail leaves the body: the two points either side of the tip lie on the edge facing it,
   * and the stretch between them lies on the tip's side of that edge's middle. A tail leaving the far
   * edge, or mirrored along its own, would cross the text.
   */
  it.each([
    ['above, left of the middle', { x: 10, y: -20 }, 'y', 'top'],
    ['below, right of the middle', { x: 70, y: 70 }, 'y', 'bottom'],
    ['below, left of the middle', { x: 10, y: 70 }, 'y', 'bottom'],
    ['to the right, low', { x: 120, y: 40 }, 'x', 'right'],
    ['to the left, high', { x: -40, y: 8 }, 'x', 'left'],
  ] as const)('leaves a say from the edge facing a tip %s', (_where, tip, axis, edge) => {
    const recorded = recordingContext();
    const lines = ['Hallo Welt', 'wie geht', 'es dir?'];
    const frame = speechBubbleFrameSize(lines, 'say');

    paintSpeechBubble(recorded.context, lines, 'say', tip);

    const points = recorded.fills[0]!.points;
    const at = points.findIndex((point) => point.x === tip.x && point.y === tip.y);
    const mouth = [points[at - 1]!, points[at + 1]!];
    const middle = { x: frame.width / 2, y: frame.height / 2 };
    for (const point of mouth) {
      if (edge === 'top' || edge === 'left') expect(point[axis]).toBeLessThan(middle[axis] - 5);
      else expect(point[axis]).toBeGreaterThan(middle[axis] + 5);
    }
    const along = axis === 'y' ? 'x' : 'y';
    const stretch = (mouth[0]![along] + mouth[1]![along]) / 2;
    expect(Math.sign(stretch - middle[along])).toBe(Math.sign(tip[along] - middle[along]));
  });

  /** As the layout points it, straight out of the edge it judges on the whole frame, so the tail does not bend round a corner. */
  it('leaves a yell from the side a short tail points straight out of, near its diagonal', () => {
    const recorded = recordingContext();
    const lines = ['Hallo Welt, wie geht es dir heute?'];
    const frame = speechBubbleFrameSize(lines, 'yell');
    const size = { width: frame.width * OVERLAY_METRES_PER_PIXEL, height: frame.height * OVERLAY_METRES_PER_PIXEL };
    // Toward a voice just under the frame's diagonal, judged on the frame: a side.
    const toward = { x: size.width, y: -size.height * 0.95 };
    const tip = tailTip({ x: 0, y: 0 }, size, { toward })!;
    const overlayTip = { x: (tip.x + size.width / 2) / OVERLAY_METRES_PER_PIXEL, y: (size.height / 2 - tip.y) / OVERLAY_METRES_PER_PIXEL };

    paintSpeechBubble(recorded.context, lines, 'yell', overlayTip);

    const points = recorded.fills[0]!.points;
    const at = points.findIndex((point) => Math.abs(point.x - overlayTip.x) < 1e-9 && Math.abs(point.y - overlayTip.y) < 1e-9);
    expect(at).toBeGreaterThan(0);
    for (const point of [points[at - 1]!, points[at + 1]!]) expect(point.x).toBeCloseTo(frame.width - 5 - 1.8);
  });

  it('draws no tail toward a tip inside the body', () => {
    const recorded = recordingContext();

    paintSpeechBubble(recorded.context, ['Hallo'], 'say', { x: 20, y: 10 });

    expect(recorded.fills[0]!.points).not.toContainEqual({ x: 20, y: 10 });
  });

  /** Marks stacked on a letter reach far past its line, and would otherwise be drawn over the world. */
  it('clips its text to the balloon, and lets the clip go after', () => {
    const recorded = recordingContext();

    paintSpeechBubble(recorded.context, ['Hallo'], 'say', { x: 70, y: 60 });

    expect(recorded.clips.map((clip) => clip.path)).toEqual([recorded.fills[0]]);
    expect(recorded.events).toEqual(['fill', 'save', 'clip', 'text', 'restore']);
  });

  const placedBubble = (x: number, opacity = 1): PlacedBubble => ({
    centre: { x, y: 0.5 },
    size: { width: 1, height: 0.4 },
    tail: { x, y: -0.6 },
    lines: ['Hallo'],
    kind: 'say',
    opacity,
    mode: 'anchored',
  });

  /** So a tail may pass behind another bubble, but never through its text. */
  it('copies every bubble outside its frame before any inside it', () => {
    const layer = recordingContext();
    const scratch = recordingContext();

    paintBubbles(layer.context, scratch.context, { halfSize: { x: 3, y: 3 }, bubbles: [placedBubble(-1), placedBubble(1)] }, { width: 600, height: 600 });

    expect(layer.clips.map((clip) => clip.rule)).toEqual(['evenodd', 'evenodd', 'nonzero', 'nonzero']);
    expect(layer.copies).toHaveLength(4);
  });

  /** Painted straight onto the layer at its opacity, the outline and the text would each show what is painted under them through. */
  it('paints a faint bubble opaque and lays the picture down at its opacity', () => {
    const layer = recordingContext();
    const scratch = recordingContext();

    paintBubbles(layer.context, scratch.context, { halfSize: { x: 3, y: 3 }, bubbles: [placedBubble(1, 0.3)] }, { width: 600, height: 600 });

    expect(scratch.fillAlphas).not.toHaveLength(0);
    expect(scratch.fillAlphas.every((alpha) => alpha === 1)).toBe(true);
    expect(layer.copies.map((copy) => copy.alpha)).toEqual([0.3, 0.3]);
  });

  describe('a bubble off the pixel grid, its tail reaching past the edge of a wide screen', () => {
    // 100 canvas pixels a metre. The frame runs from (2.003, 0.75) to (3.003, 0.25) on the screen,
    // and the tail's tip lies 1 cm inside the right edge, so the outline round it reaches past.
    const pixelSize = { width: 800, height: 600 };
    const bubble: PlacedBubble = { ...placedBubble(2.503), size: { width: 1, height: 0.5 }, tail: { x: 3.99, y: -0.6 } };
    const frame = [600, 225, 101, 50];
    const extent = [600, 225, 200, 142];

    function painted() {
      const layer = recordingContext();
      const scratch = recordingContext();
      paintBubbles(layer.context, scratch.context, { halfSize: { x: 4, y: 3 }, bubbles: [bubble] }, pixelSize);
      return { layer, scratch };
    }

    /** Whole pixels, so the two clips share no half-covered pixel along the frame. */
    it('clips to everything but its frame, then to its frame, each grown out to whole pixels', () => {
      const { layer } = painted();

      expect(layer.clips.map((clip) => [clip.rule, clip.path.rects])).toEqual([
        ['evenodd', [[0, 0, 800, 600], frame]],
        ['nonzero', [frame]],
      ]);
    });

    it('copies its frame and its tail from the scratch canvas, pixel for pixel, cut off at the screen', () => {
      const { layer, scratch } = painted();

      expect(layer.copies.map((copy) => copy.rects)).toEqual([
        [...extent, ...extent],
        [...extent, ...extent],
      ]);
      expect(layer.copies.every((copy) => copy.image === scratch.context.canvas)).toBe(true);
    });

    /** A clip left in force would cut every later bubble down to this one's frame. */
    it('clears the layer once, and sets and lets go of each clip round its copy', () => {
      const { layer } = painted();

      expect(layer.transforms).toEqual([[1, 0, 0, 1, 0, 0]]);
      expect(layer.clears).toEqual([[0, 0, 800, 600]]);
      expect(layer.events).toEqual(['transform', 'clear', 'save', 'clip', 'copy', 'restore', 'save', 'clip', 'copy', 'restore']);
    });

    /** What an earlier bubble or an earlier frame left there would be copied along. */
    it('clears what it is about to copy, in canvas pixels, before it paints', () => {
      const { scratch } = painted();

      expect(scratch.clears).toEqual([extent, extent]);
      expect(scratch.events.slice(0, 4)).toEqual(['transform', 'clear', 'transform', 'fill']);
      expect(scratch.transforms[0]).toEqual([1, 0, 0, 1, 0, 0]);
    });

    it('paints it with its frame at its place on the screen and its tail to the tip', () => {
      const { scratch } = painted();

      const scale = 100 * OVERLAY_METRES_PER_PIXEL;
      const [scaleX, skewY, skewX, scaleY, left, top] = scratch.transforms[1]!;
      expect([scaleX, skewY, skewX, scaleY]).toEqual([scale, 0, 0, scale]);
      expect(left).toBeCloseTo(600.3, 9);
      expect(top).toBeCloseTo(225, 9);
      const tip = { x: (3.99 - 2.003) / OVERLAY_METRES_PER_PIXEL, y: (0.75 + 0.6) / OVERLAY_METRES_PER_PIXEL };
      expect(scratch.fills[0]!.points.some((point) => Math.abs(point.x - tip.x) < 1e-9 && Math.abs(point.y - tip.y) < 1e-9)).toBe(true);
    });

    it('keeps the scratch canvas as large as the layer', () => {
      const { scratch } = painted();

      expect(scratch.context.canvas).toMatchObject(pixelSize);
    });
  });

  it('clears the layer and paints nothing with no scratch canvas to paint on', () => {
    const layer = recordingContext();

    paintBubbles(layer.context, null, { halfSize: { x: 3, y: 3 }, bubbles: [placedBubble(1)] }, { width: 600, height: 600 });

    expect(layer.events).toEqual(['transform', 'clear']);
  });
});

describe('per-entity resources are freed when they are swapped out', () => {
  /**
   * The entity arm of the self-heal pass. `refreshResolvedModels` reaches placeholders through
   * `resolveEntityModel`, which the post-prewarm placement test never exercises because it places no
   * entity — so a detach-without-dispose there leaks one placeholder `BoxGeometry` per entity, per
   * heal, out of reach of any later cleanup.
   */
  it('disposes the placeholder geometry when a model resolves after prewarm', async () => {
    let resolved = false;
    const scene = makeScene({
      ...emptyAssets(),
      character: () => (resolved ? new THREE.Object3D() : undefined),
      prewarm: () => {
        resolved = true;
        return Promise.resolve();
      },
    });
    scene.placeEntity(player());

    const placeholders = boxes(scene);
    expect(placeholders).toHaveLength(1);
    const geometryDispose = vi.spyOn(placeholders[0]!.geometry, 'dispose');

    await scene.prewarm();

    expect(geometryDispose).toHaveBeenCalled();
  });
});

describe('the renderer', () => {
  it('tone-maps with the neutral curve at exposure 1, and shadows softly', () => {
    const renderer = { shadowMap: { enabled: false, type: THREE.BasicShadowMap }, toneMapping: THREE.NoToneMapping, toneMappingExposure: 2 };

    configureWorldRenderer(renderer as unknown as THREE.WebGLRenderer);

    expect(renderer).toEqual({ shadowMap: { enabled: true, type: THREE.PCFShadowMap }, toneMapping: THREE.NeutralToneMapping, toneMappingExposure: 1 });
  });
});

describe('the device pixel ratio', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A window moved from a 1x display to a 2x one and back, each move firing only the query for the ratio it left. */
  it('reports every change, asking again for the ratio it changed to', () => {
    const queries = new Map<string, EventTarget>();
    vi.stubGlobal('devicePixelRatio', 1);
    vi.stubGlobal('matchMedia', (query: string) => {
      const list = new EventTarget();
      queries.set(query, list);
      return list;
    });
    const onChange = vi.fn();

    watchViewport(onChange);
    vi.stubGlobal('devicePixelRatio', 2);
    queries.get('(resolution: 1dppx)')!.dispatchEvent(new Event('change'));
    vi.stubGlobal('devicePixelRatio', 1);
    queries.get('(resolution: 2dppx)')!.dispatchEvent(new Event('change'));

    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("draws the world at the display's ratio, up to the cap", () => {
    let pixelRatio = 1;
    const renderer = { getPixelRatio: () => pixelRatio, setPixelRatio: (ratio: number) => (pixelRatio = ratio), setSize: () => {} };
    const drawnAt = (deviceRatio: number): number => {
      vi.stubGlobal('devicePixelRatio', deviceRatio);
      sizeWorldRenderer(renderer, 400, 300);
      return pixelRatio;
    };

    expect([drawnAt(1), drawnAt(1.5), drawnAt(2), drawnAt(3)]).toEqual([1, 1.5, 2, 2]);
  });
});
