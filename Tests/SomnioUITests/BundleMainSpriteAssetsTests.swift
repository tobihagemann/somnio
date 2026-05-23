import AppKit
import CoreGraphics
import Foundation
import SomnioCore
import SpriteKit
import Testing
@testable import SomnioUI

@MainActor
struct BundleMainSpriteAssetsTests {
    @Test func `groundTexture tiles the source cell into a composed engine tile`() throws {
        let assets = BundleMainSpriteAssets(bundle: Bundle.module)
        let texture = try #require(
            assets.groundTexture(tilesetIndex: 999, sourceX: 0, sourceY: 0)
        )
        let size = texture.size()
        #expect(size.width == CGFloat(SomnioConstants.tileSize))
        #expect(size.height == CGFloat(SomnioConstants.tileSize))

        // The cell at (0,0) carries red/green/blue at corner pixels; a correctly tiled
        // 4x4 composite carries exactly 16 of each.
        let counts = countColors(in: texture)
        #expect(counts.red == 16)
        #expect(counts.green == 16)
        #expect(counts.blue == 16)
    }

    @Test func `groundTexture interprets sourceX as a pixel offset (not a cell index)`() throws {
        let assets = BundleMainSpriteAssets(bundle: Bundle.module)
        // The fixture's second cell at pixel offset (32, 0) carries yellow/magenta/cyan.
        // The prior cell-index interpretation would multiply by 32 and look at x=1024,
        // which is out of bounds; this assertion locks the pixel-offset semantics in.
        let texture = try #require(
            assets.groundTexture(tilesetIndex: 999, sourceX: 32, sourceY: 0)
        )
        let counts = countColors(in: texture)
        #expect(counts.yellow == 16)
        #expect(counts.magenta == 16)
        #expect(counts.cyan == 16)
    }

    @Test func `groundTexture returns nil when the source rect extends past the tileset bounds`() {
        let assets = BundleMainSpriteAssets(bundle: Bundle.module)
        // The fixture is 64x32.
        #expect(assets.groundTexture(tilesetIndex: 999, sourceX: 64, sourceY: 0) == nil)
        #expect(assets.groundTexture(tilesetIndex: 999, sourceX: 0, sourceY: 32) == nil)
    }

    @Test func `groundTexture returns nil for negative source coordinates`() {
        let assets = BundleMainSpriteAssets(bundle: Bundle.module)
        #expect(assets.groundTexture(tilesetIndex: 999, sourceX: -1, sourceY: 0) == nil)
        #expect(assets.groundTexture(tilesetIndex: 999, sourceX: 0, sourceY: -1) == nil)
    }

    @Test func `objectTexture returns nil for invalid source rectangles`() {
        let assets = BundleMainSpriteAssets(bundle: Bundle.module)
        #expect(assets.objectTexture(tilesetIndex: 999, sourceX: -1, sourceY: 0, sourceWidth: 4, sourceHeight: 4) == nil)
        #expect(assets.objectTexture(tilesetIndex: 999, sourceX: 0, sourceY: 0, sourceWidth: 0, sourceHeight: 4) == nil)
        #expect(assets.objectTexture(tilesetIndex: 999, sourceX: 0, sourceY: 0, sourceWidth: 4, sourceHeight: -1) == nil)
        #expect(assets.objectTexture(tilesetIndex: 999, sourceX: 60, sourceY: 0, sourceWidth: 8, sourceHeight: 4) == nil)
        #expect(assets.objectTexture(tilesetIndex: 999, sourceX: 0, sourceY: 30, sourceWidth: 4, sourceHeight: 8) == nil)
    }

    @Test func `groundTexture returns nil for an unmatched tileset prefix`() {
        let assets = BundleMainSpriteAssets(bundle: Bundle.module)
        #expect(assets.groundTexture(tilesetIndex: 42, sourceX: 0, sourceY: 0) == nil)
    }

    @Test func `groundTexture caches the composed texture per source cell`() throws {
        let assets = BundleMainSpriteAssets(bundle: Bundle.module)
        let first = try #require(assets.groundTexture(tilesetIndex: 999, sourceX: 0, sourceY: 0))
        let second = try #require(assets.groundTexture(tilesetIndex: 999, sourceX: 0, sourceY: 0))
        #expect(first === second, "expected the same SKTexture instance from the cache")
    }

    @Test func `objectTexture at sourceY=0 slices row 0 of the tileset`() throws {
        let assets = BundleMainSpriteAssets(bundle: Bundle.module)
        // Row 0 of the fixture has red/green/yellow/magenta at columns 0, 1, 32, 33; row 1
        // has blue/cyan at columns 0, 32; everything else is white. A slice at sourceY=0
        // must contain row 0's red + yellow markers and *none* of row 1's blue/cyan — a
        // regression dropping the Y-flip would pull row 1 instead.
        let texture = try #require(
            assets.objectTexture(tilesetIndex: 999, sourceX: 0, sourceY: 0, sourceWidth: 64, sourceHeight: 1)
        )
        let counts = countColors(in: texture)
        #expect(counts.red > 0, "expected red from row 0 column 0")
        #expect(counts.yellow > 0, "expected yellow from row 0 column 32")
        #expect(counts.blue == 0, "row 1 blue must not appear in a sourceY=0 slice")
        #expect(counts.cyan == 0, "row 1 cyan must not appear in a sourceY=0 slice")
    }

    @Test func `objectTexture at sourceY=1 slices row 1 of the tileset`() throws {
        let assets = BundleMainSpriteAssets(bundle: Bundle.module)
        let texture = try #require(
            assets.objectTexture(tilesetIndex: 999, sourceX: 0, sourceY: 1, sourceWidth: 64, sourceHeight: 1)
        )
        let counts = countColors(in: texture)
        #expect(counts.blue > 0, "expected blue from row 1 column 0")
        #expect(counts.cyan > 0, "expected cyan from row 1 column 32")
        #expect(counts.red == 0, "row 0 red must not appear in a sourceY=1 slice")
    }

    @Test func `splash returns nil when System asset is absent from the bundle`() {
        let assets = BundleMainSpriteAssets(bundle: Bundle.module)
        // The test bundle ships only `Tilesets/`; absent `System/` exercises the
        // runtime's no-asset-pack fallback.
        #expect(assets.splash() == nil)
    }

    @Test func `animationStrip returns nil when Animations asset is absent`() {
        let assets = BundleMainSpriteAssets(bundle: Bundle.module)
        #expect(assets.animationStrip(name: "AnyName") == nil)
    }

    // MARK: - Helpers

    private struct ColorCounts {
        var red = 0
        var green = 0
        var blue = 0
        var yellow = 0
        var magenta = 0
        var cyan = 0
    }

    private func countColors(in texture: SKTexture) -> ColorCounts {
        guard let bitmap = makeBitmap(from: texture) else { return ColorCounts() }
        var counts = ColorCounts()
        for y in 0 ..< bitmap.pixelsHigh {
            for x in 0 ..< bitmap.pixelsWide {
                guard let color = bitmap.colorAt(x: x, y: y) else { continue }
                if approximatelyRed(color) { counts.red += 1 }
                if approximatelyGreen(color) { counts.green += 1 }
                if approximatelyBlue(color) { counts.blue += 1 }
                if approximatelyYellow(color) { counts.yellow += 1 }
                if approximatelyMagenta(color) { counts.magenta += 1 }
                if approximatelyCyan(color) { counts.cyan += 1 }
            }
        }
        return counts
    }

    private func makeBitmap(from texture: SKTexture) -> NSBitmapImageRep? {
        let cgImage = texture.cgImage()
        return NSBitmapImageRep(cgImage: cgImage)
    }

    private func approximatelyRed(_ color: NSColor) -> Bool {
        color.redComponent > 0.85 && color.greenComponent < 0.2 && color.blueComponent < 0.2
    }

    private func approximatelyGreen(_ color: NSColor) -> Bool {
        color.redComponent < 0.2 && color.greenComponent > 0.85 && color.blueComponent < 0.2
    }

    private func approximatelyBlue(_ color: NSColor) -> Bool {
        color.redComponent < 0.2 && color.greenComponent < 0.2 && color.blueComponent > 0.85
    }

    private func approximatelyYellow(_ color: NSColor) -> Bool {
        color.redComponent > 0.85 && color.greenComponent > 0.85 && color.blueComponent < 0.2
    }

    private func approximatelyMagenta(_ color: NSColor) -> Bool {
        color.redComponent > 0.85 && color.greenComponent < 0.2 && color.blueComponent > 0.85
    }

    private func approximatelyCyan(_ color: NSColor) -> Bool {
        color.redComponent < 0.2 && color.greenComponent > 0.85 && color.blueComponent > 0.85
    }
}
