import Foundation
import Logging
import ServiceLifecycle
import SomnioCore
import SomnioData

/// Cross-sector router. Owns one `PerSectorActor` per loaded sector and the dictionary
/// of currently logged-in connection actors keyed by account id (single-character-per-account
/// MVP). Conforms to `ServiceLifecycle.Service` so the shutdown drain runs in
/// shutdown-order *before* the Hummingbird app exits its accept loop and *after* the
/// checkpoint timer is stopped.
public actor WorldRouter: Service {
    private let sectorActors: [String: PerSectorActor]
    private var loggedInConnections: [UUID: ConnectionActor] = [:]
    private let logger: Logger
    private let characters: any CharacterRepository

    public init(
        sectors: [String: Sector],
        characters: any CharacterRepository,
        logger: Logger
    ) {
        let sectorLogger = Logger(label: "de.tobiha.somnio.server.gameplay.sector")
        var actors: [String: PerSectorActor] = [:]
        for (name, sector) in sectors {
            actors[name] = PerSectorActor(staticSector: sector, logger: sectorLogger)
        }
        self.sectorActors = actors
        self.characters = characters
        self.logger = logger
    }

    public func sectorActor(named name: String) -> PerSectorActor? {
        sectorActors[name]
    }

    /// Returns `false` when the same `accountId` is already registered — the caller maps
    /// that to `LoginResultCode.alreadyLoggedIn` and closes the second connection after the
    /// response.
    public func register(actor: ConnectionActor, accountId: UUID) -> Bool {
        guard loggedInConnections[accountId] == nil else { return false }
        loggedInConnections[accountId] = actor
        return true
    }

    public func unregister(accountId: UUID) {
        loggedInConnections.removeValue(forKey: accountId)
    }

    /// Periodic checkpoint pass — write every logged-in player's full character + inventory
    /// snapshot. Iterates per sector so the per-sector actor's snapshot list is captured at
    /// one isolation boundary. The atomic transaction inside `CharacterRepository.persistCheckpoint`
    /// gates both the character UPDATE and the inventory replace on the `last_seen` guard, so
    /// a periodic pass and a per-disconnect snapshot for the same character can't race-overwrite
    /// each other regardless of which transaction commits last.
    public func checkpointAll() async {
        for (sectorName, sector) in sectorActors {
            let snapshots = await sector.snapshotForCheckpoint()
            for snapshot in snapshots {
                await PlayerCheckpointWriter.persist(
                    snapshot,
                    characters: characters,
                    logger: logger,
                    context: ["sector": "\(sectorName)"]
                )
            }
        }
    }

    /// `Service` entry point. Awaits graceful shutdown, then drains every logged-in
    /// connection in parallel: each connection's actor enqueues a final `leave`, snapshots
    /// the player, finishes the outbox, and the writer task drains queued frames before
    /// the WebSocket is closed by Hummingbird's own teardown.
    public func run() async throws {
        try await gracefulShutdown()
        let connections = Array(loggedInConnections.values)
        guard !connections.isEmpty else { return }
        await withTaskGroup(of: Void.self) { group in
            for actor in connections {
                group.addTask {
                    await actor.drainForShutdown()
                }
            }
            await group.waitForAll()
        }
        loggedInConnections.removeAll()
    }
}
