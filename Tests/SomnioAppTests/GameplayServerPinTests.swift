import Foundation
import Testing
@testable import SomnioApp

struct GameplayServerPinTests {
    @Test func `debug build returns skipPinning`() {
        // The `resolve()` helper hard-codes `.skipPinning` under `#if DEBUG`. The test
        // suite always runs under DEBUG, so this branch is the only path callable from
        // tests; the release-only PEM-parse logic must be covered by the
        // `swift build -c release` smoke test in the packaging shell.
        let resolution = GameplayServerTrust.resolve()
        if case .skipPinning = resolution {
            #expect(true)
        } else {
            Issue.record("expected .skipPinning in debug build, got \(resolution)")
        }
    }
}
