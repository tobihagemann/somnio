import Logging
import PostgresNIO

/// Polls the `PostgresClient` with `SELECT 1` until it succeeds or the deadline elapses.
///
/// Intended for the brief startup window where `PostgresClient.run()` is up but Postgres
/// itself may still be coming online (e.g., docker-compose, ephemeral test container). The
/// retry loop only catches `PSQLError.code == .connectionError` — all other Postgres
/// failures propagate immediately so genuine misconfiguration fails fast.
public func waitForClientQueryable(
    _ client: PostgresClient,
    logger: Logger,
    timeout: Duration = .seconds(5)
) async throws {
    var delayMilliseconds: UInt64 = 100
    let deadline = ContinuousClock.now.advanced(by: timeout)
    while ContinuousClock.now < deadline {
        do {
            _ = try await client.query("SELECT 1", logger: logger)
            return
        } catch let error as PSQLError where error.code == .connectionError {
            try await Task.sleep(for: .milliseconds(delayMilliseconds))
            delayMilliseconds = min(delayMilliseconds * 2, 2000)
        }
    }
    throw ServerStartupError.databaseUnreachable
}
