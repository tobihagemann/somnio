import Foundation
import Testing
@testable import SomnioProtocol

/// Regression guard for "someone reorders a property and breaks the wire."
///
/// Each payload struct declares `CodingKeys: String, CaseIterable, CodingKey` explicitly.
/// These tests pin the canonical field order against `CodingKeys.allCases.map(\.rawValue)`.
/// Adding, removing, or reordering a `CodingKeys` case is a wire break and must trip a test.
struct FieldOrderTests {
    private func keys<Keys: CaseIterable & RawRepresentable>(_ keys: Keys.Type) -> [String] where Keys.RawValue == String {
        Keys.allCases.map(\.rawValue)
    }

    @Test func `login message order`() {
        #expect(keys(LoginMessage.CodingKeys.self) == ["nickname", "password"])
    }

    @Test func `register message order`() {
        #expect(keys(RegisterMessage.CodingKeys.self) == [
            "nickname", "password", "passwordRepeat", "characterClass", "gender", "email"
        ])
    }

    @Test func `position message order`() {
        #expect(keys(PositionMessage.CodingKeys.self) == ["entityIndex", "x", "y", "facing", "tempo"])
    }

    @Test func `say message order`() {
        #expect(keys(SayMessage.CodingKeys.self) == ["entityIndex", "text"])
    }

    @Test func `equip toggle message order`() {
        #expect(keys(EquipToggleMessage.CodingKeys.self) == ["slot", "hand"])
    }

    @Test func `bump NPC message order`() {
        #expect(keys(BumpNPCMessage.CodingKeys.self) == ["npcIndex"])
    }

    @Test func `enter portal message order`() {
        #expect(keys(EnterPortalMessage.CodingKeys.self) == ["portalIndex"])
    }

    @Test func `hello message order`() {
        #expect(keys(HelloMessage.CodingKeys.self) == ["protocolVersion"])
    }

    @Test func `login result message order`() {
        #expect(keys(LoginResultMessage.CodingKeys.self) == ["result"])
    }

    @Test func `register result message order`() {
        #expect(keys(RegisterResultMessage.CodingKeys.self) == ["result"])
    }

    @Test func `enter sector message order`() {
        #expect(keys(EnterSectorMessage.CodingKeys.self) == ["sector"])
    }

    @Test func `main character message order`() {
        #expect(keys(MainCharacterMessage.CodingKeys.self) == ["entityIndex"])
    }

    @Test func `entity message order`() {
        #expect(keys(EntityMessage.CodingKeys.self) == [
            "entityIndex", "figure", "gender", "maskWidth", "maskHeight",
            "type", "name", "x", "y", "facing", "tempo"
        ])
    }

    @Test func `energy order`() {
        #expect(keys(Energy.CodingKeys.self) == [
            "hpCurrent", "hpMax", "balanceCurrent", "balanceMax", "manaCurrent", "manaMax"
        ])
    }

    @Test func `date tick message order`() {
        #expect(keys(DateTickMessage.CodingKeys.self) == ["hour", "minute"])
    }

    @Test func `inventory message order`() {
        #expect(keys(InventoryMessage.CodingKeys.self) == ["rows"])
    }

    @Test func `leave message order`() {
        #expect(keys(LeaveMessage.CodingKeys.self) == ["entityIndex", "leftGame"])
    }

    @Test func `admin say message order`() {
        #expect(keys(AdminSayMessage.CodingKeys.self) == ["text"])
    }

    // MARK: - Wire DTO field order

    //
    // `EnterSectorMessage` and `InventoryMessage` carry these DTOs nested inside their
    // payloads. Their field order is equally load-bearing for the positional binary form,
    // so each one needs its own pin against `CodingKeys.allCases`.

    @Test func `wire grid point order`() {
        #expect(keys(WireGridPoint.CodingKeys.self) == ["x", "y"])
    }

    @Test func `wire grid size order`() {
        #expect(keys(WireGridSize.CodingKeys.self) == ["width", "height"])
    }

    @Test func `wire ground tile order`() {
        #expect(keys(WireGroundTile.CodingKeys.self) == ["tilesetIndex", "sourceX", "sourceY"])
    }

    @Test func `wire light setting order`() {
        #expect(keys(WireLightSetting.CodingKeys.self) == ["indoor", "brightness"])
    }

    @Test func `wire object order`() {
        #expect(keys(WireObject.CodingKeys.self) == [
            "x", "y", "tilesetIndex", "sourceX", "sourceY",
            "sourceWidth", "sourceHeight", "priority"
        ])
    }

    @Test func `wire collision mask order`() {
        #expect(keys(WireCollisionMask.CodingKeys.self) == ["x", "y", "width", "height"])
    }

    @Test func `wire sector portal order`() {
        #expect(keys(WireSectorPortal.CodingKeys.self) == [
            "x", "y", "width", "height", "targetSectorName", "direction"
        ])
    }

    @Test func `wire NPC order`() {
        #expect(keys(WireNPC.CodingKeys.self) == [
            "spawnX", "spawnY", "spawnBoxWidth", "spawnBoxHeight",
            "maskWidth", "maskHeight", "name", "figure", "direction",
            "behaviorTag", "dialogScript"
        ])
    }

    @Test func `wire monster spawn order`() {
        #expect(keys(WireMonsterSpawn.CodingKeys.self) == [
            "spawnX", "spawnY", "spawnBoxWidth", "spawnBoxHeight",
            "monsterWidth", "monsterHeight", "name", "figure", "bounded",
            "spawnHP", "spawnBalance", "spawnMana", "aiScriptIndex"
        ])
    }

    @Test func `wire sector order`() {
        #expect(keys(WireSector.CodingKeys.self) == [
            "name", "version", "dimensions", "ground", "light",
            "objects", "collisionMasks", "portals", "npcs", "monsterSpawns"
        ])
    }

    @Test func `wire inventory extra order`() {
        #expect(keys(WireInventoryExtra.CodingKeys.self) == ["key", "value"])
    }

    @Test func `wire inventory row order`() {
        #expect(keys(WireInventoryRow.CodingKeys.self) == [
            "slot", "category", "itemId", "extras", "equippedHand"
        ])
    }

    // MARK: - Top-level message tag bytes

    //
    // Pinning the SomnioMessageTag raw values is the wire-compat counterpart to the field
    // order tests. Bumping a tag silently breaks every running client; this test surfaces it
    // at build time.

    @Test func `somnio message tag bytes are stable`() {
        #expect(SomnioMessageTag.login.rawValue == 0x01)
        #expect(SomnioMessageTag.register.rawValue == 0x02)
        #expect(SomnioMessageTag.clientPosition.rawValue == 0x03)
        #expect(SomnioMessageTag.clientSay.rawValue == 0x04)
        #expect(SomnioMessageTag.equipToggle.rawValue == 0x05)
        #expect(SomnioMessageTag.bumpNPC.rawValue == 0x06)
        #expect(SomnioMessageTag.enterPortal.rawValue == 0x07)
        #expect(SomnioMessageTag.hello.rawValue == 0x10)
        #expect(SomnioMessageTag.loginResult.rawValue == 0x11)
        #expect(SomnioMessageTag.registerResult.rawValue == 0x12)
        #expect(SomnioMessageTag.enterSector.rawValue == 0x13)
        #expect(SomnioMessageTag.mainCharacter.rawValue == 0x14)
        #expect(SomnioMessageTag.entity.rawValue == 0x15)
        #expect(SomnioMessageTag.serverPosition.rawValue == 0x16)
        #expect(SomnioMessageTag.serverSay.rawValue == 0x17)
        #expect(SomnioMessageTag.energy.rawValue == 0x18)
        #expect(SomnioMessageTag.dateTick.rawValue == 0x19)
        #expect(SomnioMessageTag.inventory.rawValue == 0x1A)
        #expect(SomnioMessageTag.leave.rawValue == 0x1B)
        #expect(SomnioMessageTag.adminSay.rawValue == 0x1C)
    }
}
