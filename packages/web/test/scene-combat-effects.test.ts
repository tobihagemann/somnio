import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { boltFlightSeconds, effectSeconds, headingFromVector, headingRadians } from '@somnio/core';
import type { Point } from '@somnio/core';
import { RARITIES } from '@somnio/protocol';
import { WorldScene } from '@/scene/worldScene';
import type { ModelAssets } from '@/scene/modelAssets';
import { COMBAT_EFFECTS_NAME, EFFECT_POOL_SIZES, STRIKE_AT } from '@/scene/combatEffects';
import { LOOT_BEAM_NAME, LOOT_LABEL_NAME, LOOT_MARKERS_NAME } from '@/scene/lootMarkers';
import { offsetDirection } from '@/scene/cameraRig';
import { CHARACTER_SCALE } from '@/scene/placement';
import { PORTRAIT_LAYERS } from '@/scene/portraits';
import type { ClientEntity } from '@/client';
import { TEST_REGISTRY } from '../../core/test/support/worldFixture.ts';
import { clientEntity } from './helpers/worldFixture';

const CLIP_SECONDS = 1;
const SLICE = 'Melee_1H_Attack_Slice_Horizontal';
/** Deep mend's long cast, as long as the pack's, so its push comes later than the channel is long. */
const LONG_CAST = new THREE.AnimationClip('Ranged_Magic_Spellcasting_Long', 2.5, []);
const CLIPS = [
  ...[
    'Idle',
    'Flying_Idle',
    SLICE,
    'Punch',
    'Hit_A',
    'Melee_Block',
    'Ranged_Magic_Raise',
    'Melee_1H_Attack_Jump_Chop',
    'Cheering',
    'Ranged_Magic_Shoot',
    'Ranged_Magic_Spellcasting',
    'Throw',
  ].map((name) => new THREE.AnimationClip(name, CLIP_SECONDS, [])),
  LONG_CAST,
];
/** When a slot-1 swing lands, from the blow. */
const BLADE_LANDS = CLIP_SECONDS * STRIKE_AT[SLICE]!;

afterEach(() => vi.restoreAllMocks());

/** A skinned body one unit tall, bound to one bone, as the pack's models are skinned. */
function skinnedBody(): THREE.Object3D {
  const bone = new THREE.Bone();
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
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial());
  mesh.add(bone);
  mesh.bind(new THREE.Skeleton([bone]));
  const root = new THREE.Object3D();
  root.add(mesh);
  return root;
}

/**
 * A scene whose bodies carry every combat clip, a second long, except the `clipless`, which carry
 * only their idle. `models` holds the model each entity was given, in the order placed. Its wall
 * clock runs on with each tick by the seconds asked, as a drawing tab's does, though the scene
 * clamps what reaches the effects to a tenth of a second. `hide` moves it on with no tick, as a
 * hidden tab's does.
 */
function combatScene(
  options: { reducedMotion?: boolean; clipless?: readonly number[]; ground?: () => THREE.Object3D; hand?: (baseId: string) => THREE.Object3D } = {},
): {
  scene: WorldScene;
  models: THREE.Object3D[];
  hide: (ms: number) => void;
} {
  const models: THREE.Object3D[] = [];
  const assets: ModelAssets = {
    prewarm: async () => {},
    character: () => {
      const model = skinnedBody();
      // Bodies hold what a hand holds only where the scene is given hand models.
      if (options.hand !== undefined) model.add(handSlot('handslotr', -0.25), handSlot('handslotl', 0.25));
      models.push(model);
      return model;
    },
    hand: (baseId) => options.hand?.(baseId),
    ground: () => options.ground?.(),
    object: () => undefined,
    clipsFor: (root) => (options.clipless?.includes(models.indexOf(root)) === true ? CLIPS.slice(0, 1) : CLIPS),
    prototypeMeshes: () => undefined,
  };
  let wallMs = 0;
  const scene = new WorldScene(assets, TEST_REGISTRY, 1, options.reducedMotion ?? false, () => wallMs);
  const tick = scene.tick.bind(scene);
  vi.spyOn(scene, 'tick').mockImplementation((seconds) => {
    wallMs += seconds * 1000;
    tick(seconds);
  });
  return { scene, models, hide: (ms) => (wallMs += ms) };
}

/** A hand's bone, at about the height a hand hangs, turned off the body's axes so a held model's pose is not the body's. */
function handSlot(name: string, x: number): THREE.Bone {
  const bone = Object.assign(new THREE.Bone(), { name });
  bone.position.set(x, 0.6, 0.1);
  bone.quaternion.setFromEuler(new THREE.Euler(0.4, -0.7, 0.2));
  return bone;
}

function place(scene: WorldScene, id: string, position: Point, overrides: Partial<ClientEntity> = {}): void {
  const kind = id === 'self' ? 'player' : id.startsWith('monster:') ? 'monster' : 'peer';
  scene.placeEntity(clientEntity({ id, kind, name: id, position, ...overrides }));
}

/** Runs the scene for `seconds` in steps of `step`. */
function run(scene: WorldScene, seconds: number, step = 0.01): void {
  for (let elapsed = 0; elapsed < seconds - 1e-9; elapsed += step) scene.tick(step);
}

function effects(scene: WorldScene): THREE.Object3D {
  return scene.scene.getObjectByName(COMBAT_EFFECTS_NAME)!;
}

function arcs(scene: WorldScene): THREE.Mesh[] {
  return effects(scene).children.filter((child): child is THREE.Mesh => (child as THREE.Mesh).geometry?.getAttribute('aShare') !== undefined);
}

function sparks(scene: WorldScene): THREE.Mesh[] {
  return effects(scene).children.filter((child): child is THREE.Mesh => (child as THREE.Mesh).geometry?.getAttribute('aDirection') !== undefined);
}

function marks(scene: WorldScene): THREE.Sprite[] {
  return effects(scene).children.filter((child): child is THREE.Sprite => (child as THREE.Sprite).isSprite === true);
}

/** The meshes drawn over bodies: the flash on their front faces, the outline on their back faces. */
function hulls(scene: WorldScene, side: THREE.Side): THREE.Mesh[] {
  return effects(scene).children.filter((child): child is THREE.Mesh => {
    const material = (child as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
    return material?.isMeshBasicMaterial === true && material.side === side;
  });
}

function visible<T extends THREE.Object3D>(objects: readonly T[]): T[] {
  return objects.filter((object) => object.visible);
}

/** The model of each entity whose clips moved on during the next tick of `seconds`. */
function advanced(scene: WorldScene, models: readonly THREE.Object3D[], seconds: number): number[] {
  const update = vi.spyOn(THREE.AnimationMixer.prototype, 'update');
  scene.tick(seconds);
  const roots = (update.mock.contexts as THREE.AnimationMixer[]).map((mixer) => mixer.getRoot());
  update.mockRestore();
  return models.flatMap((model, index) => (roots.includes(model) ? [index] : []));
}

/** What the stagger moves: the node between the entity's node and the holder of its model. */
function jolt(model: THREE.Object3D): THREE.Object3D {
  return model.parent!.parent!;
}

/** The rings drawn on the ground, waves and pulses alike, and the colour each is drawn in. */
function rings(scene: WorldScene): THREE.Mesh[] {
  return effects(scene).children.filter((child): child is THREE.Mesh => ringUniforms(child as THREE.Mesh)?.['uMax'] !== undefined);
}

function ringUniforms(mesh: THREE.Mesh): Record<string, THREE.IUniform> | undefined {
  return (mesh.material as THREE.ShaderMaterial | undefined)?.uniforms;
}

/** The rings and the motes of the Moonstone's light that show, by their colour. */
function moonlit(scene: WorldScene): THREE.Mesh[] {
  return visible([...rings(scene), ...motes(scene)]).filter((mesh) => (ringUniforms(mesh)!['uColor']!.value as THREE.Color).getHex() === 0xd8e6ff);
}

function motes(scene: WorldScene): THREE.Mesh[] {
  return effects(scene).children.filter((child): child is THREE.Mesh => (child as THREE.Mesh).geometry?.getAttribute('aSeed') !== undefined);
}

function beams(scene: WorldScene): THREE.Mesh[] {
  return effects(scene).children.filter((child): child is THREE.Mesh => (child as THREE.Mesh).geometry?.getAttribute('aAlong') !== undefined);
}

/** The words over bodies a blow missed: the one kind of effect that is no mesh of its own but holds a plaque's. */
function missWords(scene: WorldScene): THREE.Object3D[] {
  return effects(scene).children.filter((child) => !(child as THREE.Mesh).isMesh && !(child as THREE.Sprite).isSprite);
}

/** The Challenge pulses showing at the nightmares' feet, by their colour. */
function pulses(scene: WorldScene): THREE.Mesh[] {
  return visible(rings(scene)).filter((ring) => (ringUniforms(ring)!['uColor']!.value as THREE.Color).getHex() === 0xff7a5a);
}

/**
 * The effect meshes whose geometry carries `attribute`, which tells the Mystic's kinds apart: a
 * ward's shells, the bolts and the cracks they leave, a binding's tethers, and Veil's domes.
 */
function ofKind(scene: WorldScene, attribute: string): THREE.Mesh[] {
  return effects(scene).children.filter((child): child is THREE.Mesh => (child as THREE.Mesh).geometry?.getAttribute(attribute) !== undefined);
}

const shells = (scene: WorldScene) => ofKind(scene, 'aFacet');
const bolts = (scene: WorldScene) => ofKind(scene, 'aHead');
const cracks = (scene: WorldScene) => ofKind(scene, 'aReach');
const tethers = (scene: WorldScene) => ofKind(scene, 'aTether');

function domes(scene: WorldScene): THREE.Mesh[] {
  return effects(scene).children.filter((child): child is THREE.Mesh => (child as THREE.Mesh).geometry?.type === 'SphereGeometry');
}

/** A binding's runes: the rings broken into strokes. */
function runes(scene: WorldScene): THREE.Mesh[] {
  return rings(scene).filter((ring) => (ringUniforms(ring)!['uDash']!.value as number) > 0);
}

const uniformOf = (mesh: THREE.Mesh, name: string): number => ringUniforms(mesh)![name]!.value as number;

function trails(scene: WorldScene): THREE.Mesh[] {
  return effects(scene).children.filter((child): child is THREE.Mesh => (child as THREE.Mesh).geometry?.getAttribute('aAge') !== undefined);
}

/** Reads the thickness the outline's program is given, as three would hand it over on compiling. */
function outlineThickness(material: THREE.Material): () => number {
  const shader = { uniforms: {} as Record<string, { value: number }>, vertexShader: '', fragmentShader: '' };
  material.onBeforeCompile(shader as never, undefined as never);
  return () => shader.uniforms['uThickness']!.value;
}

type PlaySpy = { mock: { contexts: unknown[] } };

/** Whether the model has flinched, by the actions `play` started. */
function flinched(play: PlaySpy, model: THREE.Object3D): boolean {
  return (play.mock.contexts as THREE.AnimationAction[]).some((action) => action.getRoot() === model && action.getClip().name === 'Hit_A');
}

/** How many times the model started its swing. */
function swings(play: PlaySpy, model: THREE.Object3D): number {
  return (play.mock.contexts as THREE.AnimationAction[]).filter((action) => action.getRoot() === model && action.getClip().name === SLICE).length;
}

/** Ticks until the model flinches, and no further. */
function untilFlinched(scene: WorldScene, play: PlaySpy, model: THREE.Object3D): void {
  for (let elapsed = 0; !flinched(play, model); elapsed += 0.01) {
    expect(elapsed).toBeLessThan(2);
    scene.tick(0.01);
  }
}

describe('a blow', () => {
  it("draws the swing's arc round the target as the blade comes round, hit or miss, and none for a nightmare's strike", () => {
    const { scene } = combatScene();
    place(scene, 'self', { x: 10, z: 10 });
    place(scene, 'monster:1', { x: 10.5, z: 10.6 });
    scene.tick(0.01);

    scene.showBlow('self', 'monster:1', false);
    expect(visible(arcs(scene))).toEqual([]);
    run(scene, BLADE_LANDS);
    const [arc] = visible(arcs(scene));
    expect(arc).toBeDefined();
    expect(arc!.rotation.y).toBeCloseTo(headingRadians(headingFromVector(0.5, 0.6)), 6);
    expect(arc!.position.x).toBe(10);
    expect(arc!.position.z).toBe(10);
    // Drawn over the bodies, as a slash is.
    expect((arc!.material as THREE.Material).depthTest).toBe(false);

    run(scene, 1);
    expect(visible(arcs(scene))).toEqual([]);
    scene.showBlow('monster:1', 'self', true);
    run(scene, 0.5);
    expect(visible(arcs(scene))).toEqual([]);
  });

  it('flashes, staggers, and sparks the target it lands on, and holds only the two bodies it names for the hit-pause', () => {
    const { scene, models } = combatScene();
    place(scene, 'self', { x: 10, z: 10 });
    place(scene, 'monster:1', { x: 10, z: 10.8 });
    place(scene, 'monster:2', { x: 13, z: 10 });
    scene.tick(0.01);
    const play = vi.spyOn(THREE.AnimationAction.prototype, 'play');

    scene.showBlow('self', 'monster:1', true);
    untilFlinched(scene, play, models[1]!);

    expect(visible(hulls(scene, THREE.FrontSide))).not.toEqual([]);
    expect(visible(sparks(scene))).toHaveLength(1);
    expect(advanced(scene, models, 0.02)).toEqual([2]);
    expect(advanced(scene, models, 0.02)).toEqual([2]);
    expect(advanced(scene, models, 0.03)).toEqual([2]);
    expect(advanced(scene, models, 0.02)).toEqual([0, 1, 2]);
    // Knocked the way the blow travels, south.
    expect(jolt(models[1]!).position.z).toBeGreaterThan(0);

    run(scene, 0.5);
    expect(visible(hulls(scene, THREE.FrontSide))).toEqual([]);
    expect(jolt(models[1]!).position.toArray()).toEqual([0, 0, 0]);
  });

  it('shakes the camera only for a blow that names the player, and lets it settle back where the rig put it', () => {
    const { scene } = combatScene();
    place(scene, 'self', { x: 10, z: 10 });
    place(scene, 'peer', { x: 12, z: 10 });
    place(scene, 'monster:1', { x: 12, z: 10.8 });
    scene.tick(0.01);
    const rig = scene.camera.position.clone();

    scene.showBlow('monster:1', 'peer', true);
    for (let tick = 0; tick < 60; tick += 1) {
      scene.tick(0.01);
      expect(scene.camera.position.toArray()).toEqual(rig.toArray());
    }

    scene.showBlow('monster:1', 'self', true);
    let shaken = false;
    for (let tick = 0; tick < 60; tick += 1) {
      scene.tick(0.01);
      shaken ||= scene.camera.position.distanceTo(rig) > 1e-4;
    }
    expect(shaken).toBe(true);
    run(scene, 1);
    expect(scene.camera.position.distanceTo(rig)).toBeLessThan(1e-9);
  });

  it('under reduced motion neither shakes the camera nor holds a clip, and leaves the body where it stands', () => {
    const { scene, models } = combatScene({ reducedMotion: true });
    place(scene, 'self', { x: 10, z: 10 });
    place(scene, 'monster:1', { x: 10, z: 10.8 });
    scene.tick(0.01);
    const rig = scene.camera.position.clone();
    const play = vi.spyOn(THREE.AnimationAction.prototype, 'play');

    scene.showBlow('self', 'monster:1', true);
    untilFlinched(scene, play, models[1]!);

    expect(advanced(scene, models, 0.02)).toEqual([0, 1]);
    expect(scene.camera.position.toArray()).toEqual(rig.toArray());
    expect(jolt(models[1]!).position.toArray()).toEqual([0, 0, 0]);
    // The flash and the sparks still show.
    expect(visible(hulls(scene, THREE.FrontSide))).not.toEqual([]);
    expect(visible(sparks(scene))).toHaveLength(1);
  });

  it('drops the landings a hidden tab queued without frames, rather than playing them all at once on its return', () => {
    const { scene, models, hide } = combatScene();
    place(scene, 'self', { x: 10, z: 10 });
    place(scene, 'monster:1', { x: 10, z: 10.8 });
    scene.tick(0.01);
    const play = vi.spyOn(THREE.AnimationAction.prototype, 'play');
    const flinches = (): number =>
      (play.mock.contexts as THREE.AnimationAction[]).filter((action) => action.getRoot() === models[1] && action.getClip().name === 'Hit_A').length;

    // Ten seconds of blows with no frame drawn, then the tab comes back: none of them land.
    for (let blow = 0; blow < 100; blow += 1) {
      hide(100);
      scene.showBlow('self', 'monster:1', true);
    }
    run(scene, 1);
    expect(flinches()).toBe(0);

    // Nor do blows queued just after the last frame, once no frame has been drawn for long enough.
    run(scene, 1);
    const before = flinches();
    for (let blow = 0; blow < 10; blow += 1) {
      hide(100);
      scene.showBlow('self', 'monster:1', true);
    }
    hide(2000);
    scene.tick(0.01);
    expect(advanced(scene, models, 0.02)).toEqual([0, 1]);
    run(scene, 1);
    expect(flinches()).toBe(before);
    expect(visible(sparks(scene))).toEqual([]);
    expect(visible(hulls(scene, THREE.FrontSide))).toEqual([]);

    // Once frames are drawn again, a blow lands as ever.
    scene.showBlow('self', 'monster:1', true);
    run(scene, 1);
    expect(flinches()).toBe(before + 1);
  });
});

describe('a tab that drew no frame for a while', () => {
  /** A scene on a wall clock the test moves; `stall` moves it past the stale time with no frame drawn. */
  function stalling(options: { clipless?: readonly number[] } = {}): { scene: WorldScene; models: THREE.Object3D[]; stall: () => void } {
    const { scene, models, hide } = combatScene(options);
    place(scene, 'self', { x: 10, z: 10 });
    place(scene, 'monster:1', { x: 10, z: 10.8 });
    return { scene, models, stall: () => hide(2000) };
  }

  it('lands blows again once a frame is drawn, even when the first frame comes late', () => {
    const { scene, models, stall } = stalling();
    stall();
    scene.tick(0.01);
    const play = vi.spyOn(THREE.AnimationAction.prototype, 'play');

    scene.showBlow('self', 'monster:1', true);
    untilFlinched(scene, play, models[1]!);
  });

  it("starts no swing for a blow arriving while it is stalled, and plays the attacker's clip again once it draws", () => {
    const { scene, models, stall } = stalling();
    scene.tick(0.01);
    const play = vi.spyOn(THREE.AnimationAction.prototype, 'play');

    stall();
    scene.showBlow('self', 'monster:1', true);
    expect(swings(play, models[0]!)).toBe(0);
    run(scene, 1);
    expect(swings(play, models[0]!)).toBe(0);
    expect(flinched(play, models[1]!)).toBe(false);

    scene.showBlow('self', 'monster:1', true);
    expect(swings(play, models[0]!)).toBe(1);
  });

  it('lands no blow with no clip to time it by while it is stalled: no flinch, flash, or shake on its return', () => {
    const { scene, models, stall } = stalling({ clipless: [0] });
    scene.tick(0.01);
    const rig = scene.camera.position.clone();
    const play = vi.spyOn(THREE.AnimationAction.prototype, 'play');
    const shaken = (): boolean => {
      let moved = false;
      for (let tick = 0; tick < 10; tick += 1) {
        scene.tick(0.01);
        moved ||= scene.camera.position.distanceTo(rig) > 1e-4;
      }
      return moved;
    };

    stall();
    scene.showBlow('self', 'monster:1', true);
    scene.tick(0.01);
    expect(visible(hulls(scene, THREE.FrontSide))).toEqual([]);
    expect(shaken()).toBe(false);
    expect(flinched(play, models[1]!)).toBe(false);
    run(scene, 1);

    // The same blow lands at once while it draws.
    scene.showBlow('self', 'monster:1', true);
    expect(flinched(play, models[1]!)).toBe(true);
    scene.tick(0.01);
    expect(visible(hulls(scene, THREE.FrontSide))).not.toEqual([]);
    expect(shaken()).toBe(true);
  });

  it('marks no nightmare for a Challenge arriving while it is stalled', () => {
    const { scene, stall } = stalling();
    scene.tick(0.01);

    stall();
    scene.showAbility('self', 'challenge', undefined);
    for (let tick = 0; tick < 150; tick += 1) {
      scene.tick(0.01);
      expect(visible(marks(scene))).toEqual([]);
    }

    scene.showAbility('self', 'challenge', undefined);
    run(scene, 1.5);
    expect(visible(marks(scene))).toHaveLength(1);
  });

  it('outlines no dreamer for a Brace arriving while it is stalled', () => {
    const { scene, stall } = stalling();
    scene.tick(0.01);
    const outlines = (): number => visible(hulls(scene, THREE.BackSide)).length;

    stall();
    scene.showAbility('self', 'brace', undefined);
    for (let tick = 0; tick < 100; tick += 1) {
      scene.tick(0.01);
      expect(outlines()).toBe(0);
    }

    scene.showAbility('self', 'brace', undefined);
    run(scene, 0.5);
    expect(outlines()).toBe(1);
  });

  it('bursts no Lunge arriving while it is stalled', () => {
    const { scene, models, stall } = stalling();
    scene.tick(0.01);
    const play = vi.spyOn(THREE.AnimationAction.prototype, 'play');

    stall();
    scene.showAbility('self', 'lunge', 'monster:1');
    for (let tick = 0; tick < 150; tick += 1) {
      scene.tick(0.01);
      expect(visible(sparks(scene))).toEqual([]);
    }
    expect(flinched(play, models[1]!)).toBe(false);

    scene.showAbility('self', 'lunge', 'monster:1');
    untilFlinched(scene, play, models[1]!);
    expect(visible(sparks(scene))).not.toEqual([]);
  });

  it("drops a Challenge's marks whose time ran out while it was hidden, and keeps them while it draws", () => {
    for (const hidden of [false, true]) {
      const { scene, hide } = combatScene();
      place(scene, 'self', { x: 10, z: 10 });
      place(scene, 'monster:1', { x: 13, z: 10 });
      scene.tick(0.01);

      scene.showAbility('self', 'challenge', undefined);
      run(scene, 1.5);
      expect(visible(marks(scene))).toHaveLength(1);
      if (hidden) {
        // The effect's six seconds end with no frame drawn.
        hide(7600);
        scene.tick(0.01);
        expect(visible(marks(scene))).toEqual([]);
      } else {
        run(scene, 3);
        expect(visible(marks(scene))).toHaveLength(1);
      }
    }
  });

  it("drops another dreamer's Brace outline whose time ran out while it was hidden, and keeps it while it draws", () => {
    for (const hidden of [false, true]) {
      const { scene, hide } = combatScene();
      place(scene, 'self', { x: 10, z: 10 });
      place(scene, 'peer', { x: 13, z: 10 });
      scene.tick(0.01);
      const outlines = (): number => visible(hulls(scene, THREE.BackSide)).length;

      scene.showAbility('peer', 'brace', undefined);
      run(scene, 0.5);
      expect(outlines()).toBe(1);
      if (hidden) {
        hide(4500);
        scene.tick(0.01);
        expect(outlines()).toBe(0);
      } else {
        run(scene, 2);
        expect(outlines()).toBe(1);
      }
    }
  });

  it('keeps a mark and an outline the server told of while it was hidden for the seconds they have left on its return', () => {
    const { scene, hide } = combatScene();
    place(scene, 'self', { x: 10, z: 10 });
    place(scene, 'monster:1', { x: 13, z: 10 });
    scene.tick(0.01);
    const outlines = (): number => visible(hulls(scene, THREE.BackSide)).length;

    hide(9000);
    scene.showEffects('self', [{ effectId: 'braced', seconds: 4 }]);
    scene.showEffects('monster:1', [{ effectId: 'challenged', seconds: 4 }]);
    hide(1000);
    scene.tick(0.01);
    expect(visible(marks(scene))).toHaveLength(1);
    expect(outlines()).toBe(1);
    run(scene, 2.8);
    expect(visible(marks(scene))).toHaveLength(1);
    expect(outlines()).toBe(1);
    run(scene, 0.5);
    expect(visible(marks(scene))).toEqual([]);
    expect(outlines()).toBe(0);
  });

  it('bursts no Lunge used just before it was hidden on its return, and bursts one while it draws', () => {
    for (const hidden of [false, true]) {
      const { scene, models, stall } = stalling();
      scene.tick(0.01);
      const play = vi.spyOn(THREE.AnimationAction.prototype, 'play');

      scene.showAbility('self', 'lunge', 'monster:1');
      if (!hidden) {
        untilFlinched(scene, play, models[1]!);
        expect(visible(sparks(scene))).not.toEqual([]);
        continue;
      }
      stall();
      for (let tick = 0; tick < 150; tick += 1) {
        scene.tick(0.01);
        expect(visible(sparks(scene))).toEqual([]);
        expect(jolt(models[1]!).position.toArray()).toEqual([0, 0, 0]);
      }
      expect(flinched(play, models[1]!)).toBe(false);
    }
  });

  it('ends the flash, stagger, sparks, and shake of a blow that landed just before it was hidden', () => {
    const { scene, models, stall } = stalling();
    scene.tick(0.01);
    const rig = scene.camera.position.clone();
    const play = vi.spyOn(THREE.AnimationAction.prototype, 'play');

    scene.showBlow('self', 'monster:1', true);
    untilFlinched(scene, play, models[1]!);
    expect(visible(hulls(scene, THREE.FrontSide))).not.toEqual([]);
    expect(visible(sparks(scene))).toHaveLength(1);

    stall();
    for (let tick = 0; tick < 30; tick += 1) {
      scene.tick(0.01);
      expect(visible(hulls(scene, THREE.FrontSide))).toEqual([]);
      expect(visible(sparks(scene))).toEqual([]);
      expect(jolt(models[1]!).position.toArray()).toEqual([0, 0, 0]);
      expect(scene.camera.position.distanceTo(rig)).toBeLessThan(1e-9);
    }
    expect(advanced(scene, models, 0.02)).toEqual([0, 1]);
  });

  it('ends a stagger under way when it was hidden, setting the body back where it stands', () => {
    const { scene, models, stall } = stalling();
    scene.tick(0.01);
    const play = vi.spyOn(THREE.AnimationAction.prototype, 'play');

    scene.showBlow('self', 'monster:1', true);
    untilFlinched(scene, play, models[1]!);
    // Past the hit-pause, the knock is under way.
    run(scene, 0.09);
    expect(jolt(models[1]!).position.length()).toBeGreaterThan(0);

    stall();
    run(scene, 1);
    expect(jolt(models[1]!).position.toArray()).toEqual([0, 0, 0]);
    expect(jolt(models[1]!).rotation.toArray().slice(0, 3)).toEqual([0, 0, 0]);
  });

  it("ends a Lunge's trail drawn mid-leap when it was hidden", () => {
    const { scene, stall } = stalling();
    scene.tick(0.01);

    scene.showAbility('self', 'lunge', 'monster:1');
    for (let step = 1; step <= 5; step += 1) {
      scene.updatePosition('self', { x: 10, z: 10 + 0.04 * step }, 0, 0);
      scene.tick(0.01);
    }
    expect(visible(trails(scene))).toHaveLength(1);

    stall();
    scene.tick(0.01);
    expect(visible(trails(scene))).toEqual([]);
  });

  it('keeps a mark whose effect still runs through being hidden, whole, without popping it again', () => {
    const { scene, stall } = stalling();
    scene.tick(0.01);

    scene.showAbility('self', 'challenge', undefined);
    run(scene, 1.5);
    expect(visible(marks(scene))).toHaveLength(1);

    // Two seconds of the effect's six pass with no frame drawn.
    stall();
    for (let tick = 0; tick < 5; tick += 1) {
      scene.tick(0.01);
      const shown = visible(marks(scene));
      expect(shown).toHaveLength(1);
      expect(shown[0]!.scale.x).toBeCloseTo(0.5, 6);
    }
  });

  it('sends no Challenge pulse a stall skipped on its return, and pulses on the beat after it', () => {
    const { scene, hide } = combatScene();
    place(scene, 'self', { x: 10, z: 10 });
    place(scene, 'monster:1', { x: 13, z: 10 });
    scene.tick(0.01);

    scene.showEffects('monster:1', [{ effectId: 'challenged', seconds: 30 }]);
    run(scene, 0.1);
    expect(pulses(scene)).toHaveLength(1);

    // Five seconds hidden span five beats, none of which goes out late.
    hide(5000);
    for (let tick = 0; tick < 5; tick += 1) {
      scene.tick(0.01);
      expect(pulses(scene)).toEqual([]);
    }
    let pulsed = false;
    for (let tick = 0; tick < 100; tick += 1) {
      scene.tick(0.01);
      expect(pulses(scene).length).toBeLessThanOrEqual(1);
      pulsed ||= pulses(scene).length === 1;
    }
    expect(pulsed).toBe(true);
  });

  it("ends a Brace's swell begun just before it was hidden, and swells it while it draws", () => {
    for (const hidden of [false, true]) {
      // Under reduced motion the outline holds still, so it is at rest exactly.
      const { scene, hide } = combatScene({ reducedMotion: true });
      place(scene, 'self', { x: 10, z: 10 });
      place(scene, 'monster:1', { x: 10, z: 10.8 });
      scene.tick(0.01);

      scene.showAbility('self', 'brace', undefined);
      run(scene, 0.7);
      const [outline] = visible(hulls(scene, THREE.BackSide));
      const material = outline!.material as THREE.MeshBasicMaterial;
      const thickness = outlineThickness(material);
      const rest = { thickness: thickness(), opacity: material.opacity };
      expect(rest.opacity).toBeCloseTo(0.85, 9);

      // A Ghost's strike lands on the brace, which swells.
      scene.showBlow('monster:1', 'self', true);
      for (let elapsed = 0; thickness() <= rest.thickness * 1.01; elapsed += 0.01) {
        expect(elapsed).toBeLessThan(1);
        scene.tick(0.01);
      }
      if (hidden) hide(2000);
      scene.tick(0.01);
      expect(visible(hulls(scene, THREE.BackSide))).toEqual([outline]);
      if (hidden) {
        expect(thickness()).toBeCloseTo(rest.thickness, 9);
        expect(material.opacity).toBeCloseTo(rest.opacity, 9);
      } else {
        expect(thickness()).toBeGreaterThan(rest.thickness * 1.5);
        expect(material.opacity).toBeGreaterThan(rest.opacity + 0.15);
      }
    }
  });
});

describe('a tab drawing slowly', () => {
  // About three frames a second: each is 300 ms of wall time, which the scene clamps to a tenth of a
  // second for the clips and the effects alike.
  const SLOW_FRAME = 0.3;

  it("outlines a Brace as its clip blocks, frame for frame with the clip's time", () => {
    const { scene, models } = combatScene();
    place(scene, 'self', { x: 10, z: 10 });
    scene.tick(0.01);
    const play = vi.spyOn(THREE.AnimationAction.prototype, 'play');
    const outlined = (): boolean => visible(hulls(scene, THREE.BackSide)).length === 1;

    scene.showAbility('self', 'brace', undefined);
    const block = (play.mock.contexts as THREE.AnimationAction[]).find((action) => action.getRoot() === models[0] && action.getClip().name === 'Melee_Block')!;
    const cue = CLIP_SECONDS * STRIKE_AT['Melee_Block']!;
    const seen: boolean[] = [];
    for (let frame = 0; frame < 6; frame += 1) {
      scene.tick(SLOW_FRAME);
      expect(outlined()).toBe(block.time >= cue);
      seen.push(outlined());
    }
    expect(seen).toEqual([false, false, false, true, true, true]);
  });

  /** The seconds of effects from a Challenge until the nightmare 5 m off shows its mark, and how far the wave had gone by then. */
  function challengeMarked(frameSeconds: number): { seconds: number; wave: number } {
    const { scene } = combatScene();
    place(scene, 'self', { x: 10, z: 10 });
    place(scene, 'monster:1', { x: 15, z: 10 });
    scene.tick(0.01);

    scene.showAbility('self', 'challenge', undefined);
    let seconds = 0;
    while (visible(marks(scene)).length === 0) {
      expect(seconds).toBeLessThan(2);
      scene.tick(frameSeconds);
      seconds += Math.min(frameSeconds, 0.1);
    }
    const waves = visible(rings(scene)).map((ring) => ringUniforms(ring)!);
    const wave = Math.max(...waves.map((uniforms) => uniforms['uRadius']!.value as number));
    return { seconds, wave };
  }

  it('marks a nightmare as the wave reaches it, at any frame rate', () => {
    const drawing = challengeMarked(0.01);
    // As the wave, drawn a frame at a time, reaches the nightmare 5 m off.
    expect(drawing.wave).toBeGreaterThan(4.9);
    expect(drawing.wave).toBeLessThan(5.1);
    const slow = challengeMarked(SLOW_FRAME);
    expect(slow.seconds).toBeGreaterThanOrEqual(drawing.seconds - 1e-9);
    expect(slow.seconds).toBeLessThan(drawing.seconds + 0.1);
  });
});

describe('a mark and an outline', () => {
  it('show from an ability until just before its rank-1 seconds have passed since it arrived, and not after', () => {
    const { scene } = combatScene();
    place(scene, 'self', { x: 10, z: 10 });
    place(scene, 'peer', { x: 10, z: 13 });
    place(scene, 'monster:1', { x: 13, z: 10 });
    scene.tick(0.01);
    const outlines = (): number => visible(hulls(scene, THREE.BackSide)).length;
    const braced = effectSeconds('braced', 1);
    const challenged = effectSeconds('challenged', 1);

    scene.showAbility('peer', 'brace', undefined);
    scene.showAbility('self', 'challenge', undefined);
    run(scene, braced - 0.03);
    expect(outlines()).toBe(1);
    run(scene, 0.06);
    expect(outlines()).toBe(0);
    run(scene, challenged - braced - 0.06);
    expect(visible(marks(scene))).toHaveLength(1);
    run(scene, 0.06);
    expect(visible(marks(scene))).toEqual([]);
  });

  it('fade out: a mark over its last 0.4 s, an outline over its last 0.3 s', () => {
    // Under reduced motion the outline holds still at 0.85.
    const { scene } = combatScene({ reducedMotion: true });
    place(scene, 'self', { x: 10, z: 10 });
    place(scene, 'monster:1', { x: 13, z: 10 });
    scene.tick(0.01);
    const opacities = (): { mark: number | undefined; outline: number | undefined } => ({
      mark: visible(marks(scene))[0]?.material.opacity,
      outline: (visible(hulls(scene, THREE.BackSide))[0]?.material as THREE.Material | undefined)?.opacity,
    });

    scene.showEffects('monster:1', [{ effectId: 'challenged', seconds: 2 }]);
    scene.showEffects('self', [{ effectId: 'braced', seconds: 2 }]);
    run(scene, 1);
    expect(opacities().mark).toBeCloseTo(1, 6);
    expect(opacities().outline).toBeCloseTo(0.85, 6);
    // 0.2 s left.
    run(scene, 0.8);
    expect(opacities().mark).toBeCloseTo(0.5, 2);
    expect(opacities().outline).toBeCloseTo((0.85 * 0.2) / 0.3, 2);
    // 0.05 s left.
    run(scene, 0.15);
    expect(opacities().mark).toBeCloseTo(0.125, 2);
    expect(opacities().outline).toBeCloseTo((0.85 * 0.05) / 0.3, 2);
    run(scene, 0.1);
    expect(opacities()).toEqual({ mark: undefined, outline: undefined });
  });
});

describe('Cleave', () => {
  /** The player facing south, a Ghost to their left (east of south) and one to their right. */
  function cleaving(): { scene: WorldScene; models: THREE.Object3D[]; play: PlaySpy; hide: (ms: number) => void } {
    const { scene, models, hide } = combatScene();
    place(scene, 'self', { x: 10, z: 10 }, { facing: 0 });
    place(scene, 'monster:left', { x: 10 + Math.sin(Math.PI / 4) * 0.8, z: 10 + Math.cos(Math.PI / 4) * 0.8 });
    place(scene, 'monster:right', { x: 10 - Math.sin(Math.PI / 4) * 0.8, z: 10 + Math.cos(Math.PI / 4) * 0.8 });
    scene.tick(0.01);
    return { scene, models, hide, play: vi.spyOn(THREE.AnimationAction.prototype, 'play') };
  }

  it('lands its blows as the sweep passes each body, from the left of the one who cleaves to their right, and swings only once', () => {
    const { scene, models, play } = cleaving();
    scene.showAbility('self', 'cleave', undefined);
    // The server sends the blows straight after the ability, the right-hand one first here.
    scene.showBlow('self', 'monster:right', true);
    scene.showBlow('self', 'monster:left', true);

    const struck: string[] = [];
    let elapsed = 0;
    const times: Record<string, number> = {};
    while (struck.length < 2 && elapsed < 1) {
      scene.tick(0.005);
      elapsed += 0.005;
      for (const [index, id] of [
        [1, 'left'],
        [2, 'right'],
      ] as const) {
        if (!struck.includes(id) && flinched(play, models[index]!)) {
          struck.push(id);
          times[id] = elapsed;
        }
      }
    }
    expect(struck).toEqual(['left', 'right']);
    // The sweep crosses 90° of its 120° between them, in that share of its 0.17 s.
    expect(times['right']! - times['left']!).toBeCloseTo(0.17 * 0.75, 1);
    expect(swings(play, models[0]!)).toBe(1);
  });

  it("takes a second blow at a body it already struck for slot 1's, which swings again", () => {
    const { scene, models, play } = cleaving();
    scene.showAbility('self', 'cleave', undefined);
    scene.showBlow('self', 'monster:left', true);
    scene.showBlow('self', 'monster:left', true);

    expect(swings(play, models[0]!)).toBe(2);
  });

  it("takes a blow arriving after the Cleave's batch for slot 1's, which swings again", () => {
    const { scene, models, play, hide } = cleaving();
    scene.showAbility('self', 'cleave', undefined);
    scene.showBlow('self', 'monster:left', true);
    expect(swings(play, models[0]!)).toBe(1);
    // A fifth of a second later on the wall clock, with no frame drawn between.
    hide(200);
    scene.showBlow('self', 'monster:right', true);
    expect(swings(play, models[0]!)).toBe(2);
  });
});

describe('Challenge', () => {
  it('marks each nightmare within its range where it is drawn, over its head, for the effect, and the target as long as the server says', () => {
    const { scene } = combatScene();
    place(scene, 'self', { x: 10, z: 10 });
    place(scene, 'monster:near', { x: 13, z: 10 });
    place(scene, 'monster:far', { x: 17, z: 10 });
    place(scene, 'peer', { x: 10, z: 12 });
    scene.tick(0.01);

    scene.showAbility('self', 'challenge', undefined);
    run(scene, 1.5);
    const shown = visible(marks(scene));
    expect(shown.map((mark) => mark.position.x)).toEqual([13]);
    expect(shown[0]!.position.y).toBeGreaterThan(CHARACTER_SCALE);
    run(scene, 5);
    expect(visible(marks(scene))).toEqual([]);

    // The server tells of the target's: it starts at once, and ends when a frame leaves it out.
    scene.showEffects('monster:far', [{ effectId: 'challenged', seconds: 20 }]);
    run(scene, 0.1);
    expect(visible(marks(scene)).map((mark) => mark.position.x)).toEqual([17]);
    run(scene, 10);
    expect(visible(marks(scene))).toHaveLength(1);
    scene.showEffects('monster:far', []);
    run(scene, 0.1);
    expect(visible(marks(scene))).toEqual([]);
  });

  it("keeps a mark on as many nightmares as it has marks for when it reaches more, none taking another one's", () => {
    const { scene } = combatScene();
    place(scene, 'self', { x: 10, z: 10 });
    const count = EFFECT_POOL_SIZES.marks + 2;
    for (let index = 0; index < count; index += 1) {
      const angle = (index / count) * Math.PI * 2;
      place(scene, `monster:${index}`, { x: 10 + Math.sin(angle) * 3, z: 10 + Math.cos(angle) * 3 });
    }
    scene.tick(0.01);

    scene.showAbility('self', 'challenge', undefined);
    run(scene, 1.5);
    const settled = visible(marks(scene));
    expect(settled).toHaveLength(EFFECT_POOL_SIZES.marks);
    for (let tick = 0; tick < 10; tick += 1) {
      scene.tick(0.05);
      const shown = visible(marks(scene));
      expect(shown).toEqual(settled);
      for (const mark of shown) expect(mark.scale.x).toBeCloseTo(0.5, 6);
    }
  });

  /** A ring of nightmares 3 m round the player, two more than there are marks; `at` is where each stands. */
  function crowd(): { scene: WorldScene; at: (index: number) => Point } {
    const { scene } = combatScene();
    place(scene, 'self', { x: 10, z: 10 });
    const count = EFFECT_POOL_SIZES.marks + 2;
    const at = (index: number): Point => {
      const angle = (index / count) * Math.PI * 2;
      return { x: 10 + Math.sin(angle) * 3, z: 10 + Math.cos(angle) * 3 };
    };
    for (let index = 0; index < count; index += 1) place(scene, `monster:${index}`, at(index));
    scene.tick(0.01);
    return { scene, at };
  }

  it('gives a mark that ends to a nightmare waiting for one', () => {
    const { scene, at } = crowd();
    const waiting = EFFECT_POOL_SIZES.marks;
    const overWaiting = (mark: THREE.Sprite): boolean => Math.hypot(mark.position.x - at(waiting).x, mark.position.z - at(waiting).z) < 1e-6;

    scene.showAbility('self', 'challenge', undefined);
    run(scene, 1.5);
    expect(visible(marks(scene)).some(overWaiting)).toBe(false);
    // The first nightmare's mark ends, and the first one waiting takes its sprite.
    scene.showEffects('monster:0', []);
    run(scene, 0.1);
    expect(visible(marks(scene)).find(overWaiting)?.scale.x).toBeGreaterThan(0);
    expect(visible(marks(scene))).toHaveLength(EFFECT_POOL_SIZES.marks);
  });

  it('marks again once every mark has ended', () => {
    const { scene } = crowd();
    scene.showAbility('self', 'challenge', undefined);
    run(scene, 10);
    expect(visible(marks(scene))).toEqual([]);

    scene.showAbility('self', 'challenge', undefined);
    run(scene, 1.5);
    expect(visible(marks(scene))).toHaveLength(EFFECT_POOL_SIZES.marks);
    for (const mark of visible(marks(scene))) expect(mark.scale.x).toBeGreaterThan(0);
  });
});

describe('Brace', () => {
  it('outlines the dreamer from the block until the effect ends, and for the rank-1 seconds where the server tells nothing', () => {
    const { scene } = combatScene();
    place(scene, 'self', { x: 10, z: 10 });
    place(scene, 'peer', { x: 13, z: 10 });
    scene.tick(0.01);
    const outlines = (): number => visible(hulls(scene, THREE.BackSide)).length;

    scene.showAbility('self', 'brace', undefined);
    scene.showEffects('self', [{ effectId: 'braced', seconds: 9 }]);
    scene.showAbility('peer', 'brace', undefined);
    expect(outlines()).toBe(0);
    run(scene, 0.5);
    expect(outlines()).toBe(2);

    // The peer's lasts the rank-1 four seconds; the player's own as long as the server said.
    run(scene, 4);
    expect(outlines()).toBe(1);
    scene.showEffects('self', []);
    scene.tick(0.01);
    expect(outlines()).toBe(0);
  });

  it('keeps every effect off the portraits: no effect hangs in a model holder or carries a portrait layer', () => {
    const { scene, models } = combatScene();
    place(scene, 'self', { x: 10, z: 10 });
    place(scene, 'monster:1', { x: 10, z: 10.8 });
    scene.setPortraitSubject('own', 'self');
    scene.setPortraitSubject('target', 'monster:1');
    scene.showAbility('self', 'brace', undefined);
    scene.showBlow('self', 'monster:1', true);
    run(scene, 0.5);

    expect(hulls(scene, THREE.BackSide)).not.toEqual([]);
    // Each model holds its mesh and its bone alone, as it was cloned.
    for (const model of models) {
      let count = 0;
      model.traverse(() => (count += 1));
      expect(count).toBe(3);
    }
    effects(scene).traverse((object) => {
      for (const layer of Object.values(PORTRAIT_LAYERS)) expect(object.layers.isEnabled(layer)).toBe(false);
    });
  });
});

describe('Rally', () => {
  it('lifts a dreamer at the edge of its wave in a tab drawing slowly, however long the wave takes on the wall clock', () => {
    const { scene, models } = combatScene();
    place(scene, 'self', { x: 10, z: 10 });
    place(scene, 'peer', { x: 21.8, z: 10 });
    scene.tick(0.01);

    // About three frames a second, each a clamped tenth of a second of effects: the wave takes about 2 s.
    scene.showAbility('self', 'rally', undefined);
    let lifted = false;
    for (let tick = 0; tick < 20 && !lifted; tick += 1) {
      scene.tick(0.3);
      lifted = jolt(models[1]!).position.y > 0;
    }
    expect(lifted).toBe(true);
  });

  it('lifts no dreamer it reaches under reduced motion', () => {
    const { scene, models } = combatScene({ reducedMotion: true });
    place(scene, 'self', { x: 10, z: 10 });
    place(scene, 'peer', { x: 13, z: 10 });
    scene.tick(0.01);

    scene.showAbility('self', 'rally', undefined);
    for (let tick = 0; tick < 150; tick += 1) {
      scene.tick(0.01);
      expect(jolt(models[1]!).position.y).toBe(0);
    }
  });
});

describe('a missed blow', () => {
  it('hangs the word over the head of the one missed as the blade lands, as large as the plaques are drawn, for a moment', () => {
    const { scene } = combatScene();
    place(scene, 'self', { x: 10, z: 10 });
    place(scene, 'monster:1', { x: 10.5, z: 10.6 });
    scene.tick(0.01);

    scene.showBlow('self', 'monster:1', true);
    run(scene, BLADE_LANDS + 0.05);
    expect(visible(missWords(scene))).toEqual([]);

    scene.showBlow('self', 'monster:1', false);
    run(scene, BLADE_LANDS - 0.02);
    expect(visible(missWords(scene))).toEqual([]);
    run(scene, 0.05);
    const [word] = visible(missWords(scene));
    expect([word!.position.x, word!.position.y, word!.position.z]).toEqual([10.5, expect.closeTo(CHARACTER_SCALE + 0.2, 2), 10.6]);
    expect(word!.scale.x).toBeGreaterThan(0);
    run(scene, 0.85);
    expect(visible(missWords(scene))).toEqual([]);
  });
});

describe("the Moonstone's light", () => {
  /** A Healer, `self`, beside a dreamer, `peer`, and a nightmare beyond them. */
  function healing(options: { reducedMotion?: boolean } = {}) {
    const combat = combatScene(options);
    place(combat.scene, 'self', { x: 10, z: 10 });
    place(combat.scene, 'peer', { x: 12, z: 10 });
    place(combat.scene, 'monster:1', { x: 10, z: 13 });
    combat.scene.tick(0.01);
    return combat;
  }

  it('swells from the feet of a body mended and rises through it, drawn over the bodies, each mend its own, and is gone in about a second', () => {
    const { scene } = healing();
    scene.showMend('peer');
    scene.tick(0.01);
    const first = moonlit(scene);
    expect(first.length).toBeGreaterThanOrEqual(3);
    expect(visible(motes(scene))).toHaveLength(1);
    expect((visible(motes(scene))[0]!.material as THREE.Material).depthTest).toBe(false);
    expect(visible(motes(scene))[0]!.position.x).toBe(12);

    scene.showMend('peer');
    scene.tick(0.01);
    expect(moonlit(scene).length).toBe(first.length * 2);
    run(scene, 1.2);
    expect(moonlit(scene)).toEqual([]);
  });

  it('shows no mend arriving while it is stalled', () => {
    const { scene, hide } = healing();
    hide(2000);
    scene.showMend('peer');
    scene.tick(0.01);
    expect(moonlit(scene)).toEqual([]);
  });

  it('draws a gold ring round a body being raised as far round as the raise has gone, at its pace from each snapshot, frame by frame or hidden, and frees it when the raise ends', () => {
    const { scene, hide } = healing();
    const gold = (): THREE.Mesh[] => visible(rings(scene)).filter((ring) => (ringUniforms(ring)!['uColor']!.value as THREE.Color).getHex() === 0xffd27a);
    const arc = (): number => ringUniforms(gold()[0]!)!['uArc']!.value as number;

    scene.showRaising('peer', { progress: 0, seconds: 6 });
    scene.tick(0.01);
    expect(gold()).toHaveLength(1);
    expect(gold()[0]!.position.x).toBe(12);
    // The arc starts on the far side of the body from the camera, which no body lying in the ring or standing by covers, over the faint rest of the ring.
    const ring = gold()[0]!;
    ring.updateWorldMatrix(true, false);
    const start = ring
      .localToWorld(new THREE.Vector3(0, 1, 0))
      .sub(ring.position)
      .setY(0)
      .normalize();
    const toCamera = offsetDirection();
    expect(start.dot(new THREE.Vector3(toCamera.x, 0, toCamera.z).normalize())).toBeCloseTo(-1, 6);
    expect(uniformOf(ring, 'uTrack')).toBeGreaterThan(0);
    run(scene, 2.99);
    expect(arc()).toBeCloseTo(0.5, 2);

    // A second Healer joins: the rest goes at twice the pace, and the ring keeps its mesh.
    scene.showRaising('peer', { progress: 0.5, seconds: 1.5 });
    run(scene, 0.75);
    expect(gold()).toEqual([ring]);
    expect(arc()).toBeCloseTo(0.75, 2);
    // Hidden, it is not dropped as a moment in flight would be, and it is as far round on the return as the raise has gone.
    hide(2000);
    scene.tick(0.01);
    expect(arc()).toBe(1);

    scene.showRaising('peer', undefined);
    scene.tick(0.01);
    expect(gold()).toEqual([]);
  });

  it("holds a raise's ring while a channel holds a Healer's pace back, and never draws it back at the snapshot as the channel ends", () => {
    const { scene, hide } = healing();
    const gold = (): THREE.Mesh[] => visible(rings(scene)).filter((ring) => (ringUniforms(ring)!['uColor']!.value as THREE.Color).getHex() === 0xffd27a);
    const arc = (): number => ringUniforms(gold()[0]!)!['uArc']!.value as number;

    // A lone Healer channelling for 1.5 s of the 6 left.
    scene.showRaising('peer', { progress: 0.25, seconds: 6, pausedSeconds: [1.5] });
    run(scene, 1.4);
    expect(arc()).toBe(0.25);
    run(scene, 1.1);
    expect(arc()).toBeCloseTo(0.25 + 1 / 6, 2);

    // Two, one channelling for a second: one pace until then, two after.
    scene.showRaising('peer', { progress: 0.25, seconds: 2.75, pausedSeconds: [0, 1] });
    run(scene, 1);
    const before = arc();
    expect(before).toBeCloseTo(0.25 + 1 / 6, 2);
    scene.showRaising('peer', { progress: 0.25 + 1 / 6, seconds: 1.75 });
    scene.tick(0.01);
    expect(arc()).toBeGreaterThanOrEqual(before);
    expect(arc()).toBeCloseTo(before, 2);

    // A snapshot that arrives between two ticks counts from its arrival, so the tick after it does not run the ring ahead.
    hide(20);
    scene.showRaising('peer', { progress: 0.5, seconds: 3 });
    scene.tick(0.02);
    expect(arc()).toBe(0.5);

    // A snapshot naming no pause lets go of the pauses the one before named, so the ring runs on at once.
    scene.showRaising('peer', { progress: 0.25, seconds: 6, pausedSeconds: [1.5] });
    scene.showRaising('peer', { progress: 0.25, seconds: 4.5 });
    run(scene, 1);
    expect(arc()).toBeCloseTo(0.25 + 0.75 / 4.5, 2);
  });
});

describe('Deep mend', () => {
  function channelling(options: { reducedMotion?: boolean } = {}) {
    const combat = combatScene(options);
    place(combat.scene, 'self', { x: 10, z: 10 });
    place(combat.scene, 'peer', { x: 13, z: 10 });
    combat.scene.tick(0.01);
    return combat;
  }

  it("plays the long cast started as far in as puts its push at the channel's end, with a beam to the dreamer and light gathering round them", () => {
    const { scene } = channelling();
    const play = vi.spyOn(THREE.AnimationAction.prototype, 'play');

    scene.showAbility('self', 'deep-mend', 'peer', { phase: 'start', seconds: 1.5 });
    const cast = (play.mock.contexts as THREE.AnimationAction[]).find((action) => action.getClip() === LONG_CAST);
    expect(cast?.time).toBeCloseTo(2.5 * STRIKE_AT['Ranged_Magic_Spellcasting_Long']! - 1.5, 6);
    scene.tick(0.01);
    expect(visible(beams(scene))).toHaveLength(1);
    expect((visible(beams(scene))[0]!.material as THREE.Material).depthTest).toBe(false);
    const stream = visible(motes(scene));
    expect(stream).toHaveLength(1);
    expect(stream[0]!.position.x).toBe(13);

    // It holds for as long as the channel runs, and a little past it with no landing.
    run(scene, 1.4);
    expect(visible(beams(scene))).toHaveLength(1);
    run(scene, 0.7);
    expect(visible(beams(scene))).toEqual([]);
    expect(visible(motes(scene))).toEqual([]);
  });

  it('bursts on the dreamer as it lands, lifting them, while its beam fades out', () => {
    const { scene, models } = channelling();
    scene.showAbility('self', 'deep-mend', 'peer', { phase: 'start', seconds: 1.5 });
    run(scene, 1.5);
    const before = moonlit(scene).length;

    scene.showAbility('self', 'deep-mend', 'peer', { phase: 'done' });
    scene.tick(0.01);
    expect(moonlit(scene).length).toBeGreaterThan(before);
    let lifted = false;
    for (let tick = 0; tick < 30; tick += 1) {
      scene.tick(0.01);
      lifted ||= jolt(models[1]!).position.y > 0;
    }
    expect(lifted).toBe(true);
    expect(visible(beams(scene))).toEqual([]);
  });

  it('gathers round the Healer with no beam on themselves, and lifts no one under reduced motion', () => {
    const { scene, models } = channelling({ reducedMotion: true });
    scene.showAbility('self', 'deep-mend', undefined, { phase: 'start', seconds: 1.5 });
    scene.tick(0.01);
    expect(visible(beams(scene))).toEqual([]);
    expect(visible(motes(scene))[0]!.position.x).toBe(10);
    run(scene, 1.5);
    scene.showAbility('self', 'deep-mend', undefined, { phase: 'done' });
    for (let tick = 0; tick < 30; tick += 1) {
      scene.tick(0.01);
      expect(jolt(models[0]!).position.y).toBe(0);
    }
  });

  it("breaks off: the beam fades, the cast gives way to the Healer's pose, and nothing bursts", () => {
    const { scene, models } = channelling();
    scene.showAbility('self', 'deep-mend', 'peer', { phase: 'start', seconds: 1.5 });
    run(scene, 0.5);
    const play = vi.spyOn(THREE.AnimationAction.prototype, 'play');

    scene.showAbility('self', 'deep-mend', 'peer', { phase: 'broken' });
    run(scene, 0.3);
    expect(visible(beams(scene))).toEqual([]);
    expect(moonlit(scene)).toEqual([]);
    const started = (play.mock.contexts as THREE.AnimationAction[]).filter((action) => action.getRoot() === models[0]).map((action) => action.getClip().name);
    expect(started).toEqual(['Idle']);
  });

  it('shows one learned of under way for the seconds it has left', () => {
    const { scene } = channelling();
    scene.showAbility('self', 'deep-mend', 'peer', { phase: 'channel', seconds: 0.4 });
    scene.tick(0.01);
    expect(visible(beams(scene))).toHaveLength(1);
    run(scene, 1);
    expect(visible(beams(scene))).toEqual([]);
  });

  it('starts nothing while stalled, and ends one that landed while hidden with no burst on the return', () => {
    const { scene, hide } = channelling();
    hide(2000);
    scene.showAbility('self', 'deep-mend', 'peer', { phase: 'start', seconds: 1.5 });
    scene.tick(0.01);
    expect(visible(beams(scene))).toEqual([]);

    scene.showAbility('self', 'deep-mend', 'peer', { phase: 'start', seconds: 1.5 });
    scene.tick(0.01);
    expect(visible(beams(scene))).toHaveLength(1);
    hide(1600);
    scene.showAbility('self', 'deep-mend', 'peer', { phase: 'done' });
    scene.tick(0.01);
    expect(visible(beams(scene))).toEqual([]);
    expect(moonlit(scene)).toEqual([]);
  });
});

describe('Renewal', () => {
  function renewing() {
    const combat = combatScene();
    place(combat.scene, 'self', { x: 10, z: 10 });
    place(combat.scene, 'peer', { x: 13, z: 10 });
    combat.scene.tick(0.01);
    return combat;
  }
  const at = (scene: WorldScene, x: number): number => visible(motes(scene)).filter((mesh) => mesh.position.x === x).length;

  it('blooms on the dreamer as the hand reaches out, and pulses there once a second for its rank-1 seconds where the server tells nothing', () => {
    const { scene } = renewing();
    scene.showAbility('self', 'renewal', 'peer');
    run(scene, STRIKE_AT['Ranged_Magic_Shoot']! - 0.02);
    expect(at(scene, 13)).toBe(0);
    run(scene, 0.05);
    expect(at(scene, 13)).toBeGreaterThan(0);
    run(scene, 9);
    expect(at(scene, 13)).toBeGreaterThan(0);
    run(scene, 3);
    expect(at(scene, 13)).toBe(0);
  });

  it('pulses for as long as the server says, and stops when it says the effect ended', () => {
    const { scene } = renewing();
    scene.showAbility('self', 'renewal', 'peer');
    scene.showEffects('peer', [{ effectId: 'renewing', seconds: 2 }]);
    run(scene, 4);
    expect(at(scene, 13)).toBe(0);

    scene.showAbility('self', 'renewal', 'peer');
    run(scene, 2);
    scene.showEffects('peer', []);
    run(scene, 2);
    expect(at(scene, 13)).toBe(0);
  });

  it('sends no pulse a stall skipped on its return', () => {
    const { scene, hide } = renewing();
    scene.showAbility('self', 'renewal', 'peer');
    run(scene, 1.5);
    hide(3000);
    scene.tick(0.01);
    expect(at(scene, 13)).toBeLessThanOrEqual(1);
  });
});

describe('Radiance', () => {
  it('lifts each dreamer its wave reaches, and none beyond it or under reduced motion', () => {
    for (const reducedMotion of [false, true]) {
      const { scene, models } = combatScene({ reducedMotion });
      place(scene, 'self', { x: 10, z: 10 });
      place(scene, 'peer', { x: 14.5, z: 10 });
      place(scene, 'far', { x: 10, z: 15.5 });
      scene.tick(0.01);

      scene.showAbility('self', 'radiance', undefined);
      let near = false;
      for (let tick = 0; tick < 150; tick += 1) {
        scene.tick(0.01);
        near ||= jolt(models[1]!).position.y > 0;
        expect(jolt(models[2]!).position.y).toBe(0);
      }
      expect(near).toBe(!reducedMotion);
    }
  });
});

describe('Calm', () => {
  it("outlines the Healer in a cool line from the cast's moment for its rank-1 seconds, apart from a Brace's white", () => {
    const { scene } = combatScene();
    place(scene, 'self', { x: 10, z: 10 });
    place(scene, 'peer', { x: 13, z: 10 });
    scene.tick(0.01);
    const outlined = () => visible(hulls(scene, THREE.BackSide)).map((mesh) => (mesh.material as THREE.MeshBasicMaterial).color.getHex());

    scene.showAbility('self', 'calm', undefined);
    scene.showAbility('peer', 'brace', undefined);
    run(scene, STRIKE_AT['Ranged_Magic_Spellcasting']! - 0.05);
    expect(outlined()).toEqual([0xffffff]);
    run(scene, 0.5);
    expect(outlined().sort()).toEqual([0x9fd8ff, 0xffffff]);
    // It holds from its use, as the server's effect does, not from the cast's moment.
    run(scene, effectSeconds('calmed', 1) - 1.2);
    expect(outlined()).toContain(0x9fd8ff);
    run(scene, 0.4);
    expect(outlined()).not.toContain(0x9fd8ff);
  });
});

describe('Ward', () => {
  function warding() {
    const combat = combatScene();
    place(combat.scene, 'self', { x: 10, z: 10 });
    place(combat.scene, 'peer', { x: 13, z: 10 });
    place(combat.scene, 'monster:1', { x: 13, z: 10.8 });
    combat.scene.tick(0.01);
    return combat;
  }

  it('forms a shell round whom it lands on as the hand reaches out, drawn over the bodies, for its rank-1 seconds where the server tells nothing', () => {
    const { scene } = warding();
    scene.showAbility('self', 'ward', 'peer');
    run(scene, STRIKE_AT['Ranged_Magic_Shoot']! - 0.02);
    expect(visible(shells(scene))).toEqual([]);
    run(scene, 0.05);
    const shown = visible(shells(scene));
    expect(shown).toHaveLength(1);
    expect(shown[0]!.position.x).toBe(13);
    expect((shown[0]!.material as THREE.Material).depthTest).toBe(false);
    run(scene, effectSeconds('warded', 1) - 0.6);
    expect(visible(shells(scene))).toHaveLength(1);
    run(scene, 0.6);
    expect(visible(shells(scene))).toEqual([]);
  });

  it('takes a landed blow in the body’s place: the shell flashes and loses facets, and the body neither flinches nor staggers', () => {
    const { scene, models } = warding();
    scene.showAbility('self', 'ward', 'peer');
    run(scene, 0.5);
    const play = vi.spyOn(THREE.AnimationAction.prototype, 'play');
    scene.showBlow('monster:1', 'peer', true);
    let flashed = false;
    for (let tick = 0; tick < 100; tick += 1) {
      scene.tick(0.01);
      flashed ||= uniformOf(visible(shells(scene))[0]!, 'uFlash') > 0;
      expect(jolt(models[1]!).position.x).toBe(0);
    }
    expect(flashed).toBe(true);
    expect(flinched(play, models[1]!)).toBe(false);
    expect(uniformOf(visible(shells(scene))[0]!, 'uCrack')).toBeGreaterThan(0);
  });

  it('shatters when the server ends it well before its time, and is gone half a second later', () => {
    const { scene } = warding();
    scene.showAbility('self', 'ward', undefined);
    scene.showEffects('self', [{ effectId: 'warded', seconds: 12 }]);
    run(scene, 0.5);
    scene.showEffects('self', []);
    scene.tick(0.1);
    const shown = visible(shells(scene));
    expect(shown).toHaveLength(1);
    expect(uniformOf(shown[0]!, 'uBurst')).toBeGreaterThan(0);
    run(scene, 0.5);
    expect(visible(shells(scene))).toEqual([]);
  });

  it('shatters as the blow that spent it lands, cracking it a last time, rather than when the server ends it with that blow', () => {
    const { scene, models } = warding();
    scene.showAbility('self', 'ward', 'peer');
    run(scene, 0.5);
    const play = vi.spyOn(THREE.AnimationAction.prototype, 'play');
    const shell = visible(shells(scene))[0]!;
    const cracked = uniformOf(shell, 'uCrack');
    scene.showBlow('monster:1', 'peer', true);
    scene.showEffects('peer', []);
    for (let elapsed = 0; !flinched(play, models[1]!); elapsed += 0.01) {
      expect(elapsed).toBeLessThan(2);
      expect(uniformOf(shell, 'uBurst')).toBe(0);
      scene.tick(0.01);
    }
    scene.tick(0.01);
    expect(visible(shells(scene))).toEqual([shell]);
    expect(uniformOf(shell, 'uBurst')).toBeGreaterThan(0);
    expect(uniformOf(shell, 'uFlash')).toBeGreaterThan(0);
    expect(uniformOf(shell, 'uCrack')).toBeGreaterThan(cracked);
    run(scene, 0.5);
    expect(visible(shells(scene))).toEqual([]);
  });

  it('lets a ward two blows on their way spent take the first and shatter as the last lands on the body', () => {
    const { scene, models } = warding();
    scene.showAbility('self', 'ward', 'peer');
    run(scene, 0.5);
    const play = vi.spyOn(THREE.AnimationAction.prototype, 'play');
    const shell = visible(shells(scene))[0]!;
    // The server took the first whole and the second spent it, in one step.
    scene.showBlow('monster:1', 'peer', true);
    scene.showBlow('monster:1', 'peer', true);
    scene.showEffects('peer', []);
    for (let elapsed = 0; !flinched(play, models[1]!); elapsed += 0.01) {
      expect(elapsed).toBeLessThan(2);
      scene.tick(0.01);
    }
    const flinches = (play.mock.contexts as THREE.AnimationAction[]).filter((action) => action.getRoot() === models[1] && action.getClip().name === 'Hit_A');
    expect(flinches).toHaveLength(1);
    scene.tick(0.01);
    expect(uniformOf(shell, 'uBurst')).toBeGreaterThan(0);
  });

  it('holds a ward the blow on its way spent, and its shatter, through every later frame of effects until the shatter ends it', () => {
    const { scene, models } = warding();
    scene.showAbility('self', 'ward', 'peer');
    run(scene, 0.5);
    const play = vi.spyOn(THREE.AnimationAction.prototype, 'play');
    const shell = visible(shells(scene))[0]!;
    scene.showBlow('monster:1', 'peer', true);
    scene.showEffects('peer', []);
    scene.showEffects('peer', [{ effectId: 'renewing', seconds: 10 }]);
    for (let elapsed = 0; !flinched(play, models[1]!); elapsed += 0.01) {
      expect(elapsed).toBeLessThan(2);
      expect(visible(shells(scene))).toEqual([shell]);
      scene.tick(0.01);
    }
    scene.tick(0.01);
    expect(uniformOf(shell, 'uBurst')).toBeGreaterThan(0);
    run(scene, 0.3);
    const bursting = uniformOf(shell, 'uBurst');
    scene.showEffects('peer', []);
    scene.tick(0.01);
    expect(visible(shells(scene))).toEqual([shell]);
    expect(uniformOf(shell, 'uBurst')).toBeGreaterThan(bursting);
    run(scene, 0.2);
    expect(visible(shells(scene))).toEqual([]);
  });

  it.each<[string, boolean]>([
    ['named again by an effects frame', false],
    ['cast again, its ability frame first', true],
  ])('lets the blow that spent a ward %s before it lands shatter the old shell and land on the body, then forms the new shell', (_label, cast) => {
    const { scene, models } = warding();
    scene.showAbility('self', 'ward', 'peer');
    run(scene, 0.5);
    const play = vi.spyOn(THREE.AnimationAction.prototype, 'play');
    const shell = visible(shells(scene))[0]!;
    scene.showBlow('monster:1', 'peer', true);
    scene.showEffects('peer', []);
    if (cast) scene.showAbility('self', 'ward', 'peer');
    scene.showEffects('peer', [{ effectId: 'warded', seconds: 12 }]);
    // The body flinches: the blow lands on it, as the server landed its harm, not on the new ward.
    for (let elapsed = 0; !flinched(play, models[1]!); elapsed += 0.01) {
      expect(elapsed).toBeLessThan(2);
      expect(visible(shells(scene))).toEqual([shell]);
      scene.tick(0.01);
    }
    scene.tick(0.01);
    expect(uniformOf(shell, 'uBurst')).toBeGreaterThan(0);
    for (let elapsed = 0; elapsed < 1; elapsed += 0.01) {
      scene.tick(0.01);
      expect(visible(shells(scene)).length).toBeLessThanOrEqual(1);
    }
    const shown = visible(shells(scene));
    expect(shown).toHaveLength(1);
    expect(uniformOf(shown[0]!, 'uBurst')).toBe(0);
    expect(uniformOf(shown[0]!, 'uCrack')).toBe(0);
  });

  it.each<[string, boolean]>([
    ['spent by a blow', true],
    ['ended with no blow on its way', false],
  ])('lets a ward named again over one %s take the next blow while the old shell flies apart, and forms its shell cracked by it', (_label, spending) => {
    const { scene, models } = warding();
    scene.showAbility('self', 'ward', 'peer');
    run(scene, 0.5);
    const play = vi.spyOn(THREE.AnimationAction.prototype, 'play');
    if (spending) scene.showBlow('monster:1', 'peer', true);
    scene.showEffects('peer', []);
    scene.showEffects('peer', [{ effectId: 'warded', seconds: 12 }]);
    if (spending) {
      for (let elapsed = 0; !flinched(play, models[1]!); elapsed += 0.01) {
        expect(elapsed).toBeLessThan(2);
        scene.tick(0.01);
      }
      play.mockClear();
    }
    // The old shell is still flying apart as the next blow lands, which the ward put on anew takes.
    scene.showBlow('monster:1', 'peer', true);
    for (let elapsed = 0; elapsed < 1; elapsed += 0.01) {
      scene.tick(0.01);
      expect(flinched(play, models[1]!)).toBe(false);
    }
    const shown = visible(shells(scene));
    expect(shown).toHaveLength(1);
    expect(uniformOf(shown[0]!, 'uBurst')).toBe(0);
    expect(uniformOf(shown[0]!, 'uCrack')).toBeGreaterThan(0);
  });

  it('forms a new shell for a ward the server names again while the last one shatters', () => {
    const { scene } = warding();
    scene.showAbility('self', 'ward', undefined);
    scene.showEffects('self', [{ effectId: 'warded', seconds: 12 }]);
    run(scene, 0.5);
    scene.showEffects('self', []);
    scene.tick(0.1);
    expect(uniformOf(visible(shells(scene))[0]!, 'uBurst')).toBeGreaterThan(0);
    scene.showEffects('self', [{ effectId: 'warded', seconds: 12 }]);
    run(scene, 1);
    const shown = visible(shells(scene));
    expect(shown).toHaveLength(1);
    expect(uniformOf(shown[0]!, 'uBurst')).toBe(0);
  });

  it('lets the shell of a ward put on again while it shatters fly apart until the new shell forms', () => {
    const { scene } = warding();
    scene.showAbility('self', 'ward', undefined);
    scene.showEffects('self', [{ effectId: 'warded', seconds: 12 }]);
    run(scene, 0.5);
    scene.showEffects('self', []);
    scene.tick(0.1);
    const shattering = visible(shells(scene))[0]!;
    scene.showAbility('self', 'ward', undefined);
    scene.showEffects('self', [{ effectId: 'warded', seconds: 12 }]);
    const bursting = uniformOf(shattering, 'uBurst');
    scene.tick(0.01);
    expect(visible(shells(scene))).toEqual([shattering]);
    expect(uniformOf(shattering, 'uBurst')).toBeGreaterThan(bursting);
    for (let elapsed = 0; elapsed < 1; elapsed += 0.01) {
      scene.tick(0.01);
      expect(visible(shells(scene))).toHaveLength(1);
    }
    expect(uniformOf(visible(shells(scene))[0]!, 'uBurst')).toBe(0);
  });

  it('lets the shell of a ward an effects frame alone names again while it shatters fly apart, then forms the new shell', () => {
    const { scene } = warding();
    scene.showAbility('self', 'ward', undefined);
    scene.showEffects('self', [{ effectId: 'warded', seconds: 12 }]);
    run(scene, 0.5);
    scene.showEffects('self', []);
    scene.tick(0.1);
    const shattering = visible(shells(scene))[0]!;
    scene.showEffects('self', [{ effectId: 'warded', seconds: 12 }]);
    const bursting = uniformOf(shattering, 'uBurst');
    scene.tick(0.01);
    expect(visible(shells(scene))).toEqual([shattering]);
    expect(uniformOf(shattering, 'uBurst')).toBeGreaterThan(bursting);
    for (let elapsed = 0; elapsed < 1; elapsed += 0.01) {
      scene.tick(0.01);
      expect(visible(shells(scene))).toHaveLength(1);
    }
    expect(uniformOf(visible(shells(scene))[0]!, 'uBurst')).toBe(0);
  });

  it('fades a ward the server ends as its time runs out, with no shatter', () => {
    const { scene } = warding();
    scene.showAbility('self', 'ward', undefined);
    scene.showEffects('self', [{ effectId: 'warded', seconds: 2 }]);
    run(scene, 1.9);
    const shell = visible(shells(scene))[0]!;
    scene.showEffects('self', []);
    for (let elapsed = 0; shell.visible; elapsed += 0.01) {
      expect(elapsed).toBeLessThan(2);
      expect(uniformOf(shell, 'uBurst')).toBe(0);
      scene.tick(0.01);
    }
  });

  it('drops the shatter of a ward spent by a blow a hidden tab dropped: the shell is gone on its return, and the body never flinches', () => {
    const { scene, models, hide } = warding();
    scene.showAbility('self', 'ward', 'peer');
    run(scene, 0.5);
    const play = vi.spyOn(THREE.AnimationAction.prototype, 'play');
    scene.showBlow('monster:1', 'peer', true);
    scene.showEffects('peer', []);
    scene.tick(0.01);
    hide(2000);
    scene.tick(0.01);
    expect(visible(shells(scene))).toEqual([]);
    run(scene, 1);
    expect(flinched(play, models[1]!)).toBe(false);
  });

  it('forms the shell of a ward named again over one a blow a hidden tab dropped had spent, once the old one has flown apart', () => {
    const { scene, hide } = warding();
    scene.showAbility('self', 'ward', 'peer');
    run(scene, 0.5);
    const old = visible(shells(scene))[0]!;
    scene.showBlow('monster:1', 'peer', true);
    scene.showEffects('peer', []);
    scene.showEffects('peer', [{ effectId: 'warded', seconds: 12 }]);
    scene.tick(0.01);
    hide(2000);
    scene.tick(0.01);
    scene.tick(0.05);
    expect(uniformOf(old, 'uBurst')).toBeGreaterThan(0);
    run(scene, 1);
    const shown = visible(shells(scene));
    expect(shown).toHaveLength(1);
    expect(uniformOf(shown[0]!, 'uBurst')).toBe(0);
  });

  it('keeps a shell the server told of through a hidden tab for the seconds it has left', () => {
    const { scene, hide } = warding();
    scene.showAbility('self', 'ward', undefined);
    scene.showEffects('self', [{ effectId: 'warded', seconds: 12 }]);
    run(scene, 0.5);
    hide(5000);
    scene.tick(0.01);
    expect(visible(shells(scene))).toHaveLength(1);
    hide(8000);
    scene.tick(0.01);
    expect(visible(shells(scene))).toEqual([]);
  });
});

describe('Dream-bolt', () => {
  /** The seconds from the bolt's use until the nightmare `metres` east of the Mystic flinches, ticked by `step`. */
  function flight(metres: number, step = 0.01, options: { reducedMotion?: boolean } = {}) {
    const combat = combatScene(options);
    place(combat.scene, 'self', { x: 10, z: 10 });
    place(combat.scene, 'monster:1', { x: 10 + metres, z: 10 });
    combat.scene.tick(0.01);
    const play = vi.spyOn(THREE.AnimationAction.prototype, 'play');
    combat.scene.showAbility('self', 'dream-bolt', 'monster:1');
    let elapsed = 0;
    let flew = false;
    while (!flinched(play, combat.models[1]!)) {
      expect(elapsed).toBeLessThan(3);
      combat.scene.tick(step);
      elapsed += step;
      flew ||= visible(bolts(combat.scene)).length > 0;
    }
    play.mockRestore();
    return { ...combat, elapsed, flew };
  }

  it('flies from the hand as the cast pushes out, drawn over the bodies, and bursts on the nightmare as the server lands its harm, later the further it flies', () => {
    const near = flight(2);
    const far = flight(8);
    expect(near.flew && far.flew).toBe(true);
    expect((bolts(near.scene)[0]!.material as THREE.Material).depthTest).toBe(false);
    expect(near.elapsed).toBeGreaterThan(STRIKE_AT['Ranged_Magic_Shoot']!);
    expect(near.elapsed).toBeCloseTo(boltFlightSeconds(2), 1);
    expect(far.elapsed).toBeCloseTo(boltFlightSeconds(8), 1);
  });

  it('bursts as harm rather than as a heal: no light rises, a ring snaps in, a crack splits its chest for a quarter second, and violet shards fly off and fall', () => {
    const { scene } = flight(6);
    expect(visible(motes(scene))).toEqual([]);
    expect(visible(cracks(scene))).toHaveLength(1);
    const shards = visible(sparks(scene));
    expect(shards).toHaveLength(3);
    for (const shard of shards) {
      expect((ringUniforms(shard)!['uColor']!.value as THREE.Color).getHex()).toBe(0xa13cff);
      expect(uniformOf(shard, 'uFall')).toBeGreaterThan(0);
    }
    const [ring] = visible(rings(scene)).filter((mesh) => (ringUniforms(mesh)!['uColor']!.value as THREE.Color).getHex() === 0xa13cff);
    const snapsFrom = uniformOf(ring!, 'uRadius');
    run(scene, 0.08);
    expect(uniformOf(ring!, 'uRadius')).toBeLessThan(snapsFrom);
    run(scene, 0.18);
    expect(visible(cracks(scene))).toEqual([]);
    expect(visible(motes(scene))).toEqual([]);
  });

  it('staggers the nightmare further and holds its clip longer than a blade does', () => {
    /** How long the nightmare's clip holds from the tick it flinched, and how far it staggers at most. */
    function aftermath(scene: WorldScene, models: THREE.Object3D[]): { held: number; shove: number } {
      let held = 0;
      let shove = 0;
      for (let tick = 0; tick < 40; tick += 1) {
        if (!advanced(scene, models, 0.01).includes(1)) held = tick + 1;
        shove = Math.max(shove, jolt(models[1]!).position.length());
      }
      return { held, shove };
    }
    const bolt = flight(6);
    const bladed = combatScene();
    place(bladed.scene, 'self', { x: 10, z: 10 });
    place(bladed.scene, 'monster:1', { x: 10, z: 10.8 });
    bladed.scene.tick(0.01);
    const play = vi.spyOn(THREE.AnimationAction.prototype, 'play');
    bladed.scene.showBlow('self', 'monster:1', true);
    untilFlinched(bladed.scene, play, bladed.models[1]!);
    const blade = aftermath(bladed.scene, bladed.models);
    const bolted = aftermath(bolt.scene, bolt.models);
    expect(bolted.held).toBeGreaterThan(blade.held);
    expect(bolted.shove).toBeGreaterThan(blade.shove * 1.3);
  });

  it('under reduced motion neither staggers nor holds the nightmare, but still splits its chest', () => {
    const { scene, models } = flight(6, 0.01, { reducedMotion: true });
    expect(visible(cracks(scene))).toHaveLength(1);
    expect(advanced(scene, models, 0.02)).toEqual([0, 1]);
    expect(jolt(models[1]!).position.toArray()).toEqual([0, 0, 0]);
  });

  it('arrives at the same moment of the effects’ clock in a tab drawing slowly', () => {
    expect(flight(6, 0.1).elapsed).toBeCloseTo(flight(6).elapsed, 0);
  });

  it('shows the miss word where it would have burst on a nightmare that evaded it, with no burst, flash, stagger, or hold', () => {
    const { scene, models } = combatScene();
    place(scene, 'self', { x: 10, z: 10 });
    place(scene, 'monster:1', { x: 16, z: 10 });
    scene.tick(0.01);
    const play = vi.spyOn(THREE.AnimationAction.prototype, 'play');
    scene.showAbility('self', 'dream-bolt', 'monster:1', { evaded: true });
    let elapsed = 0;
    let flew = false;
    while (visible(missWords(scene)).length === 0) {
      expect(elapsed).toBeLessThan(3);
      scene.tick(0.01);
      elapsed += 0.01;
      flew ||= visible(bolts(scene)).length > 0;
    }
    expect(flew).toBe(true);
    expect(elapsed).toBeCloseTo(boltFlightSeconds(6), 1);
    expect(visible(cracks(scene))).toEqual([]);
    expect(visible(sparks(scene))).toEqual([]);
    expect(flinched(play, models[1]!)).toBe(false);
    expect(advanced(scene, models, 0.02)).toEqual([0, 1]);
    expect(jolt(models[1]!).position.toArray()).toEqual([0, 0, 0]);
  });

  it('starts no bolt while stalled, and drops one in flight when the tab is hidden', () => {
    const { scene, models, hide } = combatScene();
    place(scene, 'self', { x: 10, z: 10 });
    place(scene, 'monster:1', { x: 18, z: 10 });
    scene.tick(0.01);
    const play = vi.spyOn(THREE.AnimationAction.prototype, 'play');
    hide(2000);
    scene.showAbility('self', 'dream-bolt', 'monster:1');
    run(scene, 1.5);
    expect(visible(bolts(scene))).toEqual([]);

    scene.showAbility('self', 'dream-bolt', 'monster:1');
    run(scene, STRIKE_AT['Ranged_Magic_Shoot']! + 0.1);
    expect(visible(bolts(scene))).toHaveLength(1);
    hide(2000);
    run(scene, 1);
    expect(visible(bolts(scene))).toEqual([]);
    expect(visible(cracks(scene))).toEqual([]);
    expect(flinched(play, models[1]!)).toBe(false);
  });
});

describe('Weaken', () => {
  it('outlines the nightmare in a thin violet line from the cast’s moment for its rank-1 seconds', () => {
    const { scene } = combatScene();
    place(scene, 'self', { x: 10, z: 10 });
    place(scene, 'monster:1', { x: 13, z: 10 });
    scene.tick(0.01);
    const outlined = () => visible(hulls(scene, THREE.BackSide)).map((mesh) => (mesh.material as THREE.MeshBasicMaterial).color.getHex());
    scene.showAbility('self', 'weaken', 'monster:1');
    run(scene, STRIKE_AT['Ranged_Magic_Spellcasting']! - 0.05);
    expect(outlined()).toEqual([]);
    run(scene, 0.1);
    expect(outlined()).toEqual([0xc4a8ff]);
    run(scene, effectSeconds('weakened', 1) - 0.8);
    expect(outlined()).toEqual([0xc4a8ff]);
    run(scene, 0.4);
    expect(outlined()).toEqual([]);
  });

  it('keeps the outline of one cast again from its first moment, and holds it until the later end', () => {
    const { scene } = combatScene();
    place(scene, 'self', { x: 10, z: 10 });
    place(scene, 'monster:1', { x: 13, z: 10 });
    scene.tick(0.01);
    const outlined = () => visible(hulls(scene, THREE.BackSide)).length;
    scene.showAbility('self', 'weaken', 'monster:1');
    run(scene, 2);
    expect(outlined()).toBe(1);
    scene.showAbility('self', 'weaken', 'monster:1');
    scene.tick(0.01);
    expect(outlined()).toBe(1);
    run(scene, effectSeconds('weakened', 1) - 1.5);
    expect(outlined()).toBe(1);
  });
});

describe('Bind', () => {
  it('lays runes round the nightmare’s feet and snaps tethers up to it for its rank-1 seconds, then frees both', () => {
    const { scene } = combatScene();
    place(scene, 'self', { x: 10, z: 10 });
    place(scene, 'monster:1', { x: 13, z: 10 });
    scene.tick(0.01);
    scene.showAbility('self', 'bind', 'monster:1');
    run(scene, STRIKE_AT['Ranged_Magic_Spellcasting']! + 0.05);
    expect(visible(runes(scene)).map((ring) => ring.position.x)).toEqual([13]);
    expect(visible(tethers(scene))).toHaveLength(1);
    expect(uniformOf(visible(tethers(scene))[0]!, 'uReach')).toBeLessThan(1);
    run(scene, 0.2);
    expect(uniformOf(visible(tethers(scene))[0]!, 'uReach')).toBe(1);
    run(scene, effectSeconds('bound', 1) - 1);
    expect(visible(tethers(scene))).toHaveLength(1);
    run(scene, 0.3);
    expect(visible(runes(scene))).toEqual([]);
    expect(visible(tethers(scene))).toEqual([]);
  });

  it('frees the runes and tethers of a nightmare driven off', () => {
    const { scene } = combatScene();
    place(scene, 'self', { x: 10, z: 10 });
    place(scene, 'monster:1', { x: 13, z: 10 });
    scene.tick(0.01);
    scene.showAbility('self', 'bind', 'monster:1');
    run(scene, 0.5);
    scene.updateCondition('monster:1', 'fallen');
    scene.tick(0.01);
    expect(visible(tethers(scene))).toEqual([]);
  });
});

describe('Veil', () => {
  function veiling(reducedMotion: boolean) {
    const combat = combatScene({ reducedMotion });
    place(combat.scene, 'self', { x: 10, z: 10 });
    place(combat.scene, 'peer', { x: 13, z: 10 });
    place(combat.scene, 'far', { x: 10, z: 16 });
    combat.scene.tick(0.01);
    return combat;
  }
  const misted = (scene: WorldScene) =>
    visible(hulls(scene, THREE.FrontSide)).filter((mesh) => (mesh.material as THREE.MeshBasicMaterial).color.getHex() === 0xbdb6d8);

  it('raises a dome of mist over the Mystic and fades each dreamer under it into the mist for its rank-1 seconds, and none beyond it', () => {
    const { scene } = veiling(false);
    scene.showAbility('self', 'veil', undefined);
    run(scene, STRIKE_AT['Ranged_Magic_Raise']! + 0.05);
    expect(visible(domes(scene))).toHaveLength(1);
    run(scene, 1);
    // A body's flash hull is one mesh per mesh of its model; each test body has one.
    expect(misted(scene)).toHaveLength(2);
    run(scene, 2);
    expect(visible(domes(scene))).toEqual([]);
    run(scene, effectSeconds('veiled', 1) - 3.6);
    expect(misted(scene)).toHaveLength(2);
    run(scene, 0.5);
    expect(misted(scene)).toEqual([]);
  });

  it('holds the mist steady under reduced motion', () => {
    const { scene } = veiling(true);
    scene.showAbility('self', 'veil', undefined);
    run(scene, 1.5);
    const shade = () => (misted(scene)[0]!.material as THREE.MeshBasicMaterial).opacity;
    const first = shade();
    run(scene, 0.4);
    expect(shade()).toBe(first);
  });
});

describe('a thrown drop', () => {
  const CAP = { kind: 'item', baseId: 'cap', rarity: 'rare' } as const;
  /** Where the dreamer at (10, 10) throws the cap, east of them. */
  const LANDS = { x: 11.3, z: 10 };

  /** A scene where `self` stands at (10, 10) and a drop lies on the ground as a flat box, which `item` holds. */
  function throwing(options: { reducedMotion?: boolean } = {}) {
    const item = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.06, 0.1).translate(0, 0.03, 0));
    const combat = combatScene({ ...options, ground: () => item });
    place(combat.scene, 'self', { x: 10, z: 10 });
    combat.scene.tick(0.01);
    const loot = combat.scene.scene.getObjectByName(LOOT_MARKERS_NAME)!;
    /** Whether the drop's model, its name, and its beam are drawn. */
    const drawn = () => ({
      item: isDrawn(item),
      name: loot.getObjectsByProperty('name', LOOT_LABEL_NAME).some(isDrawn),
      beam: loot.getObjectsByProperty('name', LOOT_BEAM_NAME).some(isDrawn),
    });
    const at = () => item.getWorldPosition(new THREE.Vector3());
    return { ...combat, item, drawn, at };
  }

  function isDrawn(object: THREE.Object3D): boolean {
    for (let node: THREE.Object3D | null = object; node !== null; node = node.parent) if (!node.visible) return false;
    return true;
  }

  it('plays the throw on the dreamer who threw it and flies the item from their hand, in an arc, to where it lies, its name and its light shown as it lands', () => {
    const { scene, drawn, at } = throwing();
    const played = vi.spyOn(THREE.AnimationMixer.prototype, 'clipAction');
    scene.showLoot({ lootId: 'loot-1', ...LANDS, contents: CAP, shared: true, from: { x: 10, z: 10, entityId: 'self' } });
    expect(played.mock.calls.map(([clip]) => (clip as THREE.AnimationClip).name)).toContain('Throw');
    expect(drawn()).toEqual({ item: false, name: false, beam: false });

    // The throw lets go a quarter of a second in, a little over the ground by the thrower.
    run(scene, 0.26);
    expect(drawn()).toEqual({ item: true, name: false, beam: false });
    expect(at().x).toBeLessThan(10.2);
    expect(at().y).toBeGreaterThan(0.3);
    run(scene, 0.2);
    expect(at().x).toBeGreaterThan(10.4);
    expect(at().x).toBeLessThan(LANDS.x);
    expect(at().y).toBeGreaterThan(0.1);

    run(scene, 0.3);
    expect(drawn()).toEqual({ item: true, name: true, beam: true });
    run(scene, 0.2);
    expect(at()).toEqual(new THREE.Vector3(LANDS.x, 0, LANDS.z));
  });

  it("bursts a nightmare's drop out of its body at once, with no throw played, higher and longer than a dreamer's throw, and hops higher as it lands", () => {
    const { scene, drawn, at } = throwing();
    const played = vi.spyOn(THREE.AnimationMixer.prototype, 'clipAction');
    scene.showLoot({ lootId: 'loot-1', ...LANDS, contents: CAP, from: { x: 10.8, z: 10 } });
    scene.tick(0.01);
    expect(played).not.toHaveBeenCalled();
    expect(drawn().item).toBe(true);
    expect(at().x).toBeCloseTo(10.8, 1);
    expect(at().y).toBeCloseTo(0.55, 2);

    // High over the bodies halfway, and still in the air past where a throw has come down.
    run(scene, 0.32);
    expect(at().y).toBeGreaterThan(1.2);
    run(scene, 0.2);
    expect(drawn().name).toBe(false);
    expect(at().y).toBeGreaterThan(0.5);

    run(scene, 0.15);
    expect(drawn().name).toBe(true);
    run(scene, 0.08);
    expect(at().y).toBeGreaterThan(0.08);
    run(scene, 0.2);
    expect(at()).toEqual(new THREE.Vector3(LANDS.x, 0, LANDS.z));
  });

  it.each<[string, { reducedMotion?: boolean }, (combat: ReturnType<typeof throwing>) => void]>([
    ['under reduced motion', { reducedMotion: true }, () => {}],
    ['shown while the tab stalls', {}, ({ hide }) => hide(2000)],
  ])('lays a thrown drop where it lies at once %s', (_label, options, before) => {
    const combat = throwing(options);
    before(combat);
    combat.scene.showLoot({ lootId: 'loot-1', ...LANDS, contents: CAP, shared: true, from: { x: 10, z: 10, entityId: 'self' } });
    expect([combat.drawn(), combat.at()]).toEqual([{ item: true, name: true, beam: true }, new THREE.Vector3(LANDS.x, 0, LANDS.z)]);
  });

  it('lays a drop in the air where it lies once the tab stalls', () => {
    const { scene, hide, drawn, at } = throwing();
    scene.showLoot({ lootId: 'loot-1', ...LANDS, contents: CAP, shared: true, from: { x: 10, z: 10, entityId: 'self' } });
    run(scene, 0.3);
    hide(2000);
    scene.tick(0.01);
    expect([drawn(), at()]).toEqual([{ item: true, name: true, beam: true }, new THREE.Vector3(LANDS.x, 0, LANDS.z)]);
  });

  describe('from a hand', () => {
    const SWORD = { kind: 'item', baseId: 'sword', rarity: 'rare' } as const;
    const FROM_HAND = { x: 10, z: 10, entityId: 'self', hand: 'mainHand' } as const;
    /** A blade, as a hand model holds it: its grip half turned in its node, as the pack's are. */
    const BLADE = new THREE.BoxGeometry(0.08, 1, 0.03).translate(0, 0.4, 0);
    const GRIP = new THREE.Matrix4().compose(
      new THREE.Vector3(0, 0.03, 0),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI),
      new THREE.Vector3(1, 1, 1),
    );
    /** How the ground model lays the hand model's piece down: turned onto its side, scaled to the size it is held at, and moved. */
    const LAID_DOWN = new THREE.Matrix4().compose(
      new THREE.Vector3(0.05, 0.02, -0.1),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 1.1, Math.PI / 2)),
      new THREE.Vector3().setScalar(CHARACTER_SCALE),
    );

    /**
     * A scene where `self` stands at (10, 10) holding a sword and a shield, whose hand models are
     * kept in `props`, and the sword lies on the ground as `lying`, the same blade laid down, or,
     * `mirrored`, the blade laid down as its mirror image, which is not one piece with it.
     */
    function throwingFromHand(options: { reducedMotion?: boolean; mirrored?: boolean } = {}) {
      const props: Record<string, THREE.Mesh> = {};
      const hand = (baseId: string): THREE.Object3D => {
        const mesh = new THREE.Mesh(BLADE);
        mesh.applyMatrix4(GRIP);
        props[baseId] = mesh;
        return new THREE.Group().add(mesh);
      };
      const mirror = new THREE.Matrix4().makeScale(options.mirrored === true ? -1 : 1, 1, 1);
      const lying = new THREE.Mesh(BLADE.clone().applyMatrix4(LAID_DOWN.clone().multiply(mirror).multiply(GRIP)));
      const combat = combatScene({ ...options, hand, ground: () => new THREE.Group().add(lying) });
      place(combat.scene, 'self', { x: 10, z: 10 }, { held: { mainHand: 'sword', offHand: 'shield' } });
      combat.scene.tick(0.01);
      const bones = { mainHand: combat.models[0]!.getObjectByName('handslotr')!, offHand: combat.models[0]!.getObjectByName('handslotl')! };
      /** What each hand draws. */
      const inHands = () => ({ mainHand: bones.mainHand.children.length, offHand: bones.offHand.children.length });
      /** Where each corner of the blade is drawn, from the given mesh. */
      const drawnAt = (mesh: THREE.Mesh): THREE.Vector3[] => {
        combat.scene.scene.updateMatrixWorld(true);
        const position = mesh.geometry.getAttribute('position');
        return Array.from({ length: position.count }, (_, index) => new THREE.Vector3().fromBufferAttribute(position, index).applyMatrix4(mesh.matrixWorld));
      };
      return { ...combat, props, lying, bones, inHands, drawnAt };
    }

    /** The farthest any corner of the blade is drawn from where it was. */
    function farthest(from: readonly THREE.Vector3[], to: readonly THREE.Vector3[]): number {
      return Math.max(...from.map((corner, index) => corner.distanceTo(to[index]!)));
    }

    it('keeps the item on the hand through the wind-up, though the hands are shown emptied, and flies it from where and as it was drawn as it leaves the hand, the other hand emptied at once', () => {
      const { scene, props, lying, inHands, drawnAt } = throwingFromHand();
      const sword = props.sword!;
      scene.showLoot({ lootId: 'loot-1', ...LANDS, contents: SWORD, shared: true, from: FROM_HAND });
      scene.updateHeld('self', {});
      expect(inHands()).toEqual({ mainHand: 1, offHand: 0 });

      run(scene, 0.2);
      expect([inHands(), isDrawn(lying)]).toEqual([{ mainHand: 1, offHand: 0 }, false]);

      let held = drawnAt(sword);
      let ticks = 0;
      for (; sword.parent!.parent !== null && ticks < 10; ticks += 1) {
        held = drawnAt(sword);
        scene.tick(0.01);
      }
      expect(ticks).toBeLessThan(10);
      // On the frame the sword leaves the hand, the drop is drawn where it was, turned as it was.
      expect([inHands(), isDrawn(lying)]).toEqual([{ mainHand: 0, offHand: 0 }, true]);
      expect(farthest(held, drawnAt(lying))).toBeLessThan(1e-5);
      scene.tick(0.01);
      expect(farthest(held, drawnAt(lying))).toBeGreaterThan(1e-3);

      run(scene, 1);
      expect(lying.getWorldPosition(new THREE.Vector3())).toEqual(new THREE.Vector3(LANDS.x, 0, LANDS.z));
    });

    it("flies an item whose hand model and ground model are not one piece from the hand's bone, the hand's model gone as it leaves", () => {
      const { scene, props, lying, bones, inHands } = throwingFromHand({ mirrored: true });
      const sword = props.sword!;
      scene.showLoot({ lootId: 'loot-1', ...LANDS, contents: SWORD, shared: true, from: FROM_HAND });
      scene.updateHeld('self', {});
      run(scene, 0.2);
      let ticks = 0;
      for (; sword.parent!.parent !== null && ticks < 10; ticks += 1) scene.tick(0.01);
      expect(ticks).toBeLessThan(10);

      // On the frame the sword leaves the hand, the drop leaves from the hand's bone, lying level as it lies on the ground, not turned as the hand held it.
      scene.scene.updateMatrixWorld(true);
      expect([inHands(), isDrawn(lying)]).toEqual([{ mainHand: 0, offHand: 0 }, true]);
      const hand = bones.mainHand.getWorldPosition(new THREE.Vector3());
      expect(lying.getWorldPosition(new THREE.Vector3()).distanceTo(hand)).toBeLessThan(1e-6);
      expect(hand.y).toBeGreaterThan(0.2);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(lying.getWorldQuaternion(new THREE.Quaternion()));
      expect(up.y).toBeCloseTo(1, 9);
      expect(new THREE.Vector3(0, 1, 0).applyQuaternion(bones.mainHand.getWorldQuaternion(new THREE.Quaternion())).y).toBeLessThan(0.99);

      run(scene, 1);
      expect(lying.getWorldPosition(new THREE.Vector3())).toEqual(new THREE.Vector3(LANDS.x, 0, LANDS.z));
    });

    it.each<[string, { reducedMotion?: boolean }, (combat: ReturnType<typeof throwingFromHand>) => void]>([
      ['under reduced motion', { reducedMotion: true }, () => {}],
      ['shown while the tab stalls', {}, ({ hide }) => hide(2000)],
    ])('empties the hand at once and lays the drop where it lies %s', (_label, options, before) => {
      const combat = throwingFromHand(options);
      before(combat);
      combat.scene.showLoot({ lootId: 'loot-1', ...LANDS, contents: SWORD, shared: true, from: FROM_HAND });
      combat.scene.updateHeld('self', {});
      expect([combat.inHands(), isDrawn(combat.lying), combat.lying.getWorldPosition(new THREE.Vector3())]).toEqual([
        { mainHand: 0, offHand: 0 },
        true,
        new THREE.Vector3(LANDS.x, 0, LANDS.z),
      ]);
    });

    it('lets go of the hand and lays the drop where it lies once the tab stalls in the wind-up', () => {
      const { scene, hide, inHands, lying } = throwingFromHand();
      scene.showLoot({ lootId: 'loot-1', ...LANDS, contents: SWORD, shared: true, from: FROM_HAND });
      scene.updateHeld('self', {});
      run(scene, 0.1);
      hide(2000);
      scene.tick(0.01);
      expect([inHands(), isDrawn(lying), lying.getWorldPosition(new THREE.Vector3())]).toEqual([
        { mainHand: 0, offHand: 0 },
        true,
        new THREE.Vector3(LANDS.x, 0, LANDS.z),
      ]);
    });
  });
});

describe('a look the server times', () => {
  const outlinedIn = (scene: WorldScene, color: number) =>
    visible(hulls(scene, THREE.BackSide)).some((mesh) => (mesh.material as THREE.MeshBasicMaterial).color.getHex() === color);
  const looks = [
    { effectId: 'weakened', holder: 'monster:1', shows: (scene: WorldScene) => outlinedIn(scene, 0xc4a8ff) },
    { effectId: 'bound', holder: 'monster:1', shows: (scene: WorldScene) => visible(tethers(scene)).length > 0 },
    {
      effectId: 'veiled',
      holder: 'peer',
      shows: (scene: WorldScene) =>
        visible(hulls(scene, THREE.FrontSide)).some((mesh) => (mesh.material as THREE.MeshBasicMaterial).color.getHex() === 0xbdb6d8),
    },
    { effectId: 'calmed', holder: 'peer', shows: (scene: WorldScene) => outlinedIn(scene, 0x9fd8ff) },
  ] as const;

  it.each(looks)(
    'shows $effectId as long as an effects frame says, past its rank-1 seconds, and ends it when one leaves it out',
    ({ effectId, holder, shows }) => {
      const { scene } = combatScene();
      place(scene, 'self', { x: 10, z: 10 });
      place(scene, 'peer', { x: 13, z: 10 });
      place(scene, 'monster:1', { x: 10, z: 13 });
      scene.tick(0.01);
      const seconds = effectSeconds(effectId, 1) + 3;
      scene.showEffects(holder, [{ effectId, seconds }]);
      run(scene, seconds - 0.5);
      expect(shows(scene)).toBe(true);
      run(scene, 1);
      expect(shows(scene)).toBe(false);

      scene.showEffects(holder, [{ effectId, seconds }]);
      run(scene, 1);
      expect(shows(scene)).toBe(true);
      scene.showEffects(holder, []);
      run(scene, 1);
      expect(shows(scene)).toBe(false);
    },
  );
});

describe('the pools and the programs', () => {
  /** Every ability and a hit, on the same bodies, once through. */
  function everything(scene: WorldScene): void {
    scene.showBlow('self', 'monster:1', true);
    scene.showBlow('monster:1', 'self', true);
    scene.showAbility('self', 'cleave', undefined);
    scene.showBlow('self', 'monster:1', true);
    scene.showAbility('self', 'challenge', undefined);
    scene.showAbility('self', 'brace', undefined);
    scene.showAbility('self', 'lunge', 'monster:1');
    scene.showAbility('self', 'rally', undefined);
    scene.showBlow('self', 'monster:1', false);
    scene.showMend('peer');
    scene.showAbility('self', 'renewal', 'peer');
    scene.showAbility('self', 'radiance', undefined);
    scene.showAbility('self', 'calm', undefined);
    scene.showAbility('self', 'deep-mend', 'peer', { phase: 'start', seconds: 1.5 });
    scene.showRaising('peer', { progress: 0.2, seconds: 3 });
    run(scene, 0.5, 0.05);
    scene.showAbility('self', 'deep-mend', 'peer', { phase: 'done' });
    scene.showRaising('peer', undefined);
    scene.showAbility('self', 'ward', 'peer');
    scene.showAbility('self', 'weaken', 'monster:1');
    scene.showAbility('self', 'bind', 'monster:1');
    scene.showAbility('self', 'dream-bolt', 'monster:1');
    scene.showAbility('self', 'veil', undefined);
    run(scene, 0.4, 0.05);
    scene.showBlow('monster:1', 'peer', true);
    run(scene, 0.3, 0.05);
  }

  function fight(): WorldScene {
    const { scene } = combatScene();
    place(scene, 'self', { x: 10, z: 10 });
    place(scene, 'monster:1', { x: 10, z: 10.8 });
    place(scene, 'peer', { x: 11, z: 10 });
    return scene;
  }

  it('hands out the oldest mesh again past each pool size, so a long fight draws no more meshes', () => {
    const scene = fight();
    // More nightmares north of the fight than there are marks, for Challenge to reach.
    for (let index = 0; index <= EFFECT_POOL_SIZES.marks; index += 1) place(scene, `monster:north-${index}`, { x: 7 + index * 0.7, z: 7.5 });
    for (let round = 0; round < 20; round += 1) everything(scene);
    const drawn = [...effects(scene).children];
    expect(arcs(scene).length).toBeLessThanOrEqual(EFFECT_POOL_SIZES.swingArcs + EFFECT_POOL_SIZES.cleaveArcs);
    expect(sparks(scene)).toHaveLength(EFFECT_POOL_SIZES.sparks);
    expect(marks(scene)).toHaveLength(EFFECT_POOL_SIZES.marks);
    expect(visible(marks(scene))).toHaveLength(EFFECT_POOL_SIZES.marks);
    expect(motes(scene)).toHaveLength(EFFECT_POOL_SIZES.motes + EFFECT_POOL_SIZES.streams);
    expect(missWords(scene).length).toBeLessThanOrEqual(EFFECT_POOL_SIZES.misses);
    expect(shells(scene).length).toBeLessThanOrEqual(EFFECT_POOL_SIZES.shells);
    expect(bolts(scene)).toHaveLength(EFFECT_POOL_SIZES.bolts);
    expect(cracks(scene)).toHaveLength(EFFECT_POOL_SIZES.cracks);
    expect(tethers(scene).length).toBeLessThanOrEqual(EFFECT_POOL_SIZES.tethers);
    expect(domes(scene)).toHaveLength(EFFECT_POOL_SIZES.domes);

    for (let round = 0; round < 20; round += 1) everything(scene);
    expect(effects(scene).children).toHaveLength(drawn.length);
    expect(effects(scene).children.every((child, index) => child === drawn[index])).toBe(true);
  });

  /**
   * three.js compiles a program per distinct variant: what a material is and how its shaders read.
   * The effects draw with clones of a few materials, so once each kind has drawn a fight compiles nothing more.
   */
  it('draws every effect with clones of a handful of materials, and once the pools are full a fight brings no new material at all', () => {
    const scene = fight();
    const variants = (): Set<string> => programVariants(effects(scene));
    everything(scene);
    const firstVariants = variants();
    for (let round = 0; round < 20; round += 1) everything(scene);
    expect(variants()).toEqual(firstVariants);
    const full = materialsOf(effects(scene));

    for (let round = 0; round < 10; round += 1) everything(scene);
    const later = materialsOf(effects(scene));
    expect(later).toHaveLength(full.length);
    expect(later.every((material, index) => material === full[index])).toBe(true);

    // A body joining the fight brings its own flash and outline, of the variants already drawn.
    place(scene, 'monster:2', { x: 9.4, z: 10.6 });
    scene.showBlow('self', 'monster:2', true);
    scene.showAbility('monster:2', 'brace', undefined);
    run(scene, 0.5, 0.05);
    expect(variants()).toEqual(firstVariants);
    expect(firstVariants.size).toBeLessThanOrEqual(15);
  });

  /** A program compiled on its first draw stalls the frame it draws in, which in a browser can take half a second. */
  it("compiles every program a fight draws in the prewarm, in the world's light, before any of it draws", async () => {
    const scene = fight();
    let compiled = new Set<string>();
    const compileAsync = vi.fn((root: THREE.Object3D) => {
      compiled = new Set([...compiled, ...programVariants(root)]);
      return Promise.resolve(root);
    });
    await scene.prewarm({ compileAsync });
    expect(compileAsync).toHaveBeenCalledWith(effects(scene), scene.camera, scene.scene);

    everything(scene);
    expect([...programVariants(effects(scene))].filter((variant) => !compiled.has(variant))).toEqual([]);
  });

  it('compiles the programs a drop on the ground draws in the prewarm, and adds no light', async () => {
    const scene = fight();
    const loot = scene.scene.getObjectByName(LOOT_MARKERS_NAME)!;
    let compiled = new Set<string>();
    const compileAsync = vi.fn((root: THREE.Object3D) => {
      compiled = new Set([...compiled, ...programVariants(root)]);
      return Promise.resolve(root);
    });
    const lights = (): number => scene.scene.children.filter((child) => (child as THREE.Light).isLight).length;
    const before = lights();
    await scene.prewarm({ compileAsync });
    expect(compileAsync).toHaveBeenCalledWith(loot, scene.camera, scene.scene);

    for (const rarity of RARITIES) scene.showLoot({ lootId: `loot-${rarity}`, x: 12, z: 10, contents: { kind: 'item', baseId: 'cap', rarity } });
    expect([...programVariants(loot)].filter((variant) => !compiled.has(variant))).toEqual([]);
    expect(lights()).toBe(before);
  });

  /** A disposed material releases its program, which three deletes once no material uses it, so the next flash or brace would compile it again. */
  it("keeps the flash's and the outline's materials of a body that leaves, or of a space left, for the next body, never disposing them", () => {
    const { scene } = combatScene();
    place(scene, 'self', { x: 10, z: 10 });
    place(scene, 'monster:1', { x: 10, z: 10.8 });
    scene.tick(0.01);
    const hullMaterials = (): Set<THREE.Material> =>
      new Set([...hulls(scene, THREE.FrontSide), ...hulls(scene, THREE.BackSide)].map((mesh) => mesh.material as THREE.Material));
    const disposed: THREE.Material[] = [];

    scene.showBlow('self', 'monster:1', true);
    scene.showAbility('monster:1', 'brace', undefined);
    run(scene, 0.5);
    const first = hullMaterials();
    expect(first.size).toBe(2);
    for (const material of first) material.addEventListener('dispose', () => disposed.push(material));

    scene.removeEntity('monster:1');
    expect(hullMaterials().size).toBe(0);
    place(scene, 'monster:2', { x: 10, z: 10.8 });
    scene.showBlow('self', 'monster:2', true);
    scene.showAbility('monster:2', 'brace', undefined);
    run(scene, 0.5);
    expect(hullMaterials()).toEqual(first);

    scene.showSplash();
    place(scene, 'self', { x: 10, z: 10 });
    place(scene, 'monster:3', { x: 10, z: 10.8 });
    scene.tick(0.01);
    scene.showBlow('self', 'monster:3', true);
    scene.showAbility('monster:3', 'brace', undefined);
    run(scene, 0.5);
    expect(hullMaterials()).toEqual(first);
    expect(disposed).toEqual([]);
  });
});

function materialsOf(root: THREE.Object3D): THREE.Material[] {
  const materials: THREE.Material[] = [];
  root.traverse((object) => {
    const material = (object as THREE.Mesh).material;
    if (material !== undefined) materials.push(...(Array.isArray(material) ? material : [material]));
  });
  return materials;
}

/**
 * The program variant of each mesh drawn under `root`, keyed as three.js keys it: what its material
 * is, how its shaders read, and what of its geometry and skeleton they read.
 */
function programVariants(root: THREE.Object3D): Set<string> {
  const variants = new Set<string>();
  root.traverse((object) => {
    const { material, geometry } = object as THREE.Mesh;
    if (material === undefined) return;
    for (const each of Array.isArray(material) ? material : [material]) {
      variants.add(
        [
          each.type,
          each.side,
          each.customProgramCacheKey(),
          (each as THREE.ShaderMaterial).vertexShader,
          (each as THREE.ShaderMaterial).fragmentShader,
          ((each as THREE.MeshBasicMaterial).map ?? null) !== null,
          (object as THREE.SkinnedMesh).isSkinnedMesh === true,
          geometry.hasAttribute('position'),
          geometry.hasAttribute('normal'),
        ].join('|'),
      );
    }
  });
  return variants;
}
