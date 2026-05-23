import Foundation
import Hummingbird
import HummingbirdWebSocket
import Logging
import NIOCore
import PostgresNIO
import SomnioServerCore

/// Builds a Hummingbird application mounting the production `/ws`, `/health`, and
/// `/admin` routes for live E2E tests.
public enum GameplayRouteTestApplication {
    /// Build a configured application bound to `127.0.0.1:0`. `onServerRunning` is
    /// forwarded so a `ServiceGroup` rig can hand back the bound port. `sectorsDirectory`
    /// only matters for callers that exercise sector reload from disk.
    public static func make(
        postgres: PostgresClient,
        dependencies: ConnectionDependencies,
        adminDependencies: AdminConnectionDependencies,
        adminToken: String,
        sectorsDirectory: URL = URL(fileURLWithPath: "/tmp", isDirectory: true),
        onServerRunning: (@Sendable (any Channel) async -> Void)? = nil
    ) -> Application<RouterResponder<BasicWebSocketRequestContext>> {
        let configuration = ServerConfiguration(
            httpHost: "127.0.0.1",
            httpPort: 0,
            adminToken: adminToken,
            sectorsDirectory: sectorsDirectory
        )
        return makeSomnioServerApplication(
            configuration: configuration,
            postgres: postgres,
            dependencies: dependencies,
            adminDependencies: adminDependencies,
            onServerRunning: onServerRunning
        )
    }

    /// Bag built around a pre-existing `WorldClockService`. Allocates a temp dir for
    /// the gameplay/admin log file pair.
    public static func makeAdminDependencies(
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
