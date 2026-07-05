import Foundation
import Logging
import SomnioCore
import SomnioData
import SomnioProtocol
import SomnioTestSupport
import Testing
@testable import SomnioServerCore

/// Covers the server-side `maxSayUTF8Bytes` cap on the player chat path. The admin-say twin is
/// covered in `AdminCommandDispatcherTests`; this pins the more-exposed gameplay path, where any
/// logged-in player can otherwise fan a large chat line out to every peer in the sector.
struct GameplayHandlersSayCapTests {
    @Test func `handleSay drops an over-cap chat line but broadcasts a within-cap one`() async throws {
        let dependencies = try await makeDependencies()
        let sector = try #require(await dependencies.worldRouter.sectorActor(named: "A"))

        let speakerOutbox = ConnectionOutbox(highWatermark: 1024)
        let speakerIndex = try await sector.attach(
            character: makeCharacter(at: GridPoint(x: 1, y: 1)),
            inventory: [],
            outbox: speakerOutbox
        )
        let peerOutbox = ConnectionOutbox(highWatermark: 1024)
        _ = try await sector.attach(
            character: makeCharacter(at: GridPoint(x: 2, y: 2)),
            inventory: [],
            outbox: peerOutbox
        )

        let oversized = String(repeating: "x", count: SomnioProtocolConstants.maxSayUTF8Bytes + 1)
        await GameplayHandlers.handleSay(
            SayMessage(entityIndex: 0, text: oversized),
            entityIndex: speakerIndex,
            sectorName: "A",
            dependencies: dependencies
        )
        await GameplayHandlers.handleSay(
            SayMessage(entityIndex: 0, text: "hi"),
            entityIndex: speakerIndex,
            sectorName: "A",
            dependencies: dependencies
        )

        peerOutbox.finish()
        let peerSays = try await collect(outbox: peerOutbox)
            .map { try SomnioMessageDecoder.decode($0) }
            .compactMap { message -> SayMessage? in
                if case let .serverSay(payload) = message { return payload }
                return nil
            }
        #expect(peerSays.count == 1)
        #expect(peerSays.first?.text == "hi")
    }

    // MARK: - Helpers

    private func makeDependencies() async throws -> ConnectionDependencies {
        let logger = Logger(label: "test.gameplay-say-cap")
        let worldRouter = try await WorldRouter(
            sectors: ["A": makeSector(name: "A")],
            characters: StubCharacterRepository(),
            npcDialogStates: StubNPCDialogStateRepository(),
            logger: logger
        )
        let worldClockService = WorldClockService(
            worldRouter: worldRouter,
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

    private func makeSector(name: String) -> Sector {
        let body = SectorBody(
            version: 3,
            dimensions: GridSize(width: 8, height: 8),
            ground: GroundTile(tilesetIndex: 0, sourceX: 0, sourceY: 0),
            light: LightSetting(indoor: false, brightness: 100),
            objects: [],
            collisionMasks: [],
            portals: [],
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
