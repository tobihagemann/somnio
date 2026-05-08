import Foundation

/// Centralizes the `Process` boilerplate that every container helper needs. The two flavors
/// matter: `runReturningStatus` is for fire-and-forget probes (status-only), while
/// `runCapturingOutput` reads stdout to EOF **before** waiting for exit. Both helpers
/// merge stderr into stdout via `process.standardError = stdout` so the kernel pipe
/// buffer (~64 KiB) can never block the child on a write — the same deadlock would otherwise
/// resurface on the stderr pipe under any verbose subcommand (e.g., a `docker logs` call).
enum ProcessRunner {
    /// Run `<runtime> <args...>` synchronously and return the exit status. Output is
    /// discarded but still drained: a `Pipe` whose read end is never read can still block
    /// the child once filled, so we route both streams to `FileHandle.nullDevice` and let
    /// the kernel discard them.
    static func runReturningStatus(runtime: ContainerRuntime, arguments: [String]) -> Int32 {
        let process = makeProcess(runtime: runtime, arguments: arguments)
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus
        } catch {
            return -1
        }
    }

    /// Run `<runtime> <args...>` synchronously and return its combined stdout+stderr.
    /// Throws when the child exits non-zero. Drains the merged stream to EOF *before*
    /// `waitUntilExit` so large output never deadlocks on a full pipe buffer.
    static func runCapturingOutput(runtime: ContainerRuntime, arguments: [String]) throws -> String {
        let process = makeProcess(runtime: runtime, arguments: arguments)
        let combined = Pipe()
        process.standardOutput = combined
        process.standardError = combined
        try process.run()
        let data = combined.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw ProcessRunnerError.nonZeroExit(arguments: arguments, exitCode: process.terminationStatus)
        }
        return String(decoding: data, as: UTF8.self)
    }

    private static func makeProcess(runtime: ContainerRuntime, arguments: [String]) -> Process {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [runtime.executableName] + arguments
        return process
    }
}

enum ProcessRunnerError: Error {
    case nonZeroExit(arguments: [String], exitCode: Int32)
}
