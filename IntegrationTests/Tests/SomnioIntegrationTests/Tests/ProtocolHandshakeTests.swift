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
                        guard case let .binary(buffer) = message else { continue }
                        let frame = Data(buffer: buffer)
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

    @Test func `server closes connection on unrecognized tag byte`() async throws {
        try await assertProtocolErrorClose(payload: [0xFF, 0, 0, 0, 0])
    }

    @Test func `server closes connection on truncated frame header`() async throws {
        try await assertProtocolErrorClose(payload: [0x00, 0x01])
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

    private func assertProtocolErrorClose(payload: [UInt8]) async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.handshake.malformed")
            let rig = try await WSGameplayClient.makeApplication(client: client, logger: logger)
            let observedClose = CloseRecorder()
            try await rig.application.test(.live) { testClient in
                let closeFrame = try await testClient.ws("/ws", configuration: WSGameplayClient.wsConfig(), logger: logger) { inbound, outbound, _ in
                    try await outbound.write(.binary(ByteBuffer(bytes: payload)))
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
            #expect(received == .protocolError, "expected .protocolError, got \(String(describing: received))")
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
        let frame = try BinaryEncoder().encode(AdminRequest.players)
        try await client.ws("/admin", configuration: configuration, logger: logger) { inbound, outbound, _ in
            try await outbound.write(.binary(ByteBuffer(data: frame)))
            for try await message in inbound.messages(maxSize: SomnioProtocolConstants.maxWireFrameSize) {
                if case let .binary(buffer) = message {
                    let decoded = try BinaryDecoder().decode(AdminResponse.self, from: Data(buffer: buffer))
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
