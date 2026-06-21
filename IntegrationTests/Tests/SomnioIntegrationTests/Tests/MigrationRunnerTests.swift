import Logging
import PostgresNIO
import SomnioData
import Testing

@Suite(.requiresContainerRuntime)
struct MigrationRunnerTests {
    @Test func `applyPending is idempotent on an already-migrated database`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.migrations.idempotent")
            // The harness already ran applyPending on container setup. A second call must
            // see every registered migration in `schema_migrations` and short-circuit.
            try await MigrationRunner(client: client, logger: logger).applyPending()
            let rows = try await client.query("SELECT COUNT(*) FROM schema_migrations", logger: logger)
            var count: Int = -1
            for try await value in rows.decode(Int.self) {
                count = value
            }
            #expect(count == MigrationRegistry.all.count)
        }
    }

    @Test func `failed migration rolls back the entire batch`() async throws {
        try await TestHarness.withDatabase(applyMigrations: false) { client in
            let logger = Logger(label: "test.migrations.rollback")
            // The harness leaves the schema empty when `applyMigrations: false` is set, so
            // the runner sees a virgin database and we can exercise the rollback path
            // without first dropping the harness-applied schema.
            let firstReal = try #require(MigrationRegistry.all.first)
            let bad: [Migration] = [
                firstReal,
                Migration(
                    version: 999_999,
                    name: "intentional_failure",
                    statements: ["SELECT * FROM definitely_not_a_table_anywhere"]
                )
            ]
            // `withTransaction` wraps the failed statement in PostgresTransactionError;
            // we assert via type-erased Error and verify rollback through the existence
            // checks below.
            await #expect(throws: (any Error).self) {
                try await MigrationRunner(client: client, registry: bad, logger: logger).applyPending()
            }

            // The runner wraps the entire batch in one transaction so the first migration's
            // table must not be present after the rollback.
            let rows = try await client.query(
                """
                SELECT to_regclass('public.accounts') IS NOT NULL,
                       to_regclass('public.schema_migrations') IS NOT NULL
                """,
                logger: logger
            )
            for try await (accountsExists, schemaMigrationsExists) in rows.decode((Bool, Bool).self) {
                #expect(accountsExists == false)
                #expect(schemaMigrationsExists == false)
            }
        }
    }

    @Test func `migration v6 adds skeleton columns and partial unique indexes`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.migrations.skeleton")
            let rows = try await client.query(
                """
                SELECT
                    to_regclass('public.accounts_name_skeleton_key') IS NOT NULL,
                    to_regclass('public.characters_name_skeleton_key') IS NOT NULL,
                    EXISTS (SELECT 1 FROM information_schema.columns
                            WHERE table_name = 'accounts' AND column_name = 'name_skeleton'),
                    EXISTS (SELECT 1 FROM information_schema.columns
                            WHERE table_name = 'characters' AND column_name = 'name_skeleton_version')
                """,
                logger: logger
            )
            for try await (accountIndex, characterIndex, accountColumn, characterColumn)
                in rows.decode((Bool, Bool, Bool, Bool).self) {
                #expect(accountIndex)
                #expect(characterIndex)
                #expect(accountColumn)
                #expect(characterColumn)
            }
        }
    }

    @Test func `applyPending applies only newly added migrations on a partially migrated database`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.migrations.partial")
            // The harness has already applied every registered migration. Append one
            // synthetic migration and re-run; only the new one should land.
            let synthetic = Migration(
                version: MigrationRegistry.all.count + 1,
                name: "create_partial_apply_marker",
                statements: ["CREATE TABLE partial_apply_marker (id INTEGER PRIMARY KEY)"]
            )
            let registry = MigrationRegistry.all + [synthetic]
            try await MigrationRunner(client: client, registry: registry, logger: logger).applyPending()

            let rows = try await client.query(
                "SELECT COUNT(*) FROM schema_migrations",
                logger: logger
            )
            var count = -1
            for try await value in rows.decode(Int.self) {
                count = value
            }
            #expect(count == registry.count)

            let markerExists = try await client.query(
                "SELECT to_regclass('public.partial_apply_marker') IS NOT NULL",
                logger: logger
            )
            for try await exists in markerExists.decode(Bool.self) {
                #expect(exists == true)
            }
        }
    }
}
