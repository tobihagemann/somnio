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
    /// Per-account record in `loggedInConnections`. The normalized name is cached at
    /// register time so `kickByCharacterName` has a synchronous lookup against the
    /// snapshot — see the helper below — and there is no transient `nil` window an
    /// after-attach write would create. The normalized form mirrors the Postgres
    /// `LOWER(NORMALIZE(name, NFKC))` collation so a `kick saibot` lands the character the
    /// operator looked up by name elsewhere (e.g. through the data layer).
    private struct LoggedInEntry {
        let actor: ConnectionActor
        let normalizedName: String
    }

    /// Mirrors the SQL `LOWER(NORMALIZE(name, NFKC))` collation used by every `name_normalized`
    /// generated column in the schema.
    private static func normalize(_ name: String) -> String {
        name.precomposedStringWithCompatibilityMapping.lowercased()
    }

    private let sectorActors: [String: PerSectorActor]
    private var loggedInConnections: [UUID: LoggedInEntry] = [:]
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
    /// response. `characterName` is pinned at registration so admin kick-by-name lookups
    /// work the moment the connection enters `loggedInConnections`, before
    /// `LoginHandler` has had a chance to call `markAttached`.
    public func register(actor: ConnectionActor, accountId: UUID, characterName: String) -> Bool {
        guard loggedInConnections[accountId] == nil else { return false }
        loggedInConnections[accountId] = LoggedInEntry(
            actor: actor,
            normalizedName: Self.normalize(characterName)
        )
        return true
    }

    public func unregister(accountId: UUID) {
        loggedInConnections.removeValue(forKey: accountId)
    }

    /// Number of currently logged-in *and attached* connections. Mirrors the attached-only
    /// gate in `broadcastToAllConnections` so the count excludes the post-register /
    /// pre-attach window. The per-connection `currentState` check is cross-actor, so the
    /// helper is `async`; the count is therefore a near-real-time approximation rather
    /// than a transactional snapshot, matching the legacy semantics. The snapshot is
    /// taken once at entry, so a connection that unregisters during the iteration may
    /// still be counted, and a connection that registers after the snapshot is missed
    /// — an operator polling `players` immediately around a login/logout sees this
    /// drift, but the steady-state count is correct.
    public func loggedInPlayerCount() async -> Int {
        let snapshot = Array(loggedInConnections.values)
        var count = 0
        for entry in snapshot {
            guard case .attached = await entry.actor.currentState else { continue }
            count += 1
        }
        return count
    }

    /// Disconnect every logged-in connection whose cached character name matches `name`.
    /// The scan over the snapshot is synchronous — no cross-actor calls between matches —
    /// so the router's isolation is not yielded mid-iteration; only the per-match
    /// `disconnectForAdminKick()` cross-actor hop suspends. Returns `true` when at least
    /// one match was kicked. The kicked connection's own read-loop exit path owns
    /// `worldRouter.unregister`, so the dictionary entry leaves `loggedInConnections`
    /// asynchronously after the cancelled loop unwinds.
    public func kickByCharacterName(_ name: String) async -> Bool {
        let needle = Self.normalize(name)
        let snapshot = Array(loggedInConnections.values)
        let matches = snapshot.filter { $0.normalizedName == needle }
        for entry in matches {
            await entry.actor.disconnectForAdminKick()
        }
        return !matches.isEmpty
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
        for entry in snapshot {
            guard case .attached = await entry.actor.currentState else { continue }
            let outbox = await entry.actor.connectionOutbox
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
            for entry in connections {
                group.addTask {
                    await entry.actor.drainForShutdown()
                }
            }
            await group.waitForAll()
        }
        loggedInConnections.removeAll()
    }
}
