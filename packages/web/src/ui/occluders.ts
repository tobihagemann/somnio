import { clamp } from '@somnio/core';
import type { ScreenRect } from '@/scene/bubbleLayout';

interface PageRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A point on the page in the canvas's normalized device coordinates, or `undefined` while the canvas has no size. */
export function viewportPoint(canvas: PageRect, x: number, y: number): { x: number; y: number } | undefined {
  if (canvas.width === 0 || canvas.height === 0) return undefined;
  return { x: ((x - canvas.left) / canvas.width) * 2 - 1, y: 1 - ((y - canvas.top) / canvas.height) * 2 };
}

/**
 * The page rects of what covers the canvas, as rects in its normalized device coordinates, clipped
 * to it. A hidden element measures nothing and covers nothing.
 */
export function screenOccluders(canvas: PageRect, elements: readonly PageRect[]): ScreenRect[] {
  if (canvas.width === 0 || canvas.height === 0) return [];
  const corner = (x: number, y: number) => {
    const point = viewportPoint(canvas, x, y)!;
    return { x: clamp(point.x, -1, 1), y: clamp(point.y, -1, 1) };
  };
  return elements
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .map((rect) => {
      const topLeft = corner(rect.left, rect.top);
      const bottomRight = corner(rect.left + rect.width, rect.top + rect.height);
      return { left: topLeft.x, bottom: bottomRight.y, right: bottomRight.x, top: topLeft.y };
    })
    .filter((rect) => rect.right > rect.left && rect.top > rect.bottom);
}
