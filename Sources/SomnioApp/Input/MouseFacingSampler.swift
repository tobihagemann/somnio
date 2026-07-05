import CoreGraphics
import Foundation
import SomnioCore
import SomnioScene3D

/// Maps the cursor's offset from the play-field center to a continuous heading, in world
/// floor axes: the screen offset is rotated through the 3/4 camera's fixed yaw (the same
/// mapping WASD movement uses) so the character faces where the cursor sits on screen rather
/// than 35° beside it. Sub-degree cursor wobble needs no dead band here — the wire emit
/// threshold and the render-side yaw slew absorb it.
public enum MouseFacingSampler {
    public static func heading(mouseLocation: CGPoint, viewCenter: CGPoint) -> Heading {
        // The tracking view's space is Y-up; the world transform expects screen-down.
        let world = OrthographicCameraRig.worldMovement(
            forScreenDX: Double(mouseLocation.x - viewCenter.x),
            screenDY: Double(viewCenter.y - mouseLocation.y)
        )
        return Heading(dx: Float(world.dx), dy: Float(world.dy))
    }
}
