import Foundation
import Logging
import SomnioCore
import SomnioData
import SomnioProtocol
import SomnioTestSupport
import Testing
@testable import SomnioServerCore

/// Coverage for the new `WorldRouter` boundaries: `runAITickAcrossSectors()` (persistence
/// fault tolerance) and `broadcastToAllConnections(_:)` (encode-once fan-out + attached-only
/// gating + reentrancy snapshot).
struct WorldRouterTests {
    @Test func `runAITickAcrossSectors persists single step wrap reset and skips empty script noop`() async throws {
        // Two sectors with different terminal cases: sector A's single-step script wraps on
        // first emit and produces a reset key in the digest; sector B's empty script takes
        // the no-op branch in `runNPCTick` branch (e) and writes nothing. Together they
        // verify (1) the per-sector iteration crosses both sectors, and (2) the dispatch
        // of `dialogResets` through the repository runs end-to-end on the wrap branch.
        // The non-final upsert path is covered by the next test.
        let dialogRepo = RecordingNPCDialogStateRepository()
        let routerLogger = Logger(label: "test.world-router.persistence")
        let router = try await WorldRouter(
            sectors: [
                "A": makeSector(name: "A", npcs: [makeNPC(at: GridPoint(x: 0, y: 0), dialogScript: "hi $name.")]),
                "B": makeSector(name: "B", npcs: [makeNPC(at: GridPoint(x: 0, y: 0), dialogScript: "")])
            ],
            characters: StubCharacterRepository(),
            npcDialogStates: dialogRepo,
            logger: routerLogger
        )

        // Sector A: bump the single-step NPC so the next tick fires an emit + a reset
        // (single-step scripts wrap immediately, no upsert).
        let sectorA = try #require(await router.sectorActor(named: "A"))
        let outboxA = ConnectionOutbox(highWatermark: 1024)
        let entityIndexA = try await sectorA.attach(
            character: makeCharacter(name: "alice", at: GridPoint(x: 1, y: 1), sector: "A"),
            inventory: [],
            outbox: outboxA
        )
        await sectorA.handleBumpNPC(npcIndex: 1, from: entityIndexA)

        // Sector B: bump the empty-script NPC so the next tick takes the empty-script
        // no-op branch in `runNPCTick` (no digest entry, no broadcast).
        let sectorB = try #require(await router.sectorActor(named: "B"))
        let outboxB = ConnectionOutbox(highWatermark: 1024)
        let entityIndexB = try await sectorB.attach(
            character: makeCharacter(name: "bob", at: GridPoint(x: 1, y: 1), sector: "B"),
            inventory: [],
            outbox: outboxB
        )
        await sectorB.handleBumpNPC(npcIndex: 1, from: entityIndexB)

        await router.runAITickAcrossSectors()

        let upserts = await dialogRepo.upsertedSnapshot()
        let resets = await dialogRepo.resetSnapshot()
        #expect(upserts.isEmpty)
        let sawSectorAReset = resets.contains { $0.sector == "A" && $0.npcIndex == 1 }
        #expect(sawSectorAReset)
        let sawSectorBWrite = resets.contains { $0.sector == "B" } || upserts.contains { $0.sectorName == "B" }
        #expect(sawSectorBWrite == false)
    }

    @Test func `world router init pre loads persisted cursor from the repository`() async throws {
        // Persisted scriptStep = 2 should land on the per-sector actor's NPCRuntime via
        // `loadAll(sectorName:)` + `initialDialogCursors`. After bump + tick, the first
        // emit must therefore be the second dialog line — not the first. A regression that
        // dropped the `loadAll`/`initialDialogCursors` plumbing would silently restart
        // every NPC at step 1 across the world.
        let dialogRepo = SeededNPCDialogStateRepository(rows: [
            NPCDialogState(sectorName: "A", npcIndex: 1, scriptStep: 2)
        ])
        let router = try await WorldRouter(
            sectors: [
                "A": makeSector(
                    name: "A",
                    npcs: [makeNPC(at: GridPoint(x: 0, y: 0), dialogScript: "first line.\n---\nsecond line.")]
                )
            ],
            characters: StubCharacterRepository(),
            npcDialogStates: dialogRepo,
            logger: Logger(label: "test.world-router.preload")
        )
        let sector = try #require(await router.sectorActor(named: "A"))
        let outbox = ConnectionOutbox(highWatermark: 1024)
        let entityIndex = try await sector.attach(
            character: makeCharacter(name: "alice", at: GridPoint(x: 1, y: 1), sector: "A"),
            inventory: [],
            outbox: outbox
        )
        await sector.handleBumpNPC(npcIndex: 1, from: entityIndex)

        _ = await sector.runAITick()
        outbox.finish()
        let frames = await collect(outbox: outbox)
        let serverSays = frames.compactMap { frame -> String? in
            guard let message = try? SomnioMessageDecoder.decode(frame) else { return nil }
            if case let .serverSay(say) = message { return say.text }
            return nil
        }
        #expect(serverSays.contains("second line."))
        #expect(serverSays.contains("first line.") == false)
    }

    @Test func `runAITickAcrossSectors persists a non final dialog upsert through the repository`() async throws {
        // A multi-step script's first emit advances the cursor to step 2 (still mid-script),
        // producing a `dialogUpserts` entry instead of a reset. Without this fixture the
        // router-level upsert loop is dead code in tests.
        let dialogRepo = RecordingNPCDialogStateRepository()
        let router = try await WorldRouter(
            sectors: [
                "A": makeSector(
                    name: "A",
                    npcs: [makeNPC(at: GridPoint(x: 0, y: 0), dialogScript: "first.\n---\nsecond.\n---\nthird.")]
                )
            ],
            characters: StubCharacterRepository(),
            npcDialogStates: dialogRepo,
            logger: Logger(label: "test.world-router.upsert")
        )
        let sector = try #require(await router.sectorActor(named: "A"))
        let outbox = ConnectionOutbox(highWatermark: 1024)
        let entityIndex = try await sector.attach(
            character: makeCharacter(name: "alice", at: GridPoint(x: 1, y: 1), sector: "A"),
            inventory: [],
            outbox: outbox
        )
        await sector.handleBumpNPC(npcIndex: 1, from: entityIndex)

        await router.runAITickAcrossSectors()

        let upserts = await dialogRepo.upsertedSnapshot()
        #expect(upserts.count == 1)
        let upsert = try #require(upserts.first)
        #expect(upsert.sectorName == "A")
        #expect(upsert.npcIndex == 1)
        // Script step is 1-based on the wire/DB; the second step is `scriptStep = 2`.
        #expect(upsert.scriptStep == 2)
    }

    @Test func `runAITickAcrossSectors tolerates a transient upsert failure`() async throws {
        // Symmetric to the reset-fault test but exercises the upsert side of the
        // fault-tolerance contract — a regression dropping the `do/catch` around
        // `npcDialogStates.upsert(state)` would only be caught here, since digests
        // populated by the reset-fault test never carry a `dialogUpserts` entry.
        let dialogRepo = FaultyNPCDialogStateRepository()
        await dialogRepo.armNextUpsertFault()
        let router = try await WorldRouter(
            sectors: [
                "A": makeSector(
                    name: "A",
                    npcs: [makeNPC(at: GridPoint(x: 0, y: 0), dialogScript: "first.\n---\nsecond.\n---\nthird.")]
                )
            ],
            characters: StubCharacterRepository(),
            npcDialogStates: dialogRepo,
            logger: Logger(label: "test.world-router.upsert-fault")
        )
        let sector = try #require(await router.sectorActor(named: "A"))
        let outbox = ConnectionOutbox(highWatermark: 1024)
        let entityIndex = try await sector.attach(
            character: makeCharacter(name: "alice", at: GridPoint(x: 1, y: 1), sector: "A"),
            inventory: [],
            outbox: outbox
        )
        await sector.handleBumpNPC(npcIndex: 1, from: entityIndex)

        // First call: digest contains a non-final upsert, repo throws on upsert; the loop
        // should warn-and-continue rather than tearing down. The second call (no faults
        // armed) must return normally — that's the regression sentinel for the `do/catch`
        // around the upsert.
        await router.runAITickAcrossSectors()
        await router.runAITickAcrossSectors()

        let upsertCalls = await dialogRepo.upsertCallCount()
        #expect(upsertCalls >= 1)
    }

    @Test func `runAITickAcrossSectors tolerates a transient repository failure`() async throws {
        let dialogRepo = FaultyNPCDialogStateRepository()
        await dialogRepo.armNextResetFault()
        let router = try await WorldRouter(
            sectors: [
                "A": makeSector(
                    name: "A",
                    npcs: [makeNPC(at: GridPoint(x: 0, y: 0), dialogScript: "Once: $name.")]
                )
            ],
            characters: StubCharacterRepository(),
            npcDialogStates: dialogRepo,
            logger: Logger(label: "test.world-router.fault")
        )
        let sector = try #require(await router.sectorActor(named: "A"))
        let outbox = ConnectionOutbox(highWatermark: 1024)
        let entityIndex = try await sector.attach(
            character: makeCharacter(name: "alice", at: GridPoint(x: 1, y: 1), sector: "A"),
            inventory: [],
            outbox: outbox
        )
        await sector.handleBumpNPC(npcIndex: 1, from: entityIndex)

        // First call: digest contains a reset (single-step script wraps), repo throws on
        // reset; the loop should warn-and-continue rather than tearing down.
        await router.runAITickAcrossSectors()

        // Second call (no faults armed): the actor's in-process state has cleared targeting,
        // so the next tick is an idle no-op. The fact that the second call returns
        // normally is itself the regression sentinel: a `try await` regression in the
        // tolerate-loop would have torn down the first call.
        await router.runAITickAcrossSectors()

        let resetCalls = await dialogRepo.resetCallCount()
        #expect(resetCalls >= 1)
    }

    @Test func `broadcastToAllConnections fans out an identical frame to every attached connection`() async throws {
        let logger = Logger(label: "test.world-router.broadcast")
        let router = try await WorldRouter(
            sectors: [:],
            characters: StubCharacterRepository(),
            npcDialogStates: StubNPCDialogStateRepository(),
            logger: logger
        )
        let dependencies = makeDependencies(router: router, logger: logger)
        let connectionA = ConnectionActor(dependencies: dependencies)
        let connectionB = ConnectionActor(dependencies: dependencies)
        let outboxA = await connectionA.connectionOutbox
        let outboxB = await connectionB.connectionOutbox
        let accountA = UUID()
        let accountB = UUID()
        _ = await router.register(actor: connectionA, accountId: accountA, characterName: "TestPlayerA")
        _ = await router.register(actor: connectionB, accountId: accountB, characterName: "TestPlayerB")
        // Both connections need to be in `attached` state to receive the broadcast.
        await connectionA.markAttached(entityIndex: 1, sectorName: "X", accountId: accountA)
        await connectionB.markAttached(entityIndex: 1, sectorName: "X", accountId: accountB)

        await router.broadcastToAllConnections(.dateTick(DateTickMessage(hour: 7, minute: 33)))
        outboxA.finish()
        outboxB.finish()

        let framesA = await collect(outbox: outboxA)
        let framesB = await collect(outbox: outboxB)
        #expect(framesA.count == 1)
        #expect(framesB.count == 1)
        // Encode-once invariant: both outboxes received byte-equal frames, not two separate
        // encode passes.
        #expect(framesA.first == framesB.first)
        await router.unregister(accountId: accountA)
        await router.unregister(accountId: accountB)
    }

    @Test func `broadcastToAllConnections skips connections that are still in awaiting login`() async throws {
        let logger = Logger(label: "test.world-router.gate")
        let router = try await WorldRouter(
            sectors: [:],
            characters: StubCharacterRepository(),
            npcDialogStates: StubNPCDialogStateRepository(),
            logger: logger
        )
        let dependencies = makeDependencies(router: router, logger: logger)
        let connection = ConnectionActor(dependencies: dependencies)
        let outbox = await connection.connectionOutbox
        let accountId = UUID()
        _ = await router.register(actor: connection, accountId: accountId, characterName: "TestPlayer")
        // Deliberately do not mark as attached: the connection is in the same window where
        // a real login has registered but not yet streamed `loginResult.ok`.

        await router.broadcastToAllConnections(.dateTick(DateTickMessage(hour: 1, minute: 0)))
        outbox.finish()

        let frames = await collect(outbox: outbox)
        #expect(frames.isEmpty)
        await router.unregister(accountId: accountId)
    }

    @Test func `loggedInPlayerCount counts only attached connections`() async throws {
        let logger = Logger(label: "test.world-router.player-count")
        let router = try await WorldRouter(
            sectors: [:],
            characters: StubCharacterRepository(),
            npcDialogStates: StubNPCDialogStateRepository(),
            logger: logger
        )
        let dependencies = makeDependencies(router: router, logger: logger)
        let attachedConnection = ConnectionActor(dependencies: dependencies)
        let unattachedConnection = ConnectionActor(dependencies: dependencies)
        let attachedAccount = UUID()
        let unattachedAccount = UUID()
        _ = await router.register(actor: attachedConnection, accountId: attachedAccount, characterName: "Alice")
        _ = await router.register(actor: unattachedConnection, accountId: unattachedAccount, characterName: "Bob")
        await attachedConnection.markAttached(entityIndex: 1, sectorName: "X", accountId: attachedAccount)

        let count = await router.loggedInPlayerCount()
        #expect(count == 1)

        await router.unregister(accountId: attachedAccount)
        await router.unregister(accountId: unattachedAccount)
    }

    @Test func `kickByCharacterName returns false when nobody matches`() async throws {
        let logger = Logger(label: "test.world-router.kick-miss")
        let router = try await WorldRouter(
            sectors: [:],
            characters: StubCharacterRepository(),
            npcDialogStates: StubNPCDialogStateRepository(),
            logger: logger
        )
        let dependencies = makeDependencies(router: router, logger: logger)
        let connection = ConnectionActor(dependencies: dependencies)
        let accountId = UUID()
        _ = await router.register(actor: connection, accountId: accountId, characterName: "Alice")

        let kicked = await router.kickByCharacterName("Bob")
        #expect(kicked == false)

        await router.unregister(accountId: accountId)
    }

    @Test func `kickByCharacterName normalizes case to match the schema collation`() async throws {
        let logger = Logger(label: "test.world-router.kick-normalize")
        let router = try await WorldRouter(
            sectors: [:],
            characters: StubCharacterRepository(),
            npcDialogStates: StubNPCDialogStateRepository(),
            logger: logger
        )
        let dependencies = makeDependencies(router: router, logger: logger)
        let connection = ConnectionActor(dependencies: dependencies)
        let accountId = UUID()
        _ = await router.register(actor: connection, accountId: accountId, characterName: "Saibot")

        // `LOWER(NORMALIZE(name, NFKC))` is the schema collation that `findByName` uses;
        // the operator can type the name in any case and still match.
        let kicked = await router.kickByCharacterName("saibot")
        #expect(kicked)

        await router.unregister(accountId: accountId)
    }

    @Test func `kickByCharacterName matches NFKC compatibility equivalent names`() async throws {
        // The schema's `name_normalized` column uses `LOWER(NORMALIZE(name, NFKC))`, so a
        // character registered under a full-width form must match a kick request using the
        // ASCII-folded form (and vice versa). The ASCII-only test above can't catch a
        // regression that drops `.precomposedStringWithCompatibilityMapping`.
        let logger = Logger(label: "test.world-router.kick-nfkc")
        let router = try await WorldRouter(
            sectors: [:],
            characters: StubCharacterRepository(),
            npcDialogStates: StubNPCDialogStateRepository(),
            logger: logger
        )
        let dependencies = makeDependencies(router: router, logger: logger)
        let connection = ConnectionActor(dependencies: dependencies)
        let accountId = UUID()
        // Full-width "Ｓａｉｂｏｔ" — every codepoint has an NFKC-equivalent ASCII form.
        _ = await router.register(actor: connection, accountId: accountId, characterName: "Ｓａｉｂｏｔ")

        let kicked = await router.kickByCharacterName("saibot")
        #expect(kicked)

        await router.unregister(accountId: accountId)
    }

    // MARK: - Helpers

    private func makeSector(name: String, npcs: [NPC]) -> Sector {
        let body = SectorBody(
            version: 3,
            dimensions: GridSize(width: 8, height: 8),
            ground: GroundTile(tilesetIndex: 0, sourceX: 0, sourceY: 0),
            light: LightSetting(indoor: false, brightness: 100),
            objects: [],
            collisionMasks: [],
            portals: [],
            npcs: npcs,
            monsterSpawns: []
        )
        return Sector(body: body, name: name)
    }

    private func makeNPC(at origin: GridPoint, dialogScript: String) -> NPC {
        NPC(
            spawnOrigin: origin,
            spawnBoxSize: GridSize(width: 128, height: 128),
            maskSize: GridSize(width: 128, height: 128),
            name: "test-npc",
            figure: 0,
            direction: 0,
            behaviorTag: 0,
            dialogScript: dialogScript
        )
    }

    private func makeCharacter(name: String, at position: GridPoint, sector: String) -> Character {
        Character(
            id: UUID(),
            name: name,
            figure: 0,
            gender: .male,
            currentSector: sector,
            position: position,
            facing: .south,
            tempo: .default,
            energy: Energy(
                hpCurrent: 100, hpMax: 100,
                balanceCurrent: 100, balanceMax: 100,
                manaCurrent: 100, manaMax: 100
            ),
            lastSeen: Date()
        )
    }

    private func makeDependencies(router: WorldRouter, logger: Logger) -> ConnectionDependencies {
        let worldClockService = WorldClockService(
            worldRouter: router,
            worldClocks: StubWorldClockRepository(),
            initialClock: .bootDefault,
            logger: logger
        )
        return ConnectionDependencies(
            accounts: StubAccountRepository(),
            characters: StubCharacterRepository(),
            inventories: StubInventoryRepository(),
            registrations: StubRegistrationRepository(),
            passwordHasher: PasswordHasher(logger: logger),
            worldRouter: router,
            worldClock: worldClockService,
            configuration: ServerConfiguration(
                httpHost: "127.0.0.1",
                httpPort: 8080,
                adminToken: "test",
                sectorsDirectory: URL(fileURLWithPath: "/tmp")
            ),
            logger: logger
        )
    }

    private func collect(outbox: ConnectionOutbox) async -> [Data] {
        var frames: [Data] = []
        for await frame in outbox.stream {
            frames.append(frame)
        }
        return frames
    }
}

/// Returns a fixed set of persisted `NPCDialogState` rows from `loadAll(sectorName:)`
/// so tests can exercise the `WorldRouter.init` cursor pre-load path.
private actor SeededNPCDialogStateRepository: NPCDialogStateRepository {
    private let rows: [NPCDialogState]

    init(rows: [NPCDialogState]) {
        self.rows = rows
    }

    func find(sectorName: String, npcIndex: Int16) async throws -> NPCDialogState? {
        rows.first { $0.sectorName == sectorName && $0.npcIndex == npcIndex }
    }

    func loadAll(sectorName: String) async throws -> [NPCDialogState] {
        rows.filter { $0.sectorName == sectorName }
    }

    func upsert(_: NPCDialogState) async throws {}
    func reset(sectorName _: String, npcIndex _: Int16) async throws {}
}

private actor RecordingNPCDialogStateRepository: NPCDialogStateRepository {
    private var upserted: [NPCDialogState] = []
    private var reset: [(sector: String, npcIndex: Int16)] = []

    func find(sectorName _: String, npcIndex _: Int16) async throws -> NPCDialogState? {
        nil
    }

    func loadAll(sectorName _: String) async throws -> [NPCDialogState] {
        []
    }

    func upsert(_ state: NPCDialogState) async throws {
        upserted.append(state)
    }

    func reset(sectorName: String, npcIndex: Int16) async throws {
        reset.append((sectorName, npcIndex))
    }

    func upsertedSnapshot() -> [NPCDialogState] {
        upserted
    }

    func resetSnapshot() -> [(sector: String, npcIndex: Int16)] {
        reset
    }
}

private actor FaultyNPCDialogStateRepository: NPCDialogStateRepository {
    private var nextResetThrows = false
    private var nextUpsertThrows = false
    private var resetCalls = 0
    private var upsertCalls = 0

    enum Fault: Error { case rigged }

    func armNextResetFault() {
        nextResetThrows = true
    }

    func armNextUpsertFault() {
        nextUpsertThrows = true
    }

    func resetCallCount() -> Int {
        resetCalls
    }

    func upsertCallCount() -> Int {
        upsertCalls
    }

    func find(sectorName _: String, npcIndex _: Int16) async throws -> NPCDialogState? {
        nil
    }

    func loadAll(sectorName _: String) async throws -> [NPCDialogState] {
        []
    }

    func upsert(_: NPCDialogState) async throws {
        upsertCalls += 1
        if nextUpsertThrows {
            nextUpsertThrows = false
            throw Fault.rigged
        }
    }

    func reset(sectorName _: String, npcIndex _: Int16) async throws {
        resetCalls += 1
        if nextResetThrows {
            nextResetThrows = false
            throw Fault.rigged
        }
    }
}
