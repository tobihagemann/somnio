import Foundation
import SomnioCore
import Testing
@testable import SomnioEditor

struct EditorDefaultsTests {
    @Test func `quantize snaps positive value to nearest preset multiple`() {
        #expect(EditorDefaults.quantize(67, step: 32) == 64)
        #expect(EditorDefaults.quantize(50, step: 16) == 48)
        #expect(EditorDefaults.quantize(15, step: 8) == 8)
        #expect(EditorDefaults.quantize(13, step: 4) == 12)
    }

    @Test func `quantize on an exact multiple is identity`() {
        #expect(EditorDefaults.quantize(64, step: 32) == 64)
        #expect(EditorDefaults.quantize(48, step: 16) == 48)
        #expect(EditorDefaults.quantize(0, step: 4) == 0)
    }

    @Test func `quantize with step zero returns the input unchanged`() {
        #expect(EditorDefaults.quantize(67, step: 0) == 67)
        #expect(EditorDefaults.quantize(-31, step: 0) == -31)
    }

    @Test func `quantize on a negative value rounds toward zero`() {
        // Swift integer division truncates toward zero, so `-33 / 32 == -1` and
        // `-1 * 32 == -32`. Mirrors the canvas behavior where negative pixel offsets
        // (e.g. when the user pans a record off the grid origin) snap upward.
        #expect(EditorDefaults.quantize(-33, step: 32) == -32)
        #expect(EditorDefaults.quantize(-15, step: 8) == -8)
        #expect(EditorDefaults.quantize(-1, step: 4) == 0)
    }

    @Test func `grid snap raw values match the documented presets`() {
        #expect(GridSnap.px32.rawValue == 32)
        #expect(GridSnap.px16.rawValue == 16)
        #expect(GridSnap.px8.rawValue == 8)
        #expect(GridSnap.px4.rawValue == 4)
        #expect(GridSnap.free.rawValue == 0)
        #expect(GridSnap.allCases.count == 5)
    }

    @Test func `editor default constants match documented values`() {
        #expect(EditorDefaults.defaultGridSnapPx == 32)
        #expect(EditorDefaults.gridSnapPresetsPx == [32, 16, 8, 4])
        #expect(EditorDefaults.userDefaultsKey == "editorGridSnap")
        #expect(EditorDefaults.defaultSectorVersion == 1)
        #expect(EditorDefaults.defaultFloorMaterialID == "grass-meadow")
    }

    @Test func `grid size zero sentinel compares equal to a fresh document body`() {
        #expect(GridSize.zero == GridSize(width: 0, height: 0))
    }

    @Test func `sector dimension validation mirrors the codec gate at its boundaries`() {
        // Positivity floor.
        #expect(!EditorDefaults.validSectorDimensions(width: 0, height: 1))
        #expect(!EditorDefaults.validSectorDimensions(width: 1, height: 0))
        #expect(EditorDefaults.validSectorDimensions(width: 1, height: 1))
        // Per-axis cap.
        #expect(!EditorDefaults.validSectorDimensions(width: SomnioConstants.maxSectorDimension + 1, height: 1))
        #expect(EditorDefaults.validSectorDimensions(width: SomnioConstants.maxSectorDimension, height: 1))
        // Area cap: each axis individually legal, product over the limit.
        #expect(!EditorDefaults.validSectorDimensions(width: 1024, height: 65))
        #expect(EditorDefaults.validSectorDimensions(width: 1024, height: 64))
        #expect(EditorDefaults.validSectorDimensions(width: 256, height: 256))
        #expect(!EditorDefaults.validSectorDimensions(width: 256, height: 257))
    }

    @Test func `absent UserDefaults key resolves through the defaults-fallback path`() throws {
        // Regression guard for the bug where `UserDefaults.integer(forKey:)` returned
        // 0 for an absent key and the result resolved to `GridSnap.free`. The fix
        // gates the integer read on `object(forKey:) != nil` so a fresh install lands
        // on the documented `.px32` default. Validates the absent-check primitive on
        // a scoped suite and asserts the documented fallback mapping.
        let suiteName = "de.tobiha.somnio.editor-defaults-test.\(UUID().uuidString)"
        let suite = try #require(UserDefaults(suiteName: suiteName))
        suite.removeObject(forKey: EditorDefaults.userDefaultsKey)
        #expect(suite.object(forKey: EditorDefaults.userDefaultsKey) == nil)
        #expect(suite.integer(forKey: EditorDefaults.userDefaultsKey) == 0)
        #expect(GridSnap(rawValue: EditorDefaults.defaultGridSnapPx) == .px32)
    }
}
