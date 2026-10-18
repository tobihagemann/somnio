const LOG_INTERVAL_MS = 60_000;

/** Lets a repeated warning through at most once a minute and counts the ones it held back. */
export class LogThrottle {
  private loggedAt: number | undefined;
  private suppressed = 0;

  loggedRecently(now: number): boolean {
    return this.loggedAt !== undefined && now - this.loggedAt < LOG_INTERVAL_MS;
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
