import Foundation
import RealityKit
import simd
import SomnioCore
import Testing
@testable import SomnioScene3D

/// Guards the entity-graph lifecycle that the live `RealityView` renders. This is graph
/// bookkeeping (child counts, transforms, swap flags), not pixel output, so it runs headlessly
/// — the project's "RealityKit visual output is smoke-tested, not headless-unit-tested" rule
/// does not apply here.
///
/// `rootEntity` carries the scene-persistent rig (camera + void backdrop + sun + ambient) plus the sector
/// roots; floor/objects/entities are counted on `sectorRoot`, never on `rootEntity`.
@MainActor
struct WorldScene3DLifecycleTests {
    private static let persistentChildren = 4 // camera + void backdrop + sun + ambient

    /// Stub asset source whose lookups resolve only after `prewarm()` — the warm-gap double
    /// for re-resolution tests. The pack-absent case is `resolves: false` forever.
    private final class StubModelAssets: ModelAssets {
        private let resolvesAfterPrewarm: Bool
        private var warmed = false

        init(resolvesAfterPrewarm: Bool = true) {
            self.resolvesAfterPrewarm = resolvesAfterPrewarm
        }

        func prewarm() async {
            warmed = resolvesAfterPrewarm
        }

        func entity(forKind _: WorldEntity.Kind, figure _: Int16) -> Entity? {
            warmed ? Entity() : nil
        }

        func object(forSignature _: SourceRectSignature) -> Entity? {
            warmed ? Entity() : nil
        }

        func groundTexture(tilesetIndex _: Int16, sourceX _: Int16, sourceY _: Int16) -> TextureResource? {
            nil
        }

        func groundMaterialTexture(tilesetIndex _: Int16, sourceX _: Int16, sourceY _: Int16) -> TextureResource? {
            nil
        }

        func floorMaterialURL(forID _: String) -> URL? {
            nil
        }
    }

    private func tinySector(objectCount: Int = 0) -> Sector {
        let objects = (0 ..< objectCount).map { index in
            Object(
                x: Int16(index * 64),
                y: 32,
                tilesetIndex: 25,
                sourceX: 64,
                sourceY: 512,
                sourceWidth: 64,
                sourceHeight: 96,
                priority: 0
            )
        }
        return Sector(
            name: "Test",
            version: 1,
            dimensions: GridSize(width: 4, height: 4),
            ground: GroundTile(tilesetIndex: 0, sourceX: 0, sourceY: 0),
            light: LightSetting(indoor: true, brightness: 100),
            objects: objects
        )
    }

    private func worldEntity(
        id: Int16,
        kind: WorldEntity.Kind = .npc,
        position: GridPoint = GridPoint(x: 96, y: 96),
        facing: Heading = Heading(cardinal: .south)
    ) -> WorldEntity {
        WorldEntity(
            id: id,
            kind: kind,
            figure: kind == .npc ? 16 : 0,
            position: position,
            facing: facing,
            tempo: .default,
            maskSize: GridSize(width: 32, height: 48),
            name: "Probe"
        )
    }

    private func scene(assets: StubModelAssets = StubModelAssets()) -> WorldScene3D {
        WorldScene3D(modelAssets: assets)
    }

    // MARK: - Root graph

    @Test func `a fresh scene shows only the persistent camera and light rig`() {
        let scene = scene()
        // init calls showSplash(), which leaves camera + sun + ambient in the graph.
        #expect(scene.rootEntity.children.count == Self.persistentChildren)
        #expect(scene._sectorRootChildCount() == nil)
    }

    @Test func `loading a sector adds one sector root holding the floor and objects`() {
        let scene = scene()
        scene.load(sector: tinySector(objectCount: 2), awaitingPlayerPlacement: false)
        #expect(scene.rootEntity.children.count == Self.persistentChildren + 1)
        #expect(scene._sectorRootChildCount() == 3) // floor + 2 objects
    }

    @Test func `loading a second sector replaces the sector root rather than stacking`() {
        let scene = scene()
        scene.load(sector: tinySector(objectCount: 2), awaitingPlayerPlacement: false)
        scene.placeEntity(worldEntity(id: 1))
        scene.load(sector: tinySector(), awaitingPlayerPlacement: false)
        #expect(scene.rootEntity.children.count == Self.persistentChildren + 1)
        #expect(scene._sectorRootChildCount() == 1) // fresh floor only; old objects + entities gone
        #expect(!scene._entityRenderStateContains(1))
    }

    @Test func `a second load does not disturb the persistent light rig`() {
        let scene = scene()
        scene.load(sector: tinySector(), awaitingPlayerPlacement: false)
        let intensityBefore = scene.sunEntity.components[DirectionalLightComponent.self]?.intensity
        scene.load(sector: tinySector(), awaitingPlayerPlacement: false)
        #expect(scene.rootEntity.children.count == Self.persistentChildren + 1)
        #expect(scene.sunEntity.components[DirectionalLightComponent.self]?.intensity == intensityBefore)
    }

    @Test func `showSplash removes the sector root and every entity`() {
        let scene = scene()
        scene.load(sector: tinySector(objectCount: 1), awaitingPlayerPlacement: false)
        scene.placeEntity(worldEntity(id: 1))
        scene.showSplash()
        #expect(scene.rootEntity.children.count == Self.persistentChildren)
        #expect(scene._sectorRootChildCount() == nil)
        #expect(!scene._entityRenderStateContains(1))
    }

    // MARK: - Entity placement

    @Test func `placing and removing an entity tracks sector-root children`() {
        let scene = scene()
        scene.load(sector: tinySector(), awaitingPlayerPlacement: false)
        scene.placeEntity(worldEntity(id: 7))
        #expect(scene._sectorRootChildCount() == 2) // floor + entity
        #expect(scene._entityRenderStateContains(7))
        scene.removeEntity(id: 7)
        #expect(scene._sectorRootChildCount() == 1)
        #expect(!scene._entityRenderStateContains(7))
    }

    @Test func `placing the player centers the camera on its node`() throws {
        let scene = scene()
        scene.load(sector: tinySector(), awaitingPlayerPlacement: false)
        scene.placeEntity(worldEntity(id: 0, kind: .player))
        let probe = try #require(scene._entityNodeProbe(for: 0))
        #expect(scene.cameraEntity.position == OrthographicCameraRig.cameraPosition(focusing: probe.nodePosition))
    }

    @Test func `updatePosition follows the camera only for the local player`() throws {
        let scene = scene()
        scene.load(sector: tinySector(), awaitingPlayerPlacement: false)
        scene.placeEntity(worldEntity(id: 0, kind: .player))
        scene.placeEntity(worldEntity(id: 1, kind: .peer))
        scene.updatePosition(entityID: 1, to: GridPoint(x: 200, y: 200), facing: Heading(cardinal: .south))
        let player = try #require(scene._entityNodeProbe(for: 0))
        #expect(scene.cameraEntity.position == OrthographicCameraRig.cameraPosition(focusing: player.nodePosition))
        scene.updatePosition(entityID: 0, to: GridPoint(x: 128, y: 128), facing: Heading(cardinal: .south))
        let moved = try #require(scene._entityNodeProbe(for: 0))
        #expect(scene.cameraEntity.position == OrthographicCameraRig.cameraPosition(focusing: moved.nodePosition))
    }

    @Test func `objectAnchorBottomY prefers an overlapping mask's south edge over the rect bottom`() {
        // The library's north shelf row: decal rect −48..48, authored mask ending at 32 —
        // the legacy game let the player stand on the art's bottom 16 px, so the model must
        // stand on the mask edge or the player walks inside the mesh.
        let shelf = object(x: 0, y: -48, width: 64, height: 96)
        let anchor = WorldScene3D.objectAnchorBottomY(for: shelf, masks: [CollisionMask(x: 0, y: 0, width: 256, height: 32)])
        #expect(anchor == 32)
    }

    @Test func `objectAnchorBottomY keeps the rect bottom when the mask ends exactly there`() {
        let shelf = object(x: 0, y: 96, width: 64, height: 96)
        let anchor = WorldScene3D.objectAnchorBottomY(for: shelf, masks: [CollisionMask(x: 0, y: 160, width: 256, height: 32)])
        #expect(anchor == 192)
    }

    @Test func `objectAnchorBottomY never pulls a prop south of its rect bottom`() {
        // A chair behind a table overlaps the table's mask, which ends south of the chair's
        // own rect — anchoring to it would shove the chair into the table.
        let chair = object(x: 448, y: 144, width: 32, height: 64)
        let anchor = WorldScene3D.objectAnchorBottomY(for: chair, masks: [CollisionMask(x: 448, y: 184, width: 32, height: 40)])
        #expect(anchor == 208)
    }

    @Test func `objectAnchorBottomY ignores masks further than a cell above the rect bottom`() {
        let banner = object(x: 0, y: 0, width: 64, height: 96)
        let anchor = WorldScene3D.objectAnchorBottomY(for: banner, masks: [CollisionMask(x: 0, y: 0, width: 64, height: 16)])
        #expect(anchor == 96)
    }

    private func object(x: Int16, y: Int16, width: Int16, height: Int16) -> Object {
        Object(
            x: x, y: y, tilesetIndex: 25, sourceX: 0, sourceY: 512,
            sourceWidth: width, sourceHeight: height, priority: 0
        )
    }

    @Test func `movementPose maps player tempo to sneak-walk-run and never makes NPCs skulk`() {
        #expect(WorldScene3D.movementPose(kind: .player, tempo: .walk) == .sneaking)
        #expect(WorldScene3D.movementPose(kind: .peer, tempo: .run) == .running)
        #expect(WorldScene3D.movementPose(kind: .player, tempo: .default) == .walking)
        #expect(WorldScene3D.movementPose(kind: .npc, tempo: .walk) == .walking)
        #expect(WorldScene3D.movementPose(kind: .monster, tempo: .run) == .walking)
    }

    @Test func `characterScale is the mask-derived constant for canonically staged models`() {
        // Characters are staged at the canonical 1 m figure height (accessories excluded),
        // so the runtime scale must be a pure mask ratio — measuring the loaded model's
        // skinned bounds instead mis-sizes characters (animation envelopes, merged meshes).
        let scale = WorldScene3D.characterScale(maskSize: GridSize(width: 32, height: 48))
        let expected: Float = 48 * OrthographicCameraRig.worldUnitsPerPixel * (37.0 / 48.0)
        #expect(abs(scale.x - expected / WorldScene3D.canonicalFigureHeight) < 0.0001)
        #expect(scale.x == scale.y && scale.y == scale.z)
    }

    @Test func `a sub-pixel updatePosition lands the node between grid columns`() throws {
        let scene = scene()
        scene.load(sector: tinySector(), awaitingPlayerPlacement: false)
        scene.placeEntity(worldEntity(id: 0, kind: .player))
        let start = try #require(scene._entityNodeProbe(for: 0)).nodePosition
        scene.updatePosition(entityID: 0, to: SubpixelPoint(x: 96.5, y: 96), facing: Heading(cardinal: .south))
        let moved = try #require(scene._entityNodeProbe(for: 0)).nodePosition
        #expect(abs(moved.x - (start.x + 0.5 * OrthographicCameraRig.worldUnitsPerPixel)) < 0.0001)
        #expect(moved.z == start.z)
        #expect(scene.cameraEntity.position == OrthographicCameraRig.cameraPosition(focusing: moved))
    }

    // MARK: - Tick-driven motion

    @Test func `animateEntity glides the node across ticks instead of teleporting`() throws {
        let scene = scene()
        scene.load(sector: tinySector(), awaitingPlayerPlacement: false)
        scene.placeEntity(worldEntity(id: 1, kind: .peer, position: GridPoint(x: 0, y: 0)))
        let start = try #require(scene._entityNodeProbe(for: 1)).nodePosition
        scene.animateEntity(1, to: GridPoint(x: 100, y: 0), facing: Heading(cardinal: .east), duration: 0.5)
        let target = start + SIMD3<Float>(100 * OrthographicCameraRig.worldUnitsPerPixel, 0, 0)
        scene.tick(deltaTime: 0.1)
        let midway = try #require(scene._entityNodeProbe(for: 1)).nodePosition
        #expect(midway.x > start.x)
        #expect(midway.x < target.x)
        for _ in 0 ..< 5 {
            scene.tick(deltaTime: 0.1)
        }
        let arrived = try #require(scene._entityNodeProbe(for: 1)).nodePosition
        #expect(length(arrived - target) < 0.0001)
    }

    @Test func `ticks slew the node yaw toward the facing at the fixed turn rate`() throws {
        let scene = scene()
        scene.load(sector: tinySector(), awaitingPlayerPlacement: false)
        scene.placeEntity(worldEntity(id: 1, facing: Heading(cardinal: .south)))
        scene.updatePosition(entityID: 1, to: GridPoint(x: 96, y: 96), facing: Heading(cardinal: .east))
        scene.tick(deltaTime: 0.05)
        let partway = try #require(scene._entityNodeProbe(for: 1)).orientation
        let forward = partway.act(SIMD3<Float>(0, 0, 1))
        let partYaw = atan2(forward.x, forward.z)
        #expect(partYaw > 0)
        #expect(partYaw < .pi / 2)
        for _ in 0 ..< 4 {
            scene.tick(deltaTime: 0.05)
        }
        let settled = try #require(scene._entityNodeProbe(for: 1)).orientation
        let settledForward = settled.act(SIMD3<Float>(0, 0, 1))
        #expect(abs(atan2(settledForward.x, settledForward.z) - .pi / 2) < 0.001)
    }

    // MARK: - Speech bubbles

    @Test func `a speech bubble attaches to its speaker and expires on the tick clock`() throws {
        let scene = scene()
        scene.load(sector: tinySector(), awaitingPlayerPlacement: false)
        scene.placeEntity(worldEntity(id: 1))
        scene.showSpeechBubble(above: 1, lines: ["Sei gegrüßt!"], lifetimeMs: 300)
        #expect(try #require(scene._entityNodeProbe(for: 1)).hasSpeechBubble)
        for _ in 0 ..< 4 {
            scene.tick(deltaTime: 0.1)
        }
        #expect(try #require(scene._entityNodeProbe(for: 1)).hasSpeechBubble == false)
    }

    // MARK: - Deferred reveal

    @Test func `an awaiting load parks the outgoing sector and hides the incoming one`() {
        let scene = scene()
        scene.load(sector: tinySector(), awaitingPlayerPlacement: false)
        scene.load(sector: tinySector(objectCount: 1), awaitingPlayerPlacement: true)
        let probe = scene._heldSwapProbe()
        #expect(probe.pendingPlayerReveal)
        #expect(probe.hasParkedPreviousRoot)
        #expect(probe.sectorRootEnabled == false)
        // Both roots are in the graph during the hold: persistent trio + outgoing + incoming.
        #expect(scene.rootEntity.children.count == Self.persistentChildren + 2)
    }

    @Test func `placing the player reveals the held sector atomically`() {
        let scene = scene()
        scene.load(sector: tinySector(), awaitingPlayerPlacement: false)
        scene.load(sector: tinySector(), awaitingPlayerPlacement: true)
        scene.placeEntity(worldEntity(id: 0, kind: .player))
        let probe = scene._heldSwapProbe()
        #expect(!probe.pendingPlayerReveal)
        #expect(!probe.hasParkedPreviousRoot)
        #expect(probe.sectorRootEnabled == true)
        #expect(scene.rootEntity.children.count == Self.persistentChildren + 1)
    }

    @Test func `placing a non-player entity does not reveal the held sector`() {
        let scene = scene()
        scene.load(sector: tinySector(), awaitingPlayerPlacement: false)
        scene.load(sector: tinySector(), awaitingPlayerPlacement: true)
        scene.placeEntity(worldEntity(id: 1, kind: .npc))
        let probe = scene._heldSwapProbe()
        #expect(probe.pendingPlayerReveal)
        #expect(probe.sectorRootEnabled == false)
    }

    @Test func `a non-awaiting load reveals immediately`() {
        let scene = scene()
        scene.load(sector: tinySector(), awaitingPlayerPlacement: false)
        let probe = scene._heldSwapProbe()
        #expect(!probe.pendingPlayerReveal)
        #expect(probe.sectorRootEnabled == true)
        #expect(!probe.hasParkedPreviousRoot)
    }

    @Test func `showSplash drops a parked sector mid-switch`() {
        let scene = scene()
        scene.load(sector: tinySector(), awaitingPlayerPlacement: false)
        scene.load(sector: tinySector(objectCount: 2), awaitingPlayerPlacement: true)
        scene.showSplash()
        let probe = scene._heldSwapProbe()
        #expect(scene.rootEntity.children.count == Self.persistentChildren)
        #expect(!probe.pendingPlayerReveal)
        #expect(!probe.hasParkedPreviousRoot)
        #expect(probe.pendingSunState == nil)
    }

    // MARK: - Deferred lighting

    @Test func `a tint update during a held switch is stashed, not applied`() {
        let scene = scene()
        scene.load(sector: tinySector(), awaitingPlayerPlacement: false)
        let appliedBefore = scene._heldSwapProbe().appliedSunIntensity
        scene.load(sector: tinySector(), awaitingPlayerPlacement: true)
        scene.updateDayNightTint(hour: 0, minute: 0, sectorLight: LightSetting(indoor: true, brightness: 75))
        let probe = scene._heldSwapProbe()
        #expect(probe.appliedSunIntensity == appliedBefore)
        #expect(probe.pendingSunState == DayNightSun.state(hour: 0, minute: 0, sectorLight: LightSetting(indoor: true, brightness: 75)))
    }

    @Test func `the reveal applies the stashed destination lighting`() {
        let scene = scene()
        scene.load(sector: tinySector(), awaitingPlayerPlacement: false)
        scene.load(sector: tinySector(), awaitingPlayerPlacement: true)
        let destination = LightSetting(indoor: true, brightness: 75)
        scene.updateDayNightTint(hour: 0, minute: 0, sectorLight: destination)
        scene.placeEntity(worldEntity(id: 0, kind: .player))
        let probe = scene._heldSwapProbe()
        #expect(probe.pendingSunState == nil)
        #expect(probe.appliedSunIntensity == DayNightSun.state(hour: 0, minute: 0, sectorLight: destination).sunIntensity)
    }

    @Test func `a tint update outside a held switch applies immediately`() {
        let scene = scene()
        scene.load(sector: tinySector(), awaitingPlayerPlacement: false)
        let midnight = LightSetting(indoor: false, brightness: 100)
        scene.updateDayNightTint(hour: 0, minute: 0, sectorLight: midnight)
        let probe = scene._heldSwapProbe()
        #expect(probe.appliedSunIntensity == DayNightSun.state(hour: 0, minute: 0, sectorLight: midnight).sunIntensity)
        #expect(probe.pendingSunState == nil)
    }

    // MARK: - Post-prewarm re-resolution

    @Test func `prewarm completion swaps placeholders for real models in place`() async throws {
        let assets = StubModelAssets()
        let scene = scene(assets: assets)
        scene.load(sector: tinySector(objectCount: 1), awaitingPlayerPlacement: false)
        scene.placeEntity(worldEntity(id: 1))
        #expect(scene._placeholderObjectCount() == 1)
        #expect(try #require(scene._entityNodeProbe(for: 1)).isPlaceholder)
        await scene.prewarmModels()
        #expect(scene._placeholderObjectCount() == 0)
        let healed = try #require(scene._entityNodeProbe(for: 1))
        #expect(!healed.isPlaceholder)
    }

    @Test func `re-resolution reaches the hidden pending root without revealing it`() async {
        let assets = StubModelAssets()
        let scene = scene(assets: assets)
        scene.load(sector: tinySector(), awaitingPlayerPlacement: false)
        scene.load(sector: tinySector(objectCount: 1), awaitingPlayerPlacement: true)
        #expect(scene._placeholderObjectCount() == 1)
        await scene.prewarmModels()
        let probe = scene._heldSwapProbe()
        #expect(scene._placeholderObjectCount() == 0)
        #expect(probe.pendingPlayerReveal)
        #expect(probe.sectorRootEnabled == false)
    }

    @Test func `an absent pack keeps placeholders after prewarm without trapping`() async throws {
        let assets = StubModelAssets(resolvesAfterPrewarm: false)
        let scene = scene(assets: assets)
        scene.load(sector: tinySector(objectCount: 1), awaitingPlayerPlacement: false)
        scene.placeEntity(worldEntity(id: 1))
        await scene.prewarmModels()
        #expect(scene._placeholderObjectCount() == 1)
        #expect(try #require(scene._entityNodeProbe(for: 1)).isPlaceholder)
    }

    @Test func `re-placing an id with a changed kind re-resolves its model`() throws {
        // Only the npc band resolves, so an identity change on the same id must swap the
        // rendered model in both directions (real -> placeholder and back), not keep serving
        // the stale one.
        let scene = WorldScene3D(modelAssets: NPCOnlyStubAssets())
        scene.load(sector: tinySector(), awaitingPlayerPlacement: false)

        scene.placeEntity(worldEntity(id: 1, kind: .npc))
        #expect(try #require(scene._entityNodeProbe(for: 1)).isPlaceholder == false)

        scene.placeEntity(worldEntity(id: 1, kind: .monster))
        #expect(try #require(scene._entityNodeProbe(for: 1)).isPlaceholder)

        scene.placeEntity(worldEntity(id: 1, kind: .npc))
        #expect(try #require(scene._entityNodeProbe(for: 1)).isPlaceholder == false)
    }
}

/// Resolves a model for the npc band only, so a same-id kind change flips between the real
/// model and the placeholder — observable through `_entityNodeProbe`.
@MainActor
private final class NPCOnlyStubAssets: ModelAssets {
    func prewarm() async {}

    func entity(forKind kind: WorldEntity.Kind, figure _: Int16) -> Entity? {
        kind == .npc ? Entity() : nil
    }

    func object(forSignature _: SourceRectSignature) -> Entity? {
        nil
    }

    func groundTexture(tilesetIndex _: Int16, sourceX _: Int16, sourceY _: Int16) -> TextureResource? {
        nil
    }

    func groundMaterialTexture(tilesetIndex _: Int16, sourceX _: Int16, sourceY _: Int16) -> TextureResource? {
        nil
    }

    func floorMaterialURL(forID _: String) -> URL? {
        nil
    }
}
