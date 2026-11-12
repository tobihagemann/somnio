import { describe, expect, it } from 'vitest';
import { BOOT_DEFAULT_WORLD_SECONDS, WORLD_TIME_RATE, worldDay } from '@somnio/core';
import type { WorldClockRepository } from '@somnio/data';
import { WorldClockService } from '../src/services/worldClockService.ts';
import { testLogger } from './support/logger.ts';
import { RepositoryFailure } from './support/stubRepositories.ts';

const SECONDS_PER_DAY = 24 * 60 * 60;

class SaveRecorder implements WorldClockRepository {
  readonly saved: number[] = [];
  attempts = 0;
  private readonly fail: boolean;

  constructor(fail = false) {
    this.fail = fail;
  }

  load(): Promise<number> {
    return Promise.resolve(BOOT_DEFAULT_WORLD_SECONDS);
  }

  save(worldSeconds: number): Promise<void> {
    this.attempts += 1;
    if (this.fail) return Promise.reject(new RepositoryFailure());
    this.saved.push(worldSeconds);
    return Promise.resolve();
  }
}

/** A service starting `secondsIntoMinute` world seconds into a minute, on a wall clock the test advances. */
function service(recorder: WorldClockRepository, secondsIntoMinute: number) {
  const wall = { ms: 0 };
  const start = BOOT_DEFAULT_WORLD_SECONDS + secondsIntoMinute;
  return { wall, start, clock: new WorldClockService(recorder, start, testLogger(), undefined, () => wall.ms) };
}

describe('WorldClockService.tickOnce', () => {
  it('advances by the wall time since the previous tick at the world time rate', async () => {
    const { wall, start, clock } = service(new SaveRecorder(), 0);
    wall.ms = 250;
    await clock.tickOnce();
    expect(clock.currentWorldSeconds()).toBe(start + 0.25 * WORLD_TIME_RATE);
    wall.ms = 2250;
    await clock.tickOnce();
    expect(clock.currentWorldSeconds()).toBe(start + 2.25 * WORLD_TIME_RATE);
  });

  it('persists when a tick crosses into a new world minute', async () => {
    const recorder = new SaveRecorder();
    const { wall, start, clock } = service(recorder, 59);
    wall.ms = 250;
    await clock.tickOnce();
    expect(recorder.saved).toEqual([start + 1]);
  });

  it('staying in the same minute does not persist', async () => {
    const recorder = new SaveRecorder();
    const { wall, clock } = service(recorder, 5);
    wall.ms = 250;
    await clock.tickOnce();
    expect(recorder.saved).toEqual([]);
  });

  it('logs and continues when the persistence save throws', async () => {
    const recorder = new SaveRecorder(true);
    const { wall, start, clock } = service(recorder, 59);
    wall.ms = 250;
    await clock.tickOnce();
    expect(recorder.attempts).toBe(1);
    expect(clock.currentWorldSeconds()).toBe(start + 1);
  });

  it('tells its listener once as a tick crosses into a new world day', async () => {
    const wall = { ms: 0 };
    const lastSecondOfDay = 3 * SECONDS_PER_DAY - 1;
    const clock = new WorldClockService(new SaveRecorder(), lastSecondOfDay - WORLD_TIME_RATE / 4, testLogger(), undefined, () => wall.ms);
    const days: number[] = [];
    clock.onNewDay((worldSeconds) => days.push(worldDay(worldSeconds)));
    wall.ms = 250;
    await clock.tickOnce();
    expect(days).toEqual([]);
    wall.ms = 500;
    await clock.tickOnce();
    wall.ms = 750;
    await clock.tickOnce();
    expect(days).toEqual([3]);
  });

  it('graceful shutdown triggers a final save even mid minute', async () => {
    const recorder = new SaveRecorder();
    const clock = new WorldClockService(recorder, BOOT_DEFAULT_WORLD_SECONDS + 30, testLogger(), 10);
    const control = new AbortController();
    const run = clock.run(control.signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    control.abort();
    await run;
    expect(recorder.saved.length).toBeGreaterThan(0);
    expect(recorder.saved.at(-1)).toBeGreaterThan(BOOT_DEFAULT_WORLD_SECONDS + 30);
  });
});
