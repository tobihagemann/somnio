import Foundation
import Hummingbird
import HummingbirdWebSocket
import Logging
import NIOCore
import PostgresNIO
import SomnioCore
import SomnioData
import SomnioProtocol
import SomnioServerCore

/// Builds a minimal Hummingbird application that mounts the production `/ws`, `/health`,
/// and `/admin` routes via `makeSomnioServerApplication`. The factory is the integration
/// suite's counterpart to `SomnioServerCore`'s admin-only `AdminRouteTestApplication`,
/// but it stays inside the integration package so the test target can keep its dependency
/// graph independent of `SomnioTestSupport`.
enum GameplayRouteTestApplication {
    /// Build a configured application bound to `127.0.0.1:0` with the supplied gameplay +
    /// admin dependencies. `onServerRunning` is forwarded to Hummingbird so the
    /// `ServiceGroup` rig in tick-driven tests can hand back the bound port.
    static func make(
        postgres: PostgresClient,
        dependencies: ConnectionDependencies,
        adminDependencies: AdminConnectionDependencies,
        adminToken: String,
        onServerRunning: (@Sendable (any Channel) async -> Void)? = nil
    ) -> Application<RouterResponder<BasicWebSocketRequestContext>> {
        let configuration = ServerConfiguration(
            httpHost: "127.0.0.1",
            httpPort: 0,
            adminToken: adminToken,
            sectorsDirectory: URL(fileURLWithPath: "/tmp", isDirectory: true)
        )
        return makeSomnioServerApplication(
            configuration: configuration,
            postgres: postgres,
            dependencies: dependencies,
            adminDependencies: adminDependencies,
            onServerRunning: onServerRunning
        )
    }

    /// Build a minimal `AdminConnectionDependencies` suitable for the E2E flows that don't
    /// exercise admin routes. Mirrors `AdminRouteTestApplication.makeDependencies` in shape
    /// but stays inside the integration package — the integration target intentionally does
    /// not depend on `SomnioTestSupport`, which is private to the main package's siblings.
    static func makeAdminDependencies(
        worldRouter: WorldRouter,
        worldClock: WorldClockService,
        logger: Logger
    ) async throws -> AdminConnectionDependencies {
        let logsDirectory = FileManager.default
            .temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: logsDirectory, withIntermediateDirectories: true)
        return AdminConnectionDependencies(
            worldRouter: worldRouter as any AdminWorldRouter,
            worldClock: worldClock,
            serverVersion: "test-version",
            logsDirectory: logsDirectory,
            gameplayLogFileName: "gameplay-log.log",
            adminLogFileName: "admin-log.log",
            logger: logger
        )
    }
}
