import Foundation
import SomnioCore
import Testing
@testable import SomnioServerCore

/// Coverage for `LoginHandler.resolvedSpawn` — the self-healing spawn correction applied at
/// login when a persisted position lands inside a collision mask. The full `handle` path
/// (auth + register + attach) is exercised elsewhere; this isolates the placement decision.
struct LoginHandlerSpawnTests {
    @Test func `resolvedSpawn is nil when the persisted position is walkable`() {
        let sector = makeSector(masks: [])
        let character = makeCharacter(at: GridPoint(x: 64, y: 64))
        #expect(LoginHandler.resolvedSpawn(for: character, in: sector) == nil)
    }

    @Test func `resolvedSpawn uses the arrival portal when the position is masked`() {
        let sector = makeSector(
            masks: [CollisionMask(x: 0, y: 0, width: 8, height: 8)],
            portals: [SectorPortal(x: 64, y: 64, width: 128, height: 128,
                                   targetSectorName: "S", direction: .arrivalPlacement)]
        )
        let character = makeCharacter(at: GridPoint(x: 0, y: 0)) // inside the mask
        let spawn = LoginHandler.resolvedSpawn(for: character, in: sector)
        #expect(spawn != nil)
        #expect(spawn == sector.arrivalSpawn)
    }

    @Test func `resolvedSpawn falls back to the sector center without an arrival portal`() {
        let sector = makeSector(masks: [CollisionMask(x: 0, y: 0, width: 8, height: 8)])
        let character = makeCharacter(at: GridPoint(x: 0, y: 0)) // inside the mask
        // 4x4 tiles * 128 = 512px extent; center = 256.
        #expect(LoginHandler.resolvedSpawn(for: character, in: sector) == GridPoint(x: 256, y: 256))
    }

    @Test func `resolvedSpawn falls back to the sector center when the arrival portal is fully masked`() {
        // A self-arrival portal exists but its rect is entirely covered by a collision mask, so
        // `arrivalSpawn` returns nil and the fallback must take over (not an unwalkable portal cell).
        let sector = makeSector(
            masks: [CollisionMask(x: 0, y: 0, width: 128, height: 128)],
            portals: [SectorPortal(x: 0, y: 0, width: 128, height: 128,
                                   targetSectorName: "S", direction: .arrivalPlacement)]
        )
        let character = makeCharacter(at: GridPoint(x: 0, y: 0)) // inside the mask
        #expect(sector.arrivalSpawn == nil)
        // 4x4 tiles * 128 = 512px extent; center = 256.
        #expect(LoginHandler.resolvedSpawn(for: character, in: sector) == GridPoint(x: 256, y: 256))
    }

    // MARK: - Helpers

    private func makeSector(masks: [CollisionMask], portals: [SectorPortal] = []) -> Sector {
        Sector(
            name: "S",
            version: 1,
            dimensions: GridSize(width: 4, height: 4),
            ground: GroundTile(tilesetIndex: 0, sourceX: 0, sourceY: 0),
            light: LightSetting(indoor: true, brightness: 100),
            collisionMasks: masks,
            portals: portals
        )
    }

    private func makeCharacter(at position: GridPoint) -> Character {
        Character(
            id: UUID(),
            name: "tester",
            figure: 0,
            gender: .male,
            currentSector: "S",
            position: position,
            facing: Heading(cardinal: .south),
            tempo: .default,
            energy: Energy(
                hpCurrent: 100, hpMax: 100,
                balanceCurrent: 100, balanceMax: 100,
                manaCurrent: 100, manaMax: 100
            ),
            lastSeen: Date()
        )
    }
}
