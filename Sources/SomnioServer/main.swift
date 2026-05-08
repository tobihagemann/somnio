import Foundation
import Logging
import PostgresNIO
import ServiceLifecycle
import SomnioData

ServerLoggingConfiguration.bootstrap()

let lifecycleLog = Logger(label: "de.tobiha.somnio.server.lifecycle")
let postgresLog = Logger(label: "de.tobiha.somnio.server.gameplay.persistence.postgres")
/// Migrations are admin/operator concern (one-shot at boot), not gameplay traffic, so the
/// label routes through the admin file backend instead of gameplay-log.log.
let migrationsLog = Logger(label: "de.tobiha.somnio.server.admin.migrations")

let configuration: PostgresClient.Configuration
do {
    configuration = try resolvePostgresConfiguration()
} catch {
    lifecycleLog.error("failed to resolve Postgres configuration", metadata: ["error": "\(error)"])
    exit(1)
}

let client = PostgresClient(configuration: configuration, backgroundLogger: postgresLog)

let group = ServiceGroup(
    configuration: ServiceGroupConfiguration(
        services: [
            ServiceGroupConfiguration.ServiceConfiguration(
                service: client,
                successTerminationBehavior: .gracefullyShutdownGroup,
                failureTerminationBehavior: .gracefullyShutdownGroup
            )
        ],
        gracefulShutdownSignals: [.sigint, .sigterm],
        logger: lifecycleLog
    )
)

let groupTask = Task { try await group.run() }

do {
    try await waitForClientQueryable(client, logger: postgresLog)
    try await MigrationRunner(client: client, logger: migrationsLog).applyPending()
} catch {
    lifecycleLog.error("startup failed; shutting down", metadata: ["error": "\(error)"])
    await group.triggerGracefulShutdown()
    _ = try? await groupTask.value
    exit(1)
}

lifecycleLog.info("SomnioServer ready; awaiting termination signal")

try await groupTask.value
