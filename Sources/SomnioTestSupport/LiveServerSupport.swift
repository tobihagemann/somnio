import Foundation
import HTTPTypes
import Hummingbird
import HummingbirdCore
import HummingbirdTesting
import HummingbirdWSClient
import Logging
import NIOCore
import ServiceLifecycle

/// Thrown by `withLiveServer` when the service group ends without the server ever binding
/// a port, so the failure carries a cause instead of surfacing as a generic timeout.
public enum LiveServerStartupError: Error {
    case exitedBeforeBinding
}

/// Thrown when the bounded teardown deadline elapses before client cleanup plus graceful
/// shutdown complete. The service task has been cancelled by then; a service that ignores
/// both graceful shutdown and cancellation can still outlive the throw (see `withLiveServer`).
public struct LiveServerShutdownTimeout: Error {
    public init() {}
}

/// Response surfaced by `LiveTestClient.execute`. Mirrors `HummingbirdTesting.TestResponse`,
/// which has no public initializer and therefore cannot be constructed outside that module.
public struct LiveTestResponse: Sendable {
    public let head: HTTPResponse
    public var status: HTTPResponse.Status {
        head.status
    }

    public var headers: HTTPFields {
        head.headerFields
    }

    public let body: ByteBuffer
    public let trailerHeaders: HTTPFields?
}

/// Client handle passed to a `withLiveServer` body. Wraps `HummingbirdTesting.TestClient`
/// with the surface the live fixtures use: `execute` for HTTP requests and `ws` for
/// WebSocket upgrades against the bound port. Not a `TestClientProtocol` conformance —
/// the protocol's return type `TestResponse` has no public initializer, so the protocol
/// cannot be implemented outside HummingbirdTesting.
public struct LiveTestClient: Sendable {
    let client: TestClient

    /// The bound server port. Non-optional because `withLiveServer` constructs the client
    /// only after the startup race resolves a bound port.
    public let port: Int

    @discardableResult public func execute<Return>(
        uri: String,
        method: HTTPRequest.Method,
        headers: HTTPFields = [:],
        body: ByteBuffer? = nil,
        testCallback: @escaping (LiveTestResponse) async throws -> Return = { $0 }
    ) async throws -> Return {
        var headers = headers
        headers[.connection] = "keep-alive"
        let request = TestClient.Request(uri, method: method, authority: "localhost", headers: headers, body: body)
        let response = try await client.execute(request)
        let testResponse = LiveTestResponse(
            head: response.head,
            body: response.body ?? ByteBuffer(),
            trailerHeaders: response.trailerHeaders
        )
        return try await testCallback(testResponse)
    }

    /// Mirrors `HummingbirdWSTesting`'s `TestClientProtocol.ws`, which only reads the
    /// client's port, so reimplementing it against the bound port is safe.
    @discardableResult public func ws(
        _ path: String,
        configuration: WebSocketClientConfiguration = .init(),
        logger: Logger = Logger(label: "test.live-server.client"),
        handler: @escaping WebSocketDataHandler<WebSocketClient.Context>
    ) async throws -> WebSocketCloseFrame? {
        try await WebSocketClient.connect(
            url: "ws://localhost:\(port)\(path)",
            configuration: configuration,
            logger: logger,
            handler: handler
        )
    }
}

/// Runs `body` against a live instance of `app`, replacing HummingbirdTesting's
/// `application.test(.live)`, whose two unbounded awaits intermittently hang the whole
/// test process: a non-cancellable port wait that suspends forever when the server fails
/// to bind (the bind error stays buffered, unobserved, in its task group), and a teardown
/// that awaits graceful shutdown with no deadline.
///
/// This helper bounds both. Startup races the port signal against service completion
/// under `startupTimeout`, so a bind failure rethrows the real error immediately.
/// Teardown runs the entire cleanup — client shutdown, graceful shutdown, drain — under
/// one `shutdownDeadline`, escalating to service-task cancellation plus a thrown
/// `LiveServerShutdownTimeout` when it elapses.
///
/// The deadline guarantee is cooperative, not absolute: structured concurrency must still
/// await the service child, so a service that ignores both graceful shutdown and
/// cancellation can hang past the deadline. Hummingbird's `ServiceGroup` cooperates; true
/// absolute containment would require subprocess isolation. The body itself is
/// deliberately unbounded — the live fixtures self-terminate on server-driven WS closes,
/// and a suite-level `.timeLimit` trait is the right net for body-side bugs.
public func withLiveServer<Value: Sendable>(
    _ app: some ApplicationProtocol,
    extraServices: [any Service] = [],
    startupTimeout: Duration = .seconds(5),
    shutdownDeadline: Duration = .seconds(10),
    logger: Logger = Logger(label: "test.live-server"),
    _ body: @Sendable (LiveTestClient) async throws -> Value
) async throws -> Value {
    let portPromise = PortPromise()
    let serviceEnded = ServiceEndedPromise()
    let wrappedApp = PortObservingApplication(base: app, portPromise: portPromise)
    let serviceGroup = makeLiveServerServiceGroup(services: [wrappedApp] + extraServices, logger: logger)
    let runTask = serviceEnded.captureRun(of: serviceGroup)
    let runtime = LiveServerRuntime(
        serviceGroup: serviceGroup,
        serviceEnded: serviceEnded,
        runTask: runTask,
        shutdownDeadline: shutdownDeadline
    )

    let port: Int
    do {
        port = try await raceStartup(portPromise: portPromise, serviceEnded: serviceEnded, timeout: startupTimeout)
    } catch {
        _ = try? await drainLiveServer(runtime, client: nil)
        throw error
    }

    let client = TestClient(host: "localhost", port: port, configuration: .init(timeout: .seconds(20)))
    client.connect()
    let bodyOutcome: Result<Value, any Error>
    do {
        bodyOutcome = try await .success(body(LiveTestClient(client: client, port: port)))
    } catch {
        bodyOutcome = .failure(error)
    }
    switch bodyOutcome {
    case let .success(value):
        let serviceOutcome = try await drainLiveServer(runtime, client: client)
        try serviceOutcome.get()
        return value
    case let .failure(bodyError):
        _ = try? await drainLiveServer(runtime, client: client)
        throw bodyError
    }
}

/// The moving parts of one live-server run that teardown needs, bundled so each drain
/// call site stays a one-liner.
struct LiveServerRuntime {
    let serviceGroup: ServiceGroup
    let serviceEnded: ServiceEndedPromise
    let runTask: Task<Void, Never>
    let shutdownDeadline: Duration
}

/// Wraps the application under test to observe the bound port, mirroring
/// `HummingbirdTesting.TestApplication`: rebinds to `localhost:0` and publishes the port
/// from `onServerRunning` after forwarding to the base application's own hook.
private struct PortObservingApplication<Base: ApplicationProtocol>: ApplicationProtocol {
    typealias Responder = Base.Responder

    let base: Base
    let portPromise: PortPromise

    var responder: Responder {
        get async throws { try await base.responder }
    }

    var server: HTTPServerBuilder {
        base.server
    }

    var eventLoopGroup: any EventLoopGroup {
        base.eventLoopGroup
    }

    var configuration: ApplicationConfiguration {
        base.configuration.with(address: .hostname("localhost", port: 0))
    }

    var logger: Logger {
        base.logger
    }

    var services: [any Service] {
        base.services
    }

    var processesRunBeforeServerStart: [@Sendable () async throws -> Void] {
        base.processesRunBeforeServerStart
    }

    @Sendable func onServerRunning(_ channel: any Channel) async {
        await base.onServerRunning(channel)
        if let port = channel.localAddress?.port {
            await portPromise.set(port)
        }
    }
}

private enum StartupSignal {
    case port(Int)
    case serviceEnded(Result<Void, any Error>)
}

/// Race the port publication against service completion so a bind failure rethrows its
/// real error immediately instead of hanging (or surfacing as a generic timeout). Both
/// children read cancellation-aware promises — never an unstructured `Task.value` — so
/// `cancelAll()` promptly unblocks the loser and its sentinel value is discarded.
/// Public so the IntegrationTests early-shutdown rig shares the same startup semantics
/// (and so the unit suite can drive each branch deterministically).
public func raceStartup(
    portPromise: PortPromise,
    serviceEnded: ServiceEndedPromise,
    timeout: Duration
) async throws -> Int {
    try await withTestTimeout(timeout) {
        try await withThrowingTaskGroup(of: StartupSignal.self) { group in
            group.addTask { await .port(portPromise.value()) }
            group.addTask { await .serviceEnded(serviceEnded.value()) }
            guard let first = try await group.next() else { throw TestTimeoutError() }
            group.cancelAll()
            switch first {
            case let .port(port):
                return port
            case let .serviceEnded(outcome):
                try outcome.get()
                throw LiveServerStartupError.exitedBeforeBinding
            }
        }
    }
}

/// One deadline over the whole cleanup: client shutdown, graceful shutdown, drain. The
/// deadline starts before `client.shutdown()` so a stalled client cannot eat the budget
/// unobserved. Drains through the cancellation-aware `serviceEnded` promise. When the
/// deadline wins, cancels the service task and throws `LiveServerShutdownTimeout`.
/// Internal so the unit suite can drive the deadline branch against a serverless
/// `ServiceGroup` — deliberately: cancelling a live bound Hummingbird server mid-run
/// exercises the upstream wedge and pollutes concurrently running live fixtures.
func drainLiveServer(_ runtime: LiveServerRuntime, client: TestClient?) async throws -> Result<Void, any Error> {
    do {
        return try await withTestTimeout(runtime.shutdownDeadline) {
            if let client {
                try? await client.shutdown()
            }
            await runtime.serviceGroup.triggerGracefulShutdown()
            return await runtime.serviceEnded.value()
        }
    } catch is TestTimeoutError {
        runtime.runTask.cancel()
        throw LiveServerShutdownTimeout()
    }
}

/// Builds the `ServiceGroup` shape every live-server rig uses: per-service graceful
/// shutdown on both success and failure, no signal handling. Public so the
/// IntegrationTests early-shutdown rig runs the same policy instead of a drifting copy.
public func makeLiveServerServiceGroup(services: [any Service], logger: Logger) -> ServiceGroup {
    ServiceGroup(
        configuration: ServiceGroupConfiguration(
            services: services.map {
                ServiceGroupConfiguration.ServiceConfiguration(
                    service: $0,
                    successTerminationBehavior: .gracefullyShutdownGroup,
                    failureTerminationBehavior: .gracefullyShutdownGroup
                )
            },
            gracefulShutdownSignals: [],
            logger: logger
        )
    )
}
