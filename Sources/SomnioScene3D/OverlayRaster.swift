import AppKit
import CoreGraphics
import Foundation

/// Supersampled CoreGraphics rasterizer for billboard overlay artwork (name plaques, speech
/// bubbles). Draw closures work in legacy-pixel units with a top-left origin, and the raster
/// upsamples by `scale` so vector text and hairline strokes stay crisp at the zoomed-in 3D
/// framing.
enum OverlayRaster {
    /// Texture pixels per legacy pixel. One legacy pixel spans ~3.2 screen points at the
    /// default orthographic framing, so 8 keeps the artwork above 2x-retina density.
    static let scale: CGFloat = 8

    /// Opaque RGB artwork (a color texture).
    static func colorImage(sizePixels: CGSize, draw: (CGContext) -> Void) -> CGImage? {
        image(
            sizePixels: sizePixels,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue,
            draw: draw
        )
    }

    /// 8-bit grayscale silhouette (an opacity-mask texture; white = opaque).
    static func maskImage(sizePixels: CGSize, draw: (CGContext) -> Void) -> CGImage? {
        image(
            sizePixels: sizePixels,
            space: CGColorSpaceCreateDeviceGray(),
            bitmapInfo: CGImageAlphaInfo.none.rawValue,
            draw: draw
        )
    }

    private static func image(
        sizePixels: CGSize,
        space: CGColorSpace,
        bitmapInfo: UInt32,
        draw: (CGContext) -> Void
    ) -> CGImage? {
        let width = Int((sizePixels.width * scale).rounded(.up))
        let height = Int((sizePixels.height * scale).rounded(.up))
        guard width > 0, height > 0, let context = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: space, bitmapInfo: bitmapInfo
        ) else { return nil }
        // Flip into top-left-origin legacy-pixel user space so rect math reads like the 2D
        // nodes did, and install the flipped `NSGraphicsContext` that attributed-string
        // drawing requires.
        context.scaleBy(x: scale, y: scale)
        context.translateBy(x: 0, y: sizePixels.height)
        context.scaleBy(x: 1, y: -1)
        let previous = NSGraphicsContext.current
        NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: true)
        draw(context)
        NSGraphicsContext.current = previous
        return context.makeImage()
    }
}
