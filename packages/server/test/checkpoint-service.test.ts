import { describe, expect, it, vi } from 'vitest'
import { CheckpointService } from '../src/services/checkpointService.ts'
import { makeStubConnectionDependencies } from './support/stubDependencies.ts'
import { RepositoryFailure, StubSessionRepository } from './support/stubRepositories.ts'

class SweepRecorder extends StubSessionRepository {
  sweeps = 0
  private readonly fail: boolean

  constructor(fail = false) {
    super()
    this.fail = fail
  }

  override deleteExpired(asOf: Date): Promise<number> {
    this.sweeps += 1
    if (this.fail) return Promise.reject(new RepositoryFailure())
    return super.deleteExpired(asOf)
  }
}

async function runPasses(sessions: SweepRecorder, passes: number) {
  const dependencies = await makeStubConnectionDependencies({ sessions })
  const checkpointAll = vi.spyOn(dependencies.worldRouter, 'checkpointAll')
  const controller = new AbortController()
  const service = new CheckpointService(dependencies.worldRouter, sessions, 5, dependencies.logger)
  const run = service.run(controller.signal)
  await vi.waitFor(() => expect(sessions.sweeps).toBeGreaterThanOrEqual(passes))
  controller.abort()
  await run
  return checkpointAll
}

describe('CheckpointService', () => {
  it('checkpoints every player and sweeps expired sessions on each pass', async () => {
    const sessions = new SweepRecorder()
    const checkpointAll = await runPasses(sessions, 2)
    expect(checkpointAll.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(checkpointAll.mock.calls.length).toBe(sessions.sweeps)
  })

  it('a failing sweep is logged and the timer keeps running', async () => {
    const sessions = new SweepRecorder(true)
    const checkpointAll = await runPasses(sessions, 3)
    expect(checkpointAll.mock.calls.length).toBeGreaterThanOrEqual(3)
  })
})
