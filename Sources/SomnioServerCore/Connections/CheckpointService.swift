import Foundation
import Logging
import ServiceLifecycle
import SomnioData

/// Periodic per-character checkpoint timer. Each pass calls `WorldRouter.checkpointAll()`; the
/// shutdown-cancel + error semantics live in `runPeriodically`.
///
/// The same pass sweeps expired session rows. They ride along here rather than in a service of their
/// own because the work is identical in shape — a periodic database write with no coordination — and
/// a second timer would double the machinery for one statement. The sweep is what makes
/// `SessionRepository.deleteExpired`'s "keeps the table from growing without bound" true: nothing on
/// the connection path can remove a row, because refresh, network loss, and a normal close must all
/// *preserve* the token for resumption.
public actor CheckpointService: Service {
    private let worldRouter: WorldRouter
    private let sessions: any SessionRepository
    private let interval: Duration
    private let logger: Logger

    public init(
        worldRouter: WorldRouter,
        sessions: any SessionRepository,
        interval: Duration,
        logger: Logger
    ) {
        self.worldRouter = worldRouter
        self.sessions = sessions
        self.interval = interval
        self.logger = logger
    }

    public func run() async throws {
        await runPeriodically(interval: interval, logger: logger, label: "checkpoint") { [worldRouter, sessions, logger] in
            await worldRouter.checkpointAll()
            // Failure is logged and swallowed, never propagated: an unreachable database must not
            // take the checkpoint timer down with it, and an unswept row is harmless until the next
            // pass. Expiry is enforced on the read path regardless, so a missed sweep costs storage
            // rather than letting a dead token authenticate.
            do {
                let deleted = try await sessions.deleteExpired(asOf: Date())
                if deleted > 0 {
                    logger.info("expired sessions swept", metadata: ["count": "\(deleted)"])
                }
            } catch {
                logger.warning("expired session sweep failed", metadata: ["error": "\(error)"])
            }
        }
    }
}
