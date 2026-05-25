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

    func entityTexture(figureIndex _: Int16, kind _: WorldEntity.Kind, facing _: Direction, frame _: Int) -> SKTexture? {
        nil
    }

    func animationStrip(name _: String) -> SKTexture? {
        nil
    }

    func splash() -> SKTexture? {
        nil
    }

    func speechBubble() -> SKTexture? {
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

    @Test func `removeEntity clears render state`() {
        let scene = WorldScene(size: CGSize(width: 640, height: 480), assets: NullSpriteAssets())
        scene.load(sector: tinySector())
        scene.placeEntity(sampleEntity())
        #expect(scene._entityRenderStateContains(7))
        scene.removeEntity(id: 7)
        #expect(!scene._entityRenderStateContains(7))
    }

    @Test func `loading a sector clears render state`() {
        let scene = WorldScene(size: CGSize(width: 640, height: 480), assets: NullSpriteAssets())
        scene.load(sector: tinySector())
        scene.placeEntity(sampleEntity())
        #expect(scene._entityRenderStateContains(7))
        scene.load(sector: tinySector())
        #expect(!scene._entityRenderStateContains(7))
    }

    @Test func `showSplash clears render state`() {
        let scene = WorldScene(size: CGSize(width: 640, height: 480), assets: NullSpriteAssets())
        scene.load(sector: tinySector())
        scene.placeEntity(sampleEntity())
        #expect(scene._entityRenderStateContains(7))
        scene.showSplash()
        #expect(!scene._entityRenderStateContains(7))
    }

    private func sampleEntity() -> WorldEntity {
        WorldEntity(
            id: 7,
            kind: .peer,
            figure: 0,
            position: GridPoint(x: 10, y: 20),
            facing: .south,
            tempo: .default,
            maskSize: GridSize(width: 128, height: 128),
            name: "Peer"
        )
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
