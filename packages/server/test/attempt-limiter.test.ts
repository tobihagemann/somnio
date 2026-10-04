import { describe, expect, it } from 'vitest';
import { AttemptLimiter } from '../src/connection/attemptLimiter.ts';
import { recordingLogger } from './support/logger.ts';

const ADDRESS = '203.0.113.7';
const OTHER = '203.0.113.8';
const SECOND = 1000;
const MINUTE = 60 * SECOND;

function makeLimiter(enabled = true) {
  const clock = { ms: 0 };
  const { logger, records } = recordingLogger();
  const limiter = new AttemptLimiter({ enabled, logger, now: () => clock.ms });
  return { limiter, clock, records };
}

function admits(limiter: AttemptLimiter, kind: 'login' | 'registration', address: string, count: number): boolean[] {
  return Array.from({ length: count }, () => limiter.admit(kind, address));
}

const TEN_ADMITTED = Array<boolean>(10).fill(true);

describe('AttemptLimiter budgets', () => {
  it('admits ten logins, refuses the eleventh, and admits exactly one more a minute later', () => {
    const { limiter, clock } = makeLimiter();
    expect(admits(limiter, 'login', ADDRESS, 11)).toEqual([...TEN_ADMITTED, false]);
    clock.ms = MINUTE;
    expect(admits(limiter, 'login', ADDRESS, 2)).toEqual([true, false]);
  });

  it('admits ten registrations, refuses the eleventh, and admits the next only once five minutes have passed', () => {
    const { limiter, clock } = makeLimiter();
    expect(admits(limiter, 'registration', ADDRESS, 11)).toEqual([...TEN_ADMITTED, false]);
    clock.ms = 299 * SECOND;
    expect(limiter.admit('registration', ADDRESS)).toBe(false);
    clock.ms = 300 * SECOND;
    expect(admits(limiter, 'registration', ADDRESS, 2)).toEqual([true, false]);
  });

  it('a refund restores one attempt', () => {
    const { limiter } = makeLimiter();
    admits(limiter, 'login', ADDRESS, 10);
    limiter.refund('login', ADDRESS);
    expect(admits(limiter, 'login', ADDRESS, 2)).toEqual([true, false]);
  });

  it('refunds never lift a budget past its burst', () => {
    const { limiter } = makeLimiter();
    limiter.admit('login', ADDRESS);
    limiter.refund('login', ADDRESS);
    limiter.refund('login', ADDRESS);
    expect(admits(limiter, 'login', ADDRESS, 11)).toEqual([...TEN_ADMITTED, false]);
  });

  it.each([
    ['login', 'registration'],
    ['registration', 'login'],
  ] as const)('an exhausted %s budget leaves the %s budget whole', (exhausted, other) => {
    const { limiter } = makeLimiter();
    admits(limiter, exhausted, ADDRESS, 11);
    expect(admits(limiter, other, ADDRESS, 11)).toEqual([...TEN_ADMITTED, false]);
  });

  it('one address exhausting its budget leaves another address whole', () => {
    const { limiter } = makeLimiter();
    admits(limiter, 'login', ADDRESS, 11);
    expect(admits(limiter, 'login', OTHER, 11)).toEqual([...TEN_ADMITTED, false]);
  });

  it('a disabled limiter admits past the burst and logs nothing', () => {
    const { limiter, records } = makeLimiter(false);
    expect(admits(limiter, 'login', ADDRESS, 12)).not.toContain(false);
    expect(limiter.size).toBe(0);
    expect(records).toEqual([]);
  });

  /** A socket destroyed before its upgrade completed has no address to count against. */
  it('an attempt with no address is admitted and holds no entry', () => {
    const { limiter } = makeLimiter();
    expect(Array.from({ length: 12 }, () => limiter.admit('login', undefined))).not.toContain(false);
    expect(limiter.size).toBe(0);
  });
});

describe('AttemptLimiter eviction', () => {
  it('drops an entry that has refilled and keeps one with an attempt still spent', () => {
    const { limiter, clock } = makeLimiter();
    limiter.admit('login', ADDRESS);
    clock.ms = 5 * MINUTE - 30 * SECOND;
    limiter.admit('login', OTHER);
    expect(limiter.size).toBe(2);

    clock.ms = 5 * MINUTE;
    limiter.admit('login', '203.0.113.9');

    // `ADDRESS` refilled four minutes ago; `OTHER` is thirty seconds into a one-minute refill.
    expect(limiter.size).toBe(2);
    expect(admits(limiter, 'login', OTHER, 10)).toEqual([...Array<boolean>(9).fill(true), false]);
  });

  /** Dropped while a registration is still spent, the address would come back with ten more. */
  it('keeps an entry until its registration budget has refilled too', () => {
    const { limiter, clock } = makeLimiter();
    clock.ms = MINUTE;
    limiter.admit('registration', ADDRESS);

    clock.ms = 5 * MINUTE;
    limiter.admit('login', OTHER);
    expect(limiter.size).toBe(2);

    clock.ms = 10 * MINUTE;
    limiter.admit('login', OTHER);
    expect(limiter.size).toBe(1);
  });

  it('a refund arriving after its entry was evicted and recreated leaves the address within its budget', () => {
    const { limiter, clock } = makeLimiter();
    limiter.admit('login', ADDRESS);
    clock.ms = 5 * MINUTE;
    limiter.admit('login', OTHER);
    expect(limiter.size).toBe(1);

    expect(admits(limiter, 'login', ADDRESS, 10)).toEqual(TEN_ADMITTED);
    limiter.refund('login', ADDRESS);
    expect(admits(limiter, 'login', ADDRESS, 2)).toEqual([true, false]);
  });

  it('a refund for an address with no entry creates none', () => {
    const { limiter } = makeLimiter();
    limiter.refund('login', ADDRESS);
    expect(limiter.size).toBe(0);
  });
});

describe('AttemptLimiter throttle records', () => {
  function throttleRecords(records: Record<string, unknown>[]) {
    return records.filter((record) => record['msg'] === 'pre-login attempt throttled');
  }

  it('logs one warn for a refusal and counts the repeats inside the interval', () => {
    const { limiter, clock, records } = makeLimiter();
    admits(limiter, 'login', ADDRESS, 13);
    expect(throttleRecords(records)).toMatchObject([{ level: 40, address: ADDRESS, budget: 'login', suppressed_since_last: 0 }]);

    // Each minute refills one attempt, so the second of each pair is the refusal that logs.
    clock.ms = MINUTE;
    admits(limiter, 'login', ADDRESS, 2);
    clock.ms = 2 * MINUTE;
    admits(limiter, 'login', ADDRESS, 2);
    expect(throttleRecords(records).map((record) => record['suppressed_since_last'])).toEqual([0, 2, 0]);
  });

  it('keeps an address quiet for the interval across both budgets', () => {
    const { limiter, records } = makeLimiter();
    admits(limiter, 'login', ADDRESS, 11);
    admits(limiter, 'registration', ADDRESS, 11);
    expect(throttleRecords(records)).toHaveLength(1);
  });

  /** A refunded entry is full, but removing it would forget its record and let the next refusal log again. */
  it('keeps a refilled entry through an eviction pass until its record is a minute old', () => {
    const { limiter, clock, records } = makeLimiter();
    clock.ms = 5 * MINUTE - 10 * SECOND;
    admits(limiter, 'login', ADDRESS, 11);
    for (let refund = 0; refund < 10; refund += 1) limiter.refund('login', ADDRESS);

    clock.ms = 5 * MINUTE;
    limiter.admit('login', OTHER);
    expect(limiter.size).toBe(2);
    admits(limiter, 'login', ADDRESS, 11);
    expect(throttleRecords(records)).toHaveLength(1);

    for (let refund = 0; refund < 10; refund += 1) limiter.refund('login', ADDRESS);
    clock.ms = 10 * MINUTE;
    limiter.admit('login', OTHER);
    expect(limiter.size).toBe(1);
  });
});
