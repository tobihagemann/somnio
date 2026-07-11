import Foundation
import HTTPTypes
import Hummingbird
import HummingbirdWSClient
import Logging
import NIOCore
import NIOWebSocket
import SomnioProtocol
import SomnioTestSupport
import Testing
@testable import SomnioServerCore

struct AdminConnectionActorReadLoopTests {
    @Test func `a malformed frame sequence closes the admin socket via the read-loop catch`() async throws {
        let stubRouter = StubAdminWorldRouter()
        let dependencies = try await AdminRouteTestApplication.makeDependencies(worldRouter: stubRouter)
        let application = AdminRouteTestApplication.make(adminToken: "secret", adminDependencies: dependencies)

        try await withLiveServer(application) { client in
            var configuration = WebSocketClientConfiguration()
            configuration.additionalHeaders[.authorization] = "Bearer secret"
            configuration.maxFrameSize = SomnioProtocolConstants.maxWireFrameSize

            let closeFrame = try await client.ws(
                "/admin",
                configuration: configuration,
                logger: Logger(label: "test.admin.readloop.client")
            ) { inbound, outbound, _ in
                // A bare continuation frame violates RFC 6455 fragmentation sequencing, so
                // swift-websocket's `nextMessage` throws past the inbound stream's internal
                // error handling and surfaces in `runConnection`'s outer `catch`. A single
                // oversized frame would not: the WebSocket layer closes it with
                // `.messageTooLarge` before the read loop sees a throw.
                let continuationFrame = WebSocketFrame(fin: true, opcode: .continuation, data: ByteBuffer(string: "x"))
                try await outbound.write(.custom(continuationFrame))
                for try await _ in inbound.messages(maxSize: SomnioProtocolConstants.maxWireFrameSize) {
                    // Drain until the server-driven close ends the stream.
                }
            }

            // The `reason` distinguishes the outer read-loop catch from an inner `process`
            // close (which uses reasons like "frame validation failed").
            #expect(closeFrame?.closeCode == .protocolError)
            #expect(closeFrame?.reason == "read loop error")
        }
    }
}
