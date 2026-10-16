import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { WorldScene, watchViewport } from '@/scene/worldScene';
import type { ModelAssets } from '@/scene/modelAssets';
import { ORTHO_RIG, cameraPosition } from '@/scene/cameraRig';
import { SUN_SHADOW, sunState } from '@/scene/dayNightSun';
import { CLIP_TRANSITION_DURATION, MAX_TICK_DELTA } from '@/scene/animation';
import { CHARACTER_SCALE, FLOOR_PATCH_LIFT, PLACEHOLDER_HEIGHT } from '@/scene/placement';
import {
  NAME_PLAQUE,
  OVERLAY_METRES_PER_PIXEL,
  baselineBelowBoxTop,
  baselineInCenteredBox,
  namePlaqueBackground,
  lineBoxHeight,
  paintSpeechBubble,
  renderNamePlaque,
  speechBubbleFrameSize,
} from '@/scene/overlayArt';
import { paintBubbles } from '@/scene/bubbleLayer';
import type { PlacedBubble } from '@/scene/bubbleLayer';
import { tailTip } from '@/scene/bubbleLayout';
import type { ScreenPoint } from '@/scene/bubbleLayout';
import type { Point } from '@somnio/core';
import type { SectorView, SpeechKind } from '@somnio/protocol';
import { ClientWorld } from '@/client';
import type { ClientEntity, SpeechBubbleRequest } from '@/client';
import { TEST_REGISTRY, interiorSector, outdoorSector } from '../../core/test/support/worldFixture.ts';
import { clientEntity } from './helpers/worldFixture';

/**
 * Graph-level coverage. Pixels are not unit-testable without a GPU, but the placement, framing,
 * and self-heal decisions all live in the scene graph and are.
 */

/** Assets that resolve nothing, so everything renders a placeholder until `resolving()` swaps in. */
function emptyAssets(): ModelAssets {
  return {
    prewarm: async () => {},
    character: () => undefined,
    object: () => undefined,
    floorTexture: () => undefined,
    clipsFor: () => [],
  };
}

function resolvingAssets(): ModelAssets {
  return {
    prewarm: async () => {},
    character: () => new THREE.Object3D(),
    object: () => new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)),
    floorTexture: () => undefined,
    clipsFor: () => [],
  };
}

function makeScene(assets: ModelAssets = emptyAssets(), now?: () => number): WorldScene {
  return new WorldScene(assets, TEST_REGISTRY, 1, now);
}

function sector(overrides: Partial<SectorView> = {}): SectorView {
  return outdoorSector('EdariaMitte', { x: 0, z: 0 }, overrides);
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

/** Every floor quad in the scene, base floors and patches alike, with the sector group it hangs in. */
function floorQuads(scene: WorldScene): THREE.Mesh[] {
  const quads: THREE.Mesh[] = [];
  scene.scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    // The backdrop is a plane too, but it hangs directly off the scene and carries no shadow flag.
    if (mesh.isMesh && mesh.geometry instanceof THREE.PlaneGeometry && mesh.receiveShadow) quads.push(mesh);
  });
  return quads;
}

function planeSize(mesh: THREE.Mesh): { width: number; height: number } {
  const { width, height } = (mesh.geometry as THREE.PlaneGeometry).parameters;
  return { width, height };
}

/** The ground rings drawn round entities: the one tended, and each fallen body being raised. */
function rings(scene: WorldScene): THREE.Mesh[] {
  const found: THREE.Mesh[] = [];
  scene.scene.traverse((object) => {
    if ((object as THREE.Mesh).geometry?.type === 'RingGeometry') found.push(object as THREE.Mesh);
  });
  return found;
}

/**
 * A skinned model with its own skeleton, matching what `SkeletonUtils.clone` hands back: a box
 * one unit tall standing on its node, every vertex bound to the one bone. A `head` bone under it
 * stands 0.9 units up, as the pack's models carry one.
 */
function skinnedModel(): { root: THREE.Object3D; skeleton: THREE.Skeleton; bone: THREE.Bone; head: THREE.Bone } {
  const bone = new THREE.Bone();
  const head = new THREE.Bone();
  head.name = 'head';
  head.position.y = 0.9;
  bone.add(head);
  const skeleton = new THREE.Skeleton([bone]);
  const geometry = new THREE.BoxGeometry(0.2, 1, 0.2).translate(0, 0.5, 0);
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
 * Space roots, identified by holding a sector group with a floor in it. The scene also holds the
 * lights and the backdrop, so a bare `children.length` cannot tell a parked root from the furniture.
 */
function spaceRootCount(scene: WorldScene): number {
  return scene.scene.children.filter((root) => root.children.some((group) => group.children.some((child) => floorQuads(scene).includes(child as THREE.Mesh))))
    .length;
}

function sun(scene: WorldScene): THREE.DirectionalLight {
  return scene.scene.getObjectByProperty('isDirectionalLight', true) as THREE.DirectionalLight;
}

/** The directional fill, which is the one directional light that casts no shadow. */
function ambient(scene: WorldScene): THREE.DirectionalLight {
  return scene.scene.children.find((child) => (child as THREE.DirectionalLight).isDirectionalLight && !child.castShadow) as THREE.DirectionalLight;
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

    scene.setViewportAspect(2.5);

    expect(scene.camera.top - scene.camera.bottom).toBe(verticalBefore);
    expect(scene.camera.right - scene.camera.left).toBeGreaterThan(widthBefore);
  });

  it('magnifies on zoom rather than revealing more world', () => {
    const scene = makeScene();
    scene.applyZoomFactor(2);
    expect(scene.camera.top).toBe(1.5);
  });

  /**
   * A consumer with no player positions the camera itself, and the client's camera follows the
   * player across sector borders: a sector coming into the draw set must not pull the view to it.
   */
  it('leaves the camera alone when a sector is added', () => {
    const scene = makeScene();
    const before = scene.camera.position.clone();

    scene.addSector(outdoorSector('Nordwiese', { x: 5.12, z: -30.72 }));

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
  it('builds a floor and one node per placement', () => {
    const scene = makeScene();

    scene.addSector(sector({ placements: [placement('box-1', 'box'), placement('rug-1', 'rug', { x: 8, yaw: 90 })] }));

    expect(floorQuads(scene)).toHaveLength(1);
    expect(planeSize(floorQuads(scene)[0]!)).toEqual({ width: 20, height: 20 });
    expect(scene._placeholderObjectCount()).toBe(2);
  });

  it('stands a sector at its origin and a placement at its own position, yaw, and elevation within it', () => {
    const scene = makeScene();

    scene.addSector(outdoorSector('Nordwiese', { x: 5.12, z: -30.72 }, { placements: [placement('rug-1', 'rug', { x: 4, z: 6, yaw: 270, elevation: 0.4 })] }));

    const node = scene.placementNode('Nordwiese', 'rug-1')!;
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

    expect(scene.placementNode('EdariaMitte', 'dais-1')!.position.y).toBe(0);
  });

  it('finds a placement node by sector and id, and nothing for either unknown', () => {
    const scene = makeScene();
    scene.addSector(sector({ placements: [placement('box-1', 'box')] }));
    scene.addSector(outdoorSector('Nordwiese', { x: 0, z: -20 }, { placements: [placement('box-1', 'box', { x: 1 })] }));

    // The same id in two sectors is two placements.
    expect(scene.placementNode('EdariaMitte', 'box-1')!.position.x).toBe(4);
    expect(scene.placementNode('Nordwiese', 'box-1')!.position.x).toBe(1);
    expect(scene.placementNode('EdariaMitte', 'box-2')).toBeUndefined();
    expect(scene.placementNode('Nordwald', 'box-1')).toBeUndefined();
  });

  it('removes one sector and leaves the others drawn', () => {
    const scene = makeScene();
    scene.addSector(sector({ placements: [placement('box-1', 'box')] }));
    scene.addSector(outdoorSector('Nordwiese', { x: 0, z: -20 }, { placements: [placement('box-1', 'box')] }));
    const removed = floorQuads(scene)[0]!;
    const geometryDispose = vi.spyOn(removed.geometry, 'dispose');

    scene.removeSector('EdariaMitte');

    expect(floorQuads(scene)).toHaveLength(1);
    expect(scene.placementNode('EdariaMitte', 'box-1')).toBeUndefined();
    expect(scene.placementNode('Nordwiese', 'box-1')).toBeDefined();
    expect(geometryDispose).toHaveBeenCalled();
  });

  it('replaces a sector added again under the same name', () => {
    const scene = makeScene();
    scene.addSector(sector({ placements: [placement('box-1', 'box')] }));

    scene.addSector(sector({ placements: [placement('box-1', 'box', { x: 9 })] }));

    expect(floorQuads(scene)).toHaveLength(1);
    expect(scene._placeholderObjectCount()).toBe(1);
    expect(scene.placementNode('EdariaMitte', 'box-1')!.position.x).toBe(9);
  });

  /**
   * The continuity contract: two quads abutting *vertically* must meet at one V value, so the
   * texture grid runs unbroken across the seam.
   *
   * The hazard is that V can be an affine function of the row and still be wrong — if its intercept
   * depends on the quad's own position and depth, each quad mirrors about its own centre and the
   * grid phase jumps at every horizontal seam. That is invisible in a single-quad render, so only
   * two quads with different vertical centres can distinguish the two shapes.
   */
  it('gives vertically abutting patches one shared V at their seam', () => {
    const scene = makeScene();
    scene.addSector(
      sector({
        floorPatches: [
          { id: 'patch-1', floorMaterialId: 'cobble', x: 0, z: 0, width: 2.56, depth: 1.28 },
          { id: 'patch-2', floorMaterialId: 'cobble', x: 0, z: 1.28, width: 2.56, depth: 8.96 },
        ],
      }),
    );

    const [, upper, lower] = floorQuads(scene).map((quad) => quad.geometry.getAttribute('uv').array as Float32Array);
    // Indices 0/1 are the local +Y row, which `rotation.x = -pi/2` maps to world -Z: the quad's
    // north edge, at the smaller z. Indices 2/3 are its south edge.
    expect(upper![5]).toBeCloseTo(lower![1]!, 6);
    expect(upper![5]).not.toBeCloseTo(upper![1]!, 6);
  });

  /** In space coordinates, so the grid also runs unbroken across the border between two sectors. */
  it('gives the floors of two adjacent sectors one shared V at their border, and one U along it', () => {
    const scene = makeScene();
    scene.addSector(outdoorSector('North', { x: 5.12, z: 3.2 }));
    scene.addSector(outdoorSector('South', { x: 5.12, z: 23.2 }));

    const [north, south] = floorQuads(scene).map((quad) => quad.geometry.getAttribute('uv').array as Float32Array);
    expect(north![5]).toBeCloseTo(south![1]!, 6);
    expect(north![5]).toBeCloseTo(-23.2 / 1.6, 5);
    expect(north![4]).toBeCloseTo(south![0]!, 6);
    expect(north![4]).toBeCloseTo(5.12 / 1.6, 5);
  });

  it('renders floor patches as their own quads, at their place in the sector', () => {
    const scene = makeScene();
    scene.addSector(
      outdoorSector('Nordwiese', { x: 5.12, z: -30.72 }, { floorPatches: [{ id: 'patch-1', floorMaterialId: 'cobble', x: 2, z: 4, width: 3, depth: 5 }] }),
    );

    const [floor, patch] = floorQuads(scene);
    expect(planeSize(patch!)).toEqual({ width: 3, height: 5 });
    expect(patch!.getWorldPosition(new THREE.Vector3())).toEqual(new THREE.Vector3(5.12 + 3.5, FLOOR_PATCH_LIFT, -30.72 + 6.5));
    expect(floor!.getWorldPosition(new THREE.Vector3())).toEqual(new THREE.Vector3(5.12 + 10, 0, -30.72 + 10));
  });

  /**
   * Patches are coplanar with the base floor unless something separates them, and two coplanar
   * quads z-fight — the symptom is a street that flickers between cobble and grass as the camera
   * moves.
   */
  it('lifts patch quads clear of the base floor plane', () => {
    const scene = makeScene();
    scene.addSector(sector({ floorPatches: [{ id: 'patch-1', floorMaterialId: 'cobble', x: 0, z: 0, width: 2.56, depth: 2.56 }] }));

    const heights = floorQuads(scene).map((quad) => quad.position.y);
    expect(heights).toEqual([0, FLOOR_PATCH_LIFT]);
    expect(FLOOR_PATCH_LIFT).toBeGreaterThan(0);
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
    expect(sun(scene).intensity).toBeCloseTo(sunState(12, 50).sunIntensity / 1000, 12);
    expect(sun(scene).intensity).not.toBe(outdoors);
  });

  it('returns to the outdoor light when the next space is outdoors', () => {
    const scene = makeScene();
    scene.addSector(interiorSector('EdariaInn', { brightness: 50 }));
    scene.placeEntity(player());

    scene.enterSpace(world());
    scene.addSector(sector());
    scene.placeEntity(player());

    expect(sun(scene).intensity).toBeCloseTo(sunState(12, undefined).sunIntensity / 1000, 12);
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

    expect(sun(scene).intensity).toBeCloseTo(sunState(12, undefined).sunIntensity / 1000, 12);
  });

  it('lights the scene for the time it is told', () => {
    const scene = makeScene(emptyAssets(), () => 0);
    scene.addSector(sector());

    scene.setClock(at(7));

    expect(sun(scene).intensity).toBeCloseTo(sunState(7, undefined).sunIntensity / 1000, 12);
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

    expect(sun(scene).intensity).toBeCloseTo(sunState(8, undefined).sunIntensity / 1000, 9);
    expect(sun(scene).intensity).not.toBeCloseTo(sunState(7, undefined).sunIntensity / 1000, 3);
  });

  it('does not let the clock change an interior', () => {
    let nowMs = 0;
    const scene = makeScene(emptyAssets(), () => nowMs);
    scene.addSector(interiorSector('EdariaInn', { brightness: 80 }));
    scene.setClock(at(23));

    nowMs += 3_600_000;
    scene.tick(0.016);

    expect(sun(scene).intensity).toBeCloseTo(sunState(12, 80).sunIntensity / 1000, 12);
  });

  /** The whole state reaches the lights: where the sun stands and its tint, and the fill beside it. */
  it('points and tints the sun and sets the fill for a night hour, and again for an interior', () => {
    const scene = makeScene(emptyAssets(), () => 0);
    scene.addSector(sector());

    scene.setClock(at(23));
    const night = sunState(23, undefined);
    expect(sunDirection(scene).distanceTo(new THREE.Vector3(night.direction.x, night.direction.y, night.direction.z))).toBeLessThan(1e-9);
    expect(sun(scene).color).toEqual(new THREE.Color(0.7, 0.8, 1));
    expect(ambient(scene).intensity).toBeCloseTo(0.2575 * 1.2, 9);

    scene.addSector(interiorSector('EdariaInn', { brightness: 50 }));
    const interior = sunState(23, 50);
    expect(sunDirection(scene).distanceTo(new THREE.Vector3(interior.direction.x, interior.direction.y, interior.direction.z))).toBeLessThan(1e-9);
    expect(interior.direction).not.toEqual(night.direction);
    expect(sun(scene).color).toEqual(new THREE.Color(1, 1, 1));
    expect(ambient(scene).intensity).toBeCloseTo(0.5 * 0.65 * 1.2, 9);
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
    const node = scene.placementNode('EdariaMitte', 'door-1')!;
    const before = { position: node.position.clone(), yaw: node.rotation.y };

    const warm = resolvingAssets();
    assets.object = (id) => warm.object(id);
    await scene.prewarm();

    expect(scene.placementNode('EdariaMitte', 'door-1')).toBe(node);
    expect(node.position).toEqual(before.position);
    expect(node.rotation.y).toBe(before.yaw);
    expect(node.children).toHaveLength(1);
    // The model itself is not turned a second time.
    expect(node.children[0]!.rotation.y).toBe(0);
  });

  /** A sector that loaded before the texture cache warmed must not keep its grey floor for the session. */
  it('textures the floor and its patches once the cache warms', async () => {
    const cached = new THREE.Texture();
    cached.image = { width: 64, height: 64 };
    const assets = emptyAssets();
    const scene = makeScene(assets);
    scene.addSector(sector({ floorPatches: [{ id: 'patch-1', floorMaterialId: 'cobble', x: 0, z: 0, width: 2.56, depth: 2.56 }] }));
    const grey = floorQuads(scene);
    expect(grey.map((quad) => (quad.material as THREE.MeshStandardMaterial).map)).toEqual([null, null]);
    const greyDisposes = grey.map((quad) => vi.spyOn(quad.geometry, 'dispose'));

    assets.floorTexture = () => cached;
    await scene.prewarm();

    const healed = floorQuads(scene);
    expect(healed).toHaveLength(2);
    for (const quad of healed) expect((quad.material as THREE.MeshStandardMaterial).map).not.toBeNull();
    expect(healed.map((quad) => quad.position.y)).toEqual([0, FLOOR_PATCH_LIFT]);
    for (const spy of greyDisposes) expect(spy).toHaveBeenCalled();
  });

  it('keeps a healed floor and its patch where the sector stands', async () => {
    const cached = new THREE.Texture();
    cached.image = { width: 64, height: 64 };
    const assets = emptyAssets();
    const scene = makeScene(assets);
    scene.addSector(
      outdoorSector('Nordwiese', { x: 5.12, z: -30.72 }, { floorPatches: [{ id: 'patch-1', floorMaterialId: 'cobble', x: 2, z: 4, width: 3, depth: 5 }] }),
    );

    assets.floorTexture = () => cached;
    await scene.prewarm();

    const [floor, patch] = floorQuads(scene);
    for (const quad of [floor!, patch!]) expect((quad.material as THREE.MeshStandardMaterial).map).not.toBeNull();
    expect(floor!.getWorldPosition(new THREE.Vector3())).toEqual(new THREE.Vector3(5.12 + 10, 0, -30.72 + 10));
    expect(patch!.getWorldPosition(new THREE.Vector3())).toEqual(new THREE.Vector3(5.12 + 3.5, FLOOR_PATCH_LIFT, -30.72 + 6.5));
  });
});

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

    it('is picked where the head lies, and not where its head would stand', () => {
      const { scene, head } = fallenPeer();
      scene.camera.updateMatrixWorld();
      const lying = lyingHead(head).project(scene.camera);
      const upright = new THREE.Vector3(12, CHARACTER_SCALE, 10).project(scene.camera);

      expect(scene.entityAt(lying.x, lying.y)).toBe('peer');
      expect(scene.entityAt(upright.x, upright.y)).toBeUndefined();
    });

    it('reports its screen point where it lies, and a click there picks it', () => {
      const { scene } = fallenPeer();
      scene.camera.updateMatrixWorld();
      const point = scene._viewportPointFor('peer')!;
      const upright = new THREE.Vector3(12, CHARACTER_SCALE / 2, 10).project(scene.camera);

      expect(scene.entityAt(point.x, point.y)).toBe('peer');
      expect(Math.hypot(point.x - upright.x, point.y - upright.y)).toBeGreaterThan(0.1);
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

describe('what the cursor is over, and the entity tended', () => {
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

  it('rings the one entity tended, and frees the ring when another is chosen, none is, or the entity leaves', () => {
    const scene = makeScene();
    scene.placeEntity(player());
    scene.placeEntity(player({ id: 'bren', kind: 'peer', position: { x: 12, z: 10 } }));
    scene.placeEntity(player({ id: 'cara', kind: 'peer', position: { x: 8, z: 10 } }));

    scene.showSelection('bren');
    expect(rings(scene).map((ring) => ring.parent?.position.x)).toEqual([12]);

    scene.showSelection('cara');
    expect(rings(scene).map((ring) => ring.parent?.position.x)).toEqual([8]);
    scene.showSelection(undefined);
    expect(rings(scene)).toEqual([]);

    scene.showSelection('nobody');
    expect(rings(scene)).toEqual([]);
    scene.showSelection('bren');
    scene.removeEntity('bren');
    expect(rings(scene)).toEqual([]);
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
    scene.placeEntity(player({ id: 'npc:EdariaMitte/libus', kind: 'npc', name: 'Libus' }));

    scene.updateGait('npc:EdariaMitte/libus', 'run');
    scene.updatePosition('npc:EdariaMitte/libus', { x: 9.9, z: 10 }, 90, 270);
    scene.tick(0.016);

    expect(scene._poseFor('npc:EdariaMitte/libus')).toBe('walking');
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

  afterEach(() => vi.restoreAllMocks());

  /** A scene whose character model carries `names` as clips, and the action of every clip started on it, in order. */
  function fightingScene(
    names = ['Idle', 'Interact', 'Hit_A', 'Death_A'],
    now?: () => number,
  ): { scene: WorldScene; started: () => string[]; last: () => THREE.AnimationAction } {
    const clips = names.map((name) => new THREE.AnimationClip(name, CLIP_SECONDS, []));
    const scene = makeScene({ ...emptyAssets(), character: () => new THREE.Object3D(), clipsFor: () => clips }, now);
    const play = vi.spyOn(THREE.AnimationAction.prototype, 'play');
    const actions = (): THREE.AnimationAction[] => play.mock.contexts as THREE.AnimationAction[];
    return { scene, started: () => actions().map((action) => action.getClip().name), last: () => actions().at(-1)! };
  }

  /** Runs the scene for `seconds`, in steps under the tick's own clamp. */
  function run(scene: WorldScene, seconds: number): void {
    for (let elapsed = 0; elapsed < seconds; elapsed += MAX_TICK_DELTA) scene.tick(MAX_TICK_DELTA);
  }

  function entityNode(scene: WorldScene, entityId: string): THREE.Object3D {
    scene.showSelection(entityId);
    const node = rings(scene)[0]!.parent!;
    scene.showSelection(undefined);
    return node;
  }

  it('plays a swing once over the pose, then fades the pose back in', () => {
    const { scene, started, last } = fightingScene();
    scene.placeEntity(player());
    scene.tick(0.016);
    expect(started()).toEqual(['Idle']);

    const idle = last();
    scene.showBlow('self', undefined, false);
    expect(started()).toEqual(['Idle', 'Interact']);
    expect(last().loop).toBe(THREE.LoopOnce);
    // Half-way through the fade the pose has given half its weight to the swing.
    scene.tick(CLIP_TRANSITION_DURATION / 2);
    expect(idle.getEffectiveWeight()).toBeCloseTo(0.5, 6);
    expect(last().getEffectiveWeight()).toBeCloseTo(0.5, 6);

    run(scene, CLIP_SECONDS / 2);
    expect(started()).toEqual(['Idle', 'Interact']);
    run(scene, CLIP_SECONDS);
    expect(started()).toEqual(['Idle', 'Interact', 'Idle']);
  });

  it('makes the one hit flinch, and marks a miss over the one missed for a moment', () => {
    let nowMs = 0;
    const { scene, started } = fightingScene(undefined, () => nowMs);
    scene.placeEntity(player());
    scene.placeEntity(player({ id: 'monster:1', kind: 'monster', position: { x: 11, z: 10 } }));
    scene.tick(0.016);
    const ghost = entityNode(scene, 'monster:1');
    const before = ghost.children.length;

    scene.showBlow('self', 'monster:1', true);
    expect(started().slice(-2)).toEqual(['Interact', 'Hit_A']);
    expect(ghost.children).toHaveLength(before);

    scene.showBlow('self', 'monster:1', false);
    scene.showBlow('self', 'monster:1', false);
    expect(started().at(-1)).toBe('Interact');
    expect(ghost.children).toHaveLength(before + 1);
    nowMs = 1000;
    scene.tick(0.016);
    expect(ghost.children).toHaveLength(before);
  });

  it('hangs the miss mark over the head of the one missed', () => {
    const scene = makeScene();
    scene.placeEntity(player());
    scene.placeEntity(player({ id: 'monster:1', kind: 'monster', position: { x: 11, z: 10 } }));
    const ghost = entityNode(scene, 'monster:1');

    scene.showBlow('self', 'monster:1', false);

    expect(ghost.children.at(-1)!.position.y).toBeCloseTo(CHARACTER_SCALE + 0.2, 6);
  });

  it('drops a fallen entity once and keeps it down, whatever strikes it, until it stands again', () => {
    const { scene, started, last } = fightingScene();
    scene.placeEntity(player({ id: 'peer', kind: 'peer' }));
    scene.tick(0.016);

    scene.updateCondition('peer', 'fallen');
    expect(started()).toEqual(['Idle', 'Death_A']);
    expect(last().clampWhenFinished).toBe(true);
    run(scene, CLIP_SECONDS * 3);
    scene.showBlow('monster:1', 'peer', true);
    expect(started()).toEqual(['Idle', 'Death_A']);

    scene.updateCondition('peer', 'failing');
    scene.tick(0.016);
    expect(started()).toEqual(['Idle', 'Death_A', 'Idle']);
  });

  it('lays down an entity that comes into view already fallen', () => {
    const { scene, started } = fightingScene();
    scene.placeEntity(player({ id: 'peer', kind: 'peer', condition: 'fallen' }));
    scene.tick(0.016);
    // Posed once to be measured standing, then down.
    expect(started()).toEqual(['Idle', 'Death_A']);
  });

  it('keeps the pose of a model that carries none of the clips', () => {
    const { scene, started } = fightingScene(['Idle']);
    scene.placeEntity(player());
    scene.tick(0.016);

    scene.showBlow('self', undefined, false);
    scene.updateCondition('self', 'fallen');
    run(scene, CLIP_SECONDS * 2);

    expect(started()).toEqual(['Idle']);
  });

  it('draws a ring round a body being raised as far round as the raise has gone, however few frames were drawn, and frees it when the raise ends', () => {
    let nowMs = 0;
    const scene = makeScene(emptyAssets(), () => nowMs);
    scene.placeEntity(player({ id: 'peer', kind: 'peer', condition: 'fallen' }));

    scene.showRaising('peer', 6);
    const [ring] = rings(scene);
    const whole = ring!.geometry.getIndex()!.count;
    expect(ring!.geometry.drawRange.count).toBe(0);

    nowMs = 3000;
    scene.tick(0.016);
    expect(ring!.geometry.drawRange.count).toBe(whole / 2);
    nowMs = 7000;
    scene.tick(0.016);
    expect(ring!.geometry.drawRange.count).toBe(whole);

    const dispose = vi.spyOn(ring!.geometry, 'dispose');
    scene.showRaising('peer', undefined);
    expect(rings(scene)).toEqual([]);
    expect(dispose).toHaveBeenCalled();
  });
});

describe('the sun travels with the camera focus', () => {
  /**
   * three.js derives a directional light's direction from `position - target.position`. Anchoring
   * the light at the world origin while the target follows the player swings that direction
   * further off the authored one the further the player walks from the origin — the sun
   * would visibly rotate as you cross the world.
   */
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
    const floor = scene
      .placementNode('EdariaMitte', 'box-1')!
      .parent!.children.find((child) => (child as THREE.Mesh).geometry instanceof THREE.PlaneGeometry) as THREE.Mesh | undefined;
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

  it('gives a hale monster a plaque only while it is hovered', () => {
    expect(namePlaqueBackground('monster', 'hale', false)).toBeUndefined();
    expect(namePlaqueBackground('monster', 'hale', true)).toBe(NAME_PLAQUE.playerBackground);
  });

  it.each(['grazed', 'wounded', 'hurt', 'failing', 'fallen'] as const)(
    'tints a %s player, peer, and monster alike, and leaves an NPC as it is',
    (condition) => {
      const tint = NAME_PLAQUE.conditionBackground[condition];
      expect(namePlaqueBackground('player', condition, false)).toBe(tint);
      expect(namePlaqueBackground('peer', condition, false)).toBe(tint);
      expect(namePlaqueBackground('monster', condition, false)).toBe(tint);
      expect(namePlaqueBackground('npc', condition, false)).toBe(NAME_PLAQUE.npcBackground);
    },
  );

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

    scene.placeEntity(player({ id: 'npc:EdariaMitte/libus', kind: 'npc', name: 'Libus' }));
    expect(plaqueCanvases(scene)).toHaveLength(2);

    scene.placeEntity(player({ id: 'monster:1', kind: 'monster', name: 'Gespenst' }));
    expect(plaqueCanvases(scene)).toHaveLength(2);
  });

  it('gives a nightmare a plaque while it is not hale, and takes it away when it is', () => {
    const scene = makeScene();
    scene.placeEntity(player({ id: 'monster:1', kind: 'monster', name: 'Gespenst' }));
    expect(plaqueCanvases(scene)).toHaveLength(0);

    scene.updateCondition('monster:1', 'hurt');
    expect(plaqueCanvases(scene)).toHaveLength(1);
    scene.updateCondition('monster:1', 'failing');
    expect(plaqueCanvases(scene)).toHaveLength(1);

    scene.updateCondition('monster:1', 'hale');
    expect(plaqueCanvases(scene)).toHaveLength(0);
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

    /** The player at 10, and peers at 8 (hale), 11 (tended), and 12 (hurt). */
    function crowd(): WorldScene {
      const scene = makeScene();
      scene.placeEntity(player());
      scene.placeEntity(player({ id: 'hale', kind: 'peer', position: { x: 8, z: 10 } }));
      scene.placeEntity(player({ id: 'tended', kind: 'peer', position: { x: 11, z: 10 } }));
      scene.placeEntity(player({ id: 'hurt', kind: 'peer', condition: 'hurt', position: { x: 12, z: 10 } }));
      scene.showSelection('tended');
      scene.tick(0.016);
      return scene;
    }

    function orders(scene: WorldScene): number[] {
      return [11, 12, 10, 8].map((x) => plateAt(scene, x)!.renderOrder);
    }

    it('draws the plaque tended over a hurt one, a hurt one over the own, and the own over the rest, none hidden by another', () => {
      const scene = crowd();

      const [tended, hurt, own, hale] = orders(scene);
      expect(tended).toBeGreaterThan(hurt!);
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

    it('draws the plaque tended over even a fallen one', () => {
      const scene = crowd();
      scene.placeEntity(player({ id: 'down', kind: 'peer', condition: 'fallen', position: { x: 6, z: 10 } }));
      scene.tick(0.016);

      expect(plateAt(scene, 11)!.renderOrder).toBeGreaterThan(plateAt(scene, 6)!.renderOrder);
      expect(plateAt(scene, 6)!.renderOrder).toBeGreaterThan(plateAt(scene, 12)!.renderOrder);
    });

    it('brings the hovered plaque over every other and through the world, and puts it back when the pointer leaves', () => {
      const scene = crowd();
      const before = orders(scene);

      scene.setPointer(scene._viewportPointFor('hale'));
      scene.tick(0.016);
      expect(plateAt(scene, 8)!.renderOrder).toBeGreaterThan(Math.max(...before));
      expect(depthTested(plateAt(scene, 8)!)).toBe(false);

      scene.setPointer(undefined);
      scene.tick(0.016);
      expect(orders(scene)).toEqual(before);
      expect(depthTested(plateAt(scene, 8)!)).toBe(true);
    });

    /** Hover picks what a click would reach, which is never the player. */
    it("hovers nothing over the player's own body", () => {
      const scene = crowd();
      const before = orders(scene);

      scene.setPointer(scene._viewportPointFor('self'));
      scene.tick(0.016);

      expect(orders(scene)).toEqual(before);
      expect([8, 10, 11, 12].every((x) => depthTested(plateAt(scene, x)!))).toBe(true);
    });

    it('shows the name of a hale nightmare only while it is hovered', () => {
      const scene = makeScene();
      scene.placeEntity(player());
      scene.placeEntity(player({ id: 'monster:1', kind: 'monster', name: 'Gespenst', position: { x: 12, z: 10 } }));
      expect(plateAt(scene, 12)).toBeUndefined();

      scene.setPointer(scene._viewportPointFor('monster:1'));
      scene.tick(0.016);
      expect(plateAt(scene, 12)).toBeDefined();

      // Struck and healed again under a resting pointer, it keeps its name.
      scene.updateCondition('monster:1', 'grazed');
      scene.updateCondition('monster:1', 'hale');
      scene.tick(0.016);
      expect(plateAt(scene, 12)).toBeDefined();

      scene.setPointer(undefined);
      scene.tick(0.016);
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
describe('GPU resource disposal', () => {
  const patched = sector({ floorPatches: [{ id: 'patch-1', floorMaterialId: 'cobble', x: 0, z: 0, width: 0.64, depth: 0.64 }] });

  it.each([
    ['its sector leaves the draw set', (scene: WorldScene) => scene.removeSector('EdariaMitte')],
    [
      'the next space is revealed',
      (scene: WorldScene) => {
        scene.enterSpace(world('EdariaInn'));
        scene.placeEntity(player());
      },
    ],
    ['the splash takes the space down', (scene: WorldScene) => scene.showSplash()],
  ])('disposes the floor and its patches when %s, sparing the cached texture', (_name, leave) => {
    const cached = new THREE.Texture();
    cached.image = { width: 64, height: 64 };
    const cachedDispose = vi.spyOn(cached, 'dispose');
    const scene = makeScene({ ...emptyAssets(), floorTexture: () => cached });
    scene.addSector(patched);

    const textured = floorQuads(scene);
    expect(textured).toHaveLength(2);
    const geometryDisposes = textured.map((mesh) => vi.spyOn(mesh.geometry, 'dispose'));
    const mapDisposes = textured.map((mesh) => vi.spyOn((mesh.material as THREE.MeshStandardMaterial).map!, 'dispose'));

    leave(scene);

    for (const spy of geometryDisposes) expect(spy).toHaveBeenCalled();
    // The floor and each patch clone the cache entry, so their maps are theirs to free...
    for (const spy of mapDisposes) expect(spy).toHaveBeenCalled();
    // ...while the entry itself must survive for the next quad that paints this material.
    expect(cachedDispose).not.toHaveBeenCalled();
  });

  it('leaves a cached model geometry and material alone when its holder is dropped', () => {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshBasicMaterial();
    const geometryDispose = vi.spyOn(geometry, 'dispose');
    const materialDispose = vi.spyOn(material, 'dispose');
    const scene = makeScene({ ...emptyAssets(), object: () => new THREE.Mesh(geometry, material) });
    scene.addSector(sector({ placements: [placement('box-1', 'box')] }));
    expect(scene._placeholderObjectCount()).toBe(0);

    scene.removeSector('EdariaMitte');

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

describe('speech bubbles hang round a head on screen and are pinned at the edge otherwise', () => {
  /** A line as wide as a bubble gets. */
  const LONG = 'Hallo Welt, wie geht es dir heute?';

  /** The player at (10, 10), and a peer `x` metres along. */
  function sceneWithPeer(x: number, aspect = 1, now?: () => number): WorldScene {
    const scene = new WorldScene(emptyAssets(), TEST_REGISTRY, aspect, now);
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

  /** Zoomed in all the way, the spot over the player's head where a doorway's bubble would hang is off screen. */
  it("pins a voice on the player's own spot to the top", () => {
    const scene = sceneWithPeer(11);
    scene.applyZoomFactor(2);

    expect(scene.showSpeechBubble(voiced('bren', ['Hallo'], { x: 10, z: 10 }))).toBe(true);

    const pinned = bubbleSaying(scene, 'Hallo')!.centre;
    expect(pinned.x).toBeCloseTo(0, 6);
    expect(pinned.y).toBeGreaterThan(scene.placedBubbles().halfSize.y / 2);
  });

  /** Zoomed in all the way, four lines are taller than the screen above the player's head. */
  it("hangs the player's own bubble beside their head when the screen has no room above it", () => {
    const scene = sceneWithPeer(11);
    scene.applyZoomFactor(2);

    expect(scene.showSpeechBubble(said('self', ['one', 'two', 'three', 'four'], 3000))).toBe(false);

    const bubble = bubbleSaying(scene, 'one')!;
    expect(bubble.mode).toBe('anchored');
    expect(insideScreen(scene, bubble)).toBe(true);
  });

  /** 2.7 m across the screen is drawn 0.9 of the way to its edge. */
  it.each([1, -1])('slides the bubble of a speaker drawn near the screen edge on side %i inward', (side) => {
    const yaw = (ORTHO_RIG.yawDegrees * Math.PI) / 180;
    const across = { x: 10 + side * 2.7 * Math.cos(yaw), z: 10 - side * 2.7 * Math.sin(yaw) };
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

  /** A 380 x 1000 window shows 2.28 m across, narrower than the 2.4 m of a full bubble. */
  it('keeps the bubble of a speaker beside the player overhead in a window narrower than a bubble', () => {
    const scene = sceneWithPeer(10.5, 0.38);
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
      const scene = new WorldScene(emptyAssets(), TEST_REGISTRY, aspect);
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
      const scene = roomScene(0.5);

      expect(scene.showSpeechBubble(voiced('bren', ['Hilfe!'], { x: 5, z: 0 }, { kind: 'yell' }))).toBe(false);

      const bubble = bubbleSaying(scene, 'Hilfe!')!;
      expect(bubble.mode).toBe('fixed');
      expect(bodyOf(bubble).bottom).toBeGreaterThan(screenOf(scene, new THREE.Vector3(5, 2.5, 0)).y);
      expect(insideScreen(scene, bubble)).toBe(true);
      expect(bubble.tail!.y).toBeLessThan(bodyOf(bubble).bottom);
    });

    /** A side wall leaves room for a bubble beside it only in a wide window. */
    it.each([
      [{ x: 10, z: 5 }, 'east'],
      [{ x: 0, z: 5 }, 'west'],
      [{ x: 5, z: 10 }, 'south'],
    ] as const)('points the tail of a voice from the door at %j back toward its %s wall', (source, _wall) => {
      const scene = roomScene(0.5, 2);

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
      const scene = roomScene(0.5);
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
      const scene = roomScene(0.5);
      scene.showSpeechBubble(voiced('bren', ['Hilfe!'], { x: 5, z: 0 }, { kind: 'yell' }));
      expect(bubbleSaying(scene, 'Hilfe!')!.mode).toBe('fixed');

      scene.placeEntity(player({ id: 'bren', kind: 'peer', position: { x: 5, z: 1 } }));
      scene.tick(MAX_TICK_DELTA);

      expect(bubbleSaying(scene, 'Hilfe!')!.mode).toBe('anchored');
    });

    it('pins it at the edge of the screen when the wall is off screen', () => {
      const scene = roomScene(2, 0.6);
      expect(speechBubbleFrameSize([LONG], 'say').width * 0.016).toBeGreaterThan(2 * scene.placedBubbles().halfSize.x);

      expect(scene.showSpeechBubble(voiced('bren', [LONG], { x: 5, z: 0 }))).toBe(true);
    });
  });

  /** At the closest zoom a 600 x 1000 window shows 1.8 m across, less than the 2.4 m a full bubble is wide. */
  it('centres a pinned bubble across a window too narrow for it', () => {
    const scene = sceneWithPeer(40, 0.6);
    scene.applyZoomFactor(2);
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
});
