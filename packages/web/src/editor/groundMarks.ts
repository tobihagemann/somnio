import { clamp, distance } from '@somnio/core';
import type { Point, Rect } from '@somnio/core';
import { markPointBounds, maxMarkRadius } from '@somnio/protocol';
import type { GroundMark, GroundShape, SectorView } from '@somnio/protocol';
import { shapeDistance } from '@/scene/groundField';
import { millimetres } from './preferences';

/**
 * What the ground tool and the editing of a mark need: points kept where the sector codec accepts
 * them, a mark moved whole, and whether a point lies on a mark.
 */

/** A stroke's samples are kept at least this far apart. */
const STROKE_SAMPLE_SPACING = 0.15;

/** What the ground tool lays down next. */
export interface GroundBrush {
  materialId: string;
  radius: number;
}

export const DEFAULT_GROUND_BRUSH: GroundBrush = { materialId: 'dirt-path', radius: 0.8 };

/** A shape's points clamped into where the codec accepts them, to the millimetre. A stroke's radius is capped first. */
export function boundedShape(size: SectorView['size'], shape: GroundShape): GroundShape {
  const capped = cappedShape(size, shape);
  const bounds = markPointBounds(size, capped)!;
  const points = capped.points.map((point) => clampPoint(point, bounds));
  return { ...capped, points };
}

/** The shape with a stroke's radius capped to the widest the sector takes. */
function cappedShape(size: SectorView['size'], shape: GroundShape): GroundShape {
  return shape.kind === 'stroke' ? { ...shape, radius: Math.min(shape.radius, widestStroke(size)) } : shape;
}

/** `maxMarkRadius` to the millimetre below, so the point bound of a stroke that wide never falls between two millimetres. */
export function widestStroke(size: SectorView['size']): number {
  return Math.floor(maxMarkRadius(size) * 1000 + 1e-6) / 1000;
}

/** To the millimetre, and inside the bound: its edges are rounded inward, so a clamped point is a short decimal the codec accepts. */
function clampPoint(point: Point, bounds: Rect): Point {
  const inward = (value: number, round: (scaled: number) => number, slack: number): number => round(value * 1000 + slack) / 1000;
  const within = (value: number, low: number, high: number): number => clamp(millimetres(value), inward(low, Math.ceil, -1e-6), inward(high, Math.floor, 1e-6));
  return { x: within(point.x, bounds.x, bounds.x + bounds.width), z: within(point.z, bounds.z, bounds.z + bounds.depth) };
}

/** The mark moved by the delta as a whole: the delta is clamped so every point stays where the codec accepts it, and the shape keeps its form. */
export function translateMark(mark: GroundMark, dx: number, dz: number, size: SectorView['size']): void {
  // A stroke pasted from a larger sector may be wider than this one takes.
  mark.shape = cappedShape(size, mark.shape);
  const bounds = markPointBounds(size, mark.shape)!;
  const xs = mark.shape.points.map((point) => point.x);
  const zs = mark.shape.points.map((point) => point.z);
  const along = (delta: number, low: number, high: number, from: number, to: number): number => clamp(delta, from - low, to - high);
  const x = along(dx, Math.min(...xs), Math.max(...xs), bounds.x, bounds.x + bounds.width);
  const z = along(dz, Math.min(...zs), Math.max(...zs), bounds.z, bounds.z + bounds.depth);
  mark.shape.points = mark.shape.points.map((point) => clampPoint({ x: point.x + x, z: point.z + z }, bounds));
}

/** The widest a stroke through these points may be: its points never move, so the edge nearest one of them caps it. */
export function maxStrokeRadius(size: SectorView['size'], points: readonly Point[]): number {
  const unpadded = markPointBounds(size, { kind: 'stroke', radius: 0 })!;
  const room = Math.min(
    ...points.map((point) =>
      Math.min(point.x - unpadded.x, unpadded.x + unpadded.width - point.x, point.z - unpadded.z, unpadded.z + unpadded.depth - point.z),
    ),
  );
  return Math.max(0, Math.min(widestStroke(size), room));
}

/** Samples a drag into stroke points: the press, then each sample at least `STROKE_SAMPLE_SPACING` from the last kept. */
export function appendSample(samples: Point[], point: Point): void {
  const last = samples.at(-1);
  if (last === undefined || distance(last, point) >= STROKE_SAMPLE_SPACING) samples.push(point);
}

/** Whether the sector-relative point lies on the mark's shape, its feathered edge left out. */
export function markContains(mark: GroundMark, point: Point): boolean {
  return shapeDistance(mark.shape, point.x, point.z) <= 0;
}
