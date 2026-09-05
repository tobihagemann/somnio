import type { SectorObject } from '@somnio/core'
import type { SessionRepository } from '@somnio/data'
import type { Logger } from '../../src/logging.ts'
import { makeCharacter, makeSector } from './sectorFactory.ts'
import { makeStubConnectionDependencies } from './stubDependencies.ts'
import { StubCharacterRepository } from './stubRepositories.ts'
import type { StubAccountRepository } from './stubRepositories.ts'

export interface OneSectorWorldOptions {
  sessions: SessionRepository
  accountId?: string
  characterName?: string
  /** The character's persisted sector; anything but `A` is absent from the cache. */
  characterSector?: string
  accounts?: StubAccountRepository
  objects?: SectorObject[]
  logger?: Logger
}

/** A one-sector world (`A`) holding one character: the minimum a join needs to get past both guards. */
export async function makeOneSectorWorld(options: OneSectorWorldOptions) {
  const accountId = options.accountId ?? crypto.randomUUID()
  const character = makeCharacter(
    { x: 64, y: 64 },
    options.characterName ?? 'tester',
    options.characterSector ?? 'A'
  )
  const dependencies = await makeStubConnectionDependencies({
    sessions: options.sessions,
    sectors: new Map([['A', makeSector('A', { objects: options.objects ?? [] })]]),
    characters: new StubCharacterRepository(new Map([[accountId, [character]]])),
    ...(options.accounts === undefined ? {} : { accounts: options.accounts }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  })
  return { dependencies, accountId }
}
