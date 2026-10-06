import registryJSON from '@somnio/core/data/ModelRegistry.json' with { type: 'json' };
import { encodeSomnioMessage } from '@somnio/protocol';
import type { SomnioMessage } from '@somnio/protocol';
import { SOMNIO_CONSTANTS } from '@somnio/core';
import type { Character, Point } from '@somnio/core';
import {
  PostgresAccountRepository,
  PostgresCharacterRepository,
  PostgresInventoryRepository,
  PostgresNPCDialogStateRepository,
  PostgresRegistrationRepository,
  PostgresSessionRepository,
  PostgresWorldClockRepository,
} from '@somnio/data';
import type { SomnioDatabase } from '@somnio/data';
import { startDatabase } from '../../../../data/test/integration/support/harness.ts';
import type { DatabaseHarness } from '../../../../data/test/integration/support/harness.ts';
import { bootServer } from '../../../src/bootstrap/runServer.ts';
import type { BootOptions, BootedServer } from '../../../src/bootstrap/runServer.ts';
import { DEV_SECTORS_DIRECTORY } from '../../../src/config.ts';
import { AttemptLimiter } from '../../../src/connection/attemptLimiter.ts';
import type { ConnectionDependencies } from '../../../src/connection/dependencies.ts';
import { loadSectorCache, loadWorld } from '../../../src/sectors/sectorCache.ts';
import type { LoadedWorld } from '../../../src/sectors/sectorCache.ts';
import { WorldClockService } from '../../../src/services/worldClockService.ts';
import type { SpaceActor } from '../../../src/world/spaceActor.ts';
import { WorldRouter } from '../../../src/world/worldRouter.ts';
import { TestClient } from '../../support/liveServer.ts';
import { testLogger } from '../../support/logger.ts';
import { tempLogging } from '../../support/tempLogging.ts';
import type { TempLogging } from '../../support/tempLogging.ts';

export { startDatabase };
export type { DatabaseHarness };

export const TEST_ADMIN_TOKEN = 'secret';
export const TEST_SERVER_VERSION = 'test-version';
export const TEST_PASSWORD = 'secret-pass';

export interface TestServer {
  server: BootedServer;
  logging: TempLogging;
  url: string;
  adminUrl: string;
  healthUrl: string;
  stop(): Promise<void>;
}

/**
 * The production boot over the fixture sectors and a throwaway database, on an ephemeral port.
 * `env` is merged over the environment built here.
 */
export async function bootTestServer(
  databaseUrl: string,
  options: Omit<BootOptions, 'logging' | 'port'> & { sectorsDirectory?: string; env?: Record<string, string> } = {},
): Promise<TestServer> {
  const logging = tempLogging({ maxBytes: 1 << 20 });
  const { sectorsDirectory, env, ...boot } = options;
  const server = await bootServer(
    {
      SOMNIO_DATABASE_URL: databaseUrl,
      SOMNIO_DATABASE_TLS: 'disable',
      SOMNIO_ADMIN_TOKEN: TEST_ADMIN_TOKEN,
      SOMNIO_SECTORS_DIR: sectorsDirectory ?? DEV_SECTORS_DIRECTORY,
      SOMNIO_HTTP_HOST: '127.0.0.1',
      ...env,
    },
    { ...boot, logging, port: 0, serverVersion: options.serverVersion ?? TEST_SERVER_VERSION },
  );
  return {
    server,
    logging,
    url: `ws://127.0.0.1:${server.port}/ws`,
    adminUrl: `ws://127.0.0.1:${server.port}/admin`,
    healthUrl: `http://127.0.0.1:${server.port}/health`,
    stop: async () => {
      await server.shutdown();
      logging.cleanup();
    },
  };
}

/** Real repositories over `db` plus a router over the fixture world, for handler-level suites. */
export async function makeDatabaseDependencies(db: SomnioDatabase): Promise<ConnectionDependencies> {
  const logger = testLogger();
  const characters = new PostgresCharacterRepository(db);
  const npcDialogStates = new PostgresNPCDialogStateRepository(db);
  const worldClocks = new PostgresWorldClockRepository(db);
  const worldRouter = await WorldRouter.create(fixtureWorld(), characters, npcDialogStates, logger);
  return {
    accounts: new PostgresAccountRepository(db),
    characters,
    inventories: new PostgresInventoryRepository(db),
    registrations: new PostgresRegistrationRepository(db),
    npcDialogStates,
    sessions: new PostgresSessionRepository(db),
    worldRouter,
    worldClock: new WorldClockService(worldClocks, await worldClocks.load(), logger),
    attemptLimiter: new AttemptLimiter({ enabled: false, logger }),
    outboxHighWatermark: 1024,
    logger,
  };
}

/** The committed sectors over the committed registry: the world the server ships. */
export function fixtureWorld(): LoadedWorld {
  return loadWorld(loadSectorCache(DEV_SECTORS_DIRECTORY), registryJSON);
}

export function uniqueNickname(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 6)}`;
}

export function frame(message: SomnioMessage): string {
  return encodeSomnioMessage(message);
}

export function registerFrame(nickname: string, password = TEST_PASSWORD): string {
  return frame({
    tag: 'register',
    payload: {
      nickname,
      password,
      passwordRepeat: password,
      people: 'wachen',
      email: `${nickname}@example.invalid`,
    },
  });
}

/** Registers over the wire on a throwaway socket. */
async function registerOverWire(url: string, nickname: string, password = TEST_PASSWORD): Promise<void> {
  const client = await TestClient.open(url);
  await client.next();
  client.send(registerFrame(nickname, password));
  const { target } = await client.until('registerResult');
  if (target.tag !== 'registerResult' || target.payload.result !== 'ok') {
    throw new Error(`registration of ${nickname} failed: ${JSON.stringify(target)}`);
  }
  await client.close();
}

export interface JoinedClient {
  client: TestClient;
  /** `loginResult` and every frame of the join after it, in order. */
  join: SomnioMessage[];
  entityId: string;
  spaceId: string;
}

/**
 * Logs in over the wire and drains the join sequence. The join has no closing frame, so a
 * `revokeSession` for a token nobody holds is sent behind the login: its answer marks the end.
 */
export async function loginOverWire(url: string, nickname: string, options: { password?: string; requestSessionToken?: boolean } = {}): Promise<JoinedClient> {
  const client = await TestClient.open(url);
  await client.next();
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
    }),
  );
  const login = await client.until('loginResult');
  if (login.target.tag !== 'loginResult' || login.target.payload.result !== 'ok') {
    throw new Error(`login of ${nickname} failed: ${JSON.stringify(login.target)}`);
  }
  const join = [login.target, ...(await drainFrames(client))];
  const enter = join[1];
  if (enter?.tag !== 'enterSpace') throw new Error('the join did not start with enterSpace');
  return { client, join, entityId: enter.payload.selfId, spaceId: enter.payload.spaceId };
}

/** Everything the server has sent the attached client so far. */
export async function drainFrames(client: TestClient): Promise<SomnioMessage[]> {
  client.send(frame({ tag: 'revokeSession', payload: { token: 'no-such-token' } }));
  return (await client.until('sessionRevoked')).before;
}

async function registerFreshPlayer(url: string, prefix: string): Promise<string> {
  const nickname = uniqueNickname(prefix);
  await registerOverWire(url, nickname);
  return nickname;
}

/** Registers and logs in a fresh player. */
export async function joinFreshPlayer(url: string, prefix: string): Promise<JoinedClient & { nickname: string }> {
  const nickname = await registerFreshPlayer(url, prefix);
  return { nickname, ...(await loginOverWire(url, nickname)) };
}

/** Registers a fresh player, saves them at `place`, and logs them in there. */
export async function joinFreshPlayerAt(
  server: TestServer,
  prefix: string,
  place: Pick<Character, 'space' | 'position'>,
): Promise<JoinedClient & { nickname: string }> {
  const nickname = await registerFreshPlayer(server.url, prefix);
  await server.server.db
    .updateTable('characters')
    .set({ space: place.space, position_x: place.position.x, position_z: place.position.z })
    .where('name', '=', nickname)
    .execute();
  return { nickname, ...(await loginOverWire(server.url, nickname)) };
}

/** The player's own position from its join sequence. */
export function selfPosition(joined: JoinedClient): Point {
  const self = joined.join.find((message) => message.tag === 'entity' && message.payload.id === joined.entityId);
  if (self?.tag !== 'entity') throw new Error('join carried no self entity');
  return { x: self.payload.x, z: self.payload.z };
}

/**
 * A point a player can stand on between touching `center` and `reach` away from it, found on
 * rings around it, so a suite does not pin where the committed sectors keep their furniture. The
 * outermost ring lies inside `reach`: a point computed at exactly that distance can round past it.
 */
export function standableNear(space: SpaceActor, center: Point, reach: number): Point {
  for (let radius = reach - 0.1; radius > 2 * SOMNIO_CONSTANTS.playerRadius; radius -= 0.1) {
    for (let step = 0; step < 16; step += 1) {
      const angle = (step * Math.PI) / 8;
      const candidate = { x: center.x + radius * Math.sin(angle), z: center.z + radius * Math.cos(angle) };
      if (space.canStand(candidate)) return candidate;
    }
  }
  throw new Error(`nowhere to stand within ${reach} m of (${center.x}, ${center.z})`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `probe` until it returns a value, failing after `timeoutMs`. */
export async function pollUntil<T>(probe: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await sleep(50);
  }
  throw new Error('condition not met within the timeout');
}

/** Closes a joined client and waits until the server has unregistered it, so a re-login is not answered `alreadyLoggedIn`. */
export async function closeAndAwaitCleanup(joined: JoinedClient, server: TestServer): Promise<void> {
  const before = server.server.worldRouter.loggedInPlayerCount();
  await joined.client.close();
  await pollUntil(() => Promise.resolve(server.server.worldRouter.loggedInPlayerCount() < before ? true : undefined));
}
