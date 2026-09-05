import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, resolvePostgresConfiguration } from '@somnio/data';
import { createApp } from '../../src/http/app.ts';
import { makeAdminDependencies } from '../support/adminDependencies.ts';
import { withLiveServer } from '../support/liveServer.ts';
import { testLogger } from '../support/logger.ts';
import { bootTestServer, startDatabase } from './support/harness.ts';
import type { DatabaseHarness, TestServer } from './support/harness.ts';

let harness: DatabaseHarness;
let server: TestServer;

beforeAll(async () => {
  harness = await startDatabase();
  server = await bootTestServer(harness.url);
});
afterAll(async () => {
  await server.stop();
  await harness.stop();
});

describe('GET /health', () => {
  it('returns 200 ok when the database is reachable', async () => {
    const response = await fetch(server.healthUrl);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', db: 'ok' });
  });

  it('returns 503 degraded when the database is unreachable', async () => {
    // Port 1 is reserved (TCPMUX); dialing it is refused immediately on every platform.
    const db = createDatabase(
      resolvePostgresConfiguration(
        {
          SOMNIO_DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/nowhere',
          SOMNIO_DATABASE_TLS: 'disable',
        },
        false,
      ),
    );
    const adminDependencies = await makeAdminDependencies();
    try {
      const app: Hono = createApp({ db, healthLogger: testLogger() });
      await withLiveServer({ app, adminDependencies }, async (running) => {
        const response = await fetch(`http://127.0.0.1:${running.port}/health`);
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ status: 'degraded', db: 'unreachable' });
      });
    } finally {
      await db.destroy();
      adminDependencies.logging.cleanup();
    }
  });
});
