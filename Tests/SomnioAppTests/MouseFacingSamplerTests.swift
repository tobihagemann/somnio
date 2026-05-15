import CoreGraphics
import Foundation
import SomnioCore
import Testing
@testable import SomnioApp

struct MouseFacingSamplerTests {
    private let center = CGPoint(x: 320, y: 240)

    @Test func `mouse to the east selects east`() {
        let result = MouseFacingSampler.facingQuadrant(
            mouseLocation: CGPoint(x: 500, y: 240),
            viewCenter: center
        )
        #expect(result == .east)
    }

    @Test func `mouse to the west selects west`() {
        let result = MouseFacingSampler.facingQuadrant(
            mouseLocation: CGPoint(x: 100, y: 240),
            viewCenter: center
        )
        #expect(result == .west)
    }

    @Test func `mouse to the north selects north (positive y delta)`() {
        let result = MouseFacingSampler.facingQuadrant(
            mouseLocation: CGPoint(x: 320, y: 400),
            viewCenter: center
        )
        #expect(result == .north)
    }

    @Test func `mouse to the south selects south (negative y delta)`() {
        let result = MouseFacingSampler.facingQuadrant(
            mouseLocation: CGPoint(x: 320, y: 100),
            viewCenter: center
        )
        #expect(result == .south)
    }

    @Test func `tie at 45 degrees prefers horizontal axis`() {
        let result = MouseFacingSampler.facingQuadrant(
            mouseLocation: CGPoint(x: 420, y: 340),
            viewCenter: center
        )
        #expect(result == .east)
    }
}
