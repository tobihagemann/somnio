import { LOGIN_RESULT, REGISTER_RESULT, encodeSomnioMessage } from '@somnio/protocol'
import type { SomnioMessage } from '@somnio/protocol'
import { SOMNIO_CONSTANTS, feetRect, isFeetClear } from '@somnio/core'
import type { GridPoint, PixelRect, Sector } from '@somnio/core'
import {
  PostgresAccountRepository,
  PostgresCharacterRepository,
  PostgresInventoryRepository,
  PostgresNPCDialogStateRepository,
  PostgresRegistrationRepository,
  PostgresSessionRepository,
  PostgresWorldClockRepository,
} from '@somnio/data'
import type { SomnioDatabase } from '@somnio/data'
import { startDatabase } from '../../../../data/test/integration/support/harness.ts'
import type { DatabaseHarness } from '../../../../data/test/integration/support/harness.ts'
import { bootServer } from '../../../src/bootstrap/runServer.ts'
import type { BootOptions, BootedServer } from '../../../src/bootstrap/runServer.ts'
import { DEV_SECTORS_DIRECTORY } from '../../../src/config.ts'
import type { ConnectionDependencies } from '../../../src/connection/dependencies.ts'
import { loadSectorCache } from '../../../src/sectors/sectorCache.ts'
import { WorldClockService } from '../../../src/services/worldClockService.ts'
import { WorldRouter } from '../../../src/world/worldRouter.ts'
import { TestClient } from '../../support/liveServer.ts'
import { testLogger } from '../../support/logger.ts'
import { tempLogging } from '../../support/tempLogging.ts'
import type { TempLogging } from '../../support/tempLogging.ts'

export { startDatabase }
export type { DatabaseHarness }

export const TEST_ADMIN_TOKEN = 'secret'
export const TEST_SERVER_VERSION = 'test-version'
export const TEST_PASSWORD = 'secret-pass'

export interface TestServer {
  server: BootedServer
  logging: TempLogging
  url: string
  adminUrl: string
  healthUrl: string
  stop(): Promise<void>
}

/** The production boot over the fixture sectors and a throwaway database, on an ephemeral port. */
export async function bootTestServer(
  databaseUrl: string,
  options: Omit<BootOptions, 'logging' | 'port'> & { sectorsDirectory?: string } = {}
): Promise<TestServer> {
  const logging = tempLogging({ maxBytes: 1 << 20 })
  const { sectorsDirectory, ...boot } = options
  const server = await bootServer(
    {
      SOMNIO_DATABASE_URL: databaseUrl,
      SOMNIO_DATABASE_TLS: 'disable',
      SOMNIO_ADMIN_TOKEN: TEST_ADMIN_TOKEN,
      SOMNIO_SECTORS_DIR: sectorsDirectory ?? DEV_SECTORS_DIRECTORY,
      SOMNIO_HTTP_HOST: '127.0.0.1',
    },
    { ...boot, logging, port: 0, serverVersion: options.serverVersion ?? TEST_SERVER_VERSION }
  )
  return {
    server,
    logging,
    url: `ws://127.0.0.1:${server.port}/ws`,
    adminUrl: `ws://127.0.0.1:${server.port}/admin`,
    healthUrl: `http://127.0.0.1:${server.port}/health`,
    stop: async () => {
      await server.shutdown()
      logging.cleanup()
    },
  }
}

/** Real repositories over `db` plus a router over the fixture sectors, for handler-level suites. */
export async function makeDatabaseDependencies(db: SomnioDatabase): Promise<ConnectionDependencies> {
  const logger = testLogger()
  const characters = new PostgresCharacterRepository(db)
  const npcDialogStates = new PostgresNPCDialogStateRepository(db)
  const worldClocks = new PostgresWorldClockRepository(db)
  const worldRouter = await WorldRouter.create(fixtureSectors(), characters, npcDialogStates, logger)
  return {
    accounts: new PostgresAccountRepository(db),
    characters,
    inventories: new PostgresInventoryRepository(db),
    registrations: new PostgresRegistrationRepository(db),
    npcDialogStates,
    sessions: new PostgresSessionRepository(db),
    worldRouter,
    worldClock: new WorldClockService(worldRouter, worldClocks, await worldClocks.load(), logger),
    outboxHighWatermark: 1024,
    logger,
  }
}

export function fixtureSectors(): Map<string, Sector> {
  return loadSectorCache(DEV_SECTORS_DIRECTORY)
}

export function uniqueNickname(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 6)}`
}

export function frame(message: SomnioMessage): string {
  return encodeSomnioMessage(message)
}

export function registerFrame(nickname: string, password = TEST_PASSWORD): string {
  return frame({
    tag: 'register',
    payload: {
      nickname,
      password,
      passwordRepeat: password,
      characterClass: 0,
      gender: 0,
      email: `${nickname}@example.invalid`,
    },
  })
}

/** Registers over the wire on a throwaway socket. */
async function registerOverWire(url: string, nickname: string, password = TEST_PASSWORD): Promise<void> {
  const client = await TestClient.open(url)
  await client.next()
  client.send(registerFrame(nickname, password))
  const { target } = await client.until('registerResult')
  if (target.tag !== 'registerResult' || target.payload.result !== REGISTER_RESULT.ok) {
    throw new Error(`registration of ${nickname} failed: ${JSON.stringify(target)}`)
  }
  await client.close()
}

export interface JoinedClient {
  client: TestClient
  /** `loginResult` through the closing `dateTick`, in order. */
  join: SomnioMessage[]
  entityIndex: number
}

/** Logs in over the wire and drains the join sequence. */
export async function loginOverWire(
  url: string,
  nickname: string,
  options: { password?: string; requestSessionToken?: boolean } = {}
): Promise<JoinedClient> {
  const client = await TestClient.open(url)
  await client.next()
  client.send(
    frame({
      tag: 'login',
      payload:
        options.requestSessionToken === undefined
          ? { nickname, password: options.password ?? TEST_PASSWORD }
          : {
              nickname,
              password: options.password ?? TEST_PASSWORD,
              requestSessionToken: options.requestSessionToken,
            },
    })
  )
  const login = await client.until('loginResult')
  if (login.target.tag !== 'loginResult' || login.target.payload.result !== LOGIN_RESULT.ok) {
    throw new Error(`login of ${nickname} failed: ${JSON.stringify(login.target)}`)
  }
  const { target, before } = await client.until('dateTick')
  const join = [login.target, ...before, target]
  const main = join.find((message) => message.tag === 'mainCharacter')
  if (main?.tag !== 'mainCharacter') throw new Error('join carried no mainCharacter')
  return { client, join, entityIndex: main.payload.entityIndex }
}

/** Registers and logs in a fresh player. */
export async function joinFreshPlayer(
  url: string,
  prefix: string
): Promise<JoinedClient & { nickname: string }> {
  const nickname = uniqueNickname(prefix)
  await registerOverWire(url, nickname)
  return { nickname, ...(await loginOverWire(url, nickname)) }
}

/** The player's own spawn from its join sequence. */
export function selfPosition(joined: JoinedClient): GridPoint {
  const self = joined.join.find(
    (message) => message.tag === 'entity' && message.payload.entityIndex === joined.entityIndex
  )
  if (self?.tag !== 'entity') throw new Error('join carried no self entity')
  return { x: self.payload.x, y: self.payload.y }
}

/**
 * The clear player origin on the 4 px grid nearest `center` (within `radius` of the feet
 * center when given), validated with the server's own feet-box gate against `blockers`.
 */
export function nearestClearOrigin(
  sector: Sector,
  center: { x: number; y: number },
  blockers: readonly PixelRect[],
  radius = Number.POSITIVE_INFINITY
): GridPoint | undefined {
  const sprite = SOMNIO_CONSTANTS.playerSpriteSize
  let best: GridPoint | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (let y = 0; y < sector.dimensions.height * SOMNIO_CONSTANTS.tileSize; y += 4) {
    for (let x = 0; x < sector.dimensions.width * SOMNIO_CONSTANTS.tileSize; x += 4) {
      const candidate = { x, y }
      const feet = feetRect(candidate, sprite)
      const feetCenter = { x: feet.x + feet.width / 2, y: feet.y + feet.height / 2 }
      const distance = Math.hypot(feetCenter.x - center.x, feetCenter.y - center.y)
      if (distance > radius || distance >= bestDistance) continue
      if (!isFeetClear(candidate, sprite, sector, blockers)) continue
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Polls `probe` until it returns a value, failing after `timeoutMs`. */
export async function pollUntil<T>(probe: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== undefined) return value
    await sleep(50)
  }
  throw new Error('condition not met within the timeout')
}

/** Closes a joined client and waits until the server has unregistered it, so a re-login is not answered `alreadyLoggedIn`. */
export async function closeAndAwaitCleanup(joined: JoinedClient, server: TestServer): Promise<void> {
  const before = server.server.worldRouter.loggedInPlayerCount()
  await joined.client.close()
  await pollUntil(() =>
    Promise.resolve(server.server.worldRouter.loggedInPlayerCount() < before ? true : undefined)
  )
}
