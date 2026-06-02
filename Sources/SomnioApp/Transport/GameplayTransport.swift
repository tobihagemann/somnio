import Foundation
import HummingbirdWSClient
import Logging
import NIOCore
import NIOFoundationCompat
import NIOSSL
import SomnioProtocol

/// Long-lived gameplay-WebSocket transport. Mirrors `AdminTransport`'s framing decisions
/// (`maxFrameSize = SomnioProtocolConstants.maxWireFrameSize`), with no `Authorization`
/// header — the gameplay `/ws` route is unauthenticated until `Login`. The actor refuses
/// re-entrancy: callers wanting to switch sockets must `await disconnect()` first.
public actor GameplayTransport {
    private let logger: Logger
    private var current: ActiveConnection?

    public init(logger: Logger = Logger(label: "de.tobiha.somnio.app.transport")) {
        self.logger = logger
    }

    /// Drives one WebSocket from connect through peer EOF or `disconnect()`. Forwards
    /// every meaningful event back through `delegate`. Must be called from a `Task` the
    /// caller owns so it can cancel/await the unwind without holding the actor.
    public func run(url: String, delegate: any GameplayTransportDelegate) async {
        guard current == nil else {
            logger.warning("transport.run() refused re-entrancy")
            return
        }
        let active = ActiveConnection()
        current = active

        var configuration = WebSocketClientConfiguration()
        configuration.maxFrameSize = SomnioProtocolConstants.maxWireFrameSize

        let tlsConfiguration: TLSConfiguration?
        switch await resolveTLS(delegate: delegate) {
        case let .ready(configuration):
            tlsConfiguration = configuration
        case .refused:
            current = nil
            return
        }

        let logger = logger
        do {
            _ = try await WebSocketClient.connect(
                url: url,
                configuration: configuration,
                tlsConfiguration: tlsConfiguration,
                logger: logger
            ) { inbound, outbound, _ in
                await Self.driveConnection(
                    inbound: inbound,
                    outbound: outbound,
                    active: active,
                    delegate: delegate,
                    logger: logger
                )
            }
        } catch {
            logger.warning("websocket connect failed", metadata: ["error": "\(error)", "url": "\(url)"])
            await Self.deliver(.connectFailed(error), to: delegate)
        }

        // Drain whatever is left and clear the slot so a subsequent `run` starts clean.
        let snapshot = active.snapshot
        snapshot.outbox?.finish()
        await snapshot.writerTask?.value
        await snapshot.watcherTask?.value
        active.mutate { state in
            state.outbox = nil
            state.closeSignal = nil
            state.readLoopTask = nil
            state.writerTask = nil
            state.watcherTask = nil
        }
        current = nil
    }

    /// Encode `message` and enqueue the frame on the active outbox. No-op if there is
    /// no active connection; the next `run(url:delegate:)` will start a fresh socket
    /// rather than queue stale frames.
    public func enqueue(_ message: SomnioMessage) {
        guard let outbox = current?.snapshot.outbox else { return }
        do {
            let frame = try SomnioMessageEncoder.encode(message)
            outbox.enqueue(frame)
        } catch {
            logger.warning("outbound encode failed", metadata: ["error": "\(error)", "tag": "\(message.tag)"])
        }
    }

    /// Initiates a graceful close. Cancels the read loop, fires the close signal so the
    /// watcher task issues `.normalClosure`, and finishes the outbox so the writer task
    /// drains queued frames and exits. The parent `Task { await transport.run(...) }`
    /// observes the unwind and returns.
    public func disconnect() async {
        guard let active = current else { return }
        let snapshot = active.snapshot
        // Drain the writer BEFORE firing the close watcher. Without this ordering
        // the watcher's `outbound.close(.normalClosure)` can race the writer's
        // `outbound.write(...)` for queued frames, dropping the in-flight frames or
        // misordering the close frame relative to them. swift-websocket documents
        // that data must not be sent after `close`.
        snapshot.outbox?.finish()
        await snapshot.writerTask?.value
        snapshot.closeSignal?.fire()
        snapshot.readLoopTask?.cancel()
    }

    /// Resolves the TLS configuration for this run. Returns `.ready(nil)` for the
    /// debug skip-pinning path or for `.skipPinning`; returns `.ready(configuration)`
    /// when a release pin loaded; surfaces `.refused` (and delivers `.connectFailed`
    /// to the delegate) when the release pin failed to parse, so the caller can
    /// fail-closed instead of silently downgrading to system trust.
    private enum TLSResolution {
        case ready(TLSConfiguration?)
        case refused
    }

    private func resolveTLS(delegate: any GameplayTransportDelegate) async -> TLSResolution {
        switch GameplayServerTrust.resolve() {
        case .skipPinning:
            return .ready(nil)
        case let .pinned(configuration):
            return .ready(configuration)
        case let .refused(reason):
            logger.error("refusing to connect — production pin not loadable", metadata: ["reason": "\(reason)"])
            await Self.deliver(.connectFailed(GameplayTransportError.pinningRefused(reason: reason)), to: delegate)
            return .refused
        }
    }

    /// Spawns the writer + close-watcher + read-loop tasks for one socket and waits for
    /// the read loop to finish. Pulled out of `run(url:delegate:)` so the connection
    /// closure stays under the lint thresholds.
    private static func driveConnection(
        inbound: WebSocketInboundStream,
        outbound: WebSocketOutboundWriter,
        active: ActiveConnection,
        delegate: any GameplayTransportDelegate,
        logger: Logger
    ) async {
        let (outbox, drainStream) = GameplayOutbox.make()
        let closeSignal = GameplayCloseSignal()

        // Publish the outbox + close signal BEFORE spawning the read loop so a fast
        // server `Hello` cannot race the publication: the view model's
        // `handleHello` immediately calls `transport.enqueue(.login(...))`, which
        // reads `current?.snapshot.outbox`. If the read loop is started first and
        // the Hello arrives before this `mutate` runs, the auth frame silently drops
        // and the client strands in `.awaitingLoginResult`.
        active.mutate { state in
            state.outbox = outbox
            state.closeSignal = closeSignal
        }

        let writerTask = Task<Void, Never> {
            for await frame in drainStream {
                do {
                    try await outbound.write(.text(String(decoding: frame, as: UTF8.self)))
                } catch {
                    // Peer disconnected mid-write; drop the rest and let the read loop
                    // tear the connection down.
                    break
                }
            }
        }

        let watcherTask = Task<Void, Never> {
            await closeSignal.wait()
            try? await outbound.close(.normalClosure, reason: nil)
        }

        let readLoopTask = Task<Void, Never> { @Sendable in
            await runReadLoop(inbound: inbound, outbound: outbound, delegate: delegate, logger: logger)
        }

        active.mutate { state in
            state.writerTask = writerTask
            state.watcherTask = watcherTask
            state.readLoopTask = readLoopTask
        }

        // Wait for the read loop to finish, bridging task cancellation through the
        // `Sendable` `active` reference. `outbound.close(...)` does NOT terminate
        // `inbound.messages(...)`; only an explicit `cancel()` does.
        await withTaskCancellationHandler {
            await readLoopTask.value
        } onCancel: {
            active.snapshot.readLoopTask?.cancel()
        }
    }

    /// One read-loop body. Decodes JSON text frames, forwards events, and surfaces
    /// terminal failures via `.decodeFailed` / `.unexpectedBinaryFrame`. Emits
    /// `.peerEOF` when the loop reaches end-of-stream from a peer-initiated close
    /// (the unprompted disconnect case). Intentional cancellation by `disconnect()`
    /// suppresses `.peerEOF` so an explicit Leave Game does not append a misleading
    /// "connection lost" chat line.
    private static func runReadLoop(
        inbound: WebSocketInboundStream,
        outbound: WebSocketOutboundWriter,
        delegate: any GameplayTransportDelegate,
        logger: Logger
    ) async {
        var terminatedByFailure = false
        var cancelledByDisconnect = false
        do {
            let maxSize = SomnioProtocolConstants.maxWireFrameSize
            for try await message in inbound.messages(maxSize: maxSize) {
                let outcome = await handleInbound(
                    message,
                    outbound: outbound,
                    delegate: delegate,
                    logger: logger
                )
                if outcome == .terminate {
                    terminatedByFailure = true
                    break
                }
            }
        } catch is CancellationError {
            // Cancelled by `disconnect()`; teardown owns event delivery and the user
            // already initiated the close, so suppress `.peerEOF`.
            cancelledByDisconnect = true
        } catch {
            logger.warning("read loop error", metadata: ["error": "\(error)"])
        }
        if !terminatedByFailure, !cancelledByDisconnect {
            await deliver(.peerEOF, to: delegate)
        }
    }

    private enum InboundOutcome: Equatable {
        case keepReading
        case terminate
    }

    private static func handleInbound(
        _ message: WebSocketMessage,
        outbound: WebSocketOutboundWriter,
        delegate: any GameplayTransportDelegate,
        logger: Logger
    ) async -> InboundOutcome {
        switch message {
        case let .text(string):
            let data = Data(string.utf8)
            do {
                let decoded = try SomnioMessageDecoder.decode(data)
                await deliver(.message(decoded), to: delegate)
                return .keepReading
            } catch {
                logger.warning(
                    "frame decode failed",
                    metadata: ["error": "\(error)", "frame_size": "\(data.count)"]
                )
                await deliver(.decodeFailed(error), to: delegate)
                try? await outbound.close(.protocolError, reason: "decode failed")
                return .terminate
            }
        case .binary:
            logger.warning("unexpected binary frame on gameplay socket")
            await deliver(.unexpectedBinaryFrame, to: delegate)
            try? await outbound.close(.protocolError, reason: "unexpected binary frame")
            return .terminate
        }
    }

    private static func deliver(
        _ event: GameplayTransportEvent,
        to delegate: any GameplayTransportDelegate
    ) async {
        await MainActor.run {
            delegate.handle(event)
        }
    }
}
