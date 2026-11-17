import { describe, expect, it } from 'vitest';
import { SPEECH_PACE, SpeechPace } from '@somnio/core';
import { AttemptLimiter } from '../src/connection/attemptLimiter.ts';
import { FRAME_BUDGETS, FRAME_KINDS } from '../src/connection/frameLimits.ts';
import { testLogger } from './support/logger.ts';

describe('the share budget', () => {
  it('lets four shares through at once, then one every 5 s, and spends nothing of the speech budget', () => {
    const clock = { ms: 0 };
    const limiter = new AttemptLimiter({ enabled: true, logger: testLogger(), budgets: FRAME_BUDGETS, now: () => clock.ms });
    const share = (): boolean => limiter.admit(FRAME_KINDS.shareQuest!, 'alice');
    expect([share(), share(), share(), share(), share()]).toEqual([true, true, true, true, false]);
    clock.ms = 4999;
    expect(share()).toBe(false);
    clock.ms = 5000;
    expect([share(), share()]).toEqual([true, false]);
    expect(Array.from({ length: SPEECH_PACE.burst }, () => limiter.admit('speech', 'alice'))).not.toContain(false);
  });
});

describe('the speech budget', () => {
  /** A player who sends as fast as the client lets them: a burst, a line a second, a pause, and a burst again. */
  function sentAsTheClientPaces(): number[] {
    const tries = [
      ...Array<number>(SPEECH_PACE.burst).fill(0),
      ...Array.from({ length: 20 }, (_, second) => (second + 1) * 1000),
      ...Array<number>(SPEECH_PACE.burst).fill(40_000),
    ];
    const pace = new SpeechPace(0);
    return tries.filter((at) => pace.spend(at));
  }

  /** How many of the lines sent are refused when the network holds every line sent up to `heldUntil` and delivers them together then. */
  function refusedWhenHeldUntil(heldUntil: number): number {
    const clock = { ms: 0 };
    const limiter = new AttemptLimiter({ enabled: true, logger: testLogger(), budgets: FRAME_BUDGETS, now: () => clock.ms });
    const arrivals = sentAsTheClientPaces().map((at) => Math.max(at, heldUntil));
    return arrivals.filter((at) => {
      clock.ms = at;
      return !limiter.admit('speech', 'alice');
    }).length;
  }

  it('lets through every line the client let the player send, bunched by up to 8 s, and not past that', () => {
    expect(sentAsTheClientPaces()).toHaveLength(36);
    expect(refusedWhenHeldUntil(0)).toBe(0);
    expect(refusedWhenHeldUntil(8000)).toBe(0);
    expect(refusedWhenHeldUntil(12_000)).toBe(4);
  });
});
