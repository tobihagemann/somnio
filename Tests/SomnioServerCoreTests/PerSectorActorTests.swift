import Foundation
import Logging
import SomnioCore
import SomnioProtocol
import Testing
@testable import SomnioServerCore

/// Unit-level coverage for the `PerSectorActor` invariants that govern client-driven state
/// changes: bounded positions, collision-mask rejection, and sector-local entity indexing.
struct PerSectorActorTests {
    @Test func `handlePosition rejects coordinates outside sector bounds`() async throws {
        let actor = PerSectorActor(staticSector: makeSector(), logger: testLogger)
        let outbox = ConnectionOutbox(highWatermark: 1024)
        let entityIndex = try await actor.attach(
            character: makeCharacter(at: GridPoint(x: 1, y: 1)),
            inventory: [],
            outbox: outbox
        )

        await actor.handlePosition(
            PositionMessage(entityIndex: 0, x: -1, y: 0, facing: Direction.south.rawValue, tempo: Tempo.default.rawValue),
            from: entityIndex
        )

        let snapshot = await actor.snapshotForPlayer(entityIndex: entityIndex)
        #expect(snapshot?.character.position == GridPoint(x: 1, y: 1))

        // Bounds are pixel-space: an 8x8-tile sector spans 8 * tileSize = 1024px, so a
        // coordinate at the pixel extent is out of bounds and must be rejected.
        await actor.handlePosition(
            PositionMessage(entityIndex: 0, x: 1024, y: 0, facing: Direction.south.rawValue, tempo: Tempo.default.rawValue),
            from: entityIndex
        )
        let secondSnapshot = await actor.snapshotForPlayer(entityIndex: entityIndex)
        #expect(secondSnapshot?.character.position == GridPoint(x: 1, y: 1))
    }

    @Test func `handlePosition rejects a move whose feet box overlaps a collision mask`() async throws {
        // Player sprite 32x48: at (5, 5) the feet box is (5, 37, 32, 16). A mask there blocks the
        // move (the move is dropped, leaving the position unchanged).
        let actor = PerSectorActor(
            staticSector: maskedSector(masks: [CollisionMask(x: 5, y: 37, width: 32, height: 16)]),
            logger: testLogger
        )
        let outbox = ConnectionOutbox(highWatermark: 1024)
        let entityIndex = try await actor.attach(
            character: makeCharacter(at: GridPoint(x: 1, y: 1)),
            inventory: [],
            outbox: outbox
        )

        await actor.handlePosition(
            PositionMessage(entityIndex: 0, x: 5, y: 5, facing: Direction.south.rawValue, tempo: Tempo.default.rawValue),
            from: entityIndex
        )

        let snapshot = await actor.snapshotForPlayer(entityIndex: entityIndex)
        #expect(snapshot?.character.position == GridPoint(x: 1, y: 1))
    }

    @Test func `handlePosition accepts a move whose head, but not feet, would overlap a mask`() async throws {
        // A mask over (5, 5)'s head row (y 5-21) must not block — only the feet box (y 37-53)
        // gates collision, so the move is accepted. This is the head-vs-feet fidelity fix.
        let actor = PerSectorActor(
            staticSector: maskedSector(masks: [CollisionMask(x: 5, y: 5, width: 32, height: 16)]),
            logger: testLogger
        )
        let outbox = ConnectionOutbox(highWatermark: 1024)
        let entityIndex = try await actor.attach(
            character: makeCharacter(at: GridPoint(x: 1, y: 1)),
            inventory: [],
            outbox: outbox
        )

        await actor.handlePosition(
            PositionMessage(entityIndex: 0, x: 5, y: 5, facing: Direction.south.rawValue, tempo: Tempo.default.rawValue),
            from: entityIndex
        )

        let snapshot = await actor.snapshotForPlayer(entityIndex: entityIndex)
        #expect(snapshot?.character.position == GridPoint(x: 5, y: 5))
    }

    @Test func `handlePosition rejects a move whose feet box overlaps another player`() async throws {
        // A peer's feet box at (5, 5) blocks a mover trying to step onto it.
        let actor = PerSectorActor(staticSector: maskedSector(masks: []), logger: testLogger)
        let peerOutbox = ConnectionOutbox(highWatermark: 1024)
        _ = try await actor.attach(
            character: makeCharacter(at: GridPoint(x: 5, y: 5)),
            inventory: [],
            outbox: peerOutbox
        )
        let moverOutbox = ConnectionOutbox(highWatermark: 1024)
        let moverIndex = try await actor.attach(
            character: makeCharacter(at: GridPoint(x: 1, y: 1)),
            inventory: [],
            outbox: moverOutbox
        )

        await actor.handlePosition(
            PositionMessage(entityIndex: 0, x: 5, y: 5, facing: Direction.south.rawValue, tempo: Tempo.default.rawValue),
            from: moverIndex
        )

        let snapshot = await actor.snapshotForPlayer(entityIndex: moverIndex)
        #expect(snapshot?.character.position == GridPoint(x: 1, y: 1))
    }

    @Test func `handlePosition snaps the originating client back on a rejected move`() async throws {
        // A peer occupies (5, 5); the mover's step onto it is rejected. The server must emit a
        // serverPosition snap-back to the mover's own outbox carrying the authoritative (unchanged)
        // position, so a client that predicted against stale blocker data re-syncs rather than
        // diverging. (The accepted-move case below confirms no spurious snap-back is sent.)
        let actor = PerSectorActor(staticSector: maskedSector(masks: []), logger: testLogger)
        let peerOutbox = ConnectionOutbox(highWatermark: 1024)
        _ = try await actor.attach(
            character: makeCharacter(at: GridPoint(x: 5, y: 5)),
            inventory: [],
            outbox: peerOutbox
        )
        let moverOutbox = ConnectionOutbox(highWatermark: 1024)
        let moverIndex = try await actor.attach(
            character: makeCharacter(at: GridPoint(x: 1, y: 1)),
            inventory: [],
            outbox: moverOutbox
        )

        await actor.handlePosition(
            PositionMessage(entityIndex: 0, x: 5, y: 5, facing: Direction.south.rawValue, tempo: Tempo.default.rawValue),
            from: moverIndex
        )

        moverOutbox.finish()
        let messages = try await collect(outbox: moverOutbox).map { try SomnioMessageDecoder.decode($0) }
        let snapBack = try #require(messages.compactMap { message -> PositionMessage? in
            if case let .serverPosition(payload) = message, payload.entityIndex == moverIndex { return payload }
            return nil
        }.first)
        #expect(snapBack.x == 1)
        #expect(snapBack.y == 1)
    }

    @Test func `handlePosition accepts bounded, non-colliding coordinates`() async throws {
        let actor = PerSectorActor(staticSector: makeSector(), logger: testLogger)
        let outbox = ConnectionOutbox(highWatermark: 1024)
        let entityIndex = try await actor.attach(
            character: makeCharacter(at: GridPoint(x: 1, y: 1)),
            inventory: [],
            outbox: outbox
        )

        await actor.handlePosition(
            PositionMessage(entityIndex: 0, x: 5, y: 5, facing: Direction.east.rawValue, tempo: Tempo.default.rawValue),
            from: entityIndex
        )

        let snapshot = await actor.snapshotForPlayer(entityIndex: entityIndex)
        #expect(snapshot?.character.position == GridPoint(x: 5, y: 5))
        #expect(snapshot?.character.facing == .east)

        // An accepted move must not snap the mover back to its own outbox.
        outbox.finish()
        let messages = try await collect(outbox: outbox).map { try SomnioMessageDecoder.decode($0) }
        let snappedBack = messages.contains { message in
            if case let .serverPosition(payload) = message, payload.entityIndex == entityIndex { return true }
            return false
        }
        #expect(!snappedBack)
    }

    @Test func `attach streams the self-Entity between MainCharacter and Inventory on a no-peer sector`() async throws {
        let sector = makeSector()
        let actor = PerSectorActor(staticSector: sector, logger: testLogger)
        let outbox = ConnectionOutbox(highWatermark: 1024)
        let character = makeCharacter(at: GridPoint(x: 2, y: 2))
        let entityIndex = try await actor.attach(
            character: character,
            inventory: [],
            outbox: outbox
        )

        outbox.finish()
        let frames = await collect(outbox: outbox)
        let messages = try frames.map { try SomnioMessageDecoder.decode($0) }

        #expect(messages.count == 5)
        guard case .enterSector = messages[0] else {
            Issue.record("expected enterSector at index 0, got \(messages[0])")
            return
        }
        guard case let .mainCharacter(mainPayload) = messages[1] else {
            Issue.record("expected mainCharacter at index 1, got \(messages[1])")
            return
        }
        #expect(mainPayload.entityIndex == entityIndex)
        guard case let .entity(selfEntity) = messages[2] else {
            Issue.record("expected self-Entity at index 2, got \(messages[2])")
            return
        }
        #expect(selfEntity.entityIndex == entityIndex)
        #expect(selfEntity.type == .player)
        #expect(selfEntity.name == character.name)
        #expect(selfEntity.x == character.position.x)
        #expect(selfEntity.y == character.position.y)
        guard case .inventory = messages[3] else {
            Issue.record("expected inventory at index 3, got \(messages[3])")
            return
        }
        guard case .energy = messages[4] else {
            Issue.record("expected energy at index 4, got \(messages[4])")
            return
        }
    }

    @Test func `attach with an existing peer emits exactly one self-Entity to the newcomer and one newcomer-Entity to the peer`() async throws {
        let sector = makeSector()
        let actor = PerSectorActor(staticSector: sector, logger: testLogger)
        let firstOutbox = ConnectionOutbox(highWatermark: 1024)
        let firstIndex = try await actor.attach(
            character: makeCharacter(at: GridPoint(x: 1, y: 1)),
            inventory: [],
            outbox: firstOutbox
        )

        let secondOutbox = ConnectionOutbox(highWatermark: 1024)
        let secondIndex = try await actor.attach(
            character: makeCharacter(at: GridPoint(x: 5, y: 5)),
            inventory: [],
            outbox: secondOutbox
        )

        firstOutbox.finish()
        secondOutbox.finish()
        let firstFrames = try await collect(outbox: firstOutbox).map { try SomnioMessageDecoder.decode($0) }
        let secondFrames = try await collect(outbox: secondOutbox).map { try SomnioMessageDecoder.decode($0) }

        let firstEntities = firstFrames.compactMap { message -> EntityMessage? in
            if case let .entity(payload) = message { return payload }
            return nil
        }
        #expect(firstEntities.count == 2)
        #expect(firstEntities[0].entityIndex == firstIndex, "first frame is the first peer's own self-Entity")
        #expect(firstEntities[1].entityIndex == secondIndex, "second frame is the newcomer broadcast")

        let secondEntities = secondFrames.compactMap { message -> EntityMessage? in
            if case let .entity(payload) = message { return payload }
            return nil
        }
        #expect(secondEntities.count == 2)
        #expect(secondEntities[0].entityIndex == secondIndex, "newcomer self-Entity is first")
        #expect(secondEntities[1].entityIndex == firstIndex, "existing peer's Entity follows")
        #expect(secondEntities.allSatisfy { $0.entityIndex != 0 })
    }

    @Test func `entity indices are sector-local so a portal hop must propagate the new index`() async throws {
        let sectorA = PerSectorActor(staticSector: makeSector(), logger: testLogger)
        let sectorB = PerSectorActor(staticSector: makeSector(), logger: testLogger)
        let outboxA = ConnectionOutbox(highWatermark: 1024)
        let outboxB = ConnectionOutbox(highWatermark: 1024)

        // Pre-populate sector B with an extra attach so its allocator advances past sector A's.
        _ = try await sectorB.attach(
            character: makeCharacter(at: GridPoint(x: 0, y: 0)),
            inventory: [],
            outbox: outboxB
        )

        let indexA = try await sectorA.attach(
            character: makeCharacter(at: GridPoint(x: 0, y: 0)),
            inventory: [],
            outbox: outboxA
        )
        let indexB = try await sectorB.attach(
            character: makeCharacter(at: GridPoint(x: 0, y: 0)),
            inventory: [],
            outbox: outboxB
        )
        #expect(
            indexA != indexB,
            "sector-local entity indices must diverge so portal hops cannot reuse the source sector's index"
        )
    }

    // MARK: - Helpers

    private func makeSector() -> Sector {
        maskedSector(masks: [CollisionMask(x: 3, y: 3, width: 1, height: 1)])
    }

    private func maskedSector(masks: [CollisionMask]) -> Sector {
        let body = SectorBody(
            version: 3,
            dimensions: GridSize(width: 8, height: 8),
            ground: GroundTile(tilesetIndex: 0, sourceX: 0, sourceY: 0),
            light: LightSetting(indoor: false, brightness: 100),
            objects: [],
            collisionMasks: masks,
            portals: [],
            npcs: [],
            monsterSpawns: []
        )
        return Sector(body: body, name: "TestSector")
    }

    private func makeCharacter(at position: GridPoint) -> Character {
        Character(
            id: UUID(),
            name: "tester",
            figure: 0,
            gender: .male,
            currentSector: "TestSector",
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

    private var testLogger: Logger {
        Logger(label: "test.per-sector-actor")
    }

    private func collect(outbox: ConnectionOutbox) async -> [Data] {
        var frames: [Data] = []
        for await frame in outbox.stream {
            frames.append(frame)
        }
        return frames
    }
}
