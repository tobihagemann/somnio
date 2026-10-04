import { describe, expect, it } from 'vitest';
import { SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import type { RegisterMessage } from '@somnio/protocol';
import { RegistrationError } from '@somnio/data';
import type { RegistrationRequest } from '@somnio/data';
import { ConnectionActor } from '../src/connection/connectionActor.ts';
import { handleRegister } from '../src/handlers/register.ts';
import { collectMessages } from './support/frames.ts';
import { makeStubConnectionDependencies } from './support/stubDependencies.ts';
import { StubRegistrationRepository } from './support/stubRepositories.ts';

class RecordingRegistrationRepository extends StubRegistrationRepository {
  readonly requests: RegistrationRequest[] = [];
  failWithTaken = false;

  override register(request: RegistrationRequest) {
    this.requests.push(request);
    if (this.failWithTaken) return Promise.reject(new RegistrationError());
    return Promise.reject(new Error('unused'));
  }
}

const valid: RegisterMessage = {
  nickname: 'Saibot',
  password: 'hunter2-long',
  passwordRepeat: 'hunter2-long',
  people: 'soporen',
  email: 'info@example.com',
};

async function registerResult(message: RegisterMessage, repository = new RecordingRegistrationRepository()) {
  const dependencies = { ...(await makeStubConnectionDependencies()), registrations: repository };
  const connection = new ConnectionActor(dependencies);
  await handleRegister(message, connection, dependencies);
  const messages = await collectMessages(connection.outbox);
  return messages.flatMap((frame) => (frame.tag === 'registerResult' ? [frame.payload.result] : []));
}

describe('handleRegister validation', () => {
  it('a mismatched password repeat fails before the repository', async () => {
    const repository = new RecordingRegistrationRepository();
    expect(await registerResult({ ...valid, passwordRepeat: 'other-password' }, repository)).toEqual(['failure']);
    expect(repository.requests).toEqual([]);
  });

  it('a short password fails', async () => {
    expect(await registerResult({ ...valid, password: 'short', passwordRepeat: 'short' })).toEqual(['failure']);
  });

  it('an empty nickname or email fails', async () => {
    expect(await registerResult({ ...valid, nickname: '' })).toEqual(['failure']);
    expect(await registerResult({ ...valid, email: '' })).toEqual(['failure']);
  });

  it('an over-cap nickname or email fails', async () => {
    const long = 'x'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxIdentifierUTF8Bytes + 1);
    expect(await registerResult({ ...valid, nickname: long })).toEqual(['failure']);
    expect(await registerResult({ ...valid, email: long })).toEqual(['failure']);
  });

  it.each([
    ['nickname', 'name'],
    ['email', 'email'],
  ] as const)('caps the %s in UTF-8 bytes: two-byte letters are refused one letter past the cap and reach the repository at it', async (field, stored) => {
    const letters = SOMNIO_PROTOCOL_CONSTANTS.maxIdentifierUTF8Bytes / 2;
    const refused = new RecordingRegistrationRepository();
    expect(await registerResult({ ...valid, [field]: 'ü'.repeat(letters + 1) }, refused)).toEqual(['failure']);
    expect(refused.requests).toEqual([]);
    const accepted = new RecordingRegistrationRepository();
    accepted.failWithTaken = true;
    expect(await registerResult({ ...valid, [field]: 'ü'.repeat(letters) }, accepted)).toEqual(['nicknameExists']);
    expect(accepted.requests.map((request) => request[stored])).toEqual(['ü'.repeat(letters)]);
  });

  it('an unknown people fails', async () => {
    expect(await registerResult({ ...valid, people: 'elves' })).toEqual(['failure']);
    expect(await registerResult({ ...valid, people: '' })).toEqual(['failure']);
  });

  it('a mixed-script name returns nameNotAllowed', async () => {
    expect(await registerResult({ ...valid, nickname: 'Sаibot' })).toEqual(['nameNotAllowed']);
  });

  it('a unique-constraint race maps to nicknameExists', async () => {
    const repository = new RecordingRegistrationRepository();
    repository.failWithTaken = true;
    expect(await registerResult(valid, repository)).toEqual(['nicknameExists']);
    expect(repository.requests[0]).toMatchObject({
      name: 'Saibot',
      email: 'info@example.com',
      people: 'soporen',
    });
  });
});
