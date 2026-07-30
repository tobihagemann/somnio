import Foundation
import Testing
@testable import SomnioProtocol

struct RoundTripTests {
    private func roundTrip(_ message: SomnioMessage) throws -> SomnioMessage {
        let bytes = try SomnioMessageEncoder.encode(message)
        return try SomnioMessageDecoder.decode(bytes)
    }

    @Test func login() throws {
        let m = SomnioMessage.login(LoginMessage(nickname: "Saibot", password: "hunter2"))
        #expect(try roundTrip(m) == m)
    }

    @Test func register() throws {
        let m = SomnioMessage.register(RegisterMessage(
            nickname: "Saibot", password: "p", passwordRepeat: "p",
            characterClass: 0, gender: 1, email: "info@example.com"
        ))
        #expect(try roundTrip(m) == m)
    }

    /// Heading arguments for the float round-trip guards below: `facing` is the codebase's
    /// first non-integer wire field, so a fractional value, the 0 boundary, and a near-360
    /// value are pinned to exact JSON round-trip equality.
    private static let headings: [Float] = [0.0, 137.5, 359.96875]

    @Test(arguments: headings)
    func `client position round-trips a continuous heading exactly`(heading: Float) throws {
        let m = SomnioMessage.clientPosition(PositionMessage(entityIndex: 0, x: 10, y: 20, facing: heading, tempo: 2))
        #expect(try roundTrip(m) == m)
    }

    @Test(arguments: headings)
    func `server position round-trips a continuous heading exactly`(heading: Float) throws {
        let m = SomnioMessage.serverPosition(PositionMessage(entityIndex: 7, x: 10, y: 20, facing: heading, tempo: 2))
        #expect(try roundTrip(m) == m)
    }

    @Test func `client say`() throws {
        let m = SomnioMessage.clientSay(SayMessage(entityIndex: 0, text: "Hallo Welt"))
        #expect(try roundTrip(m) == m)
    }

    @Test func `server say`() throws {
        let m = SomnioMessage.serverSay(SayMessage(entityIndex: 3, text: "?"))
        #expect(try roundTrip(m) == m)
    }

    @Test func `equip toggle`() throws {
        let m = SomnioMessage.equipToggle(EquipToggleMessage(slot: 1, hand: .left))
        #expect(try roundTrip(m) == m)
    }

    @Test func `bump NPC`() throws {
        let m = SomnioMessage.bumpNPC(BumpNPCMessage(npcIndex: 4))
        #expect(try roundTrip(m) == m)
    }

    @Test func `enter portal`() throws {
        let m = SomnioMessage.enterPortal(EnterPortalMessage(portalIndex: 2))
        #expect(try roundTrip(m) == m)
    }

    @Test func hello() throws {
        let m = SomnioMessage.hello(HelloMessage(protocolVersion: 1))
        #expect(try roundTrip(m) == m)
    }

    @Test func `login result`() throws {
        let m = SomnioMessage.loginResult(LoginResultMessage(result: .ok))
        #expect(try roundTrip(m) == m)
    }

    @Test(arguments: RegisterResultCode.allCases) func `register result`(_ result: RegisterResultCode) throws {
        let m = SomnioMessage.registerResult(RegisterResultMessage(result: result))
        #expect(try roundTrip(m) == m)
    }

    @Test func `enter sector`() throws {
        let sector = WireSector(
            name: "EdariaMitte",
            version: 1,
            dimensions: WireGridSize(width: 32, height: 24),
            floorMaterialID: "grass-meadow",
            light: WireLightSetting(indoor: false, brightness: 100),
            objects: [WireObject(x: 1, y: 2, modelID: "door", sourceWidth: 1, sourceHeight: 1, priority: 0)],
            collisionMasks: [WireCollisionMask(x: 0, y: 0, width: 1, height: 1)],
            portals: [WireSectorPortal(x: 0, y: 0, width: 1, height: 1, targetSectorName: "EdariaArena", direction: 0)],
            npcs: [],
            monsterSpawns: []
        )
        let m = SomnioMessage.enterSector(EnterSectorMessage(sector: sector))
        #expect(try roundTrip(m) == m)
    }

    @Test func `enter sector with NPCs and monster spawns`() throws {
        // Exercise the WireNPC (11 fields) and WireMonsterSpawn (13 fields including the
        // `bounded: Bool` byte) paths that the empty-arrays variant above never reaches.
        let sector = WireSector(
            name: "EdariaArena",
            version: 1,
            dimensions: WireGridSize(width: 16, height: 16),
            floorMaterialID: "stone-arena",
            light: WireLightSetting(indoor: true, brightness: 75),
            objects: [],
            collisionMasks: [],
            portals: [],
            npcs: [WireNPC(
                spawnX: 5, spawnY: 7, spawnBoxWidth: 2, spawnBoxHeight: 2,
                maskWidth: 1, maskHeight: 1, name: "Libus",
                figure: 12, direction: 137.5, behaviorTag: 0,
                dialogScript: "Hallo $name, willkommen!"
            )],
            monsterSpawns: [WireMonsterSpawn(
                spawnX: 10, spawnY: 12, spawnBoxWidth: 4, spawnBoxHeight: 4,
                monsterWidth: 1, monsterHeight: 1, name: "Gespenst",
                figure: 99, bounded: true,
                spawnHP: 100, spawnBalance: 100, spawnMana: 100,
                aiScriptIndex: 3
            )]
        )
        let m = SomnioMessage.enterSector(EnterSectorMessage(sector: sector))
        #expect(try roundTrip(m) == m)
    }

    @Test func `main character`() throws {
        let m = SomnioMessage.mainCharacter(MainCharacterMessage(entityIndex: 5))
        #expect(try roundTrip(m) == m)
    }

    @Test(arguments: headings)
    func entity(heading: Float) throws {
        let m = SomnioMessage.entity(EntityMessage(
            entityIndex: 9, figure: 0, gender: 1, maskWidth: 32, maskHeight: 48,
            type: .player, name: "Libus", x: 10, y: 12, facing: heading, tempo: 2
        ))
        #expect(try roundTrip(m) == m)
    }

    @Test func energy() throws {
        let m = SomnioMessage.energy(Energy(
            hpCurrent: 100, hpMax: 100, balanceCurrent: 50, balanceMax: 100, manaCurrent: 25, manaMax: 50
        ))
        #expect(try roundTrip(m) == m)
    }

    @Test func `date tick`() throws {
        let m = SomnioMessage.dateTick(DateTickMessage(hour: 12, minute: 0))
        #expect(try roundTrip(m) == m)
    }

    @Test func inventory() throws {
        let m = SomnioMessage.inventory(InventoryMessage(rows: [
            WireInventoryRow(slot: 0, category: 0, itemId: 0, extras: [WireInventoryExtra(key: "gold", value: 100)], equippedHand: .none),
            WireInventoryRow(slot: 1, category: 1, itemId: 0, extras: [], equippedHand: .right)
        ]))
        #expect(try roundTrip(m) == m)
    }

    @Test func leave() throws {
        let m = SomnioMessage.leave(LeaveMessage(entityIndex: 4, leftGame: true))
        #expect(try roundTrip(m) == m)
    }

    @Test func `admin say`() throws {
        let m = SomnioMessage.adminSay(AdminSayMessage(text: "Server restart in 5 minutes"))
        #expect(try roundTrip(m) == m)
    }

    // MARK: - Session resumption

    @Test func `redeem session`() throws {
        let m = SomnioMessage.redeemSession(RedeemSessionMessage(token: "0123456789abcdef"))
        #expect(try roundTrip(m) == m)
    }

    @Test func `revoke session`() throws {
        let m = SomnioMessage.revokeSession(RevokeSessionMessage(token: "0123456789abcdef"))
        #expect(try roundTrip(m) == m)
    }

    @Test func `session token`() throws {
        // 30 days in seconds overflows `Int16`, which is why the field is `Int32`.
        let m = SomnioMessage.sessionToken(SessionTokenMessage(token: "tok", expiresInSeconds: 2_592_000))
        #expect(try roundTrip(m) == m)
    }

    @Test func `session revoked`() throws {
        let m = SomnioMessage.sessionRevoked(SessionRevokedMessage(revoked: true))
        #expect(try roundTrip(m) == m)
    }

    /// `requestSessionToken` must stay Optional, and a `nil` must not reach the wire: an older
    /// client omitting it has to keep decoding, and a server must not see a key that changes its
    /// behavior for a client that never opted in. Both halves are what keep `helloVersion` at 3.
    @Test func `login omits the session-token request when nil`() throws {
        let m = SomnioMessage.login(LoginMessage(nickname: "Saibot", password: "hunter2"))
        let json = try #require(try String(data: SomnioMessageEncoder.encode(m), encoding: .utf8))
        #expect(!json.contains("requestSessionToken"))
        #expect(try roundTrip(m) == m)
    }

    @Test func `login round-trips an explicit session-token request`() throws {
        let m = SomnioMessage.login(
            LoginMessage(nickname: "Saibot", password: "hunter2", requestSessionToken: true)
        )
        #expect(try roundTrip(m) == m)
    }

    /// A pre-token client's `Login` frame — no `requestSessionToken` key at all — must still
    /// decode on a token-aware server. This is the skew case the Optional exists for.
    @Test func `a pre-token login frame still decodes`() throws {
        let legacy = Data(#"{"tag":"login","payload":{"nickname":"Saibot","password":"hunter2"}}"#.utf8)
        let decoded = try SomnioMessageDecoder.decode(legacy)
        guard case let .login(payload) = decoded else {
            Issue.record("expected .login")
            return
        }
        #expect(payload.nickname == "Saibot")
        #expect(payload.requestSessionToken == nil)
    }

    // MARK: - Nested-Codable conformance

    //
    // `SomnioMessage` ships a hand-rolled `Codable` conformance for the case where it's
    // nested inside another `Codable` value (i.e., not via `SomnioMessageEncoder` /
    // `SomnioMessageDecoder`). The framing path is exercised by every test above; these
    // tests pin the keyed-container `init(from:)` / `encode(to:)` switches by going through
    // a fresh `JSONEncoder` / `JSONDecoder` on `SomnioMessage` itself.

    private func nestedRoundTrip(_ message: SomnioMessage) throws -> SomnioMessage {
        let bytes = try JSONEncoder().encode(message)
        return try JSONDecoder().decode(SomnioMessage.self, from: bytes)
    }

    @Test(arguments: [
        SomnioMessage.login(LoginMessage(nickname: "n", password: "p")),
        SomnioMessage.hello(HelloMessage(protocolVersion: 1)),
        SomnioMessage.energy(Energy(hpCurrent: 1, hpMax: 2, balanceCurrent: 3, balanceMax: 4, manaCurrent: 5, manaMax: 6)),
        SomnioMessage.bumpNPC(BumpNPCMessage(npcIndex: 4)),
        SomnioMessage.dateTick(DateTickMessage(hour: 12, minute: 0)),
        SomnioMessage.leave(LeaveMessage(entityIndex: 4, leftGame: true)),
        SomnioMessage.adminSay(AdminSayMessage(text: "hi"))
    ])
    func `nested codable round trips`(_ message: SomnioMessage) throws {
        #expect(try nestedRoundTrip(message) == message)
    }

    @Test func `nested codable rejects unrecognized tag`() {
        let bytes = Data(#"{"tag":"bogusTag","payload":{}}"#.utf8)
        #expect(throws: SomnioProtocolError.unrecognizedTag("bogusTag")) {
            try JSONDecoder().decode(SomnioMessage.self, from: bytes)
        }
    }
}
