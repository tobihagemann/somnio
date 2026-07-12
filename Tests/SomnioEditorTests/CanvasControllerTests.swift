import CoreGraphics
import Foundation
import simd
import SomnioCore
import SwiftUI
import Testing
@testable import SomnioEditor
@testable import SomnioScene3D

@MainActor
struct CanvasControllerTests {
    private static let viewportSize = CGSize(width: 640, height: 480)

    private func framing(minPixel: SIMD2<Float> = .zero, maxPixel: SIMD2<Float> = SIMD2<Float>(512, 512)) -> EditorFraming {
        OrthographicCameraRig.editorFraming(
            fittingPixelBounds: minPixel, maxPixel,
            viewportSize: SIMD2<Float>(Float(Self.viewportSize.width), Float(Self.viewportSize.height))
        )
    }

    /// Viewport point where a legacy pixel lands under the framing — the tap location a user
    /// aiming at that pixel would produce.
    private func viewportPoint(forPixel pixel: SIMD2<Float>, framing: EditorFraming) -> CGPoint {
        let point = OrthographicCameraRig.viewportPoint(
            forLegacyPoint: pixel,
            viewportSize: SIMD2<Float>(Float(Self.viewportSize.width), Float(Self.viewportSize.height)),
            framing: framing
        )
        return CGPoint(x: CGFloat(point.x), y: CGFloat(point.y))
    }

    @Test func `a tap at a pixel's projected viewport point resolves to that grid cell`() {
        // Mid-pixel targets, as real taps are: the unprojection floors to the containing
        // pixel, matching the retired 2D canvas's downward rounding.
        let framing = framing()
        let tap = viewportPoint(forPixel: SIMD2<Float>(128.5, 96.5), framing: framing)
        let grid = CanvasController.gridPoint(forViewport: tap, viewportSize: Self.viewportSize, framing: framing)
        #expect(grid == GridPoint(x: 128, y: 96))
    }

    @Test func `a tap inside an overflow footprint resolves to negative coordinates`() {
        // A shelf row authored at y = -48 is inside the fit; picking it must yield the
        // authored negative coordinate rather than clamping to the sector rect.
        let framing = framing(minPixel: SIMD2<Float>(0, -48))
        let tap = viewportPoint(forPixel: SIMD2<Float>(32.5, -40.5), framing: framing)
        let grid = CanvasController.gridPoint(forViewport: tap, viewportSize: Self.viewportSize, framing: framing)
        #expect(grid == GridPoint(x: 32, y: -41))
    }

    @Test func `fractional pixels floor downward like the retired pixel canvas`() {
        let framing = framing()
        let tap = viewportPoint(forPixel: SIMD2<Float>(200.9, 300.4), framing: framing)
        let grid = CanvasController.gridPoint(forViewport: tap, viewportSize: Self.viewportSize, framing: framing)
        #expect(grid == GridPoint(x: 200, y: 300))
    }

    @Test func `a tap outside the sector bounds resolves without trapping`() {
        // The hit-catcher covers the whole viewport, so a corner tap unprojects to a floor
        // point outside the fitted sector rect (the floor is a rotated diamond in view space);
        // the dispatch then finds no record there and no-ops rather than crashing.
        let framing = framing()
        let grid = CanvasController.gridPoint(forViewport: .zero, viewportSize: Self.viewportSize, framing: framing)
        let insideSector = (0 ..< 512).contains(Int(grid.x)) && (0 ..< 512).contains(Int(grid.y))
        #expect(!insideSector)
    }

    @Test func `command scroll routes to zoom with raw deltas`() {
        // Zoom deltas stay unscaled — they feed the game's `PlayerZoom`, whose gain is
        // tuned against raw scroll deltas.
        #expect(CanvasController.scrollIntent(
            deltaX: 0, deltaY: 3, hasPreciseDeltas: false, commandHeld: true, shiftHeld: false
        ) == .zoom(deltaY: 3))
        #expect(CanvasController.scrollIntent(
            deltaX: 0, deltaY: 3, hasPreciseDeltas: true, commandHeld: true, shiftHeld: false
        ) == .zoom(deltaY: 3))
    }

    @Test func `plain scroll routes to a two-axis pan`() {
        #expect(CanvasController.scrollIntent(
            deltaX: 4, deltaY: -2, hasPreciseDeltas: true, commandHeld: false, shiftHeld: false
        ) == .pan(delta: CGSize(width: 4, height: -2)))
    }

    @Test func `shift turns a mouse wheel's vertical ticks horizontal`() {
        #expect(CanvasController.scrollIntent(
            deltaX: 0, deltaY: 2, hasPreciseDeltas: false, commandHeld: false, shiftHeld: true
        ) == .pan(delta: CGSize(width: 20, height: 0)))
        // A trackpad already pans both axes; Shift must not clobber a real horizontal delta.
        #expect(CanvasController.scrollIntent(
            deltaX: 3, deltaY: 2, hasPreciseDeltas: true, commandHeld: false, shiftHeld: true
        ) == .pan(delta: CGSize(width: 3, height: 2)))
    }

    @Test func `overlapping picks prefer spawns over rects and the latest record within a kind`() {
        // The documented pick preference: NPCs before monsters before portals/masks/objects
        // (small spawn boxes stay reachable under the larger rects), and within one kind
        // back-to-front so the most-recently-placed record wins.
        let overlap = SectorBody(
            version: 1,
            dimensions: GridSize(width: 4, height: 4),
            floorMaterialID: "grass-meadow",
            light: LightSetting(indoor: false, brightness: 100),
            objects: [Object(x: 0, y: 0, modelID: "door", sourceWidth: 256, sourceHeight: 256, priority: 0)],
            collisionMasks: [
                CollisionMask(x: 0, y: 0, width: 128, height: 128),
                CollisionMask(x: 0, y: 0, width: 128, height: 128)
            ],
            npcs: [NPC(
                spawnOrigin: GridPoint(x: 32, y: 32), spawnBoxSize: GridSize(width: 32, height: 32),
                maskSize: GridSize(width: 32, height: 32), name: "N", figure: 0,
                facing: Heading(cardinal: .south), behaviorTag: 0, dialogScript: ""
            )],
            monsterSpawns: [MonsterSpawn(
                spawnOrigin: GridPoint(x: 32, y: 32), spawnBoxSize: GridSize(width: 32, height: 32),
                spawnedMonsterSize: GridSize(width: 32, height: 32), name: "M", figure: 0,
                bounded: true, spawnHP: 1, spawnBalance: 1, spawnMana: 1, aiScriptIndex: 0
            )]
        )
        // Inside NPC + monster + mask + object: the NPC wins.
        #expect(CanvasController.selectRecord(at: GridPoint(x: 40, y: 40), in: overlap, tool: .select) == .npc(0))
        // Inside both masks + the object: the most-recently-placed mask wins.
        #expect(CanvasController.selectRecord(at: GridPoint(x: 100, y: 100), in: overlap, tool: .select) == .mask(1))
        // Inside only the object.
        #expect(CanvasController.selectRecord(at: GridPoint(x: 200, y: 200), in: overlap, tool: .select) == .object(0))
        // A placement tool restricts picking to its own kind.
        #expect(CanvasController.selectRecord(at: GridPoint(x: 40, y: 40), in: overlap, tool: .monster) == .monsterSpawn(0))
    }

    @Test func `the unprojected pixel quantizes with the unchanged grid snap`() {
        // The pre-pivot path was floor-then-quantize; the unprojection replaces only the
        // floor half, so quantize(128 px tap, 32 px step) still snaps to 128.
        let framing = framing()
        let tap = viewportPoint(forPixel: SIMD2<Float>(140.5, 70.5), framing: framing)
        let grid = CanvasController.gridPoint(forViewport: tap, viewportSize: Self.viewportSize, framing: framing)
        #expect(EditorDefaults.quantize(grid.x, step: 32) == 128)
        #expect(EditorDefaults.quantize(grid.y, step: 32) == 64)
    }

    // MARK: - Keyboard nudge

    @Test func `arrow keys map to 1px legacy-axis deltas`() throws {
        let up = try #require(CanvasController.nudgeDelta(key: .upArrow, shiftHeld: false, gridStep: 8))
        #expect(up == (dx: 0, dy: -1))
        let down = try #require(CanvasController.nudgeDelta(key: .downArrow, shiftHeld: false, gridStep: 8))
        #expect(down == (dx: 0, dy: 1))
        let left = try #require(CanvasController.nudgeDelta(key: .leftArrow, shiftHeld: false, gridStep: 8))
        #expect(left == (dx: -1, dy: 0))
        let right = try #require(CanvasController.nudgeDelta(key: .rightArrow, shiftHeld: false, gridStep: 8))
        #expect(right == (dx: 1, dy: 0))
    }

    @Test func `shift scales the nudge to the grid step with a 1px floor`() throws {
        let shifted = try #require(CanvasController.nudgeDelta(key: .rightArrow, shiftHeld: true, gridStep: 16))
        #expect(shifted == (dx: 16, dy: 0))
        let floored = try #require(CanvasController.nudgeDelta(key: .downArrow, shiftHeld: true, gridStep: 0))
        #expect(floored == (dx: 0, dy: 1))
    }

    @Test func `a non-arrow key resolves to no nudge`() {
        #expect(CanvasController.nudgeDelta(key: .space, shiftHeld: false, gridStep: 8) == nil)
    }

    // MARK: - Delete

    private func documentAndWorkspace(masks: [CollisionMask]) -> (document: SectorDocument, workspace: SectorWorkspace) {
        let document = SectorDocument()
        document.mutate("Create new map", undoManager: nil) { body in
            body = SectorBody(
                version: 1,
                dimensions: GridSize(width: 4, height: 4),
                floorMaterialID: "grass-meadow",
                light: LightSetting(indoor: false, brightness: 100),
                collisionMasks: masks
            )
        }
        return (document, SectorWorkspaceRegistry.workspace(forID: document.id))
    }

    @Test func `delete removes the selection in one undo step`() {
        let (document, workspace) = documentAndWorkspace(masks: [CollisionMask(x: 0, y: 0, width: 8, height: 8)])
        defer { SectorWorkspaceRegistry.discard(documentID: document.id) }
        workspace.selection = [.mask(0)]
        let undoManager = UndoManager()
        CanvasController.deleteSelection(document: document, workspace: workspace, undoManager: undoManager)
        #expect(document.body.collisionMasks.isEmpty)
        #expect(workspace.selection.isEmpty)
        #expect(undoManager.canUndo)
    }

    @Test func `delete no-ops while a modal overlay is presented`() {
        // `FantasyModalHost` swallows pointer input only; the canvas command handlers stay
        // wired underneath, so the gate must live in the shared delete path.
        let (document, workspace) = documentAndWorkspace(masks: [CollisionMask(x: 0, y: 0, width: 8, height: 8)])
        defer { SectorWorkspaceRegistry.discard(documentID: document.id) }
        workspace.selection = [.mask(0)]
        workspace.presentedOverlay = .gameMenu
        let undoManager = UndoManager()
        CanvasController.deleteSelection(document: document, workspace: workspace, undoManager: undoManager)
        #expect(document.body.collisionMasks.count == 1)
        #expect(workspace.selection == [.mask(0)])
        #expect(!undoManager.canUndo)
    }
}
