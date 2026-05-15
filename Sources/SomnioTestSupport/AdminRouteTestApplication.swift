import Foundation
import Hummingbird
import HummingbirdWebSocket
import Logging
import SomnioCore
import SomnioData
import SomnioProtocol
import SomnioServerCore

/// Builds a minimal Hummingbird application that mounts only the `/admin` route via
/// `mountAdminRoute(on:adminToken:adminDependencies:)`. Used by both `SomnioServerCoreTests`
/// and `SomnioCLICoreTests` to drive auth-gate, dispatch, and transport behavior live
/// without standing up Postgres or the `/health` and `/ws` routes.
public enum AdminRouteTestApplication {
    public static func make(
        adminToken: String,
        adminDependencies: AdminConnectionDependencies
    ) -> Application<RouterResponder<BasicWebSocketRequestContext>> {
        let router = Router(context: BasicWebSocketRequestContext.self)
        mountAdminRoute(on: router, adminToken: adminToken, adminDependencies: adminDependencies)
        let webSocketConfiguration = WebSocketServerConfiguration(
            maxFrameSize: SomnioProtocolConstants.maxWireFrameSize
        )
        return Application(
            router: router,
            server: .http1WebSocketUpgrade(
                webSocketRouter: router,
                configuration: webSocketConfiguration
            ),
            configuration: ApplicationConfiguration(address: .hostname("127.0.0.1", port: 0)),
            logger: Logger(label: "test.admin.route.app")
        )
    }

    /// Build an `AdminConnectionDependencies` bag suitable for live tests. The caller may
    /// pin a specific `logsDirectory` (e.g., a fixture-controlled temp dir the test then
    /// writes log files into) or a non-default `initialClock`; both default to a fresh
    /// temp directory and `WorldClock.bootDefault`, which is what live route tests use.
    public static func makeDependencies(
        worldRouter: any AdminWorldRouter,
        serverVersion: String = "test-version",
        logsDirectory: URL? = nil,
        initialClock: WorldClock = .bootDefault
    ) async throws -> AdminConnectionDependencies {
        let logger = Logger(label: "test.admin.route.deps")
        let routerForClock = try await WorldRouter(
            sectors: [:],
            characters: StubCharacterRepository(),
            npcDialogStates: StubNPCDialogStateRepository(),
            logger: logger
        )
        let worldClock = WorldClockService(
            worldRouter: routerForClock,
            worldClocks: StubWorldClockRepository(),
            initialClock: initialClock,
            logger: logger
        )
        let directory: URL
        if let logsDirectory {
            directory = logsDirectory
        } else {
            directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        }
        return AdminConnectionDependencies(
            worldRouter: worldRouter,
            worldClock: worldClock,
            serverVersion: serverVersion,
            logsDirectory: directory,
            gameplayLogFileName: "gameplay-log.log",
            adminLogFileName: "admin-log.log",
            logger: logger
        )
    }
}
