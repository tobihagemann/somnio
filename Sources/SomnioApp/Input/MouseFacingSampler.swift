import CoreGraphics
import Foundation
import SomnioCore

/// Pure helper for the legacy 4-quadrant mouse-driven facing rule. The mouse position is
/// interpreted relative to the world-view centre; the dominant axis selects N/E/S/W.
/// Horizontal ties (`abs(dx) == abs(dy)`) and equally-distant ties prefer the horizontal
/// axis to match the legacy `quadrant()` function.
public enum MouseFacingSampler {
    public static func facingQuadrant(mouseLocation: CGPoint, viewCenter: CGPoint) -> Direction {
        let dx = mouseLocation.x - viewCenter.x
        let dy = mouseLocation.y - viewCenter.y
        if abs(dx) >= abs(dy) {
            return dx >= 0 ? .east : .west
        }
        return dy >= 0 ? .north : .south
    }
}
