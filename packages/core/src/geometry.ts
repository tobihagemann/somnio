/**
 * Ground-plane geometry in metres: `x` runs east and `z` south. Angles are degrees
 * counter-clockwise seen from above.
 */

export interface Point {
  x: number;
  z: number;
}

export interface Size {
  width: number;
  depth: number;
}

/** Axis-aligned rectangle; `x`/`z` is the minimum corner. */
export interface Rect {
  x: number;
  z: number;
  width: number;
  depth: number;
}

export interface Segment {
  a: Point;
  b: Point;
}

/** Where a model stands: its origin and its yaw. A `Placement` is one. */
export interface Transform {
  x: number;
  z: number;
  yaw: number;
}

/**
 * How far apart two edges may be and still count as one. Origins, sizes, and registry rects are
 * decimal metres, so sums that should meet miss by a rounding error (`5.12 + 30.72` is
 * `35.839999999999996`); every adjacency, overlap, and edge test allows this much.
 */
export const EDGE_TOLERANCE = 0.001;

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** Edges are inclusive; `slack` widens the rect on every side. */
export function rectContains(rect: Rect, point: Point, slack = 0): boolean {
  return point.x >= rect.x - slack && point.x <= rect.x + rect.width + slack && point.z >= rect.z - slack && point.z <= rect.z + rect.depth + slack;
}

/** Whether two rects share ground, beyond `EDGE_TOLERANCE`; rects that only touch do not. */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    a.x + a.width - b.x > EDGE_TOLERANCE && b.x + b.width - a.x > EDGE_TOLERANCE && a.z + a.depth - b.z > EDGE_TOLERANCE && b.z + b.depth - a.z > EDGE_TOLERANCE
  );
}

/**
 * A model-space point (the model's +X east and +Z south at yaw 0) in the space the transform
 * stands in. Together with `worldToModel` this is the one definition of a placement's yaw: a
 * model-space heading `h` faces `h + yaw` in the world.
 */
export function modelToWorld(transform: Transform, point: Point): Point {
  const radians = (transform.yaw * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: transform.x + point.x * cos + point.z * sin,
    z: transform.z - point.x * sin + point.z * cos,
  };
}

/** The inverse of `modelToWorld`. */
export function worldToModel(transform: Transform, point: Point): Point {
  const radians = (transform.yaw * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = point.x - transform.x;
  const dz = point.z - transform.z;
  return {
    x: dx * cos - dz * sin,
    z: dx * sin + dz * cos,
  };
}

/** Confines `value` to `[lower, upper]`. */
export function clamp(value: number, lower: number, upper: number): number {
  return Math.min(Math.max(value, lower), upper);
}
