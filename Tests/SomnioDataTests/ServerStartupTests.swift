import Foundation
import PostgresNIO
import Testing
@testable import SomnioData

struct ServerStartupTests {
    @Test func `no env URL in debug falls back to localhost defaults`() throws {
        let configuration = try resolvePostgresConfiguration(
            environment: [:],
            databaseName: "somnio_dev",
            isDebug: true
        )
        #expect(configuration.host == "localhost")
        #expect(configuration.port == 5432)
        #expect(configuration.username == "postgres")
        #expect(configuration.password == nil)
        #expect(configuration.database == "somnio_dev")
        #expect(tlsKind(configuration) == .disable)
    }

    @Test func `no env URL in release rejects with missingDatabaseURLInRelease`() {
        #expect(throws: ServerStartupError.missingDatabaseURLInRelease) {
            _ = try resolvePostgresConfiguration(environment: [:], databaseName: "somnio", isDebug: false)
        }
    }

    @Test func `env URL overrides every field and forces TLS`() throws {
        let configuration = try resolvePostgresConfiguration(
            environment: ["SOMNIO_DATABASE_URL": "postgres://alice:hunter2@db.example.com:6432/somnio"],
            databaseName: "ignored",
            isDebug: false
        )
        #expect(configuration.host == "db.example.com")
        #expect(configuration.port == 6432)
        #expect(configuration.username == "alice")
        #expect(configuration.password == "hunter2")
        #expect(configuration.database == "somnio")
        #expect(tlsKind(configuration) == .require)
    }

    @Test func `env URL with empty path falls back to databaseName`() throws {
        let configuration = try resolvePostgresConfiguration(
            environment: ["SOMNIO_DATABASE_URL": "postgres://alice@db.example.com:6432/"],
            databaseName: "somnio_dev",
            isDebug: false
        )
        #expect(configuration.database == "somnio_dev")
    }

    @Test func `env URL without port and without user uses defaults`() throws {
        let configuration = try resolvePostgresConfiguration(
            environment: ["SOMNIO_DATABASE_URL": "postgres://db.example.com/somnio"],
            databaseName: "ignored",
            isDebug: false
        )
        #expect(configuration.port == 5432)
        #expect(configuration.username == "postgres")
        #expect(configuration.password == nil)
    }

    @Test func `env URL with percent encoded password decodes correctly`() throws {
        // RFC 3986 requires `@` in a password to be percent-encoded as `%40`. The decoded
        // form must reach SCRAM-SHA-256 verbatim or auth fails silently.
        let configuration = try resolvePostgresConfiguration(
            environment: ["SOMNIO_DATABASE_URL": "postgres://alice:p%40ss@db.example.com/somnio"],
            databaseName: "ignored",
            isDebug: false
        )
        #expect(configuration.password == "p@ss")
    }

    @Test func `SOMNIO_DATABASE_TLS=disable opts the env URL out of TLS`() throws {
        let configuration = try resolvePostgresConfiguration(
            environment: [
                "SOMNIO_DATABASE_URL": "postgres://alice@db.example.com/somnio",
                "SOMNIO_DATABASE_TLS": "disable"
            ],
            databaseName: "ignored",
            isDebug: true
        )
        #expect(tlsKind(configuration) == .disable)
    }

    @Test func `non-postgres scheme is rejected`() {
        #expect(throws: ServerStartupError.self) {
            _ = try resolvePostgresConfiguration(
                environment: ["SOMNIO_DATABASE_URL": "https://db.example.com/somnio"],
                databaseName: "ignored",
                isDebug: false
            )
        }
    }

    @Test func `postgresql scheme is also accepted`() throws {
        let configuration = try resolvePostgresConfiguration(
            environment: ["SOMNIO_DATABASE_URL": "postgresql://db.example.com/somnio"],
            databaseName: "ignored",
            isDebug: false
        )
        #expect(configuration.host == "db.example.com")
    }

    @Test func `non URL strings are rejected`() {
        #expect(throws: ServerStartupError.self) {
            _ = try resolvePostgresConfiguration(
                environment: ["SOMNIO_DATABASE_URL": "not a url"],
                databaseName: "somnio",
                isDebug: false
            )
        }
    }
}

/// `PostgresClient.Configuration.TLS` is a struct with a private `Base` enum, so tests
/// can't pattern-match against the case literals directly. `String(describing:)` reports
/// the wrapped case, which is enough to assert the configuration's TLS mode.
private enum TLSKind: String {
    case disable
    case prefer
    case require
}

private func tlsKind(_ configuration: PostgresClient.Configuration) -> TLSKind {
    let description = String(describing: configuration.tls)
    if description.contains("disable") { return .disable }
    if description.contains("prefer") { return .prefer }
    if description.contains("require") { return .require }
    return .disable
}
