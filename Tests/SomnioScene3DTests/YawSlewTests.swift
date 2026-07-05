import Foundation
import SomnioCore
import Testing
@testable import SomnioScene3D

struct YawSlewTests {
    /// Remaining shortest-arc distance from `current` to `target`.
    private func arcDistance(from current: Float, to target: Float) -> Float {
        abs((target - current).remainder(dividingBy: 2 * .pi))
    }

    @Test func `a quarter turn completes between 0.15 and 0.2 seconds`() {
        var yaw: Float = Heading(cardinal: .south).radians
        let target = Heading(cardinal: .east).radians
        for _ in 0 ..< 3 {
            yaw = YawSlew.step(from: yaw, toward: target, deltaTime: 0.05)
        }
        #expect(yaw != target) // 0.15 s: not yet there
        yaw = YawSlew.step(from: yaw, toward: target, deltaTime: 0.05)
        #expect(yaw == target) // 0.2 s: arrived exactly, no overshoot
    }

    @Test func `slew crosses the ±180° seam along the shortest arc`() {
        // From just short of the seam to just past it: the short way is through ±π, not back
        // around through zero.
        var yaw: Float = 3 * .pi / 4
        let target: Float = -3 * .pi / 4
        let first = YawSlew.step(from: yaw, toward: target, deltaTime: 0.01)
        #expect(first > yaw) // heading toward +π, not back toward 0
        var previousDistance = arcDistance(from: yaw, to: target)
        for _ in 0 ..< 200 where yaw != target {
            yaw = YawSlew.step(from: yaw, toward: target, deltaTime: 0.01)
            let distance = arcDistance(from: yaw, to: target)
            #expect(distance < previousDistance) // monotonic convergence, no overshoot
            previousDistance = distance
        }
        #expect(yaw == target)
    }

    @Test func `an exact 180° turn picks one consistent arc without spinning`() {
        // South ↔ north is the ambiguous case; the IEEE remainder resolves it to the positive
        // arc every step, so the turn converges instead of oscillating.
        var yaw: Float = Heading(cardinal: .south).radians
        let target = Heading(cardinal: .north).radians
        let first = YawSlew.step(from: yaw, toward: target, deltaTime: 0.01)
        #expect(first > 0)
        for _ in 0 ..< 100 where yaw != target {
            yaw = YawSlew.step(from: yaw, toward: target, deltaTime: 0.01)
        }
        #expect(yaw == target)
    }

    @Test func `a step never leaves the wrapped ±π range`() {
        var yaw: Float = 0.99 * .pi
        for _ in 0 ..< 50 {
            yaw = YawSlew.step(from: yaw, toward: -0.99 * .pi, deltaTime: 0.016)
            #expect(abs(yaw) <= .pi + 0.0001)
        }
    }
}
