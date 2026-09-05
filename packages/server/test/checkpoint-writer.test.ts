import { describe, expect, it } from 'vitest'
import { persistPlayerCheckpoint } from '../src/world/checkpointWriter.ts'
import { testLogger } from './support/logger.ts'
import { makeCharacter } from './support/sectorFactory.ts'
import { RepositoryFailure, StubCharacterRepository } from './support/stubRepositories.ts'

class FailingCharacterRepository extends StubCharacterRepository {
  attempts = 0

  override persistCheckpoint(): Promise<boolean> {
    this.attempts += 1
    return Promise.reject(new RepositoryFailure())
  }
}

describe('persistPlayerCheckpoint', () => {
  it('logs and swallows a failed write so the periodic pass continues past it', async () => {
    const characters = new FailingCharacterRepository()
    const snapshot = { character: makeCharacter({ x: 1, y: 1 }), inventory: [] }
    await expect(persistPlayerCheckpoint(snapshot, characters, testLogger())).resolves.toBeUndefined()
    expect(characters.attempts).toBe(1)
  })
})
