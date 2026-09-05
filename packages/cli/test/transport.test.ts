import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { makeAdminDependencies } from '../../server/test/support/adminDependencies.ts'
import { StubAdminWorldRouter } from '../../server/test/support/stubAdminWorldRouter.ts'
import { TEST_ADMIN_TOKEN, adminURL, withLiveServer } from '../../server/test/support/liveServer.ts'
import { AdminTransportError, send } from '../src/transport.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

async function expectTransportError(
  kind: AdminTransportError['kind'],
  body: () => Promise<unknown>
): Promise<AdminTransportError> {
  let caught: unknown
  try {
    await body()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(AdminTransportError)
  expect((caught as AdminTransportError).kind).toBe(kind)
  return caught as AdminTransportError
}

/** A bare `/admin` endpoint whose handler drives one scripted behaviour. */
async function withScriptedServer(
  handler: (ws: WebSocket) => void,
  body: (url: string) => Promise<void>
): Promise<void> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  wss.on('connection', (ws) => {
    ws.on('error', () => {})
    handler(ws)
  })
  await new Promise<void>((resolve) => wss.once('listening', resolve))
  const address = wss.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  try {
    await body(`ws://127.0.0.1:${port}/admin`)
  } finally {
    for (const client of wss.clients) client.terminate()
    await new Promise<void>((resolve) => wss.close(() => resolve()))
  }
}

describe('send', () => {
  it("returns the dispatcher's decoded response on the happy path", async () => {
    const router = new StubAdminWorldRouter()
    router.playerCount = 11
    const adminDependencies = await makeAdminDependencies({ worldRouter: router })
    cleanups.push(() => adminDependencies.logging.cleanup())
    await withLiveServer({ adminDependencies }, async (server) => {
      expect(await send({ tag: 'players' }, adminURL(server), TEST_ADMIN_TOKEN)).toEqual({
        tag: 'playerCount',
        payload: '11',
      })
    })
  })

  it('fails with connectFailed when the bearer is refused', async () => {
    const adminDependencies = await makeAdminDependencies()
    cleanups.push(() => adminDependencies.logging.cleanup())
    await withLiveServer({ adminDependencies }, async (server) => {
      const error = await expectTransportError('connectFailed', () =>
        send({ tag: 'players' }, adminURL(server), 'wrong')
      )
      expect(error.message).toContain('401')
    })
  })

  it('rejects an unexpected binary frame from the server', async () => {
    await withScriptedServer(
      (ws) => ws.on('message', () => ws.send(Buffer.from([0x00]), { binary: true })),
      async (url) => {
        await expectTransportError('unexpectedBinaryFrame', () => send({ tag: 'players' }, url, 'tok'))
      }
    )
  })

  it('surfaces decodeFailed carrying the underlying error', async () => {
    await withScriptedServer(
      (ws) => ws.on('message', () => ws.send('not json')),
      async (url) => {
        const error = await expectTransportError('decodeFailed', () => send({ tag: 'players' }, url, 'tok'))
        expect(error.cause).toBeInstanceOf(Error)
      }
    )
  })

  it('surfaces noResponse when the server closes without sending a frame', async () => {
    await withScriptedServer(
      (ws) => ws.on('message', () => ws.close(1000)),
      async (url) => {
        await expectTransportError('noResponse', () => send({ tag: 'players' }, url, 'tok'))
      }
    )
  })

  it('surfaces connectFailed when the server is unreachable', async () => {
    await expectTransportError('connectFailed', () =>
      send({ tag: 'players' }, 'ws://127.0.0.1:1/admin', 'tok')
    )
  })

  it.each(['ws://attacker@localhost:8080/admin', 'WSS://localhost/admin', 'ws://example.com/admin', ''])(
    'rejects %j before opening a socket',
    async (url) => {
      await expectTransportError('invalidTransportURL', () => send({ tag: 'players' }, url, 'tok'))
    }
  )

  it('rejects a validate-passing but host-disagreeing URL before dialing', async () => {
    await expectTransportError('invalidTransportURL', () =>
      send({ tag: 'players' }, 'wss://ex%41mple.com/admin', 'tok')
    )
  })

  it('fails closed with pinningRefused on a wss dial with refused roots', async () => {
    await expectTransportError('pinningRefused', () =>
      send({ tag: 'players' }, 'wss://example.com:443/admin', 'tok', { kind: 'refused', reason: 'bad pem' })
    )
  })

  it('a wss dial with pinned roots fails on connect, not on validation', async () => {
    const error = await expectTransportError('connectFailed', () =>
      send({ tag: 'players' }, 'wss://127.0.0.1:1/admin', 'tok', { kind: 'pinned', ca: [] })
    )
    expect(error.kind).toBe('connectFailed')
  })
})
