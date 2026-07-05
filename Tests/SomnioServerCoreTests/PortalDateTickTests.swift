import Foundation
import Logging
import SomnioCore
import SomnioData
import SomnioProtocol
import SomnioTestSupport
import Testing
@testable import SomnioServerCore

/// Coverage for the per-portal `DateTick` emit in `GameplayHandlers.handleEnterPortal`. Uses
/// a real `WorldRouter` with two sectors and a stub `WorldClockService` whose pre-loaded
/// clock is intentionally non-`bootDefault` so a forgotten emit shows up as a missing tag
/// rather than as coincidentally matching the default.
struct PortalDateTickTests {
    @Test func `successful portal hop emits a date tick to the moving connection`() async throws {
        let stubClock = WorldClock(second: 0, minute: 33, hour: 7, day: 1, month: 1, year: 500)
        let dependencies = try await makeDependencies(initialClock: stubClock)
        let connection = ConnectionActor(dependencies: dependencies)
        let outbox = await connection.connectionOutbox

        let actorA = try #require(await dependencies.worldRouter.sectorActor(named: "A"))
        let entityIndex = try await actorA.attach(
            character: makeCharacter(at: GridPoint(x: 1, y: 1)),
            inventory: [],
            outbox: outbox
        )
        await connection.markAttached(entityIndex: entityIndex, sectorName: "A", accountId: UUID())

        let outcome = await GameplayHandlers.handleEnterPortal(
            EnterPortalMessage(portalIndex: 0),
            entityIndex: entityIndex,
            sectorName: "A",
            connectionActor: connection,
            dependencies: dependencies
        )

        outbox.finish()
        let frames = await collect(outbox: outbox)
        let messages = frames.compactMap { try? SomnioMessageDecoder.decode($0) }
        let tags = messages.map(\.tag)
        let dateTicks = messages.compactMap { message -> DateTickMessage? in
            if case let .dateTick(tick) = message { return tick }
            return nil
        }
        let firstTick = try #require(dateTicks.first)
        #expect(firstTick.hour == 7)
        #expect(firstTick.minute == 33)
        #expect(outcome?.sectorName == "B")
        // Ordering: the destination sector's `enterSector` must precede the `dateTick`
        // so the client has a sector context to apply the day/night tint to.
        if let dateTickIndex = tags.firstIndex(of: .dateTick),
           let enterSectorIndex = tags.lastIndex(of: .enterSector) {
            #expect(dateTickIndex > enterSectorIndex)
        }
    }

    @Test func `portal hop places the player at the destination arrival spawn`() async throws {
        // Destination "B" has a self-targeting arrival portal, so a hop should relocate the
        // player to its arrival spawn rather than carrying the old sector's coordinates.
        let arrivalPortal = SectorPortal(
            x: 0, y: 0, width: 256, height: 256, targetSectorName: "B", direction: .arrivalPlacement
        )
        let dependencies = try await makeDependencies(initialClock: .bootDefault, destinationPortals: [arrivalPortal])
        let connection = ConnectionActor(dependencies: dependencies)
        let outbox = await connection.connectionOutbox

        let actorA = try #require(await dependencies.worldRouter.sectorActor(named: "A"))
        let entityIndex = try await actorA.attach(
            character: makeCharacter(at: GridPoint(x: 1, y: 1)),
            inventory: [],
            outbox: outbox
        )
        await connection.markAttached(entityIndex: entityIndex, sectorName: "A", accountId: UUID())

        let outcome = try #require(await GameplayHandlers.handleEnterPortal(
            EnterPortalMessage(portalIndex: 0),
            entityIndex: entityIndex,
            sectorName: "A",
            connectionActor: connection,
            dependencies: dependencies
        ))
        #expect(outcome.sectorName == "B")

        let actorB = try #require(await dependencies.worldRouter.sectorActor(named: "B"))
        let expectedSpawn = await actorB.staticSector.arrivalSpawn
        let placed = await actorB.snapshotForPlayer(entityIndex: outcome.entityIndex)
        #expect(placed?.character.position == expectedSpawn)
    }

    @Test func `portal hop places the player inside the inbound arrival portal keyed to the source`() async throws {
        // Destination "B" has an inbound `.arrivalPlacement` portal back to the source "A", so the
        // hop must land the player inside that portal rect (the primary placement branch), not at
        // an arrival spawn. B has no self-targeting portal, so the fallback would recenter to the
        // pixel center (512, 512) — outside this rect — and asserting "inside the rect" proves the
        // primary branch ran.
        let inbound = SectorPortal(
            x: 128, y: 128, width: 256, height: 256, targetSectorName: "A", direction: .arrivalPlacement
        )
        let dependencies = try await makeDependencies(initialClock: .bootDefault, destinationPortals: [inbound])
        let connection = ConnectionActor(dependencies: dependencies)
        let outbox = await connection.connectionOutbox

        let actorA = try #require(await dependencies.worldRouter.sectorActor(named: "A"))
        let entityIndex = try await actorA.attach(
            character: makeCharacter(at: GridPoint(x: 1, y: 1)),
            inventory: [],
            outbox: outbox
        )
        await connection.markAttached(entityIndex: entityIndex, sectorName: "A", accountId: UUID())

        let outcome = try #require(await GameplayHandlers.handleEnterPortal(
            EnterPortalMessage(portalIndex: 0),
            entityIndex: entityIndex,
            sectorName: "A",
            connectionActor: connection,
            dependencies: dependencies
        ))
        #expect(outcome.sectorName == "B")

        let actorB = try #require(await dependencies.worldRouter.sectorActor(named: "B"))
        let placed = try #require(await actorB.snapshotForPlayer(entityIndex: outcome.entityIndex))
        #expect(placed.character.position.x >= inbound.x)
        #expect(placed.character.position.x < inbound.x + inbound.width)
        #expect(placed.character.position.y >= inbound.y)
        #expect(placed.character.position.y < inbound.y + inbound.height)
    }

    @Test func `portal hop recenters an out-of-bounds carry into a sector without an arrival portal`() async throws {
        // Destination "B" has no arrival portal (default), and the carried coordinate is well
        // outside B's pixel bounds, so the hop must recenter to B's pixel center rather than
        // attach the player off-map.
        let dependencies = try await makeDependencies(initialClock: .bootDefault)
        let connection = ConnectionActor(dependencies: dependencies)
        let outbox = await connection.connectionOutbox

        let actorA = try #require(await dependencies.worldRouter.sectorActor(named: "A"))
        let entityIndex = try await actorA.attach(
            character: makeCharacter(at: GridPoint(x: 5000, y: 5000)), // out of B's 1024px extent
            inventory: [],
            outbox: outbox
        )
        await connection.markAttached(entityIndex: entityIndex, sectorName: "A", accountId: UUID())

        let outcome = try #require(await GameplayHandlers.handleEnterPortal(
            EnterPortalMessage(portalIndex: 0),
            entityIndex: entityIndex,
            sectorName: "A",
            connectionActor: connection,
            dependencies: dependencies
        ))
        #expect(outcome.sectorName == "B")

        let actorB = try #require(await dependencies.worldRouter.sectorActor(named: "B"))
        let expectedCenter = await actorB.staticSector.pixelCenter
        let placed = await actorB.snapshotForPlayer(entityIndex: outcome.entityIndex)
        #expect(placed?.character.position == expectedCenter)
    }

    @Test func `enter portal rejects a non-outbound-trigger direction and snaps back`() async throws {
        // Source sector index 1 is an arrival-placement portal (a destination marker, not an exit).
        // A crafted enterPortal naming it must be refused: no PortalOutcome, a serverPosition
        // snapback, and the player left in the source sector.
        let dependencies = try await makeDependencies(
            initialClock: .bootDefault,
            sourcePortals: [
                SectorPortal(x: 0, y: 0, width: 8, height: 8, targetSectorName: "B", direction: .outboundTrigger),
                SectorPortal(x: 16, y: 16, width: 8, height: 8, targetSectorName: "B", direction: .arrivalPlacement)
            ]
        )
        let connection = ConnectionActor(dependencies: dependencies)
        let outbox = await connection.connectionOutbox

        let actorA = try #require(await dependencies.worldRouter.sectorActor(named: "A"))
        let entityIndex = try await actorA.attach(
            character: makeCharacter(at: GridPoint(x: 1, y: 1)),
            inventory: [],
            outbox: outbox
        )
        await connection.markAttached(entityIndex: entityIndex, sectorName: "A", accountId: UUID())

        let outcome = await GameplayHandlers.handleEnterPortal(
            EnterPortalMessage(portalIndex: 1),
            entityIndex: entityIndex,
            sectorName: "A",
            connectionActor: connection,
            dependencies: dependencies
        )
        #expect(outcome == nil)

        outbox.finish()
        let frames = await collect(outbox: outbox)
        let tags = frames.compactMap { try? SomnioMessageDecoder.decode($0) }.map(\.tag)
        #expect(tags.contains(.serverPosition)) // snapBack correction frame
        let stillInA = try #require(await actorA.snapshotForPlayer(entityIndex: entityIndex))
        #expect(stillInA.character.currentSector == "A")
    }

    // MARK: - Helpers

    private func makeDependencies(
        initialClock: WorldClock,
        sourcePortals: [SectorPortal] = [SectorPortal(x: 0, y: 0, width: 8, height: 8, targetSectorName: "B", direction: .outboundTrigger)],
        destinationPortals: [SectorPortal] = []
    ) async throws -> ConnectionDependencies {
        let logger = Logger(label: "test.portal-date-tick")
        let sectorA = makeSector(name: "A", portals: sourcePortals)
        let sectorB = makeSector(name: "B", portals: destinationPortals)
        let worldRouter = try await WorldRouter(
            sectors: ["A": sectorA, "B": sectorB],
            characters: StubCharacterRepository(),
            npcDialogStates: StubNPCDialogStateRepository(),
            logger: logger
        )
        let worldClockService = WorldClockService(
            worldRouter: worldRouter,
            worldClocks: StubWorldClockRepository(),
            initialClock: initialClock,
            logger: logger
        )
        return ConnectionDependencies(
            accounts: StubAccountRepository(),
            characters: StubCharacterRepository(),
            inventories: StubInventoryRepository(),
            registrations: StubRegistrationRepository(),
            passwordHasher: PasswordHasher(logger: logger),
            worldRouter: worldRouter,
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

    private func makeSector(name: String, portals: [SectorPortal]) -> Sector {
        let body = SectorBody(
            version: 3,
            dimensions: GridSize(width: 8, height: 8),
            ground: GroundTile(tilesetIndex: 0, sourceX: 0, sourceY: 0),
            light: LightSetting(indoor: false, brightness: 100),
            objects: [],
            collisionMasks: [],
            portals: portals,
            npcs: [],
            monsterSpawns: []
        )
        return Sector(body: body, name: name)
    }

    private func makeCharacter(at position: GridPoint) -> Character {
        Character(
            id: UUID(),
            name: "tester",
            figure: 0,
            gender: .male,
            currentSector: "A",
            position: position,
            facing: Heading(cardinal: .south),
            tempo: .default,
            energy: Energy(
                hpCurrent: 100, hpMax: 100,
                balanceCurrent: 100, balanceMax: 100,
                manaCurrent: 100, manaMax: 100
            ),
            lastSeen: Date()
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
