import Foundation
import Logging
import SomnioCore
import SomnioData
import SomnioServerCore
import Testing

@Suite(.requiresContainerRuntime)
struct CheckpointServiceTests {
    @Test func `checkpointAll persists every logged-in player's full character and inventory`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.checkpoint")
            let registrations = PostgresRegistrationRepository(client: client, logger: logger)
            let characters = PostgresCharacterRepository(client: client, logger: logger)
            let inventory = PostgresInventoryRepository(client: client, logger: logger)

            let (_, originalCharacter) = try await registrations.register(
                name: "checkpoint-tester",
                passwordHash: "stub",
                email: "tester@example.com",
                gender: .female,
                figure: 1,
                starterInventory: StarterInventory.rows
            )

            let dependencies = try await IntegrationTestFixtures.makeConnectionDependencies(
                client: client,
                sectors: IntegrationTestFixtures.defaultSectors(),
                logger: logger
            )
            let worldRouter = dependencies.worldRouter

            // Stage a player slot directly via the per-sector actor; `attach` requires a
            // ConnectionActor wrapper, but `snapshotForCheckpoint` just walks `players`, so
            // the test exercises `WorldRouter.checkpointAll` against an in-memory fixture
            // built up through the documented attach surface.
            let connectionActor = ConnectionActor(dependencies: dependencies)
            let outbox = await connectionActor.connectionOutbox

            let sectorActor = try #require(await worldRouter.sectorActor(named: "EdariaBibliothek"))
            var movedCharacter = originalCharacter
            movedCharacter.position = GridPoint(x: 7, y: 11)
            movedCharacter.facing = Heading(cardinal: .north)
            movedCharacter.energy.hpCurrent = 42
            _ = try await sectorActor.attach(
                character: movedCharacter,
                inventory: StarterInventory.rows,
                outbox: outbox
            )

            await worldRouter.checkpointAll()

            let reloaded = try #require(try await characters.findByName("checkpoint-tester"))
            #expect(reloaded.position == GridPoint(x: 7, y: 11))
            #expect(reloaded.facing == Heading(cardinal: .north))
            #expect(reloaded.energy.hpCurrent == 42)
            let reloadedInventory = try await inventory.loadAll(forCharacter: reloaded.id)
            #expect(reloadedInventory.count == StarterInventory.rows.count)
        }
    }
}
