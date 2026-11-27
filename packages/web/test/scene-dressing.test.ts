import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { ModelRegistry, WardrobeRow } from '@somnio/core';
import type { Outfit, Role } from '@somnio/protocol';
import { ClientWorld } from '@/client';
import type { ClientEntity } from '@/client';
import { DRESSING_BUDGET_MS, SECTOR_BUDGET_MS, SECTOR_STEP_MS, WorldScene } from '@/scene/worldScene';
import type { ModelAssets } from '@/scene/modelAssets';
import { COMBAT_EFFECTS_NAME } from '@/scene/combatEffects';
import { CHARACTER_SCALE } from '@/scene/placement';
import { BAKED_OUTFIT, WARDROBE_STEP_MS } from '@/scene/wardrobe';
import type { PortraitSubject } from '@/scene/portraits';
import type * as Wardrobe from '@/scene/wardrobe';
import { TEST_REGISTRY, outdoorSector } from '../../core/test/support/worldFixture.ts';
import { clientEntity, outfit } from './helpers/worldFixture';
import { recordingCompiler } from './helpers/programVariants';

/**
 * The scene's clock, which each wardrobe call moves on by its worst case, as if every call took the
 * longest it may, or by `slowPrepare` for a preparation where a test sets it. A texture copied into
 * its layer moves it on by the copy's worst case, and a placement built by its worst case, or by
 * `slowBuild` where a test sets it. `joins` counts the bakes.
 */
const work = vi.hoisted(() => ({ ms: 0, slowPrepare: undefined as number | undefined, slowBuild: undefined as number | undefined, joins: 0 }));

vi.mock('@/scene/wardrobe', async (importOriginal) => {
  const actual = await importOriginal<typeof Wardrobe>();
  class TimedTextures extends actual.WardrobeTextures {
    override place(texture: THREE.Texture): number | undefined {
      if (this.unplaced(new THREE.Mesh(undefined, new THREE.MeshStandardMaterial({ map: texture }))).length > 0) work.ms += actual.WARDROBE_STEP_MS.copy;
      return super.place(texture);
    }
  }
  return {
    ...actual,
    WardrobeTextures: TimedTextures,
    preparePiece: (...args: Parameters<typeof actual.preparePiece>) => {
      if (!actual.isPrepared(...args)) work.ms += work.slowPrepare ?? actual.WARDROBE_STEP_MS.prepare;
      return actual.preparePiece(...args);
    },
    bakeOutfit: (parts: Parameters<typeof actual.bakeOutfit>[0]) => {
      work.ms += actual.WARDROBE_STEP_MS.join;
      work.joins += 1;
      return actual.bakeOutfit(parts);
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.assign(work, { ms: 0, slowPrepare: undefined, slowBuild: undefined, joins: 0 });
  TUNIC_IMAGE.close.mockClear();
  MANTLE_IMAGE.close.mockClear();
});

const HAIR_FIT = 'Hayfield courier';
const SOPORS: [number, number, number] = [1.27, 1.18, 1.13];

/**
 * A cap that tucks the hair and a tall hat over it, a tunic over the torso at tiers 1 and 3 and the Healers' at tier 3,
 * boots with a strap no body can carry, and a mantle, worn alike by every people.
 */
const WARDROBE: WardrobeRow[] = [
  { base: 'cap', tier: 1, ground: 'GroundCap', covers: [], hairFit: HAIR_FIT, wear: { default: 'WearCap' } },
  { base: 'cap', tier: 2, ground: 'GroundCapT2', covers: [], wear: { default: 'WearTallHat' } },
  { base: 'tunic', tier: 1, ground: 'GroundTunic', covers: ['Torso'], wear: { default: 'WearTunic' } },
  { base: 'tunic', tier: 3, ground: 'GroundTunicT3', covers: ['Torso'], wear: { default: 'WearTunicT3' } },
  { base: 'tunic', tier: 3, line: 'healer', ground: 'GroundTunicHealerT3', covers: ['Torso'], wear: { default: 'WearTunicHealerT3' } },
  { base: 'boots', tier: 1, ground: 'GroundBoots', covers: ['ThighL'], wear: { default: 'WearTornBoots' } },
  { base: 'shoulders', tier: 1, ground: 'GroundShoulders', covers: [], wear: { default: 'WearMantle' } },
];

/** The images the tier-3 tunic's map and the mantle's draw, each closed once its layer holds it. */
const TUNIC_IMAGE = { width: 4, height: 4, close: vi.fn() };
const MANTLE_IMAGE = { width: 4, height: 4, close: vi.fn() };

const REGISTRY: ModelRegistry = {
  ...TEST_REGISTRY,
  peoples: TEST_REGISTRY.peoples.map((rule) => (rule.people === 'sopors' ? { ...rule, scale: SOPORS } : rule)),
  wardrobe: WARDROBE,
};

/** A rig as the pack's: hips, a head a metre up, and the main hand's slot, under a root of its own. */
function rig(headTurn = 0): { root: THREE.Object3D; bones: THREE.Bone[] } {
  const root = new THREE.Object3D();
  const hips = Object.assign(new THREE.Bone(), { name: 'hips' });
  const head = Object.assign(new THREE.Bone(), { name: 'head' });
  const hand = Object.assign(new THREE.Bone(), { name: 'handslotr' });
  head.position.y = 1;
  // As the pack's head bones are, turned at rest.
  head.rotation.z = headTurn;
  hand.position.set(-0.3, 0.5, 0);
  hips.add(head, hand);
  root.add(hips);
  return { root, bones: [hips, head, hand] };
}

/** A skinned mesh named `name` over `geometry`, each vertex weighted between the hips and the head by its height, bound where it stands with the rig at rest. */
function skinned(name: string, root: THREE.Object3D, bones: THREE.Bone[], geometry: THREE.BufferGeometry): THREE.SkinnedMesh {
  const positions = geometry.getAttribute('position');
  const indices: number[] = [];
  const weights: number[] = [];
  for (let vertex = 0; vertex < positions.count; vertex++) {
    const up = THREE.MathUtils.clamp(positions.getY(vertex), 0, 1);
    indices.push(0, 1, 0, 0);
    weights.push(1 - up, up, 0, 0);
  }
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial());
  mesh.name = name;
  root.add(mesh);
  root.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones));
  return mesh;
}

/** The body every dreamer is drawn in: a torso, a crown of hair that the cap's fit tucks 0.1 down (exported at full weight), and a leg, each of its own vertex count. */
function bodyPrototype(headTurn = 0): THREE.Object3D {
  const { root, bones } = rig(headTurn);
  skinned('Torso', root, bones, new THREE.BoxGeometry(0.4, 0.7, 0.3, 1, 3, 1).translate(0, 0.45, 0));
  const crown = new THREE.BoxGeometry(0.3, 0.1, 0.3).translate(0, 0.95, 0);
  const tuck = new THREE.Float32BufferAttribute(Array.from({ length: crown.getAttribute('position').count }, () => [0, -0.1, 0]).flat(), 3);
  crown.morphAttributes['position'] = [tuck];
  crown.morphTargetsRelative = true;
  const mesh = skinned('Crown', root, bones, crown);
  mesh.morphTargetDictionary = { [HAIR_FIT]: 0 };
  // As the pack exports it, at full weight.
  mesh.morphTargetInfluences = [1];
  skinned('ThighL', root, bones, new THREE.BoxGeometry(0.1, 0.1, 0.1, 2, 1, 1).translate(0.1, 0.05, 0));
  return root;
}

/**
 * A worn piece on a rig of its own, as the pack publishes one: a cap low on the head, under the
 * crown's top, a hat from the crown's top to 1.3 m, a tunic round the torso, the tier-3 one drawn
 * from an image, a mantle on the shoulders drawn from another, or boots whose second mesh is skinned
 * to a joint no body has.
 */
function piecePrototype(stem: string): THREE.Object3D {
  const { root, bones } = rig();
  const geometry =
    stem === 'WearCap'
      ? new THREE.BoxGeometry(0.35, 0.05, 0.35, 3, 1, 1).translate(0, 0.8, 0)
      : stem === 'WearTallHat'
        ? new THREE.BoxGeometry(0.35, 0.3, 0.35).translate(0, 1.15, 0)
        : stem === 'WearTornBoots'
          ? new THREE.BoxGeometry(0.12, 0.1, 0.12).translate(0.1, 0.05, 0)
          : stem === 'WearMantle'
            ? new THREE.BoxGeometry(0.5, 0.08, 0.3).translate(0, 0.78, 0)
            : new THREE.BoxGeometry(0.45, 0.6, 0.35, 2, 2, 2).translate(0, 0.45, 0);
  const mesh = skinned(stem, root, bones, geometry);
  if (stem === 'WearTunicT3') mesh.material = new THREE.MeshStandardMaterial({ map: Object.assign(new THREE.Texture(TUNIC_IMAGE), { name: 'tunic-atlas' }) });
  if (stem === 'WearMantle') mesh.material = new THREE.MeshStandardMaterial({ map: Object.assign(new THREE.Texture(MANTLE_IMAGE), { name: 'mantle-atlas' }) });
  if (stem === 'WearTornBoots') {
    const tail = Object.assign(new THREE.Bone(), { name: 'tail' });
    skinned('BootStrap', root, [tail, ...bones.slice(1)], new THREE.BoxGeometry(0.05, 0.05, 0.05).translate(-0.1, 0.05, 0));
  }
  return root;
}

/** A 2D context for the wardrobe's 512 px canvas alone, which copies a grey image, so a texture finds its layer. */
function stubCanvas(): void {
  const context = {
    globalCompositeOperation: 'source-over',
    drawImage: () => {},
    getImageData: (_x: number, _y: number, width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4).fill(200) }),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return (this.width === 512 && this.height === 512 ? context : null) as never;
  });
}

/** How many vertices the worn piece of `stem` has. */
function pieceVertices(stem: string): number {
  return vertexCount(piecePrototype(stem).getObjectByName(stem) as THREE.Mesh);
}

/** How many vertices the regions of the body named have between them. */
function regionVertices(model: THREE.Object3D, ...names: string[]): number {
  return names.reduce((sum, name) => sum + vertexCount(region(model, name)), 0);
}

/** A worn piece's load, held until the test lets it come (`load`) or fail (`fail`). */
interface HeldLoad {
  promise: Promise<THREE.Object3D | undefined>;
  settle: (model: THREE.Object3D | undefined) => void;
}

/**
 * A scene whose dreamers are clones of one body, as the cache's are, with each worn piece's load held
 * until the test settles it. `models` holds each body given, in the order asked for. Its clock is
 * `work`, which the wardrobe's calls move on. With `sectors`, it is the game's scene,
 * which spreads the sectors it is given over frames, and each placement built moves the clock on too.
 */
function dressingScene(options: { character?: boolean; ground?: ModelAssets['ground']; headTurn?: number; idleRise?: number; sectors?: boolean } = {}) {
  const prototype = bodyPrototype(options.headTurn);
  const models: THREE.Object3D[] = [];
  const loads = new Map<string, HeldLoad>();
  const held = (stem: string): HeldLoad => {
    let load = loads.get(stem);
    if (load === undefined) {
      let settle!: HeldLoad['settle'];
      const promise = new Promise<THREE.Object3D | undefined>((resolve) => (settle = resolve));
      load = { promise, settle };
      loads.set(stem, load);
    }
    return load;
  };
  const assets: ModelAssets = {
    prewarm: async () => {},
    character: () => {
      if (options.character === false) return undefined;
      const model = cloneSkinned(prototype);
      models.push(model);
      return model;
    },
    hand: (baseId) => Object.assign(new THREE.Object3D(), { name: baseId }),
    ground: options.ground ?? (() => undefined),
    trophy: () => undefined,
    object: () => {
      if (options.sectors !== true) return undefined;
      work.ms += work.slowBuild ?? SECTOR_STEP_MS.build;
      return new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0));
    },
    wear: (stem) => held(stem).promise,
    retryWear: () => {},
    clipsFor: () => (options.idleRise === undefined ? [] : [idleClip(options.idleRise)]),
    prototypeMeshes: (id) =>
      options.sectors === true && id === 'box'
        ? [{ geometry: new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), material: new THREE.MeshBasicMaterial(), matrix: new THREE.Matrix4() }]
        : undefined,
  };
  const scene = new WorldScene(assets, REGISTRY, 1, false, () => work.ms, { rasterize: () => {} });
  scene.spreadSectors = options.sectors === true;
  const wear = vi.spyOn(assets, 'wear');
  const retryWear = vi.spyOn(assets, 'retryWear');
  /** Lets the piece of `stem` come, then lets its arrival be handled. */
  const load = async (stem: string): Promise<void> => {
    held(stem).settle(piecePrototype(stem));
    await settled();
  };
  const fail = async (stem: string): Promise<void> => {
    held(stem).settle(undefined);
    await settled();
  };
  return { scene, models, wear, retryWear, load, fail };
}

/** An idle that holds the head `rise` above where the rig rests it, so the idle pose is not the bind pose. */
function idleClip(rise: number): THREE.AnimationClip {
  return new THREE.AnimationClip('Idle', 1, [new THREE.VectorKeyframeTrack('head.position', [0, 1], [0, 1 + rise, 0, 0, 1 + rise, 0])]);
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function dreamer(id: string, worn: Outfit, overrides: Partial<ClientEntity> = {}): ClientEntity {
  return clientEntity({ id, kind: id === 'self' ? 'player' : 'peer', name: id, people: 'vigils', outfit: worn, ...overrides });
}

/** Ticks until nothing is queued to dress, at most `frames` times, and answers how much of the wardrobe's work each tick did, to a nanosecond. */
function dressAll(scene: WorldScene, frames = 100): number[] {
  const spent: number[] = [];
  for (let frame = 0; frame < frames && hasQueue(scene); frame++) {
    const before = work.ms;
    scene.tick(0.01);
    spent.push(Number((work.ms - before).toFixed(9)));
  }
  return spent;
}

function hasQueue(scene: WorldScene): boolean {
  return (scene as unknown as { dressing: Map<string, unknown> }).dressing.size > 0;
}

/** The mesh a body's model is dressed as, or `undefined` while it is drawn as its own meshes. */
function bakeOf(model: THREE.Object3D): THREE.SkinnedMesh | undefined {
  return model.getObjectByName(BAKED_OUTFIT) as THREE.SkinnedMesh | undefined;
}

/** The skinned meshes under a model that draw, each of them and every ancestor visible. */
function drawnSkinned(model: THREE.Object3D): THREE.SkinnedMesh[] {
  const drawn: THREE.SkinnedMesh[] = [];
  model.traverseVisible((object) => {
    if ((object as THREE.SkinnedMesh).isSkinnedMesh) drawn.push(object as THREE.SkinnedMesh);
  });
  return drawn;
}

function region(model: THREE.Object3D, name: string): THREE.SkinnedMesh {
  return model.getObjectByName(name) as THREE.SkinnedMesh;
}

function vertexCount(mesh: THREE.Mesh): number {
  return mesh.geometry.getAttribute('position').count;
}

/** Each vertex of a skinned mesh where it is drawn, posed by its skeleton. */
function posed(mesh: THREE.SkinnedMesh): THREE.Vector3[] {
  return Array.from({ length: vertexCount(mesh) }, (_, vertex) => mesh.getVertexPosition(vertex, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld));
}

describe('dressing a body', () => {
  it("draws a dreamer at their people's scale and a nightmare at the plain one", () => {
    const { scene, models } = dressingScene();
    scene.placeEntity(dreamer('peer-1', [], { people: 'sopors' }));
    scene.placeEntity(clientEntity({ id: 'monster:1', kind: 'monster', name: 'skeleton' }));

    expect(models[0]!.parent!.scale.toArray()).toEqual(SOPORS.map((axis) => axis * CHARACTER_SCALE));
    expect(models[1]!.parent!.scale.toArray()).toEqual([CHARACTER_SCALE, CHARACTER_SCALE, CHARACTER_SCALE]);
  });

  it('draws a dressed dreamer as one skinned mesh under its model, with no groups, casting and taking shadows', async () => {
    const { scene, models, load } = dressingScene();
    scene.placeEntity(dreamer('self', outfit({ head: 'cap', chest: 'tunic' })));
    await load('WearCap');
    await load('WearTunic');
    dressAll(scene);

    const [mesh, ...others] = drawnSkinned(models[0]!);
    expect(others).toEqual([]);
    expect([mesh!.name, mesh!.parent, mesh!.geometry.groups, mesh!.castShadow, mesh!.receiveShadow]).toEqual([BAKED_OUTFIT, models[0], [], true, true]);
    expect(vertexCount(mesh!)).toBe(pieceVertices('WearCap') + pieceVertices('WearTunic') + regionVertices(models[0]!, 'Crown', 'ThighL'));
  });

  it('frames the portraits to the top of a hat standing above the head, as far again over the head as the hat stands', async () => {
    const { scene, load } = dressingScene();
    scene.placeEntity(dreamer('self', [{ slot: 'head', baseId: 'cap', tier: 2 }]));
    const subject = (): PortraitSubject => (scene as unknown as { portraitSubjectOf(id: string): PortraitSubject }).portraitSubjectOf('self');
    const bare = subject();

    await load('WearTallHat');
    dressAll(scene);
    const hatted = subject();

    // The body stands from its feet to the crown's top at 1 m, and the hat to 1.3 m.
    expect(hatted.height / bare.height).toBeCloseTo(1.3, 5);
    expect(hatted.head.y - bare.head.y).toBeCloseTo(0.3 * bare.height, 5);
  });

  it('keeps the baked mesh through a change of the hands alone, and a piece still loading meanwhile appears once it comes', async () => {
    const { scene, models, load } = dressingScene();
    scene.placeEntity(dreamer('self', outfit({ mainHand: 'sword', chest: 'tunic' })));
    dressAll(scene);
    const bake = bakeOf(models[0]!)!;
    expect(vertexCount(bake)).toBe(regionVertices(models[0]!, 'Torso', 'Crown', 'ThighL'));

    scene.updateOutfit('self', outfit({ mainHand: 'mace', chest: 'tunic' }));
    dressAll(scene);
    expect(bakeOf(models[0]!)).toBe(bake);
    expect(models[0]!.getObjectByName('handslotr')!.children.map(({ name }) => name)).toEqual(['mace']);

    await load('WearTunic');
    dressAll(scene);
    expect(region(models[0]!, 'Torso').visible).toBe(false);
    expect(vertexCount(bakeOf(models[0]!)!)).toBe(pieceVertices('WearTunic') + regionVertices(models[0]!, 'Crown', 'ThighL'));
  });

  it('leaves out the regions a piece covers, and takes them back once the slot is emptied', async () => {
    const { scene, models, load } = dressingScene();
    scene.placeEntity(dreamer('self', outfit({ chest: 'tunic' })));
    await load('WearTunic');
    dressAll(scene);
    expect([region(models[0]!, 'Torso').visible, vertexCount(bakeOf(models[0]!)!)]).toEqual([
      false,
      pieceVertices('WearTunic') + regionVertices(models[0]!, 'Crown', 'ThighL'),
    ]);

    scene.updateOutfit('self', []);
    dressAll(scene);

    expect(vertexCount(bakeOf(models[0]!)!)).toBe(regionVertices(models[0]!, 'Torso', 'Crown', 'ThighL'));
  });

  it('leaves a region a failed piece would cover drawn, and the hair untucked under a failed cap', async () => {
    const { scene, models, load, fail } = dressingScene();
    scene.placeEntity(dreamer('self', outfit({ head: 'cap', chest: 'tunic' })));
    await fail('WearTunic');
    await load('WearCap');
    dressAll(scene);
    const crownTop = (): number =>
      new THREE.Box3().setFromBufferAttribute(bakeOf(models[0]!)!.geometry.getAttribute('position') as THREE.BufferAttribute).max.y;
    expect(vertexCount(bakeOf(models[0]!)!)).toBe(pieceVertices('WearCap') + regionVertices(models[0]!, 'Torso', 'Crown', 'ThighL'));
    expect(crownTop()).toBeCloseTo(0.9, 6);

    const capless = dressingScene();
    capless.scene.placeEntity(dreamer('self', outfit({ head: 'cap' })));
    await capless.fail('WearCap');
    dressAll(capless.scene);
    expect(new THREE.Box3().setFromBufferAttribute(bakeOf(capless.models[0]!)!.geometry.getAttribute('position') as THREE.BufferAttribute).max.y).toBeCloseTo(
      1,
      6,
    );
  });

  it('joins nothing of a piece one of whose meshes fails, and leaves the region it would cover drawn', async () => {
    const { scene, models, load } = dressingScene();
    scene.placeEntity(dreamer('self', outfit({ feet: 'boots' })));
    await load('WearTornBoots');
    dressAll(scene);

    expect(vertexCount(bakeOf(models[0]!)!)).toBe(regionVertices(models[0]!, 'Torso', 'Crown', 'ThighL'));
    expect(scene.ownBodyDressed()).toBe(true);
  });

  it('frames the portraits to a hat as it stands in the idle pose, however the body lies, moves, or is posed, and again for each bake', async () => {
    const { scene, models, load } = dressingScene();
    const subject = (): PortraitSubject => (scene as unknown as { portraitSubjectOf(id: string): PortraitSubject }).portraitSubjectOf('self');
    const node = (): THREE.Object3D => (scene as unknown as { entityStates: Map<string, { node: THREE.Object3D }> }).entityStates.get('self')!.node;
    // A body that comes into view fallen, its head bowed to the ground as a fall leaves it.
    scene.placeEntity(dreamer('self', [{ slot: 'head', baseId: 'cap', tier: 2 }], { condition: 'fallen' }));
    const bare = subject().height;
    const head = models[0]!.getObjectByName('head')!;
    head.rotation.x = Math.PI / 2;
    await load('WearTallHat');
    dressAll(scene);
    expect(subject().height / bare).toBeCloseTo(1.3, 5);

    // Raised onto higher ground, the first frame still bowed from the fall.
    scene.updateCondition('self', 'hale');
    node().position.y += 1;
    expect(subject().height / bare).toBeCloseTo(1.3, 5);
    head.rotation.x = 0;
    scene.updateCondition('self', 'fallen');
    expect(subject().height / bare).toBeCloseTo(1.3, 5);

    // The low cap stands under the crown's top.
    scene.updateOutfit('self', outfit({ head: 'cap' }));
    await load('WearCap');
    dressAll(scene);
    expect(subject().height / bare).toBeCloseTo(1, 5);
  });

  it('measures a hat in the idle pose the head is measured in, not where the rig rests', async () => {
    const { scene, load } = dressingScene({ idleRise: 0.2 });
    const subject = (): PortraitSubject => (scene as unknown as { portraitSubjectOf(id: string): PortraitSubject }).portraitSubjectOf('self');
    scene.placeEntity(dreamer('self', [{ slot: 'head', baseId: 'cap', tier: 2 }]));
    // The crown's top, lifted with the head.
    const bare = subject().height;
    expect(bare).toBeCloseTo(1.2 * CHARACTER_SCALE, 5);
    await load('WearTallHat');
    dressAll(scene);
    // The hat's top, 1.3 m on the rig, lifted with the head too.
    expect(subject().height / bare).toBeCloseTo(1.5 / 1.2, 5);
  });

  it("frames a dreamer's head along the way it points, standing on a head bone turned at rest, and lying with its head bowed", () => {
    const { scene, models } = dressingScene({ headTurn: 0.7 });
    const subject = (): PortraitSubject => (scene as unknown as { portraitSubjectOf(id: string): PortraitSubject }).portraitSubjectOf('self');
    scene.placeEntity(dreamer('self', []));
    const head = models[0]!.getObjectByName('head')!;
    const bone = (): THREE.Vector3 => {
      models[0]!.updateMatrixWorld(true);
      return head.getWorldPosition(new THREE.Vector3());
    };
    const standing = subject();
    expect([standing.headUp!.x, standing.headUp!.y, standing.headUp!.z]).toEqual([expect.closeTo(0, 6), expect.closeTo(1, 6), expect.closeTo(0, 6)]);
    expect(standing.head.y).toBeCloseTo(bone().y + standing.headSpan!, 6);

    // Bowed a quarter turn forward, as a body lying on its face holds it.
    head.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2));
    const at = bone();
    const lying = subject();
    expect([lying.headUp!.x, lying.headUp!.y, lying.headUp!.z]).toEqual([expect.closeTo(0, 6), expect.closeTo(0, 6), expect.closeTo(1, 6)]);
    expect(new THREE.Vector3().copy(lying.head).sub(at).length()).toBeCloseTo(standing.headSpan!, 6);
  });

  it("frames a standing Sopor's head straight up however the body has turned since it was put in, its people's uneven scale and all", () => {
    const { scene } = dressingScene({ headTurn: 0.7 });
    const subject = (): PortraitSubject => (scene as unknown as { portraitSubjectOf(id: string): PortraitSubject }).portraitSubjectOf('self');
    const holder = (): THREE.Object3D =>
      (scene as unknown as { entityStates: Map<string, { modelHolder: THREE.Object3D }> }).entityStates.get('self')!.modelHolder;
    scene.placeEntity(dreamer('self', [], { people: 'sopors' }));
    expect(holder().scale.x).not.toBeCloseTo(holder().scale.y, 2);

    for (const yaw of [1.1, 2.5, -0.6]) {
      holder().rotation.y = yaw;
      const { headUp } = subject();
      expect([headUp!.x, headUp!.y, headUp!.z]).toEqual([expect.closeTo(0, 6), expect.closeTo(1, 6), expect.closeTo(0, 6)]);
    }
  });

  it('draws a body bare of the hair fits its model carries at full weight, as its bake joins it', () => {
    const { scene, models } = dressingScene();
    scene.placeEntity(dreamer('peer-1', []));
    expect(region(models[0]!, 'Crown').morphTargetInfluences).toEqual([0]);
  });

  it('counts a body that wears nothing and has its bake queued as shown, but the scene as not settled until it is joined', () => {
    const { scene } = dressingScene();
    scene.placeEntity(dreamer('self', []));
    expect([scene.ownBodyDressed(), scene.isSettled()]).toEqual([true, false]);
    dressAll(scene);
    expect([scene.ownBodyDressed(), scene.isSettled()]).toEqual([true, true]);
  });

  it('counts a body that wears nothing as dressed before its bake, and one that took everything off as not, until it is joined again', async () => {
    const { scene, models, load } = dressingScene();
    scene.placeEntity(dreamer('self', []));
    expect([scene.ownBodyDressed(), bakeOf(models[0]!)]).toEqual([true, undefined]);

    scene.updateOutfit('self', outfit({ chest: 'tunic' }));
    await load('WearTunic');
    dressAll(scene);
    scene.updateOutfit('self', []);
    expect(scene.ownBodyDressed()).toBe(false);

    dressAll(scene);
    expect(scene.ownBodyDressed()).toBe(true);
  });

  it('counts a placeholder body as dressed, and a dreamer whose pieces still load as not yet', () => {
    const placeholder = dressingScene({ character: false });
    placeholder.scene.placeEntity(dreamer('self', outfit({ chest: 'tunic' })));
    expect(placeholder.wear).not.toHaveBeenCalled();
    expect(placeholder.scene.isSettled()).toBe(true);

    const { scene } = dressingScene();
    scene.placeEntity(dreamer('self', outfit({ chest: 'tunic' })));
    dressAll(scene);
    expect(scene.isSettled()).toBe(false);
  });

  it('shows the player dressed as a new space is revealed when everything they wear is loaded', async () => {
    const { scene, models, load } = dressingScene();
    scene.placeEntity(dreamer('self', outfit({ chest: 'tunic' })));
    await load('WearTunic');
    dressAll(scene);

    scene.enterSpace(new ClientWorld('EdariaInn', REGISTRY));
    scene.placeEntity(dreamer('self', outfit({ chest: 'tunic' })));

    const model = models[1]!;
    expect(drawnSkinned(model)).toEqual([bakeOf(model)]);
    expect(vertexCount(bakeOf(model)!)).toBe(pieceVertices('WearTunic') + regionVertices(model, 'Crown', 'ThighL'));
    expect(scene.isSettled()).toBe(true);
  });

  it('poses a body dressed again mid-animation as its own meshes would be posed', async () => {
    const { scene, models, load } = dressingScene();
    scene.placeEntity(dreamer('self', [], { people: 'sopors' }));
    dressAll(scene);
    const model = models[0]!;
    const [hips, head] = ['hips', 'head'].map((name) => model.getObjectByName(name)!);
    hips!.rotation.y = 0.5;
    hips!.position.x = 0.2;
    head!.rotation.z = 0.6;

    scene.updateOutfit('self', outfit({ head: 'cap' }));
    await load('WearCap');
    dressAll(scene);

    model.updateMatrixWorld(true);
    // The bake joins the cap, then the torso, the crown, and the leg; the crown is tucked under the cap, so only the torso and the leg are posed alike.
    const drawn = posed(bakeOf(model)!).slice(pieceVertices('WearCap'));
    const torso = regionVertices(model, 'Torso');
    const alike = [...drawn.slice(0, torso), ...drawn.slice(torso + regionVertices(model, 'Crown'))];
    const expected = [...posed(region(model, 'Torso')), ...posed(region(model, 'ThighL'))];
    expect(alike).toHaveLength(expected.length);
    for (const [vertex, position] of alike.entries()) expect(position.distanceTo(expected[vertex]!)).toBeLessThan(1e-6);
    expect(expected[0]!.distanceTo(new THREE.Vector3().fromBufferAttribute(region(model, 'Torso').geometry.getAttribute('position'), 0))).toBeGreaterThan(0.1);
  });

  it('spreads dressing over frames: a join behind a preparation waits for the next frame, and no frame spends past the budget', async () => {
    const { scene, models, load } = dressingScene();
    scene.placeEntity(dreamer('self', []));
    const first = dressAll(scene);
    // Three preparations fill a frame, so the join comes on a frame of its own.
    expect(first).toEqual([Number((3 * WARDROBE_STEP_MS.prepare).toFixed(9)), WARDROBE_STEP_MS.join]);

    for (let index = 0; index < 10; index++) scene.placeEntity(dreamer(`peer-${index}`, outfit({ chest: 'tunic' })));
    await load('WearTunic');
    const spent = dressAll(scene);
    expect(models.slice(1).map((model) => vertexCount(bakeOf(model)!))).toEqual(
      models.slice(1).map((model) => pieceVertices('WearTunic') + regionVertices(model, 'Crown', 'ThighL')),
    );
    // The tunic is prepared once for all ten, which share the body's model, and each joins in a frame of its own.
    expect(spent).toEqual([WARDROBE_STEP_MS.prepare, ...Array<number>(10).fill(WARDROBE_STEP_MS.join)]);
    expect(Math.max(...spent)).toBeLessThanOrEqual(DRESSING_BUDGET_MS);
  });

  /** Three boxes of a metre standing at (10, 10) of a sector whose origin is `origin`. */
  const boxes = (name: string, origin: { x: number; z: number }) =>
    outdoorSector(name, origin, { placements: [0, 1, 2].map((index) => ({ id: `box-${index}`, modelId: 'box', x: 10, z: 10, yaw: 0, elevation: 0 })) });

  it("measures a frame's dressing from where the sectors' work began, which stops at its own budget", () => {
    const { scene } = dressingScene({ sectors: true });
    scene.placeEntity(dreamer('self', []));
    // 50 m east of the player, beyond what the view could show.
    scene.addSector(boxes('FarMeadow', { x: 60, z: 0 }));

    const before = work.ms;
    scene.tick(0.01);

    // The builds that fill the sectors' slice, then as many of the three preparations as the rest of the loading budget holds.
    const sectors = Math.floor(SECTOR_BUDGET_MS / SECTOR_STEP_MS.build) * SECTOR_STEP_MS.build;
    const preparations = Math.floor((DRESSING_BUDGET_MS - sectors) / WARDROBE_STEP_MS.prepare);
    expect(preparations).toBeLessThan(3);
    expect(Number((work.ms - before).toFixed(9))).toBe(Number((sectors + preparations * WARDROBE_STEP_MS.prepare).toFixed(9)));
  });

  it("still takes a frame's first dressing step after the sectors' work ran long", () => {
    const { scene } = dressingScene({ sectors: true });
    scene.placeEntity(dreamer('self', []));
    scene.addSector(boxes('FarMeadow', { x: 60, z: 0 }));
    work.slowBuild = DRESSING_BUDGET_MS;

    const before = work.ms;
    scene.tick(0.01);

    expect(Number((work.ms - before).toFixed(9))).toBe(Number((DRESSING_BUDGET_MS + WARDROBE_STEP_MS.prepare).toFixed(9)));
  });

  it('holds a join back in a frame that built a sector the view could show', () => {
    const { scene } = dressingScene({ sectors: true });
    scene.placeEntity(dreamer('self', []));
    // The three preparations, leaving the join at the head of the queue.
    scene.tick(0.01);
    expect(work.joins).toBe(0);
    // Under the player, so it is built whole before the next render, and long enough to leave no room for the join.
    work.slowBuild = DRESSING_BUDGET_MS;
    scene.addSector(boxes('Square', { x: 0, z: 0 }));

    scene.tick(0.01);
    expect(work.joins).toBe(0);
    scene.tick(0.01);
    expect(work.joins).toBe(1);
  });

  it("copies each piece's image into its layer as a step of its own within the budget, and then lets go of the image", async () => {
    stubCanvas();
    const { scene, models, load } = dressingScene();
    scene.placeEntity(dreamer('self', []));
    dressAll(scene);
    scene.updateOutfit('self', [
      { slot: 'shoulders', baseId: 'shoulders', tier: 1 },
      { slot: 'chest', baseId: 'tunic', tier: 3 },
    ]);
    await load('WearMantle');
    await load('WearTunicT3');
    expect([MANTLE_IMAGE.close.mock.calls.length, TUNIC_IMAGE.close.mock.calls.length]).toEqual([0, 0]);

    const spent = dressAll(scene);

    // A copy, a preparation, and the second copy fill the first frame; the second preparation waits for the next.
    const { copy, prepare, join } = WARDROBE_STEP_MS;
    expect(spent).toEqual([Number((copy + prepare + copy).toFixed(9)), prepare, join]);
    expect(Math.max(...spent)).toBeLessThanOrEqual(DRESSING_BUDGET_MS);
    expect(vertexCount(bakeOf(models[0]!)!)).toBe(pieceVertices('WearMantle') + pieceVertices('WearTunicT3') + regionVertices(models[0]!, 'Crown', 'ThighL'));
    expect([MANTLE_IMAGE.close.mock.calls.length, TUNIC_IMAGE.close.mock.calls.length]).toEqual([1, 1]);
  });

  it('keeps the base clothes under a piece whose image finds no layer', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const { scene, models, load } = dressingScene();
    scene.placeEntity(dreamer('self', [{ slot: 'chest', baseId: 'tunic', tier: 3 }]));
    await load('WearTunicT3');
    dressAll(scene);

    expect(vertexCount(bakeOf(models[0]!)!)).toBe(regionVertices(models[0]!, 'Torso', 'Crown', 'ThighL'));
    expect(TUNIC_IMAGE.close).toHaveBeenCalledOnce();
  });

  it("dresses a dreamer in a set piece's own design, and again in the neutral one once only the line changes", async () => {
    const { scene, models, wear, load } = dressingScene();
    scene.placeEntity(dreamer('peer-1', [{ slot: 'chest', baseId: 'tunic', tier: 3, line: 'healer' }]));
    expect(wear.mock.calls).toEqual([['WearTunicHealerT3']]);
    await load('WearTunicHealerT3');
    dressAll(scene);
    expect(vertexCount(bakeOf(models[0]!)!)).toBe(pieceVertices('WearTunicHealerT3') + regionVertices(models[0]!, 'Crown', 'ThighL'));

    scene.updateOutfit('peer-1', [{ slot: 'chest', baseId: 'tunic', tier: 3 }]);
    expect(wear.mock.calls.at(-1)).toEqual(['WearTunicT3']);
  });

  it('dresses the local player before the dreamers queued ahead of them', async () => {
    const { scene, models, load } = dressingScene();
    for (let index = 0; index < 3; index++) scene.placeEntity(dreamer(`peer-${index}`, outfit({ chest: 'tunic' })));
    scene.placeEntity(dreamer('self', outfit({ chest: 'tunic' })));
    await load('WearTunic');

    // The tunic, the crown, and the leg are prepared once for every body, which share one model, and the local player joins first.
    dressAll(scene, 2);

    expect(models.map((model) => bakeOf(model) !== undefined)).toEqual([false, false, false, true]);
  });

  /** A program compiled on its first draw stalls the frame it draws in. */
  it("compiles a dressed body's program and each design's drop past tier 1 and each line's in the prewarm", async () => {
    // A drop of its own material type for each tier and for the line, so each is a program of its own.
    const lying = (tier: number, line: Role | undefined): THREE.Object3D =>
      new THREE.Group().add(
        new THREE.Mesh(
          new THREE.BoxGeometry(0.3, 0.1, 0.3),
          line !== undefined ? new THREE.MeshPhongMaterial() : tier === 1 ? new THREE.MeshLambertMaterial() : new THREE.MeshToonMaterial(),
        ),
      );
    const { scene, models, load } = dressingScene({ ground: (_baseId, tier, line) => lying(tier, line) });
    const { compileAsync, uncompiled } = recordingCompiler();
    await scene.prewarm({ compileAsync });

    scene.placeEntity(dreamer('self', outfit({ chest: 'tunic' })));
    await load('WearTunic');
    dressAll(scene);
    scene.showLoot({ lootId: 'tunic', x: 1, z: 1, contents: { kind: 'item', baseId: 'tunic', tier: 3, rarity: 'common' } });
    scene.showLoot({ lootId: 'stole', x: 2, z: 1, contents: { kind: 'item', baseId: 'tunic', tier: 3, rarity: 'epic', line: 'healer' } });
    scene.tick(0.016);

    expect(bakeOf(models.at(-1)!)).toBeDefined();
    expect(uncompiled(scene.scene)).toEqual([]);
  });

  it("runs a frame's first step however long the steps before it ran", () => {
    work.slowPrepare = 2 * DRESSING_BUDGET_MS;
    const { scene, models } = dressingScene();
    scene.placeEntity(dreamer('self', []));

    expect(dressAll(scene)).toEqual([2 * DRESSING_BUDGET_MS, 2 * DRESSING_BUDGET_MS, 2 * DRESSING_BUDGET_MS, WARDROBE_STEP_MS.join]);
    expect(bakeOf(models[0]!)).toBeDefined();
  });

  it('bakes nothing for a body queued to dress that has left view, nor for a piece that comes after it', async () => {
    const { scene, load } = dressingScene();
    scene.placeEntity(dreamer('peer-1', outfit({ chest: 'tunic' })));

    scene.removeEntity('peer-1');
    await load('WearTunic');
    dressAll(scene);

    expect([work.joins, work.ms]).toEqual([0, 0]);
  });

  it("builds a dressed body's flash over its baked mesh, and again over the new one once it is dressed again", async () => {
    const { scene, models, load } = dressingScene();
    scene.placeEntity(dreamer('self', []));
    scene.placeEntity(clientEntity({ id: 'monster:1', kind: 'monster', name: 'skeleton', position: { x: 10, z: 10.8 } }));
    dressAll(scene);
    const flashes = (): THREE.BufferGeometry[] =>
      scene.scene
        .getObjectByName(COMBAT_EFFECTS_NAME)!
        .children.filter((child) => child.visible && (child as THREE.SkinnedMesh).isSkinnedMesh)
        .map((child) => (child as THREE.SkinnedMesh).geometry);

    scene.showBlow('monster:1', 'self', true);
    scene.tick(0.01);
    expect(flashes()).toContain(bakeOf(models[0]!)!.geometry);

    scene.updateOutfit('self', outfit({ chest: 'tunic' }));
    await load('WearTunic');
    dressAll(scene);
    scene.tick(1);
    scene.showBlow('monster:1', 'self', true);
    scene.tick(0.01);
    expect(flashes()).toEqual([bakeOf(models[0]!)!.geometry]);
  });
});

describe("the local player's dressing", () => {
  it('says the local player is dressed once they are drawn in all they wear, and not before', async () => {
    const { scene, load } = dressingScene();
    scene.placeEntity(dreamer('self', outfit({ chest: 'tunic' })));
    dressAll(scene);
    expect(scene.ownBodyDressed()).toBe(false);

    await load('WearTunic');
    dressAll(scene);

    expect(scene.ownBodyDressed()).toBe(true);
  });

  it.each<[string, (scene: WorldScene) => void]>([
    [
      'for the space a door left',
      (scene) => {
        scene.enterSpace(new ClientWorld('EdariaInn', REGISTRY));
        scene.placeEntity(dreamer('self', outfit({ head: 'cap' })));
      },
    ],
    ['for an outfit since changed', (scene) => scene.updateOutfit('self', outfit({ head: 'cap' }))],
  ])('does not count a piece that comes %s', async (_label, change) => {
    const { scene, load } = dressingScene();
    scene.placeEntity(dreamer('self', outfit({ chest: 'tunic' })));
    change(scene);
    dressAll(scene);

    await load('WearTunic');
    scene.tick(0.01);
    expect(scene.ownBodyDressed()).toBe(false);

    await load('WearCap');
    dressAll(scene);
    expect(scene.ownBodyDressed()).toBe(true);
  });

  it('does not count a piece that comes after the session ended', async () => {
    const { scene, load } = dressingScene();
    scene.placeEntity(dreamer('self', outfit({ chest: 'tunic' })));

    scene.showSplash();
    await load('WearTunic');
    scene.tick(0.01);

    expect(scene.ownBodyDressed()).toBe(false);
  });

  it('says the local player is dressed as a space whose outfit is all loaded is revealed', async () => {
    const { scene, load } = dressingScene();
    scene.placeEntity(dreamer('self', outfit({ chest: 'tunic' })));
    await load('WearTunic');
    dressAll(scene);

    scene.enterSpace(new ClientWorld('EdariaInn', REGISTRY));
    scene.placeEntity(dreamer('self', outfit({ chest: 'tunic' })));

    expect(scene.ownBodyDressed()).toBe(true);
  });

  it("loads again only the local player's pieces still loading", async () => {
    const { scene, load, retryWear } = dressingScene();
    scene.placeEntity(dreamer('self', outfit({ head: 'cap', chest: 'tunic' })));
    scene.placeEntity(dreamer('peer-1', [{ slot: 'chest', baseId: 'tunic', tier: 3 }]));
    await load('WearCap');

    scene.retryOwnOutfit();

    expect(retryWear).toHaveBeenCalledWith(['WearTunic']);
  });
});
