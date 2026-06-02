import Foundation
import HTTPTypes
import Hummingbird
import HummingbirdTesting
import HummingbirdWebSocket
import HummingbirdWSClient
import Logging
import NIOCore
import NIOFoundationCompat
import SomnioProtocol
import SomnioTestSupport
import Testing
@testable import SomnioCLICore
@testable import SomnioServerCore

/// Lives in the CLI tests but stands up a tiny server-side WS endpoint via Hummingbird's
/// `.test(.live)` helper so we can drive `AdminTransport.send` end-to-end across the
/// process boundary. Covers the five `AdminTransportError` branches.
struct AdminTransportTests {
    private let token = "secret"

    @Test func `send returns the dispatcher's decoded AdminResponse on the happy path`() async throws {
        let stubRouter = StubAdminWorldRouter()
        await stubRouter.setPlayerCount(11)
        try await withAdminServer(router: stubRouter) { url in
            let response = try await AdminTransport.send(
                .players,
                to: url,
                token: token,
                logger: Logger(label: "test.transport.success")
            )
            #expect(response == .playerCount(text: "11"))
        }
    }

    @Test func `send rejects an unexpected binary frame from the server`() async throws {
        let app = Self.makeBinaryFrameApplication(token: token)
        try await app.test(.live) { client in
            guard let port = client.port else {
                Issue.record("test client has no port; live framework misconfigured")
                return
            }
            let url = "ws://localhost:\(port)/admin"
            await Self.expectTransportError(.unexpectedBinaryFrame) {
                try await AdminTransport.send(
                    .players,
                    to: url,
                    token: token,
                    logger: Logger(label: "test.transport.binary")
                )
            }
        }
    }

    @Test func `send surfaces decodeFailed when the server returns a malformed text frame`() async throws {
        let app = Self.makeMalformedFrameApplication(token: token)
        try await app.test(.live) { client in
            guard let port = client.port else {
                Issue.record("test client has no port; live framework misconfigured")
                return
            }
            let url = "ws://localhost:\(port)/admin"
            await Self.expectTransportError(.decodeFailed) {
                try await AdminTransport.send(
                    .players,
                    to: url,
                    token: token,
                    logger: Logger(label: "test.transport.malformed")
                )
            }
        }
    }

    @Test func `send surfaces noResponse when the server closes without sending a frame`() async throws {
        let app = Self.makeSilentApplication(token: token)
        try await app.test(.live) { client in
            guard let port = client.port else {
                Issue.record("test client has no port; live framework misconfigured")
                return
            }
            let url = "ws://localhost:\(port)/admin"
            await Self.expectTransportError(.noResponse) {
                try await AdminTransport.send(
                    .players,
                    to: url,
                    token: token,
                    logger: Logger(label: "test.transport.noresponse")
                )
            }
        }
    }

    @Test func `send surfaces connectFailed when the server is unreachable`() async {
        // Port 1 is reserved (TCPMUX); connecting fails fast on every platform.
        await Self.expectTransportError(.connectFailed) {
            try await AdminTransport.send(
                .players,
                to: "ws://127.0.0.1:1/admin",
                token: token,
                logger: Logger(label: "test.transport.connect")
            )
        }
    }

    @Test(arguments: [
        // Each entry exercises one `SecureTransportValidationError` variant that the
        // public `AdminTransport.send` gate must reject before opening a WebSocket.
        "ws://attacker@localhost:8080/admin", // userinfo present
        "WSS://localhost/admin", // uppercase scheme (case-sensitive TLS gate)
        "ws://example.com/admin", // plaintext to a remote host
        "" // unparseable URL
    ])
    func `send rejects URLs that fail the secure transport gate`(rawURL: String) async {
        await Self.expectTransportError(.invalidTransportURL) {
            try await AdminTransport.send(
                .players,
                to: rawURL,
                token: token,
                logger: Logger(label: "test.transport.invalid-url")
            )
        }
    }

    // MARK: - Error-case matcher

    /// Tag used by `expectTransportError(_:)` to match an `AdminTransportError` variant
    /// without unwrapping the associated `Error` payload (which doesn't conform to
    /// `Equatable`, so `#expect(throws:)` can't pin the case directly).
    enum ErrorCase {
        case noResponse
        case unexpectedBinaryFrame
        case encodeFailed
        case decodeFailed
        case connectFailed
        case invalidTransportURL
    }

    private static func expectTransportError(
        _ expected: ErrorCase,
        sourceLocation: SourceLocation = #_sourceLocation,
        performing body: () async throws -> Void
    ) async {
        do {
            try await body()
            Issue.record("expected AdminTransportError.\(expected)", sourceLocation: sourceLocation)
        } catch let error as AdminTransportError {
            let observed: ErrorCase = switch error {
            case .noResponse: .noResponse
            case .unexpectedBinaryFrame: .unexpectedBinaryFrame
            case .encodeFailed: .encodeFailed
            case .decodeFailed: .decodeFailed
            case .connectFailed: .connectFailed
            case .invalidTransportURL: .invalidTransportURL
            }
            #expect(observed == expected, "expected \(expected), got \(observed)", sourceLocation: sourceLocation)
        } catch {
            Issue.record("expected AdminTransportError.\(expected), got \(error)", sourceLocation: sourceLocation)
        }
    }

    // MARK: - Server fixtures

    private func withAdminServer(
        router stubRouter: StubAdminWorldRouter,
        _ body: @Sendable (String) async throws -> Void
    ) async throws {
        let dependencies = try await AdminRouteTestApplication.makeDependencies(worldRouter: stubRouter)
        let application = AdminRouteTestApplication.make(adminToken: token, adminDependencies: dependencies)
        try await application.test(.live) { client in
            guard let port = client.port else {
                Issue.record("test client has no port; live framework misconfigured")
                return
            }
            try await body("ws://localhost:\(port)/admin")
        }
    }

    private static func makeBinaryFrameApplication(token: String) -> some ApplicationProtocol {
        makeApplication(token: token) { _, outbound in
            try? await outbound.write(.binary(ByteBuffer(bytes: [0x00])))
        }
    }

    private static func makeMalformedFrameApplication(token: String) -> some ApplicationProtocol {
        makeApplication(token: token) { _, outbound in
            // Not valid JSON, so the client's `JSONDecoder().decode(AdminResponse.self, ...)`
            // throws and `AdminTransport.send` surfaces `.decodeFailed`.
            try? await outbound.write(.text("not json"))
        }
    }

    private static func makeSilentApplication(token: String) -> some ApplicationProtocol {
        makeApplication(token: token) { _, _ in
            // Close immediately without writing.
        }
    }

    private static func makeApplication(
        token: String,
        handler: @Sendable @escaping (WebSocketInboundStream, WebSocketOutboundWriter) async throws -> Void
    ) -> some ApplicationProtocol {
        let router = Router(context: BasicWebSocketRequestContext.self)
        let bearer = "Bearer \(token)"
        let logger = Logger(label: "test.admin.transport.fixture")
        router.ws("/admin") { request, _ -> RouterShouldUpgrade in
            let header = request.headers[.authorization] ?? ""
            guard header == bearer else {
                logger.warning("rejected /admin upgrade", metadata: ["reason": "missing_or_bad_token"])
                return .dontUpgrade
            }
            return .upgrade([:])
        } onUpgrade: { inbound, outbound, _ in
            try? await handler(inbound, outbound)
        }
        let webSocketConfiguration = WebSocketServerConfiguration(
            maxFrameSize: SomnioProtocolConstants.maxWireFrameSize
        )
        return Application(
            router: router,
            server: .http1WebSocketUpgrade(
                webSocketRouter: router,
                configuration: webSocketConfiguration
            ),
            configuration: ApplicationConfiguration(address: .hostname("127.0.0.1", port: 0)),
            logger: logger
        )
    }
}
