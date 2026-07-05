import CoreGraphics
import Foundation
import SomnioCore
import SomnioScene3D
import Testing
@testable import SomnioApp

/// The sampler produces the heading in world floor axes (the screen offset rotated through
/// the 3/4 camera's 35° yaw), so the tests synthesize screen positions from world-axis
/// offsets via the inverse rotation and assert the exact resulting heading.
struct MouseFacingSamplerTests {
    private let center = CGPoint(x: 320, y: 240)

    /// Screen position whose camera-rotated world offset is `(worldDX, worldDY)` (legacy
    /// floor axes, dy grows southward) — the inverse of `OrthographicCameraRig.worldMovement`.
    private func mouseLocation(forWorldDX worldDX: Double, worldDY: Double) -> CGPoint {
        let yaw = Double(OrthographicCameraRig.yawDegrees) * .pi / 180
        let screenDX = worldDX * cos(yaw) - worldDY * sin(yaw)
        let screenDY = worldDX * sin(yaw) + worldDY * cos(yaw)
        // The sampler receives Y-up view coordinates and converts to screen-down itself.
        return CGPoint(x: center.x + screenDX, y: center.y - screenDY)
    }

    @Test(arguments: [
        (0.0, 100.0, Float(0)), // due south
        (100.0, 0.0, Float(90)), // due east
        (0.0, -100.0, Float(180)), // due north
        (-100.0, 0.0, Float(270)), // due west
        (100.0, 100.0, Float(45)), // exact south-east diagonal
        (-100.0, 100.0, Float(315)) // exact south-west diagonal
    ])
    func `a world-axis cursor offset yields the exact continuous heading`(
        worldDX: Double, worldDY: Double, expected: Float
    ) {
        let heading = MouseFacingSampler.heading(
            mouseLocation: mouseLocation(forWorldDX: worldDX, worldDY: worldDY),
            viewCenter: center
        )
        #expect(abs(heading.angularDistance(to: Heading(degrees: expected))) < 0.01)
    }

    @Test func `the heading is continuous, not quantized to a quadrant`() {
        // A shallow offset just east of south must land between the cardinals, not snap to one.
        let heading = MouseFacingSampler.heading(
            mouseLocation: mouseLocation(forWorldDX: 50, worldDY: 100),
            viewCenter: center
        )
        let expected = Float(atan2(50.0, 100.0) * 180 / .pi) // ≈ 26.57°
        #expect(abs(heading.angularDistance(to: Heading(degrees: expected))) < 0.01)
        #expect(heading.degrees > 1)
        #expect(heading.degrees < 89)
    }

    @Test func `a screen-axis cursor lands in world axes, not screen axes`() {
        // A pure screen-right offset rotates through the 35° camera yaw, so the world heading
        // sits 35° past east toward north (90° + 35° = 125°) rather than due east.
        let heading = MouseFacingSampler.heading(
            mouseLocation: CGPoint(x: center.x + 100, y: center.y),
            viewCenter: center
        )
        #expect(abs(heading.angularDistance(to: Heading(degrees: 90 + OrthographicCameraRig.yawDegrees))) < 0.01)
    }
}
