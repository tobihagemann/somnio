import Foundation

/// Thrown by the `timeout:` latch variants when the bounded wait elapses before its
/// signal/fire/set lands. Surfacing a timeout keeps a stuck setup from hanging a
/// `withThrowingTaskGroup` parent, which otherwise buffers child errors until
/// `next()`/`waitForAll()` and never observes the failure.
public struct TestTimeoutError: Error {
    public init() {}
}

private enum RaceOutcome<Value: Sendable> {
    case finished(Value)
    case timedOut
}

/// Race an async wait against a deadline: returns the wait's value if it lands first, throws
/// `TestTimeoutError` if the deadline wins, otherwise rethrows the wait's own error. The wait is
/// cancelled when the deadline wins, so a latch with per-token cancellation routing resumes its
/// own waiter cleanly. A non-throwing wait is accepted too, so the latch `timeout:` variants
/// pass theirs unchanged.
public func withTestTimeout<Value: Sendable>(
    _ timeout: Duration,
    _ operation: @Sendable @escaping () async throws -> Value
) async throws -> Value {
    try await withThrowingTaskGroup(of: RaceOutcome<Value>.self) { group in
        group.addTask { try await .finished(operation()) }
        group.addTask {
            try await Task.sleep(for: timeout)
            return .timedOut
        }
        guard let outcome = try await group.next() else { throw TestTimeoutError() }
        group.cancelAll()
        switch outcome {
        case let .finished(value): return value
        case .timedOut: throw TestTimeoutError()
        }
    }
}

/// Suspend until `condition` holds, polling on a short interval. Throws `TestTimeoutError`
/// if it never holds within the budget so a wiring regression fails instead of hanging.
public func pollUntil(_ condition: @Sendable () async -> Bool) async throws {
    for _ in 0 ..< 500 {
        if await condition() { return }
        try await Task.sleep(for: .milliseconds(4))
    }
    throw TestTimeoutError()
}
