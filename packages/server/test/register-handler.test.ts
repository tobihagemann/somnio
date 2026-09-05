import { describe, expect, it } from 'vitest';
import { REGISTER_RESULT, SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
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
  characterClass: 0,
  gender: 1,
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
    expect(await registerResult({ ...valid, passwordRepeat: 'other-password' }, repository)).toEqual([REGISTER_RESULT.failure]);
    expect(repository.requests).toEqual([]);
  });

  it('a short password fails', async () => {
    expect(await registerResult({ ...valid, password: 'short', passwordRepeat: 'short' })).toEqual([REGISTER_RESULT.failure]);
  });

  it('an empty nickname or email fails', async () => {
    expect(await registerResult({ ...valid, nickname: '' })).toEqual([REGISTER_RESULT.failure]);
    expect(await registerResult({ ...valid, email: '' })).toEqual([REGISTER_RESULT.failure]);
  });

  it('an over-cap nickname or email fails', async () => {
    const long = 'x'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxIdentifierUTF8Bytes + 1);
    expect(await registerResult({ ...valid, nickname: long })).toEqual([REGISTER_RESULT.failure]);
    expect(await registerResult({ ...valid, email: long })).toEqual([REGISTER_RESULT.failure]);
  });

  it('a malformed class or gender raw fails', async () => {
    expect(await registerResult({ ...valid, characterClass: 99 })).toEqual([REGISTER_RESULT.failure]);
    expect(await registerResult({ ...valid, gender: 7 })).toEqual([REGISTER_RESULT.failure]);
  });

  it('a mixed-script name returns nameNotAllowed', async () => {
    expect(await registerResult({ ...valid, nickname: 'Sаibot' })).toEqual([REGISTER_RESULT.nameNotAllowed]);
  });

  it('a unique-constraint race maps to nicknameExists', async () => {
    const repository = new RecordingRegistrationRepository();
    repository.failWithTaken = true;
    expect(await registerResult(valid, repository)).toEqual([REGISTER_RESULT.nicknameExists]);
    expect(repository.requests[0]).toMatchObject({
      name: 'Saibot',
      email: 'info@example.com',
      gender: 1,
      figure: 1,
    });
  });
});
