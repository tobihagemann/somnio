import CoreGraphics
import Foundation
import ImageIO
import Logging
import RealityKit
import SomnioCore

/// Model-pack accessor for the RealityKit scene. A protocol over a `Bundle.main`-backed loader
/// with one structural constraint forced by RealityKit: `Entity(contentsOf:)` is async, but the
/// render surface that consumes these models is driven synchronously. Implementations therefore
/// load and cache every registry model in an async `prewarm()` (called from the sector-load path
/// before placement), and the per-request accessors are synchronous cache reads — a stem the
/// prewarm has not cached yet resolves `nil` (⇒ placeholder), never blocking and never trapping.
@MainActor public protocol ModelAssets {
    func prewarm() async
    func entity(forKind kind: WorldEntity.Kind, figure: Int16) -> Entity?
    func object(forID id: String) -> Entity?
    func floorMaterialTexture(forID id: String) -> TextureResource?
    func floorMaterialURL(forID id: String) -> URL?
}

/// Loads USDZ models from a runtime `Bundle` whose `Resources/` directory follows the subdirectory
/// layout produced by `Scripts/bundle-assets.sh` (`Models/`, `FloorMaterials/`), resolving the
/// sector format's semantic ids through the committed model registry. Loaded roots are cached as
/// prototypes and every accessor returns a fresh recursive clone — an `Entity` is a mutable
/// scene-graph node (transform, parent, animation state), so handing the same instance to
/// multiple world entities would share that state across them.
@MainActor public final class BundleMainModelAssets: ModelAssets {
    private static let logger = Logger(label: "de.tobiha.somnio.scene3d.assets")

    private let bundle: Bundle
    private let registry: ModelRegistry
    private var prototypes: [String: Entity] = [:]
    /// Negative cache: a stem whose URL or load already failed is not re-resolved on the next
    /// prewarm pass (no-asset-pack fallback stays cheap).
    private var prototypeMisses: Set<String> = []
    private var floorMaterialTextureCache: [String: TextureResource] = [:]
    private var floorMaterialMisses: Set<String> = []

    public init(bundle: Bundle = .main, registry: ModelRegistry? = nil) {
        self.bundle = bundle
        self.registry = registry ?? Self.loadBundledRegistry()
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

    /// Loads and caches every registry model prototype and floor-material texture. Call from the
    /// async sector-load path before entity placement; the synchronous accessors only ever read
    /// the caches this fills.
    public func prewarm() async {
        for entry in registry.allModelEntries
            where prototypes[entry.stem] == nil && !prototypeMisses.contains(entry.stem) {
            await loadPrototype(for: entry)
        }
        for material in registry.floorMaterials
            where floorMaterialTextureCache[material.stem] == nil && !floorMaterialMisses.contains(material.stem) {
            await loadFloorMaterialTexture(stem: material.stem)
        }
    }

    public func entity(forKind kind: WorldEntity.Kind, figure: Int16) -> Entity? {
        guard let entry = registry.model(forKind: kind, figure: figure) else { return nil }
        return clone(ofStem: entry.stem)
    }

    public func object(forID id: String) -> Entity? {
        guard let entry = registry.model(forObjectID: id) else { return nil }
        return clone(ofStem: entry.stem)
    }

    /// The dedicated floor-material texture for a sector's `floorMaterialID`, or `nil` when the id
    /// is unmapped or its texture was not warmed (absent/unloadable PNG) — the floor then falls
    /// back to a solid lit plane. A pure read of the cache `prewarm()` fills, like `object`/`entity`.
    public func floorMaterialTexture(forID id: String) -> TextureResource? {
        guard let stem = registry.floorMaterialStem(forID: id) else { return nil }
        return floorMaterialTextureCache[stem]
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

    private func loadFloorMaterialTexture(stem: String) async {
        guard let url = bundle.url(forResource: stem, withExtension: "png", subdirectory: "FloorMaterials") else {
            floorMaterialMisses.insert(stem)
            Self.logger.info("floor material .png absent from bundle; rendering the untextured floor", metadata: ["stem": "\(stem)"])
            return
        }
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
              // The async initializer keeps the (documented main-actor-blocking) synchronous texture
              // upload off the first sector-load frame. Mipmaps matter here: the material tiles across
              // the whole sector floor, and un-mipped minification shimmers under the 3/4 camera.
              let texture = try? await TextureResource(
                  image: image,
                  options: .init(semantic: .color, mipmapsMode: .allocateAndGenerateAll)
              )
        else {
            floorMaterialMisses.insert(stem)
            Self.logger.error("floor material unloadable; rendering the untextured floor", metadata: ["stem": "\(stem)"])
            return
        }
        floorMaterialTextureCache[stem] = texture
    }
}
