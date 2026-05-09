import Foundation
import Testing
@testable import SomnioServerCore

/// `ConnectionOutbox.send` is documented as never blocking. Once the in-flight count
/// exceeds the high watermark the outbox finishes its stream so a writer task observes
/// the end and closes the WebSocket with `.policyViolation`.
struct OutboxOverflowTests {
    @Test func `sending past the high watermark trips overflow and finishes the stream`() async {
        let watermark = 4
        let outbox = ConnectionOutbox(highWatermark: watermark)

        // Stuff `watermark + 1` frames in without draining anything from the stream.
        for index in 0 ..< (watermark + 1) {
            outbox.send(Data([UInt8(index)]))
        }

        #expect(outbox.isOverflowed == true)

        // The stream should now be finished — the iterator yields whatever was queued before
        // overflow fired and then ends.
        var received = 0
        for await _ in outbox.stream {
            received += 1
            if received > watermark + 2 { break }
        }
        // We may receive 0...watermark frames depending on when overflow tripped, but the
        // stream must terminate cleanly without us breaking out.
        #expect(received <= watermark)
    }

    @Test func `recordWrite decrements inflight so steady-state senders don't overflow`() {
        let watermark = 2
        let outbox = ConnectionOutbox(highWatermark: watermark)
        // Push the queue up to the watermark without draining anything.
        outbox.send(Data([1]))
        outbox.send(Data([2]))
        #expect(outbox.isOverflowed == false)
        // One drain before the next send must keep us below the watermark.
        outbox.recordWrite()
        outbox.send(Data([3]))
        #expect(outbox.isOverflowed == false)
        // Sending one more without draining trips overflow — this is the regression sentinel
        // for `recordWrite` actually decrementing the counter.
        outbox.send(Data([4]))
        #expect(outbox.isOverflowed == true)
    }

    @Test func `finish closes the outbox idempotently`() async {
        let outbox = ConnectionOutbox(highWatermark: 1024)
        outbox.send(Data([1]))
        outbox.finish()
        outbox.finish()
        var received = 0
        for await _ in outbox.stream {
            received += 1
        }
        #expect(received == 1)
    }
}
