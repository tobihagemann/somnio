import CoreGraphics
import Foundation
import RealityKit
import simd
import SomnioCore
import SomnioProtocol
import Testing
@testable import SomnioApp
@testable import SomnioScene3D

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
            facing: Heading(cardinal: .east).degrees,
            tempo: Tempo.run.rawValue
        ))))

        let entity = viewModel.entities[7]
        #expect(entity?.kind == .player)
        #expect(entity?.figure == 3)
        #expect(entity?.gender == .female)
        #expect(entity?.position == GridPoint(x: 5, y: 9))
        #expect(entity?.facing == Heading(cardinal: .east))
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
            x: 5, y: 9, facing: Heading(cardinal: .east).degrees, tempo: Tempo.default.rawValue
        ))))
        viewModel.handle(.message(.entity(EntityMessage(
            entityIndex: 5, figure: 0, gender: Gender.female.rawValue,
            maskWidth: 128, maskHeight: 128, type: .player, name: "Zoe",
            x: 1, y: 1, facing: Heading(cardinal: .south).degrees, tempo: Tempo.default.rawValue
        ))))
        viewModel.handle(.message(.entity(EntityMessage(
            entityIndex: 3, figure: 0, gender: Gender.female.rawValue,
            maskWidth: 128, maskHeight: 128, type: .player, name: "Alice",
            x: 2, y: 2, facing: Heading(cardinal: .south).degrees, tempo: Tempo.default.rawValue
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
            x: 1, y: 1, facing: Heading(cardinal: .south).degrees, tempo: Tempo.default.rawValue
        ))))

        // The server snaps the self player back to an authoritative position (a rejected move).
        viewModel.handle(.message(.serverPosition(PositionMessage(
            entityIndex: 7, x: 2, y: 3, facing: Heading(cardinal: .north).degrees, tempo: Tempo.default.rawValue
        ))))

        let probe = try #require(scene._entityNodeProbe(for: 7))
        // Direct set, not a tween: the node itself moved to the authoritative position (its
        // feet-box center mapped onto the floor), no scene tween is in flight (a peer path
        // would have left one), and the camera re-centered to follow it.
        let feetCenter = FeetMask.center(forSpriteAt: GridPoint(x: 0, y: 0), spriteSize: GridSize(width: 32, height: 48))
        let expected = OrthographicCameraRig.worldPosition(forLegacyPoint: SIMD2<Float>(
            Float(feetCenter.x) + 2, Float(feetCenter.y) + 3
        ))
        #expect(length(probe.nodePosition - expected) < 1e-4)
        #expect(!probe.hasActiveTween)
        #expect(scene.cameraEntity.position == OrthographicCameraRig.cameraPosition(focusing: probe.nodePosition))
        #expect(viewModel.entities[7]?.position == GridPoint(x: 2, y: 3))
    }

    @Test func `first-login enterSector defers the sector reveal until the self entity is placed`() {
        let (viewModel, scene) = makeViewModelWithScene()
        viewModel.connectionState = .awaitingEnterSector
        viewModel.handle(.message(.enterSector(EnterSectorMessage(sector: tinySector().asWire))))
        // Held disabled until the self entity lands — no origin-framed flicker.
        let held = scene._heldSwapProbe()
        #expect(held.sectorRootEnabled == false)
        #expect(held.pendingPlayerReveal)

        viewModel.handle(.message(.mainCharacter(MainCharacterMessage(entityIndex: 7))))
        viewModel.handle(.message(.entity(EntityMessage(
            entityIndex: 7, figure: 0, gender: Gender.male.rawValue,
            maskWidth: 32, maskHeight: 48, type: .player, name: "Me",
            x: 1, y: 1, facing: Heading(cardinal: .south).degrees, tempo: Tempo.default.rawValue
        ))))
        let revealed = scene._heldSwapProbe()
        #expect(revealed.sectorRootEnabled == true)
        #expect(!revealed.pendingPlayerReveal)
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
            x: 1, y: 1, facing: Heading(cardinal: .south).degrees, tempo: Tempo.default.rawValue
        ))))
        #expect(spy.placedEntities.contains(7))

        // A server position for self is a direct set; for a peer it is an interpolated tween.
        viewModel.handle(.message(.serverPosition(PositionMessage(
            entityIndex: 7, x: 2, y: 3, facing: Heading(cardinal: .north).degrees, tempo: Tempo.default.rawValue
        ))))
        #expect(spy.positionedEntities.contains(7))

        viewModel.handle(.message(.entity(EntityMessage(
            entityIndex: 9, figure: 0, gender: Gender.female.rawValue,
            maskWidth: 128, maskHeight: 128, type: .player, name: "Bob",
            x: 4, y: 4, facing: Heading(cardinal: .south).degrees, tempo: Tempo.default.rawValue
        ))))
        viewModel.handle(.message(.serverPosition(PositionMessage(
            entityIndex: 9, x: 5, y: 5, facing: Heading(cardinal: .east).degrees, tempo: Tempo.default.rawValue
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
            facing: Heading(cardinal: .south),
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
            facing: Heading(cardinal: .south),
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
            facing: Heading(cardinal: .south), tempo: .default,
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
            facing: Heading(cardinal: .south),
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

    @Test func `a facing turn past the emit threshold reports clientPosition without movement`() async throws {
        let viewModel = makeViewModel()
        prepareAttachedSelf(viewModel, at: GridPoint(x: 100, y: 100), sector: sectorWithPortals([]))
        var outbound: [SomnioMessage] = []
        viewModel._outboundProbe = { outbound.append($0) }
        viewModel.updateMouseFacing(Heading(degrees: 90))
        viewModel._runSingleTick() // baseline report
        outbound.removeAll()

        // Outwait the 0.5 s heartbeat so the threshold gate (not the heartbeat) decides.
        try await Task.sleep(for: .milliseconds(550))
        viewModel.updateMouseFacing(Heading(degrees: 95))
        viewModel._runSingleTick()

        let emitted = outbound.compactMap { if case let .clientPosition(m) = $0 { m } else { nil } }
        #expect(emitted.last?.facing == 95)
    }

    @Test func `facing jitter at the exact threshold boundary never reaches the wire`() async throws {
        let viewModel = makeViewModel()
        prepareAttachedSelf(viewModel, at: GridPoint(x: 100, y: 100), sector: sectorWithPortals([]))
        var outbound: [SomnioMessage] = []
        viewModel._outboundProbe = { outbound.append($0) }
        viewModel.updateMouseFacing(Heading(degrees: 90))
        viewModel._runSingleTick() // baseline report
        outbound.removeAll()

        // Past the heartbeat, so only the threshold can be suppressing the report. Exactly
        // 1° pins the gate's inclusive comparison — the boundary itself is suppressed.
        try await Task.sleep(for: .milliseconds(550))
        viewModel.updateMouseFacing(Heading(degrees: 91))
        viewModel._runSingleTick()

        #expect(!outbound.contains { if case .clientPosition = $0 { true } else { false } })
    }

    @Test func `a facing turn inside the heartbeat window stays throttled to 2 Hz`() {
        // A large turn right after a report must still wait out the heartbeat — otherwise
        // facing-only updates would bypass the 2 Hz cadence and emit at tick rate.
        let viewModel = makeViewModel()
        prepareAttachedSelf(viewModel, at: GridPoint(x: 100, y: 100), sector: sectorWithPortals([]))
        var outbound: [SomnioMessage] = []
        viewModel._outboundProbe = { outbound.append($0) }
        viewModel.updateMouseFacing(Heading(degrees: 90))
        viewModel._runSingleTick() // baseline report
        outbound.removeAll()

        viewModel.updateMouseFacing(Heading(degrees: 180))
        viewModel._runSingleTick()

        #expect(!outbound.contains { if case .clientPosition = $0 { true } else { false } })
    }

    @Test func `facing jitter across the wrap seam measures as a small turn, not a revolution`() async throws {
        // 359.75° → 0.25° is a 0.5° wobble across the 0°/360° seam; a naive degree difference
        // would read it as ~359.5° and emit on every heartbeat.
        let viewModel = makeViewModel()
        prepareAttachedSelf(viewModel, at: GridPoint(x: 100, y: 100), sector: sectorWithPortals([]))
        var outbound: [SomnioMessage] = []
        viewModel._outboundProbe = { outbound.append($0) }
        viewModel.updateMouseFacing(Heading(degrees: 359.75))
        viewModel._runSingleTick() // baseline report
        outbound.removeAll()

        try await Task.sleep(for: .milliseconds(550))
        viewModel.updateMouseFacing(Heading(degrees: 0.25))
        viewModel._runSingleTick()

        #expect(!outbound.contains { if case .clientPosition = $0 { true } else { false } })
    }

    @Test func `a held screen-up walk renders sub-pixel positions on one straight world line`() async throws {
        // The rotated per-tick step rounds to alternating integer offsets; the rendered
        // sub-pixel positions must stay exactly on the continuous world line or the player
        // visibly wobbles sideways when walking up/down-screen.
        let keyboard = KeyboardSampler()
        keyboard.updateForTest(keyCode: 13, down: true) // 'W'
        let spy = RenderSurfaceSpy()
        let viewModel = ClientViewModel(worldScene: spy, keyboard: keyboard)
        prepareAttachedSelf(viewModel, at: GridPoint(x: 300, y: 300), sector: openSector())

        for _ in 0 ..< 12 {
            viewModel._runSingleTick()
            try await Task.sleep(for: .milliseconds(5))
        }

        let points = spy.subpixelPositions
        let origin = try #require(points.first)
        let travel = try #require(points.last)
        // The screen-up key crosses both world axes under the yawed camera.
        #expect(abs(travel.x - origin.x) > 0.5)
        #expect(abs(travel.y - origin.y) > 0.5)
        for point in points {
            let cross = (point.x - origin.x) * (travel.y - origin.y) - (point.y - origin.y) * (travel.x - origin.x)
            #expect(abs(cross) < 1e-9)
        }
        // Every tick also reports the movement tempo to the renderer's clip-selection seam.
        #expect(spy.tempoUpdates.last?.entityID == 1)
        #expect(spy.tempoUpdates.last?.tempo == .default)
    }

    @Test func `a blocked walk tick drops the whole sub-pixel carry`() async throws {
        // An NPC feet-box overlap blocks the step outright; the carried fraction from the
        // rejected path must not bias the rendered position, so every tick renders exactly
        // the unmoved grid position.
        let keyboard = KeyboardSampler()
        keyboard.updateForTest(keyCode: 13, down: true) // 'W'
        let spy = RenderSurfaceSpy()
        let viewModel = ClientViewModel(worldScene: spy, keyboard: keyboard)
        prepareAttachedSelf(viewModel, at: GridPoint(x: 300, y: 300), sector: openSector())
        // Screen-up walks toward decreasing world x and y under the 35° yaw; an NPC one step
        // up-screen keeps every candidate feet box overlapping its own.
        viewModel.entities[3] = worldEntity(3, .npc, at: GridPoint(x: 300, y: 296))

        for _ in 0 ..< 6 {
            viewModel._runSingleTick()
            try await Task.sleep(for: .milliseconds(25))
        }

        #expect(!spy.subpixelPositions.isEmpty)
        for point in spy.subpixelPositions {
            #expect(point == SubpixelPoint(x: 300, y: 300))
        }
    }

    @Test func `a wall-cut axis drops its sub-pixel carry while the free axis keeps moving`() async throws {
        // A mask band above the feet box blocks the world-Y step of a screen-up walk; the cut
        // axis must render exactly on the grid while the free X axis still travels sub-pixel.
        let keyboard = KeyboardSampler()
        keyboard.updateForTest(keyCode: 13, down: true) // 'W'
        let spy = RenderSurfaceSpy()
        let viewModel = ClientViewModel(worldScene: spy, keyboard: keyboard)
        let walled = openSector(collisionMasks: [CollisionMask(x: 0, y: 316, width: 640, height: 16)])
        prepareAttachedSelf(viewModel, at: GridPoint(x: 300, y: 300), sector: walled)

        for _ in 0 ..< 6 {
            viewModel._runSingleTick()
            try await Task.sleep(for: .milliseconds(25))
        }

        let travel = try #require(spy.subpixelPositions.last)
        #expect(travel.x < 297)
        for point in spy.subpixelPositions {
            #expect(point.y == 300)
        }
    }

    @Test func `a wall-cut on the other axis mirrors the drop: x pins to the grid while y keeps moving`() async throws {
        // The vertical twin of the horizontal band above: a wall band just west of the feet
        // box cuts the world-X step of the same screen-up walk, so the carried fraction must
        // drop on X while Y still travels sub-pixel.
        let keyboard = KeyboardSampler()
        keyboard.updateForTest(keyCode: 13, down: true) // 'W'
        let spy = RenderSurfaceSpy()
        let viewModel = ClientViewModel(worldScene: spy, keyboard: keyboard)
        let walled = openSector(collisionMasks: [CollisionMask(x: 284, y: 0, width: 16, height: 640)])
        prepareAttachedSelf(viewModel, at: GridPoint(x: 300, y: 300), sector: walled)

        for _ in 0 ..< 6 {
            viewModel._runSingleTick()
            try await Task.sleep(for: .milliseconds(25))
        }

        let travel = try #require(spy.subpixelPositions.last)
        #expect(travel.y < 297)
        for point in spy.subpixelPositions {
            #expect(point.x == 300)
        }
    }

    @Test func `an authoritative self correction drops the sub-pixel carry and applies the server tempo`() async throws {
        // A few walking ticks accumulate a fractional carry; the snapback replaces the
        // predicted position outright, so the next rendered position must sit exactly on the
        // corrected grid with no residual fraction from the rejected path.
        let keyboard = KeyboardSampler()
        keyboard.updateForTest(keyCode: 13, down: true) // 'W'
        let spy = RenderSurfaceSpy()
        let viewModel = ClientViewModel(worldScene: spy, keyboard: keyboard)
        prepareAttachedSelf(viewModel, at: GridPoint(x: 300, y: 300), sector: openSector())
        for _ in 0 ..< 4 {
            viewModel._runSingleTick()
            try await Task.sleep(for: .milliseconds(25))
        }

        keyboard.updateForTest(keyCode: 13, down: false)
        viewModel.handle(.message(.serverPosition(PositionMessage(
            entityIndex: 1, x: 256, y: 256, facing: Heading(cardinal: .south).degrees, tempo: Tempo.run.rawValue
        ))))
        viewModel._runSingleTick()

        let rendered = try #require(spy.subpixelPositions.last)
        #expect(rendered == SubpixelPoint(x: 256, y: 256))
        // The server-position path also forwards the authoritative tempo to the renderer.
        #expect(spy.tempoUpdates.contains { $0.entityID == 1 && $0.tempo == .run })
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
            id: 1, kind: .player, figure: 0, position: position, facing: Heading(cardinal: .south),
            tempo: .default, maskSize: SomnioConstants.playerSpriteSize, name: "Me"
        )
        viewModel.connectionState = .attached
        viewModel.presentedSheet = nil
    }

    private func makeWorldScene() -> WorldScene3D {
        WorldScene3D(modelAssets: NullModelAssets())
    }

    private func makeViewModel(keyboard: KeyboardSampler) -> ClientViewModel {
        ClientViewModel(worldScene: makeWorldScene(), keyboard: keyboard)
    }

    private func makeViewModel() -> ClientViewModel {
        ClientViewModel(worldScene: makeWorldScene())
    }

    /// Returns the view model alongside the concrete `WorldScene3D` it drives, for the
    /// dispatch-wiring tests that reach renderer-internal probes (`_entityNodeProbe`/
    /// `_heldSwapProbe`) the erased `WorldRenderSurface` seam does not expose.
    private func makeViewModelWithScene() -> (ClientViewModel, WorldScene3D) {
        let scene = makeWorldScene()
        return (ClientViewModel(worldScene: scene), scene)
    }

    private func worldEntity(
        _ id: Int16, _ kind: WorldEntity.Kind, at position: GridPoint,
        mask: GridSize = GridSize(width: 32, height: 48)
    ) -> WorldEntity {
        WorldEntity(
            id: id, kind: kind, figure: 0, position: position,
            facing: Heading(cardinal: .south), tempo: .default, maskSize: mask, name: "e\(id)"
        )
    }

    private func tinySector() -> Sector {
        Sector(
            name: "Test",
            version: 1,
            dimensions: GridSize(width: 4, height: 4),
            floorMaterialID: "grass-meadow",
            light: LightSetting(indoor: true, brightness: 100)
        )
    }

    /// Large enough that a dozen ticks of walking from the center never clamps at an edge.
    private func openSector(collisionMasks: [CollisionMask] = []) -> Sector {
        Sector(
            name: "Test",
            version: 1,
            dimensions: GridSize(width: 20, height: 20),
            floorMaterialID: "grass-meadow",
            light: LightSetting(indoor: true, brightness: 100),
            collisionMasks: collisionMasks
        )
    }

    private func collisionSector(masks: [CollisionMask]) -> Sector {
        Sector(
            name: "Test",
            version: 1,
            dimensions: GridSize(width: 4, height: 4),
            floorMaterialID: "grass-meadow",
            light: LightSetting(indoor: true, brightness: 100),
            collisionMasks: masks
        )
    }

    private func sectorWithPortals(_ portals: [SectorPortal]) -> Sector {
        Sector(
            name: "Test",
            version: 1,
            dimensions: GridSize(width: 4, height: 4),
            floorMaterialID: "grass-meadow",
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
    private(set) var subpixelPositions: [SubpixelPoint] = []
    private(set) var tempoUpdates: [(entityID: Int16, tempo: Tempo)] = []
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

    func updatePosition(entityID: Int16, to _: GridPoint, facing _: Heading) {
        positionedEntities.append(entityID)
    }

    func updatePosition(entityID: Int16, to position: SubpixelPoint, facing _: Heading) {
        positionedEntities.append(entityID)
        subpixelPositions.append(position)
    }

    func animateEntity(_ id: Int16, to _: GridPoint, facing _: Heading, duration _: TimeInterval) {
        animatedEntities.append(id)
    }

    func updateTempo(entityID: Int16, tempo: Tempo) {
        tempoUpdates.append((entityID, tempo))
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

/// Nil-resolving asset double: every entity and object renders the placeholder path, which
/// is all the view-model dispatch tests need from the renderer.
@MainActor
private final class NullModelAssets: ModelAssets {
    func prewarm() async {}

    func entity(forKind _: WorldEntity.Kind, figure _: Int16) -> Entity? {
        nil
    }

    func object(forID _: String) -> Entity? {
        nil
    }

    func floorMaterialTexture(forID _: String) -> TextureResource? {
        nil
    }

    func floorMaterialURL(forID _: String) -> URL? {
        nil
    }
}
