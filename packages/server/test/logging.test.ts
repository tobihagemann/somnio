import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ADMIN_LOG_FILE_NAME, GAMEPLAY_LOG_FILE_NAME, RotatingFile } from '../src/logging.ts'
import { tempLogging } from './support/tempLogging.ts'
import type { TempLogging } from './support/tempLogging.ts'

let logging: TempLogging | undefined
afterEach(() => {
  logging?.cleanup()
  logging = undefined
})

function fileText(directory: string, name: string): string {
  const path = join(directory, name)
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

describe('createLogging', () => {
  it('routes gameplay records to the gameplay file only, admin records to the admin file only, and both to stdout', () => {
    logging = tempLogging({ maxBytes: 1 << 20 })
    logging.gameplayLogger('sector').info('gameplay-record')
    logging.adminLogger('dispatch').info('admin-record')
    logging.serverLogger('lifecycle').info('server-record')
    const gameplay = fileText(logging.directory, GAMEPLAY_LOG_FILE_NAME)
    const admin = fileText(logging.directory, ADMIN_LOG_FILE_NAME)
    expect(gameplay).toContain('gameplay-record')
    expect(gameplay).not.toContain('admin-record')
    expect(gameplay).not.toContain('server-record')
    expect(admin).toContain('admin-record')
    expect(admin).not.toContain('gameplay-record')
    const stdout = logging.stdoutRecords.join('')
    expect(stdout).toContain('gameplay-record')
    expect(stdout).toContain('admin-record')
    expect(stdout).toContain('server-record')
  })

  it('debug records reach the files and stdout on every root', () => {
    logging = tempLogging({ maxBytes: 1 << 20 })
    logging.gameplayLogger('sector').debug('gameplay-debug')
    logging.adminLogger('dispatch').debug('admin-debug')
    logging.serverLogger('lifecycle').debug('server-debug')
    expect(fileText(logging.directory, GAMEPLAY_LOG_FILE_NAME)).toContain('gameplay-debug')
    expect(fileText(logging.directory, ADMIN_LOG_FILE_NAME)).toContain('admin-debug')
    const stdout = logging.stdoutRecords.join('')
    expect(stdout).toContain('gameplay-debug')
    expect(stdout).toContain('admin-debug')
    expect(stdout).toContain('server-debug')
  })

  it('labels carry the subsystem prefix', () => {
    logging = tempLogging({ maxBytes: 1 << 20 })
    logging.gameplayLogger('world').info('labelled')
    const record = JSON.parse(logging.stdoutRecords.at(-1)!) as { label: string }
    expect(record.label).toBe('de.tobiha.somnio.server.gameplay.world')
  })
})

describe('RotatingFile', () => {
  it('rotates at maxBytes keeping maxArchives archives', () => {
    logging = tempLogging()
    const file = new RotatingFile({
      directory: logging.directory,
      fileName: 'rotate.log',
      maxBytes: 100,
      maxArchives: 2,
    })
    for (let index = 0; index < 8; index += 1) file.write(`${'x'.repeat(60)}\n`)
    expect(existsSync(file.archivePath(1))).toBe(true)
    expect(existsSync(file.archivePath(2))).toBe(true)
    expect(existsSync(file.archivePath(3))).toBe(false)
    file.closeAndRemove()
  })

  it('closeAndRemove unlinks the active file and archives, and the next write reopens', () => {
    logging = tempLogging()
    const file = new RotatingFile({
      directory: logging.directory,
      fileName: 'again.log',
      maxBytes: 50,
      maxArchives: 1,
    })
    file.write('a'.repeat(60))
    file.write('b')
    expect(existsSync(file.archivePath(1))).toBe(true)
    expect(file.closeAndRemove()).toBe(true)
    expect(existsSync(file.path)).toBe(false)
    expect(existsSync(file.archivePath(1))).toBe(false)
    expect(file.closeAndRemove()).toBe(false)
    file.write('reopened')
    expect(readFileSync(file.path, 'utf8')).toBe('reopened')
    file.closeAndRemove()
  })
})
