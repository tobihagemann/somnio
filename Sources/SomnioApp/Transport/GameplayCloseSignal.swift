import Foundation
import Synchronization

/// One-shot signal observed by the transport's close-watcher task. `wait()` suspends
/// until `fire()` is called. After firing, all subsequent `wait()` calls return
/// immediately so a late observer never deadlocks the unwind.
public final class GameplayCloseSignal: Sendable {
    private struct State {
        var fired = false
        var continuations: [CheckedContinuation<Void, Never>] = []
    }

    private let state = Mutex(State())

    public init() {}

    public func fire() {
        let waiters: [CheckedContinuation<Void, Never>] = state.withLock { state in
            guard !state.fired else { return [] }
            state.fired = true
            let resume = state.continuations
            state.continuations.removeAll()
            return resume
        }
        for waiter in waiters {
            waiter.resume()
        }
    }

    public func wait() async {
        await withCheckedContinuation { continuation in
            let alreadyFired: Bool = state.withLock { state in
                if state.fired { return true }
                state.continuations.append(continuation)
                return false
            }
            if alreadyFired {
                continuation.resume()
            }
        }
    }
}
