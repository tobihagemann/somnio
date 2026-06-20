import Foundation
import Logging
import ServiceLifecycle

/// Shared periodic-loop skeleton for the server's tick services. Sleeps for `interval` between
/// passes and runs `body` each wake. On graceful shutdown the inner sleep cancels and the loop
/// returns normally (the `CancellationError` branch); any other sleep failure is logged under
/// `"\(label) sleep failed"` and also returns. Callers that need work after the loop ends (e.g.
/// a final save) put it after the `await runPeriodically(...)` call.
func runPeriodically(
    interval: Duration,
    logger: Logger,
    label: String,
    _ body: @escaping @Sendable () async -> Void
) async {
    await cancelWhenGracefulShutdown {
        while !Task.isCancelled {
            do {
                try await Task.sleep(for: interval)
            } catch is CancellationError {
                return
            } catch {
                logger.warning(
                    "\(label) sleep failed",
                    metadata: ["error": "\(error)"]
                )
                return
            }
            await body()
        }
    }
}
