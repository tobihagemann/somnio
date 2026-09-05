import { describe, expect, it } from 'vitest'
import { LOGIN_RESULT, SOMNIO_PROTOCOL_CONSTANTS, encodeSomnioMessage } from '@somnio/protocol'
import { TestClient, gameplayURL, withLiveServer } from '../support/liveServer.ts'
import { makeOneSectorWorld } from '../support/oneSectorWorld.ts'
import { StubSessionRepository } from '../support/stubRepositories.ts'

const OVER_CAP_TOKEN = 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSessionTokenUTF8Bytes + 1)

/** A world where a planted session token resolves to a character in a loaded sector. */
async function resumableWorld() {
  const sessions = new StubSessionRepository()
  const accountId = crypto.randomUUID()
  const issued = await sessions.issue(accountId, 3600)
  const { dependencies } = await makeOneSectorWorld({ sessions, accountId })
  return { dependencies, sessions, token: issued.token }
}

async function attach(client: TestClient, token: string): Promise<void> {
  await client.next()
  client.send(encodeSomnioMessage({ tag: 'redeemSession', payload: { token } }))
  const { target } = await client.until('loginResult')
  expect(target).toEqual({ tag: 'loginResult', payload: { result: LOGIN_RESULT.ok } })
  await client.until('dateTick')
}

describe('over-cap handler frames over a live socket', () => {
  it('an over-cap redeemSession answers badCredentials and the next frame is still handled', async () => {
    const world = await resumableWorld()
    await withLiveServer({ dependencies: world.dependencies }, async (server) => {
      const client = await TestClient.open(gameplayURL(server))
      await client.next()
      client.send(encodeSomnioMessage({ tag: 'redeemSession', payload: { token: OVER_CAP_TOKEN } }))
      expect(await client.next()).toEqual({
        tag: 'loginResult',
        payload: { result: LOGIN_RESULT.badCredentials },
      })
      expect(world.sessions.redeemCallCount).toBe(0)
      client.send(encodeSomnioMessage({ tag: 'redeemSession', payload: { token: world.token } }))
      expect(await client.next()).toEqual({ tag: 'loginResult', payload: { result: LOGIN_RESULT.ok } })
      await client.close()
    })
  })

  it('an over-cap revokeSession answers sessionRevoked(false) and the next frame is still handled', async () => {
    const world = await resumableWorld()
    await withLiveServer({ dependencies: world.dependencies }, async (server) => {
      const client = await TestClient.open(gameplayURL(server))
      await attach(client, world.token)
      client.send(encodeSomnioMessage({ tag: 'revokeSession', payload: { token: OVER_CAP_TOKEN } }))
      expect(await client.next()).toEqual({ tag: 'sessionRevoked', payload: { revoked: false } })
      expect(world.sessions.revokeCallCount).toBe(0)
      client.send(encodeSomnioMessage({ tag: 'revokeSession', payload: { token: world.token } }))
      expect(await client.next()).toEqual({ tag: 'sessionRevoked', payload: { revoked: true } })
      await client.close()
    })
  })

  it('an over-cap clientSay is dropped, the socket stays open, and the next frame is still handled', async () => {
    const world = await resumableWorld()
    await withLiveServer({ dependencies: world.dependencies }, async (server) => {
      const client = await TestClient.open(gameplayURL(server))
      await attach(client, world.token)
      const text = 'x'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes + 1)
      client.send(encodeSomnioMessage({ tag: 'clientSay', payload: { entityIndex: 0, text } }))
      client.send(encodeSomnioMessage({ tag: 'revokeSession', payload: { token: 'unknown' } }))
      expect(await client.next()).toEqual({ tag: 'sessionRevoked', payload: { revoked: false } })
      await client.close()
    })
  })

  it('a whitespace-padded clientSay of exactly maxFrameLength bytes is accepted', async () => {
    const world = await resumableWorld()
    await withLiveServer({ dependencies: world.dependencies }, async (server) => {
      const client = await TestClient.open(gameplayURL(server))
      await attach(client, world.token)
      const say = encodeSomnioMessage({ tag: 'clientSay', payload: { entityIndex: 0, text: 'padded' } })
      const padded =
        say + ' '.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxFrameLength - Buffer.byteLength(say, 'utf8'))
      expect(Buffer.byteLength(padded, 'utf8')).toBe(SOMNIO_PROTOCOL_CONSTANTS.maxFrameLength)
      client.send(padded)
      client.send(encodeSomnioMessage({ tag: 'revokeSession', payload: { token: 'unknown' } }))
      expect(await client.next()).toEqual({ tag: 'sessionRevoked', payload: { revoked: false } })
      await client.close()
    })
  })
})
