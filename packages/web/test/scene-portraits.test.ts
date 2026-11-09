import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { WorldScene } from '@/scene/worldScene';
import type { ModelAssets } from '@/scene/modelAssets';
import { PORTRAIT, PORTRAIT_LAYERS, portraitFraming, portraitViewport, setPortraitLayer } from '@/scene/portraits';
import type { PortraitRenderer } from '@/scene/portraits';
import { CHARACTER_SCALE } from '@/scene/placement';
import { TEST_REGISTRY } from '../../core/test/support/worldFixture.ts';
import { clientEntity } from './helpers/worldFixture';

function assets(resolves: () => boolean): ModelAssets {
  return {
    prewarm: async () => {},
    character: () => (resolves() ? new THREE.Mesh(new THREE.BoxGeometry(0.4, 1, 0.4)) : undefined),
    object: () => undefined,
    clipsFor: () => [],
    prototypeMeshes: () => undefined,
  };
}

function makeScene(resolves = () => false): WorldScene {
  return new WorldScene(assets(resolves), TEST_REGISTRY, 1, false);
}

/** The meshes a portrait's camera draws, by the x they stand at. */
function drawnOn(scene: WorldScene, layer: number): number[] {
  const xs: number[] = [];
  scene.scene.traverse((object) => {
    if ((object as THREE.Mesh).isMesh && object.layers.isEnabled(layer)) xs.push(Math.round(object.getWorldPosition(new THREE.Vector3()).x));
  });
  return xs;
}

describe('portrait framing', () => {
  const feet = { x: 4, y: 0.5, z: 7 };

  it('looks at a standing head and shoulders from three-quarters in front and a little above', () => {
    const framing = portraitFraming({ head: { x: 4, y: 1.5, z: 7 }, feet, height: 1, yaw: 0 });
    expect(framing.halfHeight).toBeCloseTo(PORTRAIT.frame / 2);
    expect(framing.focus.y).toBeCloseTo(1.5 - (PORTRAIT.frame / 2 - PORTRAIT.headroom));
    const toward = { x: framing.eye.x - framing.focus.x, y: framing.eye.y - framing.focus.y, z: framing.eye.z - framing.focus.z };
    expect(Math.hypot(toward.x, toward.y, toward.z)).toBeCloseTo(PORTRAIT.distance);
    // Facing south (+z) at yaw 0: in front, and turned round toward the east by the side angle.
    expect(THREE.MathUtils.radToDeg(Math.atan2(toward.x, toward.z))).toBeCloseTo(PORTRAIT.sideDegrees);
    expect(THREE.MathUtils.radToDeg(Math.asin(toward.y / PORTRAIT.distance))).toBeCloseTo(PORTRAIT.elevationDegrees);
  });

  it('turns with the body as it is drawn', () => {
    const facingEast = portraitFraming({ head: { x: 4, y: 1.5, z: 7 }, feet, height: 1, yaw: Math.PI / 2 });
    const bearing = THREE.MathUtils.radToDeg(Math.atan2(facingEast.eye.x - facingEast.focus.x, facingEast.eye.z - facingEast.focus.z));
    expect(bearing).toBeCloseTo(90 + PORTRAIT.sideDegrees);
  });

  it('looks down at the head of a body that lies fallen, at the size it is framed standing', () => {
    const head = { x: 3.4, y: 0.5, z: 7.2 };
    const framing = portraitFraming({ head, feet, height: 1, yaw: 0 });
    expect(framing.focus).toEqual(head);
    expect(framing.halfHeight).toBeCloseTo(PORTRAIT.frame / 2);
    expect(THREE.MathUtils.radToDeg(Math.asin((framing.eye.y - framing.focus.y) / PORTRAIT.distance))).toBeCloseTo(PORTRAIT.lyingElevationDegrees);
  });

  it('frames a body measured at nothing by the least height', () => {
    expect(portraitFraming({ head: feet, feet, height: 0, yaw: 0 }).halfHeight).toBeCloseTo((PORTRAIT.frame * PORTRAIT.minHeight) / 2);
  });
});

describe('portrait viewports', () => {
  const canvas = { left: 0, top: 0, width: 1280, height: 720 };

  it("takes the circle's rect on the page into the drawing buffer by the pixel ratio, counted from the bottom", () => {
    expect(portraitViewport({ left: 24, top: 24, width: 52, height: 52 }, canvas, 1)).toEqual({ x: 24, y: 644, width: 52, height: 52 });
    expect(portraitViewport({ left: 24, top: 24, width: 52, height: 52 }, canvas, 2)).toEqual({ x: 48, y: 1288, width: 104, height: 104 });
    // A fractional rect lands on whole device pixels, and a canvas offset on the page counts from its own corner.
    expect(portraitViewport({ left: 110.25, top: 30.5, width: 40, height: 40 }, { ...canvas, left: 10, top: 10 }, 1.5)).toEqual({
      x: 150,
      y: 989,
      width: 60,
      height: 60,
    });
  });

  it('draws nothing for a hidden frame or one off the canvas', () => {
    expect(portraitViewport({ left: 0, top: 0, width: 0, height: 0 }, canvas, 2)).toBeUndefined();
    expect(portraitViewport({ left: 1300, top: 24, width: 52, height: 52 }, canvas, 2)).toBeUndefined();
  });
});

describe('portrait layers', () => {
  it('turns a layer on and off over a whole subtree', () => {
    const root = new THREE.Object3D();
    const child = new THREE.Mesh();
    root.add(child);
    setPortraitLayer(root, 2, true);
    expect([root.layers.isEnabled(2), child.layers.isEnabled(2), child.layers.isEnabled(0)]).toEqual([true, true, true]);
    setPortraitLayer(root, 2, false);
    expect([root.layers.isEnabled(2), child.layers.isEnabled(2), child.layers.isEnabled(0)]).toEqual([false, false, true]);
  });

  it("puts the subject's body alone on its portrait's layer, and moves it when the target changes", () => {
    const scene = makeScene();
    scene.placeEntity(clientEntity({ id: 'a', kind: 'peer', name: 'Ada', position: { x: 2, z: 5 } }));
    scene.placeEntity(clientEntity({ id: 'b', kind: 'monster', name: 'Ghost', condition: 'grazed', position: { x: 8, z: 5 } }));
    scene.showSelection('a', false);
    expect(drawnOn(scene, PORTRAIT_LAYERS.target)).toEqual([]);

    scene.setPortraitSubject('target', 'a');
    // The body's box and nothing hanging off its node: no plaque and no ring.
    expect(drawnOn(scene, PORTRAIT_LAYERS.target)).toEqual([2]);
    scene.setPortraitSubject('target', 'b');
    expect(drawnOn(scene, PORTRAIT_LAYERS.target)).toEqual([8]);
    expect(drawnOn(scene, PORTRAIT_LAYERS.own)).toEqual([]);
    scene.setPortraitSubject('target', undefined);
    expect(drawnOn(scene, PORTRAIT_LAYERS.target)).toEqual([]);
  });

  it("lights every portrait with the world's own lights, and nothing else of the world", () => {
    const scene = makeScene();
    const lights: THREE.Light[] = [];
    scene.scene.traverse((object) => {
      if ((object as THREE.Light).isLight) lights.push(object as THREE.Light);
    });
    expect(lights.length).toBeGreaterThan(0);
    for (const layer of Object.values(PORTRAIT_LAYERS)) expect(lights.every((light) => light.layers.isEnabled(layer))).toBe(true);
    scene.placeEntity(clientEntity({ id: 'a', kind: 'peer', position: { x: 2, z: 5 } }));
    expect(drawnOn(scene, PORTRAIT_LAYERS.own)).toEqual([]);
  });

  it('keeps the layer on a subject that leaves and comes back, and on a model put in after the prewarm', async () => {
    let resolves = false;
    const scene = makeScene(() => resolves);
    scene.setPortraitSubject('own', 'a');
    scene.placeEntity(clientEntity({ id: 'a', kind: 'peer', position: { x: 2, z: 5 } }));
    expect(drawnOn(scene, PORTRAIT_LAYERS.own)).toEqual([2]);
    scene.removeEntity('a');
    expect(drawnOn(scene, PORTRAIT_LAYERS.own)).toEqual([]);
    scene.placeEntity(clientEntity({ id: 'a', kind: 'peer', position: { x: 3, z: 5 } }));
    expect(drawnOn(scene, PORTRAIT_LAYERS.own)).toEqual([3]);
    resolves = true;
    await scene.prewarm();
    expect(drawnOn(scene, PORTRAIT_LAYERS.own)).toEqual([3]);
  });
});

describe('drawing portraits', () => {
  /** Stands in for the renderer, and records what each render was drawn with. */
  function fakeRenderer(scene: WorldScene) {
    const fill = scene.scene.children.find((object) => object instanceof THREE.HemisphereLight)!;
    const calls: unknown[][] = [];
    const renderer = {
      autoClear: true,
      shadowMap: { autoUpdate: true },
      state: { buffers: { depth: { setMask: (mask: boolean) => calls.push(['depthMask', mask]) } } },
      getPixelRatio: () => 2,
      getSize: (target: THREE.Vector2) => target.set(640, 360),
      setViewport: (...args: number[]) => calls.push(['viewport', ...args]),
      setScissor: (...args: number[]) => calls.push(['scissor', ...args]),
      setScissorTest: (on: boolean) => calls.push(['scissorTest', on]),
      clearDepth: () => calls.push(['clearDepth']),
      render: (drawn: THREE.Scene, camera: THREE.Camera) =>
        calls.push([
          'render',
          {
            world: drawn === scene.scene,
            layers: camera.layers.mask,
            camera: camera.position.clone(),
            top: (camera as THREE.OrthographicCamera).top,
            right: (camera as THREE.OrthographicCamera).right,
            background: drawn.background,
            matrices: drawn.matrixWorldAutoUpdate,
            shadows: renderer.shadowMap.autoUpdate,
            autoClear: renderer.autoClear,
            fill: fill.intensity,
          },
        ]),
    };
    return { renderer, calls, fill };
  }

  it('draws the body in the circle after the backdrop, without drawing the shadow maps again, and puts the renderer back as it was', () => {
    const scene = makeScene();
    scene.placeEntity(clientEntity({ id: 'm', kind: 'monster', name: 'Ghost', position: { x: 6, z: 9 } }));
    scene.setPortraitSubject('target', 'm');
    const { renderer, calls, fill } = fakeRenderer(scene);
    const background = scene.scene.background;
    fill.intensity = 0.1;

    scene.drawPortraits(renderer as unknown as PortraitRenderer, [{ slot: 'target', viewport: { x: 100, y: 600, width: 104, height: 104 } }]);

    const renders = calls.filter(([name]) => name === 'render').map(([, drawn]) => drawn as Record<string, unknown>);
    expect(renders.map((drawn) => drawn['world'])).toEqual([false, true]);
    expect(renders[1]).toMatchObject({
      layers: 1 << PORTRAIT_LAYERS.target,
      background: null,
      matrices: false,
      shadows: false,
      autoClear: false,
      fill: PORTRAIT.fillFloor,
    });
    const eye = renders[1]!['camera'] as THREE.Vector3;
    expect(Math.hypot(eye.x - 6, eye.z - 9)).toBeLessThan(PORTRAIT.distance);
    // Framed to the body as tall as it is drawn, a placeholder standing `CHARACTER_SCALE`, in a square viewport.
    expect(renders[1]!['top']).toBeCloseTo((PORTRAIT.frame * CHARACTER_SCALE) / 2, 6);
    expect(renders[1]!['right']).toBeCloseTo(renders[1]!['top'] as number, 6);
    // In CSS pixels, which the renderer scales by its own ratio.
    expect(calls.slice(0, 5)).toEqual([
      ['scissorTest', true],
      ['viewport', 50, 300, 52, 52],
      ['scissor', 50, 300, 52, 52],
      ['depthMask', true],
      ['clearDepth'],
    ]);
    expect(calls.slice(-3)).toEqual([
      ['scissorTest', false],
      ['viewport', 0, 0, 640, 360],
      ['scissor', 0, 0, 640, 360],
    ]);
    expect([renderer.autoClear, renderer.shadowMap.autoUpdate, scene.scene.background, scene.scene.matrixWorldAutoUpdate, fill.intensity]).toEqual([
      true,
      true,
      background,
      true,
      0.1,
    ]);
  });

  it('draws the backdrop alone while the subject is not in view, and nothing without a frame shown', () => {
    const scene = makeScene();
    scene.setPortraitSubject('own', 'gone');
    const { renderer, calls } = fakeRenderer(scene);
    scene.drawPortraits(renderer as unknown as PortraitRenderer, [{ slot: 'own', viewport: { x: 0, y: 0, width: 80, height: 80 } }]);
    expect(calls.filter(([name]) => name === 'render').map(([, drawn]) => (drawn as Record<string, unknown>)['world'])).toEqual([false]);
    calls.length = 0;
    scene.drawPortraits(renderer as unknown as PortraitRenderer, []);
    expect(calls).toEqual([]);
  });
});
