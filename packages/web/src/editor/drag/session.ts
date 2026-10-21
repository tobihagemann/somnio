import { angularDistance } from '@somnio/core';
import type { Point, Rect, Sector } from '@somnio/core';
import type { GroundShape } from '@somnio/protocol';
import { gridPoint, selectRecord } from '../canvasController';
import type { EditorTool, PlacingTool } from '../canvasController';
import { appendSample, boundedShape } from '../groundMarks';
import type { ScreenPoint } from '../picking';
import { quantize, stepOrFine } from '../preferences';
import { ID_PREFIX, containsSelection, nextFreeId, rectRecord, toggleSelection } from '../selection';
import type { EditorSelection } from '../selection';
import {
  FACING_CLEARANCE_PT,
  TAP_TRANSLATION_THRESHOLD_PT,
  facingHandlePoint,
  gridDelta,
  headingFromDrag,
  hitHandle,
  hitsHandle,
  metresPerViewportPoint,
  placementBounds,
  resizedBounds,
} from './geometry';
import type { DragContext, ResizeHandle } from './geometry';
import { applyBounds, applyFacing, applyMove, marqueeSelections, origins, placeRecord, turnable } from './mutations';
import type { PlacementDefaults } from './mutations';

/**
 * The stateless drag interaction layer: session classification in fixed precedence (facing handle → resize
 * handles → Shift-toggle → marquee/move), live previews, and committed record mutations. The ground
 * tool's gestures are sessions of their own: a drag paints a stroke, and while a polygon is being
 * drawn every press belongs to it.
 */

/**
 * In-flight canvas drag, classified once at the gesture's first change. Move snapshots every
 * selected record's position at press time so the live delta always applies to the pre-drag
 * geometry; resize snapshots the grabbed record's rect for the same reason.
 */
export type DragSession =
  | { kind: 'placement'; tool: PlacingTool; anchor: Point }
  | { kind: 'move'; originals: { selection: EditorSelection; origin: Point }[] }
  | { kind: 'resize'; selection: EditorSelection; handle: ResizeHandle; rect: Rect }
  | { kind: 'rotate'; selection: EditorSelection }
  | { kind: 'marquee' }
  /** The drag's ground points, sampled as it goes. A press that never travels is a tap, which the shell takes as a polygon vertex. */
  | { kind: 'groundStroke'; samples: Point[] }
  /** A press while a polygon is being drawn: a tap adds a vertex, and a drag adds nothing. */
  | { kind: 'groundPolygon' };

/**
 * Classifies a gesture's first change into a session, possibly retargeting the selection.
 * Edit handles keep precedence over Shift — Shift+handle stays a resize/rotate grab.
 */
export function beginSession(
  location: ScreenPoint,
  tool: EditorTool,
  additive: boolean,
  sector: Sector,
  selection: readonly EditorSelection[],
  context: DragContext,
  drawingPolygon = false,
): { session: DragSession | undefined; selection: EditorSelection[] } {
  const point = gridPoint(context, location);
  if (tool === 'ground') {
    return { session: drawingPolygon ? { kind: 'groundPolygon' } : { kind: 'groundStroke', samples: [point] }, selection: [...selection] };
  }
  if (tool !== 'select') {
    const anchor = { x: quantize(point.x, context.gridStep), z: quantize(point.z, context.gridStep) };
    return { session: { kind: 'placement', tool, anchor }, selection: [...selection] };
  }

  if (selection.length === 1) {
    const selected = selection[0]!;
    const turned = turnable(selected, sector, context);
    if (turned !== undefined) {
      const handle = facingHandlePoint(turned.center, turned.reach, turned.facing, FACING_CLEARANCE_PT * metresPerViewportPoint(context));
      if (hitsHandle(location, handle, context)) return { session: { kind: 'rotate', selection: selected }, selection: [...selection] };
    }
    const rect = rectRecord(selected, sector);
    const handle = rect === undefined ? undefined : hitHandle(location, rect, context);
    if (rect !== undefined && handle !== undefined) {
      return {
        session: { kind: 'resize', selection: selected, handle, rect: { x: rect.x, z: rect.z, width: rect.width, depth: rect.depth } },
        selection: [...selection],
      };
    }
  }

  // Resolve the topmost record at the point first: pressing a record that overlaps the
  // current selection must manipulate what is visibly under the cursor.
  const picked = selectRecord(point, sector, context.registry);
  if (additive) {
    if (picked === undefined) return { session: { kind: 'marquee' }, selection: [...selection] };
    return { session: undefined, selection: toggleSelection(selection, picked) };
  }
  if (picked === undefined) return { session: { kind: 'marquee' }, selection: [] };
  if (containsSelection(selection, picked)) {
    return { session: { kind: 'move', originals: origins(selection, sector) }, selection: [...selection] };
  }
  return { session: { kind: 'move', originals: origins([picked], sector) }, selection: [picked] };
}

/**
 * The transient sector a live drag should render, or `undefined` when the session has no
 * floor-space preview (marquee draws a viewport rect instead).
 */
export function preview(
  session: DragSession,
  start: ScreenPoint,
  current: ScreenPoint,
  sector: Sector,
  context: DragContext,
  defaults: PlacementDefaults,
): Sector | undefined {
  switch (session.kind) {
    case 'placement': {
      const transient = structuredClone(sector);
      placeRecord(session.tool, placementBounds(session.tool, session.anchor, start, current, context), transient, defaults);
      return transient;
    }
    case 'move': {
      const delta = gridDelta(start, current, context);
      const transient = structuredClone(sector);
      applyMove(session.originals, delta.dx, delta.dz, transient);
      return transient;
    }
    case 'resize': {
      const delta = gridDelta(start, current, context);
      const transient = structuredClone(sector);
      applyBounds(session.selection, resizedBounds(session.rect, session.handle, delta.dx, delta.dz, stepOrFine(context.gridStep)), transient);
      return transient;
    }
    case 'rotate': {
      const turned = turnable(session.selection, sector, context);
      if (turned === undefined) return undefined;
      const transient = structuredClone(sector);
      applyFacing(session.selection, headingFromDrag(current, turned.center, turned.facing, context), transient);
      return transient;
    }
    case 'groundStroke': {
      appendSample(session.samples, gridPoint(context, current));
      const transient = structuredClone(sector);
      paintMark(strokeOf(session.samples, defaults), transient, defaults.brush);
      return transient;
    }
    case 'marquee':
    case 'groundPolygon':
      return undefined;
  }
}

function strokeOf(samples: readonly Point[], defaults: PlacementDefaults): GroundShape {
  return { kind: 'stroke', radius: defaults.brush.radius, points: [...samples] };
}

/** Appends a mark of the brush's material in the shape, kept where the codec accepts it, and returns its selection. */
export function paintMark(shape: GroundShape, sector: Sector, brush: PlacementDefaults['brush']): EditorSelection {
  const id = nextFreeId(ID_PREFIX.mark, sector.ground.marks);
  sector.ground.marks.push({ id, materialId: brush.materialId, opacity: 1, shape: boundedShape(sector.size, shape) });
  return { kind: 'mark', id };
}

export interface DragCommitTarget {
  mutate(actionName: string, change: (sector: Sector) => void): { accepted: boolean };
}

/**
 * Commits a finished drag: placement appends and selects the new record; move/resize/rotate
 * write one mutation each (no-op when the drag came back to its origin); marquee resolves
 * the viewport rect into a selection set. Returns the selection after the commit.
 */
export function endSession(
  session: DragSession,
  start: ScreenPoint,
  end: ScreenPoint,
  additive: boolean,
  document: DragCommitTarget,
  sector: Sector,
  selection: readonly EditorSelection[],
  context: DragContext,
  defaults: PlacementDefaults,
): EditorSelection[] {
  switch (session.kind) {
    case 'placement': {
      const bounds = placementBounds(session.tool, session.anchor, start, end, context);
      let placed: EditorSelection | undefined;
      const { accepted } = document.mutate(placementDescription(session.tool), (draft) => {
        placed = placeRecord(session.tool, bounds, draft, defaults);
      });
      return accepted && placed !== undefined ? [placed] : [...selection];
    }
    case 'move': {
      const delta = gridDelta(start, end, context);
      if (session.originals.length === 0 || (delta.dx === 0 && delta.dz === 0)) return [...selection];
      document.mutate('Move selection', (draft) => {
        applyMove(session.originals, delta.dx, delta.dz, draft);
      });
      return [...selection];
    }
    case 'resize': {
      const delta = gridDelta(start, end, context);
      if (delta.dx === 0 && delta.dz === 0) return [...selection];
      const bounds = resizedBounds(session.rect, session.handle, delta.dx, delta.dz, stepOrFine(context.gridStep));
      document.mutate('Resize selection', (draft) => {
        applyBounds(session.selection, bounds, draft);
      });
      return [...selection];
    }
    case 'rotate': {
      commitRotation(session.selection, end, document, sector, context);
      return [...selection];
    }
    case 'marquee': {
      // A tap-sized marquee is just a click on empty ground: the deselection already happened
      // in `beginSession`, and a zero-size rect must not intersect-select whatever record's
      // projection happens to pass under the point.
      if (Math.hypot(end.x - start.x, end.y - start.y) < TAP_TRANSLATION_THRESHOLD_PT) {
        return [...selection];
      }
      const rect = {
        x: Math.min(start.x, end.x),
        y: Math.min(start.y, end.y),
        width: Math.abs(end.x - start.x),
        height: Math.abs(end.y - start.y),
      };
      const hits = marqueeSelections(sector, rect, context);
      if (!additive) return hits;
      const merged = [...selection];
      for (const hit of hits) {
        if (!containsSelection(merged, hit)) merged.push(hit);
      }
      return merged;
    }
    case 'groundStroke': {
      appendSample(session.samples, gridPoint(context, end));
      let painted: EditorSelection | undefined;
      const { accepted } = document.mutate('Paint ground', (draft) => {
        painted = paintMark(strokeOf(session.samples, defaults), draft, defaults.brush);
      });
      return accepted && painted !== undefined ? [painted] : [...selection];
    }
    case 'groundPolygon':
      return [...selection];
  }
}

/**
 * A grab that comes back to (essentially) the current heading turns nothing, so it is not sent
 * to the document, as a move or a resize with no travel is not.
 */
function commitRotation(selection: EditorSelection, end: ScreenPoint, document: DragCommitTarget, sector: Sector, context: DragContext): void {
  const turned = turnable(selection, sector, context);
  if (turned === undefined) return;
  const facing = headingFromDrag(end, turned.center, turned.facing, context);
  if (Math.abs(angularDistance(facing, turned.facing)) <= 0.01) return;
  document.mutate('Rotate selection', (draft) => {
    applyFacing(selection, facing, draft);
  });
}

function placementDescription(tool: PlacingTool): string {
  switch (tool) {
    case 'placement':
      return 'Place model';
    case 'blocker':
      return 'Place blocker';
    case 'npc':
      return 'Place NPC';
    case 'monsterSpawn':
      return 'Place monster spawn';
    case 'spawn':
      return 'Place spawn point';
  }
}
