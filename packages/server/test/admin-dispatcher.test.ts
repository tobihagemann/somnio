import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SOMNIO_PROTOCOL_CONSTANTS, encodeAdminResponse } from '@somnio/protocol';
import { ADMIN_LOG_FILE_NAME, GAMEPLAY_LOG_FILE_NAME } from '../src/logging.ts';
import { LOG_WIRE_LIMIT_BYTES, dispatchAdminRequest, truncateToWireLimit } from '../src/handlers/adminDispatcher.ts';
import { makeAdminDependencies } from './support/adminDependencies.ts';
import { StubAdminWorldRouter } from './support/stubAdminWorldRouter.ts';
import { tempLogging } from './support/tempLogging.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function dependencies(options: Parameters<typeof makeAdminDependencies>[0] = {}) {
  const logging = options.logging ?? tempLogging();
  cleanups.push(() => logging.cleanup());
  return makeAdminDependencies({ ...options, logging });
}

describe('log / weblog', () => {
  it('log returns logEmpty when the file does not exist', async () => {
    expect(dispatchAdminRequest({ tag: 'log' }, await dependencies())).toEqual({ tag: 'logEmpty' });
  });

  it('log returns logContents with the file body', async () => {
    const deps = await dependencies();
    writeFileSync(join(deps.logging.directory, GAMEPLAY_LOG_FILE_NAME), 'hello\nworld');
    expect(dispatchAdminRequest({ tag: 'log' }, deps)).toEqual({
      tag: 'logContents',
      payload: 'hello\nworld',
    });
  });

  it('log oversized payload is cut on a character boundary and encodes through the wire', async () => {
    const deps = await dependencies();
    const body = 'ü'.repeat(35_000);
    expect(Buffer.byteLength(body, 'utf8')).toBe(70_000);
    writeFileSync(join(deps.logging.directory, GAMEPLAY_LOG_FILE_NAME), body);
    const response = dispatchAdminRequest({ tag: 'log' }, deps);
    expect(response?.tag).toBe('logContents');
    if (response?.tag === 'logContents') {
      expect(Buffer.byteLength(response.payload, 'utf8')).toBeLessThanOrEqual(LOG_WIRE_LIMIT_BYTES);
      expect(response.payload.endsWith('ü')).toBe(true);
      expect(response.payload.startsWith('ü')).toBe(true);
      expect(() => encodeAdminResponse(response)).not.toThrow();
    }
  });

  it('log truncation keeps the trailing window, not the leading prefix', async () => {
    const deps = await dependencies();
    const head = 'HEAD-SENTINEL ';
    const tail = 'TAIL-SENTINEL';
    writeFileSync(join(deps.logging.directory, GAMEPLAY_LOG_FILE_NAME), head + 'x'.repeat(80_000) + tail);
    const response = dispatchAdminRequest({ tag: 'log' }, deps);
    if (response?.tag !== 'logContents') throw new Error('expected logContents');
    expect(Buffer.byteLength(response.payload, 'utf8')).toBeLessThanOrEqual(LOG_WIRE_LIMIT_BYTES);
    expect(response.payload.endsWith(tail)).toBe(true);
    expect(response.payload.includes(head)).toBe(false);
  });

  it('log non-UTF-8 contents fall back to logEmpty', async () => {
    const deps = await dependencies();
    writeFileSync(join(deps.logging.directory, GAMEPLAY_LOG_FILE_NAME), Buffer.from([0xff, 0xfe, 0xff]));
    expect(dispatchAdminRequest({ tag: 'log' }, deps)).toEqual({ tag: 'logEmpty' });
  });

  it('logRemove deletes the file and returns logRemoved; a later write reopens it', async () => {
    const deps = await dependencies();
    const file = join(deps.logging.directory, GAMEPLAY_LOG_FILE_NAME);
    deps.logging.gameplayFile.write('primed\n');
    expect(existsSync(file)).toBe(true);
    expect(dispatchAdminRequest({ tag: 'logRemove' }, deps)).toEqual({ tag: 'logRemoved' });
    expect(existsSync(file)).toBe(false);
    deps.logging.gameplayFile.write('after-rm\n');
    expect(readFileSync(file, 'utf8')).toBe('after-rm\n');
  });

  it('weblog returns weblogEmpty when missing and weblogContents when populated', async () => {
    const deps = await dependencies();
    expect(dispatchAdminRequest({ tag: 'weblog' }, deps)).toEqual({ tag: 'weblogEmpty' });
    writeFileSync(join(deps.logging.directory, ADMIN_LOG_FILE_NAME), 'admin-line');
    expect(dispatchAdminRequest({ tag: 'weblog' }, deps)).toEqual({
      tag: 'weblogContents',
      payload: 'admin-line',
    });
  });

  it('weblogRemove deletes the admin file and returns weblogRemoved', async () => {
    const deps = await dependencies();
    deps.logging.adminFile.write('primed\n');
    expect(dispatchAdminRequest({ tag: 'weblogRemove' }, deps)).toEqual({ tag: 'weblogRemoved' });
    expect(existsSync(join(deps.logging.directory, ADMIN_LOG_FILE_NAME))).toBe(false);
  });
});

describe('players / time', () => {
  it('players returns playerCount text', async () => {
    const router = new StubAdminWorldRouter();
    router.playerCount = 7;
    expect(dispatchAdminRequest({ tag: 'players' }, await dependencies({ worldRouter: router }))).toEqual({
      tag: 'playerCount',
      payload: '7',
    });
  });

  it('time formats the wire payload as Y;M;D;HH;MM;SS', async () => {
    const deps = await dependencies({
      initialClock: { second: 7, minute: 5, hour: 0, day: 1, month: 1, year: 1 },
    });
    expect(dispatchAdminRequest({ tag: 'time' }, deps)).toEqual({
      tag: 'worldClock',
      payload: '1;1;1;00;05;07',
    });
  });
});

describe('say', () => {
  it('broadcasts and returns sayBroadcast', async () => {
    const router = new StubAdminWorldRouter();
    const response = dispatchAdminRequest({ tag: 'say', payload: 'hello' }, await dependencies({ worldRouter: router }));
    expect(response).toEqual({ tag: 'sayBroadcast', payload: 'hello' });
    expect(router.broadcasts).toEqual([{ tag: 'adminSay', payload: { text: 'hello' } }]);
  });

  it('empty text returns undefined and records no broadcast', async () => {
    const router = new StubAdminWorldRouter();
    expect(dispatchAdminRequest({ tag: 'say', payload: '' }, await dependencies({ worldRouter: router }))).toBeUndefined();
    expect(router.broadcasts).toEqual([]);
  });

  it('text over the wire cap returns undefined and records no broadcast', async () => {
    const router = new StubAdminWorldRouter();
    const oversized = 'x'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes + 1);
    expect(dispatchAdminRequest({ tag: 'say', payload: oversized }, await dependencies({ worldRouter: router }))).toBeUndefined();
    expect(router.broadcasts).toEqual([]);
  });
});

describe('kick / version', () => {
  it('kick of a match returns kickedPlayer', async () => {
    const router = new StubAdminWorldRouter();
    router.kickOutcome = true;
    expect(dispatchAdminRequest({ tag: 'kick', payload: 'Saibot' }, await dependencies({ worldRouter: router }))).toEqual({
      tag: 'kickedPlayer',
      payload: 'Saibot',
    });
  });

  it('kick of a miss returns kickedPlayerNotFound', async () => {
    expect(dispatchAdminRequest({ tag: 'kick', payload: 'Saibot' }, await dependencies())).toEqual({
      tag: 'kickedPlayerNotFound',
      payload: 'Saibot',
    });
  });

  it('kick of an empty name returns kickedPlayerNotFound with empty text', async () => {
    expect(dispatchAdminRequest({ tag: 'kick', payload: '' }, await dependencies())).toEqual({
      tag: 'kickedPlayerNotFound',
      payload: '',
    });
  });

  it("version returns the bag's serverVersion", async () => {
    expect(dispatchAdminRequest({ tag: 'version' }, await dependencies({ serverVersion: '9.9.9' }))).toEqual({
      tag: 'versionString',
      payload: '9.9.9',
    });
  });
});

describe('truncateToWireLimit', () => {
  it('passes a small text through unchanged', () => {
    expect(truncateToWireLimit('abc')).toBe('abc');
  });

  it('never splits a multi-byte sequence', () => {
    const text = 'é'.repeat(LOG_WIRE_LIMIT_BYTES);
    const cut = truncateToWireLimit(text);
    expect(Buffer.byteLength(cut, 'utf8')).toBeLessThanOrEqual(LOG_WIRE_LIMIT_BYTES);
    expect(cut.includes('�')).toBe(false);
  });
});
