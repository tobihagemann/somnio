import CoreGraphics
import Foundation
import SomnioCore
import SomnioScene3D

/// Maps the cursor's offset from the play-field center to the legacy 4-quadrant facing, in
/// world floor axes: the screen offset is rotated through the 3/4 camera's fixed yaw (the
/// same mapping WASD movement uses) so the character faces where the cursor sits on screen
/// rather than 35° beside it.
public enum MouseFacingSampler {
    /// A candidate facing must dominate the perpendicular axis by this factor before it
    /// replaces `current`. Without the dead band a cursor near a quadrant boundary flips the
    /// facing every few pixels, and the 3D yaw slew turns that flapping into a visible
    /// idle twitch (the 2D sprite swap hid it).
    static let switchDominance = 1.2

    public static func facingQuadrant(
        mouseLocation: CGPoint,
        viewCenter: CGPoint,
        current: Direction? = nil
    ) -> Direction {
        // The tracking view's space is Y-up; the world transform expects screen-down.
        let world = OrthographicCameraRig.worldMovement(
            forScreenDX: Double(mouseLocation.x - viewCenter.x),
            screenDY: Double(viewCenter.y - mouseLocation.y)
        )
        let horizontal = abs(world.dx) >= abs(world.dy)
        let candidate: Direction = horizontal
            ? (world.dx >= 0 ? .east : .west)
            : (world.dy >= 0 ? .south : .north)
        guard let current, candidate != current else { return candidate }
        let dominant = horizontal ? abs(world.dx) : abs(world.dy)
        let other = horizontal ? abs(world.dy) : abs(world.dx)
        return dominant >= other * switchDominance ? candidate : current
    }
}
