import Foundation
import Testing
@testable import SomnioCore

struct MapCodecRoundTripTests {
    @Test(arguments: [Float(0), 90, 137.5, 270, 359.96875])
    func `npc facing survives a write then read unchanged`(degrees: Float) throws {
        // NPC facing serializes as heading degrees under the stable `"direction"` JSON key,
        // including fractional headings.
        let body = SectorBody(
            version: 1,
            dimensions: GridSize(width: 4, height: 4),
            floorMaterialID: "grass-meadow",
            light: LightSetting(indoor: false, brightness: 100),
            npcs: [NPC(spawnOrigin: GridPoint(x: 1, y: 1),
                       spawnBoxSize: GridSize(width: 1, height: 1),
                       maskSize: GridSize(width: 1, height: 1),
                       name: "Libus", figure: 16, facing: Heading(degrees: degrees), behaviorTag: 0,
                       dialogScript: "Hi $name.")]
        )
        let restored = try MapCodec.read(MapCodec.write(body))
        #expect(restored.npcs.first?.facing == Heading(degrees: degrees))
    }
}
