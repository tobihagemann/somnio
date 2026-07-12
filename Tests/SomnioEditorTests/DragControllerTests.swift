import CoreGraphics
import Foundation
import simd
import SomnioCore
import Testing
@testable import SomnioEditor
@testable import SomnioScene3D

@MainActor
struct DragControllerTests {
    private static let viewportSize = CGSize(width: 640, height: 480)

    private var framing: EditorFraming {
        OrthographicCameraRig.editorFraming(
            fittingPixelBounds: .zero, SIMD2<Float>(512, 512),
            viewportSize: SIMD2<Float>(Float(Self.viewportSize.width), Float(Self.viewportSize.height))
        )
    }

    /// Viewport point where a legacy pixel lands under the framing — the press/drag
    /// location a user aiming at that pixel would produce.
    private func viewportPoint(forPixel pixel: SIMD2<Float>) -> CGPoint {
        let point = OrthographicCameraRig.viewportPoint(
            forLegacyPoint: pixel,
            viewportSize: SIMD2<Float>(Float(Self.viewportSize.width), Float(Self.viewportSize.height)),
            framing: framing
        )
        return CGPoint(x: CGFloat(point.x), y: CGFloat(point.y))
    }

    private func body(
        objects: [Object] = [],
        masks: [CollisionMask] = [],
        portals: [SectorPortal] = [],
        npcs: [NPC] = [],
        monsterSpawns: [MonsterSpawn] = []
    ) -> SectorBody {
        SectorBody(
            version: 1,
            dimensions: GridSize(width: 4, height: 4),
            floorMaterialID: "grass-meadow",
            light: LightSetting(indoor: false, brightness: 100),
            objects: objects,
            collisionMasks: masks,
            portals: portals,
            npcs: npcs,
            monsterSpawns: monsterSpawns
        )
    }

    private func npc(at origin: GridPoint, boxSize: GridSize = GridSize(width: 32, height: 32), facing: Heading = Heading(cardinal: .south)) -> NPC {
        NPC(
            spawnOrigin: origin, spawnBoxSize: boxSize, maskSize: GridSize(width: 32, height: 48),
            name: "Libus", figure: 16, facing: facing, behaviorTag: 0, dialogScript: ""
        )
    }

    // MARK: - Move

    @Test func `a drag delta quantizes to the grid step preserving relative offsets`() {
        let delta = DragController.gridDelta(
            fromViewport: viewportPoint(forPixel: SIMD2<Float>(100, 100)),
            toViewport: viewportPoint(forPixel: SIMD2<Float>(140, 30)),
            viewportSize: Self.viewportSize, framing: framing, step: 32
        )
        #expect(delta.dx == 32)
        #expect(delta.dy == -64)
    }

    @Test func `a free-snap drag delta stays pixel-exact`() {
        let delta = DragController.gridDelta(
            fromViewport: viewportPoint(forPixel: SIMD2<Float>(100, 100)),
            toViewport: viewportPoint(forPixel: SIMD2<Float>(103, 95)),
            viewportSize: Self.viewportSize, framing: framing, step: 0
        )
        #expect(delta.dx == 3)
        #expect(delta.dy == -5)
    }

    @Test func `a group move shifts every snapshotted origin by the same delta`() {
        var body = body(
            objects: [Object(x: 0, y: 0, modelID: "door", sourceWidth: 32, sourceHeight: 32, priority: 0)],
            npcs: [npc(at: GridPoint(x: 100, y: 100))]
        )
        let originals = DragController.origins(of: [.object(0), .npc(0)], in: body)
        DragController.applyMove(originals: originals, dx: 64, dy: -32, to: &body)
        #expect(body.objects[0].x == 64)
        #expect(body.objects[0].y == -32)
        #expect(body.npcs[0].spawnOrigin == GridPoint(x: 164, y: 68))
    }

    @Test func `a move at the Int16 limits clamps instead of trapping`() {
        var body = body(masks: [CollisionMask(x: Int16.max - 1, y: Int16.min + 1, width: 32, height: 32)])
        let originals = DragController.origins(of: [.mask(0)], in: body)
        DragController.applyMove(originals: originals, dx: 10000, dy: -10000, to: &body)
        #expect(body.collisionMasks[0].x == Int16.max)
        #expect(body.collisionMasks[0].y == Int16.min)
    }

    // MARK: - Resize

    @Test func `dragging the bottom-right handle grows the record in place`() {
        let bounds = DragController.resizedBounds(
            origin: GridPoint(x: 64, y: 64), size: GridSize(width: 32, height: 32),
            handle: .bottomRight, dx: 32, dy: 64, minExtent: 32
        )
        #expect(bounds.origin == GridPoint(x: 64, y: 64))
        #expect(bounds.size == GridSize(width: 64, height: 96))
    }

    @Test func `dragging the top-left handle shifts the origin and shrinks the extent`() {
        let bounds = DragController.resizedBounds(
            origin: GridPoint(x: 64, y: 64), size: GridSize(width: 96, height: 96),
            handle: .topLeft, dx: 32, dy: 32, minExtent: 32
        )
        #expect(bounds.origin == GridPoint(x: 96, y: 96))
        #expect(bounds.size == GridSize(width: 64, height: 64))
    }

    @Test func `resizing past the opposite edge clamps at the minimum extent`() {
        let bounds = DragController.resizedBounds(
            origin: GridPoint(x: 64, y: 64), size: GridSize(width: 96, height: 96),
            handle: .right, dx: -500, dy: 0, minExtent: 32
        )
        #expect(bounds.origin == GridPoint(x: 64, y: 64))
        #expect(bounds.size == GridSize(width: 32, height: 96))
    }

    @Test func `a resize at the Int16 limits clamps instead of trapping`() {
        let bounds = DragController.resizedBounds(
            origin: GridPoint(x: Int16.max - 32, y: 0), size: GridSize(width: 32, height: 32),
            handle: .bottomRight, dx: 40000, dy: 40000, minExtent: 1
        )
        // The right edge already sits at the coordinate limit, so the width cannot grow;
        // the bottom edge clamps to the limit.
        #expect(bounds.origin == GridPoint(x: Int16.max - 32, y: 0))
        #expect(bounds.size.width == 32)
        #expect(Int32(bounds.origin.y) + Int32(bounds.size.height) == Int32(Int16.max))
    }

    @Test func `a resize keeps the minimum extent when the fixed edge sits at the domain limit`() {
        // A record whose origin was clamped to `Int16.max` by a move/paste: growing its
        // right edge cannot enter the representable domain, but the extent must keep the
        // minimum-extent floor instead of collapsing to zero.
        let bounds = DragController.resizedBounds(
            origin: GridPoint(x: Int16.max, y: 0), size: GridSize(width: 8, height: 8),
            handle: .right, dx: 100, dy: 0, minExtent: 32
        )
        #expect(bounds.size.width >= 32)
    }

    @Test func `an over-limit resize keeps the opposite edge fixed`() {
        // Dragging the left edge far past the domain: the moved edge clamps, and the
        // fixed right edge (origin.x + width) must stay exactly where it was — clamping
        // origin and size independently used to shift it by tens of thousands of pixels.
        let original = (origin: GridPoint(x: Int16.min + 8, y: 0), size: GridSize(width: 32, height: 32))
        let bounds = DragController.resizedBounds(
            origin: original.origin, size: original.size,
            handle: .left, dx: -40000, dy: 0, minExtent: 1
        )
        let fixedRightEdge = Int32(original.origin.x) + Int32(original.size.width)
        #expect(Int32(bounds.origin.x) + Int32(bounds.size.width) == fixedRightEdge)
        #expect(bounds.origin.x == Int16.min)
    }

    @Test func `an NPC handle resize writes the spawn box`() {
        var body = body(npcs: [npc(at: GridPoint(x: 100, y: 100))])
        DragController.applyBounds(.npc(0), origin: GridPoint(x: 90, y: 90), size: GridSize(width: 64, height: 48), to: &body)
        #expect(body.npcs[0].spawnOrigin == GridPoint(x: 90, y: 90))
        #expect(body.npcs[0].spawnBoxSize == GridSize(width: 64, height: 48))
    }

    // MARK: - Placement

    @Test func `a placement tap drops the default one-tile footprint at the anchor`() {
        let anchor = GridPoint(x: 128, y: 96)
        let press = viewportPoint(forPixel: SIMD2<Float>(130, 98))
        let bounds = DragController.placementBounds(
            tool: .mask, anchor: anchor, start: press, end: press,
            viewportSize: Self.viewportSize, framing: framing, step: 32
        )
        #expect(bounds.origin == anchor)
        #expect(bounds.size == DragController.defaultFootprint)
    }

    @Test func `a placement drag rubber-bands the quantized footprint`() {
        let anchor = GridPoint(x: 128, y: 96)
        let bounds = DragController.placementBounds(
            tool: .mask, anchor: anchor,
            start: viewportPoint(forPixel: SIMD2<Float>(128, 96)),
            end: viewportPoint(forPixel: SIMD2<Float>(230, 170)),
            viewportSize: Self.viewportSize, framing: framing, step: 32
        )
        #expect(bounds.origin == anchor)
        #expect(bounds.size == GridSize(width: 96, height: 64))
    }

    @Test func `a backwards rubber band normalizes and keeps one snap step minimum`() {
        let bounds = DragController.rubberBandBounds(
            from: GridPoint(x: 128, y: 96), to: GridPoint(x: 96, y: 96), minExtent: 32
        )
        #expect(bounds.origin == GridPoint(x: 96, y: 96))
        #expect(bounds.size == GridSize(width: 32, height: 32))
    }

    @Test(arguments: EditorTool.allCases.filter { $0 != .select })
    func `direct placement appends the retired dialogs' default record and selects it`(tool: EditorTool) throws {
        var body = body()
        let placed = try #require(DragController.placeRecord(
            tool: tool, origin: GridPoint(x: 64, y: 64), size: DragController.defaultFootprint, into: &body
        ))
        #expect(placed.isValid(in: body))
        let bounds = try #require(placed.bounds(in: body))
        #expect(bounds.origin == GridPoint(x: 64, y: 64))
        #expect(bounds.size == DragController.defaultFootprint)
        switch placed {
        case let .object(index):
            // The picker default comes from the committed registry so a fresh record
            // can only reference a resolvable model.
            #expect(body.objects[index].modelID == EditorDefaults.defaultObjectModelID)
            #expect(EditorDefaults.objectModelIDs.contains(body.objects[index].modelID))
        case let .npc(index):
            #expect(body.npcs[index].facing == Heading(cardinal: .south))
        case let .monsterSpawn(index):
            #expect(body.monsterSpawns[index].spawnHP == 100)
            #expect(body.monsterSpawns[index].bounded)
        case .mask, .portal:
            break
        }
    }

    // MARK: - Handles

    @Test func `the pressed handle resolves by its projected screen rect`() {
        let origin = GridPoint(x: 64, y: 64)
        let size = GridSize(width: 128, height: 128)
        let bottomRight = viewportPoint(forPixel: SIMD2<Float>(192, 192))
        #expect(DragController.hitHandle(
            at: bottomRight, origin: origin, size: size,
            viewportSize: Self.viewportSize, framing: framing
        ) == .bottomRight)
        let farAway = viewportPoint(forPixel: SIMD2<Float>(400, 400))
        #expect(DragController.hitHandle(
            at: farAway, origin: origin, size: size,
            viewportSize: Self.viewportSize, framing: framing
        ) == nil)
    }

    @Test func `the facing handle sits past the spawn box along the heading`() {
        let handle = DragController.facingHandlePixel(
            origin: GridPoint(x: 100, y: 100), size: GridSize(width: 32, height: 32),
            heading: Heading(cardinal: .east), clearancePx: 24
        )
        // Center (116, 116) + east direction × (half extent 16 + clearance 24).
        #expect(abs(handle.x - 156) < 0.001)
        #expect(abs(handle.y - 116) < 0.001)
    }

    // MARK: - Rotate

    @Test(arguments: [Direction.south, .east, .north, .west])
    func `a facing drag toward a cardinal lands on its exact degrees`(direction: Direction) {
        // The persisted NPC carries the continuous heading, so a drag along a cardinal
        // axis must produce the exact cardinal degrees.
        let subject = npc(at: GridPoint(x: 100, y: 100))
        let center = DragController.spawnBoxCenter(origin: subject.spawnOrigin, size: subject.spawnBoxSize)
        let offset: SIMD2<Float> = switch direction {
        case .south: SIMD2(0, 100)
        case .east: SIMD2(100, 0)
        case .north: SIMD2(0, -100)
        case .west: SIMD2(-100, 0)
        }
        let heading = DragController.heading(
            fromViewport: viewportPoint(forPixel: center + offset),
            npc: subject, viewportSize: Self.viewportSize, framing: framing
        )
        #expect(abs(heading.angularDistance(to: Heading(cardinal: direction))) < 0.5)
    }

    @Test func `a facing drag across the north-south seam normalizes into the half-open range`() {
        let subject = npc(at: GridPoint(x: 100, y: 100))
        let center = DragController.spawnBoxCenter(origin: subject.spawnOrigin, size: subject.spawnBoxSize)
        // Just west of due south: the raw atan2 angle is a small negative, which must
        // fold into [0, 360) rather than escaping as -0.x degrees.
        let heading = DragController.heading(
            fromViewport: viewportPoint(forPixel: center + SIMD2<Float>(-1, 200)),
            npc: subject, viewportSize: Self.viewportSize, framing: framing
        )
        #expect(heading.degrees >= 0)
        #expect(heading.degrees < 360)
        #expect(abs(heading.angularDistance(to: Heading(degrees: 0))) < 2)
    }

    // MARK: - Marquee

    private func boundingBox(of corners: [CGPoint]) -> CGRect {
        let xs = corners.map(\.x)
        let ys = corners.map(\.y)
        return CGRect(
            x: xs.min() ?? 0, y: ys.min() ?? 0,
            width: (xs.max() ?? 0) - (xs.min() ?? 0), height: (ys.max() ?? 0) - (ys.min() ?? 0)
        )
    }

    @Test func `the marquee selects records whose projected quads intersect it`() {
        let body = body(
            objects: [Object(x: 0, y: 0, modelID: "door", sourceWidth: 32, sourceHeight: 32, priority: 0)],
            masks: [CollisionMask(x: 400, y: 400, width: 32, height: 32)]
        )
        let corners = DragController.projectedCorners(
            origin: GridPoint(x: 0, y: 0), size: GridSize(width: 32, height: 32),
            viewportSize: Self.viewportSize, framing: framing
        )
        let hits = DragController.marqueeSelections(
            in: body, viewportRect: boundingBox(of: corners).insetBy(dx: -4, dy: -4),
            viewportSize: Self.viewportSize, framing: framing
        )
        #expect(hits == [.object(0)])
        let empty = DragController.marqueeSelections(
            in: body, viewportRect: CGRect(x: -50, y: -50, width: 10, height: 10),
            viewportSize: Self.viewportSize, framing: framing
        )
        #expect(empty.isEmpty)
    }

    @Test func `a marquee inside the projected bounding box but outside the quad selects nothing`() {
        // The tilted camera projects a floor rect to a rotated quad; its screen bounding
        // box covers empty ground around it. A marquee (or a click's degenerate rect) in
        // that dead corner must not select the record — the bug that made an empty-ground
        // click select a half-map arrival portal.
        let portal = SectorPortal(x: 0, y: 32, width: 256, height: 288, targetSectorName: "EdariaBibliothek", direction: .arrivalPlacement)
        let body = body(portals: [portal])
        let corners = DragController.projectedCorners(
            origin: GridPoint(x: 0, y: 32), size: GridSize(width: 256, height: 288),
            viewportSize: Self.viewportSize, framing: framing
        )
        let box = boundingBox(of: corners)
        let deadCorner = CGRect(x: box.minX + 1, y: box.minY + 1, width: 2, height: 2)
        #expect(!DragController.rectIntersectsConvexQuad(deadCorner, corners))
        let hits = DragController.marqueeSelections(
            in: body, viewportRect: deadCorner,
            viewportSize: Self.viewportSize, framing: framing
        )
        #expect(hits.isEmpty)
    }

    @Test func `pressing a selected record's handle begins a resize session`() {
        let body = body(masks: [CollisionMask(x: 64, y: 64, width: 128, height: 128)])
        let begun = DragController.beginSession(
            at: viewportPoint(forPixel: SIMD2<Float>(192, 192)), tool: .select, additive: false,
            body: body, selection: [.mask(0)],
            viewportSize: Self.viewportSize, framing: framing
        )
        #expect(begun.session == .resize(
            selection: .mask(0), handle: .bottomRight,
            origin: GridPoint(x: 64, y: 64), size: GridSize(width: 128, height: 128)
        ))
        #expect(begun.selection == [.mask(0)])
    }

    @Test func `pressing a selected NPC's facing handle begins a rotate session`() {
        let subject = npc(at: GridPoint(x: 200, y: 200))
        let body = body(npcs: [subject])
        let pxPerPt = DragController.legacyPixelsPerViewportPoint(viewportSize: Self.viewportSize, framing: framing)
        let handlePixel = DragController.facingHandlePixel(
            origin: subject.spawnOrigin, size: subject.spawnBoxSize, heading: subject.facing,
            clearancePx: Float(DragController.facingClearancePt) * pxPerPt
        )
        let begun = DragController.beginSession(
            at: viewportPoint(forPixel: handlePixel), tool: .select, additive: false,
            body: body, selection: [.npc(0)],
            viewportSize: Self.viewportSize, framing: framing
        )
        #expect(begun.session == .rotate(npcIndex: 0))
    }

    @Test func `a shift-click toggles membership and starts no session`() {
        let body = body(masks: [
            CollisionMask(x: 0, y: 0, width: 64, height: 64),
            CollisionMask(x: 200, y: 200, width: 64, height: 64)
        ])
        let press = viewportPoint(forPixel: SIMD2<Float>(230, 230))
        let added = DragController.beginSession(
            at: press, tool: .select, additive: true,
            body: body, selection: [.mask(0)],
            viewportSize: Self.viewportSize, framing: framing
        )
        #expect(added.session == nil)
        #expect(added.selection == [.mask(0), .mask(1)])
        let removed = DragController.beginSession(
            at: press, tool: .select, additive: true,
            body: body, selection: [.mask(0), .mask(1)],
            viewportSize: Self.viewportSize, framing: framing
        )
        #expect(removed.session == nil)
        #expect(removed.selection == [.mask(0)])
    }

    @Test func `pressing a selected record moves the whole selection`() {
        let body = body(masks: [
            CollisionMask(x: 0, y: 0, width: 64, height: 64),
            CollisionMask(x: 200, y: 200, width: 64, height: 64)
        ])
        let begun = DragController.beginSession(
            at: viewportPoint(forPixel: SIMD2<Float>(30, 30)), tool: .select, additive: false,
            body: body, selection: [.mask(0), .mask(1)],
            viewportSize: Self.viewportSize, framing: framing
        )
        guard case let .move(originals) = begun.session else {
            Issue.record("expected a move session, got \(String(describing: begun.session))")
            return
        }
        #expect(Set(originals.keys) == [.mask(0), .mask(1)])
        #expect(begun.selection == [.mask(0), .mask(1)])
    }

    @Test func `pressing an unselected record retargets the selection before moving`() {
        let body = body(masks: [
            CollisionMask(x: 0, y: 0, width: 64, height: 64),
            CollisionMask(x: 200, y: 200, width: 64, height: 64)
        ])
        let begun = DragController.beginSession(
            at: viewportPoint(forPixel: SIMD2<Float>(230, 230)), tool: .select, additive: false,
            body: body, selection: [.mask(0)],
            viewportSize: Self.viewportSize, framing: framing
        )
        guard case let .move(originals) = begun.session else {
            Issue.record("expected a move session, got \(String(describing: begun.session))")
            return
        }
        #expect(Set(originals.keys) == [.mask(1)])
        #expect(begun.selection == [.mask(1)])
    }

    @Test func `the topmost record under the press wins over the selection beneath it`() {
        // A selected large mask lies under an unselected NPC: the press manipulates what
        // is visibly under the cursor, so it retargets to the NPC instead of dragging the
        // covered mask.
        let body = body(
            masks: [CollisionMask(x: 0, y: 0, width: 256, height: 256)],
            npcs: [npc(at: GridPoint(x: 100, y: 100))]
        )
        let begun = DragController.beginSession(
            at: viewportPoint(forPixel: SIMD2<Float>(110, 110)), tool: .select, additive: false,
            body: body, selection: [.mask(0)],
            viewportSize: Self.viewportSize, framing: framing
        )
        guard case let .move(originals) = begun.session else {
            Issue.record("expected a move session, got \(String(describing: begun.session))")
            return
        }
        #expect(Set(originals.keys) == [.npc(0)])
        #expect(begun.selection == [.npc(0)])
    }

    @Test func `a click on empty ground clears the selection and starts a marquee`() {
        let body = body(portals: [SectorPortal(x: 0, y: 32, width: 256, height: 288, targetSectorName: "EdariaBibliothek", direction: .arrivalPlacement)])
        // Legacy (319, 235) sits outside the portal rect but well inside its projected
        // bounding box — the press must deselect, not retarget onto the portal.
        let press = viewportPoint(forPixel: SIMD2<Float>(319, 235))
        let begun = DragController.beginSession(
            at: press, tool: .select, additive: false,
            body: body, selection: [.portal(0)],
            viewportSize: Self.viewportSize, framing: framing
        )
        #expect(begun.session == .marquee)
        #expect(begun.selection.isEmpty)
    }

    // MARK: - Group delete

    @Test func `a group delete removes exactly the selected records regardless of set order`() {
        var body = body(
            masks: [
                CollisionMask(x: 0, y: 0, width: 32, height: 32),
                CollisionMask(x: 100, y: 0, width: 32, height: 32),
                CollisionMask(x: 200, y: 0, width: 32, height: 32)
            ],
            npcs: [npc(at: GridPoint(x: 0, y: 0)), npc(at: GridPoint(x: 100, y: 100))]
        )
        EditorSelection.removeAll([.mask(0), .mask(2), .npc(1)], from: &body)
        #expect(body.collisionMasks == [CollisionMask(x: 100, y: 0, width: 32, height: 32)])
        #expect(body.npcs.count == 1)
        #expect(body.npcs[0].spawnOrigin == GridPoint(x: 0, y: 0))
    }

    // MARK: - Clipboard

    @Test func `paste anchors the payload's bounding corner at the cursor preserving offsets`() {
        let source = body(
            objects: [Object(x: 64, y: 64, modelID: "door", sourceWidth: 32, sourceHeight: 32, priority: 0)],
            masks: [CollisionMask(x: 96, y: 128, width: 32, height: 32)]
        )
        let clipboard = EditorClipboard.capture([.object(0), .mask(0)], from: source)
        var target = body()
        let inserted = clipboard.inserting(into: &target, anchor: GridPoint(x: 200, y: 200), fallbackOffset: 32)
        #expect(inserted.count == 2)
        #expect(target.objects[0].x == 200)
        #expect(target.objects[0].y == 200)
        #expect(target.collisionMasks[0].x == 232)
        #expect(target.collisionMasks[0].y == 264)
    }

    @Test func `duplicate offsets every clone by the fallback step`() {
        var body = body(npcs: [npc(at: GridPoint(x: 100, y: 100))])
        let clipboard = EditorClipboard.capture([.npc(0)], from: body)
        let inserted = clipboard.inserting(into: &body, anchor: nil, fallbackOffset: 32)
        #expect(inserted == [.npc(1)])
        #expect(body.npcs[1].spawnOrigin == GridPoint(x: 132, y: 132))
        #expect(body.npcs[1].name == body.npcs[0].name)
    }

    @Test func `a paste at the Int16 limits clamps instead of trapping`() {
        let source = body(masks: [CollisionMask(x: Int16.max - 8, y: Int16.max - 8, width: 32, height: 32)])
        let clipboard = EditorClipboard.capture([.mask(0)], from: source)
        var target = body()
        clipboard.inserting(into: &target, anchor: nil, fallbackOffset: Int16.max)
        #expect(target.collisionMasks[0].x == Int16.max)
        #expect(target.collisionMasks[0].y == Int16.max)
    }

    @Test func `capture skips stale selection indices instead of trapping`() {
        let source = body(masks: [CollisionMask(x: 0, y: 0, width: 32, height: 32)])
        let clipboard = EditorClipboard.capture([.mask(0), .mask(7), .npc(3)], from: source)
        #expect(clipboard.collisionMasks == [CollisionMask(x: 0, y: 0, width: 32, height: 32)])
        #expect(clipboard.npcs.isEmpty)
    }

    @Test func `capture preserves source-array order so pasted stacking cannot shuffle`() {
        // Overlapping records: picking prefers the later array index, so the capture must
        // carry ascending source order regardless of the selection set's iteration order.
        let masks = [
            CollisionMask(x: 0, y: 0, width: 64, height: 64),
            CollisionMask(x: 8, y: 8, width: 64, height: 64),
            CollisionMask(x: 16, y: 16, width: 64, height: 64)
        ]
        let source = body(masks: masks)
        let clipboard = EditorClipboard.capture([.mask(2), .mask(0), .mask(1)], from: source)
        #expect(clipboard.collisionMasks == masks)
    }

    @Test func `validatedPaste rejects oversized, malformed, and cap-busting payloads`() throws {
        let target = body()
        let anchor = GridPoint(x: 64, y: 64)
        // Oversized raw bytes: rejected before decoding.
        let oversized = Data(count: SomnioConstants.maxSectorFileBytes + 1)
        #expect(EditorClipboard.validatedPaste(data: oversized, into: target, anchor: anchor, fallbackOffset: 32) == nil)
        // Malformed JSON: rejected by the decoder.
        let malformed = Data("not json".utf8)
        #expect(EditorClipboard.validatedPaste(data: malformed, into: target, anchor: anchor, fallbackOffset: 32) == nil)
        // A payload that would push the document past the content caps: rejected by the
        // `MapCodec.write` round-trip gate.
        var overCap = EditorClipboard()
        overCap.collisionMasks = Array(
            repeating: CollisionMask(x: 0, y: 0, width: 32, height: 32),
            count: SomnioConstants.maxSectorCollisionMasks + 1
        )
        let overCapData = try JSONEncoder().encode(overCap)
        #expect(EditorClipboard.validatedPaste(data: overCapData, into: target, anchor: anchor, fallbackOffset: 32) == nil)
        // The happy path still lands the payload at the anchor.
        var small = EditorClipboard()
        small.collisionMasks = [CollisionMask(x: 0, y: 0, width: 32, height: 32)]
        let smallData = try JSONEncoder().encode(small)
        let pasted = try #require(EditorClipboard.validatedPaste(data: smallData, into: target, anchor: anchor, fallbackOffset: 32))
        #expect(pasted.body.collisionMasks == [CollisionMask(x: 64, y: 64, width: 32, height: 32)])
        #expect(pasted.selection == [.mask(0)])
    }

    // MARK: - Commit guards

    /// Document + workspace pair seeded with `body`, for the `endSession` orchestration
    /// tests (the geometry primitives above stay document-free).
    private func documentAndWorkspace(with body: SectorBody) -> (document: SectorDocument, workspace: SectorWorkspace) {
        let document = SectorDocument()
        document.mutate("Create new map", undoManager: nil) { $0 = body }
        let workspace = SectorWorkspaceRegistry.workspace(forID: document.id)
        return (document, workspace)
    }

    @Test func `a zero-travel move commits no mutation and registers no undo step`() {
        let (document, workspace) = documentAndWorkspace(with: body(masks: [CollisionMask(x: 64, y: 64, width: 64, height: 64)]))
        // Synchronous cleanup so the registry-drain test never observes this workspace
        // (the document's own deinit discard runs on a later main-actor task).
        defer { SectorWorkspaceRegistry.discard(documentID: document.id) }
        let undoManager = UndoManager()
        let press = viewportPoint(forPixel: SIMD2<Float>(80, 80))
        DragController.endSession(
            .move(originals: [.mask(0): GridPoint(x: 64, y: 64)]),
            start: press, end: press, additive: false,
            document: document, workspace: workspace, undoManager: undoManager
        )
        #expect(document.body.collisionMasks[0] == CollisionMask(x: 64, y: 64, width: 64, height: 64))
        #expect(!undoManager.canUndo)
    }

    @Test func `a placement commit appends the record, selects it, and registers one undo step`() {
        let (document, workspace) = documentAndWorkspace(with: body())
        defer { SectorWorkspaceRegistry.discard(documentID: document.id) }
        let undoManager = UndoManager()
        let press = viewportPoint(forPixel: SIMD2<Float>(70, 70))
        DragController.endSession(
            .placement(tool: .mask, anchor: GridPoint(x: 64, y: 64)),
            start: press, end: press, additive: false,
            document: document, workspace: workspace, undoManager: undoManager
        )
        #expect(document.body.collisionMasks == [CollisionMask(
            x: 64, y: 64, width: DragController.defaultFootprint.width, height: DragController.defaultFootprint.height
        )])
        #expect(workspace.selection == [.mask(0)])
        #expect(undoManager.canUndo)
    }

    @Test func `a zero-travel resize commits no mutation and registers no undo step`() {
        let mask = CollisionMask(x: 64, y: 64, width: 64, height: 64)
        let (document, workspace) = documentAndWorkspace(with: body(masks: [mask]))
        defer { SectorWorkspaceRegistry.discard(documentID: document.id) }
        let undoManager = UndoManager()
        let press = viewportPoint(forPixel: SIMD2<Float>(128, 128))
        DragController.endSession(
            .resize(selection: .mask(0), handle: .bottomRight, origin: GridPoint(x: 64, y: 64), size: GridSize(width: 64, height: 64)),
            start: press, end: press, additive: false,
            document: document, workspace: workspace, undoManager: undoManager
        )
        #expect(document.body.collisionMasks == [mask])
        #expect(!undoManager.canUndo)
    }

    @Test func `a rotate back to the current heading commits no undo step`() {
        // Facing south (0°): a drag ending due south of the spawn-box center recomputes
        // exactly 0°, so the commit must be skipped rather than registering a no-op undo.
        let subject = npc(at: GridPoint(x: 100, y: 100))
        let (document, workspace) = documentAndWorkspace(with: body(npcs: [subject]))
        defer { SectorWorkspaceRegistry.discard(documentID: document.id) }
        let undoManager = UndoManager()
        let center = DragController.spawnBoxCenter(origin: subject.spawnOrigin, size: subject.spawnBoxSize)
        // Project through the WORKSPACE's live framing — endSession unprojects with it.
        let projected = OrthographicCameraRig.viewportPoint(
            forLegacyPoint: center + SIMD2<Float>(0, 60),
            viewportSize: SIMD2<Float>(workspace.viewportSize),
            framing: workspace.framing
        )
        let handle = CGPoint(x: CGFloat(projected.x), y: CGFloat(projected.y))
        DragController.endSession(
            .rotate(npcIndex: 0),
            start: handle, end: handle, additive: false,
            document: document, workspace: workspace, undoManager: undoManager
        )
        #expect(document.body.npcs[0].facing == subject.facing)
        #expect(!undoManager.canUndo)
    }

    @Test func `a rotate against a stale NPC index neither traps nor mutates`() {
        let (document, workspace) = documentAndWorkspace(with: body())
        defer { SectorWorkspaceRegistry.discard(documentID: document.id) }
        let before = document.body
        let undoManager = UndoManager()
        let press = viewportPoint(forPixel: SIMD2<Float>(100, 100))
        DragController.endSession(
            .rotate(npcIndex: 5),
            start: press, end: viewportPoint(forPixel: SIMD2<Float>(200, 200)), additive: false,
            document: document, workspace: workspace, undoManager: undoManager
        )
        #expect(document.body == before)
        #expect(!undoManager.canUndo)
    }

    @Test func `a reconcile clears any live drag session`() {
        let (document, workspace) = documentAndWorkspace(with: body())
        defer { SectorWorkspaceRegistry.discard(documentID: document.id) }
        workspace.dragSession = .marquee
        workspace.dragPreview = document.body
        workspace.dragAdditive = true
        workspace.reconcile(with: document.body, sectorName: "Test")
        #expect(workspace.dragSession == nil)
        #expect(workspace.dragPreview == nil)
        #expect(!workspace.dragAdditive)
    }

    @Test func `an additive marquee unions with the existing selection`() {
        let sector = body(masks: [
            CollisionMask(x: 0, y: 0, width: 32, height: 32),
            CollisionMask(x: 400, y: 400, width: 32, height: 32)
        ])
        let (document, workspace) = documentAndWorkspace(with: sector)
        defer { SectorWorkspaceRegistry.discard(documentID: document.id) }
        workspace.selection = [.mask(0)]
        let corners = DragController.projectedCorners(
            origin: GridPoint(x: 400, y: 400), size: GridSize(width: 32, height: 32),
            viewportSize: workspace.viewportSize, framing: workspace.framing
        )
        let box = boundingBox(of: corners).insetBy(dx: -4, dy: -4)
        DragController.endSession(
            .marquee,
            start: CGPoint(x: box.minX, y: box.minY), end: CGPoint(x: box.maxX, y: box.maxY),
            additive: true,
            document: document, workspace: workspace, undoManager: nil
        )
        #expect(workspace.selection == [.mask(0), .mask(1)])
    }
}
