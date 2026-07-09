import CoreGraphics
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
        private let floorTexture: TextureResource?
        private var warmed = false

        init(resolvesAfterPrewarm: Bool = true, floorTexture: TextureResource? = nil) {
            self.resolvesAfterPrewarm = resolvesAfterPrewarm
            self.floorTexture = floorTexture
        }

        func prewarm() async {
            warmed = resolvesAfterPrewarm
        }

        func entity(forKind _: WorldEntity.Kind, figure _: Int16) -> Entity? {
            warmed ? Entity() : nil
        }

        func object(forID _: String) -> Entity? {
            warmed ? Entity() : nil
        }

        func floorMaterialTexture(forID _: String) -> TextureResource? {
            warmed ? floorTexture : nil
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
                modelID: "bookshelf-ornate",
                sourceWidth: 64,
                sourceHeight: 96,
                priority: 0
            )
        }
        return Sector(
            name: "Test",
            version: 1,
            dimensions: GridSize(width: 4, height: 4),
            floorMaterialID: "grass-meadow",
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

    /// A 1x1 device-RGB texture — enough to drive the floor re-tint headlessly. Creating a
    /// `TextureResource` needs the RealityKit runtime but no display, so it runs in CI (see the
    /// suite doc); the pixel contents are irrelevant, only that the accessor returns non-nil.
    private func tinyFloorTexture() throws -> TextureResource {
        let context = try #require(CGContext(
            data: nil, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        let image = try #require(context.makeImage())
        return try TextureResource(image: image, options: .init(semantic: .color, mipmapsMode: .none))
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
        #expect(scene._floorIsFallback() == nil)
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
            x: x, y: y, modelID: "bookshelf",
            sourceWidth: width, sourceHeight: height, priority: 0
        )
    }

    @Test func `movementPose maps player tempo to sneak-walk-run and never makes NPCs skulk`() {
        #expect(WorldScene3D.movementPose(kind: .player, tempo: .walk, direction: .forward) == .sneaking)
        #expect(WorldScene3D.movementPose(kind: .peer, tempo: .run, direction: .forward) == .running)
        #expect(WorldScene3D.movementPose(kind: .player, tempo: .default, direction: .forward) == .walking)
        #expect(WorldScene3D.movementPose(kind: .npc, tempo: .walk, direction: .forward) == .walking)
        #expect(WorldScene3D.movementPose(kind: .monster, tempo: .run, direction: .forward) == .walking)
    }

    @Test func `movementPose collapses backpedal and strafe to their directional clip across every tempo`() {
        for tempo in Tempo.allCases {
            #expect(WorldScene3D.movementPose(kind: .player, tempo: tempo, direction: .backward) == .backpedal)
            #expect(WorldScene3D.movementPose(kind: .peer, tempo: tempo, direction: .strafeLeft) == .strafeLeft)
            #expect(WorldScene3D.movementPose(kind: .player, tempo: tempo, direction: .strafeRight) == .strafeRight)
        }
    }

    @Test func `movementPose ignores direction for NPCs and monsters`() {
        for direction in RelativeDirection.allCases {
            #expect(WorldScene3D.movementPose(kind: .npc, tempo: .default, direction: direction) == .walking)
            #expect(WorldScene3D.movementPose(kind: .monster, tempo: .run, direction: direction) == .walking)
        }
    }

    @Test func `a threaded backward travel drives the backpedal pose through tick`() throws {
        let scene = scene()
        scene.load(sector: tinySector(), awaitingPlayerPlacement: false)
        scene.placeEntity(worldEntity(id: 0, kind: .player, facing: Heading(cardinal: .south)))
        // Facing south while travelling north is a backpedal; the threaded travel drives the clip.
        scene.updatePosition(entityID: 0, to: SubpixelPoint(x: 96, y: 90), facing: Heading(cardinal: .south), travel: Heading(cardinal: .north))
        scene.tick(deltaTime: 0.01)
        let probe = try #require(scene._entityNodeProbe(for: 0))
        #expect(probe.travelHeading == Heading(cardinal: .north))
        #expect(probe.pose == .backpedal)
    }

    @Test func `a nil-travel tick preserves the recorded direction across the grace window`() throws {
        let scene = scene()
        scene.load(sector: tinySector(), awaitingPlayerPlacement: false)
        scene.placeEntity(worldEntity(id: 0, kind: .player, facing: Heading(cardinal: .south)))
        scene.updatePosition(entityID: 0, to: SubpixelPoint(x: 96, y: 90), facing: Heading(cardinal: .south), travel: Heading(cardinal: .north))
        // A stationary follow-up carries no travel; the last direction must survive for the glide.
        scene.updatePosition(entityID: 0, to: SubpixelPoint(x: 96, y: 90), facing: Heading(cardinal: .south))
        let probe = try #require(scene._entityNodeProbe(for: 0))
        #expect(probe.travelHeading == Heading(cardinal: .north))
    }

    @Test func `an authoritative grid snap clears the recorded travel direction`() throws {
        let scene = scene()
        scene.load(sector: tinySector(), awaitingPlayerPlacement: false)
        scene.placeEntity(worldEntity(id: 0, kind: .player, facing: Heading(cardinal: .south)))
        scene.updatePosition(entityID: 0, to: SubpixelPoint(x: 96, y: 90), facing: Heading(cardinal: .south), travel: Heading(cardinal: .north))
        // The GridPoint overload (arrivals / snapBack) is a discontinuity: the stale direction goes.
        scene.updatePosition(entityID: 0, to: GridPoint(x: 96, y: 96), facing: Heading(cardinal: .south))
        let probe = try #require(scene._entityNodeProbe(for: 0))
        #expect(probe.travelHeading == nil)
    }

    @Test func `a peer's travel direction is derived from its grid delta`() throws {
        let scene = scene()
        scene.load(sector: tinySector(), awaitingPlayerPlacement: false)
        scene.placeEntity(worldEntity(id: 1, kind: .peer, position: GridPoint(x: 0, y: 0), facing: Heading(cardinal: .south)))
        // Grid axes are x east, y south: an eastward step from a south-facer strafes to its left.
        scene.animateEntity(1, to: GridPoint(x: 100, y: 0), facing: Heading(cardinal: .south), duration: 0.5)
        scene.tick(deltaTime: 0.01)
        let probe = try #require(scene._entityNodeProbe(for: 1))
        #expect(probe.pose == .strafeLeft)
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

    @Test func `ticks slew the model yaw toward the facing at the fixed turn rate`() throws {
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

    @Test func `yaw slew rotates the model holder while the node stays unrotated`() throws {
        // The screen-aligned overlays (plaque, bubble) hang off the node: re-applying the
        // facing yaw to the node would tilt them with the character's heading.
        let scene = scene()
        scene.load(sector: tinySector(), awaitingPlayerPlacement: false)
        scene.placeEntity(worldEntity(id: 1, facing: Heading(cardinal: .south)))
        scene.updatePosition(entityID: 1, to: GridPoint(x: 96, y: 96), facing: Heading(cardinal: .east))
        for _ in 0 ..< 5 {
            scene.tick(deltaTime: 0.05)
        }
        let probe = try #require(scene._entityNodeProbe(for: 1))
        #expect(probe.orientation.angle > 0)
        #expect(probe.nodeOrientation.angle == 0)
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

    // MARK: - Name plaques

    @Test func `players and NPCs get a name plaque and monsters get none`() throws {
        let scene = scene()
        scene.load(sector: tinySector(), awaitingPlayerPlacement: false)
        scene.placeEntity(worldEntity(id: 0, kind: .player))
        scene.placeEntity(worldEntity(id: 1, kind: .peer))
        scene.placeEntity(worldEntity(id: 2, kind: .npc))
        scene.placeEntity(worldEntity(id: 3, kind: .monster))
        #expect(try #require(scene._entityNodeProbe(for: 0)).hasNamePlaque)
        #expect(try #require(scene._entityNodeProbe(for: 1)).hasNamePlaque)
        #expect(try #require(scene._entityNodeProbe(for: 2)).hasNamePlaque)
        #expect(try #require(scene._entityNodeProbe(for: 3)).hasNamePlaque == false)
    }

    @Test func `re-placing an entity keeps a single plaque instead of stacking`() throws {
        let scene = scene()
        scene.load(sector: tinySector(), awaitingPlayerPlacement: false)
        scene.placeEntity(worldEntity(id: 1))
        let before = try #require(scene._entityNodeProbe(for: 1)).namePlaqueID
        scene.placeEntity(worldEntity(id: 1))
        let probe = try #require(scene._entityNodeProbe(for: 1))
        #expect(probe.hasNamePlaque)
        #expect(probe.nodeChildCount == 2) // model holder + plaque
        // Same kind and name: the existing plaque survives — a rebuild here would churn
        // (remove + re-rasterize) on every re-sent EntityMessage.
        #expect(probe.namePlaqueID == before)
    }

    @Test func `a name plaque does not lift the speech bubble`() throws {
        // The bubble measures head height from the model holder, not the whole node: the
        // plaque's toward-camera lift gives it upward extent that would otherwise win the
        // bounds for a short model and shove the bubble up. A tiny mask makes the placeholder
        // shorter than the plaque, so a node-based measurement would diverge here.
        let scene = scene()
        scene.load(sector: tinySector(), awaitingPlayerPlacement: false)
        let tinyMask = GridSize(width: 8, height: 8)
        scene.placeEntity(WorldEntity(
            id: 1, kind: .npc, figure: 16, position: GridPoint(x: 96, y: 96),
            facing: Heading(cardinal: .south), tempo: .default, maskSize: tinyMask, name: "Probe"
        ))
        scene.placeEntity(WorldEntity(
            id: 2, kind: .monster, figure: 20, position: GridPoint(x: 160, y: 96),
            facing: Heading(cardinal: .south), tempo: .default, maskSize: tinyMask, name: "Probe"
        ))
        scene.showSpeechBubble(above: 1, lines: ["Hallo"], lifetimeMs: 1000)
        scene.showSpeechBubble(above: 2, lines: ["Hallo"], lifetimeMs: 1000)
        let plaquedProbe = try #require(scene._entityNodeProbe(for: 1))
        let bareProbe = try #require(scene._entityNodeProbe(for: 2))
        let plaqued = try #require(plaquedProbe.speechBubbleHeight)
        let bare = try #require(bareProbe.speechBubbleHeight)
        #expect(plaqued == bare)
    }

    @Test func `a kind change rebuilds the plaque and a monster sheds it`() throws {
        let scene = scene()
        scene.load(sector: tinySector(), awaitingPlayerPlacement: false)
        scene.placeEntity(worldEntity(id: 1, kind: .npc))
        scene.placeEntity(worldEntity(id: 1, kind: .monster))
        let monster = try #require(scene._entityNodeProbe(for: 1))
        #expect(monster.hasNamePlaque == false)
        #expect(monster.nodeChildCount == 1) // model holder only
        scene.placeEntity(worldEntity(id: 1, kind: .npc))
        #expect(try #require(scene._entityNodeProbe(for: 1)).hasNamePlaque)
    }

    @Test func `a same-kind name change rebuilds the plaque instead of reusing the stale label`() throws {
        let scene = scene()
        scene.load(sector: tinySector(), awaitingPlayerPlacement: false)
        var entity = worldEntity(id: 1, kind: .npc)
        scene.placeEntity(entity)
        let before = try #require(scene._entityNodeProbe(for: 1)).namePlaqueID
        entity.name = "Renamed"
        scene.placeEntity(entity)
        let after = try #require(scene._entityNodeProbe(for: 1))
        // A fresh plaque entity carries the new label; the old one is gone, not stacked under.
        #expect(after.namePlaqueID != nil)
        #expect(after.namePlaqueID != before)
        #expect(after.nodeChildCount == 2) // model holder + rebuilt plaque
    }

    // MARK: - Authoring overlay

    @Test func `the authoring overlay renders record rects and the selection under the sector root`() throws {
        let scene = scene()
        var sector = tinySector()
        sector.collisionMasks = [CollisionMask(x: 0, y: 0, width: 32, height: 32)]
        sector.portals = [SectorPortal(x: 64, y: 0, width: 32, height: 16, targetSectorName: "Other", direction: .outboundTrigger)]
        sector.npcs = [NPC(
            spawnOrigin: GridPoint(x: 96, y: 96), spawnBoxSize: GridSize(width: 32, height: 48),
            maskSize: GridSize(width: 32, height: 48), name: "Libus", figure: 16,
            facing: Heading(cardinal: .south), behaviorTag: 0, dialogScript: ""
        )]
        sector.monsterSpawns = [MonsterSpawn(
            spawnOrigin: GridPoint(x: 160, y: 160), spawnBoxSize: GridSize(width: 64, height: 64),
            spawnedMonsterSize: GridSize(width: 32, height: 48), name: "Gespenst", figure: 0,
            bounded: false, spawnHP: 100, spawnBalance: 100, spawnMana: 100, aiScriptIndex: 0
        )]
        scene.load(sector: sector, awaitingPlayerPlacement: false)
        #expect(scene._authoringOverlayChildCount() == nil)

        scene.updateAuthoringOverlay(
            body: sector.body,
            selectionBounds: (origin: GridPoint(x: 0, y: 0), size: GridSize(width: 32, height: 32)),
            showGridOverlay: false,
            gridStepPx: 32
        )
        // Mask + portal + NPC spawn + monster spawn rects + the selection border container.
        #expect(scene._authoringOverlayChildCount() == 5)
        // The overlay container joins the sector root, so a sector swap tears it down.
        #expect(scene._sectorRootChildCount() == 2) // floor + overlay

        // Rect geometry, not just counts: the mask plane sits at its authored rect's center
        // on the floor (no Y-flip), lifted just off the plane so it never z-fights the floor.
        let positions = try #require(scene._authoringOverlayChildPositions())
        let maskCenter = OrthographicCameraRig.worldPosition(forLegacyPoint: SIMD2<Float>(16, 16))
        let maskPlane = try #require(positions.first { abs($0.x - maskCenter.x) < 1e-4 && abs($0.z - maskCenter.z) < 1e-4 })
        #expect(maskPlane.y > 0)
        #expect(maskPlane.y < 0.05)
        let spawnCenter = OrthographicCameraRig.worldPosition(forLegacyPoint: SIMD2<Float>(112, 120))
        #expect(positions.contains { abs($0.x - spawnCenter.x) < 1e-4 && abs($0.z - spawnCenter.z) < 1e-4 })

        scene.updateAuthoringOverlay(body: sector.body, selectionBounds: nil, showGridOverlay: false, gridStepPx: 32)
        #expect(scene._authoringOverlayChildCount() == 4) // rebuilt from scratch, selection gone

        scene.load(sector: tinySector(), awaitingPlayerPlacement: false)
        #expect(scene._authoringOverlayChildCount() == nil)
    }

    @Test func `the grid toggle adds one grid container with a line per step across both axes`() {
        let scene = scene()
        let sector = tinySector()
        scene.load(sector: sector, awaitingPlayerPlacement: false)
        scene.updateAuthoringOverlay(body: sector.body, selectionBounds: nil, showGridOverlay: true, gridStepPx: 32)
        #expect(scene._authoringOverlayChildCount() == 1)
        // A 4×4-tile sector spans 512 px: 17 vertical + 17 horizontal lines at the 32 px step.
        #expect(scene._authoringOverlayGridLineCount() == 34)
        scene.updateAuthoringOverlay(body: sector.body, selectionBounds: nil, showGridOverlay: false, gridStepPx: 32)
        #expect(scene._authoringOverlayChildCount() == 0)
        #expect(scene._authoringOverlayGridLineCount() == nil)
    }

    @Test func `a grid past the line cap is suppressed instead of freezing the rebuild`() {
        // 12×12 tiles at the finest 4 px snap would emit (1536+1536)/4 + 2 = 770 planes,
        // past the cap — the grid is skipped entirely rather than stalling every refresh.
        let scene = scene()
        let sector = Sector(
            name: "Big",
            version: 1,
            dimensions: GridSize(width: 12, height: 12),
            floorMaterialID: "grass-meadow",
            light: LightSetting(indoor: false, brightness: 100)
        )
        scene.load(sector: sector, awaitingPlayerPlacement: false)
        scene.updateAuthoringOverlay(body: sector.body, selectionBounds: nil, showGridOverlay: true, gridStepPx: 4)
        #expect(scene._authoringOverlayChildCount() == 0)
        #expect(scene._authoringOverlayGridLineCount() == nil)
    }

    @Test func `a zero-extent record renders an empty placeholder instead of trapping`() {
        // An invalidated record mid-edit (width 0) must not reach `generatePlane`.
        let scene = scene()
        var sector = tinySector()
        sector.collisionMasks = [CollisionMask(x: 0, y: 0, width: 0, height: 32)]
        scene.load(sector: sector, awaitingPlayerPlacement: false)
        scene.updateAuthoringOverlay(body: sector.body, selectionBounds: nil, showGridOverlay: false, gridStepPx: 32)
        #expect(scene._authoringOverlayChildCount() == 1)
        #expect(scene._authoringOverlayChildPositions() == [.zero])
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

    @Test func `prewarm completion re-tints a fallback floor with its now-cached texture`() async throws {
        let assets = try StubModelAssets(floorTexture: tinyFloorTexture())
        let scene = scene(assets: assets)
        // Loading before the texture cache warms renders the gray-fallback floor.
        scene.load(sector: tinySector(), awaitingPlayerPlacement: false)
        #expect(scene._floorIsFallback() == true)
        #expect(scene._floorMaterialIsTextured() == false)
        await scene.prewarmModels()
        // Both the flag and the live material flip — asserting the material catches a heal that
        // clears the flag without swapping the texture in.
        #expect(scene._floorIsFallback() == false)
        #expect(scene._floorMaterialIsTextured() == true)
    }

    @Test func `an absent pack leaves the floor in fallback after prewarm without trapping`() async {
        let assets = StubModelAssets(resolvesAfterPrewarm: false)
        let scene = scene(assets: assets)
        scene.load(sector: tinySector(), awaitingPlayerPlacement: false)
        await scene.prewarmModels()
        #expect(scene._floorIsFallback() == true)
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

    func object(forID _: String) -> Entity? {
        nil
    }

    func floorMaterialTexture(forID _: String) -> TextureResource? {
        nil
    }

    func floorMaterialURL(forID _: String) -> URL? {
        nil
    }
}
