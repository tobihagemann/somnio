import Foundation

public struct NPC: Sendable, Equatable, Hashable {
    public var spawnOrigin: GridPoint
    public var spawnBoxSize: GridSize
    public var maskSize: GridSize
    public var name: String
    public var figure: Int16
    public var direction: Int16
    public var behaviorTag: Int16
    public var dialogScript: String

    public init(
        spawnOrigin: GridPoint,
        spawnBoxSize: GridSize,
        maskSize: GridSize,
        name: String,
        figure: Int16,
        direction: Int16,
        behaviorTag: Int16,
        dialogScript: String
    ) {
        self.spawnOrigin = spawnOrigin
        self.spawnBoxSize = spawnBoxSize
        self.maskSize = maskSize
        self.name = name
        self.figure = figure
        self.direction = direction
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
