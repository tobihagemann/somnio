import Foundation

/// Auto-spawns a `postgres:16` container on demand for the integration suite, exposing
/// the connection fields the harness can hand to `PostgresClient.Configuration`. `make()`
/// returns only after Postgres is actually accepting connections; `shutdown()` removes the
/// container even if the test body throws (the harness wires LIFO teardown).
public struct PostgresContainer: Sendable {
    public let host: String
    public let port: Int
    public let username: String
    public let password: String
    public let database: String
    private let containerId: String
    private let runtime: ContainerRuntime

    public static func make() async throws -> PostgresContainer {
        guard let runtime = ContainerRuntime.detected else {
            // Defensive: the suite's `.requiresContainerRuntime` trait gates this in normal
            // flow, so `make()` should never be reached without a runtime. Fail loudly if a
            // future direct caller bypasses the trait.
            preconditionFailure("PostgresContainer.make called without a container runtime — should be gated by @Suite(.requiresContainerRuntime)")
        }
        let password = generatePassword()
        let containerId = try runStart(runtime: runtime, password: password)
        do {
            let port = try await readAssignedPort(runtime: runtime, containerId: containerId)
            try await waitForReady(runtime: runtime, containerId: containerId)
            return PostgresContainer(
                host: "127.0.0.1",
                port: port,
                username: "postgres",
                password: password,
                database: "postgres",
                containerId: containerId,
                runtime: runtime
            )
        } catch {
            _ = ProcessRunner.runReturningStatus(runtime: runtime, arguments: ["rm", "-f", containerId])
            throw error
        }
    }

    public func shutdown() async {
        _ = ProcessRunner.runReturningStatus(runtime: runtime, arguments: ["rm", "-f", containerId])
    }

    /// Bind the host port to `127.0.0.1` only so a stray Docker daemon configuration that
    /// publishes container ports on `0.0.0.0` can't expose the test database to the LAN.
    /// `-p 127.0.0.1::5432` lets the runtime pick the host port (same behavior as `-P`)
    /// while pinning the host interface to loopback.
    private static func runStart(runtime: ContainerRuntime, password: String) throws -> String {
        let output = try ProcessRunner.runCapturingOutput(
            runtime: runtime,
            arguments: ["run", "-d", "--rm", "-e", "POSTGRES_PASSWORD=\(password)", "-p", "127.0.0.1::5432", "postgres:16"]
        )
        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw PostgresContainerError.startFailed("\(runtime.executableName) run returned empty container id")
        }
        return trimmed
    }

    private static func readAssignedPort(runtime: ContainerRuntime, containerId: String) async throws -> Int {
        for _ in 0 ..< 10 {
            do {
                let output = try ProcessRunner.runCapturingOutput(
                    runtime: runtime,
                    arguments: ["port", containerId, "5432"]
                )
                if let port = parseHostPort(from: output) {
                    return port
                }
            } catch {
                // ignored; retried below
            }
            try await Task.sleep(for: .milliseconds(200))
        }
        let logs = (try? ProcessRunner.runCapturingOutput(runtime: runtime, arguments: ["logs", containerId])) ?? ""
        throw PostgresContainerError.portUnavailable(containerId: containerId, logs: logs)
    }

    private static func parseHostPort(from output: String) -> Int? {
        // `docker port <id> 5432` output looks like:
        //   127.0.0.1:54321
        //   [::1]:54321
        for line in output.split(separator: "\n") {
            if let colonIndex = line.lastIndex(of: ":"),
               let port = Int(line[line.index(after: colonIndex)...]) {
                return port
            }
        }
        return nil
    }

    private static func waitForReady(runtime: ContainerRuntime, containerId: String) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(30))
        while ContinuousClock.now < deadline {
            let status = ProcessRunner.runReturningStatus(
                runtime: runtime,
                arguments: ["exec", containerId, "pg_isready", "-U", "postgres"]
            )
            if status == 0 { return }
            try await Task.sleep(for: .milliseconds(500))
        }
        throw PostgresContainerError.readinessTimeout(containerId: containerId)
    }

    /// Random per-container password so a stray container left running can't be reached
    /// from another test process or developer with a guessable shared password.
    private static func generatePassword() -> String {
        let charset: [Character] = Array("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
        return String((0 ..< 24).map { _ in charset.randomElement()! })
    }
}

public enum PostgresContainerError: Error, Sendable {
    case startFailed(String)
    case portUnavailable(containerId: String, logs: String)
    case readinessTimeout(containerId: String)
}
