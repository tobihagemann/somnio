import CoreGraphics
import Foundation
import SomnioCore
import SomnioProtocol
import SpriteKit
import Testing
@testable import SomnioApp
@testable import SomnioUI

@MainActor
struct ClientViewModelTests {
    @Test func `hello with the matching protocol version advances to awaitingLoginResult`() {
        let viewModel = makeViewModel()
        viewModel.loginForm.nickname = "Alice"
        viewModel.loginForm.password = "pw"
        viewModel.connectionState = .awaitingHello
        viewModel.handle(.message(.hello(HelloMessage(protocolVersion: SomnioProtocolConstants.helloVersion))))
        #expect(viewModel.connectionState == .awaitingLoginResult)
    }

    @Test func `hello with a newer server version presents the client-outdated update sheet`() {
        let viewModel = makeViewModel()
        viewModel.connectionState = .awaitingHello
        viewModel.handle(.message(.hello(HelloMessage(protocolVersion: SomnioProtocolConstants.helloVersion + 1))))
        #expect(viewModel.connectionState == .disconnected)
        #expect(viewModel.presentedSheet == .updateRequired(.clientOutdated))
        let hasVersionErrorCode = viewModel.chatLines.contains { line in
            if case .errorCode = line { return true }
            return false
        }
        #expect(!hasVersionErrorCode)
    }

    @Test func `hello with an older server version presents the server-outdated update sheet`() {
        let viewModel = makeViewModel()
        viewModel.connectionState = .awaitingHello
        viewModel.handle(.message(.hello(HelloMessage(protocolVersion: 0))))
        #expect(viewModel.connectionState == .disconnected)
        #expect(viewModel.presentedSheet == .updateRequired(.serverOutdated))
    }

    @Test func `loginResult ok sets selfDisplayName from the form`() {
        let viewModel = makeViewModel()
        viewModel.loginForm.nickname = "Alice"
        viewModel.loginForm.password = "pw"
        viewModel.connectionState = .awaitingLoginResult
        viewModel.handle(.message(.loginResult(LoginResultMessage(result: .ok))))
        #expect(viewModel.connectionState == .awaitingEnterSector)
        #expect(viewModel.selfDisplayName == "Alice")
    }

    @Test func `mainCharacter does not synthesize a placeholder; the authoritative self-Entity creates the player entry`() {
        let viewModel = makeViewModel()
        viewModel.connectionState = .awaitingEnterSector
        viewModel.handle(.message(.enterSector(EnterSectorMessage(sector: tinySector().asWire))))

        viewModel.handle(.message(.mainCharacter(MainCharacterMessage(entityIndex: 7))))
        // `handleMainCharacter` no longer synthesizes a placeholder; the entity entry only
        // appears after the authoritative `.entity` message arrives.
        #expect(viewModel.entities[7] == nil)
        #expect(viewModel.selfEntityIndex == 7)
        #expect(viewModel.connectionState == .attached)

        viewModel.handle(.message(.entity(EntityMessage(
            entityIndex: 7,
            figure: 3,
            gender: Gender.female.rawValue,
            maskWidth: 128,
            maskHeight: 128,
            type: .player,
            name: "Alice",
            x: 5,
            y: 9,
            facing: Direction.east.rawValue,
            tempo: Tempo.run.rawValue
        ))))

        let entity = viewModel.entities[7]
        #expect(entity?.kind == .player)
        #expect(entity?.figure == 3)
        #expect(entity?.gender == .female)
        #expect(entity?.position == GridPoint(x: 5, y: 9))
        #expect(entity?.facing == .east)
        #expect(entity?.tempo == .run)
        #expect(entity?.name == "Alice")
    }

    @Test func `the self entity is added to the online-players roster sorted, faithful to the legacy SpielerBox`() {
        let viewModel = makeViewModel()
        viewModel.connectionState = .awaitingEnterSector
        viewModel.handle(.message(.enterSector(EnterSectorMessage(sector: tinySector().asWire))))
        viewModel.handle(.message(.mainCharacter(MainCharacterMessage(entityIndex: 7))))
        // Deliberately non-alphabetical arrival order to exercise the sort.
        viewModel.handle(.message(.entity(EntityMessage(
            entityIndex: 7, figure: 0, gender: Gender.female.rawValue,
            maskWidth: 128, maskHeight: 128, type: .player, name: "Mallory",
            x: 5, y: 9, facing: Direction.east.rawValue, tempo: Tempo.default.rawValue
        ))))
        viewModel.handle(.message(.entity(EntityMessage(
            entityIndex: 5, figure: 0, gender: Gender.female.rawValue,
            maskWidth: 128, maskHeight: 128, type: .player, name: "Zoe",
            x: 1, y: 1, facing: Direction.south.rawValue, tempo: Tempo.default.rawValue
        ))))
        viewModel.handle(.message(.entity(EntityMessage(
            entityIndex: 3, figure: 0, gender: Gender.female.rawValue,
            maskWidth: 128, maskHeight: 128, type: .player, name: "Alice",
            x: 2, y: 2, facing: Direction.south.rawValue, tempo: Tempo.default.rawValue
        ))))
        #expect(viewModel.players == ["Alice", "Mallory", "Zoe"])
    }

    @Test func `a server position for self is applied as a direct camera-following set, not a tween`() throws {
        let (viewModel, scene) = makeViewModelWithScene()
        viewModel.connectionState = .awaitingEnterSector
        viewModel.handle(.message(.enterSector(EnterSectorMessage(sector: tinySector().asWire))))
        viewModel.handle(.message(.mainCharacter(MainCharacterMessage(entityIndex: 7))))
        viewModel.handle(.message(.entity(EntityMessage(
            entityIndex: 7, figure: 0, gender: Gender.male.rawValue,
            maskWidth: 32, maskHeight: 48, type: .player, name: "Me",
            x: 1, y: 1, facing: Direction.south.rawValue, tempo: Tempo.default.rawValue
        ))))

        // The server snaps the self player back to an authoritative position (a rejected move).
        viewModel.handle(.message(.serverPosition(PositionMessage(
            entityIndex: 7, x: 2, y: 3, facing: Direction.north.rawValue, tempo: Tempo.default.rawValue
        ))))

        let probe = try #require(scene._entityNodeProbe(for: 7))
        // Direct set, not a tween: the node itself moved to the authoritative position (x is not
        // Y-flipped, so the legacy x surfaces directly; it was placed at x=1), it holds no in-flight
        // `SKAction` (a tween would have left one running), and the camera re-centered to follow it.
        #expect(probe.nodePosition.x == 2)
        #expect(!probe.hasRunningActions)
        #expect(probe.cameraCenteredOnNode)
        #expect(viewModel.entities[7]?.position == GridPoint(x: 2, y: 3))
    }

    @Test func `first-login enterSector defers the sector reveal until the self entity is placed`() {
        let (viewModel, scene) = makeViewModelWithScene()
        viewModel.connectionState = .awaitingEnterSector
        viewModel.handle(.message(.enterSector(EnterSectorMessage(sector: tinySector().asWire))))
        // Held hidden with the splash up until the self entity lands — no origin-framed flicker.
        let held = scene._heldSwapProbe()
        #expect(held.sectorRootHidden)
        #expect(held.pendingPlayerReveal)
        #expect(held.splashPresent)

        viewModel.handle(.message(.mainCharacter(MainCharacterMessage(entityIndex: 7))))
        viewModel.handle(.message(.entity(EntityMessage(
            entityIndex: 7, figure: 0, gender: Gender.male.rawValue,
            maskWidth: 32, maskHeight: 48, type: .player, name: "Me",
            x: 1, y: 1, facing: Direction.south.rawValue, tempo: Tempo.default.rawValue
        ))))
        let revealed = scene._heldSwapProbe()
        #expect(!revealed.sectorRootHidden)
        #expect(!revealed.pendingPlayerReveal)
        #expect(!revealed.splashPresent)
    }

    @Test func `the view model drives the render surface for each inbound render event`() {
        // Injecting a non-SpriteKit spy proves the renderer-neutral seam: each inbound message that
        // should reach the renderer is dispatched through the protocol, guarding against a future
        // call-site silently dropping a dispatch through the erased `any WorldRenderSurface`.
        let spy = RenderSurfaceSpy()
        let viewModel = ClientViewModel(worldScene: spy)
        viewModel.connectionState = .awaitingEnterSector

        viewModel.handle(.message(.enterSector(EnterSectorMessage(sector: tinySector().asWire))))
        #expect(spy.loadedSectors.count == 1)
        #expect(spy.tintUpdates.count == 1)

        viewModel.handle(.message(.mainCharacter(MainCharacterMessage(entityIndex: 7))))
        viewModel.handle(.message(.entity(EntityMessage(
            entityIndex: 7, figure: 0, gender: Gender.male.rawValue,
            maskWidth: 32, maskHeight: 48, type: .player, name: "Me",
            x: 1, y: 1, facing: Direction.south.rawValue, tempo: Tempo.default.rawValue
        ))))
        #expect(spy.placedEntities.contains(7))

        // A server position for self is a direct set; for a peer it is an interpolated tween.
        viewModel.handle(.message(.serverPosition(PositionMessage(
            entityIndex: 7, x: 2, y: 3, facing: Direction.north.rawValue, tempo: Tempo.default.rawValue
        ))))
        #expect(spy.positionedEntities.contains(7))

        viewModel.handle(.message(.entity(EntityMessage(
            entityIndex: 9, figure: 0, gender: Gender.female.rawValue,
            maskWidth: 128, maskHeight: 128, type: .player, name: "Bob",
            x: 4, y: 4, facing: Direction.south.rawValue, tempo: Tempo.default.rawValue
        ))))
        viewModel.handle(.message(.serverPosition(PositionMessage(
            entityIndex: 9, x: 5, y: 5, facing: Direction.east.rawValue, tempo: Tempo.default.rawValue
        ))))
        #expect(spy.animatedEntities.contains(9))

        viewModel.handle(.message(.serverSay(SayMessage(entityIndex: 9, text: "hi"))))
        #expect(spy.speechBubbles.contains(9))

        viewModel.handle(.message(.leave(LeaveMessage(entityIndex: 9, leftGame: true))))
        #expect(spy.removedEntities.contains(9))

        // `updateDayNightTint` is also reached independently via the inbound `DateTick` path, not
        // only via `enterSector` — pin that dispatch so a dropped call in `handleDateTick` is caught.
        let tintBefore = spy.tintUpdates.count
        viewModel.handle(.message(.dateTick(DateTickMessage(hour: 8, minute: 24))))
        #expect(spy.tintUpdates.count == tintBefore + 1)
    }

    @Test func `leaveGame shows the splash on the render surface`() async {
        // `showSplash` is the one render call no inbound message drives — it fires only from the
        // async menu-driven leave path. Drive it through `leaveGame()` and poll the spy (bounded so
        // a regression fails rather than hangs) for the resulting splash.
        let spy = RenderSurfaceSpy()
        let viewModel = ClientViewModel(worldScene: spy)
        viewModel.connectionState = .attached

        viewModel.leaveGame()
        for _ in 0 ..< 1000 where spy.splashCount == 0 {
            await Task.yield()
        }
        #expect(spy.splashCount == 1)
    }

    @Test func `decodeFailed event appends errorCode and disconnects`() {
        let viewModel = makeViewModel()
        viewModel.connectionState = .awaitingHello
        viewModel.handle(.decodeFailed(NSError(domain: "test", code: 1)))
        #expect(viewModel.connectionState == .disconnected)
        let foundErrorCode = viewModel.chatLines.contains { line in
            if case .errorCode = line { return true }
            return false
        }
        #expect(foundErrorCode)
    }

    @Test func `peerEOF appends connectionLost and disconnects`() {
        let viewModel = makeViewModel()
        viewModel.connectionState = .attached
        viewModel.handle(.peerEOF)
        #expect(viewModel.connectionState == .disconnected)
        #expect(viewModel.chatLines.contains(.connectionLost))
    }

    @Test func `registerResult ok clears form, lastError, and re-presents login sheet`() {
        let viewModel = makeViewModel()
        viewModel.registrationForm.nickname = "alice"
        viewModel.registrationForm.password = "supersafe"
        viewModel.registrationForm.passwordRepeat = "supersafe"
        viewModel.registrationForm.email = "alice@example.com"
        viewModel.registrationForm.lastError = .failure
        viewModel.connectionState = .awaitingLoginResult
        viewModel.handle(.message(.registerResult(RegisterResultMessage(result: .ok))))
        #expect(viewModel.registrationForm.lastError == nil)
        #expect(viewModel.registrationForm.nickname == "")
        #expect(viewModel.presentedSheet == .login)
        #expect(viewModel.connectionState == .disconnected)
    }

    @Test func `registerResult nicknameExists surfaces typed error and tears down`() {
        let viewModel = makeViewModel()
        viewModel.connectionState = .awaitingLoginResult
        viewModel.handle(.message(.registerResult(RegisterResultMessage(result: .nicknameExists))))
        #expect(viewModel.registrationForm.lastError == .nicknameExists)
        #expect(viewModel.connectionState == .disconnected)
    }

    @Test func `registerResult nameNotAllowed surfaces typed error and tears down`() {
        let viewModel = makeViewModel()
        viewModel.connectionState = .awaitingLoginResult
        viewModel.handle(.message(.registerResult(RegisterResultMessage(result: .nameNotAllowed))))
        #expect(viewModel.registrationForm.lastError == .nameNotAllowed)
        #expect(viewModel.connectionState == .disconnected)
    }

    @Test func `registerResult failure surfaces typed error and tears down`() {
        let viewModel = makeViewModel()
        viewModel.connectionState = .awaitingLoginResult
        viewModel.handle(.message(.registerResult(RegisterResultMessage(result: .failure))))
        #expect(viewModel.registrationForm.lastError == .failure)
        #expect(viewModel.connectionState == .disconnected)
    }

    @Test func `loginResult badCredentials appends typed chat line`() {
        let viewModel = makeViewModel()
        viewModel.connectionState = .awaitingLoginResult
        viewModel.handle(.message(.loginResult(LoginResultMessage(result: .badCredentials))))
        #expect(viewModel.chatLines.contains(.badCredentials))
        #expect(viewModel.connectionState == .disconnected)
        #expect(viewModel.presentedSheet == .login)
    }

    @Test func `loginResult alreadyLoggedIn appends typed chat line`() {
        let viewModel = makeViewModel()
        viewModel.connectionState = .awaitingLoginResult
        viewModel.handle(.message(.loginResult(LoginResultMessage(result: .alreadyLoggedIn))))
        #expect(viewModel.chatLines.contains(.alreadyLoggedIn))
        #expect(viewModel.connectionState == .disconnected)
        #expect(viewModel.presentedSheet == .login)
    }

    @Test func `peer disconnect removes from entities and players and appends left chat line`() {
        let viewModel = makeViewModel()
        viewModel.connectionState = .attached
        viewModel.entities[5] = carol()
        viewModel.players = ["Carol"]
        viewModel.worldScene.placeEntity(carol())
        // A true disconnect carries `leftGame: true`.
        viewModel.handle(.message(.leave(LeaveMessage(entityIndex: 5, leftGame: true))))
        #expect(viewModel.entities[5] == nil)
        #expect(viewModel.players.contains("Carol") == false)
        #expect(viewModel.chatLines.contains(.left(playerName: "Carol")))
    }

    @Test func `peer sector change removes from entities and players without a left chat line`() {
        let viewModel = makeViewModel()
        viewModel.connectionState = .attached
        viewModel.entities[5] = carol()
        viewModel.players = ["Carol"]
        viewModel.worldScene.placeEntity(carol())
        let chatBefore = viewModel.chatLines.count
        // A portal hop to another sector detaches with `leftGame: false` — the peer is removed from
        // this sector's roster but did not quit, so no "left the game" line should appear.
        viewModel.handle(.message(.leave(LeaveMessage(entityIndex: 5, leftGame: false))))
        #expect(viewModel.entities[5] == nil)
        #expect(viewModel.players.contains("Carol") == false)
        #expect(viewModel.chatLines.count == chatBefore)
        #expect(!viewModel.chatLines.contains(.left(playerName: "Carol")))
    }

    private func carol() -> WorldEntity {
        WorldEntity(
            id: 5,
            kind: .peer,
            figure: 0,
            position: GridPoint(x: 1, y: 1),
            facing: .south,
            tempo: .default,
            maskSize: GridSize(width: 128, height: 128),
            name: "Carol"
        )
    }

    @Test func `self leave with leftGame triggers teardown`() {
        let viewModel = makeViewModel()
        viewModel.connectionState = .attached
        viewModel.selfEntityIndex = 7
        viewModel.handle(.message(.leave(LeaveMessage(entityIndex: 7, leftGame: true))))
        #expect(viewModel.connectionState == .disconnected)
    }

    @Test func `npc leave removes the entity silently (no chat line, no players mutation)`() {
        let viewModel = makeViewModel()
        viewModel.connectionState = .attached
        let npc = WorldEntity(
            id: 11,
            kind: .npc,
            figure: 0,
            position: GridPoint(x: 0, y: 0),
            facing: .south,
            tempo: .default,
            maskSize: GridSize(width: 128, height: 128),
            name: "Libus"
        )
        viewModel.entities[11] = npc
        viewModel.worldScene.placeEntity(npc)
        viewModel.players = ["Carol"]
        let chatBefore = viewModel.chatLines.count
        viewModel.handle(.message(.leave(LeaveMessage(entityIndex: 11, leftGame: false))))
        #expect(viewModel.entities[11] == nil)
        #expect(viewModel.players == ["Carol"])
        #expect(viewModel.chatLines.count == chatBefore)
    }

    @Test func `activating the cudgel enqueues an equip toggle for the right hand`() {
        let viewModel = makeViewModel()
        viewModel.connectionState = .attached
        var outbound: [SomnioMessage] = []
        viewModel._outboundProbe = { outbound.append($0) }
        viewModel.activateInventoryItem(InventoryRow(slot: 1, category: 1, itemId: 0, equippedHand: nil))
        let equips = outbound.compactMap { message -> EquipToggleMessage? in
            if case let .equipToggle(payload) = message { payload } else { nil }
        }
        #expect(equips.count == 1)
        #expect(equips.first?.slot == 1)
        #expect(equips.first?.hand == .right)
    }

    @Test func `activating an equipped cudgel enqueues an unequip`() {
        let viewModel = makeViewModel()
        viewModel.connectionState = .attached
        var outbound: [SomnioMessage] = []
        viewModel._outboundProbe = { outbound.append($0) }
        viewModel.activateInventoryItem(InventoryRow(slot: 1, category: 1, itemId: 0, equippedHand: .right))
        let equips = outbound.compactMap { message -> EquipToggleMessage? in
            if case let .equipToggle(payload) = message { payload } else { nil }
        }
        #expect(equips.first?.hand == WireHand.none)
    }

    @Test func `activating the purse posts the coin balance to chat without equipping`() {
        let viewModel = makeViewModel()
        viewModel.connectionState = .attached
        var outbound: [SomnioMessage] = []
        viewModel._outboundProbe = { outbound.append($0) }
        let purse = InventoryRow(
            slot: 0, category: 0, itemId: 0,
            extras: [InventoryExtra(key: InventoryExtra.goldKey, value: 100)]
        )
        viewModel.activateInventoryItem(purse)
        #expect(viewModel.chatLines.contains(.purseBalance(coins: 100)))
        #expect(!outbound.contains { if case .equipToggle = $0 { true } else { false } })
    }

    @Test func `activating an item while not attached does nothing`() {
        let viewModel = makeViewModel()
        viewModel.connectionState = .disconnected
        var outbound: [SomnioMessage] = []
        viewModel._outboundProbe = { outbound.append($0) }
        viewModel.activateInventoryItem(InventoryRow(slot: 1, category: 1, itemId: 0, equippedHand: nil))
        #expect(outbound.isEmpty)
        #expect(viewModel.chatLines.isEmpty)
    }

    @Test func `enterSector clears stale entities and self-index from the previous sector`() {
        let viewModel = makeViewModel()
        viewModel.connectionState = .attached
        viewModel.selfEntityIndex = 1
        viewModel.entities[1] = WorldEntity(
            id: 1, kind: .player, figure: 0,
            position: GridPoint(x: 99, y: 99),
            facing: .south, tempo: .default,
            maskSize: GridSize(width: 128, height: 128),
            name: "Old"
        )
        viewModel.players = ["Old peer"]
        viewModel.handle(.message(.enterSector(EnterSectorMessage(sector: tinySector().asWire))))
        #expect(viewModel.entities.isEmpty)
        #expect(viewModel.players.isEmpty)
        #expect(viewModel.selfEntityIndex == nil)
        #expect(viewModel.connectionState == .awaitingEnterSector)
    }

    @Test func `serverSay from a peer renders as spokenByPeer`() {
        let viewModel = makeViewModel()
        viewModel.connectionState = .attached
        let peer = WorldEntity(
            id: 9,
            kind: .peer,
            figure: 0,
            position: GridPoint(x: 0, y: 0),
            facing: .south,
            tempo: .default,
            maskSize: GridSize(width: 128, height: 128),
            name: "Bob"
        )
        viewModel.entities[9] = peer
        viewModel.worldScene.placeEntity(peer)
        viewModel.handle(.message(.serverSay(SayMessage(entityIndex: 9, text: "hi"))))
        #expect(viewModel.chatLines.contains(.spokenByPeer(senderName: "Bob", message: "hi")))
    }

    @Test func `resolvedMove passes a move that overlaps only the head, blocks one that overlaps the feet`() {
        let viewModel = makeViewModel()
        // Player sprite 32x48: at (100, 200) the feet box is (100, 232, 32, 16). A mask over the
        // head row (y 200-216) must not block; a mask over the feet row (y 232-248) must.
        let headMaskSector = collisionSector(masks: [CollisionMask(x: 100, y: 200, width: 32, height: 16)])
        #expect(
            viewModel.resolvedMove(from: GridPoint(x: 100, y: 100), to: GridPoint(x: 100, y: 200), sector: headMaskSector, blockers: [])
                == GridPoint(x: 100, y: 200)
        )
        let feetMaskSector = collisionSector(masks: [CollisionMask(x: 100, y: 232, width: 32, height: 16)])
        #expect(
            viewModel.resolvedMove(from: GridPoint(x: 100, y: 100), to: GridPoint(x: 100, y: 200), sector: feetMaskSector, blockers: [])
                == GridPoint(x: 100, y: 100)
        )
    }

    @Test func `resolvedMove is blocked by another entity's feet box`() {
        let viewModel = makeViewModel()
        let sector = collisionSector(masks: [])
        // A blocker whose feet box covers the target's feet box (100, 232, 32, 16).
        let blocker = FeetMask.rect(forSpriteAt: GridPoint(x: 100, y: 200), spriteSize: SomnioConstants.playerSpriteSize)
        #expect(
            viewModel.resolvedMove(from: GridPoint(x: 100, y: 100), to: GridPoint(x: 100, y: 200), sector: sector, blockers: [blocker])
                == GridPoint(x: 100, y: 100)
        )
        // Without the blocker the same move is accepted.
        #expect(
            viewModel.resolvedMove(from: GridPoint(x: 100, y: 100), to: GridPoint(x: 100, y: 200), sector: sector, blockers: [])
                == GridPoint(x: 100, y: 200)
        )
    }

    @Test func `entityBlockers makes a clear monster solid but drops one overlapping the player (soft-solid), peers always solid`() {
        let selfIndex: Int16 = 1
        let playerPos = GridPoint(x: 100, y: 100)
        let mask = GridSize(width: 32, height: 48)
        let playerFeet = FeetMask.rect(forSpriteAt: playerPos, spriteSize: SomnioConstants.playerSpriteSize)

        let selfEntity = worldEntity(selfIndex, .player, at: playerPos, mask: mask)
        let farMonster = worldEntity(2, .monster, at: GridPoint(x: 300, y: 300), mask: mask) // clear -> solid
        let onPlayerMonster = worldEntity(3, .monster, at: playerPos, mask: mask) // lagged onto player -> dropped
        let onPlayerPeer = worldEntity(4, .peer, at: playerPos, mask: mask) // peers stay solid when overlapping

        let blockers = ClientViewModel.entityBlockers(
            among: [selfEntity, farMonster, onPlayerMonster, onPlayerPeer],
            excludingSelf: selfIndex,
            playerFeet: playerFeet
        )

        // Four entities in, two blockers out: self and the overlapping monster are dropped; the far
        // monster and the (overlapping) peer remain.
        #expect(blockers.count == 2)
        #expect(blockers.contains(FeetMask.rect(forSpriteAt: farMonster.position, spriteSize: mask)))
        #expect(blockers.contains(FeetMask.rect(forSpriteAt: onPlayerPeer.position, spriteSize: mask)))
    }

    @Test func `soft-solid integration: resolvedMove lets the player slide off an overlapping monster but an overlapping peer still blocks`() {
        let viewModel = makeViewModel()
        let sector = collisionSector(masks: [])
        let selfIndex: Int16 = 1
        let mask = GridSize(width: 32, height: 48)
        let playerPos = GridPoint(x: 100, y: 100)
        let playerFeet = FeetMask.rect(forSpriteAt: playerPos, spriteSize: SomnioConstants.playerSpriteSize)
        // A small nudge whose feet box still overlaps a blocker sitting on the player — so the move
        // is decided by whether that blocker is solid, not by escaping its feet box outright.
        let nudge = GridPoint(x: 100, y: 104)
        let selfEntity = worldEntity(selfIndex, .player, at: playerPos, mask: mask)

        // Monster lagged onto the player -> dropped from the blocker set -> the nudge is allowed.
        let monsterBlockers = ClientViewModel.entityBlockers(
            among: [selfEntity, worldEntity(2, .monster, at: playerPos, mask: mask)], excludingSelf: selfIndex, playerFeet: playerFeet
        )
        #expect(viewModel.resolvedMove(from: playerPos, to: nudge, sector: sector, blockers: monsterBlockers) == nudge)

        // A peer at the same overlapping position stays solid -> the identical nudge is blocked.
        let peerBlockers = ClientViewModel.entityBlockers(
            among: [selfEntity, worldEntity(3, .peer, at: playerPos, mask: mask)], excludingSelf: selfIndex, playerFeet: playerFeet
        )
        #expect(viewModel.resolvedMove(from: playerPos, to: nudge, sector: sector, blockers: peerBlockers) == playerPos)
    }

    @Test func `resolvedMove slides along a wall that blocks one axis`() {
        let viewModel = makeViewModel()
        // Moving diagonally (100,100) -> (200,200). A mask over the X-candidate's feet box
        // (200, 132, 32, 16) blocks the X step, but the Y-candidate's feet box (100, 232, 32, 16)
        // is clear, so the player slides down the wall: X stays, Y advances.
        let sector = collisionSector(masks: [CollisionMask(x: 200, y: 132, width: 40, height: 40)])
        #expect(
            viewModel.resolvedMove(from: GridPoint(x: 100, y: 100), to: GridPoint(x: 200, y: 200), sector: sector, blockers: [])
                == GridPoint(x: 100, y: 200)
        )
    }

    @Test func `collisionTriggers fires the NPC bump and blocks when the step overlaps an NPC feet box`() {
        // 32x48 NPC feet box (faithful happy path): the AABB-blocked player sits well within the
        // server's 64 px center-to-center dialog gate.
        let npc = (index: Int16(3), rect: FeetMask.rect(forSpriteAt: GridPoint(x: 100, y: 100), spriteSize: SomnioConstants.playerSpriteSize))
        let steppingIn = FeetMask.rect(forSpriteAt: GridPoint(x: 110, y: 100), spriteSize: SomnioConstants.playerSpriteSize)
        let hit = ClientViewModel.collisionTriggers(playerFeetRect: steppingIn, npcFeetRects: [npc], portalTriggerRects: [])
        #expect(hit.bumpedNPC == 3)
        #expect(hit.blocked)
        #expect(hit.portal == nil)
        // One tile away: feet boxes don't overlap, so no hit and the step is not blocked.
        let away = FeetMask.rect(forSpriteAt: GridPoint(x: 100 + Int16(SomnioConstants.tileSize), y: 100), spriteSize: SomnioConstants.playerSpriteSize)
        let miss = ClientViewModel.collisionTriggers(playerFeetRect: away, npcFeetRects: [npc], portalTriggerRects: [])
        #expect(miss.bumpedNPC == nil)
        #expect(miss.blocked == false)
    }

    @Test(arguments: [
        // Two outbound bands: a narrow 32x8 that a center-point can step clean over (so the AABB
        // feet box must catch it) and a wide 180x18.
        PixelRect(x: 200, y: 300, width: 32, height: 8),
        PixelRect(x: 0, y: 300, width: 180, height: 18)
    ])
    func `collisionTriggers fires the portal trigger when the step overlaps an outbound rect`(portalRect: PixelRect) {
        let portal = (index: 2, rect: portalRect)
        // 32x16 player feet box landing on the band's top-left corner — overlaps both the narrow
        // and the wide exit.
        let onBand = PixelRect(x: portalRect.x, y: portalRect.y, width: 32, height: 16)
        let hit = ClientViewModel.collisionTriggers(playerFeetRect: onBand, npcFeetRects: [], portalTriggerRects: [portal])
        #expect(hit.portal == 2)
        #expect(hit.blocked)
        #expect(hit.bumpedNPC == nil)
    }

    @Test func `collisionTriggers reports both an NPC bump and a portal from one step`() {
        // A step whose feet box overlaps both an NPC feet box and a portal trigger fires both
        // (the tick enqueues a bumpNPC and an enterPortal) and blocks.
        let feet = FeetMask.rect(forSpriteAt: GridPoint(x: 100, y: 100), spriteSize: SomnioConstants.playerSpriteSize)
        let hit = ClientViewModel.collisionTriggers(
            playerFeetRect: feet,
            npcFeetRects: [(index: Int16(7), rect: feet)],
            portalTriggerRects: [(index: 4, rect: feet)]
        )
        #expect(hit.bumpedNPC == 7)
        #expect(hit.portal == 4)
        #expect(hit.blocked)
    }

    @Test func `collisionTriggers with no NPCs or portals is an all-clear`() {
        let feet = FeetMask.rect(forSpriteAt: GridPoint(x: 100, y: 100), spriteSize: SomnioConstants.playerSpriteSize)
        let clear = ClientViewModel.collisionTriggers(playerFeetRect: feet, npcFeetRects: [], portalTriggerRects: [])
        #expect(clear.bumpedNPC == nil)
        #expect(clear.portal == nil)
        #expect(clear.blocked == false)
    }

    @Test func `portalTriggerRects keeps each trigger's offset in the full portals array`() {
        // Arrival-placement portals (filtered out) interleaved between outbound triggers: a naive
        // re-enumeration would renumber the triggers 0,1. The server indexes the FULL array, so the
        // offsets must stay the original 1 and 3 (a wrong index → wrong-portal teleport).
        let sector = sectorWithPortals([
            SectorPortal(x: 0, y: 0, width: 32, height: 16, targetSectorName: "A", direction: .arrivalPlacement),
            SectorPortal(x: 32, y: 0, width: 32, height: 16, targetSectorName: "B", direction: .outboundTrigger),
            SectorPortal(x: 64, y: 0, width: 32, height: 16, targetSectorName: "C", direction: .arrivalPlacement),
            SectorPortal(x: 96, y: 0, width: 32, height: 16, targetSectorName: "D", direction: .outboundTrigger)
        ])
        let triggers = ClientViewModel.portalTriggerRects(in: sector)
        #expect(triggers.count == 2)
        #expect(triggers[0].index == 1)
        #expect(triggers[0].rect.x == 32)
        #expect(triggers[1].index == 3)
        #expect(triggers[1].rect.x == 96)
    }

    @Test func `a portal tick enqueues enterPortal and suppresses the stale clientPosition`() {
        // Holding a movement key, with the player's feet box already on an outbound trigger, fires
        // the portal this tick — the heartbeat must NOT also send a (now stale) old-sector position.
        let keyboard = KeyboardSampler()
        keyboard.updateForTest(keyCode: 2, down: true) // 'D'
        let viewModel = makeViewModel(keyboard: keyboard)

        let position = GridPoint(x: 100, y: 100)
        let feet = FeetMask.rect(forSpriteAt: position, spriteSize: SomnioConstants.playerSpriteSize)
        let portal = SectorPortal(
            x: Int16(feet.x), y: Int16(feet.y), width: Int16(feet.width), height: Int16(feet.height),
            targetSectorName: "B", direction: .outboundTrigger
        )
        prepareAttachedSelf(viewModel, at: position, sector: sectorWithPortals([portal]))

        var outbound: [SomnioMessage] = []
        viewModel._outboundProbe = { outbound.append($0) }
        viewModel._runSingleTick()

        #expect(outbound.contains { if case .enterPortal = $0 { true } else { false } })
        #expect(!outbound.contains { if case .clientPosition = $0 { true } else { false } })
    }

    @Test func `a non-portal moving tick still emits the clientPosition heartbeat`() {
        // Same setup minus the portal: the suppression is portal-specific, so a normal moving tick
        // reports position as before.
        let keyboard = KeyboardSampler()
        keyboard.updateForTest(keyCode: 2, down: true) // 'D'
        let viewModel = makeViewModel(keyboard: keyboard)
        prepareAttachedSelf(viewModel, at: GridPoint(x: 100, y: 100), sector: sectorWithPortals([]))

        var outbound: [SomnioMessage] = []
        viewModel._outboundProbe = { outbound.append($0) }
        viewModel._runSingleTick()

        #expect(outbound.contains { if case .clientPosition = $0 { true } else { false } })
        #expect(!outbound.contains { if case .enterPortal = $0 { true } else { false } })
    }

    @Test func `gaining chat-input focus clears keys held during the focus transition`() {
        let keyboard = KeyboardSampler()
        keyboard.updateForTest(keyCode: 13, down: true) // 'W' captured as focus is gained
        let viewModel = makeViewModel(keyboard: keyboard)

        viewModel.setChatInputFocused(true)

        #expect(viewModel.isChatInputFocused)
        #expect(keyboard.snapshot == KeyboardSampler.Held())
    }

    @Test func `losing chat-input focus clears the flag without dropping held keys`() {
        // Clearing is asymmetric: only focus *gain* drops held keys. On focus loss the held
        // bitset must survive so a movement key held across the transition keeps the player moving.
        let keyboard = KeyboardSampler()
        let viewModel = makeViewModel(keyboard: keyboard)
        viewModel.setChatInputFocused(true)
        keyboard.updateForTest(keyCode: 13, down: true) // 'W' pressed while focused

        viewModel.setChatInputFocused(false)

        #expect(viewModel.isChatInputFocused == false)
        #expect(keyboard.snapshot.w)
    }

    private func prepareAttachedSelf(_ viewModel: ClientViewModel, at position: GridPoint, sector: Sector) {
        viewModel.currentSector = sector
        viewModel.selfEntityIndex = 1
        viewModel.entities[1] = WorldEntity(
            id: 1, kind: .player, figure: 0, position: position, facing: .south,
            tempo: .default, maskSize: SomnioConstants.playerSpriteSize, name: "Me"
        )
        viewModel.connectionState = .attached
        viewModel.presentedSheet = nil
    }

    private func makeWorldScene() -> WorldScene {
        WorldScene(size: CGSize(width: 640, height: 480), assets: NullSpriteAssets())
    }

    private func makeViewModel(keyboard: KeyboardSampler) -> ClientViewModel {
        ClientViewModel(worldScene: makeWorldScene(), keyboard: keyboard)
    }

    private func makeViewModel() -> ClientViewModel {
        ClientViewModel(worldScene: makeWorldScene())
    }

    /// Returns the view model alongside the concrete `WorldScene` it drives, for the dispatch-wiring
    /// tests that reach SpriteKit-only render probes (`_entityNodeProbe`/`_heldSwapProbe`) the
    /// erased `WorldRenderSurface` seam does not expose.
    private func makeViewModelWithScene() -> (ClientViewModel, WorldScene) {
        let scene = makeWorldScene()
        return (ClientViewModel(worldScene: scene), scene)
    }

    private func worldEntity(
        _ id: Int16, _ kind: WorldEntity.Kind, at position: GridPoint,
        mask: GridSize = GridSize(width: 32, height: 48)
    ) -> WorldEntity {
        WorldEntity(
            id: id, kind: kind, figure: 0, position: position,
            facing: .south, tempo: .default, maskSize: mask, name: "e\(id)"
        )
    }

    private func tinySector() -> Sector {
        Sector(
            name: "Test",
            version: 1,
            dimensions: GridSize(width: 4, height: 4),
            ground: GroundTile(tilesetIndex: 0, sourceX: 0, sourceY: 0),
            light: LightSetting(indoor: true, brightness: 100)
        )
    }

    private func collisionSector(masks: [CollisionMask]) -> Sector {
        Sector(
            name: "Test",
            version: 1,
            dimensions: GridSize(width: 4, height: 4),
            ground: GroundTile(tilesetIndex: 0, sourceX: 0, sourceY: 0),
            light: LightSetting(indoor: true, brightness: 100),
            collisionMasks: masks
        )
    }

    private func sectorWithPortals(_ portals: [SectorPortal]) -> Sector {
        Sector(
            name: "Test",
            version: 1,
            dimensions: GridSize(width: 4, height: 4),
            ground: GroundTile(tilesetIndex: 0, sourceX: 0, sourceY: 0),
            light: LightSetting(indoor: true, brightness: 100),
            portals: portals
        )
    }
}

/// Records every render call the view model dispatches, so the dispatch-wiring test can assert
/// the view model drives the renderer-neutral `WorldRenderSurface` seam without a live renderer.
@MainActor
private final class RenderSurfaceSpy: WorldRenderSurface {
    private(set) var loadedSectors: [String] = []
    private(set) var placedEntities: [Int16] = []
    private(set) var positionedEntities: [Int16] = []
    private(set) var animatedEntities: [Int16] = []
    private(set) var tintUpdates: [(hour: Int16, minute: Int16)] = []
    private(set) var speechBubbles: [Int16] = []
    private(set) var removedEntities: [Int16] = []
    private(set) var splashCount = 0

    func load(sector: Sector, awaitingPlayerPlacement _: Bool) {
        loadedSectors.append(sector.name)
    }

    func placeEntity(_ entity: WorldEntity) {
        placedEntities.append(entity.id)
    }

    func updatePosition(entityID: Int16, to _: GridPoint, facing _: Direction) {
        positionedEntities.append(entityID)
    }

    func animateEntity(_ id: Int16, to _: GridPoint, facing _: Direction, duration _: TimeInterval) {
        animatedEntities.append(id)
    }

    func updateDayNightTint(hour: Int16, minute: Int16, sectorLight _: LightSetting) {
        tintUpdates.append((hour, minute))
    }

    func showSpeechBubble(above entityID: Int16, lines _: [String], lifetimeMs _: Int) {
        speechBubbles.append(entityID)
    }

    func removeEntity(id: Int16) {
        removedEntities.append(id)
    }

    func showSplash() {
        splashCount += 1
    }
}

@MainActor
private final class NullSpriteAssets: SpriteAssets {
    var entityFrameCount: Int {
        AssetManifest.legacyFallback.entityFrameCount
    }

    func groundTexture(tilesetIndex _: Int16, sourceX _: Int16, sourceY _: Int16) -> SKTexture? {
        nil
    }

    func objectTexture(tilesetIndex _: Int16, sourceX _: Int16, sourceY _: Int16, sourceWidth _: Int16, sourceHeight _: Int16) -> SKTexture? {
        nil
    }

    func entityTexture(figureIndex _: Int16, kind _: WorldEntity.Kind, facing _: Direction, frame _: Int) -> SKTexture? {
        nil
    }

    func animationStrip(name _: String) -> SKTexture? {
        nil
    }

    func splash() -> SKTexture? {
        nil
    }

    func speechBubble() -> SKTexture? {
        nil
    }
}
