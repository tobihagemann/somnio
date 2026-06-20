import Foundation
import Logging
import ServiceLifecycle

/// Periodic AI-tick driver. Each pass calls `WorldRouter.runAITickAcrossSectors()`, which
/// iterates every loaded sector's actor and persists the per-tick dialog digests. The
/// shutdown-cancel + error semantics live in `runPeriodically`.
public actor AITickService: Service {
    /// The AI-tick cadence in seconds — a server-loop implementation detail, not shared
    /// gameplay policy. Paired with `SomnioConstants.npcDialogCooldownSeconds` so the dialog
    /// cooldown stays a single rule: `PerSectorActor.NPCRuntime.dialogCooldownCap` derives its
    /// tick count from this value. `public` so the `public init` default below can reference it.
    public static let defaultAITickIntervalSeconds = 0.05

    private let worldRouter: WorldRouter
    private let interval: Duration
    private let logger: Logger

    public init(
        worldRouter: WorldRouter,
        interval: Duration = .seconds(AITickService.defaultAITickIntervalSeconds),
        logger: Logger
    ) {
        self.worldRouter = worldRouter
        self.interval = interval
        self.logger = logger
    }

    public func run() async throws {
        await runPeriodically(interval: interval, logger: logger, label: "ai tick") { [worldRouter] in
            await worldRouter.runAITickAcrossSectors()
        }
    }
}
