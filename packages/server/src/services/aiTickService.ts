import type { WorldRouter } from '../world/worldRouter.ts';
import { DEFAULT_AI_TICK_INTERVAL_SECONDS } from '../world/perSectorActor.ts';
import { runPeriodically } from './periodicLoop.ts';

/** Drives `runAITickAcrossSectors` on the 50 ms cadence until aborted. */
export class AITickService {
  private readonly worldRouter: WorldRouter;
  private readonly intervalMs: number;

  constructor(worldRouter: WorldRouter, intervalMs: number = DEFAULT_AI_TICK_INTERVAL_SECONDS * 1000) {
    this.worldRouter = worldRouter;
    this.intervalMs = intervalMs;
  }

  run(signal: AbortSignal): Promise<void> {
    return runPeriodically(this.intervalMs, signal, () => this.worldRouter.runAITickAcrossSectors());
  }
}
