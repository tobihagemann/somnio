import RealityKit
import SomnioCore
import Testing
@testable import SomnioScene3D

/// Guards the floor/camera entity-graph lifecycle that the live `RealityView` renders. This is
/// graph bookkeeping (child counts), not pixel output, so it runs headlessly — the project's
/// "RealityKit visual output is smoke-tested, not headless-unit-tested" rule does not apply here.
@MainActor
struct WorldScene3DLifecycleTests {
    private func tinySector() -> Sector {
        Sector(
            name: "Test",
            version: 1,
            dimensions: GridSize(width: 4, height: 4),
            ground: GroundTile(tilesetIndex: 0, sourceX: 0, sourceY: 0),
            light: LightSetting(indoor: true, brightness: 100)
        )
    }

    @Test func `a fresh scene shows only the camera, no floor`() {
        let scene = WorldScene3D()
        // init calls showSplash(), which leaves just the camera entity in the graph.
        #expect(scene.rootEntity.children.count == 1)
    }

    @Test func `loading a sector adds a single floor under the camera`() {
        let scene = WorldScene3D()
        scene.load(sector: tinySector(), awaitingPlayerPlacement: false)
        #expect(scene.rootEntity.children.count == 2) // camera + floor
    }

    @Test func `loading a second sector replaces the floor rather than stacking`() {
        let scene = WorldScene3D()
        scene.load(sector: tinySector(), awaitingPlayerPlacement: false)
        scene.load(sector: tinySector(), awaitingPlayerPlacement: false)
        #expect(scene.rootEntity.children.count == 2) // still camera + one floor
    }

    @Test func `showSplash removes the floor, leaving only the camera`() {
        let scene = WorldScene3D()
        scene.load(sector: tinySector(), awaitingPlayerPlacement: false)
        scene.showSplash()
        #expect(scene.rootEntity.children.count == 1)
    }
}
