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
    private var lastBumpedPortalIndex: Int?
    private let logger = Logger(label: "de.tobiha.somnio.app.gameplay")

    public init(
        worldScene: WorldScene,
        transport: GameplayTransport = GameplayTransport(),
        keyboard: KeyboardSampler = KeyboardSampler()
    ) {
        self.worldScene = worldScene
        self.transport = transport
        self.keyboard = keyboard
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
        case .unexpectedBinaryFrame:
            chatLines.append(.errorCode(code: "unexpected_binary_frame"))
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

    /// Tracks whether the chat input owns the keyboard. The gameplay tick already releases the
    /// sampler's capture while focused, but a movement or modifier key landing during the focus
    /// transition could survive into the next tick, so clear the held bitset immediately on focus
    /// gain as well.
    public func setChatInputFocused(_ focused: Bool) {
        isChatInputFocused = focused
        if focused { keyboard.clearHeldKeys() }
    }

    // MARK: - Inventory

    /// Double-clicking an inventory row activates that item, faithful to the legacy `InventarBox`
    /// DoubleClick: the cudgel toggles equip in its fixed hand (the right) — the player never picks
    /// a hand — and the purse reports its coin balance to the chat log rather than equipping.
    /// Re-toggling the cudgel sends `.none` to unequip; the server clears whatever else held that hand.
    public func activateInventoryItem(_ row: InventoryRow) {
        guard connectionState == .attached else { return }
        switch (row.category, row.itemId) {
        case (0, 0): // purse: report the coin balance to the chat log; not equippable
            chatLines.append(.purseBalance(coins: row.goldBalance))
        case (1, 0): // cudgel: toggle equip in the right hand
            let wireHand: WireHand = row.equippedHand == nil ? .right : .none
            enqueue(.equipToggle(EquipToggleMessage(slot: row.slot, hand: wireHand)))
        default:
            break
        }
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
            let skew: VersionSkew = payload.protocolVersion > SomnioProtocolConstants.helloVersion
                ? .clientOutdated
                : .serverOutdated
            beginAuthSocketTeardown()
            presentedSheet = .updateRequired(skew)
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
            lastBumpedPortalIndex = nil
            currentSector = sector
            // Hold the current visual until the self entity is placed, then swap — avoids a frame of
            // the new sector framed on its origin with no character. The held visual is the outgoing
            // sector on a portal hop, or the splash on first login (no outgoing sector to hold).
            worldScene.load(sector: sector, awaitingPlayerPlacement: true)
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
            // portal hop. The ticker keeps running (its `selfEntityIndex` guard makes it a
            // no-op until `mainCharacter`), so the keyboard monitor stays installed across the
            // hop: keys are still consumed (no responder-chain beep) and held WASD survives so
            // motion resumes on arrival, matching the legacy live-keyboard read.
            connectionState = .awaitingEnterSector
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
        // Mirror the legacy `SpielerBox`, which listed every character including the
        // local player and kept the roster sorted. Self is dropped on leave/teardown,
        // which clear the roster wholesale.
        if kind == .peer || kind == .player, !players.contains(entity.name) {
            players.append(entity.name)
            players.sort { $0.localizedStandardCompare($1) == .orderedAscending }
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
        // The local player's node is owned by the 60 Hz predictor (`updatePosition`, which also
        // drives the camera), so apply a server position for self — an authoritative `snapBack` after
        // a rejected move — as a direct set: a competing `SKAction` tween would fight the predictor's
        // per-frame node write and de-center the camera. Peers arrive on the ~500 ms heartbeat and
        // NPCs/monsters on the 50 ms AI tick, so those still tween across their gap or they lag.
        switch entity.kind {
        case .player:
            worldScene.updatePosition(entityID: payload.entityIndex, to: newPosition, facing: facing)
        case .peer, .npc, .monster:
            let duration = entity.kind == .peer ? Self.peerInterpolationDuration : Self.aiTickInterpolationDuration
            worldScene.animateEntity(payload.entityIndex, to: newPosition, facing: facing, duration: duration)
        }
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
                // A peer changing sectors detaches with `leftGame: false`; only a real
                // disconnect (`leftGame: true`) is a "left the game" event.
                if payload.leftGame {
                    chatLines.append(.left(playerName: leaving.name))
                }
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
        _outboundProbe?(message)
        Task { [transport] in
            await transport.enqueue(message)
        }
    }

    /// Test seam: when set, every outbound message is delivered here synchronously (before the async
    /// transport hop) so unit tests can assert what a tick enqueued without standing up a socket.
    /// `nil` in production.
    var _outboundProbe: ((SomnioMessage) -> Void)?

    /// Test seam: drives exactly one gameplay tick (the timer's per-frame body) so unit tests can
    /// assert per-tick outbound behavior without the `RunLoop`-paced ticker task.
    func _runSingleTick() {
        runOneGameplayTick()
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
        lastBumpedPortalIndex = nil
        latestMouseFacing = nil
        pendingRegistration = nil
    }

    // MARK: - Gameplay ticker

    private let keyboard: KeyboardSampler
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

    // swiftlint:disable:next function_body_length
    private func runOneGameplayTick() {
        // Gate the sampler's WASD capture on the live gameplay state. Refreshed each tick
        // (60 Hz, ~16ms latency) so opening a sheet or focusing the chat input releases
        // gameplay keys back to the responder chain without an explicit notify path. The
        // mid-switch `.awaitingEnterSector` state still counts as active so keys keep being
        // consumed (no responder-chain beep) and held state survives the hop — the tick's
        // `selfEntityIndex` guard below stops actual movement until the new character arrives,
        // and the legacy read the live keyboard across a sector switch so motion resumes if held.
        keyboard.isGameplayActive = (connectionState == .attached || connectionState == .awaitingEnterSector)
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
        var enteredPortal = false
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
            // Resolve bounds + static masks + solid entities (peers/monsters) first; NPCs are
            // excluded from the blocker set so the slide reaches the NPC's feet box rather than
            // stopping short of it (otherwise the feet-box overlap is never seen, no bump).
            let selfFeet = FeetMask.rect(forSpriteAt: selfEntity.position, spriteSize: SomnioConstants.playerSpriteSize)
            let blockers = entityBlockerFeetRects(excludingSelf: selfIndex, playerFeet: selfFeet)
            let candidate = resolvedMove(from: selfEntity.position, to: target, sector: sector, blockers: blockers)
            // Faithful unified collision (legacy `KollisionChecken`): the wall-resolved candidate's
            // feet box overlapping an NPC feet box or a portal trigger blocks the step at the
            // threshold (decision B) and fires the trigger. Testing the post-resolution candidate
            // (not the raw step) avoids triggering through a wall the player can't actually cross.
            let candidateFeet = FeetMask.rect(forSpriteAt: candidate, spriteSize: SomnioConstants.playerSpriteSize)
            let triggers = Self.collisionTriggers(
                playerFeetRect: candidateFeet,
                npcFeetRects: npcFeetRects(),
                portalTriggerRects: Self.portalTriggerRects(in: sector)
            )
            if !triggers.blocked {
                selfEntity.position = candidate
            }
            enteredPortal = dispatchTriggers(triggers)
        }
        selfEntity.tempo = velocity == .zero ? .default : tempo
        entities[selfIndex] = selfEntity
        worldScene.updatePosition(entityID: selfIndex, to: selfEntity.position, facing: selfEntity.facing)

        // A portal-blocked tick must not also report its now-stale old-sector position: the server
        // processes `.enterPortal` first and switches the connection to the destination sector, so a
        // trailing `.clientPosition` would apply the old coordinates in the new sector and snap the
        // player off the arrival placement. Suppress the heartbeat on the tick a portal fires.
        if !enteredPortal {
            emitIfChanged(entity: selfEntity, tempo: selfEntity.tempo)
        }
    }

    /// Sends the NPC-bump and portal-enter triggers for an overlapping step and reports whether a
    /// portal fired this tick. NPC bump is continuous (no latch — the server's `targetingEntity`
    /// gate makes repeats no-ops, the faithful 50 Hz re-send); the portal is latched so one
    /// threshold contact fires a single sector switch, cleared when the overlap releases.
    private func dispatchTriggers(_ triggers: CollisionTriggers) -> Bool {
        if let bumpedNPC = triggers.bumpedNPC {
            enqueue(.bumpNPC(BumpNPCMessage(npcIndex: bumpedNPC)))
        }
        guard let portalHit = triggers.portal else {
            lastBumpedPortalIndex = nil
            return false
        }
        if portalHit != lastBumpedPortalIndex {
            lastBumpedPortalIndex = portalHit
            enqueue(.enterPortal(EnterPortalMessage(portalIndex: Int16(portalHit))))
        }
        return true
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

    /// Outcome of the unified collision test: whether the step is blocked at the threshold, plus the
    /// NPC index to bump and/or the portal index to enter when their feet boxes were the blockers.
    struct CollisionTriggers {
        var bumpedNPC: Int16?
        var portal: Int?
        var blocked: Bool {
            bumpedNPC != nil || portal != nil
        }
    }

    /// Faithful unification of the legacy `KollisionChecken` for both NPC bumps and portal
    /// triggers: the player's feet box at the attempted next step overlapping an NPC feet box or a
    /// portal `.outboundTrigger` rect is a hit that blocks the step and fires the trigger. AABB
    /// overlap via `CollisionMaskOverlap.overlaps` (right/bottom-exclusive — the move gate's
    /// polarity). Pure and `internal` for `@testable` unit coverage, mirroring `resolvedMove`.
    static func collisionTriggers(
        playerFeetRect: PixelRect,
        npcFeetRects: [(index: Int16, rect: PixelRect)],
        portalTriggerRects: [(index: Int, rect: PixelRect)]
    ) -> CollisionTriggers {
        var bumpedNPC: Int16?
        for npc in npcFeetRects where CollisionMaskOverlap.overlaps(playerFeetRect, npc.rect) {
            bumpedNPC = npc.index
            break
        }
        var portal: Int?
        for trigger in portalTriggerRects where CollisionMaskOverlap.overlaps(playerFeetRect, trigger.rect) {
            portal = trigger.index
            break
        }
        return CollisionTriggers(bumpedNPC: bumpedNPC, portal: portal)
    }

    /// NPC feet boxes paired with their entity index, fed to `collisionTriggers`. NPCs are
    /// excluded from the movement blocker set (`entityBlockerFeetRects`) so the slide reaches the
    /// NPC's feet box; this re-introduces them as bump targets for the unified trigger.
    private func npcFeetRects() -> [(index: Int16, rect: PixelRect)] {
        entities.values.compactMap { entity in
            guard entity.kind == .npc else { return nil }
            return (entity.id, FeetMask.rect(forSpriteAt: entity.position, spriteSize: entity.maskSize))
        }
    }

    /// `.outboundTrigger` portal rects paired with their offset in the FULL `sector.portals`
    /// array — the server's `handleEnterPortal` indexes `staticSector.portals[portalIndex]`
    /// against the full array, so the offset must survive the trigger filter (a filtered
    /// re-enumeration would send the wrong index → wrong-portal teleport / `snapBack`). Static and
    /// `internal` for `@testable` offset-fidelity coverage, mirroring `collisionTriggers`.
    static func portalTriggerRects(in sector: Sector) -> [(index: Int, rect: PixelRect)] {
        sector.portals.enumerated().compactMap { offset, portal in
            guard portal.direction == .outboundTrigger else { return nil }
            return (offset, PixelRect(
                x: Int32(portal.x),
                y: Int32(portal.y),
                width: Int32(portal.width),
                height: Int32(portal.height)
            ))
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

    /// Movement blockers for the predictor, wrapping the pure `entityBlockers` with the live entity
    /// map and the player's current feet box.
    private func entityBlockerFeetRects(excludingSelf selfIndex: Int16, playerFeet: PixelRect) -> [PixelRect] {
        Self.entityBlockers(among: entities.values, excludingSelf: selfIndex, playerFeet: playerFeet)
    }

    /// Feet-box blockers for the predictor: peers are always solid; monsters are *soft-solid* — a
    /// monster the player is clear of blocks the step (no walking into one), but a monster already
    /// overlapping the player's feet box is dropped so the player can always slide free. Monsters
    /// move every 50 ms AI tick and can lag onto the player; a hard block there would trap the player
    /// with no escape — the legacy original avoided this by making monsters pass-through for the
    /// player entirely. NPCs are excluded so the slide reaches an NPC's feet box and
    /// `collisionTriggers` fires the bump instead of stopping short. Static and `internal` for
    /// `@testable` coverage, mirroring `resolvedMove` / `collisionTriggers`.
    static func entityBlockers(
        among entities: some Sequence<WorldEntity>,
        excludingSelf selfIndex: Int16,
        playerFeet: PixelRect
    ) -> [PixelRect] {
        entities.compactMap { entity in
            guard entity.id != selfIndex, entity.kind != .npc else { return nil }
            let rect = FeetMask.rect(forSpriteAt: entity.position, spriteSize: entity.maskSize)
            if entity.kind == .monster, CollisionMaskOverlap.overlaps(playerFeet, rect) { return nil }
            return rect
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
