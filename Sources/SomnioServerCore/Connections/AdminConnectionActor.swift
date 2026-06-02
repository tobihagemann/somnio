import Foundation
import HummingbirdWebSocket
import Logging
import NIOCore
import NIOFoundationCompat
import NIOWebSocket
import SomnioProtocol

/// One admin WebSocket's lifecycle. Mirrors `ConnectionActor` but stripped to the admin
/// protocol: no `awaitingLogin → attached` state machine, no per-connection broadcast
/// outbox — every inbound request is decoded, dispatched, and responded to inline.
public actor AdminConnectionActor {
    private let dependencies: AdminConnectionDependencies

    public init(dependencies: AdminConnectionDependencies) {
        self.dependencies = dependencies
    }

    public func runConnection(
        inbound: WebSocketInboundStream,
        outbound: WebSocketOutboundWriter
    ) async {
        let logger = dependencies.logger
        do {
            let maxSize = SomnioProtocolConstants.maxWireFrameSize
            for try await message in inbound.messages(maxSize: maxSize) {
                let outcome = await Self.process(message, dependencies: dependencies)
                switch outcome {
                case let .write(response):
                    await AdminFrameWriter.write(response, to: outbound, logger: logger)
                case .ignore:
                    continue
                case let .closeProtocolError(reason):
                    try? await outbound.close(.protocolError, reason: reason)
                    return
                }
            }
        } catch {
            logger.warning("admin read loop error", metadata: ["error": "\(error)"])
            try? await outbound.close(.protocolError, reason: "read loop error")
            return
        }
        logger.debug("admin connection closed by peer")
    }

    /// Outcome of one inbound message. Surfaced via an internal helper so tests can
    /// drive the decode + dispatch + write decision path without a live WebSocket.
    enum ProcessOutcome: Equatable {
        case write(AdminResponse)
        case ignore
        case closeProtocolError(reason: String)
    }

    /// Pure helper exposed to tests via `@testable import SomnioServerCore`. The
    /// production `runConnection` read loop calls this for every inbound message and
    /// acts on the returned outcome. Not part of the public actor surface.
    static func process(
        _ message: WebSocketMessage,
        dependencies: AdminConnectionDependencies
    ) async -> ProcessOutcome {
        switch message {
        case let .text(string):
            return await processText(string, dependencies: dependencies)
        case .binary:
            dependencies.logger.error("admin received binary frame; closing")
            return .closeProtocolError(reason: "binary frames are not part of the wire protocol")
        }
    }

    private static func processText(
        _ string: String,
        dependencies: AdminConnectionDependencies
    ) async -> ProcessOutcome {
        let data = Data(string.utf8)
        let frameSize = data.count
        do {
            let request = try JSONDecoder().decode(AdminRequest.self, from: data)
            if let response = await AdminCommandDispatcher.handle(request, dependencies: dependencies) {
                return .write(response)
            }
            return .ignore
        } catch let error as SomnioProtocolError {
            switch error {
            case .unrecognizedTag:
                // Admin-channel carve-out: a CLI built against a newer server should not
                // tear down the session for an unknown verb. Reply `unknown` and stay open.
                return .write(.unknownCommand)
            case .oversizedFrame:
                dependencies.logger.error(
                    "admin frame validation failed",
                    metadata: ["error": "\(error)", "frame_size": "\(frameSize)"]
                )
                return .closeProtocolError(reason: "frame validation failed")
            }
        } catch {
            dependencies.logger.warning(
                "admin handler threw",
                metadata: ["error": "\(error)", "frame_size": "\(frameSize)"]
            )
            return .closeProtocolError(reason: "frame validation failed")
        }
    }
}
