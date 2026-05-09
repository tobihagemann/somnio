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

        await actor.handlePosition(
            PositionMessage(entityIndex: 0, x: 8, y: 0, facing: Direction.south.rawValue, tempo: Tempo.default.rawValue),
            from: entityIndex
        )
        let secondSnapshot = await actor.snapshotForPlayer(entityIndex: entityIndex)
        #expect(secondSnapshot?.character.position == GridPoint(x: 1, y: 1))
    }

    @Test func `handlePosition rejects positions inside a collision mask`() async throws {
        let actor = PerSectorActor(staticSector: makeSector(), logger: testLogger)
        let outbox = ConnectionOutbox(highWatermark: 1024)
        let entityIndex = try await actor.attach(
            character: makeCharacter(at: GridPoint(x: 1, y: 1)),
            inventory: [],
            outbox: outbox
        )

        // The fixture sector has a 1x1 collision mask at (3, 3).
        await actor.handlePosition(
            PositionMessage(entityIndex: 0, x: 3, y: 3, facing: Direction.south.rawValue, tempo: Tempo.default.rawValue),
            from: entityIndex
        )

        let snapshot = await actor.snapshotForPlayer(entityIndex: entityIndex)
        #expect(snapshot?.character.position == GridPoint(x: 1, y: 1))
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
        let body = SectorBody(
            version: 3,
            dimensions: GridSize(width: 8, height: 8),
            ground: GroundTile(tilesetIndex: 0, sourceX: 0, sourceY: 0),
            light: LightSetting(indoor: false, brightness: 100),
            objects: [],
            collisionMasks: [CollisionMask(x: 3, y: 3, width: 1, height: 1)],
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
}
