import type { WorldRouter } from '../world/worldRouter.ts';
import { runPeriodically } from './periodicLoop.ts';

export const DEFAULT_SIMULATION_INTERVAL_MS = 50;
/** The longest stretch one pass simulates, so a stalled process does not fling monsters across a sector. */
const MAX_STEP_MS = 250;
const MOVES_FLUSH_INTERVAL_MS = 100;

/**
 * Steps every space until aborted. Each pass simulates the time since the previous one, up to
 * `MAX_STEP_MS`, and the batched `moves` go out once `MOVES_FLUSH_INTERVAL_MS` has passed since
 * the last flush.
 */
export class SimulationService {
  private readonly worldRouter: WorldRouter;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private lastPassAt: number;
  private lastFlushAt: number;

  constructor(worldRouter: WorldRouter, intervalMs: number = DEFAULT_SIMULATION_INTERVAL_MS, now: () => number = () => performance.now()) {
    this.worldRouter = worldRouter;
    this.intervalMs = intervalMs;
    this.now = now;
    this.lastPassAt = now();
    this.lastFlushAt = this.lastPassAt;
  }

  run(signal: AbortSignal): Promise<void> {
    return runPeriodically(this.intervalMs, signal, () => {
      this.runPass();
      return Promise.resolve();
    });
  }

  /** The test seam: one pass. */
  runPass(): void {
    const now = this.now();
    this.worldRouter.runTickAcrossSpaces(Math.min(now - this.lastPassAt, MAX_STEP_MS) / 1000);
    this.lastPassAt = now;
    if (now - this.lastFlushAt >= MOVES_FLUSH_INTERVAL_MS) {
      this.worldRouter.flushMoves();
      this.lastFlushAt = now;
    }
  }
}
