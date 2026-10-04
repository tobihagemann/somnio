import type { Placement } from '@somnio/protocol';
import { hashPassword } from '@somnio/data';
import type { SessionRepository } from '@somnio/data';
import type { AttemptLimiter } from '../../src/connection/attemptLimiter.ts';
import type { Logger } from '../../src/logging.ts';
import { makeCharacter, makeSector } from './sectorFactory.ts';
import { makeStubConnectionDependencies } from './stubDependencies.ts';
import { StubAccountRepository, StubCharacterRepository, makeAccount } from './stubRepositories.ts';

export interface OneSectorWorldOptions {
  sessions: SessionRepository;
  accountId?: string;
  characterName?: string;
  /** The character's persisted space; anything but the outdoor space or the starter sector is absent from the world. */
  characterSpace?: string;
  accounts?: StubAccountRepository;
  placements?: Placement[];
  logger?: Logger;
  attemptLimiter?: AttemptLimiter;
}

/** A world of one outdoor sector (`A`) holding one character: the minimum a join needs. */
export async function makeOneSectorWorld(options: OneSectorWorldOptions) {
  const accountId = options.accountId ?? crypto.randomUUID();
  const character = makeCharacter({ x: 5, z: 5 }, options.characterName ?? 'tester', options.characterSpace);
  const dependencies = await makeStubConnectionDependencies({
    sessions: options.sessions,
    sectors: [makeSector('A', { placements: options.placements ?? [] })],
    characters: new StubCharacterRepository(new Map([[accountId, [character]]])),
    ...(options.accounts === undefined ? {} : { accounts: options.accounts }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.attemptLimiter === undefined ? {} : { attemptLimiter: options.attemptLimiter }),
  });
  return { dependencies, accountId };
}

type AuthenticatedWorldOptions = Pick<OneSectorWorldOptions, 'sessions' | 'logger' | 'attemptLimiter'> & { name: string; password: string };

/** A one-sector world whose character belongs to an account a password login can reach. */
export async function makeAuthenticatedWorld({ name, password, ...world }: AuthenticatedWorldOptions) {
  const accountId = crypto.randomUUID();
  const account = makeAccount({ id: accountId, name, passwordHash: await hashPassword(password) });
  return makeOneSectorWorld({ ...world, accountId, characterName: name, accounts: new StubAccountRepository(new Map([[name, account]])) });
}
