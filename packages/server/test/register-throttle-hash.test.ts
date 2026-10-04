import { beforeEach, expect, it, vi } from 'vitest';
import type { RegisterResult } from '@somnio/protocol';
import { hashPassword } from '@somnio/data';
import type * as Data from '@somnio/data';
import { ConnectionActor } from '../src/connection/connectionActor.ts';
import type { ConnectionDependencies } from '../src/connection/dependencies.ts';
import { handleRegister } from '../src/handlers/register.ts';
import { VALID_REGISTER_MESSAGE, collectMessages, registerResults } from './support/frames.ts';
import { enabledAttemptLimiter, makeStubConnectionDependencies } from './support/stubDependencies.ts';

vi.mock('@somnio/data', async (importOriginal) => {
  const original = await importOriginal<typeof Data>();
  return { ...original, hashPassword: vi.fn(original.hashPassword) };
});

const ADDRESS = '203.0.113.7';

beforeEach(() => {
  vi.mocked(hashPassword).mockClear();
});

async function register(dependencies: ConnectionDependencies, address: string): Promise<RegisterResult[]> {
  const connection = new ConnectionActor(dependencies, address);
  await handleRegister(VALID_REGISTER_MESSAGE, connection, dependencies);
  return registerResults(await collectMessages(connection.outbox));
}

/**
 * The limit exists to keep an address from buying Argon2id hashes, and the answer alone does not
 * show which side of the hash the refusal sits on.
 */
it('refuses a throttled registration before hashing its password', async () => {
  const limiter = enabledAttemptLimiter();
  const dependencies = await makeStubConnectionDependencies({ attemptLimiter: limiter });

  await register(dependencies, '203.0.113.8');
  expect(vi.mocked(hashPassword)).toHaveBeenCalledTimes(1);

  for (let attempt = 0; attempt < 10; attempt += 1) limiter.admit('registration', ADDRESS);
  expect(await register(dependencies, ADDRESS)).toEqual(['throttled']);
  expect(vi.mocked(hashPassword)).toHaveBeenCalledTimes(1);
});

/** A hash that fails has still been started, which is the cost the budget meters. */
it('keeps a registration spent when its hash fails', async () => {
  const dependencies = await makeStubConnectionDependencies({ attemptLimiter: enabledAttemptLimiter() });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    vi.mocked(hashPassword).mockRejectedValueOnce(new Error('rigged hash failure'));
    expect(await register(dependencies, ADDRESS)).toEqual(['failure']);
  }
  expect(vi.mocked(hashPassword)).toHaveBeenCalledTimes(10);
  expect(await register(dependencies, ADDRESS)).toEqual(['throttled']);
});
