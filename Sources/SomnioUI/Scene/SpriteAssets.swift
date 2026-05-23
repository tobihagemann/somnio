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
    func characterTexture(figure: Int16, frame: Int) -> SKTexture?
    func npcTexture(figure: Int16, frame: Int) -> SKTexture?
    func monsterTexture(figure: Int16, frame: Int) -> SKTexture?
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

    private struct GroundKey: Hashable {
        // periphery:ignore
        let tilesetIndex: Int16
        // periphery:ignore
        let sourceX: Int16
        // periphery:ignore
        let sourceY: Int16
    }

    private let bundle: Bundle
    private var tilesetImageCache: [Int16: CGImage] = [:]
    private var groundTextureCache: [GroundKey: SKTexture] = [:]

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

    /// Character/NPC/monster slots are unwired — the scene does not read these accessors.
    public func characterTexture(figure _: Int16, frame _: Int) -> SKTexture? {
        nil
    }

    public func npcTexture(figure _: Int16, frame _: Int) -> SKTexture? {
        nil
    }

    public func monsterTexture(figure _: Int16, frame _: Int) -> SKTexture? {
        nil
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
        let prefix = String(format: "%03d-", tilesetIndex)
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

    private static func cgImage(at url: URL) -> CGImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else { return nil }
        return image
    }
}
