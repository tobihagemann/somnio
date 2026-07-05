import Foundation

/// One legacy character-sheet band. Mirrors the original `BilderLaden` partition: the player
/// shares a single multi-region sheet, NPCs and monsters each draw from their own filename band.
public enum CharacterBand: Sendable, Equatable, Hashable, CaseIterable {
    case player
    case npc
    case monster
}

/// An inclusive `[lower, upper]` range of filename leading numbers assigned to a band. A named
/// struct rather than `ClosedRange<Int>` so it serializes to self-documenting `lower`/`upper` JSON
/// keys (the project's "no raw arrays/ranges on the wire" convention).
public struct BandRange: Sendable, Equatable, Hashable, Codable {
    public var lower: Int
    public var upper: Int

    public init(lower: Int, upper: Int) {
        self.lower = lower
        self.upper = upper
    }

    public func contains(_ value: Int) -> Bool {
        value >= lower && value <= upper
    }
}

/// Multi-region sheet layout: the player sheet is a `columns × rows` grid of character regions,
/// each region a frame × direction grid of `BandRule.cell` cells.
public struct SheetGrid: Sendable, Equatable, Hashable, Codable {
    public var columns: Int
    public var rows: Int

    public init(columns: Int, rows: Int) {
        self.columns = columns
        self.rows = rows
    }
}

/// The convention for one character band. `leadingNumberRanges` claim the band's filenames.
/// `sheetGrid` + `cell` are both present for the multi-region player band and both absent for the
/// single-region npc/monster bands (which derive their cell from the sheet's pixel dimensions at
/// runtime); the codec validator enforces that "both or neither" invariant.
public struct BandRule: Sendable, Equatable, Hashable, Codable {
    public var leadingNumberRanges: [BandRange]
    public var sheetGrid: SheetGrid?
    public var cell: GridSize?

    public init(leadingNumberRanges: [BandRange], sheetGrid: SheetGrid? = nil, cell: GridSize? = nil) {
        self.leadingNumberRanges = leadingNumberRanges
        self.sheetGrid = sheetGrid
        self.cell = cell
    }

    public func containsLeadingNumber(_ number: Int) -> Bool {
        leadingNumberRanges.contains { $0.contains(number) }
    }
}

public struct CharacterBands: Sendable, Equatable, Hashable, Codable {
    public var player: BandRule
    public var npc: BandRule
    public var monster: BandRule

    public init(player: BandRule, npc: BandRule, monster: BandRule) {
        self.player = player
        self.npc = npc
        self.monster = monster
    }

    public subscript(_ band: CharacterBand) -> BandRule {
        switch band {
        case .player: return player
        case .npc: return npc
        case .monster: return monster
        }
    }
}

/// The tileset filename convention: a `String(format:)` pattern applied to the tileset index after
/// adding `indexOffset` (the legacy 0-based-index-vs-1-based-filename off-by-one).
public struct TilesetRule: Sendable, Equatable, Hashable, Codable {
    public var filenameFormat: String
    public var indexOffset: Int

    public init(filenameFormat: String, indexOffset: Int) {
        self.filenameFormat = filenameFormat
        self.indexOffset = indexOffset
    }
}

/// Data-driven description of the 2003 art pack's layout conventions, decoupling
/// `BundleMainSpriteAssets` from hardcoded magic numbers. The manifest references no filenames, so
/// it never drifts from the uncommitted, operator-supplied art pack. `directionRows` lists the
/// sprite-sheet row order (the legacy S/W/E/N), `entityFrameCount` the walk-frame columns,
/// `tilesets` the filename off-by-one, and `characterBands` the figure-banding + cell geometry.
public struct AssetManifest: Sendable, Equatable {
    public var directionRows: [Direction]
    public var entityFrameCount: Int
    public var tilesets: TilesetRule
    public var characterBands: CharacterBands

    public init(
        directionRows: [Direction],
        entityFrameCount: Int,
        tilesets: TilesetRule,
        characterBands: CharacterBands
    ) {
        self.directionRows = directionRows
        self.entityFrameCount = entityFrameCount
        self.tilesets = tilesets
        self.characterBands = characterBands
    }

    /// The filename prefix for a tileset index, applying the legacy 1-based offset (index 5 →
    /// `"006-"`). Widens to `Int` before the add so an out-of-range `Int16.max` index can't trap.
    public func tilesetFilenamePrefix(forIndex index: Int) -> String {
        String(format: tilesets.filenameFormat, index + tilesets.indexOffset)
    }

    /// The band a filename's leading number belongs to, or `nil` when no band claims it.
    public func band(forLeadingNumber number: Int) -> CharacterBand? {
        CharacterBand.allCases.first { characterBands[$0].containsLeadingNumber(number) }
    }

    /// The sheet row index for a facing, following `directionRows` order (`.south` → row 0 in the
    /// legacy S/W/E/N layout). `nil` when the facing is absent from the manifest's row list.
    public func rowIndex(for facing: Direction) -> Int? {
        directionRows.firstIndex(of: facing)
    }

    /// The 2003 art-pack conventions, hardcoded as a last-resort fallback for when the committed
    /// `AssetManifest.json` resource is (theoretically) missing or corrupt — so the loader degrades
    /// like an absent art pack with a logged error rather than trapping. Kept in sync with
    /// `Resources/AssetManifest.json`.
    public static let legacyFallback = AssetManifest(
        directionRows: [.south, .west, .east, .north],
        entityFrameCount: 4,
        tilesets: TilesetRule(filenameFormat: "%03d-", indexOffset: 1),
        characterBands: CharacterBands(
            player: BandRule(
                leadingNumberRanges: [BandRange(lower: 1, upper: 1)],
                sheetGrid: SheetGrid(columns: 8, rows: 2),
                cell: GridSize(width: 32, height: 48)
            ),
            npc: BandRule(leadingNumberRanges: [BandRange(lower: 2, upper: 10), BandRange(lower: 61, upper: 109)]),
            monster: BandRule(leadingNumberRanges: [BandRange(lower: 11, upper: 60)])
        )
    )
}

/// Hand-written `Codable` so `directionRows` serializes as semantic `Direction` case names
/// (`["south","west","east","north"]`) via the shared `Direction.caseName` seam — `Direction`'s
/// `Int16` rawValue is deliberately not its on-disk form here, so the manifest stays
/// self-documenting. All other fields decode through their synthesized `Codable`.
extension AssetManifest: Codable {
    private enum CodingKeys: String, CodingKey {
        case directionRows, entityFrameCount, tilesets, characterBands
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let rowNames = try container.decode([String].self, forKey: .directionRows)
        let rows = try rowNames.map { name -> Direction in
            guard let direction = Direction(caseName: name) else {
                throw DecodingError.dataCorruptedError(
                    forKey: .directionRows,
                    in: container,
                    debugDescription: "\(name) is not a valid Direction case name"
                )
            }
            return direction
        }
        try self.init(
            directionRows: rows,
            entityFrameCount: container.decode(Int.self, forKey: .entityFrameCount),
            tilesets: container.decode(TilesetRule.self, forKey: .tilesets),
            characterBands: container.decode(CharacterBands.self, forKey: .characterBands)
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(directionRows.map(\.caseName), forKey: .directionRows)
        try container.encode(entityFrameCount, forKey: .entityFrameCount)
        try container.encode(tilesets, forKey: .tilesets)
        try container.encode(characterBands, forKey: .characterBands)
    }
}
