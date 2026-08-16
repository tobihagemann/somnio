import { SOMNIO_CONSTANTS } from '@/core/constants'

/**
 * The grid-snap preference and quantization. The preference lives in `localStorage` (the
 * guarded-accessor pattern from `client/sessionStore.ts` — access throws in sandboxed iframes
 * and when the user blocks site data).
 */

export const GRID_SNAP_PRESETS_PX = [32, 16, 8, 4, 0] as const
export type GridSnapPx = (typeof GRID_SNAP_PRESETS_PX)[number]

export const DEFAULT_GRID_SNAP_PX: GridSnapPx = 32
const STORAGE_KEY = 'somnio.editor.gridSnap'

/**
 * The last snap chosen this session, held in memory so a preference survives even when the
 * `localStorage` write is blocked (a sandboxed iframe, or the user blocking site data). Only the
 * production path (no explicit `storage` argument) touches it; passing a `storage` bypasses it so
 * tests stay fully isolated from one another.
 */
let sessionGridSnapPx: GridSnapPx | undefined

/** The editor stamps this into every sector `create` writes; loads preserve the file's value. */
export const DEFAULT_SECTOR_VERSION = 1

/**
 * Snaps `value` to the nearest multiple of `step` toward zero. `step === 0` means free
 * placement (no quantization); negative inputs round toward zero like Swift integer division.
 */
export function quantize(value: number, step: number): number {
  return step === 0 ? value : Math.trunc(value / step) * step
}

/** Mirrors the `MapCodec` sector-dimension gate (per-axis cap + total-area cap). */
export function validSectorDimensions(width: number, height: number): boolean {
  return (
    width >= 1 &&
    height >= 1 &&
    width <= SOMNIO_CONSTANTS.maxSectorDimension &&
    height <= SOMNIO_CONSTANTS.maxSectorDimension &&
    width * height <= SOMNIO_CONSTANTS.maxSectorArea
  )
}

/**
 * Reads the active grid-snap preset, falling back to 32 when the key is absent or not a
 * known preset. The **absent-vs-zero** distinction is load-bearing: `free` is stored as `0`,
 * so a missing key must resolve to the documented 32 default, never to free.
 */
export function currentGridSnapPx(storage?: Pick<Storage, 'getItem'>): GridSnapPx {
  if (storage === undefined && sessionGridSnapPx !== undefined) return sessionGridSnapPx
  const raw = readItem(storage ?? safeStorage())
  if (raw === null) return DEFAULT_GRID_SNAP_PX
  const parsed = Number(raw)
  const preset = GRID_SNAP_PRESETS_PX.find((candidate) => candidate === parsed)
  return preset ?? DEFAULT_GRID_SNAP_PX
}

export function persistGridSnapPx(snap: GridSnapPx, storage?: Pick<Storage, 'setItem'>): void {
  // Record the session value before the write, so a blocked store still keeps the selection for
  // this session rather than snapping back to the default on the next read.
  if (storage === undefined) sessionGridSnapPx = snap
  try {
    ;(storage ?? safeStorage())?.setItem(STORAGE_KEY, String(snap))
  } catch {
    // A blocked store loses only persistence across sessions; the in-memory value above holds.
  }
}

function readItem(storage: Pick<Storage, 'getItem'> | undefined): string | null {
  try {
    return storage?.getItem(STORAGE_KEY) ?? null
  } catch {
    return null
  }
}

function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}
