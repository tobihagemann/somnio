import Foundation
import Synchronization

/// Sendable bag of per-connection state captured into the `WebSocketClient.connect`
/// `@Sendable` closure and the `withTaskCancellationHandler` `onCancel:` closure.
/// Centralises the `Mutex`-guarded slots so the actor never has to cross its own
/// isolation to reach them.
final class ActiveConnection: Sendable {
    struct State {
        var outbox: GameplayOutbox?
        var closeSignal: GameplayCloseSignal?
        var readLoopTask: Task<Void, Never>?
        var writerTask: Task<Void, Never>?
        var watcherTask: Task<Void, Never>?
    }

    private let state = Mutex(State())

    init() {}

    /// Atomic mutator. Lets `driveConnection` set multiple slots in one critical
    /// section as each task is spawned, instead of taking the lock per slot.
    func mutate(_ body: (inout State) -> Void) {
        state.withLock { body(&$0) }
    }

    /// Atomic snapshot. The transport's run-tail reads four slots in succession; one
    /// snapshot keeps the read consistent and avoids four separate lock acquisitions.
    var snapshot: State {
        state.withLock { $0 }
    }
}
