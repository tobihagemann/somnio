import type * as THREE from 'three';
import { headingFromVector, headingRadians } from '@somnio/core';
import type { Heading, ModelRegistry, Point, Rect, Size } from '@somnio/core';
import { gridPoint, screenPoint } from '../canvasController';
import type { EditorTool } from '../canvasController';
import { floorPointAtScreen } from '../picking';
import type { ScreenPoint, ViewportSize } from '../picking';
import { millimetres, quantize, stepOrFine } from '../preferences';

/**
 * The geometry of a canvas drag, in sector-relative metres: deltas, placement and resize rects,
 * handle positions and hit-tests, the marquee's intersection test, and the facing handle.
 */

/** Drawn extent of the resize/facing handles, in viewport points. */
export const HANDLE_DRAW_EXTENT_PT = 8;
/** Hit-test extent around each handle center — larger than the drawn square. */
const HANDLE_HIT_EXTENT_PT = 14;
/** Screen clearance between a record and its facing handle. */
export const FACING_CLEARANCE_PT = 24;
/** A gesture travelling less than this is a tap: placement drops the tap size. */
export const TAP_TRANSLATION_THRESHOLD_PT = 4;

/** What a tap with a rect tool places. */
export const TAP_SIZE: Size = { width: 1, depth: 1 };

const RESIZE_HANDLES = ['topLeft', 'top', 'topRight', 'left', 'right', 'bottomLeft', 'bottom', 'bottomRight'] as const;
export type ResizeHandle = (typeof RESIZE_HANDLES)[number];

function movesLeftEdge(handle: ResizeHandle): boolean {
  return handle === 'topLeft' || handle === 'left' || handle === 'bottomLeft';
}
function movesRightEdge(handle: ResizeHandle): boolean {
  return handle === 'topRight' || handle === 'right' || handle === 'bottomRight';
}
function movesTopEdge(handle: ResizeHandle): boolean {
  return handle === 'topLeft' || handle === 'top' || handle === 'topRight';
}
function movesBottomEdge(handle: ResizeHandle): boolean {
  return handle === 'bottomLeft' || handle === 'bottom' || handle === 'bottomRight';
}

/** What every step of a drag needs: the projection, where the document's sector stands in it, the snap step, and the registry placements take their footprints from. */
export interface DragContext {
  camera: THREE.OrthographicCamera;
  viewport: ViewportSize;
  /** The sector's origin in its space, which is the frame the camera sees. */
  origin: Point;
  gridStep: number;
  registry: ModelRegistry;
}

/**
 * Metres covered by one viewport point at the given framing: the orthographic scale is the
 * view volume's vertical HALF-height, so the viewport height spans `2 x scale` metres.
 * Derived from the live camera so drawing and hit-testing cannot disagree.
 */
export function metresPerViewportPoint(context: DragContext): number {
  if (context.viewport.height <= 0) return 1;
  return (context.camera.top * 2) / context.viewport.height;
}

/**
 * Quantized ground delta between two viewport points. Quantizing the delta (not the endpoints)
 * keeps a group move's relative offsets intact.
 */
export function gridDelta(start: ScreenPoint, end: ScreenPoint, context: DragContext): { dx: number; dz: number } {
  const from = floorPointAtScreen(context.camera, context.viewport, start);
  const to = floorPointAtScreen(context.camera, context.viewport, end);
  return { dx: quantize(to.x - from.x, context.gridStep), dz: quantize(to.z - from.z, context.gridStep) };
}

/**
 * The rect a placement drag resolves to: a tap, or a press with a tool that places a point,
 * drops the tap size at the anchor; a rubber-band drag spans anchor→end, at least one snap step
 * per axis.
 */
export function placementBounds(tool: EditorTool, anchor: Point, start: ScreenPoint, end: ScreenPoint, context: DragContext): Rect {
  const translation = Math.hypot(end.x - start.x, end.y - start.y);
  switch (tool) {
    case 'select':
    case 'placement':
    case 'npc':
    case 'spawn':
      return { ...anchor, ...TAP_SIZE };
    case 'blocker':
    case 'monsterSpawn':
    case 'floorPatch': {
      if (translation < TAP_TRANSLATION_THRESHOLD_PT) return { ...anchor, ...TAP_SIZE };
      const grid = gridPoint(context, end);
      const far = { x: quantize(grid.x, context.gridStep), z: quantize(grid.z, context.gridStep) };
      return rubberBandBounds(anchor, far, stepOrFine(context.gridStep));
    }
  }
}

/** Normalized rect between two quantized ground points, at least `minExtent` per axis. */
export function rubberBandBounds(anchor: Point, point: Point, minExtent: number): Rect {
  return {
    x: Math.min(anchor.x, point.x),
    z: Math.min(anchor.z, point.z),
    width: millimetres(Math.max(Math.abs(point.x - anchor.x), minExtent)),
    depth: millimetres(Math.max(Math.abs(point.z - anchor.z), minExtent)),
  };
}

/** The rect after dragging one handle by a quantized delta: the moved edge stops `minExtent` short of the opposite one, which stays put. */
export function resizedBounds(rect: Rect, handle: ResizeHandle, dx: number, dz: number, minExtent: number): Rect {
  let minX = rect.x;
  let minZ = rect.z;
  let maxX = minX + rect.width;
  let maxZ = minZ + rect.depth;
  if (movesLeftEdge(handle)) minX = Math.min(minX + dx, maxX - minExtent);
  if (movesRightEdge(handle)) maxX = Math.max(maxX + dx, minX + minExtent);
  if (movesTopEdge(handle)) minZ = Math.min(minZ + dz, maxZ - minExtent);
  if (movesBottomEdge(handle)) maxZ = Math.max(maxZ + dz, minZ + minExtent);
  return { x: millimetres(minX), z: millimetres(minZ), width: millimetres(maxX - minX), depth: millimetres(maxZ - minZ) };
}

/**
 * The 8 handle centers on a rect. Hit-testing projects these, and the overlay draws the same
 * centers, so the visible and grabbable handles cannot drift.
 */
export function handleCenters(rect: Rect): { handle: ResizeHandle; point: Point }[] {
  const minX = rect.x;
  const minZ = rect.z;
  const maxX = minX + rect.width;
  const maxZ = minZ + rect.depth;
  const midX = (minX + maxX) / 2;
  const midZ = (minZ + maxZ) / 2;
  const centers: Record<ResizeHandle, Point> = {
    topLeft: { x: minX, z: minZ },
    top: { x: midX, z: minZ },
    topRight: { x: maxX, z: minZ },
    left: { x: minX, z: midZ },
    right: { x: maxX, z: midZ },
    bottomLeft: { x: minX, z: maxZ },
    bottom: { x: midX, z: maxZ },
    bottomRight: { x: maxX, z: maxZ },
  };
  return RESIZE_HANDLES.map((handle) => ({ handle, point: centers[handle] }));
}

export function hitHandle(location: ScreenPoint, rect: Rect, context: DragContext): ResizeHandle | undefined {
  return handleCenters(rect).find(({ point }) => hitsHandle(location, point, context))?.handle;
}

/** Whether a viewport point lies in the constant-screen-size hit rect around a ground point's projection. */
export function hitsHandle(location: ScreenPoint, point: Point, context: DragContext): boolean {
  const projected = screenPoint(context, point);
  const half = HANDLE_HIT_EXTENT_PT / 2;
  return Math.abs(location.x - projected.x) <= half && Math.abs(location.y - projected.y) <= half;
}

/**
 * Viewport-space corners of a record's footprint, in edge order — the tilted camera maps a
 * floor rect to a rotated convex quad on screen.
 */
export function projectedCorners(corners: readonly Point[], context: DragContext): ScreenPoint[] {
  return corners.map((corner) => screenPoint(context, corner));
}

/**
 * Separating-axis intersection between an axis-aligned rect and a convex quad given in edge
 * order: the shapes overlap unless some axis — the rect's two, or a quad edge normal —
 * separates their projections.
 */
export function rectIntersectsConvexQuad(rect: { x: number; y: number; width: number; height: number }, quad: readonly ScreenPoint[]): boolean {
  const rectCorners: ScreenPoint[] = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
  const axes: ScreenPoint[] = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
  ];
  for (let index = 0; index < quad.length; index += 1) {
    const current = quad[index]!;
    const next = quad[(index + 1) % quad.length]!;
    axes.push({ x: current.y - next.y, y: next.x - current.x });
  }
  for (const axis of axes) {
    const span = (points: readonly ScreenPoint[]): { min: number; max: number } => {
      const projections = points.map((point) => point.x * axis.x + point.y * axis.y);
      return { min: Math.min(...projections), max: Math.max(...projections) };
    };
    const rectSpan = span(rectCorners);
    const quadSpan = span(quad);
    if (rectSpan.max < quadSpan.min || quadSpan.max < rectSpan.min) return false;
  }
  return true;
}

/**
 * Heading of the drag point around a record's center, in whole degrees and computed on the
 * ground — the tilted camera rotates/scales the floor axes on screen, so a viewport-space vector
 * would yield a wrong angle. A drag onto the center itself keeps `current`.
 */
export function headingFromDrag(location: ScreenPoint, center: Point, current: Heading, context: DragContext): Heading {
  const point = gridPoint(context, location);
  const dx = point.x - center.x;
  const dz = point.z - center.z;
  if (dx === 0 && dz === 0) return current;
  return Math.round(headingFromVector(dx, dz)) % 360;
}

/**
 * Where a record's facing handle sits: out from its center along the heading, cleared past the
 * record's own reach so it never lies on the record.
 */
export function facingHandlePoint(center: Point, reach: number, facing: Heading, clearance: number): Point {
  const radians = headingRadians(facing);
  return {
    x: center.x + Math.sin(radians) * (reach + clearance),
    z: center.z + Math.cos(radians) * (reach + clearance),
  };
}
