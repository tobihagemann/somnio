import AppKit
import CoreGraphics
import Foundation
import SomnioCore

/// Comic-balloon artwork for the speech bubble, reproducing the legacy `002-Balloon01`
/// geometry: a 150 px-wide white rounded body over a 10 px downward tail, framed at
/// `lines × 12 + 20` px (5 px body padding above and below the text block), with black
/// System-10 text. Lines arrive pre-wrapped by `SpeechBubbleText` (SomnioUI) against the
/// same `SomnioConstants` width and font metrics, so wrap and render cannot drift apart.
enum SpeechBubbleArt {
    static let widthPixels = CGFloat(SomnioConstants.speechBubbleWidthPixels)
    static let lineHeight: CGFloat = 12
    private static let tailHeight: CGFloat = 10
    private static let tailHalfBase: CGFloat = 7
    private static let bodyPadding: CGFloat = 5
    private static let cornerRadius: CGFloat = 8
    private static let fontSize = CGFloat(SomnioConstants.speechBubbleFontSize)

    struct Rendering {
        /// Full-bleed white artwork carrying the balloon outline and text; the silhouette lives
        /// in `opacityMask`, so edge filtering blends toward body white instead of a fringe color.
        let color: CGImage
        /// Grayscale balloon silhouette (body + tail) cutting the quad down to bubble shape.
        let opacityMask: CGImage
        /// Frame footprint in legacy pixels (tail included); the scene scales it into world meters.
        let sizePixels: CGSize
    }

    static func frameSize(lineCount: Int) -> CGSize {
        CGSize(
            width: widthPixels,
            height: CGFloat(max(lineCount, 1)) * lineHeight + tailHeight + 2 * bodyPadding
        )
    }

    static func render(lines: [String]) -> Rendering? {
        let size = frameSize(lineCount: lines.count)
        let balloon = balloonPath(frameSize: size)
        let color = OverlayRaster.colorImage(sizePixels: size) { context in
            context.setFillColor(NSColor.white.cgColor)
            context.fill(CGRect(origin: .zero, size: size))
            context.setStrokeColor(NSColor.black.cgColor)
            context.setLineWidth(1)
            context.addPath(balloon)
            context.strokePath()
            let font = NSFont.systemFont(ofSize: fontSize)
            for (index, line) in lines.enumerated() {
                let text = NSAttributedString(string: line, attributes: [.font: font, .foregroundColor: NSColor.black])
                text.draw(at: CGPoint(
                    x: (widthPixels - text.size().width) / 2,
                    y: bodyPadding + CGFloat(index) * lineHeight
                ))
            }
        }
        let mask = OverlayRaster.maskImage(sizePixels: size) { context in
            context.setFillColor(CGColor(gray: 0, alpha: 1))
            context.fill(CGRect(origin: .zero, size: size))
            // Fill + stroke so the mask reaches the outer half of the color pass's border
            // stroke — a fill-only mask would shave it to a half-pixel hairline.
            context.setFillColor(CGColor(gray: 1, alpha: 1))
            context.setStrokeColor(CGColor(gray: 1, alpha: 1))
            context.setLineWidth(1)
            context.addPath(balloon)
            context.drawPath(using: .fillStroke)
        }
        guard let color, let mask else { return nil }
        return Rendering(color: color, opacityMask: mask, sizePixels: size)
    }

    /// Rounded body + downward tail as one outline, inset half a stroke so the 1 px border
    /// survives the bitmap edge. The tail base tucks 2 px into the body so the union has no seam.
    private static func balloonPath(frameSize: CGSize) -> CGPath {
        let bodyHeight = frameSize.height - tailHeight
        let body = CGPath(
            roundedRect: CGRect(x: 0.5, y: 0.5, width: frameSize.width - 1, height: bodyHeight - 1),
            cornerWidth: cornerRadius, cornerHeight: cornerRadius, transform: nil
        )
        let centerX = frameSize.width / 2
        let tail = CGMutablePath()
        tail.move(to: CGPoint(x: centerX - tailHalfBase, y: bodyHeight - 2))
        tail.addLine(to: CGPoint(x: centerX, y: frameSize.height - 0.5))
        tail.addLine(to: CGPoint(x: centerX + tailHalfBase, y: bodyHeight - 2))
        tail.closeSubpath()
        return body.union(tail)
    }
}
