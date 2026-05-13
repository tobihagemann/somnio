import Foundation
import SomnioProtocol
import SomnioServerCore

/// Configurable stub for the admin dispatcher's `AdminWorldRouter` seam. Records every
/// `broadcastToAllConnections` call so tests can assert exactly which `.adminSay` (or
/// future) frames the dispatcher fans out, and lets each test pin `loggedInPlayerCount`
/// and `kickByCharacterName` outcomes.
public actor StubAdminWorldRouter: AdminWorldRouter {
    private var playerCount: Int = 0
    private var kickOutcome: Bool = false
    private var broadcasts: [SomnioMessage] = []

    public init() {}

    public func setPlayerCount(_ count: Int) {
        playerCount = count
    }

    public func setKickOutcome(_ value: Bool) {
        kickOutcome = value
    }

    public func recordedBroadcasts() -> [SomnioMessage] {
        broadcasts
    }

    public func loggedInPlayerCount() async -> Int {
        playerCount
    }

    public func kickByCharacterName(_: String) async -> Bool {
        kickOutcome
    }

    public func broadcastToAllConnections(_ message: SomnioMessage) async {
        broadcasts.append(message)
    }
}
