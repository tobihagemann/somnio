import Foundation
import Testing

/// Unit coverage for the per-token cancellation routing shared by `OneShotLatch`,
/// `AttachCountdown`, and `PortPromise`. The load-bearing property is that cancelling one
/// waiter resumes only that waiter — a regression to "any cancel resumes everyone" would
/// otherwise surface only as a flaky broadcast-resume pass in the admin-verb suites.
///
/// The time limit makes a cancellation-routing regression fail deterministically: each test
/// awaits a cancelled task's completion, which a broken latch would never resume.
@Suite(.timeLimit(.minutes(1)))
struct LatchTests {
    @Test func `OneShotLatch resumes only the cancelled waiter and fires the rest`() async throws {
        let latch = OneShotLatch()
        let aResumed = FirstWriteSlot<Bool>()
        let bResumed = FirstWriteSlot<Bool>()
        let taskA = Task { await latch.wait(); await aResumed.set(true) }
        let taskB = Task { await latch.wait(); await bResumed.set(true) }

        try await pollUntil { await latch.waiterCount == 2 }
        taskA.cancel()
        await taskA.value

        #expect(await aResumed.value() == true)
        #expect(await latch.waiterCount == 1, "the sibling waiter must stay suspended")
        #expect(await bResumed.value() == nil)

        await latch.fire()
        await taskB.value
        #expect(await bResumed.value() == true)
        #expect(await latch.waiterCount == 0)
    }

    @Test func `AttachCountdown resumes only the cancelled waiter and releases the rest on signal`() async throws {
        let countdown = AttachCountdown(expected: 1)
        let aResumed = FirstWriteSlot<Bool>()
        let bResumed = FirstWriteSlot<Bool>()
        let taskA = Task { await countdown.awaitAll(); await aResumed.set(true) }
        let taskB = Task { await countdown.awaitAll(); await bResumed.set(true) }

        try await pollUntil { await countdown.waiterCount == 2 }
        taskA.cancel()
        await taskA.value

        #expect(await aResumed.value() == true)
        #expect(await countdown.waiterCount == 1, "the sibling waiter must stay suspended")
        #expect(await bResumed.value() == nil)

        await countdown.signal()
        await taskB.value
        #expect(await bResumed.value() == true)
        #expect(await countdown.waiterCount == 0)
    }

    @Test func `PortPromise resumes only the cancelled waiter and resolves the rest on set`() async throws {
        let promise = PortPromise()
        let aResult = FirstWriteSlot<Int>()
        let bResult = FirstWriteSlot<Int>()
        let taskA = Task { await aResult.set(promise.value()) }
        let taskB = Task { await bResult.set(promise.value()) }

        try await pollUntil { await promise.waiterCount == 2 }
        taskA.cancel()
        await taskA.value

        #expect(await aResult.value() == 0, "a cancelled PortPromise waiter resumes with the sentinel 0")
        #expect(await promise.waiterCount == 1, "the sibling waiter must stay suspended")
        #expect(await bResult.value() == nil)

        await promise.set(4242)
        await taskB.value
        #expect(await bResult.value() == 4242)
        #expect(await promise.waiterCount == 0)
    }

    @Test func `OneShotLatch wait throws TestTimeoutError when fire never lands`() async throws {
        let latch = OneShotLatch()
        let waiting = Task { try await latch.wait(timeout: .milliseconds(200)) }
        try await pollUntil { await latch.waiterCount == 1 }
        await #expect(throws: TestTimeoutError.self) { try await waiting.value }
        #expect(await latch.waiterCount == 0, "the installed waiter must be torn down on timeout")
    }

    @Test func `AttachCountdown awaitAll throws TestTimeoutError when no signal lands`() async throws {
        let countdown = AttachCountdown(expected: 1)
        let waiting = Task { try await countdown.awaitAll(timeout: .milliseconds(200)) }
        try await pollUntil { await countdown.waiterCount == 1 }
        await #expect(throws: TestTimeoutError.self) { try await waiting.value }
        #expect(await countdown.waiterCount == 0, "the installed waiter must be torn down on timeout")
    }

    @Test func `PortPromise value throws TestTimeoutError when the port never binds`() async throws {
        let promise = PortPromise()
        let waiting = Task { try await promise.value(timeout: .milliseconds(200)) }
        try await pollUntil { await promise.waiterCount == 1 }
        await #expect(throws: TestTimeoutError.self) { _ = try await waiting.value }
        #expect(await promise.waiterCount == 0, "the installed waiter must be torn down on timeout")
    }

    @Test func `withTestTimeout rethrows the operation's own error rather than remapping to a timeout`() async throws {
        await #expect(throws: SentinelError.self) {
            // The explicit return type pins `withTestTimeout`'s generic `Value` for a body that
            // only throws; any non-`Void` type works since the closure never returns normally.
            try await withTestTimeout(.seconds(60)) { () async throws -> Int in
                throw SentinelError()
            }
        }
    }

    @Test func `withTestTimeout returns the operation's value when it finishes before the deadline`() async throws {
        let value = try await withTestTimeout(.seconds(60)) { 7 }
        #expect(value == 7)
    }
}

/// Suspend until `condition` holds, polling on a short interval. Throws `TestTimeoutError`
/// if it never holds within the budget so a wiring regression fails instead of hanging.
private func pollUntil(_ condition: @Sendable () async -> Bool) async throws {
    for _ in 0 ..< 500 {
        if await condition() { return }
        try await Task.sleep(for: .milliseconds(4))
    }
    throw TestTimeoutError()
}

/// Marker error used to verify `withTestTimeout` rethrows the operation's own failure rather
/// than remapping it to `TestTimeoutError`.
private struct SentinelError: Error {}
