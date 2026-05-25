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
    @Test func `protocol mismatch on Hello tears down the connection`() {
        let viewModel = makeViewModel()
        viewModel.connectionState = .awaitingHello
        viewModel.handle(.message(.hello(HelloMessage(protocolVersion: 0))))
        #expect(viewModel.connectionState == .disconnected)
        #expect(viewModel.chatLines.contains(.errorCode(code: "0")))
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

    @Test func `peer leave removes from entities and players and appends left chat line`() {
        let viewModel = makeViewModel()
        viewModel.connectionState = .attached
        let peer = WorldEntity(
            id: 5,
            kind: .peer,
            figure: 0,
            position: GridPoint(x: 1, y: 1),
            facing: .south,
            tempo: .default,
            maskSize: GridSize(width: 128, height: 128),
            name: "Carol"
        )
        viewModel.entities[5] = peer
        viewModel.players = ["Carol"]
        viewModel.worldScene.placeEntity(peer)
        viewModel.handle(.message(.leave(LeaveMessage(entityIndex: 5, leftGame: false))))
        #expect(viewModel.entities[5] == nil)
        #expect(viewModel.players.contains("Carol") == false)
        #expect(viewModel.chatLines.contains(.left(playerName: "Carol")))
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

    private func makeViewModel() -> ClientViewModel {
        let scene = WorldScene(size: CGSize(width: 640, height: 480), assets: NullSpriteAssets())
        return ClientViewModel(worldScene: scene)
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
}

@MainActor
private final class NullSpriteAssets: SpriteAssets {
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
