import { connect } from 'node:net'
import { describe, expect, it } from 'vitest'
import { encodeSomnioMessage } from '@somnio/protocol'
import { TestClient, attemptUpgrade, gameplayURL, withLiveServer } from '../support/liveServer.ts'
import { makeStubConnectionDependencies } from '../support/stubDependencies.ts'
import { StubSessionRepository } from '../support/stubRepositories.ts'

/** A session repository whose redemption blocks until released, holding one connection mid-handler. */
class HeldSessionRepository extends StubSessionRepository {
  private release: () => void = () => {}
  private markReached: () => void = () => {}
  /** Declared after `markReached`: field initializers run in order, and this one assigns it. */
  readonly reached = new Promise<void>((resolve) => {
    this.markReached = resolve
  })

  override async redeem(token: string) {
    this.markReached()
    await new Promise<void>((resolve) => {
      this.release = resolve
    })
    return super.redeem(token)
  }

  releaseHandler(): void {
    this.release()
  }
}

/** A raw upgrade request for an arbitrary target, including ones Node's parser accepts but `URL` refuses. */
function rawUpgrade(port: number, target: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1')
    let response = ''
    socket.on('connect', () => {
      socket.write(
        `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
          'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n\r\n'
      )
    })
    socket.on('data', (chunk: Buffer) => {
      response += chunk.toString('latin1')
    })
    socket.on('close', () => resolve(response))
    // A listener already closed refuses the connection outright: report it as an empty response.
    socket.on('error', () => resolve(response))
    // A 101 leaves the socket open; give up on it so a regression fails instead of hanging.
    setTimeout(() => socket.destroy(), 2000).unref()
  })
}

describe('upgrade guards', () => {
  it('a request target URL cannot parse answers 400 and leaves the server up', async () => {
    await withLiveServer({}, async (server) => {
      const response = await rawUpgrade(server.port, '//[/')
      expect(response.startsWith('HTTP/1.1 400 ')).toBe(true)
      expect(await attemptUpgrade(gameplayURL(server))).toBe('opened')
    })
  })

  it('an upgrade arriving while shutdown awaits a connection is refused with 503', async () => {
    const sessions = new HeldSessionRepository()
    const dependencies = await makeStubConnectionDependencies({ sessions })
    await withLiveServer({ dependencies }, async (server) => {
      // A connection stuck in a handler keeps `close()` awaiting its exit with the listener still
      // open: exactly the window a late upgrade lands in.
      const held = await TestClient.open(gameplayURL(server))
      await held.next()
      held.send(encodeSomnioMessage({ tag: 'redeemSession', payload: { token: 'held' } }))
      await sessions.reached
      const closing = server.close()
      const response = await rawUpgrade(server.port, '/ws')
      // Released before the assertion: a held handler would otherwise keep the teardown waiting.
      sessions.releaseHandler()
      expect(response.startsWith('HTTP/1.1 503 ')).toBe(true)
      await closing
      await held.closed
    })
  })
})
