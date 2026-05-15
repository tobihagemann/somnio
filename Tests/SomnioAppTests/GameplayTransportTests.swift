import Foundation
import Logging
import SomnioProtocol
import Testing
@testable import SomnioApp

/// Tests for the surface of `GameplayTransport` that does not require a live
/// WebSocket peer. The connect/read-loop/event-delivery paths are covered by the
/// `ClientViewModel` state-machine tests via synthetic `GameplayTransportEvent`
/// values; these tests pin the actor's no-active-connection contracts.
struct GameplayTransportTests {
    @Test func `enqueue without an active connection is a silent no-op`() async {
        let transport = GameplayTransport(logger: Logger(label: "test.transport"))
        // No `run(...)` has been called; there is no outbox. Enqueue must not crash.
        await transport.enqueue(.clientPosition(PositionMessage(entityIndex: 0, x: 0, y: 0, facing: 0, tempo: 0)))
    }

    @Test func `disconnect without an active connection is a silent no-op`() async {
        let transport = GameplayTransport(logger: Logger(label: "test.transport"))
        await transport.disconnect()
    }
}
