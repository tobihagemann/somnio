import Foundation

/// `facing` keeps the on-disk JSON key `"direction"` (via `CodingKeys`) so the sector format
/// stays stable across the heading migration; it serializes as a bare degree number
/// (`"direction" : 270`) through `Heading`'s single-value `Codable`, which normalizes
/// out-of-range persisted values on decode.
public struct NPC: Sendable, Equatable, Hashable, Codable {
    public var spawnOrigin: GridPoint
    public var spawnBoxSize: GridSize
    public var maskSize: GridSize
    public var name: String
    public var figure: Int16
    public var facing: Heading
    public var behaviorTag: Int16
    public var dialogScript: String

    private enum CodingKeys: String, CodingKey {
        case spawnOrigin, spawnBoxSize, maskSize, name, figure, behaviorTag, dialogScript
        case facing = "direction"
    }

    public init(
        spawnOrigin: GridPoint,
        spawnBoxSize: GridSize,
        maskSize: GridSize,
        name: String,
        figure: Int16,
        facing: Heading,
        behaviorTag: Int16,
        dialogScript: String
    ) {
        self.spawnOrigin = spawnOrigin
        self.spawnBoxSize = spawnBoxSize
        self.maskSize = maskSize
        self.name = name
        self.figure = figure
        self.facing = facing
        self.behaviorTag = behaviorTag
        self.dialogScript = dialogScript
    }

    /// Splits `dialogScript` on the literal `---` separator. A single leading `\n` and a single
    /// trailing `\n` are trimmed from each step; other whitespace is preserved verbatim. The
    /// `$name` token is left intact — substitution happens at emit time on the AI tick. Empty
    /// `dialogScript` yields `[]`.
    ///
    /// Callers that read this on a hot path should cache the result; the per-tick AI loop
    /// reads from a cached array on `NPCRuntime` so this `String.components(separatedBy:)`
    /// allocation does not run on every tick.
    public var dialogSteps: [String] {
        guard !dialogScript.isEmpty else { return [] }
        return dialogScript.components(separatedBy: "---").map { step in
            var trimmed = step
            if trimmed.first == "\n" { trimmed.removeFirst() }
            if trimmed.last == "\n" { trimmed.removeLast() }
            return trimmed
        }
    }
}
