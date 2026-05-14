import SpriteKit
import SwiftUI

/// SwiftUI host for the SpriteKit `WorldScene`. The scene instance is owned by the
/// caller and passed in via `init(scene:)` so SwiftUI body invalidations do not
/// recreate it — node state, running actions, and the splash-vs-sector swap survive
/// redraws.
@MainActor public struct WorldSceneView: View {
    private let scene: WorldScene

    public init(scene: WorldScene) {
        self.scene = scene
    }

    public var body: some View {
        SpriteView(scene: scene)
            .frame(width: 640, height: 480)
    }
}
