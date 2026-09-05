import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogging } from '../../src/logging.ts'
import type { Logging } from '../../src/logging.ts'

export interface TempLogging extends Logging {
  directory: string
  /** Every record written to the stdout replacement, in order. */
  stdoutRecords: string[]
  cleanup(): void
}

/** `createLogging` over a per-test temp directory with a small rotation size. */
export function tempLogging(options: { maxBytes?: number; maxArchives?: number } = {}): TempLogging {
  const directory = mkdtempSync(join(tmpdir(), 'somnio-logging-'))
  const stdoutRecords: string[] = []
  const logging = createLogging({
    directory,
    maxBytes: options.maxBytes ?? 4096,
    maxArchives: options.maxArchives ?? 2,
    stdout: {
      write: (chunk: string) => {
        stdoutRecords.push(chunk)
      },
    },
  })
  return {
    ...logging,
    directory,
    stdoutRecords,
    cleanup: () => {
      logging.gameplayFile.closeAndRemove()
      logging.adminFile.closeAndRemove()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}
