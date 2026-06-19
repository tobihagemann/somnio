import Foundation
import Testing
@testable import SomnioCore

struct VisualCenterTests {
    @Test func `isWithin includes the boundary at exactly the radius`() {
        let a: (x: Int32, y: Int32) = (0, 0)
        let b: (x: Int32, y: Int32) = (64, 0)
        #expect(VisualCenter.isWithin(a, b, radius: SomnioConstants.npcInteractionRadius))
    }

    @Test func `isWithin rejects a point beyond the monster aggro radius`() {
        // (192, 192) is outside the 192-px radius (squared distance is 73728, radius squared
        // is 36864).
        let a: (x: Int32, y: Int32) = (0, 0)
        let b: (x: Int32, y: Int32) = (192, 192)
        #expect(VisualCenter.isWithin(a, b, radius: SomnioConstants.monsterAggroRadius) == false)
    }

    @Test func `isWithin handles just inside and just outside the radius`() {
        let origin: (x: Int32, y: Int32) = (0, 0)
        let inside: (x: Int32, y: Int32) = (100, 0)
        let outside: (x: Int32, y: Int32) = (101, 0)
        #expect(VisualCenter.isWithin(origin, inside, radius: 100))
        #expect(VisualCenter.isWithin(origin, outside, radius: 100) == false)
    }

    @Test func `squaredDistance accumulates in Int64 without overflow near max coordinates`() {
        // Centers near `Int32.max` would overflow an `Int32` square; the helper promotes to
        // `Int64` so a maliciously large sector deployment cannot trap the AI tick.
        let a: (x: Int32, y: Int32) = (0, 0)
        let b: (x: Int32, y: Int32) = (Int32.max, Int32.max)
        let expected = 2 * Int64(Int32.max) * Int64(Int32.max)
        #expect(VisualCenter.squaredDistance(a, b) == expected)
    }
}
