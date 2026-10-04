import { describe, expect, it } from 'vitest';
import type { SomnioMessage } from '@somnio/protocol';
import { CLOSE_PROTOCOL_ERROR, ConnectionActor } from '../src/connection/connectionActor.ts';
import { makeStubConnectionDependencies } from './support/stubDependencies.ts';

const move = { x: 10, z: 20, facing: 1, gait: 'run' } as const;
const moves = { moves: [{ id: 'peer', ...move }] };
const leave = { entityId: 'peer', leftGame: true };
const entity = {
  id: 'npc:EdariaBibliothek/libus',
  kind: 'npc',
  characterModelId: 'libus',
  name: 'Libus',
  radius: 0.3,
  x: 10,
  z: 12,
  facing: 0,
  gait: 'jog',
} as const;
const register = {
  nickname: 'Saibot',
  password: 'p',
  passwordRepeat: 'p',
  people: 'wachen',
  email: 'info@example.com',
};
const sessionToken = { token: 'tok', expiresInSeconds: 2_592_000 };

const cases: { label: string; message: SomnioMessage; attachFirst: boolean }[] = [
  { label: 'pre-login moves', message: { tag: 'moves', payload: moves }, attachFirst: false },
  { label: 'pre-login entity', message: { tag: 'entity', payload: entity }, attachFirst: false },
  {
    label: 'pre-login hello',
    message: { tag: 'hello', payload: { protocolVersion: 1 } },
    attachFirst: false,
  },
  { label: 'pre-login leave', message: { tag: 'leave', payload: leave }, attachFirst: false },
  { label: 'pre-login move', message: { tag: 'move', payload: move }, attachFirst: false },
  { label: 'pre-login clientSay', message: { tag: 'clientSay', payload: { text: 'Hallo Welt' } }, attachFirst: false },
  {
    label: 'pre-login equipToggle',
    message: { tag: 'equipToggle', payload: { slot: 1, hand: 'left' } },
    attachFirst: false,
  },
  { label: 'pre-login bump', message: { tag: 'bump', payload: { targetId: entity.id } }, attachFirst: false },
  {
    label: 'pre-login useDoor',
    message: { tag: 'useDoor', payload: { sector: 'EdariaBibliothek', doorId: 'exit' } },
    attachFirst: false,
  },
  {
    label: 'post-attach login',
    message: { tag: 'login', payload: { nickname: 'n', password: 'p' } },
    attachFirst: true,
  },
  { label: 'post-attach register', message: { tag: 'register', payload: register }, attachFirst: true },
  { label: 'post-attach moves', message: { tag: 'moves', payload: moves }, attachFirst: true },
  { label: 'post-attach entity', message: { tag: 'entity', payload: entity }, attachFirst: true },
  { label: 'post-attach leave', message: { tag: 'leave', payload: leave }, attachFirst: true },
  {
    label: 'pre-login revokeSession',
    message: { tag: 'revokeSession', payload: { token: 'tok' } },
    attachFirst: false,
  },
  {
    label: 'post-attach redeemSession',
    message: { tag: 'redeemSession', payload: { token: 'tok' } },
    attachFirst: true,
  },
  {
    label: 'pre-login sessionToken',
    message: { tag: 'sessionToken', payload: sessionToken },
    attachFirst: false,
  },
  {
    label: 'post-attach sessionToken',
    message: { tag: 'sessionToken', payload: sessionToken },
    attachFirst: true,
  },
  {
    label: 'pre-login sessionRevoked',
    message: { tag: 'sessionRevoked', payload: { revoked: true } },
    attachFirst: false,
  },
  {
    label: 'post-attach sessionRevoked',
    message: { tag: 'sessionRevoked', payload: { revoked: true } },
    attachFirst: true,
  },
];

/**
 * Close-enforcement sentinel for `ConnectionActor.dispatch`: every state-illegal tag must close
 * 1002. The keep-open branches run the real handlers and are covered by their own suites.
 */
describe('ConnectionActor.dispatch', () => {
  it.each(cases)('closes with protocolError for $label', async ({ message, attachFirst }) => {
    const connection = new ConnectionActor(await makeStubConnectionDependencies());
    if (attachFirst) connection.markAttached('player', 'EdariaBibliothek', crypto.randomUUID());
    const decision = await connection.dispatch(message);
    expect(decision).toEqual({ kind: 'close', code: CLOSE_PROTOCOL_ERROR, reason: 'frame validation failed' });
  });
});
