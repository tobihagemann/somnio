import CoreGraphics
import Foundation
import SomnioCore
import SpriteKit
import Testing
@testable import SomnioUI

/// Stub `SpriteAssets` that returns `nil` for every accessor. The scene falls back to
/// untextured entity nodes (and skips the ground tile map entirely) — sufficient to verify
/// placement/animation/removal at the public surface without bundling a real asset pack
/// into the test target.
@MainActor private final class NullSpriteAssets: SpriteAssets {
    var entityFrameCount: Int {
        AssetManifest.legacyFallback.entityFrameCount
    }

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

/// Spying stub recording the walk-frame indices the scene requests, with a configurable
/// `entityFrameCount` so a test can prove the scene wraps frames within the manifest value rather
/// than a hardcoded constant.
@MainActor private final class FrameCountSpy: SpriteAssets {
    let entityFrameCount: Int
    private(set) var requestedFrames: [Int] = []

    init(entityFrameCount: Int) {
        self.entityFrameCount = entityFrameCount
    }

    func groundTexture(tilesetIndex _: Int16, sourceX _: Int16, sourceY _: Int16) -> SKTexture? {
        nil
    }

    func objectTexture(tilesetIndex _: Int16, sourceX _: Int16, sourceY _: Int16, sourceWidth _: Int16, sourceHeight _: Int16) -> SKTexture? {
        nil
    }

    func entityTexture(figureIndex _: Int16, kind _: WorldEntity.Kind, facing _: Direction, frame: Int) -> SKTexture? {
        requestedFrames.append(frame)
        return nil
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

    @Test func `speech bubble parents under the speaker and sorts above the day-night tint`() throws {
        let scene = WorldScene(size: CGSize(width: 640, height: 480), assets: NullSpriteAssets())
        scene.load(sector: tinySector())
        scene.placeEntity(sampleEntity())
        // The tint node only exists once the day/night pass has run.
        scene.updateDayNightTint(hour: 0, minute: 0, sectorLight: LightSetting(indoor: false, brightness: 100))
        scene.showSpeechBubble(above: 7, lines: ["hello"], lifetimeMs: 3000)
        let probe = try #require(scene._overlayProbe(for: 7))
        #expect(probe.bubbleParentIsEntityNode)
        #expect(probe.bubbleEffectiveZ > probe.tintEffectiveZ)
        #expect(probe.bubbleEffectiveZ > 1000)
    }

    @Test func `name plates parent under the entity and sort by screen-Y`() throws {
        let scene = WorldScene(size: CGSize(width: 640, height: 480), assets: NullSpriteAssets())
        scene.load(sector: tinySector())
        let north = WorldEntity(
            id: 1, kind: .peer, figure: 0,
            position: GridPoint(x: 100, y: 50),
            facing: .south, tempo: .default,
            maskSize: GridSize(width: 32, height: 48), name: "North"
        )
        let south = WorldEntity(
            id: 2, kind: .peer, figure: 0,
            position: GridPoint(x: 100, y: 400),
            facing: .south, tempo: .default,
            maskSize: GridSize(width: 32, height: 48), name: "South"
        )
        scene.placeEntity(north)
        scene.placeEntity(south)
        let northProbe = try #require(scene._overlayProbe(for: 1))
        let southProbe = try #require(scene._overlayProbe(for: 2))
        #expect(northProbe.namePlateParentIsEntityNode)
        #expect(southProbe.namePlateParentIsEntityNode)
        // Larger legacy Y is further south, so its plate's accumulated z sorts in front.
        #expect(southProbe.namePlateEffectiveZ > northProbe.namePlateEffectiveZ)
    }

    @Test func `a non-deferred load tears down the splash immediately`() {
        let scene = WorldScene(size: CGSize(width: 640, height: 480), assets: NullSpriteAssets())
        // A fresh scene shows the splash; a normal (editor) load with no deferral drops it at once.
        #expect(scene._heldSwapProbe().splashPresent)
        scene.load(sector: tinySector())
        #expect(!scene._heldSwapProbe().splashPresent)
    }

    @Test func `held sector switch hides the incoming sector until the player is placed`() {
        let scene = WorldScene(size: CGSize(width: 640, height: 480), assets: NullSpriteAssets())
        scene.load(sector: tinySector())
        scene.placeEntity(playerEntity())

        // Portal hop: load with the held swap. The incoming sector is hidden, the outgoing parked.
        scene.load(sector: tinySector(), awaitingPlayerPlacement: true)
        let held = scene._heldSwapProbe()
        #expect(held.sectorRootHidden)
        #expect(held.hasParkedPreviousRoot)
        #expect(held.pendingPlayerReveal)

        // Placing the player swaps atomically: incoming revealed, parked root dropped.
        scene.placeEntity(playerEntity())
        let revealed = scene._heldSwapProbe()
        #expect(!revealed.sectorRootHidden)
        #expect(!revealed.hasParkedPreviousRoot)
        #expect(!revealed.pendingPlayerReveal)
    }

    @Test func `first login defers the reveal so the sector is never shown framed on its origin`() {
        let scene = WorldScene(size: CGSize(width: 640, height: 480), assets: NullSpriteAssets())
        // Fresh scene shows the splash. The first sector load (the client always passes
        // awaitingPlayerPlacement) must keep the sector hidden — no origin-framed flicker — until the
        // player is placed. There is no outgoing sector to park; the splash is the held visual.
        scene.load(sector: tinySector(), awaitingPlayerPlacement: true)
        let held = scene._heldSwapProbe()
        #expect(held.sectorRootHidden)
        #expect(held.pendingPlayerReveal)
        #expect(!held.hasParkedPreviousRoot)
        #expect(held.splashPresent) // the splash is the held visual during the deferred load

        // Placing the player reveals the sector centered on the character AND drops the splash, so
        // the first game frame is the sector, not the splash still overlaying it.
        scene.placeEntity(playerEntity())
        let revealed = scene._heldSwapProbe()
        #expect(!revealed.sectorRootHidden)
        #expect(!revealed.pendingPlayerReveal)
        #expect(!revealed.splashPresent)
    }

    @Test func `destination tint is deferred until the held sector is revealed`() throws {
        let scene = WorldScene(size: CGSize(width: 640, height: 480), assets: NullSpriteAssets())
        scene.load(sector: tinySector())
        scene.placeEntity(playerEntity())
        // Apply a noon (bright) outgoing tint so the tint node exists with a known alpha.
        scene.updateDayNightTint(hour: 12, minute: 0, sectorLight: LightSetting(indoor: false, brightness: 100))
        let outgoingAlpha = scene._heldSwapProbe().appliedTintAlpha

        // Start a held switch, then push the destination's midnight (dark, different) tint: it must
        // be stashed, not applied, so the still-visible outgoing sector keeps its own lighting.
        scene.load(sector: tinySector(), awaitingPlayerPlacement: true)
        scene.updateDayNightTint(hour: 0, minute: 0, sectorLight: LightSetting(indoor: false, brightness: 100))
        let duringSwitch = scene._heldSwapProbe()
        #expect(duringSwitch.pendingTintAlpha != nil)
        #expect(duringSwitch.appliedTintAlpha == outgoingAlpha)

        // Reveal applies the stashed tint. `SKNode.alpha` is `Float`-backed, so compare with a
        // tolerance rather than bit-exact against the `Double` that was stashed.
        scene.placeEntity(playerEntity())
        let afterReveal = scene._heldSwapProbe()
        #expect(afterReveal.pendingTintAlpha == nil)
        let applied = try #require(afterReveal.appliedTintAlpha)
        let stashed = try #require(duringSwitch.pendingTintAlpha)
        #expect(abs(applied - stashed) < 0.0001)
    }

    @Test func `showSplash drops a sector parked for an in-flight switch`() {
        let scene = WorldScene(size: CGSize(width: 640, height: 480), assets: NullSpriteAssets())
        scene.load(sector: tinySector())
        scene.placeEntity(playerEntity())
        scene.load(sector: tinySector(), awaitingPlayerPlacement: true)
        scene.updateDayNightTint(hour: 0, minute: 0, sectorLight: LightSetting(indoor: false, brightness: 100))
        #expect(scene._heldSwapProbe().hasParkedPreviousRoot)
        scene.showSplash()
        let after = scene._heldSwapProbe()
        #expect(!after.hasParkedPreviousRoot)
        #expect(!after.pendingPlayerReveal)
        #expect(after.pendingTintAlpha == nil)
    }

    @Test func `the last deferred tint wins when several arrive before the reveal`() throws {
        let scene = WorldScene(size: CGSize(width: 640, height: 480), assets: NullSpriteAssets())
        scene.load(sector: tinySector())
        scene.placeEntity(playerEntity())
        // Held switch: push two destination tints before placement; only the last must be applied.
        scene.load(sector: tinySector(), awaitingPlayerPlacement: true)
        scene.updateDayNightTint(hour: 12, minute: 0, sectorLight: LightSetting(indoor: false, brightness: 100))
        scene.updateDayNightTint(hour: 0, minute: 0, sectorLight: LightSetting(indoor: false, brightness: 100))
        let lastDeferred = try #require(scene._heldSwapProbe().pendingTintAlpha)

        scene.placeEntity(playerEntity())
        let applied = try #require(scene._heldSwapProbe().appliedTintAlpha)
        #expect(abs(applied - lastDeferred) < 0.0001)
    }

    @Test func `load builds a single ground tile map sized to the sector`() throws {
        let assets = BundleMainSpriteAssets(bundle: Bundle.module)
        let scene = WorldScene(size: CGSize(width: 640, height: 480), assets: assets)
        // `tilesetIndex: 999` resolves (off-by-one) to the `1000-TestTile.png` fixture; a 4x4-tile
        // sector is 512x512 px, an exact 16x16 grid of 32 px ground cells.
        let sector = Sector(
            name: "Ground",
            version: 1,
            dimensions: GridSize(width: 4, height: 4),
            ground: GroundTile(tilesetIndex: 999, sourceX: 0, sourceY: 0),
            light: LightSetting(indoor: true, brightness: 100)
        )
        scene.load(sector: sector)
        let probe = try #require(scene._groundTileMapProbe())
        #expect(probe.numberOfColumns == 16)
        #expect(probe.numberOfRows == 16)
        #expect(probe.tileSize == CGSize(width: 32, height: 32))
        #expect(probe.anchorPoint == CGPoint(x: 0, y: 0))
        #expect(probe.position == .zero)
        // zPosition 0 sits below every object/entity depth (ScreenDepth floors at 1).
        #expect(probe.zPosition == 0)
    }

    @Test func `load builds no ground tile map when the asset pack is absent`() {
        let scene = WorldScene(size: CGSize(width: 640, height: 480), assets: NullSpriteAssets())
        scene.load(sector: tinySector())
        #expect(scene._groundTileMapProbe() == nil)
    }

    @Test func `update wraps the walk frame within the manifest entityFrameCount`() {
        // A 3-frame manifest must cycle frames 0,1,2 and never request frame 3 — a regression to a
        // hardcoded 4-frame count would request frame 3, so this pins the scene to the data-driven
        // value rather than a constant.
        let spy = FrameCountSpy(entityFrameCount: 3)
        let scene = WorldScene(size: CGSize(width: 640, height: 480), assets: spy)
        scene.load(sector: tinySector())
        scene.placeEntity(sampleEntity())

        var time = 0.0
        scene.update(time) // seeds the per-frame clock; advances no walk frame yet
        for step in 1 ... 20 {
            // Move every step so the motion grace window keeps the entity "moving" and the walk
            // clock accumulates across several full 3-frame cycles.
            scene.updatePosition(entityID: 7, to: GridPoint(x: Int16(10 + step), y: 20), facing: .south)
            time += 0.1
            scene.update(time)
        }

        let frames = spy.requestedFrames
        #expect(frames.allSatisfy { $0 >= 0 && $0 < 3 })
        #expect(frames.contains(2))
        #expect(!frames.contains(3))
    }

    private func playerEntity() -> WorldEntity {
        WorldEntity(
            id: 1,
            kind: .player,
            figure: 0,
            position: GridPoint(x: 100, y: 100),
            facing: .south,
            tempo: .default,
            maskSize: GridSize(width: 32, height: 48),
            name: "Player"
        )
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
