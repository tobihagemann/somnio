import Foundation
import SomnioCore
import Synchronization

/// Mutable bookkeeping owned by `ConnectionOutbox`. Held inside a `Mutex` so the wrapping
/// class can be `Sendable` (not `@unchecked Sendable`) without surrendering thread-safety.
/// `inflight` and `overflowed` are the watermark policy that lives only on the server side;
/// `finished` short-circuits post-`finish()` enqueues so they don't trip a spurious overflow
/// during graceful shutdown. The underlying continuation lifecycle is delegated to
/// `SendableMailbox`.
struct OutboxState {
    var inflight: Int = 0
    var overflowed: Bool = false
    var finished: Bool = false
}

/// Enqueue-only mailbox the per-sector actor pushes broadcasts into. Composes
/// `SomnioCore.SendableMailbox` for the continuation lifecycle and adds the server-side
/// `highWatermark` overflow policy on top: when `inflight` exceeds the watermark after
/// an enqueue, the outbox marks itself overflowed and finishes the underlying mailbox
/// so the writer drains then closes the WebSocket with `.policyViolation`.
public final class ConnectionOutbox: Sendable {
    public let stream: AsyncStream<Data>
    private let mailbox: SendableMailbox<Data>
    private let highWatermark: Int
    private let state = Mutex(OutboxState())

    public init(highWatermark: Int) {
        let (mailbox, stream) = SendableMailbox<Data>.make()
        self.mailbox = mailbox
        self.stream = stream
        self.highWatermark = highWatermark
    }

    /// Synchronous, non-blocking enqueue. Drops if the outbox has already been
    /// finished (so post-shutdown sends don't pollute the watermark accounting).
    /// Trips overflow and finishes the mailbox when `inflight` exceeds
    /// `highWatermark` after the increment so the writer task fast-fails the slow
    /// client rather than back-pressuring the per-sector broadcast loop.
    public func send(_ data: Data) {
        let shouldOverflow: Bool = state.withLock { state in
            guard !state.finished, !state.overflowed else { return false }
            state.inflight += 1
            return state.inflight > highWatermark
        }
        if shouldOverflow {
            state.withLock { state in
                guard !state.overflowed else { return }
                state.overflowed = true
                state.finished = true
            }
            mailbox.finish()
            return
        }
        mailbox.enqueue(data)
    }

    /// Called by the writer task after each successful frame write so `inflight` reflects the
    /// queue depth the broadcast loop can see.
    public func recordWrite() {
        state.withLock { state in
            state.inflight = max(0, state.inflight - 1)
        }
    }

    /// Cleanly close the outbox during graceful shutdown. The writer drains whatever's queued
    /// before the loop exits.
    public func finish() {
        state.withLock { state in
            state.finished = true
        }
        mailbox.finish()
    }

    public var isOverflowed: Bool {
        state.withLock(\.overflowed)
    }
}
