import type { Logger } from '../logging.ts';
import { LogThrottle } from './logThrottle.ts';

/** One kind's budget: a burst of attempts, then one more per refill interval. */
interface Limit {
  burst: number;
  refillMs: number;
}

/** The pre-login budgets of one key: a burst of attempts, then one more per refill interval. */
const ATTEMPT_LIMITS = {
  login: { burst: 10, refillMs: 60_000 },
  registration: { burst: 10, refillMs: 300_000 },
  account: { burst: 10, refillMs: 60_000 },
  admin: { burst: 10, refillMs: 60_000 },
} as const;

export type AttemptKind = keyof typeof ATTEMPT_LIMITS;

/** What a limiter budgets, by kind, and how its throttle record reads. */
export interface Budgets<K extends string> {
  limits: Record<K, Limit>;
  /** The field a throttle record names the key in. */
  keyField: string;
  /** What a throttle record says. */
  throttleMessage: string;
}

/** The pre-login budgets, keyed by client address or by account email. */
export const PRELOGIN_BUDGETS: Budgets<AttemptKind> = { limits: ATTEMPT_LIMITS, keyField: 'address', throttleMessage: 'pre-login attempt throttled' };

const EVICTION_INTERVAL_MS = 5 * 60_000;

interface Budget {
  /** The refill time saved up as of `creditAt`. One attempt spends one refill interval of it. */
  credit: number;
  creditAt: number;
}

interface KeyEntry<K extends string> {
  budgets: Record<K, Budget>;
  /** One per key, shared by its kinds. */
  log: LogThrottle;
}

export interface AttemptLimiterOptions<K extends string> {
  enabled: boolean;
  logger: Logger;
  budgets: Budgets<K>;
  /** Whether a throttle record names the key. Off for a key the client typed, such as an email. */
  logKey?: boolean;
  /** How many keys the table holds at most. Past it a new key is refused until idle entries are evicted. */
  maxKeys?: number;
  /** Monotonic milliseconds. */
  now?: () => number;
}

/**
 * Bounds how fast attempts are made per key: a client address guessing passwords, `/admin`
 * bearers, or creating accounts, the guesses at one account, or an account's gameplay frames. In
 * memory and per process: a restart forgets every budget. Idle entries are evicted inside a later
 * `admit`, so there is no timer.
 */
export class AttemptLimiter<K extends string> {
  private readonly enabled: boolean;
  private readonly logger: Logger;
  private readonly limits: Record<K, Limit>;
  private readonly kinds: K[];
  private readonly logKey: boolean;
  private readonly keyField: string;
  private readonly throttleMessage: string;
  private readonly maxKeys: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, KeyEntry<K>>();
  private evictedAt: number;
  /** A refused key has no entry to hold its throttle, so the table keeps one of its own. */
  private readonly fullLog = new LogThrottle();

  constructor(options: AttemptLimiterOptions<K>) {
    this.enabled = options.enabled;
    this.logger = options.logger;
    this.limits = options.budgets.limits;
    this.kinds = Object.keys(this.limits) as K[];
    this.logKey = options.logKey ?? true;
    this.keyField = options.budgets.keyField;
    this.throttleMessage = options.budgets.throttleMessage;
    this.maxKeys = options.maxKeys ?? Number.POSITIVE_INFINITY;
    this.now = options.now ?? (() => performance.now());
    this.evictedAt = this.now();
  }

  get size(): number {
    return this.entries.size;
  }

  /** Spends one attempt of the key's budget for `kind`, or refuses when none is left or the table is full. */
  admit(kind: K, key: string | undefined): boolean {
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
      entry = { budgets: this.fullBudgets(now), log: new LogThrottle() };
      this.entries.set(key, entry);
    }
    const limit = this.limits[kind];
    const budget = entry.budgets[kind];
    refill(budget, limit, now);
    if (budget.credit < limit.refillMs) {
      this.logThrottle(entry, kind, key, now);
      return false;
    }
    budget.credit -= limit.refillMs;
    return true;
  }

  /**
   * Gives an admitted attempt back. A key with no entry is left without one. Either the limiter
   * is disabled and never made it, or the entry was evicted full, and a new one starts full, so
   * there is nothing to give back.
   */
  refund(kind: K, key: string | undefined): void {
    const budget = key === undefined ? undefined : this.entries.get(key)?.budgets[kind];
    if (budget === undefined) return;
    const limit = this.limits[kind];
    budget.credit = Math.min(capacity(limit), budget.credit + limit.refillMs);
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
      const full = this.kinds.every((kind) => {
        const limit = this.limits[kind];
        refill(entry.budgets[kind], limit, now);
        return entry.budgets[kind].credit === capacity(limit);
      });
      if (full) this.entries.delete(key);
    }
  }

  private fullBudgets(now: number): Record<K, Budget> {
    return Object.fromEntries(this.kinds.map((kind) => [kind, { credit: capacity(this.limits[kind]), creditAt: now }])) as Record<K, Budget>;
  }

  private logThrottle(entry: KeyEntry<K>, kind: K, key: string, now: number): void {
    const suppressed = entry.log.take(now);
    if (suppressed === undefined) return;
    const fields = { budget: kind, suppressed_since_last: suppressed };
    this.logger.warn(this.logKey ? { [this.keyField]: key, ...fields } : fields, this.throttleMessage);
  }

  private logFull(kind: K, now: number): void {
    const suppressed = this.fullLog.take(now);
    if (suppressed !== undefined) this.logger.warn({ budget: kind, suppressed_since_last: suppressed }, 'attempt table full');
  }
}

function capacity(limit: Limit): number {
  return limit.burst * limit.refillMs;
}

function refill(budget: Budget, limit: Limit, now: number): void {
  budget.credit = Math.min(capacity(limit), budget.credit + (now - budget.creditAt));
  budget.creditAt = now;
}
