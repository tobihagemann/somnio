import SpriteKit
import SwiftUI

/// SwiftUI host for the SpriteKit `WorldScene`. The scene instance is owned by the
/// caller and passed in via `init(scene:)` so SwiftUI body invalidations do not
/// recreate it — node state, running actions, and the splash-vs-sector swap survive
/// redraws.
@MainActor public struct WorldSceneView: View {
    private let scene: WorldScene
    private let size: CGSize

    /// The player client renders the fixed 640×480 scrolling viewport (the default); the editor
    /// passes the full sector pixel size and hosts the view inside a scroll view so a sector larger
    /// than the window can be panned to in full.
    public init(scene: WorldScene, size: CGSize = CGSize(width: 640, height: 480)) {
        self.scene = scene
        self.size = size
    }

    public var body: some View {
        SpriteView(scene: scene)
            .frame(width: size.width, height: size.height)
    }
}
