import AppKit
import Foundation
import RealityKit
import SomnioCore

/// RealityKit render surface for the player client. Owns the `Entity` graph hosted by
/// `WorldScene3DView`: the root, the orthographic 3/4 camera, and the per-sector floor plane. The
/// camera and coordinate math come from `OrthographicCameraRig`.
///
/// The entity, speech-bubble, and lighting methods are intentional no-ops; the floor uses an
/// `UnlitMaterial` so it is visible without a light rig.
@MainActor public final class WorldScene3D: WorldRenderSurface {
    /// Added to the `RealityView` by `WorldScene3DView`; internal, not private, so the host view can reach it.
    let rootEntity = Entity()
    private let cameraEntity = Entity()
    private var floorEntity: ModelEntity?

    public init() {
        var camera = OrthographicCameraComponent()
        camera.scale = OrthographicCameraRig.defaultScale
        camera.near = OrthographicCameraRig.nearClip
        camera.far = OrthographicCameraRig.farClip
        cameraEntity.components.set(camera)
        rootEntity.addChild(cameraEntity)
        showSplash()
    }

    public func load(sector: Sector, awaitingPlayerPlacement _: Bool) {
        let widthMeters = Float(sector.pixelWidth) * OrthographicCameraRig.worldUnitsPerPixel
        let depthMeters = Float(sector.pixelHeight) * OrthographicCameraRig.worldUnitsPerPixel
        let mesh = MeshResource.generatePlane(width: widthMeters, depth: depthMeters)
        let floor = ModelEntity(mesh: mesh, materials: [UnlitMaterial(color: .init(white: 0.5, alpha: 1))])
        // `generatePlane` centers the mesh at the origin; offset by half so the sector's top-left
        // pixel origin (0, 0) maps to a floor corner, matching `OrthographicCameraRig.worldPosition`.
        let center = SIMD3<Float>(widthMeters / 2, 0, depthMeters / 2)
        floor.position = center

        floorEntity?.removeFromParent()
        rootEntity.addChild(floor)
        floorEntity = floor
        focusCamera(on: center)
    }

    public func placeEntity(_: WorldEntity) {}

    public func updatePosition(entityID _: Int16, to _: GridPoint, facing _: Direction) {}

    public func animateEntity(_: Int16, to _: GridPoint, facing _: Direction, duration _: TimeInterval) {}

    public func updateDayNightTint(hour _: Int16, minute _: Int16, sectorLight _: LightSetting) {}

    public func showSpeechBubble(above _: Int16, lines _: [String], lifetimeMs _: Int) {}

    public func removeEntity(id _: Int16) {}

    public func showSplash() {
        floorEntity?.removeFromParent()
        floorEntity = nil
        focusCamera(on: .zero)
    }

    private func focusCamera(on focus: SIMD3<Float>) {
        cameraEntity.position = OrthographicCameraRig.cameraPosition(focusing: focus)
        cameraEntity.orientation = OrthographicCameraRig.cameraOrientation(focusing: focus)
    }
}
