import { describe, expect, it } from 'vitest';
import { ConnectionActor } from '../src/connection/connectionActor.ts';
import { makeStubConnectionDependencies } from './support/stubDependencies.ts';

describe('ConnectionActor state primitives', () => {
  it('setAttached replaces spaceId while preserving entityId and accountId', () => {
    const connection = new ConnectionActor(makeStubConnectionDependencies());
    const accountId = crypto.randomUUID();
    connection.markAttached('player', 'EdariaLibrary', accountId);
    connection.setAttached('EdariaArena');
    expect(connection.state).toEqual({
      kind: 'attached',
      entityId: 'player',
      spaceId: 'EdariaArena',
      accountId,
    });
  });

  it('setAttached is a no-op while the connection is awaitingLogin', () => {
    const connection = new ConnectionActor(makeStubConnectionDependencies());
    connection.setAttached('Phantom');
    expect(connection.state).toEqual({ kind: 'awaitingLogin' });
  });

  it('disconnectForAdminKick is a no-op when there is no active read loop', () => {
    const connection = new ConnectionActor(makeStubConnectionDependencies());
    connection.disconnectForAdminKick();
    expect(connection.state).toEqual({ kind: 'awaitingLogin' });
  });
});
