import { describe, expect, it } from 'vitest';
import { WIRE_ENTITY_TYPE, WIRE_HAND } from '@somnio/protocol';
import type { SomnioMessage } from '@somnio/protocol';
import { CLOSE_PROTOCOL_ERROR, ConnectionActor } from '../src/connection/connectionActor.ts';
import { makeStubConnectionDependencies } from './support/stubDependencies.ts';

const position = { entityIndex: 7, x: 10, y: 20, facing: 1, tempo: 2 };
const say = { entityIndex: 0, text: 'Hallo Welt' };
const leave = { entityIndex: 4, leftGame: true };
const entity = {
  entityIndex: 9,
  figure: 0,
  gender: 1,
  maskWidth: 32,
  maskHeight: 48,
  type: WIRE_ENTITY_TYPE.player,
  name: 'Libus',
  x: 10,
  y: 12,
  facing: 0,
  tempo: 2,
};
const register = {
  nickname: 'Saibot',
  password: 'p',
  passwordRepeat: 'p',
  characterClass: 0,
  gender: 1,
  email: 'info@example.com',
};
const sessionToken = { token: 'tok', expiresInSeconds: 2_592_000 };

const cases: { label: string; message: SomnioMessage; attachFirst: boolean }[] = [
  {
    label: 'pre-login serverPosition',
    message: { tag: 'serverPosition', payload: position },
    attachFirst: false,
  },
  { label: 'pre-login entity', message: { tag: 'entity', payload: entity }, attachFirst: false },
  {
    label: 'pre-login hello',
    message: { tag: 'hello', payload: { protocolVersion: 1 } },
    attachFirst: false,
  },
  { label: 'pre-login leave', message: { tag: 'leave', payload: leave }, attachFirst: false },
  {
    label: 'pre-login clientPosition',
    message: { tag: 'clientPosition', payload: position },
    attachFirst: false,
  },
  { label: 'pre-login clientSay', message: { tag: 'clientSay', payload: say }, attachFirst: false },
  {
    label: 'pre-login equipToggle',
    message: { tag: 'equipToggle', payload: { slot: 1, hand: WIRE_HAND.left } },
    attachFirst: false,
  },
  { label: 'pre-login bumpNPC', message: { tag: 'bumpNPC', payload: { npcIndex: 4 } }, attachFirst: false },
  {
    label: 'pre-login enterPortal',
    message: { tag: 'enterPortal', payload: { portalIndex: 2 } },
    attachFirst: false,
  },
  {
    label: 'post-attach login',
    message: { tag: 'login', payload: { nickname: 'n', password: 'p' } },
    attachFirst: true,
  },
  { label: 'post-attach register', message: { tag: 'register', payload: register }, attachFirst: true },
  {
    label: 'post-attach serverPosition',
    message: { tag: 'serverPosition', payload: position },
    attachFirst: true,
  },
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
    if (attachFirst) connection.markAttached(1, 'EdariaBibliothek', crypto.randomUUID());
    const decision = await connection.dispatch(message);
    expect(decision).toEqual({ kind: 'close', code: CLOSE_PROTOCOL_ERROR, reason: 'frame validation failed' });
  });
});
