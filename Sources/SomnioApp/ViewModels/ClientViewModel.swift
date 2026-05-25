import Foundation
import Logging
import SomnioCore
import SomnioProtocol
import SomnioUI
import SpriteKit

/// Main-actor view model orchestrating the connect → splash → login → world flow plus
/// the gameplay loop. Owns the transport, the per-connection state, the chat-line
/// buffer, the entity map, and the `WorldScene` reference. Conforms to
/// `GameplayTransportDelegate` so the transport feeds events back synchronously on
/// the main actor.
@MainActor @Observable public final class ClientViewModel: GameplayTransportDelegate {
    public enum ConnectionState: Sendable, Equatable {
        case disconnected
        case awaitingHello
        case awaitingLoginResult
        case awaitingEnterSector
        case attached
    }

    // MARK: - Observable state

    public var connectionState: ConnectionState = .disconnected
    public var chatLines: [ChatLine] = []
    public var chatInput: String = ""
    public var players: [String] = []
    public var inventory: [InventoryRow] = []
    public var energy: Energy = .zero
    public var entities: [Int16: WorldEntity] = [:]
    public var selfEntityIndex: Int16?
    public var selfDisplayName: String = ""
    public var currentSector: Sector?
    public var currentDateTick: DateTickMessage = .init(hour: 12, minute: 0)
    public var presentedSheet: SheetKind? = .login
    public var isChatInputFocused: Bool = false

    public let loginForm = LoginFormState()
    public let registrationForm = RegistrationFormState()
    public let worldScene: WorldScene

    // MARK: - Internals

    private let transport: GameplayTransport
    private var connectionTask: Task<Void, Never>?
    private var tickerTask: Task<Void, Never>?
    private var lastEmittedPosition: GridPoint?
    private var lastEmittedFacing: Direction?
    private var lastEmittedTempo: Tempo?
    /// Wall-clock time of the last position frame sent to the server (the 2 Hz heartbeat gate).
    private var lastEmitTime: Date?
    /// Wall-clock time of the previous gameplay tick, for the elapsed-time-scaled movement step.
    private var lastTickTime: Date?
    private var lastBumpedNPC: Int16?
    private var lastBumpedPortalIndex: Int?
    private let logger = Logger(label: "de.tobiha.somnio.app.gameplay")

    public init(
        worldScene: WorldScene,
        transport: GameplayTransport = GameplayTransport()
    ) {
        self.worldScene = worldScene
        self.transport = transport
    }

    /// Pulls a saved credential into the login form (without opening a connection).
    /// The view calls this on first appear.
    public func bootstrapAutoLogin() {
        guard let saved = CredentialStore.load() else { return }
        loginForm.nickname = saved.nickname
        loginForm.password = saved.password
        loginForm.rememberPassword = true
    }

    // MARK: - Connection lifecycle

    public func openConnection() {
        // Short-circuit if a connection is already in flight. Clear `pendingRegistration`
        // so a stale Register message that was queued by `submitRegistration` while the
        // socket was open cannot ride out the next Hello and silently re-issue.
        guard connectionTask == nil else {
            pendingRegistration = nil
            return
        }
        // Set state before launching the transport so the first inbound `Hello` cannot
        // race the assignment (the server emits `Hello` immediately after accept).
        connectionState = .awaitingHello
        let resolvedURL: String
        do {
            resolvedURL = try GameplayURLResolver.resolve()
        } catch {
            logger.warning("server URL rejected", metadata: ["error": "\(error)"])
            connectionState = .disconnected
            chatLines.append(.serverUnreachable)
            presentedSheet = .login
            return
        }
        let transport = transport
        connectionTask = Task { [weak self] in
            await transport.run(url: resolvedURL, delegate: self ?? UnreachableDelegate.shared)
            await MainActor.run { [weak self] in
                self?.connectionTask = nil
                if self?.connectionState != .disconnected {
                    self?.connectionState = .disconnected
                }
            }
        }
    }

    public func leaveGame() {
        Task { [weak self] in
            await self?.performLeave()
        }
    }

    public func handle(_ event: GameplayTransportEvent) {
        switch event {
        case let .message(message):
            dispatch(message)
        case let .connectFailed(error):
            logger.warning("connect failed", metadata: ["error": "\(error)"])
            chatLines.append(.serverUnreachable)
            beginAuthSocketTeardown()
        case let .decodeFailed(error):
            chatLines.append(.errorCode(code: "\(error)"))
            beginAuthSocketTeardown()
        case .unexpectedTextFrame:
            chatLines.append(.errorCode(code: "unexpected_text_frame"))
            beginAuthSocketTeardown()
        case .peerEOF:
            // Mid-session peer EOF surfaces as connection lost; pre-attach EOF is
            // rare and treated the same since the user-visible result is identical.
            chatLines.append(.connectionLost)
            beginAuthSocketTeardown()
        }
    }

    // MARK: - Chat

    public func submitChat() {
        let text = chatInput.trimmingCharacters(in: .whitespacesAndNewlines)
        chatInput = ""
        guard !text.isEmpty, connectionState == .attached, let selfIndex = selfEntityIndex else { return }
        enqueue(.clientSay(SayMessage(entityIndex: 0, text: text)))
        chatLines.append(.spokenByOwn(senderName: selfDisplayName, message: text))
        let lines = SpeechBubbleText.wrap(text)
        worldScene.showSpeechBubble(above: selfIndex, lines: lines, lifetimeMs: 2000 + lines.count * 1000)
    }

    // MARK: - Inventory

    public func toggleEquip(_ row: InventoryRow, hand: Hand) {
        guard connectionState == .attached else { return }
        let wireHand: WireHand = row.equippedHand == hand ? .none : (hand == .left ? .left : .right)
        enqueue(.equipToggle(EquipToggleMessage(slot: row.slot, hand: wireHand)))
    }

    // MARK: - Inbound dispatch

    // swiftlint:disable:next cyclomatic_complexity
    private func dispatch(_ message: SomnioMessage) {
        switch message {
        case let .hello(payload):
            handleHello(payload)
        case let .loginResult(payload):
            handleLoginResult(payload)
        case let .registerResult(payload):
            handleRegisterResult(payload)
        case let .enterSector(payload):
            handleEnterSector(payload)
        case let .mainCharacter(payload):
            handleMainCharacter(payload)
        case let .entity(payload):
            handleEntity(payload)
        case let .serverPosition(payload):
            handleServerPosition(payload)
        case let .serverSay(payload):
            handleServerSay(payload)
        case let .energy(payload):
            energy = payload
        case let .dateTick(payload):
            handleDateTick(payload)
        case let .inventory(payload):
            inventory = payload.rows.map(InventoryRow.init)
        case let .leave(payload):
            handleLeave(payload)
        case let .adminSay(payload):
            chatLines.append(.adminBroadcast(message: payload.text))
        case .login, .register, .clientPosition, .clientSay, .equipToggle, .bumpNPC, .enterPortal:
            chatLines.append(.errorCode(code: "client_only_tag"))
            beginAuthSocketTeardown()
        }
    }

    private func handleHello(_ payload: HelloMessage) {
        guard connectionState == .awaitingHello else {
            chatLines.append(.errorCode(code: "unexpected_hello"))
            beginAuthSocketTeardown()
            return
        }
        guard payload.protocolVersion == SomnioProtocolConstants.helloVersion else {
            chatLines.append(.errorCode(code: "\(payload.protocolVersion)"))
            beginAuthSocketTeardown()
            return
        }
        connectionState = .awaitingLoginResult
        if let pendingRegistration {
            sendRegister(pendingRegistration)
        } else {
            sendLogin()
        }
    }

    private func handleLoginResult(_ payload: LoginResultMessage) {
        switch payload.result {
        case .ok:
            selfDisplayName = loginForm.nickname
            connectionState = .awaitingEnterSector
            if loginForm.rememberPassword {
                do {
                    try CredentialStore.save(nickname: loginForm.nickname, password: loginForm.password)
                } catch {
                    logger.warning("failed to persist remembered credential", metadata: ["error": "\(error)"])
                }
            } else {
                CredentialStore.delete()
            }
        case .badCredentials:
            registrationForm.lastError = nil
            chatLines.append(.badCredentials)
            beginAuthSocketTeardown()
            presentedSheet = .login
        case .alreadyLoggedIn:
            chatLines.append(.alreadyLoggedIn)
            beginAuthSocketTeardown()
            presentedSheet = .login
        }
    }

    private func handleRegisterResult(_ payload: RegisterResultMessage) {
        switch payload.result {
        case .ok:
            registrationForm.lastError = nil
            registrationForm.clear()
            beginAuthSocketTeardown()
            presentedSheet = .login
        case .nicknameExists:
            registrationForm.lastError = .nicknameExists
            beginAuthSocketTeardown()
        case .failure:
            registrationForm.lastError = .failure
            beginAuthSocketTeardown()
        }
        pendingRegistration = nil
    }

    private func handleEnterSector(_ payload: EnterSectorMessage) {
        do {
            let sector = try Sector(payload.sector)
            // Clear sector-local state before loading the new sector so a portal hop
            // doesn't leave the previous sector's entities/peers/self-index alive
            // alongside `currentSector`. The next `mainCharacter` will rebuild
            // `selfEntityIndex` and the entity stream rebuilds peers + NPCs.
            entities.removeAll()
            players.removeAll()
            selfEntityIndex = nil
            lastEmittedPosition = nil
            lastEmittedFacing = nil
            lastEmittedTempo = nil
            lastEmitTime = nil
            lastTickTime = nil
            lastBumpedNPC = nil
            lastBumpedPortalIndex = nil
            currentSector = sector
            worldScene.load(sector: sector)
            // Re-apply the most recent date tint so the new sector's `LightSetting`
            // takes effect without waiting for the next `DateTick`.
            worldScene.updateDayNightTint(
                hour: currentDateTick.hour,
                minute: currentDateTick.minute,
                sectorLight: sector.light
            )
            // Drop back to `.awaitingEnterSector` until the next `mainCharacter`
            // arrives so chat / movement that depend on `selfEntityIndex` cannot fire
            // in the few-tick gap between `enterSector` and `mainCharacter` on a
            // portal hop. Also stops the gameplay ticker so it doesn't reference the
            // old sector's collision masks while `currentSector` already points at
            // the new one.
            connectionState = .awaitingEnterSector
            stopGameplayTicker()
            presentedSheet = nil
        } catch {
            chatLines.append(.errorCode(code: "\(error)"))
            beginAuthSocketTeardown()
        }
    }

    private func handleMainCharacter(_ payload: MainCharacterMessage) {
        selfEntityIndex = payload.entityIndex
        // The authoritative self-Entity is the next frame on the wire; `handleEntity`
        // populates `entities[selfEntityIndex]` from it.
        connectionState = .attached
        startGameplayTicker()
    }

    private func handleEntity(_ payload: EntityMessage) {
        let kind: WorldEntity.Kind = switch payload.type {
        case .player:
            (payload.entityIndex == selfEntityIndex) ? .player : .peer
        case .npc:
            .npc
        case .monster:
            .monster
        }
        let direction = Direction(rawValue: payload.facing) ?? .south
        let tempo = Tempo(rawValue: payload.tempo) ?? .default
        let entity = WorldEntity(
            id: payload.entityIndex,
            kind: kind,
            figure: payload.figure,
            gender: Gender(rawValue: payload.gender),
            position: GridPoint(x: payload.x, y: payload.y),
            facing: direction,
            tempo: tempo,
            maskSize: GridSize(width: payload.maskWidth, height: payload.maskHeight),
            name: payload.name
        )
        entities[payload.entityIndex] = entity
        worldScene.placeEntity(entity)
        if kind == .peer, !players.contains(entity.name) {
            players.append(entity.name)
        }
    }

    private func handleServerPosition(_ payload: PositionMessage) {
        guard var entity = entities[payload.entityIndex] else { return }
        let newPosition = GridPoint(x: payload.x, y: payload.y)
        let facing = Direction(rawValue: payload.facing) ?? entity.facing
        let tempo = Tempo(rawValue: payload.tempo) ?? entity.tempo
        entity.position = newPosition
        entity.facing = facing
        entity.tempo = tempo
        entities[payload.entityIndex] = entity
        // Peers arrive on the ~500 ms position heartbeat, so tween them across that gap; NPCs and
        // monsters arrive on the 50 ms server AI tick, so keep their shorter interpolation or they
        // would visibly lag the server.
        let duration: TimeInterval = switch entity.kind {
        case .peer, .player: Self.peerInterpolationDuration
        case .npc, .monster: Self.aiTickInterpolationDuration
        }
        worldScene.animateEntity(payload.entityIndex, to: newPosition, facing: facing, duration: duration)
    }

    private func handleServerSay(_ payload: SayMessage) {
        guard let entity = entities[payload.entityIndex] else { return }
        switch entity.kind {
        case .npc, .monster:
            chatLines.append(.spokenByNPC(senderName: entity.name, message: payload.text))
        case .peer, .player:
            chatLines.append(.spokenByPeer(senderName: entity.name, message: payload.text))
        }
        let lines = SpeechBubbleText.wrap(payload.text)
        worldScene.showSpeechBubble(above: payload.entityIndex, lines: lines, lifetimeMs: 2000 + lines.count * 1000)
    }

    private func handleDateTick(_ payload: DateTickMessage) {
        currentDateTick = payload
        worldScene.updateDayNightTint(
            hour: payload.hour,
            minute: payload.minute,
            sectorLight: currentSector?.light ?? LightSetting(indoor: false, brightness: 100)
        )
    }

    private func handleLeave(_ payload: LeaveMessage) {
        if payload.entityIndex == selfEntityIndex, payload.leftGame {
            beginAuthSocketTeardown()
            return
        }
        if let leaving = entities.removeValue(forKey: payload.entityIndex) {
            worldScene.removeEntity(id: payload.entityIndex)
            if leaving.kind == .peer {
                players.removeAll { $0 == leaving.name }
                chatLines.append(.left(playerName: leaving.name))
            }
        }
    }

    // MARK: - Authentication outbound

    private var pendingRegistration: RegisterMessage?

    public func submitLogin() {
        registrationForm.lastError = nil
        pendingRegistration = nil
        openConnection()
    }

    public func submitRegistration() {
        let payload = RegisterMessage(
            nickname: registrationForm.nickname,
            password: registrationForm.password,
            passwordRepeat: registrationForm.passwordRepeat,
            characterClass: registrationForm.characterClass.rawValue,
            gender: registrationForm.gender.rawValue,
            email: registrationForm.email
        )
        pendingRegistration = payload
        loginForm.nickname = registrationForm.nickname
        loginForm.password = registrationForm.password
        openConnection()
    }

    private func sendLogin() {
        let message = LoginMessage(nickname: loginForm.nickname, password: loginForm.password)
        enqueue(.login(message))
    }

    private func sendRegister(_ message: RegisterMessage) {
        enqueue(.register(message))
    }

    /// Detached enqueue helper. The view model is `@MainActor` and the transport is
    /// an actor, so every outbound frame needs to hop through a `Task` — extracting
    /// the boilerplate keeps the seven call sites from each carrying their own
    /// `Task { [transport] in await transport.enqueue(...) }` chain.
    private func enqueue(_ message: SomnioMessage) {
        Task { [transport] in
            await transport.enqueue(message)
        }
    }

    private func beginAuthSocketTeardown() {
        // Detach the disconnect so it cannot self-await a `connectionTask` running the
        // current handler. The parent task's completion clears `connectionTask` and
        // resets `connectionState`.
        let transport = transport
        Task {
            await transport.disconnect()
        }
        resetSession()
    }

    private func performLeave() async {
        await transport.disconnect()
        connectionTask?.cancel()
        await connectionTask?.value
        connectionTask = nil
        resetSession()
        worldScene.showSplash()
        presentedSheet = .login
    }

    /// Common state reset shared by the authentication-time teardown and the
    /// menu-driven Leave Game path. Clears every transient slot the next session
    /// must start clean from — including `pendingRegistration`, which would
    /// otherwise survive a Hello-mismatch teardown and silently re-issue a
    /// registration on the next reconnect.
    private func resetSession() {
        connectionState = .disconnected
        stopGameplayTicker()
        entities.removeAll()
        players.removeAll()
        inventory.removeAll()
        selfEntityIndex = nil
        currentSector = nil
        lastEmittedPosition = nil
        lastEmittedFacing = nil
        lastEmittedTempo = nil
        lastEmitTime = nil
        lastTickTime = nil
        lastBumpedNPC = nil
        lastBumpedPortalIndex = nil
        latestMouseFacing = nil
        pendingRegistration = nil
    }

    // MARK: - Gameplay ticker

    private let keyboard = KeyboardSampler()
    /// Latest cursor-derived facing from the play-field tracking area, applied by the gameplay tick.
    /// `nil` until the tracking area first reports the cursor (seeded on attach, then on each move).
    private var latestMouseFacing: Direction?
    private static let tickPeriodNanoseconds: UInt64 = 16_666_666
    /// Position-broadcast heartbeat (legacy `UpdateTimer`, 2 Hz): the local player moves smoothly
    /// via prediction every tick, but reports its position to the server at most this often.
    private static let positionHeartbeatInterval: TimeInterval = 0.5
    /// Peer-player interpolation matches the heartbeat so remote players tween across the ~500 ms
    /// gap rather than stepping; NPCs/monsters stay on the 50 ms server AI-tick cadence so they
    /// don't visibly lag the server.
    private static let peerInterpolationDuration: TimeInterval = 0.5
    private static let aiTickInterpolationDuration: TimeInterval = 0.05
    /// Upper bound on a single tick's elapsed time so a stall (or the first tick) cannot teleport
    /// the player; mirrors the PoC's clamp.
    private static let maxTickElapsed: TimeInterval = 0.1

    /// Receives the cursor-derived facing from the play-field tracking area
    /// (`MouseFacingTrackingView`). The gameplay tick applies it each frame.
    public func updateMouseFacing(_ direction: Direction) {
        latestMouseFacing = direction
    }

    public func startGameplayTicker() {
        guard tickerTask == nil else { return }
        keyboard.start()
        tickerTask = Task { [weak self] in
            while !Task.isCancelled {
                await MainActor.run { [weak self] in
                    self?.runOneGameplayTick()
                }
                try? await Task.sleep(nanoseconds: Self.tickPeriodNanoseconds)
            }
        }
    }

    public func stopGameplayTicker() {
        tickerTask?.cancel()
        tickerTask = nil
        keyboard.stop()
    }

    private func runOneGameplayTick() {
        // Gate the sampler's WASD capture on the live gameplay state. Refreshed each tick
        // (60 Hz, ~16ms latency) so opening a sheet or focusing the chat input releases
        // gameplay keys back to the responder chain without an explicit notify path.
        keyboard.isGameplayActive = connectionState == .attached
            && presentedSheet == nil
            && !isChatInputFocused
        guard !isChatInputFocused else { return }
        guard let selfIndex = selfEntityIndex,
              var selfEntity = entities[selfIndex],
              let sector = currentSector
        else { return }

        let held = keyboard.snapshot
        let tempo: Tempo = if held.leftShift {
            .run
        } else if held.leftOption {
            .walk
        } else {
            .default
        }

        // Refresh facing every tick regardless of velocity so a stationary player still
        // tracks the cursor — the legacy `quadrant()` rule is independent of movement.
        if let facing = latestMouseFacing {
            selfEntity.facing = facing
        }

        let now = Date()
        let elapsedSeconds = max(0, min(lastTickTime.map { now.timeIntervalSince($0) } ?? 0, Self.maxTickElapsed))
        lastTickTime = now

        let velocity = velocity(from: held)
        if velocity != .zero {
            // Elapsed-time-scaled step (legacy `tempo * 60 * frameintervall`) keeps speed
            // frame-rate-independent. `clamping:` because a sector wider/taller than 255 tiles has
            // a pixel extent beyond `Int16.max`; a plain `Int16(...)` would trap near the far edge.
            let pixels = tempo.pixelsPerSecond * elapsedSeconds
            let dxPx = Int32((velocity.dx * pixels).rounded())
            let dyPx = Int32((velocity.dy * pixels).rounded())
            // Clamp the step target to the sector's feet-box bounds so a move toward an edge lands
            // flush against it rather than stopping up to one tick short; `resolvedMove` still gates
            // collision masks and other entities per axis.
            let target = FeetMask.clamped(
                GridPoint(
                    x: Int16(clamping: Int32(selfEntity.position.x) + dxPx),
                    y: Int16(clamping: Int32(selfEntity.position.y) + dyPx)
                ),
                spriteSize: SomnioConstants.playerSpriteSize,
                sector: sector
            )
            let blockers = entityBlockerFeetRects(excludingSelf: selfIndex)
            selfEntity.position = resolvedMove(from: selfEntity.position, to: target, sector: sector, blockers: blockers)
        }
        selfEntity.tempo = velocity == .zero ? .default : tempo
        entities[selfIndex] = selfEntity
        worldScene.updatePosition(entityID: selfIndex, to: selfEntity.position, facing: selfEntity.facing)

        emitIfChanged(entity: selfEntity, tempo: selfEntity.tempo)
        checkBumpsAndPortals(selfEntity: selfEntity, sector: sector)
    }

    private func emitIfChanged(entity: WorldEntity, tempo: Tempo) {
        if lastEmittedPosition == entity.position,
           lastEmittedFacing == entity.facing,
           lastEmittedTempo == tempo {
            return
        }
        // Heartbeat gate: report at most every `positionHeartbeatInterval` (legacy 2 Hz
        // `UpdateTimer`). The last-emitted snapshot is left unchanged when throttled, so the next
        // tick past the interval still sees the move as pending and reports the final position.
        let now = Date()
        if let last = lastEmitTime, now.timeIntervalSince(last) < Self.positionHeartbeatInterval {
            return
        }
        lastEmitTime = now
        lastEmittedPosition = entity.position
        lastEmittedFacing = entity.facing
        lastEmittedTempo = tempo
        let message = PositionMessage(
            entityIndex: 0,
            x: entity.position.x,
            y: entity.position.y,
            facing: entity.facing.rawValue,
            tempo: tempo.rawValue
        )
        enqueue(.clientPosition(message))
    }

    private func checkBumpsAndPortals(selfEntity: WorldEntity, sector: Sector) {
        // Feet-center, not sprite-top-left, so bumps and portal exits trigger at the character's
        // feet (the original `maskxy + maskgroesse / 2` distance), matching the server gates.
        let playerCenter = FeetMask.center(forSpriteAt: selfEntity.position, spriteSize: SomnioConstants.playerSpriteSize)
        var bumped: Int16?
        for entity in entities.values where entity.kind == .npc {
            let npcCenter = FeetMask.center(forSpriteAt: entity.position, spriteSize: entity.maskSize)
            if VisualCenter.isWithin(npcCenter, playerCenter, radius: SomnioConstants.npcInteractionRadius) {
                bumped = entity.id
                break
            }
        }
        if let bumped, bumped != lastBumpedNPC {
            lastBumpedNPC = bumped
            enqueue(.bumpNPC(BumpNPCMessage(npcIndex: bumped)))
        } else if bumped == nil {
            lastBumpedNPC = nil
        }

        var portalHit: Int?
        for (index, portal) in sector.portals.enumerated() where portal.direction == .outboundTrigger {
            let portalRect = (
                x: Int32(portal.x),
                y: Int32(portal.y),
                width: Int32(portal.width),
                height: Int32(portal.height)
            )
            if playerCenter.x >= portalRect.x,
               playerCenter.x < portalRect.x + portalRect.width,
               playerCenter.y >= portalRect.y,
               playerCenter.y < portalRect.y + portalRect.height {
                portalHit = index
                break
            }
        }
        if let portalHit, portalHit != lastBumpedPortalIndex {
            lastBumpedPortalIndex = portalHit
            enqueue(.enterPortal(EnterPortalMessage(portalIndex: Int16(portalHit))))
        } else if portalHit == nil {
            lastBumpedPortalIndex = nil
        }
    }

    private struct Velocity: Equatable {
        var dx: Double
        var dy: Double
        static let zero = Velocity(dx: 0, dy: 0)
    }

    private func velocity(from held: KeyboardSampler.Held) -> Velocity {
        var dx: Double = 0
        var dy: Double = 0
        if held.d { dx += 1 }
        if held.a { dx -= 1 }
        if held.w { dy -= 1 }
        if held.s { dy += 1 }
        guard dx != 0 || dy != 0 else { return .zero }
        let length = (dx * dx + dy * dy).squareRoot()
        return Velocity(dx: dx / length, dy: dy / length)
    }

    /// Axis-separated feet-box slide from `from` toward `to`. Each axis is committed only if the
    /// player's feet box at the candidate clears sector bounds, static masks, and `blockers`
    /// (other entities' feet boxes), so the player glides along a wall/entity instead of sticking
    /// — the original client-side `KollisionChecken` + `move`. Internal for `@testable` access.
    func resolvedMove(from: GridPoint, to: GridPoint, sector: Sector, blockers: [PixelRect]) -> GridPoint {
        var resolved = from
        let xCandidate = GridPoint(x: to.x, y: from.y)
        if Self.feetClear(at: xCandidate, sector: sector, blockers: blockers) {
            resolved.x = to.x
        }
        let yCandidate = GridPoint(x: resolved.x, y: to.y)
        if Self.feetClear(at: yCandidate, sector: sector, blockers: blockers) {
            resolved.y = to.y
        }
        return resolved
    }

    /// Feet-box clearance for the local player, pinning `playerSpriteSize`. Routes through the shared
    /// `FeetMask.isClear` so the predicted move uses the identical gate the per-sector actor accepts.
    static func feetClear(at position: GridPoint, sector: Sector, blockers: [PixelRect]) -> Bool {
        FeetMask.isClear(at: position, spriteSize: SomnioConstants.playerSpriteSize, sector: sector, blockers: blockers)
    }

    /// Feet boxes of every entity except the local player, used as movement blockers so the
    /// predictor won't let the player walk through peers, NPCs, or monsters.
    private func entityBlockerFeetRects(excludingSelf selfIndex: Int16) -> [PixelRect] {
        entities.values.compactMap { entity in
            guard entity.id != selfIndex else { return nil }
            return FeetMask.rect(forSpriteAt: entity.position, spriteSize: entity.maskSize)
        }
    }
}

// MARK: - Helpers

private extension Energy {
    static let zero = Energy(
        hpCurrent: 0,
        hpMax: 1,
        balanceCurrent: 0,
        balanceMax: 1,
        manaCurrent: 0,
        manaMax: 1
    )
}

/// Stand-in delegate captured when the view-model self-reference is `nil` during
/// teardown. Discards every event silently; it never gets invoked once the parent task
/// observes cancellation.
@MainActor private final class UnreachableDelegate: GameplayTransportDelegate {
    static let shared = UnreachableDelegate()
    func handle(_: GameplayTransportEvent) {}
}
