import Foundation
import Logging
import PostgresNIO
import SomnioData

public enum TestHarness {
    /// Runs `body` against a freshly-spawned `postgres:16` container with all migrations
    /// applied. Tears down both the client and the container even when the body throws —
    /// LIFO ordering: cancel `client.run()` first, then remove the container.
    public static func withDatabase(
        _ body: @Sendable (PostgresClient) async throws -> Void
    ) async throws {
        try await withDatabase(applyMigrations: true, body)
    }

    /// Variant that lets a test pre-empt the harness's automatic migration pass — used by
    /// `MigrationRunnerTests` so the runner itself is the only thing applying migrations.
    public static func withDatabase(
        applyMigrations: Bool,
        _ body: @Sendable (PostgresClient) async throws -> Void
    ) async throws {
        let logger = Logger(label: "test.somnio-integration")
        let container = try await PostgresContainer.make()

        let configuration = PostgresClient.Configuration(
            host: container.host,
            port: container.port,
            username: container.username,
            password: container.password,
            database: container.database,
            tls: .disable
        )
        let client = PostgresClient(configuration: configuration, backgroundLogger: logger)

        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask { await client.run() }
            do {
                try await waitForClientQueryable(client, logger: logger)
                if applyMigrations {
                    try await MigrationRunner(client: client, logger: logger).applyPending()
                }
                try await body(client)
            } catch {
                group.cancelAll()
                try? await group.waitForAll()
                await container.shutdown()
                throw error
            }
            group.cancelAll()
            try? await group.waitForAll()
            await container.shutdown()
        }
    }
}

public enum HarnessError: Error, Sendable {
    case invalidConnectionURL(String)
}
