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

/// Hand-written `Codable` so `direction` serializes as a semantic `Direction` case name
/// (`"south"`) rather than the legacy `richtung` int the field stores in memory. The case-name
/// mapping lives on `Direction` (`caseName`/`init?(caseName:)`); `Direction` is deliberately *not*
/// globally `Codable`-as-string because the wire DTOs, DB
/// columns, and sprite-row math read its `Int16` rawValue. Authored NPC directions are always in
/// 0-3 (editor-constrained), so a non-decodable case name or an out-of-range stored int is a
/// corruption signal and throws.
extension NPC: Codable {
    private enum CodingKeys: String, CodingKey {
        case spawnOrigin, spawnBoxSize, maskSize, name, figure, direction, behaviorTag, dialogScript
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let caseName = try container.decode(String.self, forKey: .direction)
        guard let semantic = Direction(caseName: caseName) else {
            throw DecodingError.dataCorruptedError(
                forKey: .direction,
                in: container,
                debugDescription: "NPC.direction \(caseName) is not a valid Direction case name"
            )
        }
        try self.init(
            spawnOrigin: container.decode(GridPoint.self, forKey: .spawnOrigin),
            spawnBoxSize: container.decode(GridSize.self, forKey: .spawnBoxSize),
            maskSize: container.decode(GridSize.self, forKey: .maskSize),
            name: container.decode(String.self, forKey: .name),
            figure: container.decode(Int16.self, forKey: .figure),
            direction: semantic.legacyRichtung,
            behaviorTag: container.decode(Int16.self, forKey: .behaviorTag),
            dialogScript: container.decode(String.self, forKey: .dialogScript)
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(spawnOrigin, forKey: .spawnOrigin)
        try container.encode(spawnBoxSize, forKey: .spawnBoxSize)
        try container.encode(maskSize, forKey: .maskSize)
        try container.encode(name, forKey: .name)
        try container.encode(figure, forKey: .figure)
        guard let semantic = Direction(legacyRichtung: direction) else {
            throw EncodingError.invalidValue(direction, EncodingError.Context(
                codingPath: container.codingPath + [CodingKeys.direction],
                debugDescription: "NPC.direction \(direction) is not a valid legacy richtung (0-3)"
            ))
        }
        try container.encode(semantic.caseName, forKey: .direction)
        try container.encode(behaviorTag, forKey: .behaviorTag)
        try container.encode(dialogScript, forKey: .dialogScript)
    }
}
