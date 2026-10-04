import { describe, expect, it } from 'vitest';
import { SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import type { Placement } from '@somnio/protocol';
import { OUTDOOR_SPACE_ID } from '@somnio/core';
import { STARTER_SECTOR } from '@somnio/data';
import { ConnectionActor } from '../src/connection/connectionActor.ts';
import { completeAuthenticatedJoin, handleLogin } from '../src/handlers/login.ts';
import { handleRedeem, handleRevoke } from '../src/handlers/session.ts';
import { collectMessages, loginResults } from './support/frames.ts';
import { recordingLogger } from './support/logger.ts';
import { makeAuthenticatedWorld, makeOneSectorWorld } from './support/oneSectorWorld.ts';
import { StubSessionRepository, failingSessionRepository } from './support/stubRepositories.ts';

describe('session token issuance', () => {
  it('a login requesting a session token receives one', async () => {
    const sessions = new StubSessionRepository();
    const world = await makeOneSectorWorld({ sessions });
    const connection = new ConnectionActor(world.dependencies);
    await completeAuthenticatedJoin(world.accountId, connection, world.dependencies, true);
    const messages = await collectMessages(connection.outbox);
    expect(messages.map((message) => message.tag)).toContain('loginResult');
    const token = messages.find((message) => message.tag === 'sessionToken');
    expect(token).toBeDefined();
    if (token?.tag === 'sessionToken') {
      expect(sessions.isStored(token.payload.token)).toBe(true);
      expect(token.payload.expiresInSeconds).toBeGreaterThan(0);
    }
  });

  it('a login that did not ask receives no session token', async () => {
    const world = await makeOneSectorWorld({ sessions: new StubSessionRepository() });
    const connection = new ConnectionActor(world.dependencies);
    await completeAuthenticatedJoin(world.accountId, connection, world.dependencies, false);
    const tags = (await collectMessages(connection.outbox)).map((message) => message.tag);
    expect(tags).toContain('loginResult');
    expect(tags).not.toContain('sessionToken');
  });

  it('a failed token issuance still completes the join', async () => {
    const world = await makeOneSectorWorld({ sessions: failingSessionRepository });
    const connection = new ConnectionActor(world.dependencies);
    await completeAuthenticatedJoin(world.accountId, connection, world.dependencies, true);
    const tags = (await collectMessages(connection.outbox)).map((message) => message.tag);
    expect(tags).toContain('loginResult');
    expect(tags).not.toContain('sessionToken');
    expect(tags).toContain('enterSpace');
  });

  it('a join that fails to attach issues no token and reports the failure', async () => {
    const sessions = new StubSessionRepository();
    // One placement carrying more than `maxFrameLength` of `modelId` makes the `sector` frame's encode throw.
    const oversized: Placement = { id: 'oversized', modelId: 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxFrameLength + 1), x: 1, z: 1, yaw: 0, elevation: 0 };
    const world = await makeOneSectorWorld({ sessions, placements: [oversized] });
    const connection = new ConnectionActor(world.dependencies);
    await completeAuthenticatedJoin(world.accountId, connection, world.dependencies, true);
    const messages = await collectMessages(connection.outbox);
    expect(loginResults(messages)).toEqual(['ok', 'badCredentials']);
    const tags = messages.map((message) => message.tag);
    expect(tags).not.toContain('enterSpace');
    expect(tags).not.toContain('sessionToken');
    expect(sessions.issuedCount).toBe(0);

    // The router slot is released: a retry is answered `ok`, not `alreadyLoggedIn`.
    const retry = new ConnectionActor(world.dependencies);
    await completeAuthenticatedJoin(world.accountId, retry, world.dependencies, false);
    expect(loginResults(await collectMessages(retry.outbox))[0]).toBe('ok');
  });

  /** The sector directory is operator-supplied, so a persisted space can be absent from the world. */
  it('a character whose saved space the world no longer has joins at the starter spawn', async () => {
    const world = await makeOneSectorWorld({ sessions: new StubSessionRepository(), characterSpace: 'Gone' });
    const connection = new ConnectionActor(world.dependencies);
    await completeAuthenticatedJoin(world.accountId, connection, world.dependencies, false);
    const messages = await collectMessages(connection.outbox);
    expect(loginResults(messages)).toEqual(['ok']);
    expect(messages[1]).toMatchObject({ tag: 'enterSpace', payload: { spaceId: STARTER_SECTOR } });
    expect(connection.state).toMatchObject({ kind: 'attached', spaceId: STARTER_SECTOR });
  });

  it('redeeming a live token joins the world', async () => {
    const sessions = new StubSessionRepository();
    const world = await makeOneSectorWorld({ sessions });
    const issued = await sessions.issue(world.accountId, 3600);
    const connection = new ConnectionActor(world.dependencies);
    await handleRedeem({ token: issued.token }, connection, world.dependencies);
    const messages = await collectMessages(connection.outbox);
    expect(loginResults(messages)).toEqual(['ok']);
    // The join is `enterSpace` first and once, and a redeemed session mints no token.
    expect(messages.map((message) => message.tag)).toEqual(['loginResult', 'enterSpace', 'sector', 'entity', 'inventory', 'energy']);
    expect(sessions.isStored(issued.token)).toBe(true);
  });

  it('a redeem that throws answers badCredentials rather than nothing', async () => {
    const world = await makeOneSectorWorld({ sessions: failingSessionRepository });
    const connection = new ConnectionActor(world.dependencies);
    await handleRedeem({ token: 'any' }, connection, world.dependencies);
    expect(loginResults(await collectMessages(connection.outbox))).toEqual(['badCredentials']);
  });

  it('a revoke that throws answers rather than going silent', async () => {
    const world = await makeOneSectorWorld({ sessions: failingSessionRepository });
    const connection = new ConnectionActor(world.dependencies);
    connection.markAttached('player', OUTDOOR_SPACE_ID, world.accountId);
    await handleRevoke({ token: 'any' }, world.accountId, connection, world.dependencies);
    expect(await collectMessages(connection.outbox)).toEqual([{ tag: 'sessionRevoked', payload: { revoked: false } }]);
  });

  it('a login omitting requestSessionToken is answered without a token', async () => {
    const world = await makeAuthenticatedWorld({ sessions: new StubSessionRepository(), name: 'gated', password: 'hunter2-long' });
    const connection = new ConnectionActor(world.dependencies);
    await handleLogin({ nickname: 'gated', password: 'hunter2-long' }, connection, world.dependencies);
    const tags = (await collectMessages(connection.outbox)).map((message) => message.tag);
    expect(tags).toContain('enterSpace');
    expect(tags).not.toContain('sessionToken');
  });

  it('a login setting requestSessionToken is answered with one', async () => {
    const world = await makeAuthenticatedWorld({ sessions: new StubSessionRepository(), name: 'asker', password: 'hunter2-long' });
    const connection = new ConnectionActor(world.dependencies);
    await handleLogin({ nickname: 'asker', password: 'hunter2-long', requestSessionToken: true }, connection, world.dependencies);
    const tags = (await collectMessages(connection.outbox)).map((message) => message.tag);
    expect(tags).toEqual(['loginResult', 'enterSpace', 'sector', 'entity', 'inventory', 'energy', 'sessionToken']);
  });

  /** Uniform on the wire, specific in the log: the record is the operator's only guessing signal. */
  it('a login with the wrong password answers badCredentials and records a warn naming the account', async () => {
    const { logger, records } = recordingLogger();
    const world = await makeAuthenticatedWorld({ sessions: new StubSessionRepository(), name: 'asker', password: 'hunter2-long', logger });
    const connection = new ConnectionActor(world.dependencies);
    await handleLogin({ nickname: 'asker', password: 'wrong-password' }, connection, world.dependencies);
    expect(loginResults(await collectMessages(connection.outbox))).toEqual(['badCredentials']);
    const rejected = records.filter((record) => record['msg'] === 'login rejected: bad credentials');
    expect(rejected).toMatchObject([{ level: 40, known_account: true, name: 'asker' }]);
  });

  it('a login for an unknown account records the warn without the submitted string', async () => {
    const { logger, records } = recordingLogger();
    const world = await makeAuthenticatedWorld({ sessions: new StubSessionRepository(), name: 'asker', password: 'hunter2-long', logger });
    const connection = new ConnectionActor(world.dependencies);
    await handleLogin({ nickname: 'my-secret-pw', password: 'whatever-long' }, connection, world.dependencies);
    expect(loginResults(await collectMessages(connection.outbox))).toEqual(['badCredentials']);
    const rejected = records.filter((record) => record['msg'] === 'login rejected: bad credentials');
    expect(rejected).toMatchObject([{ level: 40, known_account: false }]);
    // Over every record, not only the warn: no path in the handler may write the submitted string.
    expect(JSON.stringify(records)).not.toContain('my-secret-pw');
  });

  it('a second join for the same account answers alreadyLoggedIn', async () => {
    const world = await makeOneSectorWorld({ sessions: new StubSessionRepository() });
    const first = new ConnectionActor(world.dependencies);
    await completeAuthenticatedJoin(world.accountId, first, world.dependencies, false);
    const second = new ConnectionActor(world.dependencies);
    await completeAuthenticatedJoin(world.accountId, second, world.dependencies, false);
    expect(loginResults(await collectMessages(second.outbox))).toEqual(['alreadyLoggedIn']);
  });
});
