import Foundation
import Testing
@testable import SomnioCore

struct MapCodecRoundTripTests {
    @Test(arguments: [Int16(0), 1, 2, 3])
    func `npc direction survives a write then read unchanged`(direction: Int16) throws {
        // `NPC.direction` stores the legacy `richtung` encoding; the JSON codec serializes it as
        // a semantic `Direction` case name and restores the same int.
        let body = SectorBody(
            version: 1,
            dimensions: GridSize(width: 4, height: 4),
            ground: GroundTile(tilesetIndex: 0, sourceX: 0, sourceY: 0),
            light: LightSetting(indoor: false, brightness: 100),
            npcs: [NPC(spawnOrigin: GridPoint(x: 1, y: 1),
                       spawnBoxSize: GridSize(width: 1, height: 1),
                       maskSize: GridSize(width: 1, height: 1),
                       name: "Libus", figure: 16, direction: direction, behaviorTag: 0,
                       dialogScript: "Hi $name.")]
        )
        let restored = try MapCodec.read(MapCodec.write(body))
        #expect(restored.npcs.first?.direction == direction)
    }
}
