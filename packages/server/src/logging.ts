import { closeSync, fstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import pino from 'pino'
import type { Logger } from 'pino'

export type { Logger }

/**
 * Three logger roots, chosen at the call site the way each subsystem chooses its label: server
 * records go to stdout only, gameplay records additionally to `gameplay-log.log`, admin records
 * additionally to `admin-log.log`. The label keeps the `de.tobiha.somnio.server[.gameplay|.admin]
 * .<category>` shape so stdout stays greppable by subsystem.
 */
export interface Logging {
  serverLogger(category: string): Logger
  gameplayLogger(category: string): Logger
  adminLogger(category: string): Logger
  readonly gameplayFile: RotatingFile
  readonly adminFile: RotatingFile
}

export interface LoggingOptions {
  directory: string
  maxBytes: number
  maxArchives: number
  /** Replaces stdout; tests capture records here. */
  stdout?: { write(chunk: string): unknown }
}

export const GAMEPLAY_LOG_FILE_NAME = 'gameplay-log.log'
export const ADMIN_LOG_FILE_NAME = 'admin-log.log'
export const PRODUCTION_LOG_MAX_BYTES = 5 * 1024 * 1024
export const PRODUCTION_LOG_MAX_ARCHIVES = 5

export function createLogging(options: LoggingOptions): Logging {
  const stdout = options.stdout ?? process.stdout
  const gameplayFile = new RotatingFile({
    directory: options.directory,
    fileName: GAMEPLAY_LOG_FILE_NAME,
    maxBytes: options.maxBytes,
    maxArchives: options.maxArchives,
  })
  const adminFile = new RotatingFile({
    directory: options.directory,
    fileName: ADMIN_LOG_FILE_NAME,
    maxBytes: options.maxBytes,
    maxArchives: options.maxArchives,
  })
  // Each multistream destination carries its own threshold (default `info`), so the logger's
  // `debug` level alone would still drop every debug record.
  const level = 'debug'
  const server = pino({ level }, stdout)
  const gameplay = pino(
    { level },
    pino.multistream([
      { level, stream: stdout },
      { level, stream: gameplayFile },
    ])
  )
  const admin = pino(
    { level },
    pino.multistream([
      { level, stream: stdout },
      { level, stream: adminFile },
    ])
  )
  return {
    serverLogger: (category) => server.child({ label: `de.tobiha.somnio.server.${category}` }),
    gameplayLogger: (category) => gameplay.child({ label: `de.tobiha.somnio.server.gameplay.${category}` }),
    adminLogger: (category) => admin.child({ label: `de.tobiha.somnio.server.admin.${category}` }),
    gameplayFile,
    adminFile,
  }
}

export interface RotatingFileOptions {
  directory: string
  fileName: string
  maxBytes: number
  maxArchives: number
}

/**
 * A size-rotated append-only log file. Writes are synchronous so records land in emission order;
 * rotation at `maxBytes` keeps `maxArchives` archives named `<base>.<n>.<ext>`. `closeAndRemove`
 * closes and unlinks the current file plus every archive in one step — the admin `logRemove`
 * path — and the next write reopens lazily.
 */
export class RotatingFile {
  readonly path: string
  private readonly directory: string
  private readonly fileName: string
  private readonly maxBytes: number
  private readonly maxArchives: number
  private descriptor: number | undefined

  constructor(options: RotatingFileOptions) {
    this.directory = options.directory
    this.fileName = options.fileName
    this.maxBytes = options.maxBytes
    this.maxArchives = options.maxArchives
    this.path = join(options.directory, options.fileName)
  }

  write(chunk: string): boolean {
    const descriptor = this.ensureOpen()
    writeSync(descriptor, chunk)
    if (fstatSync(descriptor).size >= this.maxBytes) this.rotate()
    return true
  }

  /** Whether the active file was unlinked; archive deletions are best-effort. */
  closeAndRemove(): boolean {
    if (this.descriptor !== undefined) {
      closeSync(this.descriptor)
      this.descriptor = undefined
    }
    let activeRemoved = false
    try {
      unlinkSync(this.path)
      activeRemoved = true
    } catch {
      // Already gone, or not removable; either way there is nothing more to do here.
    }
    for (let index = 1; index <= this.maxArchives; index += 1) {
      try {
        unlinkSync(this.archivePath(index))
      } catch {
        // The chain may be partially rotated; wipe what exists.
      }
    }
    return activeRemoved
  }

  archivePath(index: number): string {
    const extension = extname(this.fileName)
    const base = basename(this.fileName, extension)
    return join(this.directory, `${base}.${index}${extension}`)
  }

  private ensureOpen(): number {
    if (this.descriptor !== undefined) return this.descriptor
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    this.descriptor = openSync(this.path, 'a', 0o600)
    return this.descriptor
  }

  /** Each step tolerates an absent file: `closeAndRemove` may have unlinked part of the chain. */
  private rotate(): void {
    if (this.descriptor !== undefined) closeSync(this.descriptor)
    this.descriptor = undefined
    ignoringMissing(() => unlinkSync(this.archivePath(this.maxArchives)))
    for (let index = this.maxArchives - 1; index >= 1; index -= 1) {
      ignoringMissing(() => renameSync(this.archivePath(index), this.archivePath(index + 1)))
    }
    ignoringMissing(() => renameSync(this.path, this.archivePath(1)))
  }
}

function ignoringMissing(operation: () => void): void {
  try {
    operation()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
