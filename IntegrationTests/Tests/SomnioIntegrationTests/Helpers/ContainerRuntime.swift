import Foundation

/// Picks between Docker and Podman for spawning ephemeral test containers, preferring
/// whichever exposes a healthy daemon. The integration suite is intentionally
/// self-contained: there is no env-var override, only auto-detection.
public enum ContainerRuntime: Sendable {
    case docker
    case podman

    public var executableName: String {
        switch self {
        case .docker: return "docker"
        case .podman: return "podman"
        }
    }

    /// `static let` memoizes detection at first access; Swift Testing's `ConditionTrait`
    /// re-evaluates the autoclosure before every test, so without memoization we'd shell
    /// out N times per run. Environment changes mid-run are not observed (acceptable for
    /// CI / single-shot CLI runs).
    public static let detected: ContainerRuntime? = ContainerRuntime.detect()

    /// Tries `docker info` then `podman info` — both must exit zero, which verifies a
    /// usable daemon (CLI presence alone is not enough — `docker --version` exits 0 even
    /// when the daemon is stopped, which would surface as test failures rather than
    /// clean skips).
    public static func detect() -> ContainerRuntime? {
        if ProcessRunner.runReturningStatus(runtime: .docker, arguments: ["info", "-f", "{{.ServerVersion}}"]) == 0 {
            return .docker
        }
        if ProcessRunner.runReturningStatus(runtime: .podman, arguments: ["info", "--format", "{{.Version.Version}}"]) == 0 {
            return .podman
        }
        return nil
    }
}
