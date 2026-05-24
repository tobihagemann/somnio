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
/// `groundTexture` takes only three params because each engine tile is composed at
/// load time from a 4 × 4 grid of 32 × 32 source-pack pixels — the slicing is implicit
/// in the implementation. `objectTexture` takes an explicit five-param source rect
/// because the `Object` record carries its own width and height which can be any size.
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
}

/// Loads textures from a runtime `Bundle` whose `Resources/` directory follows the
/// subdirectory layout produced by `Scripts/bundle-assets.sh` (`Tilesets/`,
/// `Animations/`, `System/`, `Characters/`, `Buttons/`). Tilesets are keyed by a
/// zero-padded three-digit numeric prefix in their filename.
@MainActor public final class BundleMainSpriteAssets: SpriteAssets {
    private static let logger = Logger(label: "de.tobiha.somnio.ui.assets")
    private static let sourceCellSize = 32

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

    private let bundle: Bundle
    private var tilesetImageCache: [Int16: CGImage] = [:]
    private var groundTextureCache: [GroundKey: SKTexture] = [:]
    private var characterImageCache: [Int16: CGImage] = [:]
    private var characterImageMisses: Set<Int16> = []
    private var characterSheetTextureCache: [Int16: SKTexture] = [:]
    private var entityTextureCache: [EntityTextureKey: SKTexture] = [:]

    public init(bundle: Bundle = .main) {
        self.bundle = bundle
    }

    public func groundTexture(tilesetIndex: Int16, sourceX: Int16, sourceY: Int16) -> SKTexture? {
        guard sourceX >= 0, sourceY >= 0 else { return nil }
        let key = GroundKey(tilesetIndex: tilesetIndex, sourceX: sourceX, sourceY: sourceY)
        if let cached = groundTextureCache[key] { return cached }
        guard let tileset = tilesetImage(for: tilesetIndex) else { return nil }
        let composedSize = Int(SomnioConstants.tileSize)
        let sourceRect = CGRect(x: Int(sourceX), y: Int(sourceY), width: Self.sourceCellSize, height: Self.sourceCellSize)
        guard sourceRect.maxX <= CGFloat(tileset.width),
              sourceRect.maxY <= CGFloat(tileset.height),
              let cell = tileset.cropping(to: sourceRect),
              let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(
                  data: nil,
                  width: composedSize,
                  height: composedSize,
                  bitsPerComponent: 8,
                  bytesPerRow: 0,
                  space: space,
                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
              )
        else { return nil }
        let tilesPerSide = composedSize / Self.sourceCellSize
        for row in 0 ..< tilesPerSide {
            for column in 0 ..< tilesPerSide {
                context.draw(
                    cell,
                    in: CGRect(
                        x: column * Self.sourceCellSize,
                        y: row * Self.sourceCellSize,
                        width: Self.sourceCellSize,
                        height: Self.sourceCellSize
                    )
                )
            }
        }
        guard let composite = context.makeImage() else { return nil }
        let texture = SKTexture(cgImage: composite)
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
        let imageWidth = CGFloat(tileset.width)
        let imageHeight = CGFloat(tileset.height)
        guard imageWidth > 0, imageHeight > 0,
              CGFloat(sourceX) + CGFloat(sourceWidth) <= imageWidth,
              CGFloat(sourceY) + CGFloat(sourceHeight) <= imageHeight
        else { return nil }
        let whole = SKTexture(cgImage: tileset)
        // `SKTexture(rect:in:)` uses normalized UV coordinates with the origin at the
        // bottom-left of the source image, but the legacy Object record's source rect
        // is in top-left pixel coordinates. Flip the Y axis so the slice matches.
        let uvX = CGFloat(sourceX) / imageWidth
        let uvY = (imageHeight - CGFloat(sourceY) - CGFloat(sourceHeight)) / imageHeight
        let uvW = CGFloat(sourceWidth) / imageWidth
        let uvH = CGFloat(sourceHeight) / imageHeight
        return SKTexture(rect: CGRect(x: uvX, y: uvY, width: uvW, height: uvH), in: whole)
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
        let sheetIndex: Int16
        let pixelRect: CGRect
        switch kind {
        case .player, .peer:
            // All players share `001-Main01.png` (sheet index 0); the wire figure selects
            // the character region within it, not the sheet file.
            guard figureIndex >= 0, figureIndex < Int16(Self.playerSheetColumns * Self.playerSheetRows),
                  let playerSheet = characterSheetImage(for: 0) else { return nil }
            let charColumn = Int(figureIndex) % Self.playerSheetColumns
            let charRow = Int(figureIndex) / Self.playerSheetColumns
            let regionWidth = Self.entityWalkFrames * Self.playerCellWidth
            let regionHeight = Self.entityDirections * Self.playerCellHeight
            sheet = playerSheet
            sheetIndex = 0
            pixelRect = CGRect(
                x: charColumn * regionWidth + frame * Self.playerCellWidth,
                y: charRow * regionHeight + Int(facing.rawValue) * Self.playerCellHeight,
                width: Self.playerCellWidth,
                height: Self.playerCellHeight
            )
        case .npc, .monster:
            guard let npcSheet = characterSheetImage(for: figureIndex) else { return nil }
            let cellWidth = npcSheet.width / Self.entityWalkFrames
            let cellHeight = npcSheet.height / Self.entityDirections
            guard cellWidth > 0, cellHeight > 0 else { return nil }
            sheet = npcSheet
            sheetIndex = figureIndex
            pixelRect = CGRect(
                x: frame * cellWidth,
                y: Int(facing.rawValue) * cellHeight,
                width: cellWidth,
                height: cellHeight
            )
        }
        guard let texture = entitySlice(in: sheet, sheetIndex: sheetIndex, pixelRect: pixelRect) else { return nil }
        entityTextureCache[key] = texture
        return texture
    }

    /// Slices a top-left pixel rect out of a whole-sheet `CGImage`, returning a UV-rect
    /// `SKTexture` against a cached whole-sheet texture. Mirrors `objectTexture`'s Y-flip
    /// (`SKTexture(rect:in:)` is bottom-left UV; the sheet rect is top-left pixels).
    private func entitySlice(in sheetImage: CGImage, sheetIndex: Int16, pixelRect: CGRect) -> SKTexture? {
        let imageWidth = CGFloat(sheetImage.width)
        let imageHeight = CGFloat(sheetImage.height)
        guard imageWidth > 0, imageHeight > 0,
              pixelRect.minX >= 0, pixelRect.minY >= 0,
              pixelRect.maxX <= imageWidth, pixelRect.maxY <= imageHeight
        else { return nil }
        let whole: SKTexture
        if let cached = characterSheetTextureCache[sheetIndex] {
            whole = cached
        } else {
            whole = SKTexture(cgImage: sheetImage)
            characterSheetTextureCache[sheetIndex] = whole
        }
        let uvX = pixelRect.minX / imageWidth
        let uvY = (imageHeight - pixelRect.minY - pixelRect.height) / imageHeight
        let uvW = pixelRect.width / imageWidth
        let uvH = pixelRect.height / imageHeight
        return SKTexture(rect: CGRect(x: uvX, y: uvY, width: uvW, height: uvH), in: whole)
    }

    public func animationStrip(name: String) -> SKTexture? {
        guard let url = bundle.url(forResource: name, withExtension: "png", subdirectory: "Animations"),
              let image = Self.cgImage(at: url) else {
            return nil
        }
        return SKTexture(cgImage: image)
    }

    public func splash() -> SKTexture? {
        guard let url = bundle.url(
            forResource: "001-SplashScreen01",
            withExtension: "png",
            subdirectory: "System"
        ), let image = Self.cgImage(at: url) else {
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

    private func characterSheetImage(for figureIndex: Int16) -> CGImage? {
        if let cached = characterImageCache[figureIndex] { return cached }
        // Negative cache: `entityTexture` is hit per walk-frame, so without this a missing
        // sheet (no-asset-pack fallback) re-scans/sorts the bundle every frame.
        if characterImageMisses.contains(figureIndex) { return nil }
        guard let urls = bundle.urls(forResourcesWithExtension: "png", subdirectory: "Characters") else {
            characterImageMisses.insert(figureIndex)
            return nil
        }
        // Binary stores 0-based indices; filenames are 1-based (`001-`...`128-`). Widen to
        // `Int` before `+ 1` so a hostile/corrupt `Int16.max` figure index can't trap the add.
        let prefix = String(format: "%03d-", Int(figureIndex) + 1)
        let matches = urls
            .filter { $0.lastPathComponent.hasPrefix(prefix) }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        guard let pick = matches.first else {
            characterImageMisses.insert(figureIndex)
            return nil
        }
        if matches.count > 1 {
            Self.logger.warning(
                "duplicate character prefix; picking lexicographically-first match",
                metadata: [
                    "figure_index": "\(figureIndex)",
                    "picked": "\(pick.lastPathComponent)",
                    "candidates": "\(matches.map(\.lastPathComponent))"
                ]
            )
        }
        guard let image = Self.cgImage(at: pick) else {
            characterImageMisses.insert(figureIndex)
            return nil
        }
        characterImageCache[figureIndex] = image
        return image
    }

    private static func cgImage(at url: URL) -> CGImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else { return nil }
        return image
    }
}
