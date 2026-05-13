import Foundation
import HTTPTypes
import Hummingbird
import HummingbirdTesting
import HummingbirdWSClient
import HummingbirdWSTesting
import Logging
import NIOCore
import SomnioProtocol
import SomnioTestSupport
import Testing
@testable import SomnioServerCore

struct AdminAuthGateTests {
    // MARK: - constantTimeEquals

    @Test func `constantTimeEquals matches identical strings`() {
        #expect(constantTimeEquals("Bearer secret", "Bearer secret"))
    }

    @Test func `constantTimeEquals rejects different strings of the same length`() {
        #expect(constantTimeEquals("Bearer secret", "Bearer sekret") == false)
    }

    @Test func `constantTimeEquals rejects different lengths`() {
        #expect(constantTimeEquals("Bearer secret", "Bearer secretX") == false)
        #expect(constantTimeEquals("Bearer secret", "") == false)
    }

    @Test func `constantTimeEquals folds the length flag so a zero padded prefix still fails`() {
        // The folded length-mismatch flag is the regression sentinel: without it, a prefix
        // match against the secret followed by implicit zero bytes (the shorter side's
        // missing bytes are treated as `0`) would silently pass.
        let prefix = "Bearer sec"
        let secret = "Bearer secret"
        #expect(constantTimeEquals(prefix, secret) == false)
        #expect(constantTimeEquals(secret, prefix) == false)
    }

    @Test func `constantTimeEquals matches empty against empty`() {
        #expect(constantTimeEquals("", ""))
    }

    // MARK: - /admin upgrade

    @Test func `/admin upgrade is rejected when the Authorization header is missing`() async throws {
        try await withAdminApplication { _, client in
            try await assertUpgradeFails(client: client, headers: [:])
        }
    }

    @Test func `/admin upgrade is rejected when the bearer token is wrong`() async throws {
        try await withAdminApplication { _, client in
            try await assertUpgradeFails(client: client, headers: [.authorization: "Bearer wrong"])
        }
    }

    @Test func `/admin upgrade is rejected when the scheme is missing`() async throws {
        try await withAdminApplication { _, client in
            try await assertUpgradeFails(client: client, headers: [.authorization: "secret"])
        }
    }

    @Test func `/admin upgrade succeeds with the configured bearer token and runs the dispatcher`() async throws {
        try await withAdminApplication { stubRouter, client in
            await stubRouter.setPlayerCount(3)
            var configuration = WebSocketClientConfiguration()
            configuration.additionalHeaders[.authorization] = "Bearer secret"
            configuration.maxFrameSize = Int(SomnioProtocolConstants.maxFrameLength) + 5

            let frame = try BinaryEncoder().encode(AdminRequest.players)
            let response = ResponseSlot()
            try await client.ws(
                "/admin",
                configuration: configuration,
                logger: Logger(label: "test.admin.upgrade.client")
            ) { inbound, outbound, _ in
                try await outbound.write(.binary(ByteBuffer(data: frame)))
                for try await message in inbound.messages(maxSize: Int(SomnioProtocolConstants.maxFrameLength) + 5) {
                    if case let .binary(buffer) = message {
                        let decoded = try BinaryDecoder().decode(AdminResponse.self, from: Data(buffer: buffer))
                        await response.set(decoded)
                        try await outbound.close(.normalClosure, reason: nil)
                        return
                    }
                }
            }
            let observed = await response.take()
            #expect(observed == .playerCount(text: "3"))
        }
    }

    // MARK: - Helpers

    private func withAdminApplication(
        _ body: @Sendable (StubAdminWorldRouter, any TestClientProtocol) async throws -> Void
    ) async throws {
        let stubRouter = StubAdminWorldRouter()
        let dependencies = try await AdminRouteTestApplication.makeDependencies(worldRouter: stubRouter)
        let application = AdminRouteTestApplication.make(adminToken: "secret", adminDependencies: dependencies)
        try await application.test(.live) { client in
            try await body(stubRouter, client)
        }
    }

    private func assertUpgradeFails(client: any TestClientProtocol, headers: HTTPFields) async throws {
        var configuration = WebSocketClientConfiguration()
        configuration.additionalHeaders = headers
        do {
            try await client.ws(
                "/admin",
                configuration: configuration,
                logger: Logger(label: "test.admin.upgrade.reject")
            ) { _, _, _ in
                Issue.record("the handler must not run when the upgrade is rejected")
            }
            Issue.record("upgrade should have thrown")
        } catch {
            // Expected: server returns a non-101 response (Hummingbird responds with 405).
        }
    }
}

/// Tiny sendable slot used by the success-path test to ferry the decoded admin response
/// out of the `@Sendable` WS handler closure.
private actor ResponseSlot {
    private var value: AdminResponse?

    func set(_ response: AdminResponse) {
        value = response
    }

    func take() -> AdminResponse? {
        let captured = value
        value = nil
        return captured
    }
}
