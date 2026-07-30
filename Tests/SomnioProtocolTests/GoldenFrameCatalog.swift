import Foundation
@testable import SomnioProtocol

/// The canonical cross-language fixture set: one named frame per message tag, plus fully
/// populated nested payloads.
///
/// This catalog is the *only* declaration of the fixture contents. The Swift side compares
/// `SomnioMessageEncoder` output against the committed JSON, and the TypeScript side decodes and
/// re-encodes the same file — which is what makes the invariant two-sided. A TS-only assertion
/// would not be connected to the Swift encoder at all, so a renamed Swift property would leave
/// the fixture untouched and CI green.
enum GoldenFrameCatalog {
    struct Entry {
        let name: String
        let message: SomnioMessage
    }

    /// Every tag must appear, so a new message cannot ship without a fixture.
    static let entries: [Entry] = [
        Entry(name: "login", message: .login(LoginMessage(nickname: "Saibot", password: "hunter2"))),
        Entry(
            name: "login-with-session-request",
            message: .login(LoginMessage(nickname: "Saibot", password: "hunter2", requestSessionToken: true))
        ),
        Entry(name: "register", message: .register(RegisterMessage(
            nickname: "Saibot", password: "passw0rd", passwordRepeat: "passw0rd",
            characterClass: 0, gender: 1, email: "info@example.com"
        ))),
        Entry(name: "clientPosition", message: .clientPosition(
            PositionMessage(entityIndex: 0, x: 10, y: 20, facing: 137.5, tempo: 2)
        )),
        Entry(name: "clientSay", message: .clientSay(SayMessage(entityIndex: 0, text: "Hallo Welt"))),
        Entry(name: "equipToggle", message: .equipToggle(EquipToggleMessage(slot: 1, hand: .right))),
        Entry(name: "bumpNPC", message: .bumpNPC(BumpNPCMessage(npcIndex: 4))),
        Entry(name: "enterPortal", message: .enterPortal(EnterPortalMessage(portalIndex: 2))),
        Entry(name: "redeemSession", message: .redeemSession(RedeemSessionMessage(token: "tok-abc"))),
        Entry(name: "revokeSession", message: .revokeSession(RevokeSessionMessage(token: "tok-abc"))),
        Entry(name: "hello", message: .hello(HelloMessage(protocolVersion: SomnioProtocolConstants.helloVersion))),
        Entry(name: "loginResult", message: .loginResult(LoginResultMessage(result: .ok))),
        Entry(name: "registerResult", message: .registerResult(RegisterResultMessage(result: .nameNotAllowed))),
        Entry(name: "enterSector", message: .enterSector(EnterSectorMessage(sector: populatedSector))),
        Entry(name: "mainCharacter", message: .mainCharacter(MainCharacterMessage(entityIndex: 5))),
        Entry(name: "entity", message: .entity(EntityMessage(
            entityIndex: 9, figure: 0, gender: 1, maskWidth: 32, maskHeight: 48,
            type: .player, name: "Libus", x: 10, y: 12, facing: 359.96875, tempo: 2
        ))),
        Entry(name: "serverPosition", message: .serverPosition(
            PositionMessage(entityIndex: 7, x: 10, y: 20, facing: 0, tempo: 4)
        )),
        Entry(name: "serverSay", message: .serverSay(SayMessage(entityIndex: 3, text: "Wer bist du?"))),
        Entry(name: "energy", message: .energy(Energy(
            hpCurrent: 100, hpMax: 100, balanceCurrent: 50, balanceMax: 100, manaCurrent: 25, manaMax: 50
        ))),
        Entry(name: "dateTick", message: .dateTick(DateTickMessage(hour: 7, minute: 33))),
        Entry(name: "inventory", message: .inventory(InventoryMessage(rows: [
            WireInventoryRow(
                slot: 0, category: 0, itemId: 0,
                extras: [WireInventoryExtra(key: "gold", value: 100)], equippedHand: .none
            ),
            WireInventoryRow(slot: 1, category: 1, itemId: 0, extras: [], equippedHand: .right)
        ]))),
        Entry(name: "leave", message: .leave(LeaveMessage(entityIndex: 4, leftGame: true))),
        Entry(name: "adminSay", message: .adminSay(AdminSayMessage(text: "Server restart in 5 minutes"))),
        Entry(name: "sessionToken", message: .sessionToken(
            SessionTokenMessage(token: "tok-abc", expiresInSeconds: 2_592_000)
        )),
        Entry(name: "sessionRevoked", message: .sessionRevoked(SessionRevokedMessage(revoked: true)))
    ]

    /// Every nested wire shape populated at once, so the fixture exercises `WireObject`'s
    /// rotation, the NPC's float heading, the monster spawn's `Bool`, and a floor patch.
    static let populatedSector = WireSector(
        name: "EdariaMitte",
        version: 1,
        dimensions: WireGridSize(width: 16, height: 12),
        floorMaterialID: "grass-meadow",
        light: WireLightSetting(indoor: false, brightness: 100),
        objects: [WireObject(
            x: 128, y: 256, modelID: "door",
            sourceWidth: 64, sourceHeight: 32, priority: 3, rotation: 270
        )],
        collisionMasks: [WireCollisionMask(x: 128, y: 256, width: 64, height: 32)],
        portals: [WireSectorPortal(
            x: 0, y: 0, width: 32, height: 32,
            targetSectorName: "Nordwiese", direction: 1
        )],
        npcs: [WireNPC(
            spawnX: 320, spawnY: 192, spawnBoxWidth: 64, spawnBoxHeight: 64,
            maskWidth: 32, maskHeight: 48, name: "Libus",
            figure: 16, direction: 270, behaviorTag: 0,
            dialogScript: "Hallo $name, willkommen!"
        )],
        monsterSpawns: [WireMonsterSpawn(
            spawnX: 640, spawnY: 384, spawnBoxWidth: 128, spawnBoxHeight: 128,
            monsterWidth: 32, monsterHeight: 48, name: "Gespenst",
            figure: 0, bounded: true,
            spawnHP: 100, spawnBalance: 100, spawnMana: 100, aiScriptIndex: 3
        )],
        floorPatches: [WireFloorPatch(floorMaterialID: "cobble-town", x: 0, y: 0, width: 512, height: 128)]
    )

    /// Canonical rendering of a frame: object keys sorted, so the comparison is over JSON
    /// *structure* rather than bytes.
    ///
    /// Byte comparison would be wrong here, not merely strict: `SomnioMessageEncoder` uses a bare
    /// `JSONEncoder()` with no `.sortedKeys`, so member order is unspecified and is not part of
    /// the wire contract. A byte-exact check would fail spuriously and train people to regenerate
    /// fixtures instead of reading them.
    static func canonicalJSON(_ data: Data) throws -> String {
        let object = try JSONSerialization.jsonObject(with: data)
        let canonical = try JSONSerialization.data(
            withJSONObject: object,
            options: [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes]
        )
        return String(decoding: canonical, as: UTF8.self)
    }
}
