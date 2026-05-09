import Foundation
import Testing
@testable import SomnioCore

struct VisualCenterTests {
    @Test func `even sized mask centers at half width and half height`() {
        let center = VisualCenter.center(
            position: GridPoint(x: 0, y: 0),
            mask: GridSize(width: 128, height: 128)
        )
        #expect(center.x == 64)
        #expect(center.y == 64)
    }

    @Test func `odd sized mask truncates the half toward the origin`() {
        // Integer division: 65 / 2 == 32, not 32.5. Mirrors how Int32 indexing works for
        // tile-pixel coordinates throughout the codebase.
        let center = VisualCenter.center(
            position: GridPoint(x: 100, y: 200),
            mask: GridSize(width: 65, height: 65)
        )
        #expect(center.x == 132)
        #expect(center.y == 232)
    }

    @Test func `isWithin includes the boundary at exactly the radius`() {
        let a = VisualCenter.center(
            position: GridPoint(x: 0, y: 0),
            mask: GridSize(width: 0, height: 0)
        )
        let b = VisualCenter.center(
            position: GridPoint(x: 64, y: 0),
            mask: GridSize(width: 0, height: 0)
        )
        #expect(VisualCenter.isWithin(a, b, radius: SomnioConstants.npcInteractionRadius))
    }

    @Test func `isWithin rejects a point beyond the monster aggro radius`() {
        // (192, 192) is outside the 192-px radius (squared distance is 73728, radius squared
        // is 36864).
        let a = VisualCenter.center(
            position: GridPoint(x: 0, y: 0),
            mask: GridSize(width: 0, height: 0)
        )
        let b = VisualCenter.center(
            position: GridPoint(x: 192, y: 192),
            mask: GridSize(width: 0, height: 0)
        )
        #expect(VisualCenter.isWithin(a, b, radius: SomnioConstants.monsterAggroRadius) == false)
    }

    @Test func `center near max sector dimensions does not trap`() {
        // A player one pixel inside the right edge of a near-`Int16.max` sector with a
        // full-tile mask produces a center that overflows `Int16` arithmetic; the helper
        // must promote to `Int32` so the AI tick cannot be DoS-ed by a maliciously large
        // sector deployment.
        let center = VisualCenter.center(
            position: GridPoint(x: Int16.max - 1, y: Int16.max - 1),
            mask: GridSize(width: Int16.max, height: Int16.max)
        )
        let expected = Int32(Int16.max) - 1 + Int32(Int16.max) / 2
        #expect(center.x == expected)
        #expect(center.y == expected)
    }

    @Test func `isWithin handles just inside and just outside the radius`() {
        let origin = VisualCenter.center(
            position: GridPoint(x: 0, y: 0),
            mask: GridSize(width: 0, height: 0)
        )
        let inside = VisualCenter.center(
            position: GridPoint(x: 100, y: 0),
            mask: GridSize(width: 0, height: 0)
        )
        let outside = VisualCenter.center(
            position: GridPoint(x: 101, y: 0),
            mask: GridSize(width: 0, height: 0)
        )
        #expect(VisualCenter.isWithin(origin, inside, radius: 100))
        #expect(VisualCenter.isWithin(origin, outside, radius: 100) == false)
    }
}
