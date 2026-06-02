// TLS is terminated by the deployment proxy in production. The server listens plain
// HTTP/WS; the docker-compose example pins the proxy contract.

import Foundation
import HTTPTypes
import Hummingbird
import HummingbirdCore
import HummingbirdWebSocket
import Logging
import PostgresNIO
import SomnioProtocol

/// `/health` response body. Codable-shaped so `Application` can encode it via the default
/// `JSONResponseEncoder`. `db` is `"ok"` on success and `"unreachable"` on probe failure.
/// Properties are read by the synthesized `Encodable` conformance, which Periphery can't
/// see directly.
struct HealthResponse: ResponseEncodable {
    // periphery:ignore
    let status: String
    // periphery:ignore
    let db: String
}

/// Build the gameplay-server `Application`:
///
/// - `/ws` — gameplay route. Bare-closure form; the connection actor takes the inbound +
///   outbound and drives the lifecycle.
/// - `/admin` — admin route. Pre-upgrade `Authorization: Bearer <token>` gate so the
///   upgrade is rejected with `405 Method Not Allowed` *before* HTTP 101 — a post-upgrade
///   `outbound.close(.policyViolation)` would briefly establish the admin connection.
///   The token comparison runs in constant time so a network attacker can't recover the
///   secret byte-by-byte by measuring response latency.
/// - `GET /health` — unauthenticated readiness probe; runs `SELECT 1` and returns
///   `200 {"status":"ok","db":"ok"}` on success or `503 {"status":"degraded","db":"unreachable"}`
///   when the probe throws (any error, not just `PSQLError`, so a tripped connection-pool
///   circuit breaker maps to 503 instead of 500).
public func makeSomnioServerApplication(
    configuration: ServerConfiguration,
    postgres: PostgresClient,
    dependencies: ConnectionDependencies,
    adminDependencies: AdminConnectionDependencies,
    onServerRunning: (@Sendable (any Channel) async -> Void)? = nil
) -> Application<RouterResponder<BasicWebSocketRequestContext>> {
    let router = Router(context: BasicWebSocketRequestContext.self)
    let healthLogger = Logger(label: "de.tobiha.somnio.server.gameplay.health")

    router.ws("/ws") { inbound, outbound, _ in
        let actor = ConnectionActor(dependencies: dependencies)
        await actor.runConnection(inbound: inbound, outbound: outbound)
    }

    mountAdminRoute(on: router, adminToken: configuration.adminToken, adminDependencies: adminDependencies)

    router.get("/health") { _, _ -> EditedResponse<HealthResponse> in
        do {
            _ = try await postgres.query("SELECT 1", logger: healthLogger)
            return EditedResponse(status: .ok, response: HealthResponse(status: "ok", db: "ok"))
        } catch {
            healthLogger.warning("health probe failed", metadata: ["error": "\(error)"])
            return EditedResponse(
                status: .serviceUnavailable,
                response: HealthResponse(status: "degraded", db: "unreachable")
            )
        }
    }

    let applicationConfiguration = ApplicationConfiguration(
        address: .hostname(configuration.httpHost, port: configuration.httpPort),
        serverName: "Somnio"
    )
    // Match the WebSocket frame ceiling to the protocol decoder so legitimate large frames
    // are not rejected by the WS layer before they reach `SomnioMessageDecoder`. The default
    // (`1 << 14` = 16 KiB) is far below the protocol's 1 MiB limit. Frames are JSON over text
    // frames; `maxWireFrameSize` keeps a small slack above `maxFrameLength` so an oversized
    // message trips the encoder's `oversizedFrame` guard rather than this hard ceiling.
    let webSocketConfiguration = WebSocketServerConfiguration(
        maxFrameSize: SomnioProtocolConstants.maxWireFrameSize
    )
    // Hummingbird stores `onServerRunning` privately at init, so it can't be retrofitted
    // after construction. Tests pass an `onServerRunning:` closure to read the bound port
    // when binding to port 0; production calls leave the parameter `nil` and the no-op
    // default matches Hummingbird's own initializer default.
    return Application(
        router: router,
        server: .http1WebSocketUpgrade(
            webSocketRouter: router,
            configuration: webSocketConfiguration
        ),
        configuration: applicationConfiguration,
        onServerRunning: onServerRunning ?? { _ in },
        logger: Logger(label: "de.tobiha.somnio.server.gameplay.app")
    )
}

/// Wire the `/admin` WebSocket route onto an existing router. Extracted so test fixtures
/// can mount the same gate + dispatch shape on a minimal router without standing up the
/// full Postgres-backed gameplay application.
public func mountAdminRoute(
    on router: some RouterMethods<some WebSocketRequestContext>,
    adminToken: String,
    adminDependencies: AdminConnectionDependencies
) {
    let adminBearer = "Bearer \(adminToken)"
    let adminLogger = Logger(label: "de.tobiha.somnio.server.admin.connection")
    router.ws("/admin") { request, _ -> RouterShouldUpgrade in
        let header = request.headers[.authorization] ?? ""
        guard constantTimeEquals(header, adminBearer) else {
            adminLogger.warning("rejected /admin upgrade", metadata: ["reason": "missing_or_bad_token"])
            return .dontUpgrade
        }
        return .upgrade([:])
    } onUpgrade: { inbound, outbound, _ in
        let actor = AdminConnectionActor(dependencies: adminDependencies)
        await actor.runConnection(inbound: inbound, outbound: outbound)
    }
}

/// Constant-time string comparison so the admin token can't be recovered byte-by-byte by
/// timing the response. The loop walks `max(lhs.count, rhs.count)` bytes, treating the
/// shorter side's missing bytes as `0`, then folds a length-difference flag into the
/// accumulator so an attacker-supplied prefix that matches the secret followed by zero bytes
/// still fails the comparison. The iteration count is bounded by the larger of the two
/// inputs; for candidates shorter than the token the bound is constant (the token's length),
/// for candidates longer it scales with attacker-supplied length, so the only timing channel
/// is the secret's length itself — the byte-by-byte recovery the helper exists to prevent
/// is closed. `internal` so tests can pin the invariant directly.
func constantTimeEquals(_ lhs: String, _ rhs: String) -> Bool {
    let lhsBytes = Array(lhs.utf8)
    let rhsBytes = Array(rhs.utf8)
    let length = max(lhsBytes.count, rhsBytes.count)
    var difference: UInt8 = 0
    for index in 0 ..< length {
        let lhsByte: UInt8 = index < lhsBytes.count ? lhsBytes[index] : 0
        let rhsByte: UInt8 = index < rhsBytes.count ? rhsBytes[index] : 0
        difference |= lhsByte ^ rhsByte
    }
    let lengthMismatch: UInt8 = lhsBytes.count == rhsBytes.count ? 0 : 1
    return (difference | lengthMismatch) == 0
}
