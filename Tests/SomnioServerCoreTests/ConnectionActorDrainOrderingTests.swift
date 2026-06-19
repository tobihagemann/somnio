import Foundation
import NIOWebSocket
import SomnioTestSupport
import Testing
@testable import SomnioServerCore

/// Deterministic regression sentinel for the drain-before-close exit ordering in
/// `ConnectionActor.finishDrainAndClose`. A live black-box test can't discriminate a
/// writer-await-past-close reorder (the writer drains into the send-buffer before any
/// client-driven close arrives), so this drives the extracted exit directly against a
/// recording, blocking sink.
///
/// The oracle is the final ordered event log, evaluated only after all work completes — not an
/// interim "is `.close` absent yet" check, which would race the exit task's scheduling. The
/// correct sequence yields `[.write × N, .close]`; a buggy `close`-before-`await writerTask`
/// appends `.close` while the writer is parked at the gate (spy-actor reentrancy lets it
/// through), then the remaining buffered writes land after it, so `.close` is not last and the
/// assertion fails.
struct ConnectionActorDrainOrderingTests {
    @Test(arguments: [1, 3])
    func `finishDrainAndClose drains every queued frame before the close frame`(gateOnWrite: Int) async throws {
        let frameCount = 4
        let sink = BlockingOutboundSink(gateOnWrite: gateOnWrite)
        let connection = try await ConnectionActor(dependencies: makeStubConnectionDependencies())
        let outbox = await connection.connectionOutbox

        await connection.startWriterTask(sink: sink)
        for index in 0 ..< frameCount {
            outbox.send(Data("frame-\(index)".utf8))
        }
        await sink.waitUntilParked()

        async let exit: Void = connection.finishDrainAndClose(
            decision: .close(code: .protocolError, reason: "x"),
            sink: sink
        )
        await sink.releaseGate()
        await exit

        let events = await sink.snapshot()
        #expect(events == Array(repeating: .write, count: frameCount) + [.close])
    }

    @Test func `the writer task closes with policyViolation when the outbox overflows`() async throws {
        let watermark = 4
        let sink = BlockingOutboundSink(gateOnWrite: 1)
        let dependencies = try await makeStubConnectionDependencies(outboxHighWatermark: watermark)
        let connection = try await ConnectionActor(dependencies: dependencies)
        let outbox = await connection.connectionOutbox

        await connection.startWriterTask(sink: sink)
        // Park the writer on the first frame so `inflight` accumulates without `recordWrite`,
        // then exceed the watermark to trip overflow (which finishes the mailbox). Releasing the
        // gate lets the writer drain the buffer and hit the `isOverflowed` post-loop close.
        for index in 0 ... watermark {
            outbox.send(Data("frame-\(index)".utf8))
        }
        await sink.waitUntilParked()
        await sink.releaseGate()
        await sink.waitUntilClosed()

        let (code, reason) = await sink.closeInfo()
        #expect(code == .policyViolation)
        #expect(reason == "outbox overflow")
        // The overflow close must land *after* the buffered frames drain (the fifth send trips
        // overflow and is dropped, so `watermark` writes precede the single close), not race
        // ahead of them.
        let events = await sink.snapshot()
        #expect(events == Array(repeating: .write, count: watermark) + [.close])
    }

    @Test func `finishDrainAndClose maps keepOpen to a goingAway close`() async throws {
        // No frames are enqueued, so the gate never fires; the writer drains nothing and the
        // close decision alone selects the wire code.
        let sink = BlockingOutboundSink(gateOnWrite: 1)
        let connection = try await ConnectionActor(dependencies: makeStubConnectionDependencies())

        await connection.startWriterTask(sink: sink)
        await connection.finishDrainAndClose(decision: .keepOpen, sink: sink)

        let (code, reason) = await sink.closeInfo()
        #expect(code == .goingAway)
        #expect(reason == "connection closed")
        // Exactly one close, no writes: confirms the writer's overflow branch stayed silent.
        let events = await sink.snapshot()
        #expect(events == [.close])
    }
}

/// Recording, blocking spy. Appends `.write`/`.close` to an ordered log and parks one selected
/// `writeText` on a continuation the test releases. A second continuation lets the test
/// synchronize on the gated write actually suspending, so there is no `Task.sleep`. An `actor`,
/// never `@unchecked Sendable`.
private actor BlockingOutboundSink: ConnectionOutboundSink {
    enum Event: Equatable { case write, close }

    private(set) var events: [Event] = []
    private let gateOnWrite: Int
    private var writeCount = 0
    private var parked = false
    private var closed = false
    private var lastCloseCode: WebSocketErrorCode?
    private var lastCloseReason: String?
    private var gateContinuation: CheckedContinuation<Void, Never>?
    private var parkedContinuation: CheckedContinuation<Void, Never>?
    private var closedContinuation: CheckedContinuation<Void, Never>?

    init(gateOnWrite: Int) {
        self.gateOnWrite = gateOnWrite
    }

    func writeText(_: Data) async throws {
        writeCount += 1
        if writeCount == gateOnWrite {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                gateContinuation = continuation
                parked = true
                parkedContinuation?.resume()
                parkedContinuation = nil
            }
        }
        events.append(.write)
    }

    func close(code: WebSocketErrorCode, reason: String) async {
        lastCloseCode = code
        lastCloseReason = reason
        events.append(.close)
        closed = true
        closedContinuation?.resume()
        closedContinuation = nil
    }

    /// Suspends until the gated `writeText` has actually parked. Returns immediately if the
    /// write parked before this was called (the `parked` flag closes that race).
    func waitUntilParked() async {
        if parked { return }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            parkedContinuation = continuation
        }
    }

    func releaseGate() {
        gateContinuation?.resume()
        gateContinuation = nil
    }

    /// Suspends until `close` has run. Returns immediately if the close already happened
    /// (the `closed` flag closes that race).
    func waitUntilClosed() async {
        if closed { return }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            closedContinuation = continuation
        }
    }

    func closeInfo() -> (WebSocketErrorCode?, String?) {
        (lastCloseCode, lastCloseReason)
    }

    func snapshot() -> [Event] {
        events
    }
}
