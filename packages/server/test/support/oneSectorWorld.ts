import type { Placement } from '@somnio/protocol';
import type { SessionRepository } from '@somnio/data';
import type { Logger } from '../../src/logging.ts';
import { makeCharacter, makeSector } from './sectorFactory.ts';
import { makeStubConnectionDependencies } from './stubDependencies.ts';
import { StubCharacterRepository } from './stubRepositories.ts';
import type { StubAccountRepository } from './stubRepositories.ts';

export interface OneSectorWorldOptions {
  sessions: SessionRepository;
  accountId?: string;
  characterName?: string;
  /** The character's persisted space; anything but the outdoor space or the starter sector is absent from the world. */
  characterSpace?: string;
  accounts?: StubAccountRepository;
  placements?: Placement[];
  logger?: Logger;
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
  });
  return { dependencies, accountId };
}
