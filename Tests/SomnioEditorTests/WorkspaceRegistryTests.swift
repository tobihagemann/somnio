import Foundation
import Testing
@testable import SomnioEditor

@MainActor struct WorkspaceRegistryTests {
    @Test func `workspace lookup is idempotent for the same document ID`() {
        let document = SectorDocument()
        let first = SectorWorkspaceRegistry.workspace(forID: document.id)
        let second = SectorWorkspaceRegistry.workspace(forID: document.id)
        #expect(first === second)
        SectorWorkspaceRegistry.discard(documentID: document.id)
    }

    @Test func `dropping a document drains the registry after the deinit task runs`() async throws {
        let baseline = SectorWorkspaceRegistry.count
        do {
            for _ in 0 ..< 10 {
                let document = SectorDocument()
                _ = SectorWorkspaceRegistry.workspace(forID: document.id)
            }
        }
        // `SectorDocument.deinit` enqueues a main-actor task to drop the workspace.
        // Yielding alone is not enough — the enqueued task and the assertion both run
        // on the main actor, so the bounded sleep matches the canonical pattern for
        // "wait for previously-enqueued main-actor work to drain."
        try await Task.sleep(for: .milliseconds(20))
        #expect(SectorWorkspaceRegistry.count == baseline)
    }
}
