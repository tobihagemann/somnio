import { expect, it } from 'vitest'
import { AITickService } from '../src/services/aiTickService.ts'
import { makeStubConnectionDependencies } from './support/stubDependencies.ts'

it('an aborted signal ends run() cleanly', async () => {
  const dependencies = await makeStubConnectionDependencies()
  const service = new AITickService(dependencies.worldRouter, 5)
  const control = new AbortController()
  const run = service.run(control.signal)
  await new Promise((resolve) => setTimeout(resolve, 20))
  control.abort()
  await expect(run).resolves.toBeUndefined()
})
