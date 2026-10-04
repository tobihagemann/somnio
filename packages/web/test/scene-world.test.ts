import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { WorldScene } from '@/scene/worldScene';
import type { ModelAssets } from '@/scene/modelAssets';
import { ORTHO_RIG, cameraPosition } from '@/scene/cameraRig';
import { SUN_SHADOW, sunState } from '@/scene/dayNightSun';
import { MAX_TICK_DELTA } from '@/scene/animation';
import { CHARACTER_SCALE, FLOOR_PATCH_LIFT, PLACEHOLDER_HEIGHT } from '@/scene/placement';
import {
  NAME_PLAQUE,
  baselineBelowBoxTop,
  baselineInCenteredBox,
  namePlaqueBackground,
  lineBoxHeight,
  renderNamePlaque,
  speechBubbleFrameSize,
} from '@/scene/overlayArt';
import type { SectorView } from '@somnio/protocol';
import { ClientWorld } from '@/client';
import type { ClientEntity } from '@/client';
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
   * `BUBBLE_HEAD_GAP` sits between the speaker's head and the balloon tail. The head is measured
   * off the model holder's bounds, relative to the entity's own feet: on raised ground the bounds
   * are higher in the world, and the balloon hangs off a node that is already up there.
   */
  it.each([
    ['on the floor', { x: 12, z: 12 }],
    ['on raised ground', { x: 5, z: 5 }],
  ])('lifts a speech balloon a gap above the head of a speaker %s', (_name, position) => {
    const scene = sceneWithGround();
    scene.placeEntity(player({ position }));

    scene.showSpeechBubble('self', ['Hallo'], 3000);

    // The bounds come from Float32 vertex data, hence the looser match.
    expect(scene._bubbleNodeFor('self')!.position.y).toBeCloseTo(CHARACTER_SCALE + 0.2, 6);
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
   * yaw on the node would tilt the name plaque and speech bubble with the character.
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
  /**
   * The bubble frame: the body grows a line at a time and the tail plus the two body
   * paddings are fixed, so the frame is `lines * 12 + 20`. The wrap step measures against the same
   * width, and a mismatch here overflows the balloon rather than failing anything.
   */
  it.each([
    [1, 32],
    [2, 44],
    [4, 68],
  ])('frames %i bubble line(s) at %ipx tall', (lines, height) => {
    expect(speechBubbleFrameSize(lines)).toEqual({ width: 150, height });
  });

  /** `max(lineCount, 1)`: an empty balloon still has a body rather than collapsing onto its tail. */
  it('never frames a bubble shorter than one line', () => {
    expect(speechBubbleFrameSize(0)).toEqual(speechBubbleFrameSize(1));
  });

  it.each([
    ['player', NAME_PLAQUE.playerBackground],
    ['peer', NAME_PLAQUE.playerBackground],
    ['npc', NAME_PLAQUE.npcBackground],
  ] as const)('gives a %s a plaque', (kind, background) => {
    expect(namePlaqueBackground(kind)).toBe(background);
  });

  it('gives a monster no plaque', () => {
    expect(namePlaqueBackground('monster')).toBeUndefined();
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
});

/**
 * GPU-resource lifetime. `removeFromParent()` leaves geometry, materials, and textures in
 * `WebGLRenderer`'s internal maps, so a long session of doors, border crossings, and peer churn
 * would accumulate VRAM until the context is lost. Nothing about that is visible in a graph
 * assertion, which is why these spy on `dispose` directly — and why they assert both directions:
 * freeing what this file allocated, and *not* freeing what the asset cache lent it.
 */
describe('GPU resource disposal', () => {
  /** A skinned model with its own skeleton, matching what `SkeletonUtils.clone` hands back. */
  function skinnedModel(): { root: THREE.Object3D; skeleton: THREE.Skeleton } {
    const bone = new THREE.Bone();
    const skeleton = new THREE.Skeleton([bone]);
    const mesh = new THREE.SkinnedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    mesh.add(bone);
    mesh.bind(skeleton);
    const root = new THREE.Object3D();
    root.add(mesh);
    return { root, skeleton };
  }

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

describe('speech bubbles are freed as they are replaced and expire', () => {
  /** Every mesh under an entity's live bubble node, which is where its own texture hangs. */
  function bubbleMeshes(scene: WorldScene): THREE.Mesh[] {
    const node = scene._bubbleNodeFor('self');
    if (node === undefined) return [];
    const found: THREE.Mesh[] = [];
    node.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) found.push(mesh);
    });
    return found;
  }

  function sceneWithEntity(): WorldScene {
    const scene = makeScene();
    scene.placeEntity(player());
    return scene;
  }

  /**
   * The highest-frequency allocator in the file: one supersampled `CanvasTexture` per chat line.
   * Nothing else reclaims them inside a space, so a bubble replaced without disposal leaks
   * unboundedly for as long as anyone is talking.
   */
  it('disposes the previous bubble when an entity speaks again', () => {
    const scene = sceneWithEntity();
    scene.showSpeechBubble('self', ['first'], 5000);
    const first = bubbleMeshes(scene);
    expect(first).toHaveLength(1);
    const geometryDispose = vi.spyOn(first[0]!.geometry, 'dispose');
    const material = first[0]!.material as THREE.MeshBasicMaterial;
    const mapDispose = vi.spyOn(material.map!, 'dispose');
    const materialDispose = vi.spyOn(material, 'dispose');

    scene.showSpeechBubble('self', ['second'], 5000);

    expect(geometryDispose).toHaveBeenCalled();
    expect(mapDispose).toHaveBeenCalled();
    expect(materialDispose).toHaveBeenCalled();
    // Replaced, not accumulated: one bubble per entity at a time.
    expect(bubbleMeshes(scene)).toHaveLength(1);
  });

  it('disposes a bubble when its lifetime runs out', () => {
    const scene = sceneWithEntity();
    scene.showSpeechBubble('self', ['fleeting'], 1000);
    const mesh = bubbleMeshes(scene)[0]!;
    const mapDispose = vi.spyOn((mesh.material as THREE.MeshBasicMaterial).map!, 'dispose');

    // Driven in whole frames rather than one long one: `tick` clamps each delta to `MAX_TICK_DELTA`,
    // so a single 1.5 s call advances the countdown by 0.1 s and the bubble would still be up.
    for (let elapsed = 0; elapsed <= 1; elapsed += MAX_TICK_DELTA) scene.tick(MAX_TICK_DELTA);

    expect(bubbleMeshes(scene)).toHaveLength(0);
    expect(mapDispose).toHaveBeenCalled();
  });

  it('disposes an outstanding bubble when its entity leaves', () => {
    const scene = sceneWithEntity();
    scene.showSpeechBubble('self', ['mid-sentence'], 5000);
    const mesh = bubbleMeshes(scene)[0]!;
    const mapDispose = vi.spyOn((mesh.material as THREE.MeshBasicMaterial).map!, 'dispose');

    scene.removeEntity('self');

    expect(bubbleMeshes(scene)).toHaveLength(0);
    expect(mapDispose).toHaveBeenCalled();
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
