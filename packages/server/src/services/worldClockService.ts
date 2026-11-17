import { WORLD_TIME_RATE } from '@somnio/core';
import type { WorldClockRepository } from '@somnio/data';
import type { Logger } from '../logging.ts';
import { runPeriodically } from './periodicLoop.ts';

export const DEFAULT_WORLD_CLOCK_INTERVAL_MS = 250;
const SECONDS_PER_MINUTE = 60;

/**
 * The in-game clock, running at `WORLD_TIME_RATE` times wall clock: each tick advances
 * `worldSeconds` by the wall time since the previous one and persists once per in-game minute.
 * The pre-loaded `initialWorldSeconds` is required so a forgotten pre-load cannot hand clients the
 * boot default.
 */
export class WorldClockService {
  private readonly worldClocks: WorldClockRepository;
  private readonly intervalMs: number;
  private readonly logger: Logger;
  private readonly now: () => number;
  private worldSeconds: number;
  private advancedAt: number;

  constructor(
    worldClocks: WorldClockRepository,
    initialWorldSeconds: number,
    logger: Logger,
    intervalMs: number = DEFAULT_WORLD_CLOCK_INTERVAL_MS,
    now: () => number = () => performance.now(),
  ) {
    this.worldClocks = worldClocks;
    this.worldSeconds = initialWorldSeconds;
    this.logger = logger;
    this.intervalMs = intervalMs;
    this.now = now;
    this.advancedAt = now();
  }

  /** Ticks until aborted, then saves whatever the post-tick state is so the last in-game second is not lost. */
  async run(signal: AbortSignal): Promise<void> {
    await runPeriodically(this.intervalMs, signal, () => this.tickOnce());
    try {
      await this.worldClocks.save(this.worldSeconds);
    } catch (error) {
      this.logger.warn({ error: String(error) }, 'world clock final save failed');
    }
  }

  /** The test seam: one tick, with the persist gate. */
  async tickOnce(): Promise<void> {
    const now = this.now();
    const previous = this.worldSeconds;
    this.worldSeconds += ((now - this.advancedAt) / 1000) * WORLD_TIME_RATE;
    this.advancedAt = now;
    if (Math.floor(this.worldSeconds / SECONDS_PER_MINUTE) === Math.floor(previous / SECONDS_PER_MINUTE)) return;
    try {
      await this.worldClocks.save(this.worldSeconds);
    } catch (error) {
      this.logger.warn({ error: String(error) }, 'world clock save failed');
    }
  }

  /** The clock as of the last tick. */
  currentWorldSeconds(): number {
    return this.worldSeconds;
  }
}
