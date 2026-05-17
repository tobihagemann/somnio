import Foundation
import HummingbirdTesting
import HummingbirdWebSocket
import HummingbirdWSClient
import HummingbirdWSTesting
import Logging
import NIOCore
import NIOWebSocket
import SomnioProtocol

// Latches used by admin-verb tests to coordinate multiple long-lived gameplay sessions
// with a single test body that performs admin calls between sessions' setup and teardown.

/// Counting latch: callers `await awaitAll()` until `expected` `signal()` calls land.
/// Cancellation is routed per-token so a single cancelled waiter does not release its
/// siblings.
actor AttachCountdown {
    private var seen: Int = 0
    private let expected: Int
    private var waiters: [UUID: CheckedContinuation<Void, Never>] = [:]

    init(expected: Int) {
        self.expected = expected
    }

    func signal() {
        seen += 1
        if seen >= expected {
            let toResume = waiters
            waiters.removeAll()
            for (_, continuation) in toResume {
                continuation.resume()
            }
        }
    }

    func awaitAll() async {
        if seen >= expected { return }
        let token = UUID()
        await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                installWaiter(continuation, token: token)
            }
        } onCancel: {
            Task { await self.resumeOnCancel(token: token) }
        }
    }

    private func installWaiter(_ continuation: CheckedContinuation<Void, Never>, token: UUID) {
        if seen >= expected || Task.isCancelled {
            continuation.resume()
            return
        }
        waiters[token] = continuation
    }

    private func resumeOnCancel(token: UUID) {
        guard let continuation = waiters.removeValue(forKey: token) else { return }
        continuation.resume()
    }
}

/// One-shot broadcast latch: any number of `wait()` callers suspend until the first
/// `fire()` resumes them all. Cancellation routes per-token so a single cancelled
/// waiter does not release its siblings — a regression to "any cancel resumes
/// everyone" was the bug iter 2 fixed.
///
/// Two role-named aliases below (`ReleaseLatch`, `HelloReceivedLatch`) give the held
/// gameplay session and pre-login session role-readable names at the call site without
/// duplicating the actor body.
actor OneShotLatch {
    private var fired = false
    private var waiters: [UUID: CheckedContinuation<Void, Never>] = [:]

    func fire() {
        guard !fired else { return }
        fired = true
        let toResume = waiters
        waiters.removeAll()
        for (_, continuation) in toResume {
            continuation.resume()
        }
    }

    func wait() async {
        if fired { return }
        let token = UUID()
        await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                installWaiter(continuation, token: token)
            }
        } onCancel: {
            Task { await self.resumeOnCancel(token: token) }
        }
    }

    /// Role-named entry point for held gameplay sessions: the test body calls
    /// `release()` to fire the latch after admin assertions land. Equivalent to
    /// `fire()`; kept for call-site readability.
    func release() {
        fire()
    }

    /// Role-named entry point for the pre-login session: drain fires `signal()` when
    /// the server's Hello frame lands so the test body can wait for the pre-login
    /// socket to be observably alive before broadcasting.
    func signal() {
        fire()
    }

    private func installWaiter(_ continuation: CheckedContinuation<Void, Never>, token: UUID) {
        if fired || Task.isCancelled {
            continuation.resume()
            return
        }
        waiters[token] = continuation
    }

    private func resumeOnCancel(token: UUID) {
        guard let continuation = waiters.removeValue(forKey: token) else { return }
        continuation.resume()
    }
}

typealias ReleaseLatch = OneShotLatch
typealias HelloReceivedLatch = OneShotLatch

/// Open a `/ws` session, log in, drain to attached state, then hold the connection open
/// until `release` fires (or the server closes the read loop, e.g. on an admin kick).
/// Returns whatever close frame the underlying `WebSocketClient.connect` surfaces.
@discardableResult
// swiftlint:disable:next function_parameter_count
func runHeldGameplaySession(
    testClient: any TestClientProtocol,
    nickname: String,
    recorder: FrameRecorder,
    attached: AttachCountdown,
    release: ReleaseLatch,
    logger: Logger
) async throws -> WebSocketCloseFrame? {
    try await testClient.ws("/ws", configuration: WSGameplayClient.wsConfig(), logger: logger) { inbound, outbound, _ in
        try await WSGameplayClient.registerAndLogin(nickname: nickname, on: outbound)
        try await drainHeld(inbound: inbound, recorder: recorder, attached: attached, release: release)
        try? await outbound.close(.normalClosure, reason: nil)
    }
}

/// Open a `/ws` session WITHOUT logging in. The server emits `Hello` on connect and
/// nothing else; the session sits in `awaitingLogin` until `release` fires. The
/// `helloReceived` latch fires once the server's Hello frame lands so a test body can
/// wait for the pre-login socket to be observably alive before broadcasting.
@discardableResult
func runHeldPreLoginSession(
    testClient: any TestClientProtocol,
    recorder: FrameRecorder,
    release: ReleaseLatch,
    helloReceived: HelloReceivedLatch,
    logger: Logger
) async throws -> WebSocketCloseFrame? {
    try await testClient.ws("/ws", configuration: WSGameplayClient.wsConfig(), logger: logger) { inbound, outbound, _ in
        try await drainHeld(inbound: inbound, recorder: recorder, attached: nil, helloReceived: helloReceived, release: release)
        try? await outbound.close(.normalClosure, reason: nil)
    }
}

private func drainHeld(
    inbound: WebSocketInboundStream,
    recorder: FrameRecorder,
    attached: AttachCountdown?,
    helloReceived: HelloReceivedLatch? = nil,
    release: ReleaseLatch
) async throws {
    try await withThrowingTaskGroup(of: Void.self) { group in
        group.addTask {
            var didAttach = false
            for try await message in inbound.messages(maxSize: SomnioProtocolConstants.maxWireFrameSize) {
                guard case let .binary(buffer) = message else { continue }
                let frame = Data(buffer: buffer)
                await recorder.append(frame)
                if let decoded = try? SomnioMessageDecoder.decode(frame) {
                    if case .hello = decoded {
                        await helloReceived?.signal()
                    }
                    if !didAttach, let attached, case .dateTick = decoded {
                        didAttach = true
                        await attached.signal()
                    }
                }
            }
        }
        group.addTask {
            await release.wait()
        }
        _ = try await group.next()
        group.cancelAll()
    }
}
