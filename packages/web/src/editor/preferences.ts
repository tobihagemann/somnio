/**
 * The grid-snap preference and quantization. The preference lives in `localStorage` (the
 * guarded-accessor pattern from `client/sessionStore.ts` — access throws in sandboxed iframes
 * and when the user blocks site data).
 */

/** Grid steps in metres; 0 is free placement. */
export const GRID_SNAP_PRESETS = [1, 0.5, 0.25, 0.1, 0] as const;
export type GridSnap = (typeof GRID_SNAP_PRESETS)[number];

export const DEFAULT_GRID_SNAP: GridSnap = 0.5;
const STORAGE_KEY = 'somnio.editor.gridSnap';

/** The step a nudge, a minimum extent, and a duplicate offset use while the grid is free. */
export const FINE_STEP = 0.01;

/**
 * The last snap chosen this session, held in memory so a preference survives even when the
 * `localStorage` write is blocked (a sandboxed iframe, or the user blocking site data). Only the
 * production path (no explicit `storage` argument) touches it; passing a `storage` bypasses it so
 * tests stay fully isolated from one another.
 */
let sessionGridSnap: GridSnap | undefined;

/** Rounds a length to the millimetre, so authored records stay short decimals. Adding 0 folds a negative zero into zero. */
export function millimetres(value: number): number {
  return Math.round(value * 1000) / 1000 + 0;
}

/** Snaps `value` to the nearest multiple of `step`, to the millimetre. `step === 0` means free placement. */
export function quantize(value: number, step: number): number {
  return millimetres(step === 0 ? value : Math.round(value / step) * step);
}

/** The grid step, or the fine step while the grid is free. */
export function stepOrFine(gridStep: number): number {
  return gridStep > 0 ? gridStep : FINE_STEP;
}

/**
 * Reads the active grid-snap preset, falling back to the default when the key is absent or not a
 * known preset. The **absent-vs-zero** distinction is load-bearing: `free` is stored as `0`,
 * so a missing key must resolve to the default, never to free.
 */
export function currentGridSnap(storage?: Pick<Storage, 'getItem'>): GridSnap {
  if (storage === undefined && sessionGridSnap !== undefined) return sessionGridSnap;
  const raw = readItem(storage ?? safeStorage());
  if (raw === null) return DEFAULT_GRID_SNAP;
  const parsed = Number(raw);
  const preset = GRID_SNAP_PRESETS.find((candidate) => candidate === parsed);
  return preset ?? DEFAULT_GRID_SNAP;
}

export function persistGridSnap(snap: GridSnap, storage?: Pick<Storage, 'setItem'>): void {
  // Record the session value before the write, so a blocked store still keeps the selection for
  // this session rather than snapping back to the default on the next read.
  if (storage === undefined) sessionGridSnap = snap;
  try {
    (storage ?? safeStorage())?.setItem(STORAGE_KEY, String(snap));
  } catch {
    // A blocked store loses only persistence across sessions; the in-memory value above holds.
  }
}

function readItem(storage: Pick<Storage, 'getItem'> | undefined): string | null {
  try {
    return storage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
