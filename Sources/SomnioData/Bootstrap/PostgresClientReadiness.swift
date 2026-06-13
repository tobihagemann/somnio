import Logging
import PostgresNIO

/// Confirms the database answers a `SELECT 1`.
///
/// No bespoke backoff loop: `PostgresClient`'s connection pool is itself the readiness
/// mechanism — while Postgres is still coming online (docker-compose, ephemeral test
/// container) the pool retries dials internally until it connects or its circuit breaker
/// trips, so this probe blocks until the database answers or the pool gives up. A genuine
/// misconfiguration (bad credentials, unresolvable host) surfaces its underlying error
/// directly so startup fails fast with a meaningful diagnostic.
public func waitForClientQueryable(
    _ client: PostgresClient,
    logger: Logger
) async throws {
    _ = try await client.query("SELECT 1", logger: logger)
}
