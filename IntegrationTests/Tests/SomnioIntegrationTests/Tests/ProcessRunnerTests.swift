import Testing

/// Regression guard against the pipe-buffer deadlock that `ProcessRunner` exists to prevent.
/// The kernel pipe buffer is ~64 KiB on macOS and Linux; if the child writes past that
/// and the parent isn't reading, the child blocks at `write(2)` and `waitUntilExit` hangs.
/// We force the child to emit ~256 KiB on each stream before exiting so any future
/// regression (re-introducing an undrained pipe, dropping `nullDevice`, or moving the read
/// after `waitUntilExit`) trips the test instead of CI.
@Suite(.requiresContainerRuntime)
struct ProcessRunnerTests {
    @Test func `runCapturingOutput drains large combined output`() throws {
        // Use `/bin/sh -c "for i in ...; do echo line; done >&2; ..."` via the container
        // runtime as a `run --rm <image> /bin/sh -c ...` is overkill — instead we shell
        // out to /bin/sh directly via the runtime's `run --rm alpine` lightweight image.
        // Skipping this test against an absent container runtime is handled by the suite
        // trait, which is the same gating the rest of the integration suite uses.
        guard let runtime = ContainerRuntime.detected else { return }
        let payload = "echo this output should exceed the pipe buffer | head -c 1; for i in $(seq 1 6000); do printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n'; done; for i in $(seq 1 6000); do printf 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\n' 1>&2; done"
        let output = try ProcessRunner.runCapturingOutput(
            runtime: runtime,
            arguments: ["run", "--rm", "alpine:3", "/bin/sh", "-c", payload]
        )
        // Output is the merged stream; both streams together should comfortably exceed
        // the pipe buffer (~64 KiB). 6000 lines × 49 bytes ≈ 294 KiB per stream.
        #expect(output.count > 100_000)
        #expect(output.contains("aaaaaaaaaa"))
        #expect(output.contains("bbbbbbbbbb"))
    }

    @Test func `runReturningStatus does not hang on large discarded output`() {
        guard let runtime = ContainerRuntime.detected else { return }
        let payload = "for i in $(seq 1 6000); do printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n'; done; for i in $(seq 1 6000); do printf 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\n' 1>&2; done; exit 0"
        let status = ProcessRunner.runReturningStatus(
            runtime: runtime,
            arguments: ["run", "--rm", "alpine:3", "/bin/sh", "-c", payload]
        )
        #expect(status == 0)
    }
}
