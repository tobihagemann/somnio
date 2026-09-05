import { describe, expect, it } from 'vitest';
import { BOOT_DEFAULT_WORLD_CLOCK } from '@somnio/core';
import type { WorldClock } from '@somnio/core';
import type { WorldClockRepository } from '@somnio/data';
import { ConnectionActor } from '../src/connection/connectionActor.ts';
import { WorldClockService } from '../src/services/worldClockService.ts';
import { collectMessages, dateTicks } from './support/frames.ts';
import { testLogger } from './support/logger.ts';
import { makeStubConnectionDependencies } from './support/stubDependencies.ts';
import { RepositoryFailure } from './support/stubRepositories.ts';

class SaveRecorder implements WorldClockRepository {
  readonly saved: WorldClock[] = [];
  attempts = 0;
  private readonly fail: boolean;

  constructor(fail = false) {
    this.fail = fail;
  }

  load(): Promise<WorldClock> {
    return Promise.resolve({ ...BOOT_DEFAULT_WORLD_CLOCK });
  }

  save(clock: WorldClock): Promise<void> {
    this.attempts += 1;
    if (this.fail) return Promise.reject(new RepositoryFailure());
    this.saved.push({ ...clock });
    return Promise.resolve();
  }
}

async function attachedConnection() {
  const dependencies = await makeStubConnectionDependencies();
  const connection = new ConnectionActor(dependencies);
  const accountId = crypto.randomUUID();
  dependencies.worldRouter.register(connection, accountId, 'TestPlayer');
  connection.markAttached(1, 'X', accountId);
  return { dependencies, connection };
}

function service(
  router: Awaited<ReturnType<typeof attachedConnection>>['dependencies']['worldRouter'],
  recorder: WorldClockRepository,
  clock: WorldClock,
  intervalMs?: number,
) {
  return new WorldClockService(router, recorder, clock, testLogger(), intervalMs);
}

describe('WorldClockService.tickOnce', () => {
  it('tick at minute twelve emits a date tick', async () => {
    const { dependencies, connection } = await attachedConnection();
    const recorder = new SaveRecorder();
    await service(dependencies.worldRouter, recorder, {
      second: 59,
      minute: 11,
      hour: 12,
      day: 1,
      month: 1,
      year: 500,
    }).tickOnce();
    expect(dateTicks(await collectMessages(connection.outbox))).toEqual([{ hour: 12, minute: 12 }]);
    expect(recorder.saved.length).toBe(1);
  });

  it('tick at minute eleven persists but does not emit', async () => {
    const { dependencies, connection } = await attachedConnection();
    const recorder = new SaveRecorder();
    await service(dependencies.worldRouter, recorder, {
      second: 59,
      minute: 10,
      hour: 12,
      day: 1,
      month: 1,
      year: 500,
    }).tickOnce();
    expect(dateTicks(await collectMessages(connection.outbox))).toEqual([]);
    expect(recorder.saved.length).toBe(1);
  });

  it('midnight tick emits hour twenty four on the wire', async () => {
    const { dependencies, connection } = await attachedConnection();
    const clock = service(dependencies.worldRouter, new SaveRecorder(), {
      second: 59,
      minute: 59,
      hour: 23,
      day: 1,
      month: 1,
      year: 500,
    });
    await clock.tickOnce();
    expect(dateTicks(await collectMessages(connection.outbox))[0]).toEqual({ hour: 24, minute: 0 });
    expect(clock.currentTime()).toMatchObject({ hour: 0, day: 2 });
  });

  it('staying in the same minute does not persist', async () => {
    const { dependencies } = await attachedConnection();
    const recorder = new SaveRecorder();
    await service(dependencies.worldRouter, recorder, {
      second: 5,
      minute: 7,
      hour: 12,
      day: 1,
      month: 1,
      year: 500,
    }).tickOnce();
    expect(recorder.saved).toEqual([]);
  });

  it('boot default first tick neither emits nor persists', async () => {
    const { dependencies, connection } = await attachedConnection();
    const recorder = new SaveRecorder();
    await service(dependencies.worldRouter, recorder, BOOT_DEFAULT_WORLD_CLOCK).tickOnce();
    expect(dateTicks(await collectMessages(connection.outbox))).toEqual([]);
    expect(recorder.saved).toEqual([]);
  });

  it('logs and continues when the persistence save throws', async () => {
    const { dependencies } = await attachedConnection();
    const recorder = new SaveRecorder(true);
    const clock = service(dependencies.worldRouter, recorder, {
      second: 59,
      minute: 10,
      hour: 12,
      day: 1,
      month: 1,
      year: 500,
    });
    await clock.tickOnce();
    expect(recorder.attempts).toBe(1);
    expect(clock.currentTime()).toMatchObject({ second: 0, minute: 11 });
  });

  it('graceful shutdown triggers a final save even mid minute', async () => {
    const { dependencies } = await attachedConnection();
    const recorder = new SaveRecorder();
    const clock = service(dependencies.worldRouter, recorder, { second: 30, minute: 5, hour: 12, day: 1, month: 1, year: 500 }, 10);
    const control = new AbortController();
    const run = clock.run(control.signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    control.abort();
    await run;
    expect(recorder.saved.length).toBeGreaterThan(0);
  });
});
