import Foundation
import Logging
import ServiceLifecycle

/// Periodic per-character checkpoint timer. Each pass calls `WorldRouter.checkpointAll()`; the
/// shutdown-cancel + error semantics live in `runPeriodically`.
public actor CheckpointService: Service {
    private let worldRouter: WorldRouter
    private let interval: Duration
    private let logger: Logger

    public init(worldRouter: WorldRouter, interval: Duration, logger: Logger) {
        self.worldRouter = worldRouter
        self.interval = interval
        self.logger = logger
    }

    public func run() async throws {
        await runPeriodically(interval: interval, logger: logger, label: "checkpoint") { [worldRouter] in
            await worldRouter.checkpointAll()
        }
    }
}
