import Foundation
import simd
import Testing
@testable import SomnioScene3D

struct OrthographicCameraRigTests {
    private func approxEqual(_ lhs: SIMD3<Float>, _ rhs: SIMD3<Float>, tolerance: Float = 1e-4) -> Bool {
        length(lhs - rhs) <= tolerance
    }

    @Test func `the offset direction is a unit vector pinned to the fixed pitch and yaw`() {
        let direction = OrthographicCameraRig.offsetDirection()
        #expect(abs(length(direction) - 1) <= 1e-5)
        #expect(direction.y > 0)
        #expect(direction.x > 0)
        #expect(direction.z > 0)
        // Independently re-derive the framing from the angle constants via tan (the rig builds the
        // vector from cos/sin products), so a swapped X/Z component or a changed pitch is caught.
        let pitch = OrthographicCameraRig.pitchDegrees * .pi / 180
        let yaw = OrthographicCameraRig.yawDegrees * .pi / 180
        let horizontal = (direction.x * direction.x + direction.z * direction.z).squareRoot()
        #expect(abs(direction.y / horizontal - tan(pitch)) <= 1e-4) // pitch pins vertical vs ground run
        #expect(abs(direction.x / direction.z - tan(yaw)) <= 1e-4) // yaw pins the horizontal heading
    }

    @Test func `the camera sits one camera-distance from its focus along the offset direction`() {
        let focus = SIMD3<Float>(3, 0, 7)
        let position = OrthographicCameraRig.cameraPosition(focusing: focus)
        #expect(abs(length(position - focus) - OrthographicCameraRig.cameraDistance) <= 1e-3)
        let expected = focus + OrthographicCameraRig.offsetDirection() * OrthographicCameraRig.cameraDistance
        #expect(approxEqual(position, expected))
    }

    @Test func `the camera translates rigidly with its focus`() {
        let a = OrthographicCameraRig.cameraPosition(focusing: SIMD3<Float>(0, 0, 0))
        let b = OrthographicCameraRig.cameraPosition(focusing: SIMD3<Float>(10, 0, -4))
        #expect(approxEqual(b - a, SIMD3<Float>(10, 0, -4)))
    }

    @Test func `the camera orientation aims its forward axis at the focus`() {
        let focus = SIMD3<Float>(2, 0, 5)
        let orientation = OrthographicCameraRig.cameraOrientation(focusing: focus)
        // A RealityKit camera looks down its local -Z axis; rotating that by the orientation must
        // point from the camera toward the focus.
        let forward = orientation.act(SIMD3<Float>(0, 0, -1))
        let expected = normalize(focus - OrthographicCameraRig.cameraPosition(focusing: focus))
        #expect(approxEqual(forward, expected, tolerance: 1e-4))
    }

    @Test func `clampedScale bounds zoom to the permitted range`() {
        #expect(OrthographicCameraRig.clampedScale(0) == OrthographicCameraRig.minScale)
        #expect(OrthographicCameraRig.clampedScale(1000) == OrthographicCameraRig.maxScale)
        #expect(OrthographicCameraRig.clampedScale(OrthographicCameraRig.defaultScale) == OrthographicCameraRig.defaultScale)
    }

    @Test func `legacy pixels map onto the flat floor scaled by world-units-per-pixel`() {
        let world = OrthographicCameraRig.worldPosition(forLegacyX: 100, y: 200)
        #expect(world.y == 0)
        #expect(approxEqual(world, SIMD3<Float>(
            100 * OrthographicCameraRig.worldUnitsPerPixel,
            0,
            200 * OrthographicCameraRig.worldUnitsPerPixel
        )))
    }
}
