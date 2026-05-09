import Foundation
import Logging
import SomnioCore
import SomnioData
import SomnioProtocol
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

    // MARK: - Helpers

    private func makeDependencies(initialClock: WorldClock) async throws -> ConnectionDependencies {
        let logger = Logger(label: "test.portal-date-tick")
        let sectorA = makeSector(
            name: "A",
            portals: [SectorPortal(x: 0, y: 0, width: 8, height: 8, targetSectorName: "B", direction: .outboundTrigger)]
        )
        let sectorB = makeSector(name: "B", portals: [])
        let worldRouter = try await WorldRouter(
            sectors: ["A": sectorA, "B": sectorB],
            characters: PortalStubCharacterRepository(),
            npcDialogStates: PortalStubNPCDialogStateRepository(),
            logger: logger
        )
        let worldClockService = WorldClockService(
            worldRouter: worldRouter,
            worldClocks: PortalStubWorldClockRepository(),
            initialClock: initialClock,
            logger: logger
        )
        return ConnectionDependencies(
            accounts: PortalStubAccountRepository(),
            characters: PortalStubCharacterRepository(),
            inventories: PortalStubInventoryRepository(),
            registrations: PortalStubRegistrationRepository(),
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

    private func collect(outbox: ConnectionOutbox) async -> [Data] {
        var frames: [Data] = []
        for await frame in outbox.stream {
            frames.append(frame)
        }
        return frames
    }
}

private struct PortalStubAccountRepository: AccountRepository {
    func create(name _: String, passwordHash _: String, email _: String) async throws -> Account {
        fatalError("not used in portal tests")
    }

    func findByName(_: String) async throws -> Account? {
        nil
    }

    func findById(_: UUID) async throws -> Account? {
        nil
    }
}

private struct PortalStubCharacterRepository: CharacterRepository {
    func create(accountId _: UUID, name _: String, figure _: Int16, gender _: Gender) async throws -> Character {
        fatalError("not used in portal tests")
    }

    func findByAccount(_: UUID) async throws -> [Character] {
        []
    }

    func findByName(_: String) async throws -> Character? {
        nil
    }

    func snapshot(_: Character) async throws -> Bool {
        false
    }

    func persistCheckpoint(character _: Character, inventory _: [InventoryRow]) async throws -> Bool {
        false
    }
}

private struct PortalStubInventoryRepository: InventoryRepository {
    func loadAll(forCharacter _: UUID) async throws -> [InventoryRow] {
        []
    }

    func replaceAll(forCharacter _: UUID, rows _: [InventoryRow]) async throws {}
}

private struct PortalStubRegistrationRepository: RegistrationRepository {
    // swiftlint:disable:next function_parameter_count
    func register(
        name _: String,
        passwordHash _: String,
        email _: String,
        gender _: Gender,
        figure _: Int16,
        starterInventory _: [InventoryRow]
    ) async throws -> (Account, Character) {
        fatalError("not used in portal tests")
    }
}

private struct PortalStubNPCDialogStateRepository: NPCDialogStateRepository {
    func find(sectorName _: String, npcIndex _: Int16) async throws -> NPCDialogState? {
        nil
    }

    func loadAll(sectorName _: String) async throws -> [NPCDialogState] {
        []
    }

    func upsert(_: NPCDialogState) async throws {}
    func reset(sectorName _: String, npcIndex _: Int16) async throws {}
}

private struct PortalStubWorldClockRepository: WorldClockRepository {
    func load() async throws -> WorldClock {
        .bootDefault
    }

    func save(_: WorldClock) async throws {}
}
