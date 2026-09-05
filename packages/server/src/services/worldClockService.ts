import { SOMNIO_CONSTANTS, tickWorldClock } from '@somnio/core'
import type { WorldClock } from '@somnio/core'
import type { DateTickMessage } from '@somnio/protocol'
import type { WorldClockRepository } from '@somnio/data'
import type { Logger } from '../logging.ts'
import type { WorldRouter } from '../world/worldRouter.ts'
import { runPeriodically } from './periodicLoop.ts'

export const DEFAULT_WORLD_CLOCK_INTERVAL_MS = 250

/**
 * The in-game clock at 4x wall clock: each tick advances the clock, broadcasts a `dateTick` on the
 * minute marks and the hour rollover, and persists once per in-game minute. The pre-loaded
 * `initialClock` is required so a forgotten pre-load cannot hand clients the boot default.
 */
export class WorldClockService {
  private readonly worldRouter: WorldRouter
  private readonly worldClocks: WorldClockRepository
  private readonly intervalMs: number
  private readonly logger: Logger
  private readonly clock: WorldClock

  constructor(
    worldRouter: WorldRouter,
    worldClocks: WorldClockRepository,
    initialClock: WorldClock,
    logger: Logger,
    intervalMs: number = DEFAULT_WORLD_CLOCK_INTERVAL_MS
  ) {
    this.worldRouter = worldRouter
    this.worldClocks = worldClocks
    this.clock = { ...initialClock }
    this.logger = logger
    this.intervalMs = intervalMs
  }

  /** Ticks until aborted, then saves whatever the post-tick state is so the last in-game second is not lost. */
  async run(signal: AbortSignal): Promise<void> {
    await runPeriodically(this.intervalMs, signal, () => this.tickOnce())
    try {
      await this.worldClocks.save(this.clock)
    } catch (error) {
      this.logger.warn({ error: String(error) }, 'world clock final save failed')
    }
  }

  /** The test seam: one tick, with the broadcast and persist gates. */
  async tickOnce(): Promise<void> {
    const wire = tickWorldClock(this.clock)
    // A post-tick second of 0 means a new minute: broadcast on the mid-hour marks and the hour
    // rollover, persist regardless. The midnight `hour: 24` quirk rides in `wire`.
    if (this.clock.second !== 0) return
    const minutes: readonly number[] = SOMNIO_CONSTANTS.dateTickMinutes
    if (minutes.includes(this.clock.minute) || this.clock.minute === 0) {
      this.worldRouter.broadcastToAllConnections({
        tag: 'dateTick',
        payload: { hour: wire.hour, minute: wire.minute },
      })
    }
    try {
      await this.worldClocks.save(this.clock)
    } catch (error) {
      this.logger.warn({ error: String(error) }, 'world clock save failed')
    }
  }

  /** Full clock state for the admin `time` verb. */
  currentTime(): WorldClock {
    return { ...this.clock }
  }

  /** The post-tick `(hour, minute)` for the per-login and per-portal hooks; never the midnight 24. */
  currentDateTickMessage(): DateTickMessage {
    return { hour: this.clock.hour, minute: this.clock.minute }
  }
}
