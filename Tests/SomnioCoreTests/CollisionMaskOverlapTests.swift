import Foundation
import Testing
@testable import SomnioCore

struct CollisionMaskOverlapTests {
    @Test func `position outside masks returns false`() {
        let result = CollisionMaskOverlap.contains(
            GridPoint(x: 0, y: 0),
            in: [CollisionMask(x: 100, y: 100, width: 32, height: 32)]
        )
        #expect(result == false)
    }

    @Test func `position inside a mask returns true`() {
        let result = CollisionMaskOverlap.contains(
            GridPoint(x: 110, y: 110),
            in: [CollisionMask(x: 100, y: 100, width: 32, height: 32)]
        )
        #expect(result == true)
    }

    @Test func `right and bottom mask edges are exclusive`() {
        let masks = [CollisionMask(x: 0, y: 0, width: 10, height: 10)]
        #expect(CollisionMaskOverlap.contains(GridPoint(x: 9, y: 9), in: masks) == true)
        #expect(CollisionMaskOverlap.contains(GridPoint(x: 10, y: 10), in: masks) == false)
    }

    @Test func `int16 max edge mask does not trap the bounds check`() {
        let masks = [CollisionMask(x: Int16.max - 5, y: 0, width: 10, height: 10)]
        // Endpoint (`Int16.max - 5 + 10`) widens to Int32, so the comparison cannot
        // overflow Int16. The position itself doesn't matter — only that the loop
        // completes without trap.
        _ = CollisionMaskOverlap.contains(GridPoint(x: Int16.max, y: 0), in: masks)
    }
}
