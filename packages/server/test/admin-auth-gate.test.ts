import { describe, expect, it } from 'vitest'
import { decodeAdminResponse, encodeAdminRequest } from '@somnio/protocol'
import { timingSafeBearer } from '../src/http/app.ts'
import { makeAdminDependencies } from './support/adminDependencies.ts'
import {
  TEST_ADMIN_TOKEN,
  TestClient,
  adminURL,
  attemptUpgrade,
  bearer,
  withLiveServer,
} from './support/liveServer.ts'
import { StubAdminWorldRouter } from './support/stubAdminWorldRouter.ts'

describe('timingSafeBearer', () => {
  it('matches the identical bearer', () => {
    expect(timingSafeBearer('Bearer secret', 'secret')).toBe(true)
  })

  it('rejects a different token of the same length', () => {
    expect(timingSafeBearer('Bearer sekret', 'secret')).toBe(false)
  })

  it('rejects different lengths', () => {
    expect(timingSafeBearer('Bearer secretX', 'secret')).toBe(false)
    expect(timingSafeBearer('', 'secret')).toBe(false)
    expect(timingSafeBearer(undefined, 'secret')).toBe(false)
  })

  it('folds the length flag so a zero padded prefix still fails', () => {
    expect(timingSafeBearer('Bearer sec', 'secret')).toBe(false)
    expect(timingSafeBearer('Bearer secret', 'sec')).toBe(false)
  })

  it('matches an empty token against an empty bearer', () => {
    expect(timingSafeBearer('Bearer ', '')).toBe(true)
  })
})

describe('/admin upgrade', () => {
  it('is rejected with 401 when the Authorization header is missing', async () => {
    await withLiveServer({}, async (server) => {
      expect(await attemptUpgrade(adminURL(server))).toBe(401)
    })
  })

  it('is rejected with 401 when the bearer token is wrong', async () => {
    await withLiveServer({}, async (server) => {
      expect(await attemptUpgrade(adminURL(server), bearer('wrong'))).toBe(401)
    })
  })

  it('is rejected with 401 when the scheme is missing', async () => {
    await withLiveServer({}, async (server) => {
      expect(await attemptUpgrade(adminURL(server), { headers: { authorization: TEST_ADMIN_TOKEN } })).toBe(
        401
      )
    })
  })

  it('succeeds with the configured bearer token and runs the dispatcher', async () => {
    const router = new StubAdminWorldRouter()
    router.playerCount = 3
    const adminDependencies = await makeAdminDependencies({ worldRouter: router })
    try {
      await withLiveServer({ adminDependencies }, async (server) => {
        const client = await TestClient.open(adminURL(server), bearer(TEST_ADMIN_TOKEN))
        client.send(encodeAdminRequest({ tag: 'players' }))
        expect(decodeAdminResponse(await client.nextText())).toEqual({ tag: 'playerCount', payload: '3' })
        await client.close()
      })
    } finally {
      adminDependencies.logging.cleanup()
    }
  })
})
