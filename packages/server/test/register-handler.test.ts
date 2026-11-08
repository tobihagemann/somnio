import { describe, expect, it } from 'vitest';
import { SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import type { RegisterMessage } from '@somnio/protocol';
import { EmailTakenError } from '@somnio/data';
import { ConnectionActor } from '../src/connection/connectionActor.ts';
import { handleRegister } from '../src/handlers/register.ts';
import { VALID_REGISTER_MESSAGE, collectMessages, registerResults } from './support/frames.ts';
import { makeStubConnectionDependencies } from './support/stubDependencies.ts';
import { StubAccountRepository } from './support/stubRepositories.ts';

class RecordingAccountRepository extends StubAccountRepository {
  readonly requests: { email: string; passwordHash: string }[] = [];
  failWithTaken = false;

  override create(email: string, passwordHash: string) {
    this.requests.push({ email, passwordHash });
    if (this.failWithTaken) return Promise.reject(new EmailTakenError());
    return Promise.reject(new Error('unused'));
  }
}

const valid = VALID_REGISTER_MESSAGE;

async function registerResult(message: RegisterMessage, repository = new RecordingAccountRepository()) {
  const dependencies = await makeStubConnectionDependencies({ accounts: repository });
  const connection = new ConnectionActor(dependencies);
  await handleRegister(message, connection, dependencies);
  return registerResults(await collectMessages(connection.outbox));
}

describe('handleRegister validation', () => {
  it('a mismatched password repeat fails before the repository', async () => {
    const repository = new RecordingAccountRepository();
    expect(await registerResult({ ...valid, passwordRepeat: 'other-password' }, repository)).toEqual(['failure']);
    expect(repository.requests).toEqual([]);
  });

  it('a short password fails', async () => {
    expect(await registerResult({ ...valid, password: 'short', passwordRepeat: 'short' })).toEqual(['failure']);
  });

  it.each([
    '',
    'info',
    'info@example',
    '@example.com',
    'info@example.',
    'info@.com',
    'in fo@example.com',
    'info@ex@ample.com',
    'in\u0001fo@example.com',
    'in\uD800fo@example.com',
  ])('%j is not an email address and fails before the repository', async (email) => {
    const repository = new RecordingAccountRepository();
    expect(await registerResult({ ...valid, email }, repository)).toEqual(['failure']);
    expect(repository.requests).toEqual([]);
  });

  it('caps the email in UTF-8 bytes: two-byte letters are refused one letter past the cap and reach the repository at it', async () => {
    const domain = '@ex.de';
    const letters = (SOMNIO_PROTOCOL_CONSTANTS.maxIdentifierUTF8Bytes - domain.length) / 2;
    const refused = new RecordingAccountRepository();
    expect(await registerResult({ ...valid, email: `${'ü'.repeat(letters + 1)}${domain}` }, refused)).toEqual(['failure']);
    expect(refused.requests).toEqual([]);
    const accepted = new RecordingAccountRepository();
    accepted.failWithTaken = true;
    expect(await registerResult({ ...valid, email: `${'ü'.repeat(letters)}${domain}` }, accepted)).toEqual(['emailExists']);
    expect(accepted.requests.map((request) => request.email)).toEqual([`${'ü'.repeat(letters)}${domain}`]);
  });

  it('a unique-constraint race maps to emailExists', async () => {
    const repository = new RecordingAccountRepository();
    repository.failWithTaken = true;
    expect(await registerResult(valid, repository)).toEqual(['emailExists']);
    expect(repository.requests[0]).toMatchObject({ email: 'info@example.com' });
  });
});
