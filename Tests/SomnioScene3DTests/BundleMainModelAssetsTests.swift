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
        #expect(assets.object(forID: "door") == nil)
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

    @Test func `object returns nil for a mapped id whose model is absent from the bundle`() async {
        // The registry maps the id, so resolution reaches the prototype cache — which missed
        // during prewarm because the test bundle carries no Models/ subtree.
        let registry = ModelRegistry(
            entityBands: EntityModelBands(player: [], npc: [], monster: []),
            objectModels: [ObjectModelRule(id: "tree", model: ModelEntry(stem: "Tree"))],
            floorMaterials: []
        )
        let assets = BundleMainModelAssets(bundle: .main, registry: registry)
        await assets.prewarm()
        #expect(assets.object(forID: "tree") == nil)
    }

    @Test func `object returns nil for an unmapped id`() async {
        let assets = packAbsentAssets()
        await assets.prewarm()
        #expect(assets.object(forID: "no-such-object") == nil)
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

    @Test func `floorMaterialTexture returns nil for an unmapped id`() {
        let assets = packAbsentAssets()
        #expect(assets.floorMaterialTexture(forID: "no-such-material") == nil)
    }

    @Test func `floorMaterialTexture returns nil for a mapped id whose PNG is absent, even after prewarm`() async {
        // The registry maps the id, so prewarm reaches the FloorMaterials bundle lookup — which
        // misses because the test bundle has no such subtree, recording the stem as a miss. The
        // accessor is a pure cache read, so it then resolves nil like the model accessors do.
        let registry = ModelRegistry(
            entityBands: EntityModelBands(player: [], npc: [], monster: []),
            objectModels: [],
            floorMaterials: [FloorMaterialRule(id: "grass", stem: "GrassAlbedo")]
        )
        let assets = BundleMainModelAssets(bundle: .main, registry: registry)
        await assets.prewarm()
        #expect(assets.floorMaterialTexture(forID: "grass") == nil)
    }

    @Test func `a corrupt-registry fallback resolves everything to placeholder`() async {
        let assets = BundleMainModelAssets(bundle: .main, registry: .placeholderFallback)
        await assets.prewarm()
        #expect(assets.entity(forKind: .player, figure: 0) == nil)
        #expect(assets.floorMaterialURL(forID: "grass") == nil)
    }
}
