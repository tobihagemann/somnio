/**
 * The HUD's portraits: each frame's circle, and the Character window's body, is a window onto the
 * canvas, where the in-world body itself is drawn again, after the world, through a camera of its
 * own. The body is not a copy, so whatever it does in the world the portrait shows in the same frame.
 *
 * Each portrait has a layer, which its subject's model and the scene's lights carry, so its camera
 * draws that body, with what its hands hold, under the world's own lights and nothing else: no
 * plaque, ring, ground, or placed prop.
 * The body's materials see the same lights, so they keep the programs the world compiled for them.
 */
import * as THREE from 'three';
import { clamp } from '@somnio/core';
import { applyFrustum } from './cameraRig';

/** The frames' two circles, and `body`, the Character window's whole body, drawn in a rect. */
export const PORTRAIT_SLOTS = ['own', 'target', 'body'] as const;
export type PortraitSlot = (typeof PORTRAIT_SLOTS)[number];

/** The layer each portrait's camera draws. The world's camera draws layer 0 alone, which every object keeps. */
export const PORTRAIT_LAYERS: Record<PortraitSlot, number> = { own: 1, target: 2, body: 3 };

/**
 * How a portrait frames its body, in shares of the body's standing height: `frame` from the top of
 * the circle to its bottom, the top of the head `headroom` below the circle's top. The camera looks
 * from `sideDegrees` round from the body's front and `elevationDegrees` above, or from
 * `lyingElevationDegrees` above a body that lies, from `distance` metres off.
 */
export const PORTRAIT = {
  frame: 0.85,
  headroom: 0.06,
  sideDegrees: 35,
  elevationDegrees: 8,
  lyingElevationDegrees: 60,
  distance: 3,
  /** The least standing height framed by, so a body measured at nothing is not framed at a point. */
  minHeight: 0.3,
  /** The least the hemisphere fill lights a portrait with, so a body in a dim room or at night still reads. */
  fillFloor: 1.1,
  /**
   * The backdrop, light behind the head and dark at the rim. Light enough that a dark body, such as
   * a Ghost, reads as a silhouette against it, where more fill would only wash out a pale one.
   */
  backdropCentre: 0x6e6680,
  backdropRim: 0x1c1824,
} as const;

interface Vector {
  x: number;
  y: number;
  z: number;
}

/** What a portrait is aimed at: the top of the head as drawn, the feet, the standing height, and the yaw the model is turned to. */
export interface PortraitSubject {
  head: Vector;
  feet: Vector;
  height: number;
  yaw: number;
}

/** Where a portrait's camera stands, what it looks at, and the half-height of what it shows, in metres. */
export interface PortraitFraming {
  eye: Vector;
  focus: Vector;
  halfHeight: number;
}

/**
 * A head-and-shoulders view three-quarters from the front of the body as it is turned. A body comes
 * down as it falls, so the view eases from that to looking down at the head as the head comes down.
 */
export function portraitFraming(subject: PortraitSubject): PortraitFraming {
  const height = Math.max(subject.height, PORTRAIT.minHeight);
  const upright = clamp((subject.head.y - subject.feet.y) / height, 0, 1);
  const focus = { x: subject.head.x, y: subject.head.y - (PORTRAIT.frame / 2 - PORTRAIT.headroom) * height * upright, z: subject.head.z };
  const elevation = THREE.MathUtils.degToRad(PORTRAIT.lyingElevationDegrees + (PORTRAIT.elevationDegrees - PORTRAIT.lyingElevationDegrees) * upright);
  const bearing = subject.yaw + THREE.MathUtils.degToRad(PORTRAIT.sideDegrees);
  const across = Math.cos(elevation) * PORTRAIT.distance;
  return {
    eye: { x: focus.x + Math.sin(bearing) * across, y: focus.y + Math.sin(elevation) * PORTRAIT.distance, z: focus.z + Math.cos(bearing) * across },
    focus,
    halfHeight: (PORTRAIT.frame * height) / 2,
  };
}

/**
 * How the Character window frames its body, in shares of the standing height: `frame` from the top
 * of its rect to its bottom, round the middle of the body from the feet to the top of the head. The
 * camera looks from `sideDegrees` round from the body's front, turned on by the window's own turn,
 * and `elevationDegrees` above, or from the portrait's lying elevation above a body that lies.
 */
export const BODY_VIEW = {
  frame: 1.08,
  sideDegrees: 25,
  elevationDegrees: 10,
} as const;

/** A whole body three-quarters from the front, turned `turn` radians further round it, as the Character window shows it. */
export function bodyFraming(subject: PortraitSubject, turn: number): PortraitFraming {
  const height = Math.max(subject.height, PORTRAIT.minHeight);
  const upright = clamp((subject.head.y - subject.feet.y) / height, 0, 1);
  const focus = { x: (subject.head.x + subject.feet.x) / 2, y: (subject.head.y + subject.feet.y) / 2, z: (subject.head.z + subject.feet.z) / 2 };
  const elevation = THREE.MathUtils.degToRad(PORTRAIT.lyingElevationDegrees + (BODY_VIEW.elevationDegrees - PORTRAIT.lyingElevationDegrees) * upright);
  const bearing = subject.yaw + THREE.MathUtils.degToRad(BODY_VIEW.sideDegrees) + turn;
  const across = Math.cos(elevation) * PORTRAIT.distance;
  return {
    eye: { x: focus.x + Math.sin(bearing) * across, y: focus.y + Math.sin(elevation) * PORTRAIT.distance, z: focus.z + Math.cos(bearing) * across },
    focus,
    halfHeight: (BODY_VIEW.frame * height) / 2,
  };
}

/** Turns a portrait's layer on or off across a subtree. */
export function setPortraitLayer(root: THREE.Object3D, layer: number, on: boolean): void {
  root.traverse((object) => {
    if (on) object.layers.enable(layer);
    else object.layers.disable(layer);
  });
}

/** A rect on the page, in CSS pixels. */
export interface PageRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A rect of the drawing buffer, in device pixels from its bottom-left corner, as WebGL counts them. */
export interface DeviceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where a portrait's circle lies in the canvas's drawing buffer; `undefined` while it is not shown or lies off the canvas. */
export function portraitViewport(slot: PageRect, canvas: PageRect, pixelRatio: number): DeviceRect | undefined {
  if (slot.width <= 0 || slot.height <= 0) return undefined;
  const left = Math.round((slot.left - canvas.left) * pixelRatio);
  const right = Math.round((slot.left + slot.width - canvas.left) * pixelRatio);
  const top = Math.round((slot.top - canvas.top) * pixelRatio);
  const bottom = Math.round((slot.top + slot.height - canvas.top) * pixelRatio);
  const bufferWidth = Math.floor(canvas.width * pixelRatio);
  const bufferHeight = Math.floor(canvas.height * pixelRatio);
  if (right <= 0 || bottom <= 0 || left >= bufferWidth || top >= bufferHeight) return undefined;
  return { x: left, y: bufferHeight - bottom, width: right - left, height: bottom - top };
}

/** What a portrait draws: where, and the body's framing, `undefined` for the backdrop alone. */
export interface PortraitShot {
  slot: PortraitSlot;
  viewport: DeviceRect;
  framing: PortraitFraming | undefined;
}

/** The part of the renderer a portrait pass drives, so a test can stand in for it without WebGL. */
export type PortraitRenderer = Pick<
  THREE.WebGLRenderer,
  'autoClear' | 'shadowMap' | 'state' | 'getPixelRatio' | 'getSize' | 'setViewport' | 'setScissor' | 'setScissorTest' | 'clearDepth' | 'render'
>;

/**
 * Draws the portraits over the world just rendered. A frame's is clipped to its circle by depth: a
 * square with the circle cut out is laid at the front, a disc of backdrop at the back, and the body
 * between them draws only inside the circle. Outside it, the world drawn under the frame stays. The
 * Character window's body fills its rect, whose backdrop covers all of it.
 *
 * The world's render drew the shadow maps this frame, so they are not drawn again. It also brought
 * the scene's matrices up to date.
 */
export class PortraitPass {
  private readonly cameras: Record<PortraitSlot, THREE.OrthographicCamera>;
  private readonly clip = new THREE.Scene();
  private readonly fill = new THREE.Scene();
  private readonly clipCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly size = new THREE.Vector2();

  constructor() {
    this.cameras = {
      own: portraitCamera(PORTRAIT_LAYERS.own),
      target: portraitCamera(PORTRAIT_LAYERS.target),
      body: portraitCamera(PORTRAIT_LAYERS.body),
    };
    const shape = new THREE.Shape([new THREE.Vector2(-2, -2), new THREE.Vector2(2, -2), new THREE.Vector2(2, 2), new THREE.Vector2(-2, 2)]);
    shape.holes.push(new THREE.Path().absarc(0, 0, 1, 0, Math.PI * 2, false));
    const surround = new THREE.Mesh(new THREE.ShapeGeometry(shape, 48), new THREE.MeshBasicMaterial({ colorWrite: false }));
    surround.position.z = -0.001;
    const backdrop = new THREE.Mesh(backdropGeometry(), new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }));
    backdrop.position.z = -0.999;
    this.clip.add(surround, backdrop);
    const square = new THREE.Mesh(squareBackdropGeometry(), backdrop.material);
    square.position.z = -0.999;
    this.fill.add(square);
  }

  draw(renderer: PortraitRenderer, scene: THREE.Scene, shots: readonly PortraitShot[]): void {
    if (shots.length === 0) return;
    const saved = {
      autoClear: renderer.autoClear,
      shadows: renderer.shadowMap.autoUpdate,
      background: scene.background,
      matrices: scene.matrixWorldAutoUpdate,
    };
    renderer.autoClear = false;
    renderer.shadowMap.autoUpdate = false;
    scene.background = null;
    scene.matrixWorldAutoUpdate = false;
    const ratio = renderer.getPixelRatio();
    renderer.setScissorTest(true);
    for (const { slot, viewport, framing } of shots) {
      const { x, y, width, height } = viewport;
      renderer.setViewport(x / ratio, y / ratio, width / ratio, height / ratio);
      renderer.setScissor(x / ratio, y / ratio, width / ratio, height / ratio);
      // The world's last draw may have left depth writes off, which a clear obeys.
      renderer.state.buffers.depth.setMask(true);
      renderer.clearDepth();
      renderer.render(slot === 'body' ? this.fill : this.clip, this.clipCamera);
      if (framing === undefined) continue;
      const camera = this.cameras[slot];
      aim(camera, framing, width / height);
      renderer.render(scene, camera);
    }
    renderer.setScissorTest(false);
    renderer.getSize(this.size);
    renderer.setViewport(0, 0, this.size.x, this.size.y);
    renderer.setScissor(0, 0, this.size.x, this.size.y);
    renderer.autoClear = saved.autoClear;
    renderer.shadowMap.autoUpdate = saved.shadows;
    scene.background = saved.background;
    scene.matrixWorldAutoUpdate = saved.matrices;
  }
}

function portraitCamera(layer: number): THREE.OrthographicCamera {
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, PORTRAIT.distance * 2);
  camera.layers.set(layer);
  return camera;
}

function aim(camera: THREE.OrthographicCamera, framing: PortraitFraming, aspect: number): void {
  const { eye, focus, halfHeight } = framing;
  applyFrustum(camera, halfHeight, aspect);
  camera.position.set(eye.x, eye.y, eye.z);
  camera.lookAt(focus.x, focus.y, focus.z);
  camera.updateMatrixWorld();
}

/** The backdrop's colour at a point of the clip camera's square: light a little above the middle, dark at the rim `reach` away. */
function backdropColor(x: number, y: number, reach: number): THREE.Color {
  const share = clamp(Math.hypot(x, y - 0.3) / reach, 0, 1);
  return new THREE.Color(PORTRAIT.backdropCentre).lerp(new THREE.Color(PORTRAIT.backdropRim), share);
}

/** The whole square, shaded as the disc is, its rim at the square's corners. */
function squareBackdropGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(2.1, 2.1, 16, 16);
  const position = geometry.getAttribute('position');
  const colors = new Float32Array(position.count * 3);
  for (let index = 0; index < position.count; index += 1) backdropColor(position.getX(index), position.getY(index), 1.6).toArray(colors, index * 3);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** A disc a little wider than the circle, lit from a little above its middle. */
function backdropGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.CircleGeometry(1.05, 48);
  const position = geometry.getAttribute('position');
  position.setY(0, 0.3);
  const centre = new THREE.Color(PORTRAIT.backdropCentre);
  const rim = new THREE.Color(PORTRAIT.backdropRim);
  const colors = new Float32Array(position.count * 3);
  for (let index = 0; index < position.count; index += 1) (index === 0 ? centre : rim).toArray(colors, index * 3);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}
