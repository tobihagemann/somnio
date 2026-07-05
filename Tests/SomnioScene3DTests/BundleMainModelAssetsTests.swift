import Foundation
import SomnioCore
import Testing
@testable import SomnioScene3D

/// Guards only the nil/placeholder path: every case here short-circuits before a RealityKit
/// asset load, so it runs headlessly. Positive USDZ loading and clip enumeration need a live
/// RealityKit device and are covered by the smoke test and the SomnioAssetValidator tool.
@MainActor
struct BundleMainModelAssetsTests {
    /// The test bundle carries no `Models/` or `FloorMaterials/` subtree — the pack-absent case.
    private func packAbsentAssets() -> BundleMainModelAssets {
        BundleMainModelAssets(bundle: .main)
    }

    @Test func `accessors return nil before prewarm has cached anything`() {
        let assets = packAbsentAssets()
        #expect(assets.entity(forKind: .player, figure: 0) == nil)
        #expect(assets.object(forSignature: SourceRectSignature(tilesetIndex: 0, sourceX: 0, sourceY: 0, sourceWidth: 1, sourceHeight: 1)) == nil)
        #expect(assets.floorMaterialURL(forID: "grass") == nil)
    }

    @Test func `prewarm on an absent pack records misses without trapping`() async {
        let assets = packAbsentAssets()
        await assets.prewarm()
        #expect(assets.entity(forKind: .player, figure: 0) == nil)
        #expect(assets.entity(forKind: .npc, figure: 16) == nil)
        #expect(assets.entity(forKind: .monster, figure: 0) == nil)
    }

    @Test func `entity returns nil for an unmapped figure`() async {
        let assets = packAbsentAssets()
        await assets.prewarm()
        #expect(assets.entity(forKind: .npc, figure: 99) == nil)
    }

    @Test func `object returns nil for a mapped signature whose model is absent from the bundle`() async {
        // The registry maps the signature, so resolution reaches the prototype cache — which
        // missed during prewarm because the test bundle carries no Models/ subtree.
        let signature = SourceRectSignature(tilesetIndex: 4, sourceX: 0, sourceY: 96, sourceWidth: 64, sourceHeight: 96)
        let registry = ModelRegistry(
            entityBands: EntityModelBands(player: [], npc: [], monster: []),
            objectModels: [ObjectModelRule(signature: signature, model: ModelEntry(stem: "Tree"))],
            floorMaterials: []
        )
        let assets = BundleMainModelAssets(bundle: .main, registry: registry)
        await assets.prewarm()
        #expect(assets.object(forSignature: signature) == nil)
    }

    @Test func `floorMaterialURL returns nil when the mapped stem is absent from the bundle`() {
        // The registry maps the id, so resolution reaches the FloorMaterials bundle lookup —
        // which misses because the test bundle carries no such subtree.
        let registry = ModelRegistry(
            entityBands: EntityModelBands(player: [], npc: [], monster: []),
            objectModels: [],
            floorMaterials: [FloorMaterialRule(id: "grass", stem: "GrassAlbedo")]
        )
        let assets = BundleMainModelAssets(bundle: .main, registry: registry)
        #expect(assets.floorMaterialURL(forID: "grass") == nil)
    }

    @Test func `groundTexture returns nil for negative source coordinates`() {
        let assets = packAbsentAssets()
        #expect(assets.groundTexture(tilesetIndex: 0, sourceX: -1, sourceY: 0) == nil)
        #expect(assets.groundTexture(tilesetIndex: 0, sourceX: 0, sourceY: -1) == nil)
    }

    @Test func `groundTexture returns nil when the tileset is absent, including the cached retry`() {
        let assets = packAbsentAssets()
        #expect(assets.groundTexture(tilesetIndex: 0, sourceX: 0, sourceY: 0) == nil)
        // Second call exercises the negative cache rather than re-walking the bundle.
        #expect(assets.groundTexture(tilesetIndex: 0, sourceX: 0, sourceY: 0) == nil)
    }

    @Test func `groundMaterialTexture returns nil for an unmapped ground signature`() {
        let assets = packAbsentAssets()
        #expect(assets.groundMaterialTexture(tilesetIndex: 99, sourceX: 0, sourceY: 0) == nil)
    }

    @Test func `groundMaterialTexture returns nil for a mapped signature whose PNG is absent, including the cached retry`() {
        // The registry bridges the signature to a floor-material id, so resolution reaches the
        // FloorMaterials bundle lookup — which misses because the test bundle has no such subtree.
        let registry = ModelRegistry(
            entityBands: EntityModelBands(player: [], npc: [], monster: []),
            objectModels: [],
            floorMaterials: [FloorMaterialRule(id: "grass", stem: "GrassAlbedo")],
            groundMaterials: [GroundMaterialRule(tilesetIndex: 0, sourceX: 0, sourceY: 0, id: "grass")]
        )
        let assets = BundleMainModelAssets(bundle: .main, registry: registry)
        #expect(assets.groundMaterialTexture(tilesetIndex: 0, sourceX: 0, sourceY: 0) == nil)
        // Second call exercises the negative cache rather than re-resolving the stem.
        #expect(assets.groundMaterialTexture(tilesetIndex: 0, sourceX: 0, sourceY: 0) == nil)
    }

    @Test func `a corrupt-registry fallback resolves everything to placeholder`() async {
        let assets = BundleMainModelAssets(bundle: .main, registry: .placeholderFallback)
        await assets.prewarm()
        #expect(assets.entity(forKind: .player, figure: 0) == nil)
        #expect(assets.floorMaterialURL(forID: "grass") == nil)
    }
}
