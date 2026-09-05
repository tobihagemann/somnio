import { describe, expect, it } from 'vitest';
import { SOMNIO_PROTOCOL_CONSTANTS, decodeSomnioMessage, encodeSomnioMessage } from '@somnio/protocol';
import { ConnectionActor } from '../src/connection/connectionActor.ts';
import { ConnectionOutbox } from '../src/connection/outbox.ts';
import { handleSay } from '../src/handlers/gameplay.ts';
import { collectMessages, serverSays } from './support/frames.ts';
import { makeCharacter, makeSector } from './support/sectorFactory.ts';
import { makeStubConnectionDependencies } from './support/stubDependencies.ts';
import { StubSessionRepository } from './support/stubRepositories.ts';

/** The server-side UTF-8 caps on the gameplay handlers: every over-cap frame is answered or dropped, never closed on. */
describe('handler caps', () => {
  it('handleSay drops an over-cap chat line but broadcasts a within-cap one', async () => {
    const dependencies = await makeStubConnectionDependencies({ sectors: new Map([['A', makeSector('A')]]) });
    const sector = dependencies.worldRouter.sector('A')!;
    const speakerOutbox = new ConnectionOutbox(1024);
    const speaker = sector.attach(makeCharacter({ x: 1, y: 1 }, 'tester', 'A'), [], speakerOutbox);
    const peerOutbox = new ConnectionOutbox(1024);
    sector.attach(makeCharacter({ x: 2, y: 2 }, 'peer', 'A'), [], peerOutbox);

    const oversized = 'x'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes + 1);
    handleSay({ entityIndex: 0, text: oversized }, speaker, 'A', dependencies);
    handleSay({ entityIndex: 0, text: 'hi' }, speaker, 'A', dependencies);

    expect(serverSays(await collectMessages(peerOutbox))).toEqual(['hi']);
  });

  it('an over-cap clientSay through dispatch keeps the connection open and broadcasts nothing', async () => {
    const dependencies = await makeStubConnectionDependencies({ sectors: new Map([['A', makeSector('A')]]) });
    const sector = dependencies.worldRouter.sector('A')!;
    const connection = new ConnectionActor(dependencies);
    const speaker = sector.attach(makeCharacter({ x: 1, y: 1 }, 'tester', 'A'), [], connection.outbox);
    connection.markAttached(speaker, 'A', crypto.randomUUID());
    const peerOutbox = new ConnectionOutbox(1024);
    sector.attach(makeCharacter({ x: 2, y: 2 }, 'peer', 'A'), [], peerOutbox);

    // The frame is a legal wire frame (the client-side decode is uncapped), so it reaches the handler.
    const frame = encodeSomnioMessage({
      tag: 'clientSay',
      payload: { entityIndex: 0, text: 'x'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes + 1) },
    });
    const decision = await connection.dispatch(decodeSomnioMessage(frame));
    expect(decision).toEqual({ kind: 'keepOpen' });
    expect(serverSays(await collectMessages(peerOutbox))).toEqual([]);
  });

  it('an over-cap redeemSession answers badCredentials with no repository call', async () => {
    const sessions = new StubSessionRepository();
    const connection = new ConnectionActor(await makeStubConnectionDependencies({ sessions }));
    const token = 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSessionTokenUTF8Bytes + 1);
    await connection.dispatch({ tag: 'redeemSession', payload: { token } });
    expect(await collectMessages(connection.outbox)).toEqual([{ tag: 'loginResult', payload: { result: 1 } }]);
    expect(sessions.redeemCallCount).toBe(0);
  });

  it('an over-cap revokeSession answers sessionRevoked(false) with no repository call', async () => {
    const sessions = new StubSessionRepository();
    const connection = new ConnectionActor(await makeStubConnectionDependencies({ sessions }));
    connection.markAttached(1, 'A', crypto.randomUUID());
    const token = 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSessionTokenUTF8Bytes + 1);
    await connection.dispatch({ tag: 'revokeSession', payload: { token } });
    expect(await collectMessages(connection.outbox)).toEqual([{ tag: 'sessionRevoked', payload: { revoked: false } }]);
    expect(sessions.revokeCallCount).toBe(0);
  });
});
