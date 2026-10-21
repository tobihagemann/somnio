import type { MonsterSpawn, Point, Sector, SectorNPC } from '@somnio/core';
import type { Blocker, Door, GroundMark, Placement } from '@somnio/protocol';
import { translateMark } from './groundMarks';
import { millimetres } from './preferences';
import { ID_PREFIX, containsSelection, nextDoorId, nextFreeId } from './selection';
import type { EditorSelection } from './selection';

/**
 * An in-page record buffer over the record kinds that can exist more than once, rather than the
 * system clipboard: cross-page paste is not needed.
 */

export interface EditorClipboard {
  placements: Placement[];
  blockers: Blocker[];
  doors: Door[];
  npcs: SectorNPC[];
  monsterSpawns: MonsterSpawn[];
  marks: GroundMark[];
}

export function emptyClipboard(): EditorClipboard {
  return { placements: [], blockers: [], doors: [], npcs: [], monsterSpawns: [], marks: [] };
}

export function isClipboardEmpty(clipboard: EditorClipboard): boolean {
  return Object.values(clipboard).every((records: unknown[]) => records.length === 0);
}

/**
 * Snapshots every selected record's value in source-array order — insertion appends each array
 * verbatim and picking treats later records as topmost, so a selection-ordered capture would
 * shuffle overlapping records' stacking on paste. A door is carried only together with its
 * placement: on its own it has no wall to be pasted into.
 */
export function captureClipboard(selections: readonly EditorSelection[], sector: Sector): EditorClipboard {
  const selected = <R extends { id: string }>(kind: EditorSelection['kind'], records: readonly R[]): R[] =>
    structuredClone(records.filter((record) => containsSelection(selections, { kind, id: record.id })));
  const placements = selected('placement', sector.placements);
  return {
    placements,
    blockers: selected('blocker', sector.blockers),
    doors: selected('door', sector.doors).filter((door) => placements.some((placement) => placement.id === door.placement)),
    npcs: selected('npc', sector.npcs),
    monsterSpawns: selected('monsterSpawn', sector.monsterSpawns),
    marks: selected('mark', sector.ground.marks),
  };
}

/**
 * Appends clones of every carried record under fresh ids, shifted as a group: with an `anchor`
 * the payload's north-west bounding corner lands there (paste-at-cursor); without one every
 * position shifts by `fallbackOffset` on both axes (duplicate). A carried door is attached to the
 * clone of its placement, and a mark moves whole, stopping where the codec bounds its points.
 * Returns the clones' selections.
 */
export function insertClipboard(clipboard: EditorClipboard, sector: Sector, anchor: Point | undefined, fallbackOffset: number): EditorSelection[] {
  const minOrigin = boundingOrigin(clipboard);
  const shift =
    anchor !== undefined && minOrigin !== undefined ? { dx: anchor.x - minOrigin.x, dz: anchor.z - minOrigin.z } : { dx: fallbackOffset, dz: fallbackOffset };
  const inserted: EditorSelection[] = [];
  const insert = <R extends Point & { id: string }>(
    kind: EditorSelection['kind'],
    records: readonly R[],
    into: R[],
    prefix: (record: R) => string,
  ): Map<string, string> => {
    const ids = new Map<string, string>();
    for (const record of records) {
      const id = nextFreeId(prefix(record), into);
      into.push({ ...structuredClone(record), id, x: millimetres(record.x + shift.dx), z: millimetres(record.z + shift.dz) });
      inserted.push({ kind, id });
      ids.set(record.id, id);
    }
    return ids;
  };
  const placementIds = insert('placement', clipboard.placements, sector.placements, (placement) => placement.modelId);
  insert('blocker', clipboard.blockers, sector.blockers, () => ID_PREFIX.blocker);
  insert('npc', clipboard.npcs, sector.npcs, () => ID_PREFIX.npc);
  insert('monsterSpawn', clipboard.monsterSpawns, sector.monsterSpawns, () => ID_PREFIX.monsterSpawn);
  for (const mark of clipboard.marks) {
    const id = nextFreeId(ID_PREFIX.mark, sector.ground.marks);
    const clone = { ...structuredClone(mark), id };
    translateMark(clone, shift.dx, shift.dz, sector.size);
    sector.ground.marks.push(clone);
    inserted.push({ kind: 'mark', id });
  }
  for (const door of clipboard.doors) {
    const id = nextDoorId(door.target.sector, sector.doors);
    sector.doors.push({ ...structuredClone(door), id, placement: placementIds.get(door.placement)! });
    inserted.push({ kind: 'door', id });
  }
  return inserted;
}

/** North-west corner of the payload's bounding box, or `undefined` for an empty payload. */
function boundingOrigin(clipboard: EditorClipboard): Point | undefined {
  const positions: Point[] = [
    ...clipboard.placements,
    ...clipboard.blockers,
    ...clipboard.npcs,
    ...clipboard.monsterSpawns,
    ...clipboard.marks.flatMap((mark) => mark.shape.points),
  ];
  if (positions.length === 0) return undefined;
  return { x: Math.min(...positions.map((position) => position.x)), z: Math.min(...positions.map((position) => position.z)) };
}
