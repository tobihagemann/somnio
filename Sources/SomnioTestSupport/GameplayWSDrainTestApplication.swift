import Foundation
import Hummingbird
import HummingbirdWebSocket
import NIOCore
import SomnioProtocol
import SomnioServerCore

/// Slim, Postgres-free gameplay-`/ws` fixture for the drain-before-close live tests. Replicates
/// only the `/ws` wiring from `makeSomnioServerApplication` — no `/health`, no `PostgresClient`,
/// no admin route — and pre-seeds caller-supplied frames into the connection's outbox before
/// running the lifecycle so a test can assert every queued frame reaches the client ahead of
/// the close.
public enum GameplayWSDrainTestApplication {
    public static func make(
        dependencies: ConnectionDependencies,
        preseed: [Data],
        onServerRunning: (@Sendable (any Channel) async -> Void)? = nil
    ) -> Application<RouterResponder<BasicWebSocketRequestContext>> {
        let router = Router(context: BasicWebSocketRequestContext.self)
        router.ws("/ws") { inbound, outbound, _ in
            let actor = ConnectionActor(dependencies: dependencies)
            let outbox = await actor.connectionOutbox
            for frame in preseed {
                outbox.send(frame)
            }
            await actor.runConnection(inbound: inbound, outbound: outbound)
        }
        return Application(
            router: router,
            server: .http1WebSocketUpgrade(
                webSocketRouter: router,
                configuration: WebSocketServerConfiguration(maxFrameSize: SomnioProtocolConstants.maxWireFrameSize)
            ),
            configuration: ApplicationConfiguration(address: .hostname("127.0.0.1", port: 0)),
            onServerRunning: onServerRunning ?? { _ in }
        )
    }
}
