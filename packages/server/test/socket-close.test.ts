import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { socketFromWebSocket } from '../src/connection/connectionActor.ts'
import type { ConnectionSocket } from '../src/connection/connectionActor.ts'

/**
 * The real `ws` adapter's close: the handshake completes against a responsive peer even while the
 * server side is paused, a peer that never answers is terminated after the grace so the exit path
 * stays bounded, and an already-closed socket settles at once.
 */
describe('socketFromWebSocket.close', () => {
  let wss: WebSocketServer | undefined
  afterEach(() => {
    wss?.close()
    wss = undefined
  })

  async function connectedPair(): Promise<{
    server: WebSocket
    adapter: ConnectionSocket
    client: WebSocket
  }> {
    const listening = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    wss = listening
    await new Promise<void>((resolve) => listening.once('listening', resolve))
    const serverSide = new Promise<WebSocket>((resolve) => listening.once('connection', resolve))
    const port = (listening.address() as { port: number }).port
    const client = new WebSocket(`ws://127.0.0.1:${port}/`)
    await new Promise<void>((resolve) => client.once('open', resolve))
    const server = await serverSide
    return { server, adapter: socketFromWebSocket(server), client }
  }

  it('completes the handshake against a responsive peer, even while paused', async () => {
    const { server, adapter, client } = await connectedPair()
    const clientClosed = new Promise<number>((resolve) => client.once('close', (code) => resolve(code)))
    adapter.pause()
    const started = Date.now()
    await adapter.close(1001, 'connection closed')
    expect(Date.now() - started).toBeLessThan(900)
    expect(server.readyState).toBe(WebSocket.CLOSED)
    expect(await clientClosed).toBe(1001)
  })

  it('terminates a peer that never answers the close frame after the grace', async () => {
    const { server, adapter, client } = await connectedPair()
    // A paused client socket never reads the close frame, so it never replies.
    client.pause()
    const started = Date.now()
    // Raced against a deadline so a regression of the grace fails here instead of hanging.
    const outcome = await Promise.race([adapter.close(1001, 'connection closed'), delay(5000, 'deadline')])
    expect(outcome).toBeUndefined()
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    expect(server.readyState).toBe(WebSocket.CLOSED)
    client.terminate()
  })

  it('resolves immediately on a socket that is already closed', async () => {
    const { server, adapter, client } = await connectedPair()
    client.terminate()
    await new Promise<void>((resolve) => server.once('close', () => resolve()))
    const started = Date.now()
    await adapter.close(1001, 'connection closed')
    expect(Date.now() - started).toBeLessThan(100)
  })
})
