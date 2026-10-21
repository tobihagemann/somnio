import type { ModelRegistry, Point, Sector } from '@somnio/core';
import type { DragContext } from './drag/geometry';
import { floorPointAtScreen, screenAtFloorPoint } from './picking';
import type { ScreenPoint } from './picking';
import { FINE_STEP, millimetres, stepOrFine } from './preferences';
import { markContains } from './groundMarks';
import { SPAWN_ID, byId, footprintContains, selectionFootprint } from './selection';
import type { EditorSelection } from './selection';

/**
 * Stateless canvas geometry and pick dispatch.
 */

export const EDITOR_TOOLS = ['select', 'placement', 'blocker', 'npc', 'monsterSpawn', 'ground', 'spawn'] as const;
export type EditorTool = (typeof EDITOR_TOOLS)[number];
/** The tools that place a record where the pointer lands. */
export type PlacingTool = Exclude<EditorTool, 'select' | 'ground'>;

/**
 * Converts a top-left viewport point to the ground point under it, relative to the document's
 * sector and to the millimetre.
 */
export function gridPoint(context: DragContext, screen: ScreenPoint): Point {
  const floor = floorPointAtScreen(context.camera, context.viewport, screen);
  return { x: millimetres(floor.x - context.origin.x), z: millimetres(floor.z - context.origin.z) };
}

/** The viewport point a sector-relative ground point projects to — the inverse of `gridPoint`. */
export function screenPoint(context: DragContext, point: Point): ScreenPoint {
  return screenAtFloorPoint(context.camera, context.viewport, { x: context.origin.x + point.x, z: context.origin.z + point.z });
}

/**
 * The delta an arrow-key nudge moves the selection by: one centimetre, or the grid step with
 * Shift held. Non-arrow keys resolve to `undefined`.
 */
export function nudgeDelta(key: string, shiftHeld: boolean, gridStep: number): { dx: number; dz: number } | undefined {
  const step = shiftHeld ? stepOrFine(gridStep) : FINE_STEP;
  switch (key) {
    case 'ArrowUp':
      return { dx: 0, dz: -step };
    case 'ArrowDown':
      return { dx: 0, dz: step };
    case 'ArrowLeft':
      return { dx: -step, dz: 0 };
    case 'ArrowRight':
      return { dx: step, dz: 0 };
    default:
      return undefined;
  }
}

/**
 * Pick candidates in preference order, back-to-front within each kind so the most-recently-
 * placed record wins overlaps. The body-sized markers and door triggers come first so they stay
 * reachable on top of the placement they stand on; placements come before every authored rect and
 * mark, so a click on a prop selects the prop and not the blocker, spawn area, or ground mark under
 * it.
 */
export function candidateSelections(sector: Sector): EditorSelection[] {
  const reversed = (kind: EditorSelection['kind'], records: readonly { id: string }[]): EditorSelection[] =>
    records.map((record): EditorSelection => ({ kind, id: record.id })).reverse();
  return [
    ...reversed('npc', sector.npcs),
    ...(sector.spawn === undefined ? [] : [{ kind: 'spawn', id: SPAWN_ID } as const]),
    ...reversed('door', sector.doors),
    ...reversed('placement', sector.placements),
    ...reversed('blocker', sector.blockers),
    ...reversed('monsterSpawn', sector.monsterSpawns),
    ...reversed('mark', sector.ground.marks),
  ];
}

/** A mark is hit on its shape, not on the rect it spans: a diagonal road's rect covers most of a sector. */
export function selectRecord(point: Point, sector: Sector, registry: ModelRegistry): EditorSelection | undefined {
  return candidateSelections(sector).find((candidate) => {
    if (candidate.kind === 'mark') {
      const mark = byId(sector.ground.marks, candidate.id);
      return mark !== undefined && markContains(mark, point);
    }
    const footprint = selectionFootprint(candidate, sector, registry);
    return footprint !== undefined && footprintContains(footprint, point);
  });
}
