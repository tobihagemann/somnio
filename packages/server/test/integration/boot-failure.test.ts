import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { bootTestServer, startDatabase } from './support/harness.ts'
import type { DatabaseHarness } from './support/harness.ts'

let harness: DatabaseHarness

beforeAll(async () => {
  harness = await startDatabase()
})
afterAll(async () => {
  await harness.stop()
})

/** The whole boot, not just the guard: an empty sector directory must refuse rather than serve an empty world. */
it('refuses to boot over a sector directory with no sector files', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'somnio-no-sectors-'))
  try {
    await expect(bootTestServer(harness.url, { sectorsDirectory: empty })).rejects.toThrow(
      /no sectors loaded/
    )
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})
