import Foundation
import SomnioCore

/// Editor-only constants consumed by the canvas placement logic, the per-tool dialogs,
/// and the Preferences pane. The Object dialog seeds new sectors with `defaultGround`;
/// the New-map flow stamps `defaultSectorVersion` (the version emitted by the shipped
/// record-type fixtures).
public enum EditorDefaults {
    public static let gridSnapPresetsPx: [Int16] = [32, 16, 8, 4]
    public static let defaultGridSnapPx: Int16 = 32
    public static let userDefaultsKey = "editorGridSnap"
    public static let defaultSectorVersion: Int16 = 1
    public static let defaultGround = GroundTile(tilesetIndex: 0, sourceX: 0, sourceY: 0)

    /// Snaps `value` to the nearest multiple of `step` toward zero. `step == 0` means
    /// "free placement" (no quantization). Negative inputs round toward zero in the same
    /// direction Swift integer division does.
    public static func quantize(_ value: Int16, step: Int16) -> Int16 {
        step == 0 ? value : (value / step) * step
    }

    /// Reads the active grid-snap preset from UserDefaults under `userDefaultsKey`,
    /// falling back to `.px32` when the key is unset or the stored value isn't a known
    /// preset. Single source of truth for the canvas, the overlay layer, and the
    /// Preferences picker.
    ///
    /// `object(forKey:)` is checked first because `integer(forKey:)` returns `0` for
    /// an absent key and `0` collides with `GridSnap.free` — without the absent-check
    /// a fresh install would default to no-snap instead of the documented `.px32`.
    public static func currentGridSnap() -> GridSnap {
        let defaults = UserDefaults(suiteName: BuildEnvironment.userDefaultsSuiteName) ?? .standard
        guard defaults.object(forKey: userDefaultsKey) != nil else {
            return GridSnap(rawValue: defaultGridSnapPx) ?? .px32
        }
        let stored = Int16(exactly: defaults.integer(forKey: userDefaultsKey)) ?? defaultGridSnapPx
        return GridSnap(rawValue: stored) ?? .px32
    }

    public static func currentGridStepPx() -> Int16 {
        currentGridSnap().rawValue
    }
}

/// Editor-only snap step. The four pixel-quantization presets are sub-tile (the engine
/// tile is `SomnioConstants.tileSize` = 128), so quantization happens in pixel space.
/// `.free` is the no-snap sentinel and quantizes to itself via `quantize(_:step:)`.
public enum GridSnap: Int16, CaseIterable, Sendable {
    case px32 = 32
    case px16 = 16
    case px8 = 8
    case px4 = 4
    case free = 0
}

public extension GridSize {
    /// Sentinel "uninitialized dimensions" pair the editor compares against to detect a
    /// fresh `SectorDocument` that should auto-present its New-map sheet.
    static let zero = GridSize(width: 0, height: 0)
}
