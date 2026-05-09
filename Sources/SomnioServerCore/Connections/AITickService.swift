import Foundation
import Logging
import ServiceLifecycle

/// Periodic AI-tick driver. Sleeps for `interval` between passes; on graceful shutdown the
/// inner sleep cancels and `run()` returns normally. Each pass calls
/// `WorldRouter.runAITickAcrossSectors()` which iterates every loaded sector's actor and
/// persists the per-tick dialog digests.
public actor AITickService: Service {
    private let worldRouter: WorldRouter
    private let interval: Duration
    private let logger: Logger

    public init(
        worldRouter: WorldRouter,
        interval: Duration = .milliseconds(50),
        logger: Logger
    ) {
        self.worldRouter = worldRouter
        self.interval = interval
        self.logger = logger
    }

    public func run() async throws {
        let interval = interval
        let logger = logger
        let worldRouter = worldRouter
        await cancelWhenGracefulShutdown {
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: interval)
                } catch is CancellationError {
                    return
                } catch {
                    logger.warning(
                        "ai tick sleep failed",
                        metadata: ["error": "\(error)"]
                    )
                    return
                }
                await worldRouter.runAITickAcrossSectors()
            }
        }
    }
}
