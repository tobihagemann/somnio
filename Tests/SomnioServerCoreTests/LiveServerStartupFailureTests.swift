import Hummingbird
import Logging
import SomnioTestSupport
import Testing

/// Deterministic guard for `withLiveServer`'s startup race: a server that fails before
/// binding must rethrow its own error, and must do so immediately. Matching the concrete
/// error type is the point — a regression that buffers the failure until `startupTimeout`
/// elapses would throw `TestTimeoutError` instead (and the replaced framework would have
/// hung forever), so a broader `(any Error)` matcher could not catch it.
struct LiveServerStartupFailureTests {
    @Test func `withLiveServer rethrows a pre-bind startup failure without running the body`() async throws {
        var application = Application(
            router: Router(),
            configuration: ApplicationConfiguration(address: .hostname("127.0.0.1", port: 0)),
            logger: Logger(label: "test.live-server.startup-failure")
        )
        application.beforeServerStarts { throw ExpectedStartupFailure() }

        await #expect(throws: ExpectedStartupFailure.self) {
            try await withLiveServer(application) { _ in
                Issue.record("body must not run when the server never binds")
                return
            }
        }
    }
}

/// Marker error thrown by the pre-bind step; the helper must surface exactly this error.
private struct ExpectedStartupFailure: Error {}
