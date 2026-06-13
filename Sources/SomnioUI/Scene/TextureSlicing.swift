import CoreGraphics

/// Converts a top-left-origin pixel rect into the bottom-left-origin normalized UV rect
/// `SKTexture(rect:in:)` expects, flipping Y. Returns nil when the image is degenerate
/// or the rect escapes the image bounds.
func uvRect(forTopLeftPixelRect rect: CGRect, imageWidth: CGFloat, imageHeight: CGFloat) -> CGRect? {
    guard imageWidth > 0, imageHeight > 0,
          rect.minX >= 0, rect.minY >= 0,
          rect.maxX <= imageWidth, rect.maxY <= imageHeight
    else { return nil }
    return CGRect(
        x: rect.minX / imageWidth,
        y: (imageHeight - rect.minY - rect.height) / imageHeight,
        width: rect.width / imageWidth,
        height: rect.height / imageHeight
    )
}
