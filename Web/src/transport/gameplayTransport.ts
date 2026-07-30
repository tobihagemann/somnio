import { OversizedFrameError, decodeSomnioMessage, encodeSomnioMessage } from '@/protocol'
import type { SomnioMessage } from '@/protocol'
import { CLOSE_CODE, browserSocketFactory } from './socket'
import type { GameplaySocket, GameplaySocketFactory } from './socket'

/**
 * Mirror of `GameplayTransportEvent`. `peerEOF` is suppressed on a user-initiated close so an
 * explicit Leave Game does not append a misleading "connection lost" chat line.
 */
export type GameplayTransportEvent =
  | { kind: 'message'; message: SomnioMessage }
  | { kind: 'connectFailed'; error: unknown }
  | { kind: 'decodeFailed'; error: unknown }
  | { kind: 'unexpectedBinaryFrame' }
  | { kind: 'peerEOF' }

export type GameplayTransportDelegate = (event: GameplayTransportEvent) => void

/**
 * Long-lived gameplay-WebSocket transport, mirroring `Sources/SomnioApp/Transport/GameplayTransport.swift`.
 *
 * Three of the Swift actor's ordering invariants carry over, and each is load-bearing:
 *
 * 1. **The outbox is live before the socket can deliver anything.** The Swift actor publishes
 *    the outbox and close-signal *before* starting its read loop, because the server emits
 *    `hello` immediately on accept and the controller answers it by enqueuing `login`
 *    synchronously. If that enqueue can land before the outbox exists, the auth frame is
 *    silently dropped and the client strands in `awaitingLoginResult`. Here the queue is
 *    created in the constructor and buffers until the socket opens, so there is no window.
 * 2. **The writer drains before the close frame.** `disconnect()` flushes before closing, matching
 *    the Swift ordering; sending after close is undefined. Here that flush is ordering only, and
 *    never actually carries a frame: `pending` holds frames only while the socket is not open, and
 *    `flushPending` returns early in exactly that state, so the queue is empty whenever the flush
 *    can run. Disconnecting before the socket opens therefore drops what was queued rather than
 *    sending it. Nothing queues pre-open today — the predictor waits for `selfEntityIndex` and
 *    `currentSector`, and `sendAuth` runs on `hello` — so this is the ordering the Swift actor
 *    states, not a drain the browser client relies on.
 * 3. **Text frames only.** A binary frame or a decode failure is terminal and closes the
 *    connection, exactly as the Swift read loop does.
 */
export class GameplayTransport {
  private socket: GameplaySocket | undefined
  private readonly factory: GameplaySocketFactory
  private delegate: GameplayTransportDelegate | undefined
  /** Frames enqueued before the socket reached OPEN. Drained in order on open. */
  private pending: string[] = []
  private isOpen = false
  private closedByUs = false
  private terminatedByFailure = false
  /**
   * Which connection attempt the live callbacks belong to.
   *
   * The Swift original needs no equivalent: `GameplayTransport.run` scopes every per-socket flag in
   * an `ActiveConnection` value, refuses re-entrancy while one is live, and does not return until the
   * socket has unwound. The browser port has one mutable slot plus callbacks the platform keeps
   * invoking after `close()`, so a stale socket's late `close` would otherwise run `handleClose` on
   * the *replacement* — clearing `this.socket` out from under a live connection, emitting a spurious
   * `peerEOF`, and leaving the server holding a registration that makes the next login
   * `alreadyLoggedIn`. Comparing generations is what restores the original's per-socket scoping.
   *
   * Bumped by every path that takes ownership of or retires a socket — `connect`, `disconnect`, and
   * `terminate` — so a socket is superseded the moment this transport is done with it, not only once
   * a replacement exists.
   */
  private generation = 0

  constructor(factory: GameplaySocketFactory = browserSocketFactory) {
    this.factory = factory
  }

  connect(url: string, delegate: GameplayTransportDelegate): void {
    if (this.socket !== undefined) return
    this.delegate = delegate
    this.closedByUs = false
    this.terminatedByFailure = false
    this.isOpen = false
    this.pending = []
    this.generation += 1
    const generation = this.generation

    try {
      this.socket = this.factory(url, {
        onOpen: () => this.ifCurrent(generation, () => this.handleOpen()),
        onText: (text) => this.ifCurrent(generation, () => this.handleText(text)),
        onBinary: () => this.ifCurrent(generation, () => this.handleBinary()),
        onClose: () => this.ifCurrent(generation, () => this.handleClose()),
        onError: (error) => this.ifCurrent(generation, () => this.handleError(error)),
      })
    } catch (error) {
      // A malformed URL throws synchronously from the `WebSocket` constructor.
      this.socket = undefined
      this.emit({ kind: 'connectFailed', error })
    }
  }

  /** Drops an event from a socket this transport has already moved on from. */
  private ifCurrent(generation: number, body: () => void): void {
    if (generation !== this.generation) return
    body()
  }

  /**
   * Encodes and sends one message. The encoder's `maxFrameLength` guard fires here rather than
   * letting the receiver hard-close, matching the Swift `enqueue`, and a failure is logged
   * rather than thrown: a single oversized chat line must not tear down the session.
   */
  send(message: SomnioMessage): void {
    if (this.socket === undefined) return
    let frame: string
    try {
      frame = encodeSomnioMessage(message)
    } catch (error) {
      if (error instanceof OversizedFrameError) {
        console.warn('outbound encode failed: frame exceeds the protocol cap', message.tag)
        return
      }
      throw error
    }
    if (!this.isOpen) {
      this.pending.push(frame)
      return
    }
    this.socket.send(frame)
  }

  /**
   * Graceful close. Flushes before closing so a final message cannot be reordered behind the close
   * frame — see the class doc for why that flush is ordering rather than a drain — then suppresses
   * `peerEOF` for the resulting `onClose`.
   */
  disconnect(): void {
    if (this.socket === undefined) return
    this.closedByUs = true
    this.flushPending()
    this.socket.close(CLOSE_CODE.normal)
    this.socket = undefined
    this.isOpen = false
    // A socket we closed is superseded too, so its generation retires here rather than waiting for
    // the next `connect` to bump it. Hardening, not a fixed bug: the spec's "message has been
    // received" steps return early unless ready state is OPEN, and `close()` sets CLOSING
    // synchronously, so no late frame can arrive; and `closedByUs` already suppresses the `peerEOF`
    // from the resulting `close`. What this closes is the gap in between — any callback at all from
    // a socket this transport has finished with, reaching a controller that has moved on.
    this.generation += 1
  }

  private handleOpen(): void {
    this.isOpen = true
    this.flushPending()
  }

  private flushPending(): void {
    if (this.socket === undefined || !this.isOpen) return
    const queued = this.pending
    this.pending = []
    for (const frame of queued) {
      this.socket.send(frame)
    }
  }

  private handleText(text: string): void {
    let message: SomnioMessage
    try {
      message = decodeSomnioMessage(text)
    } catch (error) {
      // Terminated *before* the event goes out, because the delegate handles it synchronously: the
      // controller's recovery reaches `disconnect()`, which closes with the normal code and clears
      // the socket, so a `terminate()` afterwards would find nothing left to close and the server
      // would see a clean 1000 for a protocol violation. Closing first is otherwise invisible to the
      // delegate — `disconnect()` then early-returns, and `terminatedByFailure` already suppresses
      // the `peerEOF` this close would produce.
      this.terminate()
      this.emit({ kind: 'decodeFailed', error })
      return
    }
    this.emit({ kind: 'message', message })
  }

  private handleBinary(): void {
    this.terminate()
    this.emit({ kind: 'unexpectedBinaryFrame' })
  }

  private handleClose(): void {
    const shouldReportEOF = !this.closedByUs && !this.terminatedByFailure
    this.socket = undefined
    this.isOpen = false
    if (shouldReportEOF) {
      this.emit({ kind: 'peerEOF' })
    }
  }

  private handleError(error: unknown): void {
    // The browser fires `error` before `close` on a failed handshake and reveals nothing about
    // the cause (deliberately, to avoid leaking cross-origin information). Report it as a
    // connect failure and let the close handler run its normal teardown.
    if (!this.isOpen) {
      // Flagged before the emit, as on the two decode paths: the delegate runs synchronously and may
      // reach back into `connect()`, which resets this flag for the socket it opens. Setting it
      // afterwards would stamp the failure onto that replacement instead, suppressing the peer close
      // of a connection that never failed.
      this.terminatedByFailure = true
      this.emit({ kind: 'connectFailed', error })
    }
  }

  /** Terminal protocol failure: close and suppress the `peerEOF` the close would otherwise emit. */
  private terminate(): void {
    this.terminatedByFailure = true
    this.socket?.close(CLOSE_CODE.protocolError, 'frame validation failed')
    this.socket = undefined
    this.isOpen = false
    // Retired here for the same reason as in `disconnect`: every path that drops the socket also
    // retires its generation, so "is this callback current?" never depends on which path dropped it.
    this.generation += 1
  }

  private emit(event: GameplayTransportEvent): void {
    this.delegate?.(event)
  }
}
