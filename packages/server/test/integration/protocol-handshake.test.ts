import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MAX_WIRE_FRAME_SIZE,
  SOMNIO_PROTOCOL_CONSTANTS,
  decodeAdminResponse,
  encodeAdminRequest,
} from '@somnio/protocol'
import { CLOSE_PROTOCOL_ERROR } from '../../src/connection/connectionActor.ts'
import { TestClient, attemptUpgrade, bearer } from '../support/liveServer.ts'
import { TEST_ADMIN_TOKEN, bootTestServer, startDatabase } from './support/harness.ts'
import type { DatabaseHarness, TestServer } from './support/harness.ts'

let harness: DatabaseHarness
let server: TestServer

beforeAll(async () => {
  harness = await startDatabase()
  server = await bootTestServer(harness.url)
})
afterAll(async () => {
  await server.stop()
  await harness.stop()
})

describe('protocol handshake against the booted server', () => {
  it('sends hello with the current protocol version on connect', async () => {
    const client = await TestClient.open(server.url)
    expect(await client.next()).toEqual({
      tag: 'hello',
      payload: { protocolVersion: SOMNIO_PROTOCOL_CONSTANTS.helloVersion },
    })
    await client.close()
  })

  it.each([
    ['an unrecognized tag', '{"tag":"notAVerb","payload":{}}'],
    ['malformed JSON', '{ not json'],
    ['a recognized tag with a malformed payload', '{"tag":"clientPosition","payload":{}}'],
    ['a zero-byte text frame', ''],
  ])('closes the connection on %s', async (_label, text) => {
    const client = await TestClient.open(server.url)
    await client.next()
    client.send(text)
    expect((await client.closed).code).toBe(CLOSE_PROTOCOL_ERROR)
  })

  it('closes the connection on a binary frame', async () => {
    const client = await TestClient.open(server.url)
    await client.next()
    client.socket.send(Buffer.from([0x00]), { binary: true })
    expect((await client.closed).code).toBe(CLOSE_PROTOCOL_ERROR)
  })

  it('closes the connection on a frame larger than the wire size cap', async () => {
    const client = await TestClient.open(server.url)
    await client.next()
    client.send('a'.repeat(MAX_WIRE_FRAME_SIZE + 16))
    expect([1009, 1006]).toContain((await client.closed).code)
  })

  it('admin upgrade requires the bearer and then answers a verb', async () => {
    expect(await attemptUpgrade(server.adminUrl)).toBe(401)
    const admin = await TestClient.open(server.adminUrl, bearer(TEST_ADMIN_TOKEN))
    admin.send(encodeAdminRequest({ tag: 'players' }))
    expect(decodeAdminResponse(await admin.nextText())).toEqual({ tag: 'playerCount', payload: '0' })
    await admin.close()
  })
})
