import * as THREE from 'three';
import type { Point } from '@somnio/core';

/**
 * Screen ↔ floor mapping for the editor's picking and gizmo paths.
 *
 * A `THREE.Raycaster` against the floor plane rather than an analytic inverse: Three.js owns
 * the projection matrix, so there is no mirrored math to keep honest. The inverse
 * (`screenAtFloorPoint`) **returns coordinates — it does not create elements**: handle
 * hit-testing happens in screen space by comparing the press point against projected handle
 * centres, so no parallel DOM handle layer exists to drift out of sync.
 */

export interface ViewportSize {
  width: number;
  height: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

const raycaster = new THREE.Raycaster();
const FLOOR_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const scratchNDC = new THREE.Vector2();
const scratchHit = new THREE.Vector3();
const scratchWorld = new THREE.Vector3();

/**
 * Unprojects a top-left-origin viewport point through the camera onto the floor plane
 * (Y = 0) and returns the ground point in space coordinates. The fixed 45° pitch keeps the ray
 * from ever running parallel to the floor, so the intersection always exists.
 */
export function floorPointAtScreen(camera: THREE.OrthographicCamera, viewport: ViewportSize, screen: ScreenPoint): Point {
  scratchNDC.set((screen.x / viewport.width) * 2 - 1, 1 - (screen.y / viewport.height) * 2);
  raycaster.setFromCamera(scratchNDC, camera);
  raycaster.ray.intersectPlane(FLOOR_PLANE, scratchHit);
  return { x: scratchHit.x, z: scratchHit.z };
}

/** Projects a ground point to its top-left-origin viewport point — the inverse. */
export function screenAtFloorPoint(camera: THREE.OrthographicCamera, viewport: ViewportSize, point: Point): ScreenPoint {
  scratchWorld.set(point.x, 0, point.z).project(camera);
  return {
    x: ((scratchWorld.x + 1) / 2) * viewport.width,
    y: ((1 - scratchWorld.y) / 2) * viewport.height,
  };
}
