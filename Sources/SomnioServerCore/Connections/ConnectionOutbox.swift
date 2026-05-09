import Foundation
import Synchronization

/// Mutable bookkeeping owned by `ConnectionOutbox`. Held inside a `Mutex` so the wrapping
/// class can be `Sendable` (not `@unchecked Sendable`) without surrendering thread-safety.
struct OutboxState {
    var inflight: Int = 0
    var overflowed: Bool = false
    var finished: Bool = false
}

/// Enqueue-only mailbox the per-sector actor pushes broadcasts into. The class keeps
/// `send(_:)` synchronous so the broadcast path never blocks on a slow client; if the
/// per-connection writer task can't keep up past `highWatermark`, the outbox marks itself
/// overflowed and finishes the underlying stream so the writer drains then closes the
/// WebSocket with `.policyViolation`.
public final class ConnectionOutbox: Sendable {
    public let stream: AsyncStream<Data>
    private let continuation: AsyncStream<Data>.Continuation
    private let highWatermark: Int
    private let state = Mutex(OutboxState())

    public init(highWatermark: Int) {
        let (stream, continuation) = AsyncStream<Data>.makeStream(bufferingPolicy: .unbounded)
        self.stream = stream
        self.continuation = continuation
        self.highWatermark = highWatermark
    }

    /// Synchronous, non-blocking enqueue. Trips overflow and finishes the stream when
    /// `inflight` exceeds `highWatermark` after the increment so the writer task fast-fails
    /// the slow client rather than back-pressuring the per-sector broadcast loop.
    public func send(_ data: Data) {
        let shouldOverflow: Bool = state.withLock { state in
            guard !state.finished else { return false }
            state.inflight += 1
            return state.inflight > highWatermark
        }
        if shouldOverflow {
            state.withLock { state in
                guard !state.finished else { return }
                state.overflowed = true
                state.finished = true
            }
            continuation.finish()
            return
        }
        continuation.yield(data)
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
        let alreadyFinished: Bool = state.withLock { state in
            if state.finished { return true }
            state.finished = true
            return false
        }
        guard !alreadyFinished else { return }
        continuation.finish()
    }

    public var isOverflowed: Bool {
        state.withLock(\.overflowed)
    }
}
