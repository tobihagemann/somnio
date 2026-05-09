import Foundation
import Logging
import ServiceLifecycle
import SomnioCore
import SomnioData
import SomnioProtocol

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
    private let npcDialogStates: any NPCDialogStateRepository

    public init(
        sectors: [String: Sector],
        characters: any CharacterRepository,
        npcDialogStates: any NPCDialogStateRepository,
        logger: Logger
    ) async throws {
        let sectorLogger = Logger(label: "de.tobiha.somnio.server.gameplay.sector")
        var actors: [String: PerSectorActor] = [:]
        for (name, sector) in sectors {
            let states = try await npcDialogStates.loadAll(sectorName: name)
            var cursors: [Int16: Int16] = [:]
            for state in states {
                cursors[state.npcIndex] = state.scriptStep
            }
            actors[name] = PerSectorActor(
                staticSector: sector,
                logger: sectorLogger,
                initialDialogCursors: cursors
            )
        }
        self.sectorActors = actors
        self.characters = characters
        self.npcDialogStates = npcDialogStates
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

    /// One AI-tick pass across every loaded sector. Persists each digest's dialog upserts
    /// and resets through the repository; persistence failure logs a warning but does not
    /// tear down the loop — the next emit's upsert rewrites the row, and the in-process
    /// cursor is the source of truth between writes.
    public func runAITickAcrossSectors() async {
        for (sectorName, sector) in sectorActors {
            let digest = await sector.runAITick()
            for state in digest.dialogUpserts {
                do {
                    try await npcDialogStates.upsert(state)
                } catch {
                    logger.warning(
                        "npc dialog upsert failed",
                        metadata: [
                            "error": "\(error)",
                            "sector": "\(sectorName)",
                            "npc_index": "\(state.npcIndex)"
                        ]
                    )
                }
            }
            for key in digest.dialogResets {
                do {
                    try await npcDialogStates.reset(sectorName: key.sectorName, npcIndex: key.npcIndex)
                } catch {
                    logger.warning(
                        "npc dialog reset failed",
                        metadata: [
                            "error": "\(error)",
                            "sector": "\(key.sectorName)",
                            "npc_index": "\(key.npcIndex)"
                        ]
                    )
                }
            }
        }
    }

    /// Encode once and fan out to every logged-in *and attached* connection's outbox. The
    /// dictionary is snapshotted before the per-connection `await connectionOutbox` so a
    /// reentrant register/unregister call during the iteration cannot mutate the underlying
    /// dictionary while we walk it. The attach gate is load-bearing: `LoginHandler` registers
    /// the connection before it sends `loginResult.ok` and the join sequence, so a tick that
    /// landed an unguarded broadcast in the gap would put a `dateTick` on the wire ahead of
    /// `loginResult` — violating the documented join-sequence ordering.
    public func broadcastToAllConnections(_ message: SomnioMessage) async {
        let frame: Data
        do {
            frame = try SomnioMessageEncoder.encode(message)
        } catch {
            logger.warning(
                "failed to encode broadcast",
                metadata: ["error": "\(error)"]
            )
            return
        }
        let snapshot = Array(loggedInConnections.values)
        for actor in snapshot {
            guard case .attached = await actor.currentState else { continue }
            let outbox = await actor.connectionOutbox
            outbox.send(frame)
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
