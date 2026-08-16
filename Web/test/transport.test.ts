import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { GameplayTransport, CLOSE_CODE, resolveGameplayURL } from '@/transport'
import type { GameplayTransportEvent } from '@/transport'
import { SOMNIO_PROTOCOL_CONSTANTS } from '@/protocol'
import { fakeSocketFactory } from './helpers/fakeSocket'

/**
 * Mirrors `GameplayTransport`'s ordering invariants. Each test below corresponds to a comment
 * in the Swift actor explaining why the ordering is load-bearing — those rationales matter more
 * than the code, because every one of them describes a failure that is silent rather than loud.
 */

function collect(): { events: GameplayTransportEvent[]; delegate: (e: GameplayTransportEvent) => void } {
  const events: GameplayTransportEvent[] = []
  return { events, delegate: (event) => events.push(event) }
}

describe('endpoint resolution', () => {
  it('derives wss from an https origin and ws from http', () => {
    expect(resolveGameplayURL({ protocol: 'https:', host: 'somnio.tobiha.de' })).toBe(
      'wss://somnio.tobiha.de/ws'
    )
    expect(resolveGameplayURL({ protocol: 'http:', host: 'localhost:17669' })).toBe('ws://localhost:17669/ws')
  })

  /**
   * Origin-relative in both environments: production shares an origin by the hosting decision,
   * and development goes through the Vite `/ws` proxy rather than dialing :17662 directly.
   */
  it('stays origin-relative rather than hardcoding a host', () => {
    expect(resolveGameplayURL({ protocol: 'http:', host: '127.0.0.1:17669' })).toContain('127.0.0.1:17669')
  })
})

describe('outbox is live before the socket opens', () => {
  /**
   * The server emits `hello` immediately on accept and the controller answers it by sending
   * `login` synchronously. If a send before OPEN were dropped, the auth frame would vanish and
   * the client would strand in `awaitingLoginResult` — the exact failure the Swift actor
   * publishes its outbox early to prevent.
   */
  it('buffers a send issued before open and flushes it in order', () => {
    const { factory, latest } = fakeSocketFactory()
    const transport = new GameplayTransport(factory)
    const { delegate } = collect()
    transport.connect('ws://test/ws', delegate)

    transport.send({ tag: 'login', payload: { nickname: 'a', password: 'b' } })
    transport.send({ tag: 'clientSay', payload: { entityIndex: 0, text: 'hi' } })
    expect(latest().sent).toEqual([])

    latest().open()
    expect(latest().sent).toHaveLength(2)
    expect(JSON.parse(latest().sent[0]!).tag).toBe('login')
    expect(JSON.parse(latest().sent[1]!).tag).toBe('clientSay')
  })
})

describe('outbound frames are text', () => {
  /**
   * The single check that covers the real encoder-to-socket chain. Every other transport test
   * could pass while the transport shipped `ArrayBuffer`, which the Swift server closes on.
   */
  it('sends a string through the production encoder path', () => {
    const { factory, latest } = fakeSocketFactory()
    const transport = new GameplayTransport(factory)
    transport.connect('ws://test/ws', () => {})
    latest().open()

    transport.send({ tag: 'clientSay', payload: { entityIndex: 0, text: 'Hallo Welt' } })

    const frame = latest().sent[0]
    expect(typeof frame).toBe('string')
    expect(JSON.parse(frame!)).toEqual({
      tag: 'clientSay',
      payload: { entityIndex: 0, text: 'Hallo Welt' },
    })
  })

  it('drops an oversized frame at the encoder rather than letting the receiver hard-close', () => {
    // Registered for teardown rather than restored at the end of the body: `restoreMocks` defaults
    // to false, so a failure in any assertion below would leave `console.warn` stubbed for every
    // later test in the file.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    onTestFinished(() => warn.mockRestore())
    const { factory, latest } = fakeSocketFactory()
    const transport = new GameplayTransport(factory)
    transport.connect('ws://test/ws', () => {})
    latest().open()

    transport.send({
      tag: 'adminSay',
      payload: { text: 'x'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxFrameLength + 1) },
    })

    expect(latest().sent).toEqual([])
    expect(warn).toHaveBeenCalled()
  })
})

describe('inbound handling', () => {
  it('decodes a text frame into a message event', () => {
    const { factory, latest } = fakeSocketFactory()
    const transport = new GameplayTransport(factory)
    const { events, delegate } = collect()
    transport.connect('ws://test/ws', delegate)
    latest().open()

    latest().deliverText('{"tag":"hello","payload":{"protocolVersion":3}}')

    expect(events).toEqual([{ kind: 'message', message: { tag: 'hello', payload: { protocolVersion: 3 } } }])
  })

  it.each([
    ['malformed JSON', '{ not json'],
    ['an unknown tag', '{"tag":"notAVerb","payload":{}}'],
    ['a known tag with a bad payload', '{"tag":"clientPosition","payload":{}}'],
    ['a zero-byte frame', ''],
  ])('closes on %s', (_label, frame) => {
    const { factory, latest } = fakeSocketFactory()
    const transport = new GameplayTransport(factory)
    const { events, delegate } = collect()
    transport.connect('ws://test/ws', delegate)
    latest().open()

    latest().deliverText(frame)

    expect(events.map((event) => event.kind)).toEqual(['decodeFailed'])
    expect(latest().closes).toEqual([{ code: CLOSE_CODE.protocolError, reason: 'frame validation failed' }])
  })

  /**
   * The browser `WebSocket` exposes no `maxFrameSize`, so the inbound cap the Swift transport
   * gets from the WS layer has to live in the decoder. This is the one divergence the
   * server-facing conformance cases cannot reach.
   */
  it('closes on an oversized inbound text frame', () => {
    const { factory, latest } = fakeSocketFactory()
    const transport = new GameplayTransport(factory)
    const { events, delegate } = collect()
    transport.connect('ws://test/ws', delegate)
    latest().open()

    latest().deliverText(
      `{"tag":"adminSay","payload":{"text":"${'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxFrameLength)}"}}`
    )

    expect(events.map((event) => event.kind)).toEqual(['decodeFailed'])
    expect(latest().closes).toHaveLength(1)
  })

  it('closes on any binary frame', () => {
    const { factory, latest } = fakeSocketFactory()
    const transport = new GameplayTransport(factory)
    const { events, delegate } = collect()
    transport.connect('ws://test/ws', delegate)
    latest().open()

    latest().deliverBinary()

    expect(events.map((event) => event.kind)).toEqual(['unexpectedBinaryFrame'])
    expect(latest().closes).toHaveLength(1)
  })
})

describe('close handling', () => {
  it('reports peerEOF on an unprompted close', () => {
    const { factory, latest } = fakeSocketFactory()
    const transport = new GameplayTransport(factory)
    const { events, delegate } = collect()
    transport.connect('ws://test/ws', delegate)
    latest().open()

    latest().deliverClose()

    expect(events.map((event) => event.kind)).toEqual(['peerEOF'])
  })

  /**
   * Suppressing `peerEOF` on a user-initiated close is what keeps an explicit Leave Game from
   * appending a misleading "connection lost" chat line.
   */
  it('suppresses peerEOF when the close was ours', () => {
    const { factory, latest } = fakeSocketFactory()
    const transport = new GameplayTransport(factory)
    const { events, delegate } = collect()
    transport.connect('ws://test/ws', delegate)
    const socket = latest()
    socket.open()

    transport.disconnect()
    socket.deliverClose()

    expect(events.map((event) => event.kind)).toEqual([])
    expect(socket.closes).toEqual([{ code: CLOSE_CODE.normal }])
  })

  it('suppresses peerEOF after a protocol failure already reported', () => {
    const { factory, latest } = fakeSocketFactory()
    const transport = new GameplayTransport(factory)
    const { events, delegate } = collect()
    transport.connect('ws://test/ws', delegate)
    const socket = latest()
    socket.open()

    socket.deliverBinary()
    socket.deliverClose()

    expect(events.map((event) => event.kind)).toEqual(['unexpectedBinaryFrame'])
  })

  /**
   * A frame sent on an open socket goes out before the close frame; sending after close is
   * undefined behaviour.
   *
   * This walks the direct path, and deliberately so — `send` only queues while the socket is *not*
   * open, and `flushPending` returns early in exactly that state, so `disconnect`'s flush can never
   * carry a frame. The pre-open case is the one below, which asserts the drop rather than a drain.
   *
   * Which means moving `disconnect`'s `flushPending()` after its `close()` is an equivalent mutation
   * here and no test can catch it. The call is kept anyway: in Swift the outbox is an async stream
   * with its own writer task, frames genuinely are in flight at `disconnect` time, and the drain
   * ordering is documented there as preventing a dropped or misordered frame
   * (`GameplayTransport.disconnect`). The browser's synchronous `send` is what makes the port's
   * copy unreachable — not a decision that the ordering does not matter.
   */
  it('sends a queued frame before closing', () => {
    const { factory, latest } = fakeSocketFactory()
    const transport = new GameplayTransport(factory)
    transport.connect('ws://test/ws', () => {})
    const socket = latest()
    socket.open()

    transport.send({ tag: 'clientSay', payload: { entityIndex: 0, text: 'bye' } })
    transport.disconnect()

    // Through the ordered log, not two independent arrays: their lengths are both 1 whichever way
    // round the transport does it, so the assertion this replaces could not see a swap.
    expect(socket.log).toEqual(['send', 'close'])
  })

  /**
   * Pins what actually happens to a frame enqueued before the socket opened: it is dropped, not
   * flushed. Nothing queues pre-open today — the predictor waits for `selfEntityIndex` and
   * `currentSector`, `sendAuth` runs on `hello` — so this documents the boundary rather than
   * guarding a live path, and it fails loudly if someone later relies on the drain the class doc's
   * ordering invariant might suggest.
   */
  it('drops a frame enqueued before the socket opened, rather than draining it on close', () => {
    const { factory, latest } = fakeSocketFactory()
    const transport = new GameplayTransport(factory)
    transport.connect('ws://test/ws', () => {})
    const socket = latest()

    transport.send({ tag: 'clientSay', payload: { entityIndex: 0, text: 'never sent' } })
    transport.disconnect()

    expect(socket.sent).toEqual([])
    expect(socket.closes).toHaveLength(1)
  })
})

/**
 * Late events from a socket the transport has already replaced.
 *
 * The browser keeps invoking a socket's handlers after `close()`, and `disconnect()` clears the slot
 * immediately, so nothing but generation matching stops a stale `close` from running against the
 * live connection. The Swift original is immune by construction — per-socket state lives in an
 * `ActiveConnection` value and `run` refuses re-entrancy — so this is a hazard the port introduced
 * and has to guard explicitly.
 */
describe('superseded sockets cannot act on their replacement', () => {
  it('ignores a stale close that arrives after a reconnect', () => {
    const { events, delegate } = collect()
    const sockets = fakeSocketFactory()
    const transport = new GameplayTransport(sockets.factory)

    transport.connect('ws://localhost/ws', delegate)
    sockets.latest().open()
    transport.disconnect()

    // The replacement opens before the platform gets round to the old socket's close event.
    transport.connect('ws://localhost/ws', delegate)
    sockets.latest().open()
    const replacement = sockets.latest()
    const stale = sockets.all[0]!
    expect(replacement).not.toBe(stale)

    stale.deliverClose()

    // No spurious peerEOF, and the replacement is still the transport's live socket: a frame sent
    // now has to reach it rather than being dropped because the slot was cleared.
    expect(events.filter((event) => event.kind === 'peerEOF')).toHaveLength(0)
    transport.send({ tag: 'clientSay', payload: { entityIndex: 0, text: 'still here' } })
    expect(replacement.sent.at(-1)).toContain('clientSay')
  })

  it('ignores stale text, binary, and error events after a reconnect', () => {
    const { events, delegate } = collect()
    const sockets = fakeSocketFactory()
    const transport = new GameplayTransport(sockets.factory)

    transport.connect('ws://localhost/ws', delegate)
    sockets.latest().open()
    transport.disconnect()
    transport.connect('ws://localhost/ws', delegate)
    sockets.latest().open()

    const stale = sockets.all[0]!
    const before = events.length
    stale.deliverText('{"tag":"dateTick","payload":{"hour":1,"minute":0}}')
    stale.deliverBinary()
    stale.deliverError()

    // A stale binary frame or error would otherwise terminate a perfectly good connection.
    expect(events).toHaveLength(before)
  })

  /**
   * The window between `disconnect` and the next `connect`, which the two tests above do not cover:
   * they supersede a socket by *replacing* it, so a generation bumped only on `connect` still passes.
   * `handleAlreadyLoggedIn` disconnects and schedules a resume 250 ms later, and the controller is
   * `disconnected` throughout — anything the retired socket still emits reaches a controller that
   * has moved on, and `handleError`'s `!isOpen` gate is *true* by then, so an error would report the
   * server unreachable and tear down the resume that is about to start.
   */
  it('ignores events from a socket it has already disconnected', () => {
    const { events, delegate } = collect()
    const sockets = fakeSocketFactory()
    const transport = new GameplayTransport(sockets.factory)

    transport.connect('ws://localhost/ws', delegate)
    sockets.latest().open()
    const retired = sockets.latest()
    transport.disconnect()

    const before = events.length
    retired.deliverError()
    retired.deliverClose()
    retired.deliverText('{"tag":"dateTick","payload":{"hour":1,"minute":0}}')

    expect(events).toHaveLength(before)
  })

  /**
   * The close *code* a protocol violation actually ships, through a delegate that recovers the way
   * the controller does.
   *
   * The other tests here use an inert delegate, which hides the ordering that matters: the real one
   * handles `decodeFailed` synchronously and reaches `disconnect()`, so a transport that closed
   * after emitting would find the socket already gone and the server would read a normal 1000 for a
   * malformed frame.
   */
  it('closes with the protocol-error code even when the delegate disconnects synchronously', () => {
    const sockets = fakeSocketFactory()
    const transport = new GameplayTransport(sockets.factory)

    transport.connect('ws://localhost/ws', (event) => {
      if (event.kind === 'decodeFailed') transport.disconnect()
    })
    sockets.latest().open()
    const socket = sockets.latest()

    socket.deliverText('{ not json')

    expect(socket.closes).toEqual([{ code: CLOSE_CODE.protocolError, reason: 'frame validation failed' }])
    // The literal too, not only the constant: `WebSocket.close` throws `InvalidAccessError` for any
    // code outside 3000-4999 (1000 aside), so retargeting this at Swift's own 1002 would pass every
    // assertion here and wedge the real client on the first malformed frame.
    expect(socket.closes[0]!.code).toBe(4002)
    expect(socket.closes[0]!.code).toBeGreaterThanOrEqual(3000)
    expect(socket.closes[0]!.code).toBeLessThanOrEqual(4999)
  })

  /**
   * The binary path carries the identical ordering and needs the identical shape: `collect()`'s
   * inert delegate never re-enters the transport, so with it the terminate/emit order is
   * unobservable and a reordered `handleBinary` closes an already-cleared socket — the server
   * reading a normal 1000 for a protocol violation.
   */
  it('closes with the protocol-error code on a binary frame even when the delegate disconnects synchronously', () => {
    const sockets = fakeSocketFactory()
    const transport = new GameplayTransport(sockets.factory)

    transport.connect('ws://localhost/ws', (event) => {
      if (event.kind === 'unexpectedBinaryFrame') transport.disconnect()
    })
    sockets.latest().open()
    const socket = sockets.latest()

    socket.deliverBinary()

    expect(socket.closes).toEqual([{ code: CLOSE_CODE.protocolError, reason: 'frame validation failed' }])
    expect(socket.closes[0]!.code).toBe(4002)
  })

  /**
   * `terminatedByFailure` is stamped before the emit for the same reason: a delegate handling
   * `connectFailed` synchronously may reach back into `connect()` for a fresh socket, and a flag
   * set afterwards lands on that replacement — suppressing the new connection's genuine peer close,
   * so a real disconnect never surfaces as `connectionLost`.
   */
  it('does not stamp the failure flag onto a socket the delegate opened while handling the error', () => {
    const sockets = fakeSocketFactory()
    const transport = new GameplayTransport(sockets.factory)
    const events: string[] = []
    let reconnected = false

    // Disconnect *then* connect, which is what `endSessionWithRecovery` does — `connect` refuses
    // to replace a socket that is still assigned, so a bare re-entrant connect would be a no-op
    // and could never reach the flag.
    transport.connect('ws://localhost/ws', (event) => {
      events.push(event.kind)
      if (event.kind === 'connectFailed' && !reconnected) {
        reconnected = true
        transport.disconnect()
        transport.connect('ws://localhost/ws', (next) => events.push(next.kind))
      }
    })
    sockets.latest().deliverError()

    // The replacement socket's own close is a genuine peer EOF and must be reported as one.
    sockets.latest().open()
    sockets.latest().deliverClose()

    expect(events).toContain('peerEOF')
    // Exactly one, and it belongs to the replacement. Without this the test held with the flag never
    // set at all: the failed socket's own close would then add a second `peerEOF`, telling the player
    // the connection was lost on a handshake that never connected.
    expect(events.filter((kind) => kind === 'peerEOF')).toHaveLength(1)
    expect(events.indexOf('peerEOF')).toBeGreaterThan(events.indexOf('connectFailed'))
  })

  /**
   * The suppression itself, on the simple path: a failed handshake fires `error` and then `close`,
   * and only the flag stops the close from being reported as a lost connection. "Server
   * unreachable." and "Connection lost." are different diagnoses and the player gets only one.
   */
  it('suppresses the peer EOF that follows a failed handshake', () => {
    const { events, delegate } = collect()
    const sockets = fakeSocketFactory()
    const transport = new GameplayTransport(sockets.factory)

    transport.connect('ws://localhost/ws', delegate)
    sockets.latest().deliverError()
    sockets.latest().deliverClose()

    expect(events.map((event) => event.kind)).toEqual(['connectFailed'])
  })

  /**
   * The `!isOpen` gate in `handleError` is what separates a failed handshake from a mid-session
   * drop. Reporting a live socket's error as `connectFailed` would show the player "Server
   * unreachable." for a connection that had been working, and worse, the `terminatedByFailure`
   * flag it sets would suppress the `peerEOF` that produces the correct "Connection lost." line —
   * so the session would end with the wrong explanation and no right one.
   */
  it('reports a live socket losing its connection as a peer EOF, not a connect failure', () => {
    const { events, delegate } = collect()
    const sockets = fakeSocketFactory()
    const transport = new GameplayTransport(sockets.factory)

    transport.connect('ws://localhost/ws', delegate)
    sockets.latest().open()
    // A browser fires `error` before `close` on a mid-session drop just as it does on a failed
    // handshake; only the open state distinguishes them.
    sockets.latest().deliverError()
    sockets.latest().deliverClose()

    const kinds = events.map((event) => event.kind)
    expect(kinds).toContain('peerEOF')
    expect(kinds).not.toContain('connectFailed')
  })

  /** The same window after a protocol-error termination, the other path that retires a socket. */
  it('ignores events from a socket it has already terminated', () => {
    const { events, delegate } = collect()
    const sockets = fakeSocketFactory()
    const transport = new GameplayTransport(sockets.factory)

    transport.connect('ws://localhost/ws', delegate)
    sockets.latest().open()
    const retired = sockets.latest()
    // A decode failure terminates the socket and reports it once.
    retired.deliverText('{ not json')
    const before = events.length

    retired.deliverError()
    retired.deliverClose()

    expect(events).toHaveLength(before)
  })
})
