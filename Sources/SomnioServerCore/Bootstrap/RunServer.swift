import Foundation
import Logging
import PostgresNIO
import ServiceLifecycle
import SomnioData

/// Entry point the `SomnioServer` executable shim calls. Owns the entire bootstrap:
/// logging → config resolution → `PostgresClient` construction → `ServiceGroup` setup
/// (with `PostgresClient` as the initial service) → post-readiness sequence
/// (`waitForClientQueryable` → `MigrationRunner.applyPending` → `SectorCache.load` →
/// `WorldRouter` construction) → append `Application`, `WorldRouter`, `CheckpointService`
/// → terminal `try await groupTask.value`.
///
/// `(environment, isDebug)` are injected so tests can drive the entry with a synthesized
/// environment without monkey-patching globals.
public func runServer(
    environment: [String: String] = ProcessInfo.processInfo.environment,
    isDebug: Bool = isDebugBuild
) async throws {
    ServerLoggingConfiguration.bootstrap()
    let lifecycleLogger = Logger(label: "de.tobiha.somnio.server.lifecycle")
    let postgresLogger = Logger(label: "de.tobiha.somnio.server.gameplay.persistence.postgres")
    // Migrations are an admin/operator concern (one-shot at boot), not gameplay traffic, so
    // the label routes through the admin file backend instead of `gameplay-log.log`.
    let migrationsLogger = Logger(label: "de.tobiha.somnio.server.admin.migrations")
    let sectorsLogger = Logger(label: "de.tobiha.somnio.server.gameplay.sectors.loader")

    let postgresConfiguration: PostgresClient.Configuration
    let serverConfiguration: ServerConfiguration
    do {
        postgresConfiguration = try resolvePostgresConfiguration(environment: environment, isDebug: isDebug)
        serverConfiguration = try ServerConfiguration.resolve(environment: environment, isDebug: isDebug)
    } catch {
        lifecycleLogger.error("failed to resolve configuration", metadata: ["error": "\(error)"])
        throw error
    }

    let client = PostgresClient(configuration: postgresConfiguration, backgroundLogger: postgresLogger)

    var groupConfiguration = ServiceGroupConfiguration(
        services: [
            ServiceGroupConfiguration.ServiceConfiguration(
                service: client,
                successTerminationBehavior: .gracefullyShutdownGroup,
                failureTerminationBehavior: .gracefullyShutdownGroup
            )
        ],
        gracefulShutdownSignals: [.sigint, .sigterm],
        logger: lifecycleLogger
    )
    // Cap total shutdown time so a hung Postgres snapshot during drain can't stall shutdown
    // indefinitely. The reverse-shutdown order still applies inside this cap.
    groupConfiguration.maximumGracefulShutdownDuration = .seconds(15)
    let group = ServiceGroup(configuration: groupConfiguration)

    let groupTask = Task { try await group.run() }

    let worldRouter: WorldRouter
    let dependencies: ConnectionDependencies
    do {
        try await waitForClientQueryable(client, logger: postgresLogger)
        try await MigrationRunner(client: client, logger: migrationsLogger).applyPending()
        let sectorCache = SectorCache()
        try await sectorCache.load(from: serverConfiguration.sectorsDirectory)
        let sectorNames = await sectorCache.names()
        sectorsLogger.info(
            "sector cache populated",
            metadata: ["count": "\(sectorNames.count)"]
        )
        let accounts = PostgresAccountRepository(client: client, logger: postgresLogger)
        let characters = PostgresCharacterRepository(client: client, logger: postgresLogger)
        let inventories = PostgresInventoryRepository(client: client, logger: postgresLogger)
        let registrations = PostgresRegistrationRepository(client: client, logger: postgresLogger)
        let passwordHasher = PasswordHasher(logger: postgresLogger)
        let worldRouterLogger = Logger(label: "de.tobiha.somnio.server.gameplay.world")
        worldRouter = await WorldRouter(
            sectors: sectorCache.snapshotByName(),
            characters: characters,
            logger: worldRouterLogger
        )
        dependencies = ConnectionDependencies(
            accounts: accounts,
            characters: characters,
            inventories: inventories,
            registrations: registrations,
            passwordHasher: passwordHasher,
            worldRouter: worldRouter,
            configuration: serverConfiguration,
            logger: Logger(label: "de.tobiha.somnio.server.gameplay.connection")
        )
    } catch {
        lifecycleLogger.error("startup failed; shutting down", metadata: ["error": "\(error)"])
        await group.triggerGracefulShutdown()
        _ = try? await groupTask.value
        throw error
    }

    let application = makeSomnioServerApplication(
        configuration: serverConfiguration,
        postgres: client,
        dependencies: dependencies
    )
    let checkpointService = CheckpointService(
        worldRouter: worldRouter,
        interval: serverConfiguration.checkpointInterval,
        logger: Logger(label: "de.tobiha.somnio.server.gameplay.checkpoint")
    )

    // Reverse-shutdown order is the inverse of registration order:
    // `CheckpointService` stops first (no new writes contend with the drain), then
    // `WorldRouter.run()` drains every logged-in connection, then the Hummingbird app
    // closes the accept loop, then `PostgresClient` tears down. The chosen ordering keeps
    // WebSocket connections live during the world drain so per-connection writer tasks can
    // flush their outboxes before the accept loop closes; the trade-off is that a login
    // racing in mid-drain can be silently dropped from `loggedInConnections.removeAll()`,
    // but its own `ConnectionActor` cleanup still snapshots through the disconnect path.
    // `addServiceUnlessShutdown` silently no-ops if the group is already shutting down,
    // which is the actual safety net against a SIGTERM during the readiness window.
    let postReadinessServices: [any Service] = [application, worldRouter, checkpointService]
    for service in postReadinessServices {
        await group.addServiceUnlessShutdown(
            ServiceGroupConfiguration.ServiceConfiguration(
                service: service,
                successTerminationBehavior: .gracefullyShutdownGroup,
                failureTerminationBehavior: .gracefullyShutdownGroup
            )
        )
    }

    lifecycleLogger.info("SomnioServer ready; awaiting termination signal")

    try await groupTask.value
}
