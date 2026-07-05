import CoreGraphics
import Foundation
import SomnioCore
import Testing
@testable import SomnioApp

/// The sampler classifies in world floor axes (the screen offset rotated through the 3/4
/// camera's 35° yaw), so pure screen-axis cursor offsets still land in the expected quadrant
/// — the rotation only moves the boundaries, not the axis centers.
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

    @Test func `mouse up-screen selects north`() {
        let result = MouseFacingSampler.facingQuadrant(
            mouseLocation: CGPoint(x: 320, y: 400),
            viewCenter: center
        )
        #expect(result == .north)
    }

    @Test func `mouse down-screen selects south`() {
        let result = MouseFacingSampler.facingQuadrant(
            mouseLocation: CGPoint(x: 320, y: 100),
            viewCenter: center
        )
        #expect(result == .south)
    }

    @Test func `the quadrant boundaries sit in world axes, not screen axes`() {
        // A 45° screen diagonal (up-right) rotates past the world N/E boundary under the
        // camera's 35° yaw, so it reads as north — the facing that looks right on screen.
        let result = MouseFacingSampler.facingQuadrant(
            mouseLocation: CGPoint(x: 420, y: 340),
            viewCenter: center
        )
        #expect(result == .north)
    }

    @Test func `a cursor just across a boundary keeps the current facing`() {
        // World offset (dx: 1, dy: -1.1) — nominally north, but not dominant enough to
        // out-vote an established east facing (dead band, anti-twitch).
        let nearBoundary = CGPoint(x: center.x + 145, y: center.y + 32.7)
        #expect(MouseFacingSampler.facingQuadrant(mouseLocation: nearBoundary, viewCenter: center) == .north)
        let held = MouseFacingSampler.facingQuadrant(mouseLocation: nearBoundary, viewCenter: center, current: .east)
        #expect(held == .east)
    }

    @Test func `a clearly dominant cursor direction overrides the current facing`() {
        let clearlyNorth = CGPoint(x: 320, y: 400)
        let result = MouseFacingSampler.facingQuadrant(mouseLocation: clearlyNorth, viewCenter: center, current: .east)
        #expect(result == .north)
    }
}
