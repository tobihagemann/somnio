import { describe, expect, it } from 'vitest';
import { LOGIN_RESULT, SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import { ConnectionActor } from '../src/connection/connectionActor.ts';
import { collectMessages, collectTags, loginResults } from './support/frames.ts';
import { makeStubConnectionDependencies } from './support/stubDependencies.ts';
import { StubSessionRepository } from './support/stubRepositories.ts';

/** The session verbs' placement in the state machine and their answers; the dispatch suite is the mirror image. */
describe('session tag placement', () => {
  it('redeemSession is accepted before login', async () => {
    const connection = new ConnectionActor(await makeStubConnectionDependencies());
    expect(await connection.dispatch({ tag: 'redeemSession', payload: { token: 'tok' } })).toEqual({
      kind: 'keepOpen',
    });
  });

  it('revokeSession is accepted after attach', async () => {
    const connection = new ConnectionActor(await makeStubConnectionDependencies());
    connection.markAttached(1, 'EdariaBibliothek', crypto.randomUUID());
    expect(await connection.dispatch({ tag: 'revokeSession', payload: { token: 'tok' } })).toEqual({
      kind: 'keepOpen',
    });
  });

  it('an unresolvable token answers badCredentials without closing', async () => {
    const connection = new ConnectionActor(await makeStubConnectionDependencies());
    const decision = await connection.dispatch({ tag: 'redeemSession', payload: { token: 'nope' } });
    expect(decision).toEqual({ kind: 'keepOpen' });
    expect(loginResults(await collectMessages(connection.outbox))).toEqual([LOGIN_RESULT.badCredentials]);
  });

  it('revocation acknowledges even when nothing was removed', async () => {
    const connection = new ConnectionActor(await makeStubConnectionDependencies());
    connection.markAttached(1, 'EdariaBibliothek', crypto.randomUUID());
    await connection.dispatch({ tag: 'revokeSession', payload: { token: 'tok' } });
    expect(await collectTags(connection.outbox)).toContain('sessionRevoked');
  });

  it('an over-cap token is refused without reaching the repository', async () => {
    const sessions = new StubSessionRepository();
    const issued = await sessions.issue(crypto.randomUUID(), 60);
    const connection = new ConnectionActor(await makeStubConnectionDependencies({ sessions }));
    const oversized = 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSessionTokenUTF8Bytes + 1);
    const decision = await connection.dispatch({ tag: 'redeemSession', payload: { token: oversized } });
    expect(decision).toEqual({ kind: 'keepOpen' });
    expect(await collectTags(connection.outbox)).toContain('loginResult');
    expect(sessions.isStored(issued.token)).toBe(true);
    expect(sessions.redeemCallCount).toBe(0);
  });

  it('an over-cap revoke token is refused without reaching the repository', async () => {
    const sessions = new StubSessionRepository();
    const accountId = crypto.randomUUID();
    const issued = await sessions.issue(accountId, 3600);
    const connection = new ConnectionActor(await makeStubConnectionDependencies({ sessions }));
    connection.markAttached(1, 'EdariaBibliothek', accountId);
    const oversized = 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSessionTokenUTF8Bytes + 1);
    const decision = await connection.dispatch({ tag: 'revokeSession', payload: { token: oversized } });
    expect(decision).toEqual({ kind: 'keepOpen' });
    expect(await collectTags(connection.outbox)).toContain('sessionRevoked');
    expect(sessions.isStored(issued.token)).toBe(true);
    expect(sessions.revokeCallCount).toBe(0);
  });

  it('revocation refuses a token belonging to another account', async () => {
    const sessions = new StubSessionRepository();
    const victim = await sessions.issue(crypto.randomUUID(), 3600);
    const connection = new ConnectionActor(await makeStubConnectionDependencies({ sessions }));
    connection.markAttached(1, 'EdariaBibliothek', crypto.randomUUID());
    await connection.dispatch({ tag: 'revokeSession', payload: { token: victim.token } });
    const messages = await collectMessages(connection.outbox);
    expect(messages).toContainEqual({ tag: 'sessionRevoked', payload: { revoked: false } });
    expect(sessions.isStored(victim.token)).toBe(true);
  });

  it("revocation removes the connection's own token", async () => {
    const sessions = new StubSessionRepository();
    const accountId = crypto.randomUUID();
    const issued = await sessions.issue(accountId, 3600);
    const connection = new ConnectionActor(await makeStubConnectionDependencies({ sessions }));
    connection.markAttached(1, 'EdariaBibliothek', accountId);
    await connection.dispatch({ tag: 'revokeSession', payload: { token: issued.token } });
    const messages = await collectMessages(connection.outbox);
    expect(messages).toContainEqual({ tag: 'sessionRevoked', payload: { revoked: true } });
    expect(sessions.isStored(issued.token)).toBe(false);
  });

  it('an expired token answers badCredentials', async () => {
    const sessions = new StubSessionRepository();
    sessions.plant('aged', crypto.randomUUID(), new Date(Date.now() - 60_000));
    const connection = new ConnectionActor(await makeStubConnectionDependencies({ sessions }));
    await connection.dispatch({ tag: 'redeemSession', payload: { token: 'aged' } });
    expect(loginResults(await collectMessages(connection.outbox))).toEqual([LOGIN_RESULT.badCredentials]);
  });
});
