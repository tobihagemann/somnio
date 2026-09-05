import { readFileSync } from 'node:fs'
import { SOMNIO_PROTOCOL_CONSTANTS, utf8ByteLength } from '@somnio/protocol'
import type { AdminRequest, AdminResponse } from '@somnio/protocol'
import type { Logger, RotatingFile } from '../logging.ts'
import type { WorldClockService } from '../services/worldClockService.ts'
import type { AdminWorldRouter } from '../world/worldRouter.ts'

/** The file the `log`/`weblog` verbs read and `logRemove`/`weblogRemove` wipe. */
export type AdminLogFile = Pick<RotatingFile, 'path' | 'closeAndRemove'>

export interface AdminDependencies {
  worldRouter: AdminWorldRouter
  worldClock: WorldClockService
  serverVersion: string
  gameplayLog: AdminLogFile
  adminLog: AdminLogFile
  logger: Logger
}

/** A single admin reply stays a bounded frame: the trailing window of the log, on a character boundary. */
export const LOG_WIRE_LIMIT_BYTES = 65_535

/**
 * Stateless per-verb dispatch. Returns `undefined` only for the empty or over-cap `say`
 * (no broadcast, no response); every other verb answers.
 */
export function dispatchAdminRequest(
  request: AdminRequest,
  dependencies: AdminDependencies
): AdminResponse | undefined {
  switch (request.tag) {
    case 'log':
      return readLog(
        dependencies.gameplayLog,
        { tag: 'logEmpty' },
        (text) => ({ tag: 'logContents', payload: text }),
        dependencies.logger
      )
    case 'weblog':
      return readLog(
        dependencies.adminLog,
        { tag: 'weblogEmpty' },
        (text) => ({ tag: 'weblogContents', payload: text }),
        dependencies.logger
      )
    case 'logRemove':
      removeLog(dependencies.gameplayLog, dependencies.logger)
      return { tag: 'logRemoved' }
    case 'weblogRemove':
      removeLog(dependencies.adminLog, dependencies.logger)
      return { tag: 'weblogRemoved' }
    case 'players':
      return { tag: 'playerCount', payload: String(dependencies.worldRouter.loggedInPlayerCount()) }
    case 'time': {
      const clock = dependencies.worldClock.currentTime()
      const pad = (value: number) => String(value).padStart(2, '0')
      return {
        tag: 'worldClock',
        payload: `${clock.year};${clock.month};${clock.day};${pad(clock.hour)};${pad(clock.minute)};${pad(clock.second)}`,
      }
    }
    case 'say': {
      const text = request.payload
      if (text.length === 0 || utf8ByteLength(text) > SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes)
        return undefined
      dependencies.worldRouter.broadcastToAllConnections({ tag: 'adminSay', payload: { text } })
      return { tag: 'sayBroadcast', payload: text }
    }
    case 'kick': {
      const name = request.payload
      return dependencies.worldRouter.kickByCharacterName(name)
        ? { tag: 'kickedPlayer', payload: name }
        : { tag: 'kickedPlayerNotFound', payload: name }
    }
    case 'version':
      return { tag: 'versionString', payload: dependencies.serverVersion }
  }
}

function readLog(
  file: AdminLogFile,
  emptyResponse: AdminResponse,
  contentsResponse: (text: string) => AdminResponse,
  logger: Logger
): AdminResponse {
  let bytes: Buffer
  try {
    bytes = readFileSync(file.path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn({ error: String(error), file: file.path }, 'admin log read failed; reporting empty')
    }
    return emptyResponse
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    logger.warn({ file: file.path }, 'admin log read returned non-UTF-8 bytes; reporting empty')
    return emptyResponse
  }
  if (text.length === 0) return emptyResponse
  return contentsResponse(truncateToWireLimit(text))
}

function removeLog(file: AdminLogFile, logger: Logger): void {
  if (!file.closeAndRemove())
    logger.debug({ file: file.path }, 'admin log close-and-remove reported no file removed')
}

/**
 * Keeps the trailing `LOG_WIRE_LIMIT_BYTES` UTF-8 window (operators read log tails), walking the
 * cut forward to the next character boundary so a multi-byte sequence is never split.
 */
export function truncateToWireLimit(text: string): string {
  const encoded = Buffer.from(text, 'utf8')
  if (encoded.length <= LOG_WIRE_LIMIT_BYTES) return text
  let cut = encoded.length - LOG_WIRE_LIMIT_BYTES
  // 0b10xxxxxx marks a continuation byte; advance to a lead byte.
  while (cut < encoded.length && (encoded[cut]! & 0xc0) === 0x80) cut += 1
  return encoded.subarray(cut).toString('utf8')
}
