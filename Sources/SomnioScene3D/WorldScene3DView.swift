import RealityKit
import SwiftUI

/// SwiftUI host for the RealityKit `WorldScene3D`. The scene instance is owned by the caller
/// and passed in via `init(scene:)` so SwiftUI body invalidations do not recreate it — the
/// entity graph, camera, and per-sector floor survive redraws. Mirrors `WorldSceneView`'s
/// caller-owned ownership pattern for the SpriteKit scene.
@MainActor public struct WorldScene3DView: View {
    private let scene: WorldScene3D
    private let size: CGSize

    /// The player client renders the fixed 640×480 viewport (the default).
    public init(scene: WorldScene3D, size: CGSize = CGSize(width: 640, height: 480)) {
        self.scene = scene
        self.size = size
    }

    public var body: some View {
        RealityView { content in
            // Opt into the scene's own camera entity: on macOS `RealityViewCameraContent` defaults
            // to a tracking camera that ignores our `OrthographicCameraComponent`, rendering blank.
            content.camera = .virtual
            content.add(scene.rootEntity)
        }
        .frame(width: size.width, height: size.height)
    }
}
