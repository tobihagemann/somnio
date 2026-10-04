import { describe, expect, it } from 'vitest';
import { BOOT_DEFAULT_WORLD_SECONDS, WORLD_TIME_RATE, calendarFromWorldSeconds, hourOfDay } from '../src/worldClock.ts';

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 28 * DAY;
const YEAR = 12 * MONTH;

describe('world clock', () => {
  it('runs at four world seconds a second', () => {
    expect(WORLD_TIME_RATE).toBe(4);
  });

  it('boots at noon on the first day of year 500', () => {
    expect(BOOT_DEFAULT_WORLD_SECONDS).toBe(14_515_243_200);
    expect(calendarFromWorldSeconds(BOOT_DEFAULT_WORLD_SECONDS)).toEqual({ year: 500, month: 1, day: 1, hour: 12, minute: 0, second: 0 });
  });

  it.each([
    [0, { year: 0, month: 1, day: 1, hour: 0, minute: 0, second: 0 }],
    [59.9, { year: 0, month: 1, day: 1, hour: 0, minute: 0, second: 59 }],
    [HOUR - 1, { year: 0, month: 1, day: 1, hour: 0, minute: 59, second: 59 }],
    [DAY - 1, { year: 0, month: 1, day: 1, hour: 23, minute: 59, second: 59 }],
    [DAY, { year: 0, month: 1, day: 2, hour: 0, minute: 0, second: 0 }],
    [MONTH - 1, { year: 0, month: 1, day: 28, hour: 23, minute: 59, second: 59 }],
    [MONTH, { year: 0, month: 2, day: 1, hour: 0, minute: 0, second: 0 }],
    [YEAR - 1, { year: 0, month: 12, day: 28, hour: 23, minute: 59, second: 59 }],
    [YEAR, { year: 1, month: 1, day: 1, hour: 0, minute: 0, second: 0 }],
  ])('reads world second %s as its calendar date', (worldSeconds, expected) => {
    expect(calendarFromWorldSeconds(worldSeconds)).toEqual(expected);
  });

  it('gives the hour of the day as a fraction, wrapping at midnight', () => {
    expect(hourOfDay(BOOT_DEFAULT_WORLD_SECONDS)).toBe(12);
    expect(hourOfDay(BOOT_DEFAULT_WORLD_SECONDS + 90 * MINUTE)).toBe(13.5);
    expect(hourOfDay(BOOT_DEFAULT_WORLD_SECONDS + 12 * HOUR)).toBe(0);
    expect(hourOfDay(BOOT_DEFAULT_WORLD_SECONDS + 12 * HOUR - 1)).toBeCloseTo(24 - 1 / 3600, 9);
  });
});
