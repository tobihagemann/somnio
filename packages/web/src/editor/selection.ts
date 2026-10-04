import { SOMNIO_CONSTANTS, modelToWorld, objectModel, rectContains, resolveDoor, worldToModel } from '@somnio/core';
import type { ModelRegistry, Point, Rect, Sector, Size, Transform } from '@somnio/core';
import { requireId } from '@somnio/protocol';
import { placeholderFootprint } from '@/scene/placement';

/**
 * Selection state over the seven record kinds. Selections are value-shaped `{kind, id}` pairs;
 * JavaScript `Set` compares by reference, so the set operations live in the list helpers below,
 * keyed by `selectionKey`.
 */

type SelectionKind = 'placement' | 'blocker' | 'door' | 'npc' | 'monsterSpawn' | 'floorPatch' | 'spawn';

export interface EditorSelection {
  kind: SelectionKind;
  id: string;
}

/** A sector has one spawn point, so its selection carries this fixed id. */
export const SPAWN_ID = 'spawn';

export function selectionKey(selection: EditorSelection): string {
  return `${selection.kind}:${selection.id}`;
}

export function selectionsEqual(a: readonly EditorSelection[], b: readonly EditorSelection[]): boolean {
  if (a.length !== b.length) return false;
  const keys = new Set(a.map(selectionKey));
  return b.every((selection) => keys.has(selectionKey(selection)));
}

export function containsSelection(list: readonly EditorSelection[], selection: EditorSelection): boolean {
  return list.some((candidate) => selectionKey(candidate) === selectionKey(selection));
}

/** Shift-click membership toggle. */
export function toggleSelection(list: readonly EditorSelection[], selection: EditorSelection): EditorSelection[] {
  return containsSelection(list, selection) ? list.filter((candidate) => selectionKey(candidate) !== selectionKey(selection)) : [...list, selection];
}

/** The record array a kind lives in. The spawn point is a single optional record, not a list. */
function recordList(kind: Exclude<SelectionKind, 'spawn'>, sector: Sector): { id: string }[] {
  switch (kind) {
    case 'placement':
      return sector.placements;
    case 'blocker':
      return sector.blockers;
    case 'door':
      return sector.doors;
    case 'npc':
      return sector.npcs;
    case 'monsterSpawn':
      return sector.monsterSpawns;
    case 'floorPatch':
      return sector.floorPatches;
  }
}

export function byId<R extends { id: string }>(records: readonly R[], id: string): R | undefined {
  return records.find((record) => record.id === id);
}

export function isValidSelection(selection: EditorSelection, sector: Sector): boolean {
  return selection.kind === 'spawn' ? sector.spawn !== undefined : byId(recordList(selection.kind, sector), selection.id) !== undefined;
}

/** The selected record's own position, or `undefined` for a door, which stands where its placement does. */
export function positionedRecord(selection: EditorSelection, sector: Sector): Point | undefined {
  switch (selection.kind) {
    case 'placement':
      return byId(sector.placements, selection.id);
    case 'npc':
      return byId(sector.npcs, selection.id);
    case 'spawn':
      return sector.spawn;
    case 'blocker':
    case 'monsterSpawn':
    case 'floorPatch':
      return rectRecord(selection, sector);
    case 'door':
      return undefined;
  }
}

/** The selected record when it is an authored rect, which is what the resize handles act on. */
export function rectRecord(selection: EditorSelection, sector: Sector): Rect | undefined {
  switch (selection.kind) {
    case 'blocker':
      return byId(sector.blockers, selection.id);
    case 'monsterSpawn':
      return byId(sector.monsterSpawns, selection.id);
    case 'floorPatch':
      return byId(sector.floorPatches, selection.id);
    case 'placement':
    case 'door':
    case 'npc':
    case 'spawn':
      return undefined;
  }
}

/** The ground a record covers: `rect` in the frame `transform` stands in, sector-relative. */
export interface Footprint {
  transform: Transform;
  rect: Rect;
}

const UNTURNED: Transform = { x: 0, z: 0, yaw: 0 };

/** A rect of the given size centred on the origin of its frame, as a model's footprint is. */
export function centeredRect(size: Size): Rect {
  return { x: -size.width / 2, z: -size.depth / 2, width: size.width, depth: size.depth };
}

/** The square reaching `reach` to every side of `center`. */
export function squareAround(center: Point, reach: number): Rect {
  return { x: center.x - reach, z: center.z - reach, width: reach * 2, depth: reach * 2 };
}

/** A rect's corners in edge order. */
export function rectCorners(rect: Rect): Point[] {
  const { x, z, width, depth } = rect;
  return [
    { x, z },
    { x: x + width, z },
    { x: x + width, z: z + depth },
    { x, z: z + depth },
  ];
}

/**
 * What the canvas hit-tester, the marquee, and the selection highlight treat as the record: a
 * placement's registry footprint turned by its yaw, a door's trigger, a body-sized square for an
 * NPC or the spawn point, and the rect itself for the rest. `undefined` once the record is gone,
 * and for a door its placement's model has no anchor for.
 */
export function selectionFootprint(selection: EditorSelection, sector: Sector, registry: ModelRegistry): Footprint | undefined {
  switch (selection.kind) {
    case 'placement': {
      const placement = byId(sector.placements, selection.id);
      if (placement === undefined) return undefined;
      return { transform: placement, rect: centeredRect(placeholderFootprint(objectModel(registry, placement.modelId))) };
    }
    case 'door': {
      const door = byId(sector.doors, selection.id);
      const placement = door === undefined ? undefined : byId(sector.placements, door.placement);
      const trigger = door === undefined ? undefined : resolveDoor(sector, door, registry)?.trigger;
      return placement === undefined || trigger === undefined ? undefined : { transform: placement, rect: trigger };
    }
    case 'npc': {
      const npc = byId(sector.npcs, selection.id);
      return npc === undefined ? undefined : { transform: UNTURNED, rect: squareAround(npc, SOMNIO_CONSTANTS.npcRadius) };
    }
    case 'spawn':
      return sector.spawn === undefined ? undefined : { transform: UNTURNED, rect: squareAround(sector.spawn, SOMNIO_CONSTANTS.playerRadius) };
    case 'blocker':
    case 'monsterSpawn':
    case 'floorPatch': {
      const rect = rectRecord(selection, sector);
      return rect === undefined ? undefined : { transform: UNTURNED, rect };
    }
  }
}

export function footprintContains(footprint: Footprint, point: Point): boolean {
  return rectContains(footprint.rect, worldToModel(footprint.transform, point));
}

/** The footprint's corners in edge order, sector-relative. */
export function footprintCorners(footprint: Footprint): Point[] {
  return rectCorners(footprint.rect).map((corner) => modelToWorld(footprint.transform, corner));
}

/** Removes every selected record. A placement takes its doors with it: a door cannot outlive the wall it is in. */
export function removeAllSelections(selections: readonly EditorSelection[], sector: Sector): void {
  for (const selection of selections) {
    if (selection.kind === 'spawn') {
      delete sector.spawn;
      continue;
    }
    const records = recordList(selection.kind, sector);
    const index = records.findIndex((record) => record.id === selection.id);
    if (index >= 0) records.splice(index, 1);
  }
  sector.doors = sector.doors.filter((door) => byId(sector.placements, door.placement) !== undefined);
}

/** One record's change of id, as the selection naming it before and after. */
export interface RecordRename {
  from: EditorSelection;
  to: EditorSelection;
}

/** The list with the renamed record named by its new id. */
export function followRename(list: readonly EditorSelection[], rename: RecordRename): EditorSelection[] {
  return list.map((entry) => (selectionKey(entry) === selectionKey(rename.from) ? rename.to : entry));
}

/** Gives the selected record a new id. A placement's doors follow it. */
export function renameRecord(selection: EditorSelection, id: string, sector: Sector): void {
  if (selection.kind === 'spawn') return;
  const record = byId(recordList(selection.kind, sector), selection.id);
  if (record === undefined) return;
  record.id = id;
  if (selection.kind !== 'placement') return;
  for (const door of sector.doors) {
    if (door.placement === selection.id) door.placement = id;
  }
}

/** Whether the sector codec accepts `value` as a record id. */
export function isValidId(value: string): boolean {
  try {
    requireId({ id: value }, 'id', 'record');
    return true;
  } catch {
    return false;
  }
}

/** What a generated id starts with. A placement's starts with its model id and a door's is `nextDoorId`. */
export const ID_PREFIX = { blocker: 'blocker', npc: 'npc', monsterSpawn: 'spawn', floorPatch: 'patch' } as const;

/** The first `<prefix>-<n>` no record in `taken` carries. */
export function nextFreeId(prefix: string, taken: readonly { id: string }[]): string {
  let n = 1;
  while (byId(taken, `${prefix}-${n}`) !== undefined) n += 1;
  return `${prefix}-${n}`;
}

/** A door is named for where it leads, `to-<target sector>`, and numbered while it leads nowhere or the name is taken. */
export function nextDoorId(targetSector: string, taken: readonly { id: string }[]): string {
  if (targetSector === '') return nextFreeId('door', taken);
  const named = `to-${targetSector.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return byId(taken, named) === undefined ? named : nextFreeId(named, taken);
}
