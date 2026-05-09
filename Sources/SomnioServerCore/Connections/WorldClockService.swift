import Foundation
import Logging
import ServiceLifecycle
import SomnioCore
import SomnioData
import SomnioProtocol

/// Drives the in-game world clock at 4× wall clock. Owns the only `WorldClock` instance the
/// server mutates: each tick advances the clock, broadcasts a `DateTick` to every logged-in
/// connection on the configured minute marks, and persists the post-tick state once per
/// in-game minute. The pre-loaded `initialClock` parameter is required (no default seed) so
/// a forgotten pre-load is a compile error rather than a startup race that hands clients
/// `bootDefault` instead of the persisted state.
public actor WorldClockService: Service {
    private let worldRouter: WorldRouter
    private let worldClocks: any WorldClockRepository
    private let interval: Duration
    private let logger: Logger
    private var clock: WorldClock

    public init(
        worldRouter: WorldRouter,
        worldClocks: any WorldClockRepository,
        initialClock: WorldClock,
        interval: Duration = .milliseconds(250),
        logger: Logger
    ) {
        self.worldRouter = worldRouter
        self.worldClocks = worldClocks
        self.clock = initialClock
        self.interval = interval
        self.logger = logger
    }

    public func run() async throws {
        let interval = interval
        let logger = logger
        await cancelWhenGracefulShutdown {
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: interval)
                } catch is CancellationError {
                    return
                } catch {
                    logger.warning(
                        "world clock sleep failed",
                        metadata: ["error": "\(error)"]
                    )
                    return
                }
                await self.tickOnce()
            }
        }
        // After graceful-shutdown signals: persist whatever the post-tick state is so the
        // last in-game second isn't lost. The service group is already shutting down, so a
        // thrown save error has no recovery path — log and return.
        do {
            try await worldClocks.save(clock)
        } catch {
            logger.warning(
                "world clock final save failed",
                metadata: ["error": "\(error)"]
            )
        }
    }

    /// Direct test seam. Tests drive `tickOnce()` and read `currentTime()` instead of
    /// sleeping the service for `interval`.
    func tickOnce() async {
        let wire = clock.tick()
        // Post-tick second == 0 means we just rolled into a new minute. Two gates run on
        // that boundary: the broadcast gate fires on each mid-hour mark from
        // `SomnioConstants.dateTickMinutes` plus the hour rollover (minute 0); the persist
        // gate fires on every new-minute boundary regardless. The wire's midnight `hour=24`
        // quirk is encoded in `WireTime` so the emit carries it naturally.
        if clock.second == 0 {
            let isMidHourMark = SomnioConstants.dateTickMinutes.contains(clock.minute)
            let isHourRollover = clock.minute == 0
            if isMidHourMark || isHourRollover {
                await worldRouter.broadcastToAllConnections(
                    .dateTick(DateTickMessage(hour: wire.hour, minute: wire.minute))
                )
            }
            do {
                try await worldClocks.save(clock)
            } catch {
                logger.warning(
                    "world clock save failed",
                    metadata: ["error": "\(error)"]
                )
            }
        }
    }

    /// Full clock state for the admin `time` verb readout.
    public func currentTime() -> WorldClock {
        clock
    }

    /// Wire payload used by the per-login and per-portal hooks: a snapshot of the post-tick
    /// internal `(hour, minute)` state. Does not advance the clock and does not reproduce
    /// the midnight `hour=24` quirk (only the advancing tick produces that wire shape, and
    /// these snapshots are post-rollover).
    public func currentDateTickMessage() -> DateTickMessage {
        DateTickMessage(hour: clock.hour, minute: clock.minute)
    }
}
