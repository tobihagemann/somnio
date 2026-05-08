import Foundation
import PostgresNIO
import SomnioCore

/// Errors thrown by the server bootstrap (config resolution, readiness wait, migrations).
public enum ServerStartupError: Error, Sendable, Equatable, CustomStringConvertible {
    /// `SOMNIO_DATABASE_URL` failed to parse. The associated value carries a redacted shape
    /// (scheme + host) so credentials embedded in the URL never reach logs.
    case invalidDatabaseURL(redacted: String)
    case databaseUnreachable
    /// Release builds require an explicit `SOMNIO_DATABASE_URL`; the no-URL plaintext
    /// localhost fallback is a dev-only convenience.
    case missingDatabaseURLInRelease

    public var description: String {
        switch self {
        case let .invalidDatabaseURL(redacted):
            return "SOMNIO_DATABASE_URL is malformed: \(redacted)"
        case .databaseUnreachable:
            return "Postgres did not become reachable within the startup timeout"
        case .missingDatabaseURLInRelease:
            return "SOMNIO_DATABASE_URL must be set in a release build"
        }
    }
}

/// Resolves a `PostgresClient.Configuration` from the process environment.
///
/// Precedence:
/// - `SOMNIO_DATABASE_URL` is parsed via `URLComponents`. The URL must use the `postgres`
///   or `postgresql` scheme; anything else is rejected as malformed. Apple's `user` /
///   `password` / `host` getters return percent-decoded form, so passwords with `@` / `:`
///   round-trip correctly when the URL is RFC-3986-encoded. The URL's database path is
///   authoritative when present; an empty path falls back to `databaseName`. TLS defaults
///   to `.require` so a network attacker cannot strip TLS; an operator may opt out via
///   `SOMNIO_DATABASE_TLS=disable` for plaintext development setups.
/// - With no URL, debug builds default to `localhost:5432` / `postgres` / no password /
///   `databaseName`, `tls: .disable`. Release builds reject the no-URL path so a
///   misconfigured deployment fails closed instead of silently connecting to the operator's
///   local Postgres.
public func resolvePostgresConfiguration(
    environment: [String: String] = ProcessInfo.processInfo.environment,
    databaseName: String = BuildEnvironment.databaseName,
    isDebug: Bool = isDebugBuild
) throws -> PostgresClient.Configuration {
    if let raw = environment["SOMNIO_DATABASE_URL"] {
        guard let components = URLComponents(string: raw),
              components.scheme == "postgres" || components.scheme == "postgresql",
              let host = components.host
        else {
            throw ServerStartupError.invalidDatabaseURL(redacted: redact(raw))
        }
        let port = components.port ?? 5432
        let username = components.user ?? "postgres"
        let password = components.password
        let pathDatabase = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let database = pathDatabase.isEmpty ? databaseName : pathDatabase
        let tls = environment["SOMNIO_DATABASE_TLS"] == "disable"
            ? PostgresClient.Configuration.TLS.disable
            : PostgresClient.Configuration.TLS.require(.clientDefault)
        return PostgresClient.Configuration(
            host: host,
            port: port,
            username: username,
            password: password,
            database: database,
            tls: tls
        )
    }
    guard isDebug else {
        throw ServerStartupError.missingDatabaseURLInRelease
    }
    return PostgresClient.Configuration(
        host: "localhost",
        port: 5432,
        username: "postgres",
        password: nil,
        database: databaseName,
        tls: .disable
    )
}

/// Build-flavor flag — debug vs release — exposed for testability so the helper isn't tied
/// to the compile-time `#if DEBUG` of its caller.
public let isDebugBuild: Bool = {
    #if DEBUG
        return true
    #else
        return false
    #endif
}()

/// Strips userinfo and path from a Postgres URL string so a parse-failure log never leaks
/// embedded credentials. Example: `postgres://user:pass@db.example.com:5432/somnio` →
/// `postgres://db.example.com:5432`.
private func redact(_ raw: String) -> String {
    if let components = URLComponents(string: raw),
       let host = components.host {
        let scheme = components.scheme ?? "postgres"
        if let port = components.port {
            return "\(scheme)://\(host):\(port)"
        }
        return "\(scheme)://\(host)"
    }
    return "<unparseable>"
}
