import Foundation
import SomnioCore
import Testing

struct RelativeDirectionTests {
    /// Facing south (0°), so a travel heading's degrees are the absolute-to-relative angle: the
    /// classification only depends on the arc between travel and facing.
    @Test(arguments: [
        (Float(0), RelativeDirection.forward), // straight ahead
        (Float(180), .backward), // directly behind
        (Float(90), .strafeLeft), // screen-east is the south-facer's own left
        (Float(270), .strafeRight), // screen-west is its own right
        (Float(45), .forward), // 45° boundary owned by forward
        (Float(315), .forward), // -45° boundary owned by forward
        (Float(135), .strafeLeft), // 135° boundary owned by strafe, not backward
        (Float(225), .strafeRight), // -135° boundary owned by strafe
        (Float(46), .strafeLeft), // just past the forward cone
        (Float(134), .strafeLeft), // just inside the strafe wedge
        (Float(136), .backward) // just into the backward cone
    ])
    func `bucketing faces south and classifies travel by relative angle`(travelDegrees: Float, expected: RelativeDirection) {
        let direction = RelativeDirection(travel: Heading(degrees: travelDegrees), facing: Heading(cardinal: .south))
        #expect(direction == expected)
    }

    @Test func `bucketing is facing-relative, not absolute`() {
        // The same world-north travel is forward when you face north and backward when you face south.
        #expect(RelativeDirection(travel: Heading(cardinal: .north), facing: Heading(cardinal: .north)) == .forward)
        #expect(RelativeDirection(travel: Heading(cardinal: .north), facing: Heading(cardinal: .south)) == .backward)
    }

    @Test(arguments: [
        (RelativeDirection.forward, 1.0),
        (.strafeLeft, 0.70),
        (.strafeRight, 0.70),
        (.backward, 0.50)
    ])
    func `speedMultiplier penalizes strafe and backpedal`(direction: RelativeDirection, expected: Double) {
        #expect(direction.speedMultiplier == expected)
    }
}
