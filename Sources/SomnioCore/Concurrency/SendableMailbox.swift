import Foundation
import Synchronization

/// Sendable enqueue-only mailbox over an `AsyncStream`. Both the player client's
/// `GameplayOutbox` and the server's `ConnectionOutbox` compose this primitive so the
/// continuation lifecycle and `Mutex`-guarded `finished` flag live in one place. The
/// composing layer adds policy on top (e.g. server-side overflow watermark).
public final class SendableMailbox<Element: Sendable>: Sendable {
    private struct State {
        var continuation: AsyncStream<Element>.Continuation?
        var finished = false
    }

    private let state: Mutex<State>

    private init(continuation: AsyncStream<Element>.Continuation) {
        self.state = Mutex(State(continuation: continuation))
    }

    /// Returns a fresh mailbox + drain stream pair. Callers spawn the consumer on the
    /// drain stream and store the mailbox for `enqueue(_:)`.
    public static func make() -> (SendableMailbox<Element>, AsyncStream<Element>) {
        let (stream, continuation) = AsyncStream<Element>.makeStream(bufferingPolicy: .unbounded)
        return (SendableMailbox(continuation: continuation), stream)
    }

    /// Synchronous, non-blocking enqueue. Drops if the mailbox has been finished.
    public func enqueue(_ value: Element) {
        state.withLock { state in
            guard !state.finished, let continuation = state.continuation else { return }
            continuation.yield(value)
        }
    }

    /// Closes the underlying stream so the consumer task sees end-of-stream. Idempotent.
    public func finish() {
        state.withLock { state in
            guard !state.finished else { return }
            state.finished = true
            state.continuation?.finish()
            state.continuation = nil
        }
    }

    /// True once `finish()` has been called.
    public var isFinished: Bool {
        state.withLock(\.finished)
    }
}
