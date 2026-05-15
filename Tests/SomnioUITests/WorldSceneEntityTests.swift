import CoreGraphics
import Foundation
import SomnioCore
import SpriteKit
import Testing
@testable import SomnioUI

/// Stub `SpriteAssets` that returns `nil` for every accessor. The scene falls back to
/// untextured nodes — sufficient to verify placement/animation/removal at the public
/// surface without bundling a real asset pack into the test target.
@MainActor private final class NullSpriteAssets: SpriteAssets {
    func groundTexture(tilesetIndex _: Int16, sourceX _: Int16, sourceY _: Int16) -> SKTexture? {
        nil
    }

    func objectTexture(tilesetIndex _: Int16, sourceX _: Int16, sourceY _: Int16, sourceWidth _: Int16, sourceHeight _: Int16) -> SKTexture? {
        nil
    }

    func characterTexture(figure _: Int16, frame _: Int) -> SKTexture? {
        nil
    }

    func npcTexture(figure _: Int16, frame _: Int) -> SKTexture? {
        nil
    }

    func monsterTexture(figure _: Int16, frame _: Int) -> SKTexture? {
        nil
    }

    func animationStrip(name _: String) -> SKTexture? {
        nil
    }

    func splash() -> SKTexture? {
        nil
    }
}

@MainActor
struct WorldSceneEntityTests {
    @Test func `placeEntity then animateEntity then removeEntity round-trips`() {
        let scene = WorldScene(size: CGSize(width: 640, height: 480), assets: NullSpriteAssets())
        scene.load(sector: tinySector())
        let entity = WorldEntity(
            id: 7,
            kind: .peer,
            figure: 0,
            position: GridPoint(x: 10, y: 20),
            facing: .south,
            tempo: .default,
            maskSize: GridSize(width: 128, height: 128),
            name: "Peer"
        )
        scene.placeEntity(entity)
        scene.animateEntity(7, to: GridPoint(x: 30, y: 40), facing: .east, duration: 0.05)
        scene.removeEntity(id: 7)
        // Re-placing after removal should succeed without crashing.
        scene.placeEntity(entity)
    }

    private func tinySector() -> Sector {
        Sector(
            name: "Test",
            version: 1,
            dimensions: GridSize(width: 4, height: 4),
            ground: GroundTile(tilesetIndex: 0, sourceX: 0, sourceY: 0),
            light: LightSetting(indoor: true, brightness: 100)
        )
    }
}
