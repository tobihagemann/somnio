import { describe, expect, it } from 'vitest'
import { encodeSomnioMessage } from '@somnio/protocol'
import type { SessionRepository } from '@somnio/data'
import { ConnectionActor } from '../src/connection/connectionActor.ts'
import type { ConnectionSocket } from '../src/connection/connectionActor.ts'
import { makeOneSectorWorld } from './support/oneSectorWorld.ts'
import { makeCharacter, makeSector } from './support/sectorFactory.ts'
import { makeStubConnectionDependencies } from './support/stubDependencies.ts'
import { StubCharacterRepository } from './support/stubRepositories.ts'

/** A character repository whose checkpoint write blocks until released. */
class GatedCharacterRepository extends StubCharacterRepository {
  private gate: Deferred<void> | undefined

  hold(): void {
    this.gate = deferred()
  }

  release(): void {
    this.gate?.resolve()
    this.gate = undefined
  }

  override async persistCheckpoint(): Promise<boolean> {
    if (this.gate !== undefined) await this.gate.promise
    return false
  }
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** A session repository whose `redeem` blocks until the test releases it, recording each call. */
class GatedSessionRepository implements SessionRepository {
  readonly calls: string[] = []
  /** When set, every redemption resolves to this account instead of `undefined`. */
  resolveTo: string | undefined
  private gate: Deferred<void> | undefined

  hold(): void {
    this.gate = deferred()
  }

  release(): void {
    this.gate?.resolve()
    this.gate = undefined
  }

  issue(): Promise<never> {
    return Promise.reject(new Error('unused'))
  }

  async redeem(token: string) {
    this.calls.push(token)
    if (this.gate !== undefined) await this.gate.promise
    if (this.resolveTo === undefined) return undefined
    return { accountId: this.resolveTo, expiresAt: new Date(Date.now() + 60_000) }
  }

  revoke(): Promise<boolean> {
    return Promise.resolve(false)
  }

  deleteExpired(): Promise<number> {
    return Promise.resolve(0)
  }
}

/** A recording socket double: sends, closes, and pause/resume transitions land in one ordered log. */
class RecordingSocket implements ConnectionSocket {
  readonly events: string[] = []
  /** When set, every send hangs forever: a peer whose receive window never reopens. */
  stallSends = false
  private messageListener: ((data: string | Uint8Array, isBinary: boolean) => void) | undefined
  private closeListener: (() => void) | undefined

  send(frame: string): Promise<void> {
    this.events.push(`send:${JSON.parse(frame).tag}`)
    return this.stallSends ? new Promise(() => {}) : Promise.resolve()
  }

  close(code: number): void {
    this.events.push(`close:${code}`)
  }

  pause(): void {
    this.events.push('pause')
  }

  resume(): void {
    this.events.push('resume')
  }

  onMessage(listener: (data: string | Uint8Array, isBinary: boolean) => void): void {
    this.messageListener = listener
  }

  onClose(listener: () => void): void {
    this.closeListener = listener
  }

  deliver(text: string): void {
    this.messageListener?.(text, false)
  }

  peerClose(): void {
    this.closeListener?.()
  }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('inbound sequencing', () => {
  it('a handler awaiting a deferred repository call is not interleaved with the next frame', async () => {
    const sessions = new GatedSessionRepository()
    const socket = new RecordingSocket()
    const connection = new ConnectionActor(await makeStubConnectionDependencies({ sessions }))
    const run = connection.runConnection(socket)
    await settle()

    sessions.hold()
    socket.deliver(encodeSomnioMessage({ tag: 'redeemSession', payload: { token: 'first' } }))
    socket.deliver(encodeSomnioMessage({ tag: 'redeemSession', payload: { token: 'second' } }))
    await settle()
    // The socket was paused for the first handler and the second frame has not reached the repository.
    expect(socket.events).toContain('pause')
    expect(socket.events).not.toContain('resume')
    expect(sessions.calls).toEqual(['first'])

    sessions.release()
    await settle()
    await settle()
    expect(sessions.calls).toEqual(['first', 'second'])
    expect(socket.events.at(-1)).toBe('resume')

    socket.peerClose()
    await run
  })

  it('frames parsed before the pause are drained in order and the queue is discarded on close', async () => {
    const sessions = new GatedSessionRepository()
    const socket = new RecordingSocket()
    const connection = new ConnectionActor(await makeStubConnectionDependencies({ sessions }))
    const run = connection.runConnection(socket)
    await settle()

    sessions.hold()
    for (const token of ['a', 'b', 'c']) {
      socket.deliver(encodeSomnioMessage({ tag: 'redeemSession', payload: { token } }))
    }
    await settle()
    expect(sessions.calls).toEqual(['a'])
    // The peer goes away while `b` and `c` are still queued: they are dropped, not handled.
    socket.peerClose()
    sessions.release()
    await run
    expect(sessions.calls).toEqual(['a'])
  })

  /**
   * The peer leaves while a redemption is still awaiting the repository and the redemption then
   * succeeds: the connection's exit path has to outlast the handler, or the join it completes
   * attaches a player nothing can ever detach.
   */
  it('a successful redemption completing after the peer closed leaves no player behind', async () => {
    const sessions = new GatedSessionRepository()
    const socket = new RecordingSocket()
    const world = await makeOneSectorWorld({ sessions })
    sessions.resolveTo = world.accountId
    const connection = new ConnectionActor(world.dependencies)
    const run = connection.runConnection(socket)
    await settle()

    sessions.hold()
    socket.deliver(encodeSomnioMessage({ tag: 'redeemSession', payload: { token: 'late' } }))
    await settle()
    expect(sessions.calls).toEqual(['late'])
    socket.peerClose()
    let exited = false
    void run.then(() => {
      exited = true
    })
    await settle()
    // Not yet: the handler is still in flight.
    expect(exited).toBe(false)

    sessions.release()
    await run
    expect(connection.state.kind).toBe('awaitingLogin')
    expect(world.dependencies.worldRouter.loggedInPlayerCount()).toBe(0)
    // Detached from the sector and the account slot released, not merely a reset actor state.
    expect(world.dependencies.worldRouter.sector('A')?.snapshotForCheckpoint()).toEqual([])
    expect(
      world.dependencies.worldRouter.register(
        new ConnectionActor(world.dependencies),
        world.accountId,
        'tester'
      )
    ).toBe(true)
  })

  /** The shutdown drain waits for the exit path: the socket receives the 1001 close before the drain resolves. */
  it('a shutdown drain waits for the exit path to close the socket', async () => {
    const sessions = new GatedSessionRepository()
    const socket = new RecordingSocket()
    const world = await makeOneSectorWorld({ sessions })
    sessions.resolveTo = world.accountId
    const connection = new ConnectionActor(world.dependencies)
    const run = connection.runConnection(socket)
    await settle()
    socket.deliver(encodeSomnioMessage({ tag: 'redeemSession', payload: { token: 'ok' } }))
    await settle()
    await settle()
    expect(connection.state.kind).toBe('attached')

    await connection.drainForShutdown()
    expect(socket.events.at(-1)).toBe('close:1001')
    expect(world.dependencies.worldRouter.sector('A')?.snapshotForCheckpoint()).toEqual([])
    await run
  })

  /**
   * A portal hop arriving while the drain's checkpoint write is pending must not outlive the
   * cleanup: the drain ends the loop first, so the hop is discarded and one cleanup path detaches
   * whatever sector the player is in.
   */
  it('a portal hop racing the shutdown snapshot leaves no player in either sector', async () => {
    const sessions = new GatedSessionRepository()
    const accountId = crypto.randomUUID()
    sessions.resolveTo = accountId
    const characters = new GatedCharacterRepository(
      new Map([[accountId, [makeCharacter({ x: 64, y: 64 }, 'hopper', 'A')]]])
    )
    const dependencies = await makeStubConnectionDependencies({
      sessions,
      characters,
      sectors: new Map([
        [
          'A',
          makeSector('A', {
            portals: [
              { x: 0, y: 0, width: 256, height: 256, targetSectorName: 'B', direction: 'outboundTrigger' },
            ],
          }),
        ],
        ['B', makeSector('B')],
      ]),
    })
    const socket = new RecordingSocket()
    const connection = new ConnectionActor(dependencies)
    const run = connection.runConnection(socket)
    await settle()
    socket.deliver(encodeSomnioMessage({ tag: 'redeemSession', payload: { token: 'ok' } }))
    await settle()
    await settle()
    expect(connection.state.kind).toBe('attached')

    characters.hold()
    const drain = connection.drainForShutdown()
    socket.deliver(encodeSomnioMessage({ tag: 'enterPortal', payload: { portalIndex: 0 } }))
    await settle()
    characters.release()
    await drain
    await run
    expect(connection.state.kind).toBe('awaitingLogin')
    expect(dependencies.worldRouter.sector('A')?.snapshotForCheckpoint()).toEqual([])
    expect(dependencies.worldRouter.sector('B')?.snapshotForCheckpoint()).toEqual([])
  })

  it('a shutdown drain is bounded when the socket never finishes writing', async () => {
    const sessions = new GatedSessionRepository()
    const socket = new RecordingSocket()
    socket.stallSends = true
    const connection = new ConnectionActor(await makeStubConnectionDependencies({ sessions }))
    void connection.runConnection(socket)
    await settle()
    const started = Date.now()
    await connection.drainForShutdown(50)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('a close decision mid-drain ends the loop without resuming the socket', async () => {
    const socket = new RecordingSocket()
    const connection = new ConnectionActor(await makeStubConnectionDependencies())
    const run = connection.runConnection(socket)
    await settle()
    socket.deliver('not json')
    socket.deliver(encodeSomnioMessage({ tag: 'redeemSession', payload: { token: 'late' } }))
    await run
    expect(socket.events).toContain('close:1002')
    expect(socket.events).not.toContain('resume')
  })
})
