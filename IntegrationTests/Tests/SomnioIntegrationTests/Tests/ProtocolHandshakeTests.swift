import Foundation
import HTTPTypes
import Hummingbird
import HummingbirdTesting
import HummingbirdWebSocket
import HummingbirdWSClient
import HummingbirdWSTesting
import Logging
import NIOCore
import NIOWebSocket
import SomnioProtocol
import SomnioServerCore
import Testing

@Suite(.requiresContainerRuntime)
struct ProtocolHandshakeTests {
    @Test func `server sends Hello frame with current protocol version on connect`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.handshake.hello")
            let rig = try await WSGameplayClient.makeApplication(client: client, logger: logger)
            let helloSlot = HelloSlot()
            try await rig.application.test(.live) { testClient in
                _ = try await testClient.ws("/ws", configuration: WSGameplayClient.wsConfig(), logger: logger) { inbound, outbound, _ in
                    for try await message in inbound.messages(maxSize: SomnioProtocolConstants.maxWireFrameSize) {
                        guard case let .text(string) = message else { continue }
                        let frame = Data(string.utf8)
                        if let hello = IntegrationTestFixtures.helloPayload(of: frame) {
                            await helloSlot.set(hello)
                            try await outbound.close(.normalClosure, reason: nil)
                            return
                        }
                    }
                }
            }
            let hello = try #require(await helloSlot.value())
            #expect(hello.protocolVersion == SomnioProtocolConstants.helloVersion)
        }
    }

    @Test func `server closes connection on unrecognized tag`() async throws {
        try await assertProtocolErrorClose { try await $0.write(.text(#"{"tag":"notAVerb","payload":{}}"#)) }
    }

    @Test func `server closes connection on malformed JSON`() async throws {
        try await assertProtocolErrorClose { try await $0.write(.text("{ not json")) }
    }

    @Test func `server closes connection on a binary frame`() async throws {
        // Binary frames are no longer part of the wire protocol; the gameplay socket must
        // reject one with a protocol-error close, mirroring the admin socket.
        try await assertProtocolErrorClose { try await $0.write(.binary(ByteBuffer(bytes: [0x00]))) }
    }

    @Test func `server closes connection on a recognized tag with a malformed payload`() async throws {
        // A known verb whose payload omits required fields fails `SomnioMessageDecoder.decode`
        // with a `DecodingError` — a distinct branch from the unrecognized-tag rejection.
        try await assertProtocolErrorClose { try await $0.write(.text(#"{"tag":"clientPosition","payload":{}}"#)) }
    }

    @Test func `server closes connection on a zero-byte text frame`() async throws {
        try await assertProtocolErrorClose { try await $0.write(.text("")) }
    }

    @Test func `server closes connection on a frame larger than the wire size cap`() async throws {
        // A message past `maxWireFrameSize` trips the WebSocket layer's reassembly guard with
        // `.messageTooLarge` before the decoder runs — the slack above the encoder's
        // `maxFrameLength` is what keeps a legitimately-sized frame from hitting this.
        let oversized = String(repeating: "a", count: SomnioProtocolConstants.maxWireFrameSize + 16)
        try await assertServerClose(expected: .messageTooLarge) { try await $0.write(.text(oversized)) }
    }

    @Test func `admin upgrade requires Authorization Bearer header`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.handshake.admin")
            let rig = try await WSGameplayClient.makeApplication(client: client, logger: logger)
            try await rig.application.test(.live) { testClient in
                try await assertAdminUpgradeFails(client: testClient, headers: [:], logger: logger)
                try await assertAdminUpgradeFails(client: testClient, headers: [.authorization: "Bearer wrong-token"], logger: logger)
                try await runAdminUpgradeSucceeds(client: testClient, logger: logger)
            }
        }
    }

    // MARK: - Helpers

    private func assertProtocolErrorClose(
        send: @Sendable @escaping (WebSocketOutboundWriter) async throws -> Void
    ) async throws {
        try await assertServerClose(expected: .protocolError, send: send)
    }

    private func assertServerClose(
        expected: WebSocketErrorCode,
        send: @Sendable @escaping (WebSocketOutboundWriter) async throws -> Void
    ) async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.handshake.malformed")
            let rig = try await WSGameplayClient.makeApplication(client: client, logger: logger)
            let observedClose = CloseRecorder()
            try await rig.application.test(.live) { testClient in
                let closeFrame = try await testClient.ws("/ws", configuration: WSGameplayClient.wsConfig(), logger: logger) { inbound, outbound, _ in
                    try await send(outbound)
                    for try await _ in inbound.messages(maxSize: SomnioProtocolConstants.maxWireFrameSize) {
                        // Drain inbound (Hello, then anything else) until the server-driven
                        // close ends the stream.
                    }
                }
                if let observed = closeFrame {
                    await observedClose.set(observed.closeCode)
                }
            }
            let received = await observedClose.value()
            #expect(received == expected, "expected \(expected), got \(String(describing: received))")
        }
    }

    private func assertAdminUpgradeFails(
        client: any TestClientProtocol,
        headers: HTTPFields,
        logger: Logger
    ) async throws {
        var configuration = WebSocketClientConfiguration()
        configuration.additionalHeaders = headers
        do {
            _ = try await client.ws("/admin", configuration: configuration, logger: logger) { _, _, _ in
                Issue.record("admin upgrade should have been rejected")
            }
            Issue.record("admin upgrade should have thrown")
        } catch {
            // Expected: server returns a non-101 response (Hummingbird responds with 405).
        }
    }

    private func runAdminUpgradeSucceeds(client: any TestClientProtocol, logger: Logger) async throws {
        var configuration = WebSocketClientConfiguration()
        configuration.additionalHeaders[.authorization] = "Bearer test"
        configuration.maxFrameSize = SomnioProtocolConstants.maxWireFrameSize
        let responseSlot = AdminResponseSlot()
        let frame = try JSONEncoder().encode(AdminRequest.players)
        try await client.ws("/admin", configuration: configuration, logger: logger) { inbound, outbound, _ in
            try await outbound.write(.text(String(decoding: frame, as: UTF8.self)))
            for try await message in inbound.messages(maxSize: SomnioProtocolConstants.maxWireFrameSize) {
                if case let .text(string) = message {
                    let decoded = try JSONDecoder().decode(AdminResponse.self, from: Data(string.utf8))
                    await responseSlot.set(decoded)
                    try await outbound.close(.normalClosure, reason: nil)
                    return
                }
            }
        }
        let observed = try #require(await responseSlot.value())
        guard case let .playerCount(text) = observed else {
            Issue.record("expected .playerCount, got \(observed)")
            return
        }
        #expect(text == "0")
    }
}

private typealias HelloSlot = FirstWriteSlot<HelloMessage>
private typealias AdminResponseSlot = FirstWriteSlot<AdminResponse>
