import AppKit
import CoreGraphics
import Foundation
import SomnioCore
import Testing
@testable import SomnioScene3D

/// Structural guards for the CoreGraphics overlay artwork. Rendered *looks* are judged by
/// smoke-testing (the project's RealityKit visual rule); these assert the geometry contracts
/// the scene's quad sizing depends on, plus the mask silhouette that cuts the bubble to shape.
@MainActor
struct OverlayArtTests {
    @Test func `plaque art sizes the box around the measured text at the supersampled footprint`() throws {
        let rendering = try #require(NamePlaqueArt.render(name: "Libus", background: NamePlaqueArt.npcBackground, bold: false))
        #expect(rendering.sizePixels.width > 6)
        #expect(rendering.sizePixels.height > 4)
        #expect(rendering.image.width == Int(rendering.sizePixels.width * OverlayRaster.scale))
        #expect(rendering.image.height == Int(rendering.sizePixels.height * OverlayRaster.scale))
    }

    @Test func `a longer name widens the plaque without changing its height`() throws {
        let short = try #require(NamePlaqueArt.render(name: "Bo", background: NamePlaqueArt.playerBackground, bold: false))
        let long = try #require(NamePlaqueArt.render(name: "Bodobert der Lange", background: NamePlaqueArt.playerBackground, bold: false))
        #expect(long.sizePixels.width > short.sizePixels.width)
        #expect(long.sizePixels.height == short.sizePixels.height)
    }

    @Test func `a hostile oversized name clamps to the byte cap instead of growing the raster`() throws {
        // The clamp is a byte prefix, not a grapheme count: an ASCII name past the cap
        // renders exactly as its 64-byte prefix, and doubling the input changes nothing.
        let capBytes = SomnioConstants.maxRenderedNameUTF8Bytes
        let atCap = try #require(NamePlaqueArt.render(
            name: String(repeating: "x", count: capBytes), background: NamePlaqueArt.playerBackground, bold: false
        ))
        let oversized = try #require(NamePlaqueArt.render(
            name: String(repeating: "x", count: capBytes * 4), background: NamePlaqueArt.playerBackground, bold: false
        ))
        let huge = try #require(NamePlaqueArt.render(
            name: String(repeating: "x", count: capBytes * 8), background: NamePlaqueArt.playerBackground, bold: false
        ))
        #expect(oversized.sizePixels == atCap.sizePixels)
        #expect(huge.sizePixels == oversized.sizePixels)
    }

    @Test func `a multibyte name split at the byte cap still renders bounded`() throws {
        // 3-byte scalars guarantee the 64-byte cut lands mid-codepoint; the decode degrades
        // to U+FFFD rather than trapping, and the raster stays bounded.
        let clamped = try #require(NamePlaqueArt.render(
            name: String(repeating: "€", count: 100), background: NamePlaqueArt.npcBackground, bold: false
        ))
        let doubled = try #require(NamePlaqueArt.render(
            name: String(repeating: "€", count: 200), background: NamePlaqueArt.npcBackground, bold: false
        ))
        #expect(clamped.sizePixels == doubled.sizePixels)
    }

    @Test func `bubble frame height follows the legacy lines-times-12-plus-20 rule`() {
        #expect(SpeechBubbleArt.frameSize(lineCount: 1) == CGSize(width: 150, height: 32))
        #expect(SpeechBubbleArt.frameSize(lineCount: 4) == CGSize(width: 150, height: 68))
        // Degenerate zero-line input still yields a drawable one-line frame.
        #expect(SpeechBubbleArt.frameSize(lineCount: 0) == CGSize(width: 150, height: 32))
    }

    @Test func `bubble art renders color and mask at the same supersampled footprint`() throws {
        let rendering = try #require(SpeechBubbleArt.render(lines: ["Sei gegrüßt!", "Willkommen in Edaria."]))
        #expect(rendering.sizePixels == SpeechBubbleArt.frameSize(lineCount: 2))
        #expect(rendering.color.width == rendering.opacityMask.width)
        #expect(rendering.color.height == rendering.opacityMask.height)
        #expect(rendering.color.width == Int(SpeechBubbleArt.widthPixels * OverlayRaster.scale))
    }

    @Test func `the bubble mask is opaque inside the body and transparent at the frame corners`() throws {
        let rendering = try #require(SpeechBubbleArt.render(lines: ["Sei gegrüßt!"]))
        let mask = rendering.opacityMask
        let data = try #require(mask.dataProvider?.data as Data?)
        let bytesPerRow = mask.bytesPerRow
        func gray(x: Int, y: Int) -> UInt8 {
            data[y * bytesPerRow + x]
        }
        // Body center is well inside the rounded rect; the frame's top-left corner sits
        // outside the corner radius, and the bottom-left corner is beside the tail.
        #expect(gray(x: mask.width / 2, y: mask.height / 2) > 200)
        #expect(gray(x: 0, y: 0) < 50)
        #expect(gray(x: 0, y: mask.height - 1) < 50)
        // Tail interior (bottom center, above the tip) — a lost body/tail union would render
        // a plain rounded rect and zero this sample.
        #expect(gray(x: mask.width / 2, y: mask.height - Int(5 * OverlayRaster.scale)) > 200)
    }
}
