import { timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { assertQueryable } from '@somnio/data'
import type { SomnioDatabase } from '@somnio/data'
import type { Logger } from '../logging.ts'

export interface AppDependencies {
  db: SomnioDatabase
  healthLogger: Logger
}

/**
 * The HTTP surface: `GET /health` (200 `{"status":"ok","db":"ok"}` on a `SELECT 1`, 503
 * `{"status":"degraded","db":"unreachable"}` on any error) and a 401 for a plain `GET /admin`.
 * The WebSocket routes themselves are handled on the HTTP server's `upgrade` event (`server.ts`).
 */
export function createApp(dependencies: AppDependencies): Hono {
  const app = new Hono()
  app.get('/health', async (context) => {
    try {
      await assertQueryable(dependencies.db)
      return context.json({ status: 'ok', db: 'ok' }, 200)
    } catch (error) {
      dependencies.healthLogger.warn({ error: String(error) }, 'health probe failed')
      return context.json({ status: 'degraded', db: 'unreachable' }, 503)
    }
  })
  app.get('/admin', (context) => context.text('Unauthorized', 401))
  return app
}

/**
 * Constant-time comparison so the admin token cannot be recovered byte-by-byte by timing. The
 * length mismatch is folded into the verdict rather than short-circuiting, so a prefix followed by
 * missing bytes still fails.
 */
export function timingSafeBearer(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`, 'utf8')
  const candidate = Buffer.from(header ?? '', 'utf8')
  const length = Math.max(expected.length, candidate.length)
  const paddedExpected = Buffer.concat([expected, Buffer.alloc(length - expected.length)])
  const paddedCandidate = Buffer.concat([candidate, Buffer.alloc(length - candidate.length)])
  const same = timingSafeEqual(paddedExpected, paddedCandidate)
  return same && expected.length === candidate.length
}
