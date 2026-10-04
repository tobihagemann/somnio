/**
 * The server-owned in-game world clock. World time is one number, `worldSeconds`, counted from
 * the start of year 0 and advanced at `WORLD_TIME_RATE` times wall clock by the caller. The
 * calendar is derived from it: 24 hours a day, 28 days a month, 12 months a year.
 */

/** World seconds per wall-clock second. */
export const WORLD_TIME_RATE = 4;

const SECONDS_PER_DAY = 24 * 60 * 60;
const DAYS_PER_MONTH = 28;
const DAYS_PER_YEAR = DAYS_PER_MONTH * 12;

/** `day` and `month` count from 1. */
export interface WorldCalendar {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Year 500, day 1 of month 1, 12:00. */
export const BOOT_DEFAULT_WORLD_SECONDS = 500 * DAYS_PER_YEAR * SECONDS_PER_DAY + 12 * 60 * 60;

export function calendarFromWorldSeconds(worldSeconds: number): WorldCalendar {
  const whole = Math.floor(worldSeconds);
  const days = Math.floor(whole / SECONDS_PER_DAY);
  const secondOfDay = whole - days * SECONDS_PER_DAY;
  const dayOfYear = days % DAYS_PER_YEAR;
  return {
    year: Math.floor(days / DAYS_PER_YEAR),
    month: Math.floor(dayOfYear / DAYS_PER_MONTH) + 1,
    day: (dayOfYear % DAYS_PER_MONTH) + 1,
    hour: Math.floor(secondOfDay / 3600),
    minute: Math.floor(secondOfDay / 60) % 60,
    second: secondOfDay % 60,
  };
}

/** The fractional hour of the day in `[0, 24)`, which the sun follows. */
export function hourOfDay(worldSeconds: number): number {
  const secondOfDay = worldSeconds - Math.floor(worldSeconds / SECONDS_PER_DAY) * SECONDS_PER_DAY;
  return secondOfDay / 3600;
}
