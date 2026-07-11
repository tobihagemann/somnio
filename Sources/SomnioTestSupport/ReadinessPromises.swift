import Foundation
import ServiceLifecycle

/// Resolves to the bound port once `set(_:)` is called from `onServerRunning`. Modeled
/// as an `actor` so the WS Channel's task and the test body don't race on `port`.
/// Cancellation-aware with per-token routing: if the awaiting task is cancelled before
/// the server binds (e.g., a sibling service in the task group failed), only that
/// task's continuation resumes — sibling waiters keep waiting. A cancelled waiter
/// resumes with the sentinel `0`; race-style consumers discard the loser's value, so
/// the sentinel is never built into a client.
public actor PortPromise {
    private var port: Int?
    private var continuations: [UUID: CheckedContinuation<Int, Never>] = [:]

    public init() {}

    public func set(_ value: Int) {
        if port == nil { port = value }
        let resumers = continuations
        continuations.removeAll()
        for (_, continuation) in resumers {
            continuation.resume(returning: value)
        }
    }

    public func value() async -> Int {
        if let port { return port }
        let token = UUID()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Int, Never>) in
                installWaiter(continuation, token: token)
            }
        } onCancel: {
            Task { await self.resumeOnCancel(token: token) }
        }
    }

    /// Deadline-bounded `value`. Throws `TestTimeoutError` if the server does not bind within
    /// `timeout`, so a stuck setup surfaces instead of hanging the parent group.
    public func value(timeout: Duration) async throws -> Int {
        try await withTestTimeout(timeout) { await self.value() }
    }

    /// Test-only inspection: waiters currently suspended in `value`.
    public var waiterCount: Int {
        continuations.count
    }

    private func installWaiter(_ continuation: CheckedContinuation<Int, Never>, token: UUID) {
        if let port {
            continuation.resume(returning: port)
            return
        }
        if Task.isCancelled {
            continuation.resume(returning: 0)
            return
        }
        continuations[token] = continuation
    }

    private func resumeOnCancel(token: UUID) {
        guard let continuation = continuations.removeValue(forKey: token) else { return }
        continuation.resume(returning: 0)
    }
}

/// One-shot completion latch carrying the `serviceGroup.run()` outcome. `withLiveServer`
/// publishes the service task's result here so its startup race and teardown drain read a
/// cancellation-aware promise instead of the unstructured task's `.value` — `Task.value` is
/// not cancellation-responsive, so awaiting it inside a cancellable race child deadlocks
/// the enclosing group. Shaped like `PortPromise`: per-token continuation routing,
/// resume-on-cancel. The resume-on-cancel sentinel (`.success(())`) is only ever produced
/// for a race loser, whose value is discarded.
public actor ServiceEndedPromise {
    private var outcome: Result<Void, any Error>?
    private var continuations: [UUID: CheckedContinuation<Result<Void, any Error>, Never>] = [:]

    public init() {}

    public func set(_ value: Result<Void, any Error>) {
        if outcome == nil { outcome = value }
        let resumers = continuations
        continuations.removeAll()
        for (_, continuation) in resumers {
            continuation.resume(returning: value)
        }
    }

    public func value() async -> Result<Void, any Error> {
        if let outcome { return outcome }
        let token = UUID()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Result<Void, any Error>, Never>) in
                installWaiter(continuation, token: token)
            }
        } onCancel: {
            Task { await self.resumeOnCancel(token: token) }
        }
    }

    /// Deadline-bounded `value`. Throws `TestTimeoutError` if the service does not end within
    /// `timeout`, so a stalled shutdown surfaces instead of hanging the parent group.
    public func value(timeout: Duration) async throws -> Result<Void, any Error> {
        try await withTestTimeout(timeout) { await self.value() }
    }

    /// Runs `serviceGroup` in an unstructured task and publishes its outcome here, so
    /// races and drains read this cancellation-aware promise instead of the task's
    /// `.value`. The returned task is the caller's cancellation handle; its `.value`
    /// must never be awaited.
    public nonisolated func captureRun(of serviceGroup: ServiceGroup) -> Task<Void, Never> {
        Task {
            let outcome: Result<Void, any Error>
            do {
                try await serviceGroup.run()
                outcome = .success(())
            } catch {
                outcome = .failure(error)
            }
            await self.set(outcome)
        }
    }

    /// Test-only inspection: waiters currently suspended in `value`.
    public var waiterCount: Int {
        continuations.count
    }

    private func installWaiter(
        _ continuation: CheckedContinuation<Result<Void, any Error>, Never>,
        token: UUID
    ) {
        if let outcome {
            continuation.resume(returning: outcome)
            return
        }
        if Task.isCancelled {
            continuation.resume(returning: .success(()))
            return
        }
        continuations[token] = continuation
    }

    private func resumeOnCancel(token: UUID) {
        guard let continuation = continuations.removeValue(forKey: token) else { return }
        continuation.resume(returning: .success(()))
    }
}
