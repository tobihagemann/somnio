import type { SessionRepository } from '@somnio/data';
import type { Logger } from '../logging.ts';
import type { WorldRouter } from '../world/worldRouter.ts';
import { runPeriodically } from './periodicLoop.ts';

/**
 * The periodic checkpoint plus the expired-session sweep, which rides along because it is the
 * same shape of work and nothing on the connection path removes an expired session row.
 */
export class CheckpointService {
  private readonly worldRouter: WorldRouter;
  private readonly sessions: SessionRepository;
  private readonly intervalMs: number;
  private readonly logger: Logger;

  constructor(worldRouter: WorldRouter, sessions: SessionRepository, intervalMs: number, logger: Logger) {
    this.worldRouter = worldRouter;
    this.sessions = sessions;
    this.intervalMs = intervalMs;
    this.logger = logger;
  }

  run(signal: AbortSignal): Promise<void> {
    return runPeriodically(this.intervalMs, signal, async () => {
      await this.worldRouter.checkpointAll();
      // Logged and swallowed: an unreachable database must not take the timer down, and an
      // unswept row is harmless until the next pass because expiry is enforced on read.
      try {
        const deleted = await this.sessions.deleteExpired(new Date());
        if (deleted > 0) this.logger.info({ count: deleted }, 'expired sessions swept');
      } catch (error) {
        this.logger.warn({ error: String(error) }, 'expired session sweep failed');
      }
    });
  }
}
