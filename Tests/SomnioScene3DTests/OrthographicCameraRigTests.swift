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

    @Test func `the authored origin lands on the floor corner and the sector max on the opposite corner`() {
        #expect(OrthographicCameraRig.worldPosition(forLegacyX: 0, y: 0) == SIMD3<Float>(0, 0, 0))
        // A 4×4-tile sector spans 512 px per axis; its far corner sits at the full metric extent.
        let farCorner = OrthographicCameraRig.worldPosition(forLegacyX: 512, y: 512)
        #expect(approxEqual(farCorner, SIMD3<Float>(
            512 * OrthographicCameraRig.worldUnitsPerPixel,
            0,
            512 * OrthographicCameraRig.worldUnitsPerPixel
        )))
    }

    @Test func `screen-relative movement maps W up-screen and D screen-right without changing speed`() {
        let yaw = Double(OrthographicCameraRig.yawDegrees) * .pi / 180
        // W (screen up) walks away from the camera: the inverse of the camera's horizontal offset.
        let up = OrthographicCameraRig.worldMovement(forScreenDX: 0, screenDY: -1)
        #expect(abs(up.dx - -sin(yaw)) < 1e-9)
        #expect(abs(up.dy - -cos(yaw)) < 1e-9)
        // D (screen right) is perpendicular to it, biased east under the fixed 35° swing.
        let right = OrthographicCameraRig.worldMovement(forScreenDX: 1, screenDY: 0)
        #expect(abs(right.dx - cos(yaw)) < 1e-9)
        #expect(abs(right.dy - -sin(yaw)) < 1e-9)
        // Pure rotation: a unit input stays unit length, so tempo is unchanged.
        #expect(abs(up.dx * up.dx + up.dy * up.dy - 1) < 1e-9)
    }

    @Test func `the fractional-point variant agrees with the integer one and keeps half pixels`() {
        let integer = OrthographicCameraRig.worldPosition(forLegacyX: 100, y: 200)
        let fractional = OrthographicCameraRig.worldPosition(forLegacyPoint: SIMD2<Float>(100, 200))
        #expect(approxEqual(integer, fractional))
        // A rect center with odd extent lands on a half pixel — the placement path for
        // object footprint centers and entity feet-box centers.
        let center = OrthographicCameraRig.worldPosition(forLegacyPoint: SIMD2<Float>(100.5, 200.5))
        #expect(approxEqual(center, SIMD3<Float>(
            100.5 * OrthographicCameraRig.worldUnitsPerPixel,
            0,
            200.5 * OrthographicCameraRig.worldUnitsPerPixel
        )))
    }
}
