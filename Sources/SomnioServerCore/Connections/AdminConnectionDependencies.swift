import Foundation
import Logging
import SomnioProtocol

/// Surface of `WorldRouter` the admin dispatcher consumes. Typing the router dependency
/// against this protocol lets dispatcher tests substitute a struct stub — `WorldRouter`
/// is an actor and actors are not subclassable, so this is the only available mock
/// seam. `WorldRouter`'s public `async` methods (added for admin verbs and the existing
/// broadcast helper) satisfy the requirements automatically via cross-actor hops; no
/// `nonisolated` modifier is needed.
public protocol AdminWorldRouter: Sendable {
    func loggedInPlayerCount() async -> Int
    func kickByCharacterName(_ name: String) async -> Bool
    func broadcastToAllConnections(_ message: SomnioMessage) async
}

extension WorldRouter: AdminWorldRouter {}

/// Bag of dependencies the `AdminConnectionActor` and `AdminCommandDispatcher`
/// consume. Constructed once in `runServer` and passed into
/// `makeSomnioServerApplication` alongside the gameplay-side `ConnectionDependencies`.
public struct AdminConnectionDependencies: Sendable {
    public let worldRouter: any AdminWorldRouter
    public let worldClock: WorldClockService
    public let serverVersion: String
    public let logsDirectory: URL
    public let gameplayLogFileName: String
    public let adminLogFileName: String
    public let logger: Logger

    public init(
        worldRouter: any AdminWorldRouter,
        worldClock: WorldClockService,
        serverVersion: String,
        logsDirectory: URL,
        gameplayLogFileName: String,
        adminLogFileName: String,
        logger: Logger
    ) {
        self.worldRouter = worldRouter
        self.worldClock = worldClock
        self.serverVersion = serverVersion
        self.logsDirectory = logsDirectory
        self.gameplayLogFileName = gameplayLogFileName
        self.adminLogFileName = adminLogFileName
        self.logger = logger
    }
}
