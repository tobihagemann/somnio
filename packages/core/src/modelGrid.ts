import { EDGE_TOLERANCE } from './geometry.ts';
import type { Point, Rect } from './geometry.ts';

/**
 * Placed models filed by where they reach, so a collision check visits only the models near it
 * rather than every model in the space. Plain data, so it crosses `postMessage` with the collision
 * it indexes, whose models it holds as the same objects.
 */

/** A cell's side, in metres. */
const CELL = 2;

/** A model as the grid files it: where it stands and how far its geometry reaches from there. */
interface Filed {
  transform: Point;
  reach: number;
}

export interface ModelGrid<M extends Filed> {
  /**
   * The models whose reach square covers each cell, by `cellKey`. Only cells some model is filed
   * in are present, so the grid grows with the models however far apart their sectors lie.
   */
  cells: Map<number, M[]>;
}

export function buildModelGrid<M extends Filed>(models: readonly M[]): ModelGrid<M> {
  const cells = new Map<number, M[]>();
  for (const model of models) {
    const lastColumn = cellOf(model.transform.x + model.reach);
    const lastRow = cellOf(model.transform.z + model.reach);
    for (let row = firstRowOf(model); row <= lastRow; row += 1) {
      for (let column = firstColumnOf(model); column <= lastColumn; column += 1) {
        const key = cellKey(column, row);
        const filed = cells.get(key);
        if (filed === undefined) cells.set(key, [model]);
        else filed.push(model);
      }
    }
  }
  return { cells };
}

/**
 * Whether `visit` accepts one of the models near the rect, stopping at the first it accepts. It
 * visits each model at most once. It visits every model whose reach comes within `reach` of the
 * rect, and some beyond, so a caller still tests each. The rect is widened by `EDGE_TOLERANCE`
 * besides, so rounding at a cell's edge never drops a model the caller's test would keep.
 */
export function someModelNear<M extends Filed>(grid: ModelGrid<M>, rect: Rect, reach: number, visit: (model: M) => boolean): boolean {
  const pad = reach + EDGE_TOLERANCE;
  const firstColumn = cellOf(rect.x - pad);
  const firstRow = cellOf(rect.z - pad);
  const lastColumn = cellOf(rect.x + rect.width + pad);
  const lastRow = cellOf(rect.z + rect.depth + pad);
  for (let row = firstRow; row <= lastRow; row += 1) {
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const filed = grid.cells.get(cellKey(column, row));
      if (filed === undefined) continue;
      for (const model of filed) {
        // A model is visited in the first cell, by row and by column, that both it and the query cover.
        if (column !== Math.max(firstColumn, firstColumnOf(model)) || row !== Math.max(firstRow, firstRowOf(model))) continue;
        if (visit(model)) return true;
      }
    }
  }
  return false;
}

function firstColumnOf(model: Filed): number {
  return cellOf(model.transform.x - model.reach);
}

function firstRowOf(model: Filed): number {
  return cellOf(model.transform.z - model.reach);
}

function cellOf(at: number): number {
  return Math.floor(at / CELL);
}

/**
 * Unique while every row lies within ±32,767 cells of the origin. `maxCoordinateMetres` bounds a
 * sector's origin and its records' positions, and the registry's models reach a few metres past
 * them, so a model's rows stay far inside that.
 */
function cellKey(column: number, row: number): number {
  return column * 65_536 + row;
}
