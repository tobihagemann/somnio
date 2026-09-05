/**
 * The server-owned in-game world clock: 60 sec/min, 60 min/hr, 24 hr/day, 28 days/month, 12
 * months/year, advanced at 4x wall clock by the caller.
 *
 * Rollover is atomic and emits before it applies: one tick at midnight returns wire `hour: 24`
 * while the post-tick state is `hour: 0, day + 1`.
 */
export interface WorldClock {
  second: number;
  minute: number;
  hour: number;
  day: number;
  month: number;
  year: number;
}

export interface WireTime {
  hour: number;
  minute: number;
}

export const BOOT_DEFAULT_WORLD_CLOCK: WorldClock = {
  second: 0,
  minute: 0,
  hour: 12,
  day: 1,
  month: 1,
  year: 500,
};

/**
 * Advances `clock` by one in-game second in place and returns the wire time for this tick; at
 * midnight the returned hour is 24 even though `clock.hour` is 0 afterwards.
 */
export function tickWorldClock(clock: WorldClock): WireTime {
  clock.second += 1;
  if (clock.second !== 60) return { hour: clock.hour, minute: clock.minute };
  clock.second = 0;
  clock.minute += 1;
  if (clock.minute !== 60) return { hour: clock.hour, minute: clock.minute };
  clock.minute = 0;
  clock.hour += 1;
  const wire = { hour: clock.hour, minute: clock.minute };
  if (clock.hour === 24) {
    clock.hour = 0;
    clock.day += 1;
    if (clock.day === 29) {
      clock.day = 1;
      clock.month += 1;
      if (clock.month === 13) {
        clock.month = 1;
        clock.year += 1;
      }
    }
  }
  return wire;
}
