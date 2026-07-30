import AppKit
import Testing
@testable import SomnioScene3D

/// Pins the two system-font line-box numbers the browser client mirrors as literals.
///
/// `SpeechBubbleArt` and `NamePlaqueArt` position text with `NSAttributedString.draw(at:)`, which
/// takes the top-left of the **line box**, and size their boxes from `size().height`. Neither
/// quantity has a canvas equivalent that agrees: Chrome's `fontBoundingBoxAscent` happens to match
/// the baseline offset, but `fontBoundingBoxDescent` reports 2 where AppKit rounds to 3, so the
/// browser's plaque box came out a pixel short. `Web/src/scene/overlayArt.ts` therefore carries both
/// as recorded constants (`NATIVE_LINE_BOX`), and this suite is what stops them going stale — a
/// macOS system-font change fails here rather than quietly drifting the two clients apart.
///
/// Measured through `OverlayRaster`'s own pipeline rather than from `NSFont.ascender`: AppKit's
/// default line height is not the font's ascent plus descent (9.67 + 2.11 is 11.78, while
/// `size().height` is 13.0 at System-10), so only the rasterized result is authoritative.
@MainActor
struct NativeLineBoxTests {
    /// Mirrors `nativeLineBoxHeight` in the browser client: `fontSize + 3`.
    @Test(arguments: [(CGFloat(10), CGFloat(13)), (CGFloat(11), CGFloat(14))])
    func `line box height is the point size plus three`(size: CGFloat, expected: CGFloat) {
        let font = NSFont.systemFont(ofSize: size)
        let measured = NSAttributedString(string: "Hg", attributes: [.font: font]).size().height
        #expect(measured == expected)
    }

    /// Mirrors `nativeBaselineOffset`: the baseline sits exactly `fontSize` below the draw origin.
    ///
    /// Read off the rendered bitmap, using a sample with no descender so the last inked row *is* the
    /// baseline. Drawn at a non-zero origin so an implementation that ignored the origin would fail.
    @Test(arguments: [CGFloat(10), CGFloat(11)])
    func `baseline sits one point size below the draw origin`(size: CGFloat) throws {
        let boxTop: CGFloat = 4
        let bottom = try #require(inkBottom(sample: "H", size: size, boxTop: boxTop))
        #expect(bottom == boxTop + size)
    }

    /// Last inked row in legacy pixels, rasterized exactly as the overlay art is.
    private func inkBottom(sample: String, size: CGFloat, boxTop: CGFloat) -> CGFloat? {
        let scale = OverlayRaster.scale
        let frame = CGSize(width: 60, height: 40)
        let pixelWidth = Int(frame.width * scale)
        let pixelHeight = Int(frame.height * scale)
        // A CGContext, not `NSImage.lockFocus`: the latter is unreliable headless (it can hand back
        // a 0x0 backing store), while an explicit bitmap context renders identically to production.
        guard let context = CGContext(
            data: nil, width: pixelWidth, height: pixelHeight, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return nil }
        context.setFillColor(CGColor(gray: 1, alpha: 1))
        context.fill(CGRect(origin: .zero, size: CGSize(width: pixelWidth, height: pixelHeight)))
        context.scaleBy(x: scale, y: scale)
        context.translateBy(x: 0, y: frame.height)
        context.scaleBy(x: 1, y: -1)
        let previous = NSGraphicsContext.current
        NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: true)
        let font = NSFont.systemFont(ofSize: size)
        NSAttributedString(string: sample, attributes: [.font: font, .foregroundColor: NSColor.black])
            .draw(at: CGPoint(x: 4, y: boxTop))
        NSGraphicsContext.current = previous

        guard let data = context.data else { return nil }
        let bytes = data.assumingMemoryBound(to: UInt8.self)
        let rowBytes = context.bytesPerRow
        var last = -1
        for row in 0 ..< pixelHeight {
            for column in 0 ..< pixelWidth where bytes[row * rowBytes + column] < 128 {
                last = row
                break
            }
        }
        guard last >= 0 else { return nil }
        // The baseline is the boundary *below* the last inked row.
        return CGFloat(last + 1) / scale
    }
}
