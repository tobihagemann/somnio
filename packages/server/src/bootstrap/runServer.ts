import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import registryJSON from '@somnio/core/data/ModelRegistry.json' with { type: 'json' };
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
} from '@somnio/data';
import type { SomnioDatabase } from '@somnio/data';
import { resolveServerConfiguration } from '../config.ts';
import { AttemptLimiter } from '../connection/attemptLimiter.ts';
import type { ConnectionDependencies } from '../connection/dependencies.ts';
import type { AdminDependencies } from '../handlers/adminDispatcher.ts';
import { createApp } from '../http/app.ts';
import { startServer } from '../http/server.ts';
import { PRODUCTION_LOG_MAX_ARCHIVES, PRODUCTION_LOG_MAX_BYTES, createLogging } from '../logging.ts';
import type { Logging } from '../logging.ts';
import { loadSectorCache, loadWorld, requireSectorsLoaded } from '../sectors/sectorCache.ts';
import type { LoadedWorld } from '../sectors/sectorCache.ts';
import { CheckpointService } from '../services/checkpointService.ts';
import { SimulationService } from '../services/simulationService.ts';
import { WorldClockService } from '../services/worldClockService.ts';
import { SERVER_VERSION } from '../version.ts';
import { WorldRouter } from '../world/worldRouter.ts';

/** The log directory is fixed relative to the working directory; the image's `WORKDIR` owns it. */
const LOGS_DIRECTORY = 'logs';
const SHUTDOWN_CAP_MS = 15_000;

/** Test seams over the production boot: every optional field defaults to what `runServer` uses. */
export interface BootOptions {
  logging: Logging;
  /** Overrides the configured port; `0` binds an ephemeral one. */
  port?: number;
  serverVersion?: string;
  worldClockIntervalMs?: number;
  simulationIntervalMs?: number;
  checkpointIntervalMs?: number;
}

export interface BootedServer {
  port: number;
  db: SomnioDatabase;
  worldRouter: WorldRouter;
  worldClock: WorldClockService;
  dependencies: ConnectionDependencies;
  /** The reverse of the boot: services stop, connections drain, the server closes, the pool destroys. */
  shutdown(): Promise<void>;
}

/**
 * The whole boot, in order: config → database → readiness → migrations → sectors → world →
 * router → synchronous world-clock preload → listen → services.
 */
export async function bootServer(env: Record<string, string | undefined>, options: BootOptions): Promise<BootedServer> {
  const logging = options.logging;
  const lifecycle = logging.serverLogger('lifecycle');
  const configuration = resolveServerConfiguration(env);
  const postgresConfiguration = resolvePostgresConfiguration(env, configuration.devDefaults);
  const db = createDatabase(postgresConfiguration, (error) => lifecycle.warn({ error: String(error) }, 'postgres pool error'));
  const failStartup = async (error: unknown): Promise<never> => {
    lifecycle.error({ error: String(error) }, 'startup failed; shutting down');
    await db.destroy();
    throw error;
  };
  try {
    await assertQueryable(db);
    await migrateToLatest(db);
  } catch (error) {
    return failStartup(error);
  }

  const sectorsLogger = logging.gameplayLogger('sectors.loader');
  let world: LoadedWorld;
  try {
    const sectors = loadSectorCache(configuration.sectorsDirectory);
    sectorsLogger.info({ count: sectors.size }, 'sector cache populated');
    requireSectorsLoaded(sectors, configuration.sectorsDirectory);
    world = loadWorld(sectors, registryJSON);
    for (const issue of world.issues) {
      sectorsLogger.error({ sector: issue.sector, record: issue.record, id: issue.id, issue: issue.message }, 'world issue');
    }
  } catch (error) {
    return failStartup(error);
  }

  const accounts = new PostgresAccountRepository(db);
  const characters = new PostgresCharacterRepository(db);
  const inventories = new PostgresInventoryRepository(db);
  const registrations = new PostgresRegistrationRepository(db);
  const npcDialogStates = new PostgresNPCDialogStateRepository(db);
  const worldClocks = new PostgresWorldClockRepository(db);
  const sessions = new PostgresSessionRepository(db);

  let worldRouter: WorldRouter;
  let worldClock: WorldClockService;
  try {
    worldRouter = await WorldRouter.create(world, characters, npcDialogStates, logging.gameplayLogger('world'), logging.gameplayLogger('space'));
    // Pre-loaded synchronously so a login in the first tick sees the persisted clock, not the default.
    worldClock = new WorldClockService(worldClocks, await worldClocks.load(), logging.gameplayLogger('worldclock'), options.worldClockIntervalMs);
  } catch (error) {
    return failStartup(error);
  }

  const preloginLogger = logging.gameplayLogger('prelogin');
  const dependencies: ConnectionDependencies = {
    accounts,
    characters,
    inventories,
    registrations,
    npcDialogStates,
    sessions,
    worldRouter,
    worldClock,
    attemptLimiter: new AttemptLimiter({ enabled: configuration.preloginLimit !== 'off', logger: preloginLogger }),
    outboxHighWatermark: configuration.outboxHighWatermark,
    logger: logging.gameplayLogger('connection'),
  };
  const adminDependencies: AdminDependencies = {
    worldRouter,
    worldClock,
    serverVersion: options.serverVersion ?? SERVER_VERSION,
    gameplayLog: logging.gameplayFile,
    adminLog: logging.adminFile,
    logger: logging.adminLogger('dispatch'),
  };
  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer({
      app: createApp({ db, healthLogger: logging.gameplayLogger('health') }),
      host: configuration.httpHost,
      port: options.port ?? configuration.httpPort,
      adminToken: configuration.adminToken,
      trustProxy: configuration.preloginLimit === 'proxy',
      dependencies,
      adminDependencies,
      logger: logging.adminLogger('connection'),
    });
  } catch (error) {
    return failStartup(error);
  }

  const checkpoint = new CheckpointService(
    worldRouter,
    sessions,
    options.checkpointIntervalMs ?? configuration.checkpointIntervalMs,
    logging.gameplayLogger('checkpoint'),
  );
  const simulation = new SimulationService(worldRouter, options.simulationIntervalMs);
  const simulationControl = new AbortController();
  const worldClockControl = new AbortController();
  const checkpointControl = new AbortController();
  const simulationRun = simulation.run(simulationControl.signal);
  const worldClockRun = worldClock.run(worldClockControl.signal);
  const checkpointRun = checkpoint.run(checkpointControl.signal);
  // Through the gameplay logger, so the record is in the gameplay log an operator reads over `/admin`.
  if (configuration.preloginLimit === 'off' && !configuration.devDefaults) {
    preloginLogger.error('the pre-login limit is off until SOMNIO_TRUST_PROXY is set');
  }
  lifecycle.info({ port: server.port, version: SERVER_VERSION, prelogin_limit: configuration.preloginLimit }, 'SomnioServer ready');

  return {
    port: server.port,
    db,
    worldRouter,
    worldClock,
    dependencies,
    // The simulation stops first so no in-flight pass contends with the drain; the world clock saves;
    // the checkpointer stops; the router drains every connection; then the server and the pool.
    shutdown: async () => {
      simulationControl.abort();
      await simulationRun;
      lifecycle.debug('shutdown: simulation stopped');
      worldClockControl.abort();
      await worldClockRun;
      lifecycle.debug('shutdown: world clock saved');
      checkpointControl.abort();
      await checkpointRun;
      lifecycle.debug('shutdown: checkpointer stopped');
      await worldRouter.drainAll();
      lifecycle.debug('shutdown: connections drained');
      await server.close();
      lifecycle.debug('shutdown: server closed');
      await db.destroy();
    },
  };
}

/** Boots, waits for SIGINT/SIGTERM, then shuts down under a 15 s cap. */
export async function runServer(env: Record<string, string | undefined>): Promise<void> {
  const logging = createLogging({
    directory: resolve(LOGS_DIRECTORY),
    maxBytes: PRODUCTION_LOG_MAX_BYTES,
    maxArchives: PRODUCTION_LOG_MAX_ARCHIVES,
  });
  const lifecycle = logging.serverLogger('lifecycle');
  const server = await bootServer(env, { logging });
  lifecycle.info('awaiting termination signal');

  await new Promise<void>((resolveSignal) => {
    const onSignal = (signal: NodeJS.Signals) => {
      lifecycle.info({ signal }, 'termination signal received');
      resolveSignal();
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  });

  await Promise.race([server.shutdown(), delay(SHUTDOWN_CAP_MS, undefined, { ref: false })]);
  lifecycle.info('SomnioServer stopped');
}
