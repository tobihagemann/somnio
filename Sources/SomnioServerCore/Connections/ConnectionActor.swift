import Foundation
import HummingbirdWebSocket
import Logging
import NIOCore
import NIOFoundationCompat
import NIOWebSocket
import SomnioData
import SomnioProtocol

/// One connection's complete lifecycle. Owns the per-connection writer task that drains
/// `ConnectionOutbox.stream` and writes JSON text frames to the WebSocket. State transitions:
/// `awaitingLogin` (Hello already on the wire after start) → `attached(entityIndex, sectorName, accountId)`
/// once Login succeeds. The `/ws` route closure calls `runConnection` and the actor handles
/// every subsequent step until disconnect.
public actor ConnectionActor {
    public enum State: Sendable {
        case awaitingLogin
        case attached(entityIndex: Int16, sectorName: String, accountId: UUID)
    }

    public enum CloseDecision: Sendable {
        case keepOpen
        case close(code: WebSocketErrorCode, reason: String)
    }

    private let dependencies: ConnectionDependencies
    private let outbox: ConnectionOutbox
    private var state: State = .awaitingLogin
    private var writerTask: Task<Void, Never>?
    private var readLoopTask: Task<CloseDecision, Never>?
    private var logger: Logger {
        dependencies.logger
    }

    public init(dependencies: ConnectionDependencies) {
        self.dependencies = dependencies
        self.outbox = ConnectionOutbox(highWatermark: dependencies.configuration.outboxHighWatermark)
    }

    var currentState: State {
        state
    }

    public var connectionOutbox: ConnectionOutbox {
        outbox
    }

    /// Drive one gameplay WebSocket from accept to disconnect. Spawns the writer task,
    /// emits the `Hello` protocol-version frame first, then runs the read loop in a
    /// stored child task so an admin kick can `cancel()` it out-of-band. After the loop
    /// returns (peer EOF, protocol-error close, or admin kick), writes a per-disconnect
    /// snapshot before unregistering with the world router.
    public func runConnection(
        inbound: WebSocketInboundStream,
        outbound: WebSocketOutboundWriter
    ) async {
        await runConnection(inbound: inbound, sink: WebSocketOutboundSink(outbound: outbound))
    }

    /// Generic over the outbound sink so the live route uses the concrete `WebSocketOutboundSink`
    /// (static dispatch, no existential on the hot path) while tests inject a recording spy to
    /// pin the drain-before-close exit ordering. The orchestration is identical for both.
    func runConnection(
        inbound: WebSocketInboundStream,
        sink: some ConnectionOutboundSink
    ) async {
        startWriterTask(sink: sink)
        sendHello()

        let task = Task { [weak self] () -> CloseDecision in
            guard let self else { return .keepOpen }
            return await runReadLoop(inbound: inbound)
        }
        readLoopTask = task
        // `Task { ... }` is unstructured and does not inherit cancellation from the
        // enclosing Hummingbird upgrade task, so the cancellation handler below bridges
        // a parent-task cancel (e.g. graceful shutdown) into a `cancel()` on the read
        // loop. Admin kicks still call `disconnectForAdminKick()` directly; both paths
        // converge on the same `cancel()`.
        let closeDecision = await withTaskCancellationHandler {
            await task.value
        } onCancel: {
            task.cancel()
        }
        readLoopTask = nil

        await snapshotAndCleanup()
        await finishDrainAndClose(decision: closeDecision, sink: sink)
    }

    /// The drain-before-close exit, extracted so the spy test can drive it directly:
    ///   1. Finish the outbox so the writer task sees end-of-stream.
    ///   2. Await the writer task so every queued frame lands on the wire.
    ///   3. Write the close frame on top of the now-drained stream.
    /// Reordering 1↔2 would deadlock (writer never observes EOF); reordering 2↔3
    /// would race queued frames past the close frame.
    func finishDrainAndClose(decision: CloseDecision, sink: some ConnectionOutboundSink) async {
        outbox.finish()
        await writerTask?.value
        await close(decision: decision, sink: sink)
    }

    private func runReadLoop(inbound: WebSocketInboundStream) async -> CloseDecision {
        var decision: CloseDecision = .keepOpen
        do {
            let maxSize = SomnioProtocolConstants.maxWireFrameSize
            for try await message in inbound.messages(maxSize: maxSize) {
                let outcome = await handleInboundMessage(message)
                if case .close = outcome {
                    decision = outcome
                    break
                }
            }
        } catch is CancellationError {
            // Admin kick cancelled the loop. Routine, not an error path — log at debug so
            // the gameplay file backend isn't polluted with a warning per kick.
            logger.debug("WebSocket read loop cancelled (admin kick)")
        } catch {
            logger.warning("WebSocket read loop error", metadata: ["error": "\(error)"])
        }
        return decision
    }

    /// Synchronous kick affordance: cancel the read-loop task so
    /// `inbound.messages(...)` unblocks with `CancellationError` immediately. Teardown
    /// (snapshot, unregister, outbox finish, outbound close) is owned by
    /// `runConnection`'s exit path, so the kick path here only releases the loop.
    public func disconnectForAdminKick() {
        readLoopTask?.cancel()
    }

    /// Used by the shutdown drain (Step 11): broadcasts `leave(leftGame: true)` to old peers
    /// via the sector actor, snapshots the player, then closes the outbox so the writer
    /// task drains queued frames and exits.
    public func drainForShutdown() async {
        await snapshotAndCleanup(leftGame: true)
        outbox.finish()
    }

    // MARK: - Inbound dispatch

    private func handleInboundMessage(_ message: WebSocketMessage) async -> CloseDecision {
        switch message {
        case let .text(string):
            let data = Data(string.utf8)
            let frameSize = data.count
            do {
                let decoded = try SomnioMessageDecoder.decode(data)
                return await dispatch(decoded, frameSize: frameSize)
            } catch let error as SomnioProtocolError {
                return protocolErrorClose("\(error)", frameSize: frameSize)
            } catch {
                logger.warning(
                    "decoded frame handler threw",
                    metadata: ["error": "\(error)", "frame_size": "\(frameSize)"]
                )
                return .close(code: .protocolError, reason: "frame validation failed")
            }
        case .binary:
            return protocolErrorClose("binary frames are not part of the wire protocol", frameSize: 0)
        }
    }

    /// Logs a frame-validation failure and returns the standard `.close(.protocolError, ...)`
    /// decision the wire-protocol layer uses for any unrecoverable inbound frame. The reason
    /// can embed attacker-controlled data (e.g. an unrecognized JSON tag string up to the full
    /// frame size on the unauthenticated socket), so it is truncated before logging to bound
    /// log amplification.
    private func protocolErrorClose(_ reason: String, frameSize: Int) -> CloseDecision {
        let bounded = String(decoding: reason.utf8.prefix(256), as: UTF8.self)
        logger.error(
            "frame validation failed",
            metadata: ["error": "\(bounded)", "frame_size": "\(frameSize)"]
        )
        return .close(code: .protocolError, reason: "frame validation failed")
    }

    /// `internal` (not `private`) so `SomnioServerCoreTests` can assert the wire-protocol close
    /// branches directly without driving a live socket.
    func dispatch(_ message: SomnioMessage, frameSize: Int) async -> CloseDecision {
        switch state {
        case .awaitingLogin:
            switch message {
            case let .login(payload):
                await LoginHandler.handle(payload, on: self, dependencies: dependencies)
                return .keepOpen
            case let .register(payload):
                await RegisterHandler.handle(payload, on: self, dependencies: dependencies)
                return .keepOpen
            case .clientPosition, .clientSay, .equipToggle, .bumpNPC, .enterPortal,
                 .hello, .loginResult, .registerResult, .enterSector, .mainCharacter,
                 .entity, .serverPosition, .serverSay, .energy, .dateTick, .inventory,
                 .leave, .adminSay:
                return protocolErrorClose("unexpected tag before login", frameSize: frameSize)
            }
        case let .attached(entityIndex, sectorName, _):
            switch message {
            case let .clientPosition(payload):
                await GameplayHandlers.handlePosition(
                    payload,
                    entityIndex: entityIndex,
                    sectorName: sectorName,
                    dependencies: dependencies
                )
                return .keepOpen
            case let .clientSay(payload):
                await GameplayHandlers.handleSay(
                    payload,
                    entityIndex: entityIndex,
                    sectorName: sectorName,
                    dependencies: dependencies
                )
                return .keepOpen
            case let .equipToggle(payload):
                await GameplayHandlers.handleEquipToggle(
                    payload,
                    entityIndex: entityIndex,
                    sectorName: sectorName,
                    outbox: outbox,
                    dependencies: dependencies
                )
                return .keepOpen
            case let .bumpNPC(payload):
                await GameplayHandlers.handleBumpNPC(
                    payload,
                    entityIndex: entityIndex,
                    sectorName: sectorName,
                    dependencies: dependencies
                )
                return .keepOpen
            case let .enterPortal(payload):
                let outcome = await GameplayHandlers.handleEnterPortal(
                    payload,
                    entityIndex: entityIndex,
                    sectorName: sectorName,
                    connectionActor: self,
                    dependencies: dependencies
                )
                if let outcome {
                    setAttached(entityIndex: outcome.entityIndex, sectorName: outcome.sectorName)
                }
                return .keepOpen
            case .login, .register:
                return protocolErrorClose("login/register after attach", frameSize: frameSize)
            case .hello, .loginResult, .registerResult, .enterSector, .mainCharacter,
                 .entity, .serverPosition, .serverSay, .energy, .dateTick, .inventory,
                 .leave, .adminSay:
                return protocolErrorClose("server-only tag from client", frameSize: frameSize)
            }
        }
    }

    // MARK: - State transitions called by handlers

    /// Promote the connection to `attached` after a successful Login or Register flow.
    /// Called by `LoginHandler` after the join sequence has been streamed.
    public func markAttached(entityIndex: Int16, sectorName: String, accountId: UUID) {
        state = .attached(entityIndex: entityIndex, sectorName: sectorName, accountId: accountId)
    }

    /// Update both the cached entity index and the sector name after a successful portal hop.
    /// The `entityIndex` is sector-local, so the value returned by the destination sector's
    /// `attach` must replace the source sector's value — otherwise position/equip/disconnect
    /// paths address the wrong slot in the new sector.
    public func setAttached(entityIndex: Int16, sectorName: String) {
        if case let .attached(_, _, accountId) = state {
            state = .attached(entityIndex: entityIndex, sectorName: sectorName, accountId: accountId)
        }
    }

    // MARK: - Writer task + Hello

    func startWriterTask(sink: some ConnectionOutboundSink) {
        let outbox = outbox
        let task = Task<Void, Never> {
            for await frame in outbox.stream {
                do {
                    try await sink.writeText(frame)
                    outbox.recordWrite()
                } catch {
                    // Peer disconnected mid-write; drop the rest and let the read loop tear
                    // the connection down. There's no useful retry here.
                    break
                }
            }
            if outbox.isOverflowed {
                await sink.close(code: .policyViolation, reason: "outbox overflow")
            }
        }
        writerTask = task
    }

    private func sendHello() {
        outbox.sendEncoded(
            .hello(HelloMessage(protocolVersion: SomnioProtocolConstants.helloVersion)),
            logger: logger
        )
    }

    // MARK: - Close + cleanup

    private func snapshotAndCleanup(leftGame: Bool = true) async {
        guard case let .attached(entityIndex, sectorName, accountId) = state else { return }
        if let sectorActor = await dependencies.worldRouter.sectorActor(named: sectorName) {
            if let snapshot = await sectorActor.snapshotForPlayer(entityIndex: entityIndex) {
                // Atomic transaction inside `persistCheckpoint` enforces the `last_seen`
                // skip-if-stale guard for both the character row and the inventory rows, so
                // this write and a racing periodic checkpoint can't overwrite each other.
                await PlayerCheckpointWriter.persist(
                    snapshot,
                    characters: dependencies.characters,
                    logger: logger,
                    context: ["origin": "disconnect", "sector": "\(sectorName)"]
                )
            }
            await sectorActor.detach(entityIndex: entityIndex, leftGame: leftGame)
        }
        await dependencies.worldRouter.unregister(accountId: accountId)
        state = .awaitingLogin
    }

    private func close(decision: CloseDecision, sink: some ConnectionOutboundSink) async {
        // The outbox is already finished and drained by the time `finishDrainAndClose` calls
        // this helper, so the only work here is selecting the wire close-code and reason.
        switch decision {
        case .keepOpen:
            await sink.close(code: .goingAway, reason: "connection closed")
        case let .close(code, reason):
            await sink.close(code: code, reason: reason)
        }
    }
}
