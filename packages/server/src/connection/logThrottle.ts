const DEFAULT_LOG_INTERVAL_MS = 60_000;

/** Lets a repeated warning through at most once an interval and counts the ones it held back. */
export class LogThrottle {
  private readonly intervalMs: number;
  private loggedAt: number | undefined;
  private suppressed = 0;

  constructor(intervalMs = DEFAULT_LOG_INTERVAL_MS) {
    this.intervalMs = intervalMs;
  }

  loggedRecently(now: number): boolean {
    return this.loggedAt !== undefined && now - this.loggedAt < this.intervalMs;
  }

  /** How many were held back since the last record when one is due now; otherwise counts this one and returns `undefined`. */
  take(now: number): number | undefined {
    if (this.loggedRecently(now)) {
      this.suppressed += 1;
      return undefined;
    }
    const suppressed = this.suppressed;
    this.loggedAt = now;
    this.suppressed = 0;
    return suppressed;
  }
}
