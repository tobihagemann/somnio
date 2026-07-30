import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectionController, SessionStore } from '@/client'
import type { SessionStorageLike } from '@/client'
import { GameplayTransport } from '@/transport'
import {
  LOGIN_RESULT,
  REGISTER_RESULT,
  SOMNIO_PROTOCOL_CONSTANTS,
  WIRE_ENTITY_TYPE,
  encodeSomnioMessage,
} from '@/protocol'
import type { SomnioMessage, WireSector } from '@/protocol'
import { fakeSocketFactory } from './helpers/fakeSocket'
import type { FakeSocket } from './helpers/fakeSocket'

/** In-memory storage so the session tests never touch a real `localStorage`. */
class MemoryStorage implements SessionStorageLike {
  private readonly map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
}

/**
 * A store that hands out its object, answers reads, and rejects every write.
 *
 * This is the shape the constructor's `try` cannot catch: `QuotaExceededError`, a storage-blocking
 * extension, and Safari's cross-site-tracking prevention inside a frame all permit the property
 * access and then throw from the method. `?.` guards an absent store, not a throwing one.
 */
class WriteRejectingStorage implements SessionStorageLike {
  private readonly map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  setItem(): void {
    throw new Error('QuotaExceededError')
  }
  removeItem(): void {
    throw new Error('QuotaExceededError')
  }
}

function wireSector(name = 'EdariaMitte'): WireSector {
  return {
    name,
    version: 1,
    dimensions: { width: 4, height: 4 },
    floorMaterialID: 'grass-meadow',
    light: { indoor: false, brightness: 100 },
    objects: [],
    collisionMasks: [],
    portals: [],
    npcs: [],
    monsterSpawns: [],
    floorPatches: [],
  }
}

interface Rig {
  controller: ConnectionController
  socket: () => FakeSocket
  storage: SessionStorageLike
  sentTags: () => string[]
  deliver: (message: SomnioMessage) => void
}

function makeRig(options: { storage?: SessionStorageLike } = {}): Rig {
  const { factory, latest } = fakeSocketFactory()
  const transport = new GameplayTransport(factory)
  const storage = options.storage ?? new MemoryStorage()
  const controller = new ConnectionController({
    transport,
    sessionStore: new SessionStore(storage),
    resolveURL: () => 'ws://test/ws',
  })
  // Retries are driven explicitly in the retry test rather than through real timers.
  controller.scheduleResume = () => {}
  return {
    controller,
    socket: latest,
    storage,
    sentTags: () => latest().sent.map((frame) => JSON.parse(frame).tag as string),
    deliver: (message) => latest().deliverText(encodeSomnioMessage(message)),
  }
}

function hello(version: number = SOMNIO_PROTOCOL_CONSTANTS.helloVersion): SomnioMessage {
  return { tag: 'hello', payload: { protocolVersion: version } }
}

describe('connection state machine', () => {
  let rig: Rig

  beforeEach(() => {
    rig = makeRig()
  })

  it('walks disconnected to attached in order', () => {
    expect(rig.controller.connectionState).toBe('disconnected')

    rig.controller.connect({
      kind: 'login',
      credentials: { nickname: 'Saibot', password: 'hunter2', rememberMe: false },
    })
    expect(rig.controller.connectionState).toBe('awaitingHello')

    rig.socket().open()
    rig.deliver(hello())
    expect(rig.controller.connectionState).toBe('awaitingLoginResult')

    rig.deliver({ tag: 'loginResult', payload: { result: 0 } })
    expect(rig.controller.connectionState).toBe('awaitingEnterSector')

    rig.deliver({ tag: 'enterSector', payload: { sector: wireSector() } })
    expect(rig.controller.connectionState).toBe('awaitingEnterSector')

    rig.deliver({ tag: 'mainCharacter', payload: { entityIndex: 7 } })
    expect(rig.controller.connectionState).toBe('attached')
    expect(rig.controller.selfEntityIndex).toBe(7)
  })

  /**
   * `mainCharacter` is the attach marker, not `dateTick`. `dateTick` merely arrives last in the
   * join sequence for unrelated reasons, and keying on it would leave the client unattached
   * through every portal hop that does not re-send one.
   */
  it('attaches on mainCharacter, not on dateTick', () => {
    rig.controller.connect({
      kind: 'login',
      credentials: { nickname: 'a', password: 'b', rememberMe: false },
    })
    rig.socket().open()
    rig.deliver(hello())
    rig.deliver({ tag: 'loginResult', payload: { result: 0 } })
    rig.deliver({ tag: 'enterSector', payload: { sector: wireSector() } })

    rig.deliver({ tag: 'dateTick', payload: { hour: 7, minute: 33 } })
    expect(rig.controller.connectionState).toBe('awaitingEnterSector')

    rig.deliver({ tag: 'mainCharacter', payload: { entityIndex: 1 } })
    expect(rig.controller.connectionState).toBe('attached')
  })

  /**
   * A portal hop must clear sector-local state and drop back to `awaitingEnterSector`, or chat
   * and movement that depend on `selfEntityIndex` fire against the old sector in the gap.
   */
  it('clears sector-local state and returns through awaitingEnterSector on a portal hop', () => {
    rig.controller.connect({
      kind: 'login',
      credentials: { nickname: 'a', password: 'b', rememberMe: false },
    })
    rig.socket().open()
    rig.deliver(hello())
    rig.deliver({ tag: 'loginResult', payload: { result: 0 } })
    rig.deliver({ tag: 'enterSector', payload: { sector: wireSector() } })
    rig.deliver({ tag: 'mainCharacter', payload: { entityIndex: 1 } })
    rig.deliver({
      tag: 'entity',
      payload: {
        entityIndex: 2,
        figure: 0,
        gender: 0,
        maskWidth: 32,
        maskHeight: 48,
        type: 0,
        name: 'Peer',
        x: 10,
        y: 10,
        facing: 0,
        tempo: 2,
      },
    })
    expect(rig.controller.entities.size).toBe(1)
    expect(rig.controller.players).toEqual(['Peer'])

    rig.deliver({ tag: 'enterSector', payload: { sector: wireSector('Nordwiese') } })

    expect(rig.controller.connectionState).toBe('awaitingEnterSector')
    expect(rig.controller.entities.size).toBe(0)
    expect(rig.controller.players).toEqual([])
    expect(rig.controller.selfEntityIndex).toBeUndefined()
    expect(rig.controller.currentSector?.name).toBe('Nordwiese')
  })
})

describe('version gate is strict equality', () => {
  it.each([
    [SOMNIO_PROTOCOL_CONSTANTS.helloVersion + 1, 'clientOutdated'],
    [SOMNIO_PROTOCOL_CONSTANTS.helloVersion - 1, 'serverOutdated'],
  ])('rejects protocol version %i as %s', (version, skew) => {
    const rig = makeRig()
    rig.controller.connect({
      kind: 'login',
      credentials: { nickname: 'a', password: 'b', rememberMe: false },
    })
    rig.socket().open()

    rig.deliver(hello(version))

    expect(rig.controller.connectionState).toBe('disconnected')
    expect(rig.controller.presentedOverlay).toEqual({ kind: 'updateRequired', skew })
  })

  it('accepts the matching version', () => {
    const rig = makeRig()
    rig.controller.connect({
      kind: 'login',
      credentials: { nickname: 'a', password: 'b', rememberMe: false },
    })
    rig.socket().open()
    rig.deliver(hello())
    expect(rig.controller.connectionState).toBe('awaitingLoginResult')
  })
})

describe('tick gating lifecycle', () => {
  /**
   * The failure the Swift enum's own doc comment warns about is a tick that keeps running past
   * teardown, so both halves are asserted: `mainCharacter` opens the gate, and teardown closes it.
   *
   * `connectionState` *is* the gate — `AppShell.onFrame` reads exactly this before calling
   * `runTick`, and the app shell owns the single `requestAnimationFrame` loop that drives the tick
   * and the draw from one timestamp. Asserting a separate flag instead would report a safety
   * property nothing in production consults.
   */
  it('opens on mainCharacter and closes on teardown', () => {
    const rig = makeRig()
    rig.controller.beginSession({
      kind: 'login',
      credentials: { nickname: 'a', password: 'b', rememberMe: false },
    })
    rig.socket().open()
    rig.deliver(hello())
    rig.deliver({ tag: 'loginResult', payload: { result: 0 } })
    rig.deliver({ tag: 'enterSector', payload: { sector: wireSector() } })
    // Not yet ticking, and distinguishable from the closed state below: the join is still in flight.
    expect(rig.controller.connectionState).toBe('awaitingEnterSector')

    rig.deliver({ tag: 'mainCharacter', payload: { entityIndex: 1 } })
    expect(rig.controller.connectionState).toBe('attached')

    rig.socket().deliverClose()
    expect(rig.controller.connectionState).toBe('disconnected')
  })
})

describe('session-token request gating', () => {
  /**
   * The invariant that keeps `helloVersion` at 3: the field is omitted entirely unless the user
   * opted in, so a server never volunteers a tag the client did not ask for.
   */
  it('omits requestSessionToken when the user did not opt in', () => {
    const rig = makeRig()
    rig.controller.connect({
      kind: 'login',
      credentials: { nickname: 'a', password: 'b', rememberMe: false },
    })
    rig.socket().open()
    rig.deliver(hello())

    const login = JSON.parse(rig.socket().sent.at(-1)!)
    expect(login.tag).toBe('login')
    expect('requestSessionToken' in login.payload).toBe(false)
  })

  it('sets requestSessionToken when the user opted in', () => {
    const rig = makeRig()
    rig.controller.connect({ kind: 'login', credentials: { nickname: 'a', password: 'b', rememberMe: true } })
    rig.socket().open()
    rig.deliver(hello())

    const login = JSON.parse(rig.socket().sent.at(-1)!)
    expect(login.payload.requestSessionToken).toBe(true)
  })

  it('stores an issued token and redeems it on the next connect', () => {
    const storage = new MemoryStorage()
    const first = makeRig({ storage })
    first.controller.connect({
      kind: 'login',
      credentials: { nickname: 'a', password: 'b', rememberMe: true },
    })
    first.socket().open()
    first.deliver(hello())
    first.deliver({ tag: 'loginResult', payload: { result: 0 } })
    first.deliver({ tag: 'sessionToken', payload: { token: 'tok-abc', expiresInSeconds: 2_592_000 } })

    const resumed = makeRig({ storage })
    resumed.controller.connect({ kind: 'resume' })
    resumed.socket().open()
    resumed.deliver(hello())

    const frame = JSON.parse(resumed.socket().sent.at(-1)!)
    expect(frame.tag).toBe('redeemSession')
    expect(frame.payload.token).toBe('tok-abc')
  })
})

describe('token failure and revocation', () => {
  /**
   * A rolled-back pre-token server cannot be distinguished from a token-capable one, so any
   * failure during redemption has to mean "token unusable" and degrade to the password form.
   */
  it('discards the token and falls back to the login form on a rejected redeem', () => {
    const storage = new MemoryStorage()
    storage.setItem('somnio.sessionToken', JSON.stringify({ token: 'stale', expiresAt: Date.now() + 60_000 }))
    const rig = makeRig({ storage })
    // Resumed with no credentials, which is the only path that redeems a token.
    expect(rig.controller.resumeStoredSession()).toBe(true)
    rig.socket().open()
    rig.deliver(hello())
    expect(JSON.parse(rig.socket().sent.at(-1)!).tag).toBe('redeemSession')
    rig.deliver({ tag: 'loginResult', payload: { result: 1 } })

    expect(storage.getItem('somnio.sessionToken')).toBeNull()
    expect(rig.controller.presentedOverlay).toEqual({ kind: 'login' })
    // "Bad credentials." would tell a returning player their password is wrong when they never
    // typed one; the client knows this was a resume even though the server does not say so.
    expect(rig.controller.chatHistory.at(-1)).toEqual({ kind: 'sessionExpired' })
  })

  /**
   * Typing credentials claims the machine for that account, so the stored token goes even when
   * "Remember password" is ticked and even when the password turns out to be wrong.
   *
   * The store cannot tell whose token it holds, so "keep it, the password rejection says nothing
   * about the token" is only safe when the token belongs to the same person. On a shared browser it
   * does not: tick the box, mistype, reload, and the previous user's token is redeemed. Clearing
   * costs a returning player one retyped password after a typo; keeping costs an account takeover.
   */
  it('clears the stored token when a password login is rejected, even with rememberMe', () => {
    const storage = new MemoryStorage()
    storage.setItem('somnio.sessionToken', JSON.stringify({ token: 'keep', expiresAt: Date.now() + 60_000 }))
    const rig = makeRig({ storage })
    rig.controller.beginSession({
      kind: 'login',
      credentials: { nickname: 'a', password: 'wrong', rememberMe: true },
    })
    rig.socket().open()
    rig.deliver(hello())
    rig.deliver({ tag: 'loginResult', payload: { result: 1 } })

    expect(storage.getItem('somnio.sessionToken')).toBeNull()
    // And the message is the password one, not the session one: this was never a resume.
    expect(rig.controller.chatHistory.at(-1)).toEqual({ kind: 'badCredentials' })
  })

  /**
   * The same clear on the success path, which is what stops a failed server-side issuance from
   * leaving the *previous* user's token in place: `LoginHandler.issueToken` logs and swallows its
   * errors, so a successful login can legitimately produce no `sessionToken` frame at all.
   */
  it('clears the stored token on an explicit login that is never replaced', () => {
    const storage = new MemoryStorage()
    storage.setItem(
      'somnio.sessionToken',
      JSON.stringify({ token: 'foreign', expiresAt: Date.now() + 60_000 })
    )
    const rig = makeRig({ storage })
    rig.controller.beginSession({
      kind: 'login',
      credentials: { nickname: 'bob', password: 'correct-horse', rememberMe: true },
    })
    rig.socket().open()
    rig.deliver(hello())
    rig.deliver({ tag: 'loginResult', payload: { result: 0 } })

    expect(storage.getItem('somnio.sessionToken')).toBeNull()
  })

  /**
   * The precedence that keeps a shared browser from signing the second user into the first user's
   * account: typed credentials are what reach the wire, and the foreign token is discarded rather
   * than left to hijack the next login too.
   */
  it('prefers typed credentials over a stored token and clears the store', () => {
    const storage = new MemoryStorage()
    storage.setItem('somnio.sessionToken', JSON.stringify({ token: 'alice', expiresAt: Date.now() + 60_000 }))
    const rig = makeRig({ storage })
    rig.controller.beginSession({
      kind: 'login',
      credentials: { nickname: 'bob', password: 'bobpass', rememberMe: false },
    })
    rig.socket().open()
    rig.deliver(hello())

    const frame = JSON.parse(rig.socket().sent.at(-1)!)
    expect(frame.tag).toBe('login')
    expect(frame.payload.nickname).toBe('bob')
    // `rememberMe: false` also has to remove a credential a previous session left behind.
    expect(storage.getItem('somnio.sessionToken')).toBeNull()
  })

  /** An unsolicited token is not persisted, so declining "Remember password" cannot be overridden. */
  it('ignores a sessionToken frame the client did not request', () => {
    const storage = new MemoryStorage()
    const rig = makeRig({ storage })
    rig.controller.beginSession({
      kind: 'login',
      credentials: { nickname: 'a', password: 'b', rememberMe: false },
    })
    rig.socket().open()
    rig.deliver(hello())
    rig.deliver({ tag: 'sessionToken', payload: { token: 'unasked', expiresInSeconds: 60 } })

    expect(storage.getItem('somnio.sessionToken')).toBeNull()
  })

  /**
   * Logout has to leave no working credential behind. Storage is cleared even if the revoke
   * never lands, because a UI claiming a dead session is the fail-open direction.
   */
  it('sends revokeSession on leaveGame and clears storage regardless', () => {
    const storage = new MemoryStorage()
    const rig = makeRig({ storage })
    rig.controller.connect({ kind: 'login', credentials: { nickname: 'a', password: 'b', rememberMe: true } })
    rig.socket().open()
    rig.deliver(hello())
    rig.deliver({ tag: 'loginResult', payload: { result: 0 } })
    rig.deliver({ tag: 'enterSector', payload: { sector: wireSector() } })
    rig.deliver({ tag: 'mainCharacter', payload: { entityIndex: 1 } })
    rig.deliver({ tag: 'sessionToken', payload: { token: 'tok', expiresInSeconds: 100 } })

    rig.controller.leaveGame()

    expect(rig.sentTags()).toContain('revokeSession')
    expect(storage.getItem('somnio.sessionToken')).toBeNull()
  })

  it('drops a locally expired token rather than presenting it', () => {
    const storage = new MemoryStorage()
    storage.setItem('somnio.sessionToken', JSON.stringify({ token: 'old', expiresAt: Date.now() - 1000 }))
    expect(new SessionStore(storage).load()).toBeUndefined()
    expect(storage.getItem('somnio.sessionToken')).toBeNull()
  })

  it('treats corrupt storage as no session', () => {
    const storage = new MemoryStorage()
    storage.setItem('somnio.sessionToken', 'not json')
    expect(new SessionStore(storage).load()).toBeUndefined()
  })
})

/**
 * A throwing store must not escape into the client.
 *
 * There is nothing to catch it anywhere downstream: the raw `onmessage` in `transport/socket.ts`
 * has no `try`, `handleText`'s covers only the decode, and there is no `window.onerror` or
 * `unhandledrejection` handler in `Web/src` or `index.html`. So each of these three writes reaches
 * the player as a different failure — a console-only exception, a dead Log In button, or a blank
 * page — with no assertion failing anywhere.
 */
describe('a storage backend that rejects writes', () => {
  it('reports a failed token save as a chat line rather than throwing out of dispatch', () => {
    const rig = makeRig({ storage: new WriteRejectingStorage() })
    rig.controller.connect({
      kind: 'login',
      credentials: { nickname: 'a', password: 'b', rememberMe: true },
    })
    rig.socket().open()
    rig.deliver(hello())
    rig.deliver({ tag: 'loginResult', payload: { result: LOGIN_RESULT.ok } })

    expect(() =>
      rig.deliver({ tag: 'sessionToken', payload: { token: 'tok', expiresInSeconds: 60 } })
    ).not.toThrow()
    // The browser analogue of the native `.credentialSaveFailed` line: "Remember password" was
    // ticked and nothing was remembered, which the player would otherwise learn on their next visit.
    expect(rig.controller.chatHistory.map((line) => line.kind)).toContain('credentialSaveFailed')
    // The session itself is unaffected — a save failure is a report, not a teardown.
    expect(rig.controller.connectionState).toBe('awaitingEnterSector')
  })

  it('says nothing when the save was never asked for', () => {
    // `rememberMe` unticked means no `save` call at all, so a store that would have refused one
    // must not produce a line about a credential the player did not ask to keep.
    const rig = makeRig({ storage: new WriteRejectingStorage() })
    rig.controller.connect({
      kind: 'login',
      credentials: { nickname: 'a', password: 'b', rememberMe: false },
    })
    rig.socket().open()
    rig.deliver(hello())
    rig.deliver({ tag: 'loginResult', payload: { result: LOGIN_RESULT.ok } })
    rig.deliver({ tag: 'sessionToken', payload: { token: 'tok', expiresInSeconds: 60 } })

    expect(rig.controller.chatHistory.map((line) => line.kind)).not.toContain('credentialSaveFailed')
  })

  it('still opens the socket when the login-submit clear throws', () => {
    // `connect` clears the store *synchronously* before starting the transport, so an escaping
    // throw here aborts before the socket opens and the Log In button silently does nothing.
    const rig = makeRig({ storage: new WriteRejectingStorage() })

    expect(() =>
      rig.controller.connect({
        kind: 'login',
        credentials: { nickname: 'a', password: 'b', rememberMe: true },
      })
    ).not.toThrow()
    expect(rig.controller.connectionState).toBe('awaitingHello')
    expect(rig.sentTags()).toEqual([])
    rig.socket().open()
    rig.deliver(hello())
    expect(rig.sentTags()).toEqual(['login'])
  })

  it('reads an unreadable store as no session', () => {
    // The constructor's `try` covers the property access only; an engine may answer it and then
    // reject `getItem`. `resumeStoredSession` runs at module top level, where a throw is a blank page.
    const store = new SessionStore({
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {},
      removeItem: () => {},
    })

    expect(store.load()).toBeUndefined()
  })

  it('reports whether a save landed', () => {
    // The no-store case (a sandboxed iframe, site data blocked) reports `false` through the same
    // return and is not reachable from here: passing `undefined` takes the constructor's default
    // argument, which is happy-dom's working `localStorage`.
    expect(new SessionStore(new MemoryStorage()).save('tok', 60)).toBe(true)
    expect(new SessionStore(new WriteRejectingStorage()).save('tok', 60)).toBe(false)
  })
})

describe('duplicate-login race on refresh', () => {
  /**
   * A refresh can open the resumed socket before the previous one has unregistered, so login
   * legitimately answers `alreadyLoggedIn` for a moment. The bounded retry rides that out
   * instead of surfacing the error to a user who did nothing wrong.
   */
  it('retries a token resume on alreadyLoggedIn rather than surfacing it', () => {
    const storage = new MemoryStorage()
    storage.setItem('somnio.sessionToken', JSON.stringify({ token: 'tok', expiresAt: Date.now() + 60_000 }))
    const rig = makeRig({ storage })
    let resumes = 0
    rig.controller.scheduleResume = () => {
      resumes += 1
    }

    rig.controller.connect({ kind: 'resume' })
    rig.socket().open()
    rig.deliver(hello())
    rig.deliver({ tag: 'loginResult', payload: { result: 2 } })

    expect(resumes).toBe(1)
    // The race itself must not surface as "Already logged in." — that would be wrong, since the
    // player is not. A "Reconnecting..." line is shown instead so a slow unwind is not a dead screen.
    expect(rig.controller.chatHistory.map((line) => line.kind)).not.toContain('alreadyLoggedIn')
    expect(rig.controller.chatHistory.map((line) => line.kind)).toContain('reconnecting')
    expect(storage.getItem('somnio.sessionToken')).not.toBeNull()
  })

  /**
   * Driven with a **positive** budget and a real reconnect per retry, which is the only shape that
   * catches a counter reset on re-entry: with `maxResumeRetries: 0` the comparison fails on the first
   * response and the counter never has to advance, so an implementation that zeroes it every attempt
   * passes while looping forever in production.
   */
  it('gives up after the retry budget and surfaces alreadyLoggedIn', () => {
    const storage = new MemoryStorage()
    const { factory, latest } = fakeSocketFactory()
    const budget = 2
    const controller = new ConnectionController({
      transport: new GameplayTransport(factory),
      sessionStore: new SessionStore(storage),
      resolveURL: () => 'ws://test/ws',
      maxResumeRetries: budget,
    })
    storage.setItem('somnio.sessionToken', JSON.stringify({ token: 'tok', expiresAt: Date.now() + 60_000 }))

    let resumes = 0
    const alreadyLoggedIn = (): void => {
      latest().open()
      latest().deliverText(encodeSomnioMessage(hello()))
      latest().deliverText(encodeSomnioMessage({ tag: 'loginResult', payload: { result: 2 } }))
    }
    controller.scheduleResume = () => {
      resumes += 1
      controller.connect({ kind: 'resume' })
      alreadyLoggedIn()
    }

    controller.resumeStoredSession()
    alreadyLoggedIn()

    // Exactly `budget` retries, then the give-up path — not an unbounded reconnect loop.
    expect(resumes).toBe(budget)
    expect(controller.chatHistory.map((line) => line.kind)).toContain('alreadyLoggedIn')
    expect(controller.presentedOverlay).toEqual({ kind: 'login' })
  })

  /**
   * The account-takeover shape the *unconditional* store clear does not reach on its own, because
   * the clear sits below `connect`'s state guard.
   *
   * The retry announces itself with a chat line, which repaints the DOM and reveals the login card
   * over the resuming session; a second user types their own credentials into it. By then
   * `scheduleResume` has re-entered `connect`, so the state is no longer `disconnected` — and a
   * guard that returns there discards the credentials *and* skips the clear, leaving the first
   * user's token to redeem. Typing takes longer than the 250 ms retry delay, so this is the ordinary
   * ordering rather than a narrow race.
   */
  it('lets an explicit login override a resume already in flight', () => {
    const storage = new MemoryStorage()
    storage.setItem(
      'somnio.sessionToken',
      JSON.stringify({ token: 'foreign', expiresAt: Date.now() + 60_000 })
    )
    const rig = makeRig({ storage })

    rig.controller.resumeStoredSession()
    rig.socket().open()
    expect(rig.controller.connectionState).not.toBe('disconnected')

    rig.controller.beginSession({
      kind: 'login',
      credentials: { nickname: 'Bob', password: 'hunter2', rememberMe: true },
    })

    // The foreign token is gone and the typed credentials are what reach the wire.
    expect(storage.getItem('somnio.sessionToken')).toBeNull()
    rig.socket().open()
    rig.deliver(hello())
    expect(rig.sentTags()).toContain('login')
    expect(rig.sentTags()).not.toContain('redeemSession')
  })

  /** The credential-free half stays a no-op, so the retry cannot stack connections on itself. */
  it('ignores a credential-free connect while one is already in flight', () => {
    const rig = makeRig()
    rig.controller.connect({
      kind: 'login',
      credentials: { nickname: 'Saibot', password: 'hunter2', rememberMe: false },
    })
    const socketBefore = rig.socket()

    rig.controller.connect({ kind: 'resume' })

    expect(rig.socket()).toBe(socketBefore)
    expect(rig.controller.connectionState).toBe('awaitingHello')
  })

  /** Registration re-enters `connect` with credentials, so the form it just queued must survive. */
  it('keeps a queued registration when it supersedes a connection in flight', () => {
    const rig = makeRig()
    rig.controller.connect({ kind: 'resume' })
    rig.socket().open()

    rig.controller.register({
      nickname: 'Newcomer',
      password: 'hunter2',
      passwordRepeat: 'hunter2',
      characterClass: 0,
      gender: 0,
      email: 'new@example.com',
    })
    rig.socket().open()
    rig.deliver(hello())

    expect(rig.sentTags()).toContain('register')
  })

  /**
   * A login must never inherit a registration form it did not queue.
   *
   * `sendAuth` reads `pendingRegistration` before both other credentials, and cancelling the
   * registration overlay returns to the login card without ending the socket — so a form left
   * behind by an abandoned Sign Up is still live when the next login is typed. On a shared browser
   * that form carries the previous person's nickname and password, so the wire would carry an
   * account-creation request the current user never made while leaving them unauthenticated.
   */
  it('sends the typed login rather than an abandoned registration form', () => {
    const rig = makeRig()
    rig.controller.register({
      nickname: 'Abandoned',
      password: 'hunter2',
      passwordRepeat: 'hunter2',
      characterClass: 0,
      gender: 0,
      email: 'abandoned@example.com',
    })
    rig.socket().open()
    // The overlay is cancelled, which returns to the login card but leaves the socket open — so the
    // state guard below is closed when the credentials arrive.
    expect(rig.controller.connectionState).not.toBe('disconnected')

    rig.controller.beginSession({
      kind: 'login',
      credentials: { nickname: 'Bob', password: 'correct-horse', rememberMe: false },
    })
    rig.socket().open()
    rig.deliver(hello())

    expect(rig.sentTags()).toContain('login')
    expect(rig.sentTags()).not.toContain('register')
    const login = rig
      .socket()
      .sent.map((frame) => JSON.parse(frame) as SomnioMessage)
      .at(-1)
    if (login?.tag !== 'login') throw new Error('expected a login frame')
    expect(login.payload.nickname).toBe('Bob')
  })

  /**
   * The teardown clear, which the register-result path cannot pin: `handleRegisterResult` clears the
   * form itself before calling `teardown`, so that route passes with the teardown clear deleted.
   * Driving a terminal transport event instead reaches the clear directly.
   */
  it('drops a queued registration when the connection fails before the result arrives', () => {
    const rig = makeRig()
    rig.controller.register({
      nickname: 'Interrupted',
      password: 'hunter2',
      passwordRepeat: 'hunter2',
      characterClass: 0,
      gender: 0,
      email: 'interrupted@example.com',
    })
    rig.socket().open()
    rig.socket().deliverClose()

    rig.controller.beginSession({
      kind: 'login',
      credentials: { nickname: 'Bob', password: 'correct-horse', rememberMe: false },
    })
    rig.socket().open()
    rig.deliver(hello())

    expect(rig.sentTags()).toContain('login')
    expect(rig.sentTags()).not.toContain('register')
  })
})

describe('inbound direction check', () => {
  it('treats a client-only tag arriving inbound as a hard error', () => {
    const rig = makeRig()
    rig.controller.connect({
      kind: 'login',
      credentials: { nickname: 'a', password: 'b', rememberMe: false },
    })
    rig.socket().open()
    rig.deliver(hello())

    rig.deliver({ tag: 'clientSay', payload: { entityIndex: 0, text: 'echo' } })

    expect(rig.controller.connectionState).toBe('disconnected')
    expect(rig.controller.chatHistory.at(-1)).toEqual({ kind: 'errorCode', code: 'client_only_tag' })
  })
})

describe('leave removes a departed peer', () => {
  /** Dropping `leave` leaves peers rendered forever — an easy tag to miss. */
  it('removes the entity and the roster row', () => {
    const rig = makeRig()
    rig.controller.connect({
      kind: 'login',
      credentials: { nickname: 'a', password: 'b', rememberMe: false },
    })
    rig.socket().open()
    rig.deliver(hello())
    rig.deliver({ tag: 'loginResult', payload: { result: 0 } })
    rig.deliver({ tag: 'enterSector', payload: { sector: wireSector() } })
    rig.deliver({ tag: 'mainCharacter', payload: { entityIndex: 1 } })
    rig.deliver({
      tag: 'entity',
      payload: {
        entityIndex: 2,
        figure: 0,
        gender: 0,
        maskWidth: 32,
        maskHeight: 48,
        type: 0,
        name: 'Peer',
        x: 10,
        y: 10,
        facing: 0,
        tempo: 2,
      },
    })
    expect(rig.controller.players).toEqual(['Peer'])

    rig.deliver({ tag: 'leave', payload: { entityIndex: 2, leftGame: true } })

    expect(rig.controller.entities.has(2)).toBe(false)
    expect(rig.controller.players).toEqual([])
  })
})

describe('registration', () => {
  let rig: Rig

  beforeEach(() => {
    rig = makeRig()
  })

  function register(): void {
    rig.controller.register({
      nickname: 'Wanda',
      password: 'hunter22',
      passwordRepeat: 'hunter22',
      characterClass: 0,
      gender: 1,
      email: 'wanda@example.invalid',
    })
    rig.socket().open()
    rig.deliver(hello())
  }

  it('authenticates with a register frame carrying the form, not a login', () => {
    register()
    expect(rig.sentTags()).toEqual(['register'])
    const sent = JSON.parse(rig.socket().sent[0]!) as { payload: Record<string, unknown> }
    expect(sent.payload).toEqual({
      nickname: 'Wanda',
      password: 'hunter22',
      passwordRepeat: 'hunter22',
      characterClass: 0,
      gender: 1,
      email: 'wanda@example.invalid',
    })
  })

  /**
   * A stored token authenticates an account that by definition does not exist yet, so redeeming
   * one here would answer `badCredentials` and the account would never be created.
   */
  it('ignores a stored session token', () => {
    // Written through the store rather than as hand-rolled JSON, so the fixture cannot drift from
    // the storage key and quietly turn this case into an assertion about an empty store.
    new SessionStore(rig.storage).save('stored', 600)
    expect(new SessionStore(rig.storage).load()?.token).toBe('stored')
    register()
    expect(rig.sentTags()).toEqual(['register'])
  })

  it('returns to the login overlay on success and reports the outcome', () => {
    const outcomes: string[] = []
    rig.controller.onRegistrationOutcome = (outcome) => outcomes.push(outcome)
    register()
    rig.deliver({ tag: 'registerResult', payload: { result: REGISTER_RESULT.ok } })
    expect(outcomes).toEqual(['ok'])
    expect(rig.controller.presentedOverlay).toEqual({ kind: 'login' })
    expect(rig.controller.connectionState).toBe('disconnected')
  })

  it.each([
    [REGISTER_RESULT.nicknameExists, 'nicknameExists'],
    [REGISTER_RESULT.failure, 'failure'],
    [REGISTER_RESULT.nameNotAllowed, 'nameNotAllowed'],
  ])('leaves the registration overlay up on result %i', (result, expected) => {
    const outcomes: string[] = []
    rig.controller.onRegistrationOutcome = (outcome) => outcomes.push(outcome)
    rig.controller.presentedOverlay = { kind: 'registration' }
    register()
    rig.deliver({ tag: 'registerResult', payload: { result } })
    expect(outcomes).toEqual([expected])
    expect(rig.controller.presentedOverlay).toEqual({ kind: 'registration' })
  })

  /**
   * The pending form is dropped rather than held, so it cannot ride out the *next* hello and
   * silently re-issue a registration the player never asked for a second time.
   */
  it('does not re-issue the registration on a later connect', () => {
    register()
    rig.deliver({ tag: 'registerResult', payload: { result: REGISTER_RESULT.ok } })
    rig.controller.connect({
      kind: 'login',
      credentials: { nickname: 'Wanda', password: 'hunter22', rememberMe: false },
    })
    rig.socket().open()
    rig.deliver(hello())
    expect(rig.sentTags()).toEqual(['login'])
  })
})

describe('roster changes notify the UI', () => {
  /**
   * The players panel re-renders off this hook alone. Without it the roster is only refreshed when
   * something else forces a render, so a peer who joins without saying anything stays invisible in
   * the list while standing in plain sight in the sector.
   */
  function attached(rig: Rig): void {
    rig.controller.connect({
      kind: 'login',
      credentials: { nickname: 'Greta', password: 'hunter22', rememberMe: false },
    })
    rig.socket().open()
    rig.deliver(hello())
    rig.deliver({ tag: 'loginResult', payload: { result: 0 } })
    rig.deliver({ tag: 'enterSector', payload: { sector: wireSector() } })
    rig.deliver({ tag: 'mainCharacter', payload: { entityIndex: 1 } })
  }

  function peer(entityIndex: number, name: string): SomnioMessage {
    return {
      tag: 'entity',
      payload: {
        entityIndex,
        figure: 0,
        gender: 0,
        maskWidth: 32,
        maskHeight: 48,
        type: 0,
        name,
        x: 10,
        y: 10,
        facing: 0,
        tempo: 2,
      },
    }
  }

  it('reports a peer arriving and leaving', () => {
    const rig = makeRig()
    attached(rig)
    let notifications = 0
    rig.controller.onPlayersChanged = () => (notifications += 1)

    rig.deliver(peer(2, 'Tobi'))
    expect(notifications).toBe(1)
    expect(rig.controller.players).toEqual(['Tobi'])

    rig.deliver({ tag: 'leave', payload: { entityIndex: 2, leftGame: true } })
    expect(notifications).toBe(2)
    expect(rig.controller.players).toEqual([])
  })

  /** A re-sent entity frame for a peer already listed is not a roster change. */
  it('stays quiet when the same peer is re-announced', () => {
    const rig = makeRig()
    attached(rig)
    rig.deliver(peer(2, 'Tobi'))
    let notifications = 0
    rig.controller.onPlayersChanged = () => (notifications += 1)
    rig.deliver(peer(2, 'Tobi'))
    expect(notifications).toBe(0)
  })

  /** NPCs and monsters are not players and must not move the count. */
  it('ignores NPC and monster arrivals', () => {
    const rig = makeRig()
    attached(rig)
    let notifications = 0
    rig.controller.onPlayersChanged = () => (notifications += 1)
    for (const type of [WIRE_ENTITY_TYPE.npc, WIRE_ENTITY_TYPE.monster]) {
      const frame = peer(10 + type, 'Libus') as Extract<SomnioMessage, { tag: 'entity' }>
      rig.deliver({ ...frame, payload: { ...frame.payload, type } })
    }
    expect(notifications).toBe(0)
    expect(rig.controller.players).toEqual([])
  })
})

/**
 * A terminal transport failure has to leave the player somewhere they can act.
 *
 * Once attached there is no overlay up, so a bare teardown leaves a frozen world on screen and Esc
 * is deliberately inert while disconnected — the only way out would be reloading the page. Asserting
 * the chat line alone would not catch that: the line is appended either way.
 */
describe('terminal transport failures present a recovery surface', () => {
  function attach(rig: Rig): void {
    rig.controller.beginSession({
      kind: 'login',
      credentials: { nickname: 'a', password: 'b', rememberMe: false },
    })
    rig.socket().open()
    rig.deliver(hello())
    rig.deliver({ tag: 'loginResult', payload: { result: 0 } })
    rig.deliver({ tag: 'enterSector', payload: { sector: wireSector() } })
    rig.deliver({ tag: 'mainCharacter', payload: { entityIndex: 1 } })
  }

  it('returns to the login overlay when the connection drops mid-session', () => {
    const rig = makeRig()
    attach(rig)
    expect(rig.controller.presentedOverlay).toBeUndefined()

    rig.socket().deliverClose()

    expect(rig.controller.connectionState).toBe('disconnected')
    expect(rig.controller.presentedOverlay).toEqual({ kind: 'login' })
    expect(rig.controller.chatHistory.at(-1)).toEqual({ kind: 'connectionLost' })
  })

  it('returns to the login overlay when a binary frame terminates the session', () => {
    const rig = makeRig()
    attach(rig)

    rig.socket().deliverBinary()

    expect(rig.controller.presentedOverlay).toEqual({ kind: 'login' })
  })

  /**
   * The dispatch-side terminal branches need the same recovery as the transport-side ones. They are
   * reached while *attached*, so a bare teardown leaves the last rendered frame of a dead world on
   * screen — and Esc is deliberately inert while disconnected, which leaves a page reload as the
   * only way out.
   */
  it('returns to the login overlay when the server ends this session with leave', () => {
    const rig = makeRig()
    attach(rig)

    rig.deliver({ tag: 'leave', payload: { entityIndex: 1, leftGame: true } })

    expect(rig.controller.connectionState).toBe('disconnected')
    expect(rig.controller.presentedOverlay).toEqual({ kind: 'login' })
  })

  it('returns to the login overlay when a portal hop delivers an out-of-bounds sector', () => {
    const rig = makeRig()
    attach(rig)

    rig.deliver({
      tag: 'enterSector',
      payload: { sector: { ...wireSector(), dimensions: { width: 4096, height: 4096 } } },
    })

    expect(rig.controller.connectionState).toBe('disconnected')
    expect(rig.controller.presentedOverlay).toEqual({ kind: 'login' })
    expect(rig.controller.chatHistory.at(-1)?.kind).toBe('errorCode')
  })
})

describe('transport failures reach the recovery surface', () => {
  /**
   * The two transport-event branches nothing drove: a socket that errors before it opens (the
   * server is down) and a malformed inbound frame. Both must append their chat line *and* recover —
   * without the recovery the tab sits in `awaitingHello` forever, and because a credential-free
   * `connect` no-ops on a live state, even the retry button cannot get out.
   */
  it('recovers when the socket fails before it opens', () => {
    const rig = makeRig()
    rig.controller.connect({
      kind: 'login',
      credentials: { nickname: 'Saibot', password: 'hunter2', rememberMe: false },
    })

    rig.socket().deliverError()

    expect(rig.controller.connectionState).toBe('disconnected')
    expect(rig.controller.presentedOverlay).toEqual({ kind: 'login' })
    expect(rig.controller.chatHistory.map((line) => line.kind)).toContain('serverUnreachable')
  })

  it('recovers when a malformed frame arrives mid-session', () => {
    const rig = makeRig()
    rig.controller.connect({
      kind: 'login',
      credentials: { nickname: 'Saibot', password: 'hunter2', rememberMe: false },
    })
    rig.socket().open()

    rig.socket().deliverText('{ not json')

    expect(rig.controller.connectionState).toBe('disconnected')
    expect(rig.controller.presentedOverlay).toEqual({ kind: 'login' })
    expect(rig.controller.chatHistory.at(-1)?.kind).toBe('errorCode')
  })
})

describe('a resumed session recovers its own display name', () => {
  /**
   * A token resume carries no typed nickname, so `selfDisplayName` stays empty until the self
   * `entity` frame arrives — which is the only authoritative source on that path. Without it every
   * line the player sends renders with an empty sender for the whole session.
   */
  it('takes the display name from the self entity frame', () => {
    const storage = new MemoryStorage()
    storage.setItem('somnio.sessionToken', JSON.stringify({ token: 'tok', expiresAt: Date.now() + 60_000 }))
    const rig = makeRig({ storage })
    // The credential-free resume path: no typed nickname exists for `handleLoginResult` to record.
    rig.controller.resumeStoredSession()
    rig.socket().open()
    rig.deliver(hello())
    rig.deliver({ tag: 'loginResult', payload: { result: 0 } })
    expect(rig.controller.selfDisplayName).toBe('')
    rig.deliver({ tag: 'enterSector', payload: { sector: wireSector() } })
    rig.deliver({ tag: 'mainCharacter', payload: { entityIndex: 1 } })

    rig.deliver({
      tag: 'entity',
      payload: {
        entityIndex: 1,
        figure: 0,
        gender: 0,
        maskWidth: 32,
        maskHeight: 48,
        type: 0,
        name: 'Resumed',
        x: 10,
        y: 10,
        facing: 0,
        tempo: 2,
      },
    })

    expect(rig.controller.selfDisplayName).toBe('Resumed')
    expect(rig.controller.entities.get(1)?.kind).toBe('player')
  })
})

describe('chat scrollback is bounded', () => {
  /**
   * The browser's one divergence from the native array: `renderChat` replaces the whole scrollback
   * subtree on every append, so per-message cost grows with history. Chat is peer-driven with no
   * server-side rate limit, so an unbounded history is a denial of service on every other player's
   * tab rather than untidiness.
   */
  it('drops the oldest lines past the retention cap', () => {
    const rig = makeRig()
    const overCap = 520

    for (let index = 0; index < overCap; index += 1) {
      rig.controller.appendChat({ kind: 'adminBroadcast', message: `line-${index}` })
    }

    expect(rig.controller.chatHistory.length).toBe(500)
    // The *oldest* went, not the newest: trimming the wrong end would keep the length correct while
    // discarding what the player just saw arrive.
    expect(rig.controller.chatHistory.at(0)).toEqual({
      kind: 'adminBroadcast',
      message: `line-${overCap - 500}`,
    })
    expect(rig.controller.chatHistory.at(-1)).toEqual({
      kind: 'adminBroadcast',
      message: `line-${overCap - 1}`,
    })
  })
})

describe('the session store refuses a tampered token', () => {
  /**
   * The store's own cap, distinct from the decoder's cap on the inbound `sessionToken` frame: this
   * one guards a value that was already written and then edited in storage, which no wire check can
   * see. Left unguarded, `resumeStoredSession` reports success, no login overlay is presented, and
   * `encodeSomnioMessage` throws an oversized frame that `send` swallows — leaving the tab in
   * `awaitingLoginResult` with no world, no form, and no error.
   */
  it('clears an over-cap token instead of resuming with it', () => {
    const storage = new MemoryStorage()
    const oversized = 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSessionTokenUTF8Bytes + 1)
    storage.setItem(
      'somnio.sessionToken',
      JSON.stringify({ token: oversized, expiresAt: Date.now() + 60_000 })
    )
    const store = new SessionStore(storage)

    expect(store.load()).toBeUndefined()
    // Self-healing, not merely refusing: a token that can never be used must not sit in storage
    // failing the same check on every page load.
    expect(storage.getItem('somnio.sessionToken')).toBeNull()
  })
})

describe('end of session identity', () => {
  it('drops the typed credentials, not only the stored token', () => {
    const rig = makeRig()
    let formCleared = 0
    rig.controller.onSessionIdentityEnded = () => {
      formCleared += 1
    }
    rig.controller.beginSession({
      kind: 'login',
      credentials: { nickname: 'Alice', password: 'alice-secret', rememberMe: true },
    })
    rig.socket().open()
    rig.deliver(hello())
    rig.deliver({ tag: 'loginResult', payload: { result: 0 } })
    rig.deliver({ tag: 'sessionToken', payload: { token: 'alice-token', expiresInSeconds: 60 } })

    // Set from the credentials on a successful login, so it names the departing player.
    expect(rig.controller.selfDisplayName).toBe('Alice')

    rig.controller.leaveGame()

    expect(formCleared).toBe(1)
    expect(rig.controller.sessionStore.load()).toBeUndefined()
    expect(rig.controller.selfDisplayName).toBe('')

    // The wire is the observable that matters: a resume after logout must not be able to
    // re-authenticate as the departing player, which is what a surviving `credentials` would do.
    rig.controller.beginSession({ kind: 'resume' })
    rig.socket().open()
    rig.deliver(hello())
    const frames = rig.socket().sent.map((frame) => JSON.parse(frame) as { tag: string })
    expect(frames.some((frame) => frame.tag === 'login')).toBe(false)
    expect(frames.some((frame) => frame.tag === 'redeemSession')).toBe(false)
  })

  it('ends the identity when the server revokes the session', () => {
    const rig = makeRig()
    let formCleared = 0
    rig.controller.onSessionIdentityEnded = () => {
      formCleared += 1
    }
    rig.controller.beginSession({
      kind: 'login',
      credentials: { nickname: 'Bob', password: 'bob-secret', rememberMe: true },
    })
    rig.socket().open()
    rig.deliver(hello())
    rig.deliver({ tag: 'loginResult', payload: { result: 0 } })
    rig.deliver({ tag: 'sessionToken', payload: { token: 'bob-token', expiresInSeconds: 60 } })

    rig.deliver({ tag: 'sessionRevoked', payload: { revoked: true } })

    expect(formCleared).toBe(1)
    expect(rig.controller.sessionStore.load()).toBeUndefined()
    // The rest of what the identity carried, on the one path that reaches `endSessionIdentity`
    // *without* a following `teardown`: everything asserted below is cleared by that method alone
    // here, where `leaveGame` would have had teardown clear it a moment later anyway.
    expect(rig.controller.chatHistory).toEqual([])
    expect(rig.controller.selfDisplayName).toBe('')
  })

  it('drops a queued registration on teardown, with no later clear to mask it', () => {
    const rig = makeRig()
    rig.controller.register({
      nickname: 'Carol',
      password: 'carol-secret',
      passwordRepeat: 'carol-secret',
      characterClass: 1,
      gender: 1,
      email: 'carol@example.invalid',
    })
    rig.socket().open()
    // A terminal transport event, so `teardown` is the only thing that can clear the form —
    // `handleRegisterResult` clears it before its own teardown, and a credentialed retry would
    // clear it a second time, either of which would mask the loss of that clear.
    rig.socket().deliverClose()
    rig.controller.beginSession({ kind: 'resume' })
    rig.socket().open()
    rig.deliver(hello())

    const tags = rig.socket().sent.map((frame) => JSON.parse(frame).tag as string)
    expect(tags).not.toContain('register')
  })

  it('does not re-issue a queued registration after an explicit logout', () => {
    // End-to-end, and attributed carefully: `leaveGame` calls `endSessionIdentity` *and* then
    // `teardown`, and both clear `pendingRegistration`, so this pins the outcome rather than either
    // line. Removing `endSessionIdentity`'s clear alone leaves the suite green — teardown covers it
    // on every path that can reach `sendAuth`, which is why the redundancy is invisible. It stays as
    // defence for the `sessionRevoked` path, which ends the identity with the socket still live.
    const rig = makeRig()
    rig.controller.register({
      nickname: 'Dora',
      password: 'dora-secret',
      passwordRepeat: 'dora-secret',
      characterClass: 1,
      gender: 1,
      email: 'dora@example.invalid',
    })
    rig.socket().open()
    rig.controller.leaveGame()

    rig.controller.beginSession({ kind: 'resume' })
    rig.socket().open()
    rig.deliver(hello())

    const tags = rig.socket().sent.map((frame) => JSON.parse(frame).tag as string)
    expect(tags).not.toContain('register')
  })

  it('does not redeem the resumed token again after an explicit logout', () => {
    // `resumingWithToken` is read by `sendAuth` before `credentials`, so a copy surviving the logout
    // would re-authenticate the departing player even with the store cleared. Same attribution
    // caveat as above: `teardown` clears the field too, and the store clear alone would already
    // starve the retry, so this pins the outcome and not one particular line.
    const storage = new MemoryStorage()
    const rig = makeRig({ storage })
    storage.setItem(
      'somnio.sessionToken',
      JSON.stringify({ token: 'eve-token', expiresAt: Date.now() + 60_000 })
    )

    rig.controller.beginSession()
    rig.socket().open()
    // Left mid-resume on purpose: the redeem is in flight, so `resumingWithToken` is populated.
    rig.deliver(hello())
    expect(rig.socket().sent.map((frame) => JSON.parse(frame).tag as string)).toContain('redeemSession')

    rig.controller.leaveGame()

    rig.controller.beginSession({ kind: 'resume' })
    rig.socket().open()
    rig.deliver(hello())
    const tags = rig.socket().sent.map((frame) => JSON.parse(frame).tag as string)
    expect(tags).not.toContain('redeemSession')
  })

  /**
   * Leave Game is reachable in both post-login states, not only `attached`: the game menu opens
   * whenever no overlay is presented, and `handleEnterSector` clears the overlay while dropping
   * back to `awaitingEnterSector` on every sector load and portal hop. The server accepts
   * `revokeSession` from registration onward, so a gate that only fired on `attached` skipped the
   * revoke on a hop while still clearing the store — leaving a token alive for its full lifetime
   * with nothing left that could revoke it.
   */
  it('revokes the token when leaving before the sector arrives, not only once attached', () => {
    const rig = makeRig()

    rig.controller.beginSession({
      kind: 'login',
      credentials: { nickname: 'Ida', password: 'hunter2-long', rememberMe: true },
    })
    rig.socket().open()
    rig.deliver(hello())
    // Issued during the session — `connect` clears the store on an explicit login, so a token
    // seeded beforehand would not survive to be revoked.
    rig.deliver({ tag: 'sessionToken', payload: { token: 'hop-token', expiresInSeconds: 2_592_000 } })
    // Authenticated but still waiting on the sector — the state a portal hop returns to.
    rig.deliver({ tag: 'loginResult', payload: { result: 0 } })

    rig.controller.leaveGame()

    expect(rig.sentTags()).toContain('revokeSession')
  })

  /**
   * A teardown from a *login* has to drop the credentials too, not just a pending registration.
   * `resume` is documented credential-free and `sendAuth` falls back to whatever `credentials`
   * still holds, so a surviving pair makes the next resume silently re-authenticate the departing
   * player — and the `updateRequired` card's only control is exactly that resume.
   */
  it('does not re-authenticate the previous player when a login teardown is retried', () => {
    const rig = makeRig()

    rig.controller.beginSession({
      kind: 'login',
      credentials: { nickname: 'Ida', password: 'hunter2-long', rememberMe: false },
    })
    rig.socket().open()
    // Version skew tears the session down and presents the update card.
    rig.deliver(hello(SOMNIO_PROTOCOL_CONSTANTS.helloVersion + 1))

    // "Try Again" — a credential-free resume, which must not find Ida's password still in hand.
    rig.controller.beginSession({ kind: 'resume' })
    rig.socket().open()
    rig.deliver(hello())

    expect(rig.sentTags()).not.toContain('login')
  })

  it('stores the lifetime the server issued, not a substitute', () => {
    // A wrong lifetime has no symptom until it bites: too short and the browser drops a live
    // token, too long and it keeps offering a dead one, and either way the only thing the player
    // sees is a resume that answers `badCredentials`.
    const storage = new MemoryStorage()
    const rig = makeRig({ storage })
    rig.controller.beginSession({
      kind: 'login',
      credentials: { nickname: 'Ivan', password: 'ivan-secret', rememberMe: true },
    })
    rig.socket().open()
    rig.deliver(hello())
    rig.deliver({ tag: 'loginResult', payload: { result: 0 } })

    const before = Date.now()
    rig.deliver({ tag: 'sessionToken', payload: { token: 'ivan-token', expiresInSeconds: 2_592_000 } })

    const stored = rig.controller.sessionStore.load()
    expect(stored?.token).toBe('ivan-token')
    expect(stored!.expiresAt - before).toBeGreaterThanOrEqual(2_592_000 * 1000 - 1000)
  })

  it('clears the chat scrollback, which the next person at a shared browser would read', () => {
    const rig = makeRig()
    rig.controller.beginSession({
      kind: 'login',
      credentials: { nickname: 'Frank', password: 'frank-secret', rememberMe: false },
    })
    rig.socket().open()
    rig.deliver(hello())
    // A line the controller owns. Peer and NPC speech is forwarded to the session rather than
    // appended here, so a `serverSay` would not reach this scrollback in a controller-only rig.
    rig.deliver({ tag: 'loginResult', payload: { result: LOGIN_RESULT.badCredentials } })
    expect(rig.controller.chatHistory.length).toBeGreaterThan(0)

    rig.controller.leaveGame()

    expect(rig.controller.chatHistory).toEqual([])
    expect(rig.controller.selfDisplayName).toBe('')
  })
})

describe('an explicit authentication retires a resume already scheduled', () => {
  // The one place the real 250 ms timer is driven. Every other retry test replaces
  // `scheduleResume`, which is exactly why the generation counter it guards went unpinned: a
  // synchronous stand-in never gives the comparison two competing authentications to arbitrate.
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function rigWithRealTimer(storage: MemoryStorage): Rig {
    const { factory, latest } = fakeSocketFactory()
    const transport = new GameplayTransport(factory)
    const controller = new ConnectionController({
      transport,
      sessionStore: new SessionStore(storage),
      resolveURL: () => 'ws://test/ws',
    })
    return {
      controller,
      socket: latest,
      storage,
      sentTags: () => latest().sent.map((frame) => JSON.parse(frame).tag as string),
      deliver: (message) => latest().deliverText(encodeSomnioMessage(message)),
    }
  }

  it('does not let the superseded resume erase a sign-up queued inside its window', () => {
    // A registration, not a login, because that is where the damage is observable: a credential-free
    // resume that reaches `connect` finds the socket already live and takes the early return, whose
    // first act is to drop `pendingRegistration`. The sign-up then leaves as a `login` for an
    // account that was never created.
    const storage = new MemoryStorage()
    storage.setItem('somnio.sessionToken', JSON.stringify({ token: 'stale', expiresAt: Date.now() + 60_000 }))
    const rig = rigWithRealTimer(storage)

    rig.controller.beginSession()
    rig.socket().open()
    rig.deliver(hello())
    // Schedules the 250 ms resume and returns to `disconnected`, leaving the card usable.
    rig.deliver({ tag: 'loginResult', payload: { result: LOGIN_RESULT.alreadyLoggedIn } })

    rig.controller.register({
      nickname: 'Grace',
      password: 'grace-secret',
      passwordRepeat: 'grace-secret',
      characterClass: 1,
      gender: 1,
      email: 'grace@example.invalid',
    })
    rig.socket().open()

    // The superseded resume fires. It must not touch the attempt that replaced it.
    vi.advanceTimersByTime(250)

    rig.deliver(hello())
    const frames = rig.socket().sent.map((frame) => JSON.parse(frame) as { tag: string })
    expect(frames.some((frame) => frame.tag === 'register')).toBe(true)
    expect(frames.some((frame) => frame.tag === 'login')).toBe(false)
  })
})

describe('a torn-down registration does not become a login', () => {
  /**
   * The version gate is the reachable trigger and it is not hypothetical: production runs protocol
   * 2 while this branch is on 3, so a skewed `hello` is what every player meets until the server
   * ships. `teardown` drops the queued form; the credentials `connect` derived *from* that form
   * must go with it, or the retry authenticates as an account the server never created and the
   * player is told their own password is wrong.
   */
  it('returns to the login card after a version-skewed sign-up rather than sending login', () => {
    const rig = makeRig()
    rig.controller.register({
      nickname: 'Judy',
      password: 'judy-secret',
      passwordRepeat: 'judy-secret',
      characterClass: 1,
      gender: 1,
      email: 'judy@example.invalid',
    })
    rig.socket().open()
    // A server one protocol version behind, which is what tears the attempt down.
    rig.deliver(hello(SOMNIO_PROTOCOL_CONSTANTS.helloVersion - 1))

    // "Try Again" on the update-required card: a credential-free resume.
    rig.controller.beginSession()
    rig.socket().open()
    rig.deliver(hello())

    const tags = rig.socket().sent.map((frame) => JSON.parse(frame).tag as string)
    expect(tags).not.toContain('login')
    expect(tags).not.toContain('register')
    expect(rig.controller.presentedOverlay).toEqual({ kind: 'login' })
  })
})

describe('the online roster is bounded', () => {
  it('stops growing when a peer re-announces one index under fresh names', () => {
    // The roster dedupes by name and `leave` removes only the name an index currently carries, so
    // a server re-announcing one entity grows it without limit — each append re-sorting and
    // rebuilding the panel until the tab locks up.
    const rig = makeRig()
    rig.controller.beginSession({
      kind: 'login',
      credentials: { nickname: 'Heidi', password: 'heidi-secret', rememberMe: false },
    })
    rig.socket().open()
    rig.deliver(hello())
    rig.deliver({ tag: 'loginResult', payload: { result: 0 } })
    rig.deliver({ tag: 'enterSector', payload: { sector: wireSector() } })
    rig.deliver({ tag: 'mainCharacter', payload: { entityIndex: 1 } })

    // Literals on both sides, as the sibling `MAX_RETAINED_CHAT_LINES` test does. Driving the
    // constant + 50 and asserting the constant reads the same symbol twice, so the assertion
    // holds for any value it takes — including one small enough to truncate a busy sector's
    // roster. (That symmetry is also why the constant needs no export.)
    for (let index = 0; index < 550; index += 1) {
      rig.deliver({
        tag: 'entity',
        payload: {
          entityIndex: 7,
          figure: 0,
          gender: 0,
          maskWidth: 32,
          maskHeight: 48,
          // Index 7 is not `mainCharacter`'s 1, so this decodes as a peer rather than as self.
          type: WIRE_ENTITY_TYPE.player,
          name: `Peer${index}`,
          x: 10,
          y: 10,
          facing: 0,
          tempo: 2,
        },
      })
    }

    expect(rig.controller.players.length).toBe(500)
  })
})
