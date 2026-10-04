import { SOMNIO_CONSTANTS, heading, objectModel } from '@somnio/core';
import type { Heading, MonsterKindId, Point, Rect, Sector } from '@somnio/core';
import { placeholderFootprint } from '@/scene/placement';
import { candidateSelections } from '../canvasController';
import type { EditorTool } from '../canvasController';
import { millimetres } from '../preferences';
import { ID_PREFIX, SPAWN_ID, byId, footprintCorners, nextFreeId, positionedRecord, rectRecord, selectionFootprint } from '../selection';
import type { EditorSelection } from '../selection';
import { projectedCorners, rectIntersectsConvexQuad } from './geometry';
import type { DragContext } from './geometry';

/**
 * What a drag writes into a sector: moves, resizes, turns, and freshly placed records.
 */

/** Per-kind seeds for direct placement; ids come from the committed registry. */
export interface PlacementDefaults {
  modelId: string;
  floorMaterialId: string;
  characterModelId: string;
  monsterKind: MonsterKindId;
}

/** Position snapshot of every selected record that has one of its own, taken at press time. */
export function origins(selections: readonly EditorSelection[], sector: Sector): { selection: EditorSelection; origin: Point }[] {
  const snapshots: { selection: EditorSelection; origin: Point }[] = [];
  for (const selection of selections) {
    const record = positionedRecord(selection, sector);
    if (record !== undefined) snapshots.push({ selection, origin: { x: record.x, z: record.z } });
  }
  return snapshots;
}

export function applyMove(originals: readonly { selection: EditorSelection; origin: Point }[], dx: number, dz: number, sector: Sector): void {
  for (const { selection, origin } of originals) {
    const record = positionedRecord(selection, sector);
    if (record === undefined) continue;
    record.x = millimetres(origin.x + dx);
    record.z = millimetres(origin.z + dz);
  }
}

export function applyBounds(selection: EditorSelection, bounds: Rect, sector: Sector): void {
  const record = rectRecord(selection, sector);
  if (record !== undefined) Object.assign(record, bounds);
}

/** What a selection's facing handle turns: the point it turns about, how far the record reaches from it, and the heading the handle shows. */
export interface Turnable {
  center: Point;
  reach: number;
  facing: Heading;
}

/**
 * An NPC and the spawn point face their `facing`. A placement's handle shows where its model's
 * +X axis points, the side a normalized model's door is on, which is heading 90 at yaw 0.
 */
export function turnable(selection: EditorSelection, sector: Sector, context: DragContext): Turnable | undefined {
  switch (selection.kind) {
    case 'placement': {
      const placement = byId(sector.placements, selection.id);
      if (placement === undefined) return undefined;
      const size = placeholderFootprint(objectModel(context.registry, placement.modelId));
      return { center: placement, reach: Math.max(size.width, size.depth) / 2, facing: heading(placement.yaw + 90) };
    }
    case 'npc': {
      const npc = byId(sector.npcs, selection.id);
      return npc === undefined ? undefined : { center: npc, reach: SOMNIO_CONSTANTS.npcRadius, facing: npc.facing };
    }
    case 'spawn':
      return sector.spawn === undefined ? undefined : { center: sector.spawn, reach: SOMNIO_CONSTANTS.playerRadius, facing: sector.spawn.facing };
    case 'blocker':
    case 'door':
    case 'monsterSpawn':
    case 'floorPatch':
      return undefined;
  }
}

/** Turns the selected record so its facing handle shows `facing` — the inverse of `turnable`. */
export function applyFacing(selection: EditorSelection, facing: Heading, sector: Sector): void {
  switch (selection.kind) {
    case 'placement': {
      const placement = byId(sector.placements, selection.id);
      if (placement !== undefined) placement.yaw = heading(facing - 90);
      break;
    }
    case 'npc': {
      const npc = byId(sector.npcs, selection.id);
      if (npc !== undefined) npc.facing = facing;
      break;
    }
    case 'spawn':
      if (sector.spawn !== undefined) sector.spawn.facing = facing;
      break;
    case 'blocker':
    case 'door':
    case 'monsterSpawn':
    case 'floorPatch':
      break;
  }
}

/**
 * Appends a freshly placed record with the default field values, returning its selection
 * (the inspector then refines the fields in place). A sector has one spawn point, so placing it
 * again moves it.
 */
export function placeRecord(tool: EditorTool, bounds: Rect, sector: Sector, defaults: PlacementDefaults): EditorSelection | undefined {
  const at = { x: bounds.x, z: bounds.z };
  switch (tool) {
    case 'select':
      return undefined;
    case 'placement': {
      const id = nextFreeId(defaults.modelId, sector.placements);
      sector.placements.push({ id, modelId: defaults.modelId, ...at, yaw: 0, elevation: 0 });
      return { kind: 'placement', id };
    }
    case 'blocker': {
      const id = nextFreeId(ID_PREFIX.blocker, sector.blockers);
      sector.blockers.push({ id, ...bounds });
      return { kind: 'blocker', id };
    }
    case 'npc': {
      const id = nextFreeId(ID_PREFIX.npc, sector.npcs);
      sector.npcs.push({ id, name: '', characterModelId: defaults.characterModelId, ...at, facing: 0, dialogScript: '' });
      return { kind: 'npc', id };
    }
    case 'monsterSpawn': {
      const id = nextFreeId(ID_PREFIX.monsterSpawn, sector.monsterSpawns);
      sector.monsterSpawns.push({ id, kind: defaults.monsterKind, ...bounds, maxAlive: 1 });
      return { kind: 'monsterSpawn', id };
    }
    case 'floorPatch': {
      const id = nextFreeId(ID_PREFIX.floorPatch, sector.floorPatches);
      sector.floorPatches.push({ id, floorMaterialId: defaults.floorMaterialId, ...bounds });
      return { kind: 'floorPatch', id };
    }
    case 'spawn':
      sector.spawn = { ...at, facing: sector.spawn?.facing ?? 0 };
      return { kind: 'spawn', id: SPAWN_ID };
  }
}

/**
 * Every record whose projected footprint intersects the marquee rect. The quad itself is tested
 * (separating axes), not its bounding box — a rotated floor rect's bounding box covers far
 * more screen than the record and would marquee-select across empty ground.
 */
export function marqueeSelections(sector: Sector, rect: { x: number; y: number; width: number; height: number }, context: DragContext): EditorSelection[] {
  return candidateSelections(sector).filter((candidate) => {
    const footprint = selectionFootprint(candidate, sector, context.registry);
    return footprint !== undefined && rectIntersectsConvexQuad(rect, projectedCorners(footprintCorners(footprint), context));
  });
}
