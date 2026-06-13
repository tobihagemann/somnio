import CoreGraphics
import Foundation
import ImageIO
import Logging
import SomnioCore
import SpriteKit

/// Texture-pack accessor for the SpriteKit scene. Implementations resolve the legacy
/// asset-pack naming conventions described in the reference docs. The protocol is
/// `@MainActor`-isolated because `SKTexture` is a non-Sendable SpriteKit reference type
/// bound to the main actor; the scene that calls these methods is itself main-actor
/// isolated, so the protocol-level isolation matches its call sites.
///
/// `groundTexture` takes only three params because it returns one uniform 32 × 32
/// source-pack cell, which the caller's `SKTileMapNode` repeats across the sector.
/// `objectTexture` takes an explicit five-param source rect because the `Object` record
/// carries its own width and height which can be any size.
@MainActor public protocol SpriteAssets {
    func groundTexture(tilesetIndex: Int16, sourceX: Int16, sourceY: Int16) -> SKTexture?
    func objectTexture(
        tilesetIndex: Int16,
        sourceX: Int16,
        sourceY: Int16,
        sourceWidth: Int16,
        sourceHeight: Int16
    ) -> SKTexture?
    func entityTexture(
        figureIndex: Int16,
        kind: WorldEntity.Kind,
        facing: Direction,
        frame: Int
    ) -> SKTexture?
    func animationStrip(name: String) -> SKTexture?
    func splash() -> SKTexture?
    func speechBubble() -> SKTexture?
}

/// Loads textures from a runtime `Bundle` whose `Resources/` directory follows the
/// subdirectory layout produced by `Scripts/bundle-assets.sh` (`Tilesets/`,
/// `Animations/`, `System/`, `Characters/`, `Buttons/`). Tilesets are keyed by a
/// zero-padded three-digit numeric prefix in their filename.
@MainActor public final class BundleMainSpriteAssets: SpriteAssets {
    private static let logger = Logger(label: "de.tobiha.somnio.ui.assets")
    private static let sourceCellSize = Int(SomnioConstants.groundCellSize)

    // Main player sheet (`001-Main01.png`, 1024 × 384): an 8 × 2 grid of character regions;
    // each region is a 4-frame × 4-direction grid of 32 × 48 cells. NPC/monster sheets hold
    // a single character region whose cell size is the sheet divided by frames/directions.
    private static let playerSheetColumns = 8
    private static let playerSheetRows = 2
    private static let entityWalkFrames = 4
    private static let entityDirections = 4
    private static let playerCellWidth = 32
    private static let playerCellHeight = 48

    private struct GroundKey: Hashable {
        // periphery:ignore
        let tilesetIndex: Int16
        // periphery:ignore
        let sourceX: Int16
        // periphery:ignore
        let sourceY: Int16
    }

    private struct EntityTextureKey: Hashable {
        // periphery:ignore
        let figureIndex: Int16
        // periphery:ignore
        let kind: WorldEntity.Kind
        // periphery:ignore
        let facing: Direction
        // periphery:ignore
        let frame: Int
    }

    /// The three legacy character-sheet bands (`BilderLaden`): the player shares one sheet
    /// (the `001-` file), NPCs index `npcBand`, monsters index `monsterBand`. `.peer` resolves
    /// to the player band like `.player`.
    private enum SheetBand: Hashable {
        case player
        case npc
        case monster
    }

    /// Composite key for the per-band sheet caches. NPC figure 0, monster figure 0, and the
    /// player resolve to different files, so they would collide on a bare `Int16` index —
    /// the band disambiguates them.
    private struct CharacterSheetKey: Hashable {
        // periphery:ignore
        let band: SheetBand
        // periphery:ignore
        let index: Int16
    }

    private let bundle: Bundle
    private var tilesetImageCache: [Int16: CGImage] = [:]
    private var groundTextureCache: [GroundKey: SKTexture] = [:]
    private var characterImageCache: [CharacterSheetKey: CGImage] = [:]
    private var characterImageMisses: Set<CharacterSheetKey> = []
    private var characterSheetTextureCache: [CharacterSheetKey: SKTexture] = [:]
    /// Sorted file lists per band, built lazily on first character lookup. `nil` until built.
    private var characterBands: [SheetBand: [URL]]?
    private var entityTextureCache: [EntityTextureKey: SKTexture] = [:]

    public init(bundle: Bundle = .main) {
        self.bundle = bundle
    }

    public func groundTexture(tilesetIndex: Int16, sourceX: Int16, sourceY: Int16) -> SKTexture? {
        guard sourceX >= 0, sourceY >= 0 else { return nil }
        let key = GroundKey(tilesetIndex: tilesetIndex, sourceX: sourceX, sourceY: sourceY)
        if let cached = groundTextureCache[key] { return cached }
        guard let tileset = tilesetImage(for: tilesetIndex) else { return nil }
        let sourceRect = CGRect(x: Int(sourceX), y: Int(sourceY), width: Self.sourceCellSize, height: Self.sourceCellSize)
        // Crop the source cell as a standalone `CGImage` rather than a UV sub-rect of the whole
        // tileset: a cropped image clamps at its own edges, so the tile map's default `.linear`
        // sampling can't bleed neighboring tileset cells at the tile seams.
        guard sourceRect.maxX <= CGFloat(tileset.width),
              sourceRect.maxY <= CGFloat(tileset.height),
              let cell = tileset.cropping(to: sourceRect)
        else { return nil }
        let texture = SKTexture(cgImage: cell)
        groundTextureCache[key] = texture
        return texture
    }

    public func objectTexture(
        tilesetIndex: Int16,
        sourceX: Int16,
        sourceY: Int16,
        sourceWidth: Int16,
        sourceHeight: Int16
    ) -> SKTexture? {
        guard sourceX >= 0, sourceY >= 0, sourceWidth > 0, sourceHeight > 0 else { return nil }
        guard let tileset = tilesetImage(for: tilesetIndex) else { return nil }
        let pixelRect = CGRect(x: Int(sourceX), y: Int(sourceY), width: Int(sourceWidth), height: Int(sourceHeight))
        guard let uv = uvRect(
            forTopLeftPixelRect: pixelRect,
            imageWidth: CGFloat(tileset.width),
            imageHeight: CGFloat(tileset.height)
        ) else { return nil }
        return SKTexture(rect: uv, in: SKTexture(cgImage: tileset))
    }

    public func entityTexture(
        figureIndex: Int16,
        kind: WorldEntity.Kind,
        facing: Direction,
        frame: Int
    ) -> SKTexture? {
        guard frame >= 0, frame < Self.entityWalkFrames,
              facing.rawValue >= 0, facing.rawValue < Int16(Self.entityDirections)
        else { return nil }
        let key = EntityTextureKey(figureIndex: figureIndex, kind: kind, facing: facing, frame: frame)
        if let cached = entityTextureCache[key] { return cached }

        let sheet: CGImage
        let sheetKey: CharacterSheetKey
        let pixelRect: CGRect
        switch kind {
        case .player, .peer:
            // All players share the player band's single sheet (`001-Main01.png`); the wire
            // figure selects the character region within it, not the sheet file.
            guard figureIndex >= 0, figureIndex < Int16(Self.playerSheetColumns * Self.playerSheetRows),
                  let playerSheet = characterSheetImage(band: .player, index: 0) else { return nil }
            let charColumn = Int(figureIndex) % Self.playerSheetColumns
            let charRow = Int(figureIndex) / Self.playerSheetColumns
            let regionWidth = Self.entityWalkFrames * Self.playerCellWidth
            let regionHeight = Self.entityDirections * Self.playerCellHeight
            sheet = playerSheet
            sheetKey = CharacterSheetKey(band: .player, index: 0)
            // The sheet rows are laid out in the original `richtung` order (S/W/E/N), so a
            // semantic `Direction` selects its row via `legacyRichtung`, not `rawValue`.
            pixelRect = CGRect(
                x: charColumn * regionWidth + frame * Self.playerCellWidth,
                y: charRow * regionHeight + Int(facing.legacyRichtung) * Self.playerCellHeight,
                width: Self.playerCellWidth,
                height: Self.playerCellHeight
            )
        case .npc, .monster:
            // NPCs and monsters draw from separate filename bands, so figure 0 resolves to a
            // different sheet per kind (`068-Civilian08` for NPC figure 16, `011-Undead01` for
            // monster figure 0).
            let band: SheetBand = kind == .npc ? .npc : .monster
            guard let npcSheet = characterSheetImage(band: band, index: figureIndex) else { return nil }
            let cellWidth = npcSheet.width / Self.entityWalkFrames
            let cellHeight = npcSheet.height / Self.entityDirections
            guard cellWidth > 0, cellHeight > 0 else { return nil }
            sheet = npcSheet
            sheetKey = CharacterSheetKey(band: band, index: figureIndex)
            // Same S/W/E/N row order as the player sheet — select the row by `legacyRichtung`.
            pixelRect = CGRect(
                x: frame * cellWidth,
                y: Int(facing.legacyRichtung) * cellHeight,
                width: cellWidth,
                height: cellHeight
            )
        }
        guard let texture = entitySlice(in: sheet, sheetKey: sheetKey, pixelRect: pixelRect) else { return nil }
        entityTextureCache[key] = texture
        return texture
    }

    /// Slices a top-left pixel rect out of a whole-sheet `CGImage`, returning a UV-rect
    /// `SKTexture` against a cached whole-sheet texture. The top-left-pixel-to-bottom-left-UV
    /// flip `SKTexture(rect:in:)` needs is delegated to `uvRect`.
    private func entitySlice(in sheetImage: CGImage, sheetKey: CharacterSheetKey, pixelRect: CGRect) -> SKTexture? {
        guard let uv = uvRect(
            forTopLeftPixelRect: pixelRect,
            imageWidth: CGFloat(sheetImage.width),
            imageHeight: CGFloat(sheetImage.height)
        ) else { return nil }
        let whole: SKTexture
        if let cached = characterSheetTextureCache[sheetKey] {
            whole = cached
        } else {
            whole = SKTexture(cgImage: sheetImage)
            characterSheetTextureCache[sheetKey] = whole
        }
        return SKTexture(rect: uv, in: whole)
    }

    public func animationStrip(name: String) -> SKTexture? {
        texture(named: name, in: "Animations")
    }

    public func splash() -> SKTexture? {
        texture(named: "001-SplashScreen01", in: "System")
    }

    public func speechBubble() -> SKTexture? {
        texture(named: "002-Balloon01", in: "System")
    }

    /// Whole-PNG texture from a named resource in a bundle subdirectory, nil-fallback when the
    /// asset pack is absent.
    private func texture(named name: String, in subdirectory: String) -> SKTexture? {
        guard let url = bundle.url(forResource: name, withExtension: "png", subdirectory: subdirectory),
              let image = Self.cgImage(at: url) else {
            return nil
        }
        return SKTexture(cgImage: image)
    }

    private func tilesetImage(for tilesetIndex: Int16) -> CGImage? {
        if let cached = tilesetImageCache[tilesetIndex] { return cached }
        guard let urls = bundle.urls(forResourcesWithExtension: "png", subdirectory: "Tilesets") else {
            return nil
        }
        // Binary stores 0-based indices; filenames are 1-based (`001-`...`051-`). Widen to
        // `Int` before `+ 1` so an out-of-range `Int16.max` index can't trap the add.
        let prefix = String(format: "%03d-", Int(tilesetIndex) + 1)
        let matches = urls
            .filter { $0.lastPathComponent.hasPrefix(prefix) }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        guard let pick = matches.first else { return nil }
        if matches.count > 1 {
            Self.logger.warning(
                "duplicate tileset prefix; picking lexicographically-first match",
                metadata: [
                    "tileset_index": "\(tilesetIndex)",
                    "picked": "\(pick.lastPathComponent)",
                    "candidates": "\(matches.map(\.lastPathComponent))"
                ]
            )
        }
        guard let image = Self.cgImage(at: pick) else { return nil }
        tilesetImageCache[tilesetIndex] = image
        return image
    }

    /// Resolves the sheet `CGImage` for a band + figure index. The figure index is positional
    /// within the band's sorted file list (mirroring the original `BilderLaden` banding), not a
    /// global filename number — so NPC figure 16 → `068-Civilian08.png` and monster figure 0 →
    /// `011-Undead01.png`, while the player band's single `001-Main01.png` carries every player
    /// region. Keyed by `(band, index)` so the three bands don't collide.
    private func characterSheetImage(band: SheetBand, index: Int16) -> CGImage? {
        let key = CharacterSheetKey(band: band, index: index)
        if let cached = characterImageCache[key] { return cached }
        // Negative cache: `entityTexture` is hit per walk-frame, so without this a missing
        // sheet (no-asset-pack fallback) re-scans the bundle every frame.
        if characterImageMisses.contains(key) { return nil }
        let urls = sheetURLs(for: band)
        guard index >= 0, Int(index) < urls.count else {
            characterImageMisses.insert(key)
            return nil
        }
        guard let image = Self.cgImage(at: urls[Int(index)]) else {
            characterImageMisses.insert(key)
            return nil
        }
        characterImageCache[key] = image
        return image
    }

    /// Returns the band's sorted file list, building all three bands on first access. The full
    /// `Characters/` enumeration runs once; subsequent lookups read the cached partition.
    private func sheetURLs(for band: SheetBand) -> [URL] {
        if let bands = characterBands { return bands[band] ?? [] }
        let built = Self.buildCharacterBands(bundle: bundle)
        characterBands = built
        return built[band] ?? []
    }

    /// Partitions `Characters/*.png` into the three legacy bands by each filename's leading
    /// number (the field before the first `-`): player = 1, NPC = 2...10 ∪ 61...109,
    /// monster = 11...60 (`BilderLaden`, `Somnio.txt` decoded lines 505-525). Each band is
    /// sorted by filename so the figure index maps positionally. Returns empty bands when the
    /// asset pack is absent (server/CI have no `Characters/`).
    private static func buildCharacterBands(bundle: Bundle) -> [SheetBand: [URL]] {
        guard let urls = bundle.urls(forResourcesWithExtension: "png", subdirectory: "Characters") else {
            return [.player: [], .npc: [], .monster: []]
        }
        var player: [URL] = []
        var npc: [URL] = []
        var monster: [URL] = []
        for url in urls {
            guard let number = leadingNumber(url.lastPathComponent) else { continue }
            switch number {
            case 1: player.append(url)
            case 2 ... 10, 61 ... 109: npc.append(url)
            case 11 ... 60: monster.append(url)
            default: break
            }
        }
        func sortedByName(_ list: [URL]) -> [URL] {
            list.sorted { $0.lastPathComponent < $1.lastPathComponent }
        }
        return [.player: sortedByName(player), .npc: sortedByName(npc), .monster: sortedByName(monster)]
    }

    /// Leading run of digits in a filename (`068-Civilian08.png` → 68). Returns `nil` when the
    /// name does not start with a digit, so a stray non-numeric file is skipped (matching the
    /// original `Val(NthField(name, "-", 1))` which yields 0 for those, unmatched by any band).
    private static func leadingNumber(_ filename: String) -> Int? {
        Int(filename.prefix { $0.isNumber })
    }

    private static func cgImage(at url: URL) -> CGImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else { return nil }
        return image
    }
}
