import Foundation
import SomnioCore
import Testing
@testable import SomnioEditor

struct CursorReadoutTests {
    private static let body = SectorBody(
        version: 1,
        dimensions: GridSize(width: 4, height: 4),
        floorMaterialID: "grass-meadow",
        light: LightSetting(indoor: false, brightness: 100),
        collisionMasks: [CollisionMask(x: 10, y: 20, width: 30, height: 40)]
    )

    @Test func `a single selection tracks the record's size`() {
        let readout = CursorReadout()
        readout.applyBounds(for: [.mask(0)], in: Self.body)
        #expect(readout.width == 30)
        #expect(readout.height == 40)
    }

    @Test func `a multi-selection clears the size readout`() {
        let readout = CursorReadout()
        readout.applyBounds(for: [.mask(0)], in: Self.body)
        readout.applyBounds(for: [.mask(0), .object(0)], in: Self.body)
        #expect(readout.width == 0)
        #expect(readout.height == 0)
    }

    @Test func `an empty or stale selection clears the size readout`() {
        let readout = CursorReadout()
        readout.applyBounds(for: [.mask(0)], in: Self.body)
        readout.applyBounds(for: [], in: Self.body)
        #expect(readout.width == 0)
        #expect(readout.height == 0)
        readout.applyBounds(for: [.mask(9)], in: Self.body)
        #expect(readout.width == 0)
        #expect(readout.height == 0)
    }
}
