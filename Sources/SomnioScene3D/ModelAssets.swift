import CoreGraphics
import Foundation
import ImageIO
import Logging
import RealityKit
import SomnioCore

/// Model-pack accessor for the RealityKit scene. Mirrors the sprite-pack accessor's shape (a
/// protocol over a `Bundle.main`-backed loader) with one structural difference forced by
/// RealityKit: `Entity(contentsOf:)` is async, but the render surface that consumes these models
/// is driven synchronously. Implementations therefore load and cache every registry model in an
/// async `prewarm()` (called from the sector-load path before placement), and the per-request
/// accessors are synchronous cache reads — a stem the prewarm has not cached yet resolves `nil`
/// (⇒ placeholder), never blocking and never trapping.
///
/// `groundTexture` mirrors the sprite accessor's three-param shape: it returns one uniform
/// 32 × 32 source-pack cell, which the floor material repeats across the sector plane.
@MainActor public protocol ModelAssets {
    func prewarm() async
    func entity(forKind kind: WorldEntity.Kind, figure: Int16) -> Entity?
    func object(forSignature signature: SourceRectSignature) -> Entity?
    func groundTexture(tilesetIndex: Int16, sourceX: Int16, sourceY: Int16) -> TextureResource?
    func groundMaterialTexture(tilesetIndex: Int16, sourceX: Int16, sourceY: Int16) -> TextureResource?
    func floorMaterialURL(forID id: String) -> URL?
}

/// Loads USDZ models from a runtime `Bundle` whose `Resources/` directory follows the subdirectory
/// layout produced by `Scripts/bundle-assets.sh` (`Models/`, `FloorMaterials/`, and — for the MVP
/// floor — the 2D pack's `Tilesets/`), resolving stems through the committed model registry.
/// Loaded roots are cached as prototypes and every accessor returns a fresh recursive clone — an
/// `Entity` is a mutable scene-graph node (transform, parent, animation state), so handing the
/// same instance to multiple world entities would share that state across them.
@MainActor public final class BundleMainModelAssets: ModelAssets {
    private static let logger = Logger(label: "de.tobiha.somnio.scene3d.assets")

    private struct GroundKey: Hashable {
        // periphery:ignore
        let tilesetIndex: Int16
        // periphery:ignore
        let sourceX: Int16
        // periphery:ignore
        let sourceY: Int16
    }

    private let bundle: Bundle
    private let registry: ModelRegistry
    /// The 2D pack's layout manifest, needed only to resolve ground-tileset filenames for the
    /// MVP floor texture (SomnioScene3D cannot reach SomnioUI's sprite loader).
    private let manifest: AssetManifest
    private var prototypes: [String: Entity] = [:]
    /// Negative cache: a stem whose URL or load already failed is not re-resolved on the next
    /// prewarm pass (no-asset-pack fallback stays cheap).
    private var prototypeMisses: Set<String> = []
    private var tilesetImageCache: [Int16: CGImage] = [:]
    private var tilesetImageMisses: Set<Int16> = []
    private var groundTextureCache: [GroundKey: TextureResource] = [:]
    private var groundTextureMisses: Set<GroundKey> = []
    private var floorMaterialTextureCache: [String: TextureResource] = [:]
    private var floorMaterialMisses: Set<String> = []

    public init(bundle: Bundle = .main, registry: ModelRegistry? = nil, manifest: AssetManifest? = nil) {
        self.bundle = bundle
        self.registry = registry ?? Self.loadBundledRegistry()
        self.manifest = manifest ?? Self.loadBundledManifest()
    }

    /// Resolves the committed model registry, degrading to the empty placeholder fallback with a
    /// logged error if the bundled JSON is (theoretically) missing or corrupt — the same graceful
    /// path as an absent model pack rather than a trap.
    private static func loadBundledRegistry() -> ModelRegistry {
        do {
            return try ModelRegistryCodec.bundledRegistry()
        } catch {
            logger.error("ModelRegistry.json missing or invalid; using placeholder fallback", metadata: ["error": "\(error)"])
            return .placeholderFallback
        }
    }

    /// Resolves the committed asset manifest the same graceful way, mirroring the sprite
    /// loader's fallback so a corrupt manifest costs the floor texture, never a trap.
    private static func loadBundledManifest() -> AssetManifest {
        do {
            return try AssetManifestCodec.bundledLegacy()
        } catch {
            logger.error("AssetManifest.json missing or invalid; using legacy fallback", metadata: ["error": "\(error)"])
            return .legacyFallback
        }
    }

    /// Loads and caches every registry model as a prototype. Call from the async sector-load path
    /// before entity placement; the synchronous accessors only ever read the cache this fills.
    public func prewarm() async {
        for entry in registry.allModelEntries
            where prototypes[entry.stem] == nil && !prototypeMisses.contains(entry.stem) {
            await loadPrototype(for: entry)
        }
    }

    public func entity(forKind kind: WorldEntity.Kind, figure: Int16) -> Entity? {
        guard let entry = registry.model(forKind: kind, figure: figure) else { return nil }
        return clone(ofStem: entry.stem)
    }

    public func object(forSignature signature: SourceRectSignature) -> Entity? {
        guard let entry = registry.model(forSignature: signature) else { return nil }
        return clone(ofStem: entry.stem)
    }

    /// The dedicated floor-material texture for a sector's authored ground signature (via the
    /// registry's interim signature -> id bridge), or `nil` when unmapped or absent — the floor
    /// then falls back to the repeated 2D ground cell.
    public func groundMaterialTexture(tilesetIndex: Int16, sourceX: Int16, sourceY: Int16) -> TextureResource? {
        guard let stem = registry.floorMaterialStem(
            forGroundTileset: tilesetIndex, sourceX: sourceX, sourceY: sourceY
        ) else { return nil }
        if let cached = floorMaterialTextureCache[stem] { return cached }
        if floorMaterialMisses.contains(stem) { return nil }
        guard let url = bundle.url(forResource: stem, withExtension: "png", subdirectory: "FloorMaterials"),
              let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
              let texture = try? TextureResource(
                  image: image,
                  options: .init(semantic: .color, mipmapsMode: .allocateAndGenerateAll)
              )
        else {
            Self.logger.error("floor material missing or unloadable; using the 2D ground cell", metadata: ["stem": "\(stem)"])
            floorMaterialMisses.insert(stem)
            return nil
        }
        floorMaterialTextureCache[stem] = texture
        return texture
    }

    /// One 32 × 32 ground cell cropped from the 2D pack's tileset PNG as a RealityKit texture,
    /// or `nil` when the pack (or the cell) is absent. Cropping a standalone `CGImage` rather
    /// than shifting UVs into the whole tileset keeps neighboring cells from bleeding at the
    /// repeat seams, mirroring the sprite loader's ground path.
    public func groundTexture(tilesetIndex: Int16, sourceX: Int16, sourceY: Int16) -> TextureResource? {
        guard sourceX >= 0, sourceY >= 0 else { return nil }
        let key = GroundKey(tilesetIndex: tilesetIndex, sourceX: sourceX, sourceY: sourceY)
        if let cached = groundTextureCache[key] { return cached }
        if groundTextureMisses.contains(key) { return nil }
        let cellSize = Int(SomnioConstants.groundCellSize)
        let sourceRect = CGRect(x: Int(sourceX), y: Int(sourceY), width: cellSize, height: cellSize)
        guard let tileset = tilesetImage(for: tilesetIndex),
              sourceRect.maxX <= CGFloat(tileset.width),
              sourceRect.maxY <= CGFloat(tileset.height),
              let cell = tileset.cropping(to: sourceRect),
              // Mipmaps matter here: the cell tiles hundreds of times across a sector floor,
              // and un-mipped minification shimmers under the 3/4 camera.
              let texture = try? TextureResource(
                  image: cell,
                  options: .init(semantic: .color, mipmapsMode: .allocateAndGenerateAll)
              )
        else {
            groundTextureMisses.insert(key)
            return nil
        }
        groundTextureCache[key] = texture
        return texture
    }

    public func floorMaterialURL(forID id: String) -> URL? {
        guard let stem = registry.floorMaterialStem(forID: id) else { return nil }
        return bundle.url(forResource: stem, withExtension: "png", subdirectory: "FloorMaterials")
    }

    private func clone(ofStem stem: String) -> Entity? {
        prototypes[stem]?.clone(recursive: true)
    }

    private func loadPrototype(for entry: ModelEntry) async {
        guard let url = bundle.url(forResource: entry.stem, withExtension: "usdz", subdirectory: "Models") else {
            prototypeMisses.insert(entry.stem)
            Self.logger.info("model .usdz absent from bundle; rendering placeholder", metadata: ["stem": "\(entry.stem)"])
            return
        }
        do {
            // A rigged USDZ is an entity tree whose skeleton and animation library must survive,
            // so it loads as a root `Entity` hierarchy, never a flattened single `ModelEntity`.
            let prototype = try await Entity(contentsOf: url)
            let missing = ModelRegistry.missingClips(
                expected: entry.expectedClips,
                actual: RealityKitAnimationClips.names(in: prototype)
            )
            if !missing.isEmpty {
                Self.logger.error(
                    "model is missing expected animation clips; the glb→USDZ conversion likely collapsed its clip library",
                    metadata: ["stem": "\(entry.stem)", "missing": "\(missing.sorted().joined(separator: ", "))"]
                )
            }
            prototypes[entry.stem] = prototype
        } catch {
            prototypeMisses.insert(entry.stem)
            Self.logger.error("failed to load model", metadata: ["stem": "\(entry.stem)", "error": "\(error)"])
        }
    }

    /// Resolves the whole tileset PNG for an index from the pack's `Tilesets/` subtree via the
    /// manifest's filename convention, with a negative cache so the no-asset-pack fallback does
    /// not re-walk the bundle per sector load.
    private func tilesetImage(for tilesetIndex: Int16) -> CGImage? {
        if let cached = tilesetImageCache[tilesetIndex] { return cached }
        if tilesetImageMisses.contains(tilesetIndex) { return nil }
        guard let urls = bundle.urls(forResourcesWithExtension: "png", subdirectory: "Tilesets") else {
            tilesetImageMisses.insert(tilesetIndex)
            return nil
        }
        let prefix = manifest.tilesetFilenamePrefix(forIndex: Int(tilesetIndex))
        let matches = urls
            .filter { $0.lastPathComponent.hasPrefix(prefix) }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        if matches.count > 1 {
            Self.logger.warning(
                "duplicate tileset prefix; picking lexicographically-first match",
                metadata: [
                    "tileset_index": "\(tilesetIndex)",
                    "picked": "\(matches[0].lastPathComponent)",
                    "candidates": "\(matches.map(\.lastPathComponent))"
                ]
            )
        }
        guard let pick = matches.first,
              let source = CGImageSourceCreateWithURL(pick as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else {
            tilesetImageMisses.insert(tilesetIndex)
            return nil
        }
        tilesetImageCache[tilesetIndex] = image
        return image
    }
}
