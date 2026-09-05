import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  PostgresAccountRepository,
  PostgresCharacterRepository,
  PostgresInventoryRepository,
  PostgresNPCDialogStateRepository,
  PostgresRegistrationRepository,
  PostgresSessionRepository,
  PostgresWorldClockRepository,
  assertQueryable,
  createDatabase,
  migrateToLatest,
  resolvePostgresConfiguration,
} from '@somnio/data'
import type { SomnioDatabase } from '@somnio/data'
import { resolveServerConfiguration } from '../config.ts'
import type { ConnectionDependencies } from '../connection/dependencies.ts'
import type { AdminDependencies } from '../handlers/adminDispatcher.ts'
import { createApp } from '../http/app.ts'
import { startServer } from '../http/server.ts'
import { PRODUCTION_LOG_MAX_ARCHIVES, PRODUCTION_LOG_MAX_BYTES, createLogging } from '../logging.ts'
import type { Logging } from '../logging.ts'
import { loadSectorCache, requireSectorsLoaded } from '../sectors/sectorCache.ts'
import { AITickService } from '../services/aiTickService.ts'
import { CheckpointService } from '../services/checkpointService.ts'
import { WorldClockService } from '../services/worldClockService.ts'
import { SERVER_VERSION } from '../version.ts'
import { WorldRouter } from '../world/worldRouter.ts'
import { pruneOrphanNPCDialogStates } from './orphanDialogPrune.ts'

/** The log directory is fixed relative to the working directory; the image's `WORKDIR` owns it. */
const LOGS_DIRECTORY = 'logs'
const SHUTDOWN_CAP_MS = 15_000

/** Test seams over the production boot: every optional field defaults to what `runServer` uses. */
export interface BootOptions {
  logging: Logging
  /** Overrides the configured port; `0` binds an ephemeral one. */
  port?: number
  serverVersion?: string
  worldClockIntervalMs?: number
  aiTickIntervalMs?: number
  checkpointIntervalMs?: number
}

export interface BootedServer {
  port: number
  db: SomnioDatabase
  worldRouter: WorldRouter
  worldClock: WorldClockService
  dependencies: ConnectionDependencies
  /** The reverse of the boot: services stop, connections drain, the server closes, the pool destroys. */
  shutdown(): Promise<void>
}

/**
 * The whole boot, in order: config → database → readiness → migrations → sectors → orphan-dialog
 * prune → router → synchronous world-clock preload → listen → services.
 */
export async function bootServer(
  env: Record<string, string | undefined>,
  options: BootOptions
): Promise<BootedServer> {
  const logging = options.logging
  const lifecycle = logging.serverLogger('lifecycle')
  const configuration = resolveServerConfiguration(env)
  const postgresConfiguration = resolvePostgresConfiguration(env, configuration.devDefaults)
  const db = createDatabase(postgresConfiguration, (error) =>
    lifecycle.warn({ error: String(error) }, 'postgres pool error')
  )
  const failStartup = async (error: unknown): Promise<never> => {
    lifecycle.error({ error: String(error) }, 'startup failed; shutting down')
    await db.destroy()
    throw error
  }
  try {
    await assertQueryable(db)
    await migrateToLatest(db)
  } catch (error) {
    return failStartup(error)
  }

  const sectorsLogger = logging.gameplayLogger('sectors.loader')
  let sectors: ReturnType<typeof loadSectorCache>
  try {
    sectors = loadSectorCache(configuration.sectorsDirectory)
    sectorsLogger.info({ count: sectors.size }, 'sector cache populated')
    requireSectorsLoaded(sectors, configuration.sectorsDirectory)
  } catch (error) {
    return failStartup(error)
  }

  const accounts = new PostgresAccountRepository(db)
  const characters = new PostgresCharacterRepository(db)
  const inventories = new PostgresInventoryRepository(db)
  const registrations = new PostgresRegistrationRepository(db)
  const npcDialogStates = new PostgresNPCDialogStateRepository(db)
  const worldClocks = new PostgresWorldClockRepository(db)
  const sessions = new PostgresSessionRepository(db)

  let worldRouter: WorldRouter
  let worldClock: WorldClockService
  try {
    // The prune runs before the router seeds from the table, so it never loads a cursor for an
    // NPC index the loaded sector no longer has.
    await pruneOrphanNPCDialogStates(
      npcDialogStates,
      sectors,
      configuration.forceDialogPrune,
      logging.adminLogger('dialogprune')
    )
    worldRouter = await WorldRouter.create(
      sectors,
      characters,
      npcDialogStates,
      logging.gameplayLogger('world'),
      logging.gameplayLogger('sector')
    )
    // Pre-loaded synchronously so a login in the first tick sees the persisted clock, not the default.
    worldClock = new WorldClockService(
      worldRouter,
      worldClocks,
      await worldClocks.load(),
      logging.gameplayLogger('worldclock'),
      options.worldClockIntervalMs
    )
  } catch (error) {
    return failStartup(error)
  }

  const dependencies: ConnectionDependencies = {
    accounts,
    characters,
    inventories,
    registrations,
    npcDialogStates,
    sessions,
    worldRouter,
    worldClock,
    outboxHighWatermark: configuration.outboxHighWatermark,
    logger: logging.gameplayLogger('connection'),
  }
  const adminDependencies: AdminDependencies = {
    worldRouter,
    worldClock,
    serverVersion: options.serverVersion ?? SERVER_VERSION,
    gameplayLog: logging.gameplayFile,
    adminLog: logging.adminFile,
    logger: logging.adminLogger('dispatch'),
  }
  let server: Awaited<ReturnType<typeof startServer>>
  try {
    server = await startServer({
      app: createApp({ db, healthLogger: logging.gameplayLogger('health') }),
      host: configuration.httpHost,
      port: options.port ?? configuration.httpPort,
      adminToken: configuration.adminToken,
      dependencies,
      adminDependencies,
      logger: logging.adminLogger('connection'),
    })
  } catch (error) {
    return failStartup(error)
  }

  const checkpoint = new CheckpointService(
    worldRouter,
    sessions,
    options.checkpointIntervalMs ?? configuration.checkpointIntervalMs,
    logging.gameplayLogger('checkpoint')
  )
  const aiTick = new AITickService(worldRouter, options.aiTickIntervalMs)
  const aiTickControl = new AbortController()
  const worldClockControl = new AbortController()
  const checkpointControl = new AbortController()
  const aiTickRun = aiTick.run(aiTickControl.signal)
  const worldClockRun = worldClock.run(worldClockControl.signal)
  const checkpointRun = checkpoint.run(checkpointControl.signal)
  lifecycle.info({ port: server.port, version: SERVER_VERSION }, 'SomnioServer ready')

  return {
    port: server.port,
    db,
    worldRouter,
    worldClock,
    dependencies,
    // The AI tick stops first so no in-flight tick contends with the drain; the world clock saves;
    // the checkpointer stops; the router drains every connection; then the server and the pool.
    shutdown: async () => {
      aiTickControl.abort()
      await aiTickRun
      lifecycle.debug('shutdown: ai tick stopped')
      worldClockControl.abort()
      await worldClockRun
      lifecycle.debug('shutdown: world clock saved')
      checkpointControl.abort()
      await checkpointRun
      lifecycle.debug('shutdown: checkpointer stopped')
      await worldRouter.drainAll()
      lifecycle.debug('shutdown: connections drained')
      await server.close()
      lifecycle.debug('shutdown: server closed')
      await db.destroy()
    },
  }
}

/** Boots, waits for SIGINT/SIGTERM, then shuts down under a 15 s cap. */
export async function runServer(env: Record<string, string | undefined>): Promise<void> {
  const logging = createLogging({
    directory: resolve(LOGS_DIRECTORY),
    maxBytes: PRODUCTION_LOG_MAX_BYTES,
    maxArchives: PRODUCTION_LOG_MAX_ARCHIVES,
  })
  const lifecycle = logging.serverLogger('lifecycle')
  const server = await bootServer(env, { logging })
  lifecycle.info('awaiting termination signal')

  await new Promise<void>((resolveSignal) => {
    const onSignal = (signal: NodeJS.Signals) => {
      lifecycle.info({ signal }, 'termination signal received')
      resolveSignal()
    }
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
  })

  await Promise.race([server.shutdown(), delay(SHUTDOWN_CAP_MS, undefined, { ref: false })])
  lifecycle.info('SomnioServer stopped')
}
