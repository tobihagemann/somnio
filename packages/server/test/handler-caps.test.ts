import { describe, expect, it } from 'vitest';
import { SOMNIO_PROTOCOL_CONSTANTS, decodeSomnioMessage, encodeSomnioMessage } from '@somnio/protocol';
import { OUTDOOR_SPACE_ID } from '@somnio/core';
import { ConnectionActor } from '../src/connection/connectionActor.ts';
import { handleSay } from '../src/handlers/gameplay.ts';
import { collectMessages, serverSays } from './support/frames.ts';
import { attachPlayer, makeSector } from './support/sectorFactory.ts';
import { makeStubConnectionDependencies } from './support/stubDependencies.ts';
import { StubSessionRepository } from './support/stubRepositories.ts';

/** The server-side UTF-8 caps on the gameplay handlers: every over-cap frame is answered or dropped, never closed on. */
describe('handler caps', () => {
  it('handleSay drops an over-cap chat line but broadcasts a within-cap one', async () => {
    const dependencies = await makeStubConnectionDependencies({ sectors: [makeSector('A')] });
    const space = dependencies.worldRouter.space(OUTDOOR_SPACE_ID)!;
    const speaker = attachPlayer(space, { x: 1, z: 1 });
    const peer = attachPlayer(space, { x: 2, z: 2 }, 'peer');

    const oversized = 'x'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes + 1);
    handleSay({ text: oversized }, speaker.entityId, OUTDOOR_SPACE_ID, dependencies);
    handleSay({ text: 'hi' }, speaker.entityId, OUTDOOR_SPACE_ID, dependencies);

    expect(serverSays(await collectMessages(peer.outbox))).toEqual(['hi']);
  });

  it('an over-cap clientSay through dispatch keeps the connection open and broadcasts nothing', async () => {
    const dependencies = await makeStubConnectionDependencies({ sectors: [makeSector('A')] });
    const space = dependencies.worldRouter.space(OUTDOOR_SPACE_ID)!;
    const connection = new ConnectionActor(dependencies);
    const speaker = attachPlayer(space, { x: 1, z: 1 }, 'speaker', { outbox: connection.outbox });
    connection.markAttached(speaker.entityId, OUTDOOR_SPACE_ID, crypto.randomUUID());
    const peer = attachPlayer(space, { x: 2, z: 2 }, 'peer');

    // The frame is a legal wire frame (the client-side decode is uncapped), so it reaches the handler.
    const frame = encodeSomnioMessage({
      tag: 'clientSay',
      payload: { text: 'x'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes + 1) },
    });
    const decision = await connection.dispatch(decodeSomnioMessage(frame));
    expect(decision).toEqual({ kind: 'keepOpen' });
    expect(serverSays(await collectMessages(peer.outbox))).toEqual([]);
  });

  it('an over-cap redeemSession answers badCredentials with no repository call', async () => {
    const sessions = new StubSessionRepository();
    const connection = new ConnectionActor(await makeStubConnectionDependencies({ sessions }));
    const token = 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSessionTokenUTF8Bytes + 1);
    await connection.dispatch({ tag: 'redeemSession', payload: { token } });
    expect(await collectMessages(connection.outbox)).toEqual([{ tag: 'loginResult', payload: { result: 'badCredentials' } }]);
    expect(sessions.redeemCallCount).toBe(0);
  });

  it('an over-cap revokeSession answers sessionRevoked(false) with no repository call', async () => {
    const sessions = new StubSessionRepository();
    const connection = new ConnectionActor(await makeStubConnectionDependencies({ sessions }));
    connection.markAttached('player', OUTDOOR_SPACE_ID, crypto.randomUUID());
    const token = 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSessionTokenUTF8Bytes + 1);
    await connection.dispatch({ tag: 'revokeSession', payload: { token } });
    expect(await collectMessages(connection.outbox)).toEqual([{ tag: 'sessionRevoked', payload: { revoked: false } }]);
    expect(sessions.revokeCallCount).toBe(0);
  });
});
