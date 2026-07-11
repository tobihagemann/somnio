import Hummingbird
import Logging
import ServiceLifecycle
import Testing
@testable import SomnioTestSupport

/// Lifecycle coverage for `withLiveServer` beyond the happy path the migrated fixtures
/// exercise: the startup race's four outcomes, the bounded-teardown deadline, error
/// precedence between body and teardown, background-service failure surfacing, and
/// `ServiceEndedPromise`'s per-token cancellation routing (mirroring the `LatchTests`
/// coverage its sibling latches have in the IntegrationTests package).
///
/// The time limit makes a cancellation-routing regression fail deterministically: the
/// routing tests await a cancelled task's completion, which a broken promise would
/// never resume.
@Suite(.timeLimit(.minutes(1)))
struct LiveServerLifecycleTests {
    // MARK: - raceStartup branches

    @Test func `raceStartup returns the port when it wins the race`() async throws {
        let portPromise = PortPromise()
        let serviceEnded = ServiceEndedPromise()
        await portPromise.set(4242)
        let port = try await raceStartup(portPromise: portPromise, serviceEnded: serviceEnded, timeout: .seconds(5))
        #expect(port == 4242)
    }

    @Test func `raceStartup rethrows a service failure that lands before the port`() async throws {
        let portPromise = PortPromise()
        let serviceEnded = ServiceEndedPromise()
        await serviceEnded.set(.failure(SidecarFailure()))
        await #expect(throws: SidecarFailure.self) {
            _ = try await raceStartup(portPromise: portPromise, serviceEnded: serviceEnded, timeout: .seconds(5))
        }
    }

    @Test func `raceStartup maps a pre-bind service success to exitedBeforeBinding`() async throws {
        let portPromise = PortPromise()
        let serviceEnded = ServiceEndedPromise()
        await serviceEnded.set(.success(()))
        await #expect(throws: LiveServerStartupError.self) {
            _ = try await raceStartup(portPromise: portPromise, serviceEnded: serviceEnded, timeout: .seconds(5))
        }
    }

    @Test func `raceStartup times out when neither signal lands`() async throws {
        let portPromise = PortPromise()
        let serviceEnded = ServiceEndedPromise()
        await #expect(throws: TestTimeoutError.self) {
            _ = try await raceStartup(portPromise: portPromise, serviceEnded: serviceEnded, timeout: .milliseconds(100))
        }
    }

    // MARK: - Teardown

    @Test func `a background service failure after a successful body surfaces from withLiveServer`() async throws {
        let bodyFinished = ServiceEndedPromise()
        await #expect(throws: SidecarFailure.self) {
            try await withLiveServer(
                Self.makeIdleApplication(label: "test.live-server.sidecar-failure"),
                extraServices: [FailAfterSignalService(signal: bodyFinished, threw: nil)]
            ) { _ in
                await bodyFinished.set(.success(()))
            }
        }
    }

    /// Drives the deadline branch against a serverless `ServiceGroup` on purpose: a
    /// deadline test that cancels a live bound Hummingbird server would exercise the
    /// upstream shutdown wedge in-process and destabilize concurrently running live
    /// fixtures. The drain's integration into `withLiveServer` is plain call plumbing.
    @Test func `the bounded drain cancels the service task and throws LiveServerShutdownTimeout on the deadline`() async throws {
        let serviceEnded = ServiceEndedPromise()
        let started = ServiceEndedPromise()
        let group = makeLiveServerServiceGroup(
            services: [UnstoppableService(started: started)],
            logger: Logger(label: "test.live-server.shutdown-timeout")
        )
        let runTask = serviceEnded.captureRun(of: group)
        // `captureRun` only enqueues the run; wait until the group is actually running so
        // the drain's trigger cannot land on a not-yet-started group and skip the branch
        // under test.
        _ = await started.value()
        let runtime = LiveServerRuntime(
            serviceGroup: group,
            serviceEnded: serviceEnded,
            runTask: runTask,
            shutdownDeadline: .milliseconds(300)
        )
        await #expect(throws: LiveServerShutdownTimeout.self) {
            _ = try await drainLiveServer(runtime, client: nil)
        }
        // The deadline escalated to cancellation; the cooperative service must unwind
        // promptly and publish its outcome instead of lingering as a zombie.
        _ = try await serviceEnded.value(timeout: .seconds(5))
    }

    @Test func `a body error stays primary over a teardown service failure`() async throws {
        let bodyFinished = ServiceEndedPromise()
        let sidecarThrew = FirstWriteSlot<Bool>()
        await #expect(throws: BodyFailure.self) {
            try await withLiveServer(
                Self.makeIdleApplication(label: "test.live-server.body-error"),
                extraServices: [FailAfterSignalService(signal: bodyFinished, threw: sidecarThrew)]
            ) { (_: LiveTestClient) -> Int in
                await bodyFinished.set(.success(()))
                throw BodyFailure()
            }
        }
        // The precedence claim is only meaningful if the teardown really drained a failed
        // service; the marker proves the sidecar threw rather than ending cleanly.
        #expect(await sidecarThrew.value() == true)
    }

    // MARK: - ServiceEndedPromise routing

    @Test func `a cancelled ServiceEndedPromise waiter resumes alone and set resolves the rest`() async throws {
        let promise = ServiceEndedPromise()
        let aOutcome = OutcomeSlot()
        let bOutcome = OutcomeSlot()
        let taskA = Task { await aOutcome.set(promise.value()) }
        let taskB = Task { await bOutcome.set(promise.value()) }

        try await pollUntil { await promise.waiterCount == 2 }
        taskA.cancel()
        await taskA.value

        let sentinel = try #require(await aOutcome.value())
        guard case .success = sentinel else {
            Issue.record("a cancelled ServiceEndedPromise waiter must resume with the .success sentinel")
            return
        }
        #expect(await promise.waiterCount == 1, "the sibling waiter must stay suspended")
        #expect(await bOutcome.value() == nil)

        await promise.set(.failure(SidecarFailure()))
        await taskB.value
        let real = try #require(await bOutcome.value())
        guard case .failure = real else {
            Issue.record("the surviving waiter must receive the real failure outcome")
            return
        }
        #expect(await promise.waiterCount == 0)
    }

    @Test func `value(timeout:) throws TestTimeoutError when the service never ends`() async throws {
        let promise = ServiceEndedPromise()
        let waiting = Task { try await promise.value(timeout: .milliseconds(200)) }
        try await pollUntil { await promise.waiterCount == 1 }
        await #expect(throws: TestTimeoutError.self) { _ = try await waiting.value }
        #expect(await promise.waiterCount == 0, "the installed waiter must be torn down on timeout")
    }

    // MARK: - Fixtures

    private static func makeIdleApplication(label: String) -> some ApplicationProtocol {
        Application(
            router: Router(),
            configuration: ApplicationConfiguration(address: .hostname("127.0.0.1", port: 0)),
            logger: Logger(label: label)
        )
    }
}

/// Marker error thrown by the failing sidecar; the helper must surface exactly this error.
private struct SidecarFailure: Error {}

/// Marker error thrown by a failing body; it must win over any teardown error.
private struct BodyFailure: Error {}

/// Sidecar that waits for `signal` and then fails, so the failure deterministically lands
/// after the body ran instead of racing the startup port publication. Marks `threw` when
/// provided, so a test can prove the failure actually happened.
private struct FailAfterSignalService: Service {
    let signal: ServiceEndedPromise
    var threw: FirstWriteSlot<Bool>?

    func run() async throws {
        _ = await signal.value()
        await threw?.set(true)
        throw SidecarFailure()
    }
}

/// Sidecar that never observes graceful shutdown; only task cancellation ends it, so the
/// bounded teardown's deadline is the only way out. Publishes `started` so a test can
/// wait until the group is actually running before triggering shutdown.
private struct UnstoppableService: Service {
    let started: ServiceEndedPromise

    func run() async throws {
        await started.set(.success(()))
        try await Task.sleep(for: .seconds(3600))
    }
}

/// Ferries a waiter's outcome out of its task for the routing assertions.
private typealias OutcomeSlot = FirstWriteSlot<Result<Void, any Error>>
