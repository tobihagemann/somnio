import Foundation
import Hummingbird
import HummingbirdWSClient
import Logging
import NIOCore
import NIOWebSocket
import SomnioProtocol
import SomnioTestSupport
import Testing
@testable import SomnioServerCore

/// Live `/ws` coverage for the drain-before-close exit and the framing close-branches that the
/// `private` `handleInboundMessage` owns. The functional drain test verifies every queued frame
/// reaches the client before the close (and that the drain-then-close sequence is actually
/// wired — a `finish`↔`await-writer` reorder would deadlock to timeout). The framing tests
/// verify a binary / malformed-JSON / unknown-tag inbound frame each closes with
/// `.protocolError`. The adversarial step-3↔4 ordering is covered deterministically by
/// `ConnectionActorDrainOrderingTests`; a live socket can't discriminate that reorder.
struct ConnectionActorDrainTests {
    @Test func `runConnection drains every queued frame before closing the gameplay socket`() async throws {
        let frameCount = 16
        let preseed = try (0 ..< frameCount).map { index in
            try SomnioMessageEncoder.encode(.dateTick(DateTickMessage(hour: Int16(index % 24), minute: 0)))
        }
        let dependencies = try await makeStubConnectionDependencies()
        let app = GameplayWSDrainTestApplication.make(dependencies: dependencies, preseed: preseed)
        let collector = FrameCollector()

        try await withLiveServer(app) { client in
            var configuration = WebSocketClientConfiguration()
            configuration.maxFrameSize = SomnioProtocolConstants.maxWireFrameSize
            let closeFrame = try await client.ws(
                "/ws",
                configuration: configuration,
                logger: Logger(label: "test.ws.drain.client")
            ) { inbound, outbound, _ in
                // A binary frame is not part of the wire protocol, so it drives the
                // server-side close after the queued frames have drained.
                try await outbound.write(.binary(ByteBuffer(string: "x")))
                for try await message in inbound.messages(maxSize: SomnioProtocolConstants.maxWireFrameSize) {
                    if case let .text(string) = message {
                        await collector.append(string)
                    }
                }
            }
            #expect(closeFrame?.closeCode == .protocolError)
        }

        // Every preseeded frame plus the actor's `Hello` must have reached the client before
        // the close. Decode the received frames and assert the multiset is exactly the N
        // dateTicks + one Hello — order-insensitive (the spy test owns ordering), but stronger
        // than a bare count, so a dropped preseed paired with a duplicated Hello can't pass.
        let received = await collector.frames
        #expect(received.count == frameCount + 1)
        let decoded = try received.map { try SomnioMessageDecoder.decode(Data($0.utf8)) }
        var helloCount = 0
        var tickHours: [Int16] = []
        for message in decoded {
            if case .hello = message {
                helloCount += 1
            } else if case let .dateTick(payload) = message {
                tickHours.append(payload.hour)
            } else {
                Issue.record("unexpected frame on the wire: \(message)")
            }
        }
        #expect(helloCount == 1)
        #expect(tickHours.sorted() == Array(0 ..< Int16(frameCount)))
    }

    @Test(arguments: [FramingTrigger.binary, .malformedJSON, .unknownTag])
    func `a malformed gameplay frame closes the socket with protocolError`(_ trigger: FramingTrigger) async throws {
        let dependencies = try await makeStubConnectionDependencies()
        let app = GameplayWSDrainTestApplication.make(dependencies: dependencies, preseed: [])

        try await withLiveServer(app) { client in
            var configuration = WebSocketClientConfiguration()
            configuration.maxFrameSize = SomnioProtocolConstants.maxWireFrameSize
            let closeFrame = try await client.ws(
                "/ws",
                configuration: configuration,
                logger: Logger(label: "test.ws.framing.client")
            ) { inbound, outbound, _ in
                try await outbound.write(trigger.frame)
                for try await _ in inbound.messages(maxSize: SomnioProtocolConstants.maxWireFrameSize) {
                    // Drain until the server-driven close ends the stream.
                }
            }
            #expect(closeFrame?.closeCode == .protocolError)
        }
    }
}

/// The three framing close-branches `handleInboundMessage` rejects: a binary frame, a
/// well-formed text frame that isn't valid JSON, and a valid-JSON frame carrying an
/// unrecognized tag.
enum FramingTrigger: CustomTestStringConvertible {
    case binary
    case malformedJSON
    case unknownTag

    var frame: WebSocketOutboundWriter.OutboundFrame {
        switch self {
        case .binary:
            .binary(ByteBuffer(string: "x"))
        case .malformedJSON:
            .text("this is not json")
        case .unknownTag:
            .text(#"{"tag":"bogusTag","payload":{}}"#)
        }
    }

    var testDescription: String {
        switch self {
        case .binary: "binary frame"
        case .malformedJSON: "malformed JSON text frame"
        case .unknownTag: "unknown-tag text frame"
        }
    }
}

/// Sendable collector ferrying decoded text frames out of the `@Sendable` WS handler closure.
private actor FrameCollector {
    private(set) var frames: [String] = []

    func append(_ frame: String) {
        frames.append(frame)
    }
}
