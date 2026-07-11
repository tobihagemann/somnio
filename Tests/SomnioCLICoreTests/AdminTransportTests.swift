import Foundation
import HTTPTypes
import Hummingbird
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

/// Lives in the CLI tests but stands up a tiny server-side WS endpoint via the
/// `withLiveServer` helper so we can drive `AdminTransport.send` end-to-end across the
/// process boundary. Covers the `AdminTransportError` branches reachable in a debug build.
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
        try await withLiveServer(app) { client in
            let url = "ws://localhost:\(client.port)/admin"
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

    @Test func `send surfaces decodeFailed carrying the underlying typed DecodingError`() async throws {
        // Asserts both the case tag and the payload: flattening the typed `Error` back to
        // a string would slip past the tag-only matcher.
        let app = Self.makeMalformedFrameApplication(token: token)
        try await withLiveServer(app) { client in
            let url = "ws://localhost:\(client.port)/admin"
            do {
                _ = try await AdminTransport.send(
                    .players,
                    to: url,
                    token: token,
                    logger: Logger(label: "test.transport.malformed")
                )
                Issue.record("expected decodeFailed")
            } catch let AdminTransportError.decodeFailed(underlying) {
                #expect(underlying is DecodingError)
            } catch {
                Issue.record("expected decodeFailed, got \(error)")
            }
        }
    }

    @Test func `send surfaces noResponse when the server closes without sending a frame`() async throws {
        let app = Self.makeSilentApplication(token: token)
        try await withLiveServer(app) { client in
            let url = "ws://localhost:\(client.port)/admin"
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

    @Test func `send rejects a validate-passing but host-disagreeing URL before dialing`() async {
        // `wss://ex%41mple.com/admin` clears `SecureTransportValidator` (wss, remote host)
        // but the host the dialer would parse disagrees with the validated host, so the
        // public `send` entrypoint must fail closed via the `dialableURL` gate rather than
        // open a socket. Guards against `send` no longer calling the gate.
        await Self.expectTransportError(.invalidTransportURL) {
            try await AdminTransport.send(
                .players,
                to: "wss://ex%41mple.com/admin",
                token: token,
                logger: Logger(label: "test.transport.host-disagreement")
            )
        }
    }

    @Test func `resolveTLS maps skipPinning to no TLS configuration`() throws {
        let resolved = try AdminTransport.resolveTLS(.skipPinning, logger: Logger(label: "test.transport.tls"))
        #expect(resolved == nil)
    }

    @Test func `resolveTLS surfaces a pinned configuration`() throws {
        let pinned = try AdminServerTrust.makePinnedConfiguration(fromPEM: adminProductionTrustRootPEM)
        let resolved = try AdminTransport.resolveTLS(.pinned(pinned), logger: Logger(label: "test.transport.tls"))
        #expect(resolved != nil)
    }

    @Test func `resolveTLS fails closed with pinningRefused on a refused pin`() {
        do {
            _ = try AdminTransport.resolveTLS(.refused(reason: "bad pem"), logger: Logger(label: "test.transport.tls"))
            Issue.record("expected pinningRefused")
        } catch let AdminTransportError.pinningRefused(reason) {
            #expect(reason == "bad pem")
        } catch {
            Issue.record("expected pinningRefused, got \(error)")
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
        case pinningRefused
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
            case .pinningRefused: .pinningRefused
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
        try await withLiveServer(application) { client in
            try await body("ws://localhost:\(client.port)/admin")
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
