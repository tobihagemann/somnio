import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { effectSeconds, headingFromVector, headingRadians } from '@somnio/core';
import type { Point } from '@somnio/core';
import { WorldScene } from '@/scene/worldScene';
import type { ModelAssets } from '@/scene/modelAssets';
import { COMBAT_EFFECTS_NAME, EFFECT_POOL_SIZES, STRIKE_AT } from '@/scene/combatEffects';
import { CHARACTER_SCALE } from '@/scene/placement';
import { PORTRAIT_LAYERS } from '@/scene/portraits';
import type { ClientEntity } from '@/client';
import { TEST_REGISTRY } from '../../core/test/support/worldFixture.ts';
import { clientEntity } from './helpers/worldFixture';

const CLIP_SECONDS = 1;
const SLICE = 'Melee_1H_Attack_Slice_Horizontal';
const CLIPS = ['Idle', 'Flying_Idle', SLICE, 'Punch', 'Hit_A', 'Melee_Block', 'Ranged_Magic_Raise', 'Melee_1H_Attack_Jump_Chop', 'Cheering'].map(
  (name) => new THREE.AnimationClip(name, CLIP_SECONDS, []),
);
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
function combatScene(options: { reducedMotion?: boolean; clipless?: readonly number[] } = {}): {
  scene: WorldScene;
  models: THREE.Object3D[];
  hide: (ms: number) => void;
} {
  const models: THREE.Object3D[] = [];
  const assets: ModelAssets = {
    prewarm: async () => {},
    character: () => {
      const model = skinnedBody();
      models.push(model);
      return model;
    },
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

/** The Challenge pulses showing at the nightmares' feet, by their colour. */
function pulses(scene: WorldScene): THREE.Mesh[] {
  return visible(rings(scene)).filter((ring) => (ringUniforms(ring)!['uColor']!.value as THREE.Color).getHex() === 0xff7a5a);
}

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
    run(scene, 0.5, 0.05);
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
    const variants = (): Set<string> =>
      new Set(
        materialsOf(scene).map((material) =>
          [
            material.type,
            material.side,
            material.customProgramCacheKey(),
            (material as THREE.ShaderMaterial).vertexShader,
            (material as THREE.ShaderMaterial).fragmentShader,
          ].join('|'),
        ),
      );
    everything(scene);
    const firstVariants = variants();
    for (let round = 0; round < 20; round += 1) everything(scene);
    expect(variants()).toEqual(firstVariants);
    const full = materialsOf(scene);

    for (let round = 0; round < 10; round += 1) everything(scene);
    const later = materialsOf(scene);
    expect(later).toHaveLength(full.length);
    expect(later.every((material, index) => material === full[index])).toBe(true);

    // A body joining the fight brings its own flash and outline, of the variants already drawn.
    place(scene, 'monster:2', { x: 9.4, z: 10.6 });
    scene.showBlow('self', 'monster:2', true);
    scene.showAbility('monster:2', 'brace', undefined);
    run(scene, 0.5, 0.05);
    expect(variants()).toEqual(firstVariants);
    expect(firstVariants.size).toBeLessThanOrEqual(7);
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

function materialsOf(scene: WorldScene): THREE.Material[] {
  const materials: THREE.Material[] = [];
  effects(scene).traverse((object) => {
    const material = (object as THREE.Mesh).material;
    if (material !== undefined) materials.push(...(Array.isArray(material) ? material : [material]));
  });
  return materials;
}
