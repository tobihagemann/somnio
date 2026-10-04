import type { Logger } from '../logging.ts';

/** The pre-login budgets of one client address: a burst of attempts, then one more per refill interval. */
export const ATTEMPT_LIMITS = {
  login: { burst: 10, refillMs: 60_000 },
  registration: { burst: 10, refillMs: 300_000 },
} as const;

type AttemptKind = keyof typeof ATTEMPT_LIMITS;

/** Minimum gap between throttle log lines per address; refusals in between are counted. */
const THROTTLE_LOG_INTERVAL_MS = 60_000;
const EVICTION_INTERVAL_MS = 5 * 60_000;

interface Budget {
  /** The refill time saved up as of `creditAt`. One attempt spends one refill interval of it. */
  credit: number;
  creditAt: number;
}

interface AddressEntry {
  budgets: Record<AttemptKind, Budget>;
  throttleLoggedAt: number | undefined;
  suppressedThrottles: number;
}

export interface AttemptLimiterOptions {
  enabled: boolean;
  logger: Logger;
  /** Monotonic milliseconds. */
  now?: () => number;
}

/**
 * Bounds how fast one client address can guess passwords or create accounts. In memory and per
 * process: a restart forgets every budget. Idle entries are evicted inside a later `admit`, so
 * there is no timer.
 */
export class AttemptLimiter {
  private readonly enabled: boolean;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly entries = new Map<string, AddressEntry>();
  private evictedAt: number;

  constructor(options: AttemptLimiterOptions) {
    this.enabled = options.enabled;
    this.logger = options.logger;
    this.now = options.now ?? (() => performance.now());
    this.evictedAt = this.now();
  }

  get size(): number {
    return this.entries.size;
  }

  /** Spends one attempt of the address's budget for `kind`, or refuses when none is left. */
  admit(kind: AttemptKind, address: string | undefined): boolean {
    if (!this.enabled || address === undefined) return true;
    const now = this.now();
    this.evictIdle(now);
    let entry = this.entries.get(address);
    if (entry === undefined) {
      entry = {
        budgets: { login: fullBudget('login', now), registration: fullBudget('registration', now) },
        throttleLoggedAt: undefined,
        suppressedThrottles: 0,
      };
      this.entries.set(address, entry);
    }
    const budget = entry.budgets[kind];
    refill(budget, kind, now);
    if (budget.credit < ATTEMPT_LIMITS[kind].refillMs) {
      this.logThrottle(entry, kind, address, now);
      return false;
    }
    budget.credit -= ATTEMPT_LIMITS[kind].refillMs;
    return true;
  }

  /**
   * Gives an admitted attempt back. An address with no entry is left without one. Either the
   * limiter is disabled and never made it, or the entry was evicted full, and a new one starts
   * full, so there is nothing to give back.
   */
  refund(kind: AttemptKind, address: string | undefined): void {
    const budget = address === undefined ? undefined : this.entries.get(address)?.budgets[kind];
    if (budget === undefined) return;
    budget.credit = Math.min(capacity(kind), budget.credit + ATTEMPT_LIMITS[kind].refillMs);
  }

  /**
   * Drops the entries whose removal cannot change a later decision. Both budgets must be full.
   * The last throttle record must also be older than the log interval, so a refusal after the
   * removal cannot log a second time inside that interval.
   */
  private evictIdle(now: number): void {
    if (now - this.evictedAt < EVICTION_INTERVAL_MS) return;
    this.evictedAt = now;
    for (const [address, entry] of this.entries) {
      if (loggedRecently(entry, now)) continue;
      refill(entry.budgets.login, 'login', now);
      refill(entry.budgets.registration, 'registration', now);
      if (entry.budgets.login.credit === capacity('login') && entry.budgets.registration.credit === capacity('registration')) {
        this.entries.delete(address);
      }
    }
  }

  private logThrottle(entry: AddressEntry, kind: AttemptKind, address: string, now: number): void {
    if (loggedRecently(entry, now)) {
      entry.suppressedThrottles += 1;
      return;
    }
    this.logger.warn({ address, budget: kind, suppressed_since_last: entry.suppressedThrottles }, 'pre-login attempt throttled');
    entry.throttleLoggedAt = now;
    entry.suppressedThrottles = 0;
  }
}

function loggedRecently(entry: AddressEntry, now: number): boolean {
  return entry.throttleLoggedAt !== undefined && now - entry.throttleLoggedAt < THROTTLE_LOG_INTERVAL_MS;
}

function capacity(kind: AttemptKind): number {
  return ATTEMPT_LIMITS[kind].burst * ATTEMPT_LIMITS[kind].refillMs;
}

function fullBudget(kind: AttemptKind, now: number): Budget {
  return { credit: capacity(kind), creditAt: now };
}

function refill(budget: Budget, kind: AttemptKind, now: number): void {
  budget.credit = Math.min(capacity(kind), budget.credit + (now - budget.creditAt));
  budget.creditAt = now;
}
