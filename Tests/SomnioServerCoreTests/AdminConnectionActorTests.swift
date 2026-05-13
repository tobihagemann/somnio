import Foundation
import HummingbirdWebSocket
import Logging
import NIOCore
import SomnioCore
import SomnioProtocol
import SomnioTestSupport
import Testing
@testable import SomnioServerCore

struct AdminConnectionActorTests {
    @Test func `unrecognized tag yields write unknownCommand and keeps loop open`() async throws {
        let dependencies = try await makeAdminDependencies()
        let outcome = await AdminConnectionActor.process(
            .binary(ByteBuffer(bytes: [0xFF])),
            dependencies: dependencies
        )
        #expect(outcome == .write(.unknownCommand))
    }

    @Test func `well formed players request yields write playerCount`() async throws {
        let dependencies = try await makeAdminDependencies()
        let frame = try BinaryEncoder().encode(AdminRequest.players)
        let outcome = await AdminConnectionActor.process(
            .binary(ByteBuffer(data: frame)),
            dependencies: dependencies
        )
        guard case let .write(response) = outcome else {
            Issue.record("expected .write outcome, got \(String(describing: outcome))")
            return
        }
        if case let .playerCount(text) = response {
            #expect(text == "0")
        } else {
            Issue.record("expected .playerCount, got \(String(describing: response))")
        }
    }

    @Test func `truncated say payload closes with protocolError`() async throws {
        let dependencies = try await makeAdminDependencies()
        // Tag 4 == .say(text:), then a length-prefix-truncated body.
        let outcome = await AdminConnectionActor.process(
            .binary(ByteBuffer(bytes: [0x04, 0x05])),
            dependencies: dependencies
        )
        guard case let .closeProtocolError(reason) = outcome else {
            Issue.record("expected .closeProtocolError, got \(String(describing: outcome))")
            return
        }
        #expect(reason == "frame validation failed")
    }

    @Test func `text frame closes with protocolError`() async throws {
        let dependencies = try await makeAdminDependencies()
        let outcome = await AdminConnectionActor.process(
            .text("anything"),
            dependencies: dependencies
        )
        guard case .closeProtocolError = outcome else {
            Issue.record("expected .closeProtocolError, got \(String(describing: outcome))")
            return
        }
    }

    // MARK: - Helpers

    private func makeAdminDependencies() async throws -> AdminConnectionDependencies {
        try await AdminRouteTestApplication.makeDependencies(worldRouter: StubAdminWorldRouter())
    }
}
