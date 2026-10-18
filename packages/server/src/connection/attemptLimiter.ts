import type { Logger } from '../logging.ts';
import { LogThrottle } from './logThrottle.ts';

/** The pre-login budgets of one key: a burst of attempts, then one more per refill interval. */
export const ATTEMPT_LIMITS = {
  login: { burst: 10, refillMs: 60_000 },
  registration: { burst: 10, refillMs: 300_000 },
  account: { burst: 10, refillMs: 60_000 },
  admin: { burst: 10, refillMs: 60_000 },
} as const;

type AttemptKind = keyof typeof ATTEMPT_LIMITS;

const ATTEMPT_KINDS = Object.keys(ATTEMPT_LIMITS) as AttemptKind[];

const EVICTION_INTERVAL_MS = 5 * 60_000;

interface Budget {
  /** The refill time saved up as of `creditAt`. One attempt spends one refill interval of it. */
  credit: number;
  creditAt: number;
}

interface KeyEntry {
  budgets: Record<AttemptKind, Budget>;
  /** One per key, shared by its kinds. */
  log: LogThrottle;
}

export interface AttemptLimiterOptions {
  enabled: boolean;
  logger: Logger;
  /** Whether a throttle record names the key. Off for a key the client typed, such as a nickname. */
  logKey?: boolean;
  /** How many keys the table holds at most. Past it a new key is refused until idle entries are evicted. */
  maxKeys?: number;
  /** Monotonic milliseconds. */
  now?: () => number;
}

/**
 * Bounds how fast attempts are made per key: a client address guessing passwords, `/admin`
 * bearers, or creating accounts, or the guesses at one account. In memory and per process: a
 * restart forgets every budget. Idle entries are evicted inside a later `admit`, so there is no
 * timer.
 */
export class AttemptLimiter {
  private readonly enabled: boolean;
  private readonly logger: Logger;
  private readonly logKey: boolean;
  private readonly maxKeys: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, KeyEntry>();
  private evictedAt: number;
  /** A refused key has no entry to hold its throttle, so the table keeps one of its own. */
  private readonly fullLog = new LogThrottle();

  constructor(options: AttemptLimiterOptions) {
    this.enabled = options.enabled;
    this.logger = options.logger;
    this.logKey = options.logKey ?? true;
    this.maxKeys = options.maxKeys ?? Number.POSITIVE_INFINITY;
    this.now = options.now ?? (() => performance.now());
    this.evictedAt = this.now();
  }

  get size(): number {
    return this.entries.size;
  }

  /** Spends one attempt of the key's budget for `kind`, or refuses when none is left or the table is full. */
  admit(kind: AttemptKind, key: string | undefined): boolean {
    if (!this.enabled || key === undefined) return true;
    const now = this.now();
    this.evictIdle(now);
    let entry = this.entries.get(key);
    if (entry === undefined) {
      // Refused without a further eviction pass: a pass per refusal would let every cheap refused
      // attempt scan the whole table.
      if (this.entries.size >= this.maxKeys) {
        this.logFull(kind, now);
        return false;
      }
      entry = { budgets: fullBudgets(now), log: new LogThrottle() };
      this.entries.set(key, entry);
    }
    const budget = entry.budgets[kind];
    refill(budget, kind, now);
    if (budget.credit < ATTEMPT_LIMITS[kind].refillMs) {
      this.logThrottle(entry, kind, key, now);
      return false;
    }
    budget.credit -= ATTEMPT_LIMITS[kind].refillMs;
    return true;
  }

  /**
   * Gives an admitted attempt back. A key with no entry is left without one. Either the limiter
   * is disabled and never made it, or the entry was evicted full, and a new one starts full, so
   * there is nothing to give back.
   */
  refund(kind: AttemptKind, key: string | undefined): void {
    const budget = key === undefined ? undefined : this.entries.get(key)?.budgets[kind];
    if (budget === undefined) return;
    budget.credit = Math.min(capacity(kind), budget.credit + ATTEMPT_LIMITS[kind].refillMs);
  }

  /**
   * Drops the entries whose removal cannot change a later decision. Every budget must be full.
   * The last throttle record must also be older than the log interval, so a refusal after the
   * removal cannot log a second time inside that interval.
   */
  private evictIdle(now: number): void {
    if (now - this.evictedAt < EVICTION_INTERVAL_MS) return;
    this.evictedAt = now;
    for (const [key, entry] of this.entries) {
      if (entry.log.loggedRecently(now)) continue;
      const full = ATTEMPT_KINDS.every((kind) => {
        refill(entry.budgets[kind], kind, now);
        return entry.budgets[kind].credit === capacity(kind);
      });
      if (full) this.entries.delete(key);
    }
  }

  private logThrottle(entry: KeyEntry, kind: AttemptKind, key: string, now: number): void {
    const suppressed = entry.log.take(now);
    if (suppressed === undefined) return;
    const fields = { budget: kind, suppressed_since_last: suppressed };
    this.logger.warn(this.logKey ? { address: key, ...fields } : fields, 'pre-login attempt throttled');
  }

  private logFull(kind: AttemptKind, now: number): void {
    const suppressed = this.fullLog.take(now);
    if (suppressed !== undefined) this.logger.warn({ budget: kind, suppressed_since_last: suppressed }, 'attempt table full');
  }
}

function capacity(kind: AttemptKind): number {
  return ATTEMPT_LIMITS[kind].burst * ATTEMPT_LIMITS[kind].refillMs;
}

function fullBudgets(now: number): Record<AttemptKind, Budget> {
  return Object.fromEntries(ATTEMPT_KINDS.map((kind) => [kind, { credit: capacity(kind), creditAt: now }])) as Record<AttemptKind, Budget>;
}

function refill(budget: Budget, kind: AttemptKind, now: number): void {
  budget.credit = Math.min(capacity(kind), budget.credit + (now - budget.creditAt));
  budget.creditAt = now;
}
