import Foundation
import SomnioCore

/// Sendable enqueue-only mailbox for outbound binary frames. Composes
/// `SendableMailbox` (the shared shell used by both this client transport and the
/// server's `ConnectionOutbox`) so the continuation lifecycle and `Mutex`-guarded
/// `finished` flag live in one place. The transport actor hands the mailbox reference
/// to a `@Sendable` writer task without crossing its isolation boundary at every
/// enqueue.
public final class GameplayOutbox: Sendable {
    private let mailbox: SendableMailbox<Data>

    private init(mailbox: SendableMailbox<Data>) {
        self.mailbox = mailbox
    }

    /// Returns the outbox + drain stream pair. The transport spawns the writer task on
    /// the stream and stores the box for `enqueue(_:)`.
    public static func make() -> (GameplayOutbox, AsyncStream<Data>) {
        let (mailbox, stream) = SendableMailbox<Data>.make()
        return (GameplayOutbox(mailbox: mailbox), stream)
    }

    /// Synchronous, non-blocking enqueue. Drops if the stream is finished — once the
    /// transport tears down, late writes are no-ops by design.
    public func enqueue(_ data: Data) {
        mailbox.enqueue(data)
    }

    /// Cleanly closes the underlying stream so the writer task observes EOF and exits.
    /// Idempotent.
    public func finish() {
        mailbox.finish()
    }
}
