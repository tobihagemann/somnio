import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LOGIN_RESULT, REGISTER_RESULT } from '@somnio/protocol'
import {
  SOMNIO_CONSTANTS,
  TEMPO,
  feetCenter,
  feetRect,
  headingFromCardinal,
  npcRuntimePosition,
} from '@somnio/core'
import { PostgresCharacterRepository, PostgresWorldClockRepository } from '@somnio/data'
import { CLOSE_GOING_AWAY } from '../../src/connection/connectionActor.ts'
import { TestClient } from '../support/liveServer.ts'
import {
  bootTestServer,
  closeAndAwaitCleanup,
  fixtureSectors,
  frame,
  joinFreshPlayer,
  loginOverWire,
  nearestClearOrigin,
  registerFrame,
  selfPosition,
  startDatabase,
  uniqueNickname,
} from './support/harness.ts'
import type { DatabaseHarness, TestServer } from './support/harness.ts'

let harness: DatabaseHarness
let server: TestServer
const bibliothek = fixtureSectors().get('EdariaBibliothek')!

beforeAll(async () => {
  harness = await startDatabase()
  // second 50 / minute 11 with a 20 ms tick: the clock crosses into minute 12 (a broadcast mark)
  // 200 ms in, leaving the client time to log in and reach the attached state.
  await new PostgresWorldClockRepository(harness.db).save({
    second: 50,
    minute: 11,
    hour: 12,
    day: 1,
    month: 1,
    year: 500,
  })
  server = await bootTestServer(harness.url, { worldClockIntervalMs: 20 })
})
afterAll(async () => {
  await server.stop()
  await harness.stop()
})

describe('gameplay end to end', () => {
  it('register then login flow surfaces success codes', async () => {
    const nickname = uniqueNickname('alice')
    const client = await TestClient.open(server.url)
    await client.next()
    client.send(registerFrame(nickname))
    expect(await client.next()).toEqual({ tag: 'registerResult', payload: { result: REGISTER_RESULT.ok } })
    client.send(frame({ tag: 'login', payload: { nickname, password: 'secret-pass' } }))
    expect(await client.next()).toEqual({ tag: 'loginResult', payload: { result: LOGIN_RESULT.ok } })
    await client.close()
  })

  it('a position update propagates to a peer in the same sector and never echoes to the mover', async () => {
    const listener = await joinFreshPlayer(server.url, 'peer-a')
    const mover = await joinFreshPlayer(server.url, 'peer-b')
    const listenerFeet = feetRect(selfPosition(listener), SOMNIO_CONSTANTS.playerSpriteSize)
    const libusFeet = feetRect(npcRuntimePosition(bibliothek.npcs[0]!), bibliothek.npcs[0]!.maskSize)
    const target = nearestClearOrigin(bibliothek, { x: 256, y: 256 }, [listenerFeet, libusFeet])!
    mover.client.send(
      frame({
        tag: 'clientPosition',
        payload: {
          entityIndex: 0,
          x: target.x,
          y: target.y,
          facing: headingFromCardinal('east'),
          tempo: TEMPO.default,
        },
      })
    )
    const { target: observed } = await listener.client.until('serverPosition')
    expect(observed).toMatchObject({
      tag: 'serverPosition',
      payload: { entityIndex: mover.entityIndex, x: target.x, y: target.y },
    })
    // Anything the mover received after its join is not its own position echoed back.
    mover.client.send(frame({ tag: 'revokeSession', payload: { token: 'probe' } }))
    const { before } = await mover.client.until('sessionRevoked')
    expect(
      before.filter(
        (message) => message.tag === 'serverPosition' && message.payload.entityIndex === mover.entityIndex
      )
    ).toEqual([])
    await mover.client.close()
    await listener.client.close()
  })

  it('a sector switch via portal moves the player and broadcasts leave', async () => {
    const triggerIndex = bibliothek.portals.findIndex((portal) => portal.direction === 'outboundTrigger')
    const stayer = await joinFreshPlayer(server.url, 'stay')
    const hopper = await joinFreshPlayer(server.url, 'hop')
    hopper.client.send(frame({ tag: 'enterPortal', payload: { portalIndex: triggerIndex } }))
    const { target } = await hopper.client.until('enterSector')
    expect(target.tag === 'enterSector' && target.payload.sector.name).toBe(
      bibliothek.portals[triggerIndex]!.targetSectorName
    )
    const { target: leave } = await stayer.client.until('leave')
    expect(leave).toEqual({ tag: 'leave', payload: { entityIndex: hopper.entityIndex, leftGame: false } })
    await hopper.client.close()
    await stayer.client.close()
  })

  it('an NPC bump triggers a say frame from the configured dialog cursor', async () => {
    const libus = bibliothek.npcs[0]!
    const runtime = npcRuntimePosition(libus)
    const target = nearestClearOrigin(
      bibliothek,
      feetCenter(runtime, libus.maskSize),
      [feetRect(runtime, libus.maskSize)],
      SOMNIO_CONSTANTS.npcInteractionRadius
    )!
    const bumper = await joinFreshPlayer(server.url, 'bumper')
    bumper.client.send(
      frame({
        tag: 'clientPosition',
        payload: {
          entityIndex: 0,
          x: target.x,
          y: target.y,
          facing: headingFromCardinal('north'),
          tempo: TEMPO.default,
        },
      })
    )
    bumper.client.send(frame({ tag: 'bumpNPC', payload: { npcIndex: 1 } }))
    const { target: say } = await bumper.client.until('serverSay')
    expect(say.tag === 'serverSay' && say.payload.entityIndex).toBe(1)
    expect(say.tag === 'serverSay' && say.payload.text.length).toBeGreaterThan(0)
    await bumper.client.close()
  })

  it('world clock ticks broadcast dateTick frames to connected clients', async () => {
    // At 20 ms per in-game second the next broadcast mark is at most 12 in-game minutes (14.4 s) away.
    const ticker = await joinFreshPlayer(server.url, 'ticker')
    const { target } = await ticker.client.until('dateTick', 30_000)
    expect(target.tag).toBe('dateTick')
    await ticker.client.close()
  })

  it('graceful shutdown drains in-flight frames before closing connections', async () => {
    const local = await startDatabase()
    const own = await bootTestServer(local.url)
    try {
      const nickname = uniqueNickname('drainer')
      const client = await TestClient.open(own.url)
      await client.next()
      client.send(registerFrame(nickname))
      await client.until('registerResult')
      client.send(frame({ tag: 'login', payload: { nickname, password: 'secret-pass' } }))
      await client.until('dateTick')
      const characters = new PostgresCharacterRepository(local.db)
      const beforeShutdown = (await characters.findByName(nickname))!.lastSeen
      const shutdown = own.server.shutdown()
      const closed = await client.closed
      await shutdown
      expect([CLOSE_GOING_AWAY, 1000]).toContain(closed.code)
      // The drain's snapshot landed: the shutdown checkpoint advanced the row, not only the close.
      const afterShutdown = (await characters.findByName(nickname))!.lastSeen
      expect(afterShutdown.getTime()).toBeGreaterThan(beforeShutdown.getTime())
    } finally {
      own.logging.cleanup()
      await local.stop()
    }
  })

  it('a login requesting a session token can resume without a password', async () => {
    const nickname = uniqueNickname('resumer')
    const client = await TestClient.open(server.url)
    await client.next()
    client.send(registerFrame(nickname))
    await client.until('registerResult')
    await client.close()
    const first = await loginOverWire(server.url, nickname, { requestSessionToken: true })
    const token = first.join.find((message) => message.tag === 'sessionToken')
    expect(token?.tag).toBe('sessionToken')
    await closeAndAwaitCleanup(first, server)
    const second = await TestClient.open(server.url)
    await second.next()
    if (token?.tag === 'sessionToken')
      second.send(frame({ tag: 'redeemSession', payload: { token: token.payload.token } }))
    expect(await second.next()).toEqual({ tag: 'loginResult', payload: { result: LOGIN_RESULT.ok } })
    await second.close()
  })
})
