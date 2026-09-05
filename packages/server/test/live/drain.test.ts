import { describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { MAX_WIRE_FRAME_SIZE, decodeSomnioMessage, encodeSomnioMessage } from '@somnio/protocol'
import {
  CLOSE_PROTOCOL_ERROR,
  ConnectionActor,
  socketFromWebSocket,
} from '../../src/connection/connectionActor.ts'
import { TestClient } from '../support/liveServer.ts'
import { makeStubConnectionDependencies } from '../support/stubDependencies.ts'

/**
 * A bare `ws` server driving `runConnection` directly, so frames can be preseeded into the
 * outbox before the actor starts and the drain-before-close exit observed on a real socket.
 */
async function withActorServer(preseed: string[], body: (url: string) => Promise<void>): Promise<void> {
  const dependencies = await makeStubConnectionDependencies()
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: MAX_WIRE_FRAME_SIZE })
  wss.on('connection', (ws) => {
    ws.on('error', () => {})
    const actor = new ConnectionActor(dependencies)
    for (const frame of preseed) actor.outbox.send(frame)
    void actor.runConnection(socketFromWebSocket(ws))
  })
  await new Promise<void>((resolve) => wss.once('listening', resolve))
  const address = wss.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  try {
    await body(`ws://127.0.0.1:${port}/ws`)
  } finally {
    for (const client of wss.clients) client.terminate()
    await new Promise<void>((resolve) => wss.close(() => resolve()))
  }
}

describe('drain before close', () => {
  it('every queued frame reaches the client before the protocol-error close', async () => {
    const frameCount = 16
    const preseed = Array.from({ length: frameCount }, (_, index) =>
      encodeSomnioMessage({ tag: 'dateTick', payload: { hour: index % 24, minute: 0 } })
    )
    await withActorServer(preseed, async (url) => {
      const client = await TestClient.open(url)
      client.socket.send(Buffer.from('x'), { binary: true })
      const received = (await client.drainUntilClose()).map(decodeSomnioMessage)
      expect((await client.closed).code).toBe(CLOSE_PROTOCOL_ERROR)
      expect(received.length).toBe(frameCount + 1)
      expect(received.filter((message) => message.tag === 'hello').length).toBe(1)
      const hours = received.flatMap((message) => (message.tag === 'dateTick' ? [message.payload.hour] : []))
      expect(hours.sort((a, b) => a - b)).toEqual(Array.from({ length: frameCount }, (_, index) => index))
    })
  })

  it.each([
    ['binary', (client: TestClient) => client.socket.send(Buffer.from('x'), { binary: true })],
    ['malformed JSON', (client: TestClient) => client.send('this is not json')],
    ['unknown tag', (client: TestClient) => client.send('{"tag":"bogusTag","payload":{}}')],
  ])('a malformed %s frame closes the socket with protocolError', async (_label, send) => {
    await withActorServer([], async (url) => {
      const client = await TestClient.open(url)
      send(client)
      expect((await client.closed).code).toBe(CLOSE_PROTOCOL_ERROR)
    })
  })
})
