import { describe, expect, it } from 'vitest';
import { BOOT_DEFAULT_WORLD_CLOCK, tickWorldClock } from '../src/worldClock.ts';
import type { WorldClock } from '../src/worldClock.ts';

function clock(second: number, minute: number, hour: number, day: number, month: number, year: number): WorldClock {
  return { second, minute, hour, day, month, year };
}

describe('world clock', () => {
  it('boot default', () => {
    expect(BOOT_DEFAULT_WORLD_CLOCK).toEqual(clock(0, 0, 12, 1, 1, 500));
  });

  it('increments the second', () => {
    const c = clock(5, 0, 12, 1, 1, 500);
    expect(tickWorldClock(c)).toEqual({ hour: 12, minute: 0 });
    expect(c.second).toBe(6);
  });

  it('rolls the minute over', () => {
    const c = clock(59, 5, 12, 1, 1, 500);
    expect(tickWorldClock(c)).toEqual({ hour: 12, minute: 6 });
    expect(c).toEqual(clock(0, 6, 12, 1, 1, 500));
  });

  it('emits hour 24 at midnight and rolls to the next day', () => {
    const c = clock(59, 59, 23, 1, 1, 500);
    expect(tickWorldClock(c)).toEqual({ hour: 24, minute: 0 });
    expect(c).toEqual(clock(0, 0, 0, 2, 1, 500));
  });

  it('rolls the day over into the next month', () => {
    const c = clock(59, 59, 23, 28, 1, 500);
    expect(tickWorldClock(c)).toEqual({ hour: 24, minute: 0 });
    expect(c).toEqual(clock(0, 0, 0, 1, 2, 500));
  });

  it('rolls the month over into the next year', () => {
    const c = clock(59, 59, 23, 28, 12, 500);
    expect(tickWorldClock(c)).toEqual({ hour: 24, minute: 0 });
    expect(c).toEqual(clock(0, 0, 0, 1, 1, 501));
  });

  it('does not emit 24 on a non-hour rollover', () => {
    const c = clock(59, 11, 12, 1, 1, 500);
    expect(tickWorldClock(c)).toEqual({ hour: 12, minute: 12 });
  });

  it('increments a non-midnight hour without resetting the day', () => {
    const c = clock(59, 59, 12, 5, 7, 500);
    expect(tickWorldClock(c)).toEqual({ hour: 13, minute: 0 });
    expect(c).toEqual(clock(0, 0, 13, 5, 7, 500));
  });
});
