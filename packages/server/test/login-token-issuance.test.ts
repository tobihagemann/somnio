import pino from 'pino'
import { describe, expect, it } from 'vitest'
import { LOGIN_RESULT, SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol'
import type { SectorObject } from '@somnio/core'
import { hashPassword } from '@somnio/data'
import type { SessionRepository } from '@somnio/data'
import { ConnectionActor } from '../src/connection/connectionActor.ts'
import { completeAuthenticatedJoin, handleLogin } from '../src/handlers/login.ts'
import type { Logger } from '../src/logging.ts'
import { handleRedeem, handleRevoke } from '../src/handlers/session.ts'
import { collectMessages, loginResults } from './support/frames.ts'
import { makeOneSectorWorld } from './support/oneSectorWorld.ts'
import {
  StubAccountRepository,
  StubSessionRepository,
  failingSessionRepository,
  makeAccount,
} from './support/stubRepositories.ts'

async function makeAuthenticatedWorld(
  sessions: SessionRepository,
  name: string,
  password: string,
  logger?: Logger
) {
  const accountId = crypto.randomUUID()
  const account = makeAccount({ id: accountId, name, passwordHash: await hashPassword(password) })
  return makeOneSectorWorld({
    sessions,
    accountId,
    characterName: name,
    accounts: new StubAccountRepository(new Map([[name, account]])),
    ...(logger === undefined ? {} : { logger }),
  })
}

/** A logger whose records are collected as parsed JSON, for asserting on what the operator sees. */
function recordingLogger(): { logger: Logger; records: Record<string, unknown>[] } {
  const records: Record<string, unknown>[] = []
  const logger = pino(
    { level: 'debug' },
    { write: (chunk: string) => records.push(JSON.parse(chunk) as Record<string, unknown>) }
  )
  return { logger, records }
}

describe('session token issuance', () => {
  it('a login requesting a session token receives one', async () => {
    const sessions = new StubSessionRepository()
    const world = await makeOneSectorWorld({ sessions })
    const connection = new ConnectionActor(world.dependencies)
    await completeAuthenticatedJoin(world.accountId, connection, world.dependencies, true)
    const messages = await collectMessages(connection.outbox)
    expect(messages.map((message) => message.tag)).toContain('loginResult')
    const token = messages.find((message) => message.tag === 'sessionToken')
    expect(token).toBeDefined()
    if (token?.tag === 'sessionToken') {
      expect(sessions.isStored(token.payload.token)).toBe(true)
      expect(token.payload.expiresInSeconds).toBeGreaterThan(0)
    }
  })

  it('a login that did not ask receives no session token', async () => {
    const world = await makeOneSectorWorld({ sessions: new StubSessionRepository() })
    const connection = new ConnectionActor(world.dependencies)
    await completeAuthenticatedJoin(world.accountId, connection, world.dependencies, false)
    const tags = (await collectMessages(connection.outbox)).map((message) => message.tag)
    expect(tags).toContain('loginResult')
    expect(tags).not.toContain('sessionToken')
  })

  it('a failed token issuance still completes the join', async () => {
    const world = await makeOneSectorWorld({ sessions: failingSessionRepository })
    const connection = new ConnectionActor(world.dependencies)
    await completeAuthenticatedJoin(world.accountId, connection, world.dependencies, true)
    const tags = (await collectMessages(connection.outbox)).map((message) => message.tag)
    expect(tags).toContain('loginResult')
    expect(tags).not.toContain('sessionToken')
    expect(tags).toContain('enterSector')
  })

  it('a join that fails to attach issues no token and reports the failure', async () => {
    const sessions = new StubSessionRepository()
    // One object carrying more than `maxFrameLength` of `modelID` makes the first `enterSector` encode throw.
    const oversized: SectorObject = {
      x: 0,
      y: 0,
      modelID: 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxFrameLength + 1),
      sourceWidth: 32,
      sourceHeight: 32,
      priority: 0,
      rotation: 0,
    }
    const world = await makeOneSectorWorld({ sessions, objects: [oversized] })
    const connection = new ConnectionActor(world.dependencies)
    await completeAuthenticatedJoin(world.accountId, connection, world.dependencies, true)
    const messages = await collectMessages(connection.outbox)
    expect(loginResults(messages)).toEqual([LOGIN_RESULT.ok, LOGIN_RESULT.badCredentials])
    const tags = messages.map((message) => message.tag)
    expect(tags).not.toContain('enterSector')
    expect(tags).not.toContain('sessionToken')
    expect(sessions.issuedCount).toBe(0)

    // The router slot is released: a retry is answered `ok`, not `alreadyLoggedIn`.
    const retry = new ConnectionActor(world.dependencies)
    await completeAuthenticatedJoin(world.accountId, retry, world.dependencies, false)
    expect(loginResults(await collectMessages(retry.outbox))[0]).toBe(LOGIN_RESULT.ok)
  })

  /** The sector directory is operator-supplied, so a persisted sector can be absent from the cache. */
  it('a character in a sector missing from the cache is refused and releases the router slot', async () => {
    const sessions = new StubSessionRepository()
    const world = await makeOneSectorWorld({ sessions, characterSector: 'Gone' })
    const connection = new ConnectionActor(world.dependencies)
    await completeAuthenticatedJoin(world.accountId, connection, world.dependencies, true)
    const messages = await collectMessages(connection.outbox)
    expect(loginResults(messages)).toEqual([LOGIN_RESULT.badCredentials])
    expect(messages.map((message) => message.tag)).not.toContain('enterSector')
    expect(sessions.issuedCount).toBe(0)
    expect(world.dependencies.worldRouter.loggedInPlayerCount()).toBe(0)

    const retry = new ConnectionActor(world.dependencies)
    await completeAuthenticatedJoin(world.accountId, retry, world.dependencies, false)
    expect(loginResults(await collectMessages(retry.outbox))).toEqual([LOGIN_RESULT.badCredentials])
  })

  it('redeeming a live token joins the world', async () => {
    const sessions = new StubSessionRepository()
    const world = await makeOneSectorWorld({ sessions })
    const issued = await sessions.issue(world.accountId, 3600)
    const connection = new ConnectionActor(world.dependencies)
    await handleRedeem({ token: issued.token }, connection, world.dependencies)
    const messages = await collectMessages(connection.outbox)
    expect(loginResults(messages)).toEqual([LOGIN_RESULT.ok])
    const tags = messages.map((message) => message.tag)
    expect(tags).toContain('enterSector')
    expect(tags).not.toContain('sessionToken')
    expect(sessions.isStored(issued.token)).toBe(true)
  })

  it('a redeem that throws answers badCredentials rather than nothing', async () => {
    const world = await makeOneSectorWorld({ sessions: failingSessionRepository })
    const connection = new ConnectionActor(world.dependencies)
    await handleRedeem({ token: 'any' }, connection, world.dependencies)
    expect(loginResults(await collectMessages(connection.outbox))).toEqual([LOGIN_RESULT.badCredentials])
  })

  it('a revoke that throws answers rather than going silent', async () => {
    const world = await makeOneSectorWorld({ sessions: failingSessionRepository })
    const connection = new ConnectionActor(world.dependencies)
    connection.markAttached(1, 'A', world.accountId)
    await handleRevoke({ token: 'any' }, world.accountId, connection, world.dependencies)
    expect(await collectMessages(connection.outbox)).toEqual([
      { tag: 'sessionRevoked', payload: { revoked: false } },
    ])
  })

  it('a login omitting requestSessionToken is answered without a token', async () => {
    const world = await makeAuthenticatedWorld(new StubSessionRepository(), 'gated', 'hunter2-long')
    const connection = new ConnectionActor(world.dependencies)
    await handleLogin({ nickname: 'gated', password: 'hunter2-long' }, connection, world.dependencies)
    const tags = (await collectMessages(connection.outbox)).map((message) => message.tag)
    expect(tags).toContain('enterSector')
    expect(tags).not.toContain('sessionToken')
  })

  it('a login setting requestSessionToken is answered with one', async () => {
    const world = await makeAuthenticatedWorld(new StubSessionRepository(), 'asker', 'hunter2-long')
    const connection = new ConnectionActor(world.dependencies)
    await handleLogin(
      { nickname: 'asker', password: 'hunter2-long', requestSessionToken: true },
      connection,
      world.dependencies
    )
    const tags = (await collectMessages(connection.outbox)).map((message) => message.tag)
    expect(tags).toContain('enterSector')
    expect(tags).toContain('sessionToken')
  })

  /** Uniform on the wire, specific in the log: the record is the operator's only guessing signal. */
  it('a login with the wrong password answers badCredentials and records a warn naming the account', async () => {
    const { logger, records } = recordingLogger()
    const world = await makeAuthenticatedWorld(new StubSessionRepository(), 'asker', 'hunter2-long', logger)
    const connection = new ConnectionActor(world.dependencies)
    await handleLogin({ nickname: 'asker', password: 'wrong-password' }, connection, world.dependencies)
    expect(loginResults(await collectMessages(connection.outbox))).toEqual([LOGIN_RESULT.badCredentials])
    const rejected = records.filter((record) => record['msg'] === 'login rejected: bad credentials')
    expect(rejected).toMatchObject([{ level: 40, known_account: true, name: 'asker' }])
  })

  it('a login for an unknown account records the warn without the submitted string', async () => {
    const { logger, records } = recordingLogger()
    const world = await makeAuthenticatedWorld(new StubSessionRepository(), 'asker', 'hunter2-long', logger)
    const connection = new ConnectionActor(world.dependencies)
    await handleLogin({ nickname: 'my-secret-pw', password: 'whatever-long' }, connection, world.dependencies)
    expect(loginResults(await collectMessages(connection.outbox))).toEqual([LOGIN_RESULT.badCredentials])
    const rejected = records.filter((record) => record['msg'] === 'login rejected: bad credentials')
    expect(rejected).toMatchObject([{ level: 40, known_account: false }])
    // Over every record, not only the warn: no path in the handler may write the submitted string.
    expect(JSON.stringify(records)).not.toContain('my-secret-pw')
  })

  it('a second join for the same account answers alreadyLoggedIn', async () => {
    const world = await makeOneSectorWorld({ sessions: new StubSessionRepository() })
    const first = new ConnectionActor(world.dependencies)
    await completeAuthenticatedJoin(world.accountId, first, world.dependencies, false)
    const second = new ConnectionActor(world.dependencies)
    await completeAuthenticatedJoin(world.accountId, second, world.dependencies, false)
    expect(loginResults(await collectMessages(second.outbox))).toEqual([LOGIN_RESULT.alreadyLoggedIn])
  })
})
