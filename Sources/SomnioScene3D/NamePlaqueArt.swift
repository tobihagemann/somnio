import AppKit
import CoreGraphics
import Foundation
import SomnioCore

/// Artwork for the name label under a player or NPC, mirroring the original's `namesprite`:
/// black System-11 text on a filled box with a 1 px black border — gray for players, cyan
/// for NPCs; monsters get none. The local player's text is bold.
enum NamePlaqueArt {
    static let playerBackground = NSColor(red: 221 / 255, green: 221 / 255, blue: 221 / 255, alpha: 1)
    static let npcBackground = NSColor(red: 204 / 255, green: 255 / 255, blue: 255 / 255, alpha: 1)
    private static let fontSize: CGFloat = 11

    struct Rendering {
        /// Opaque box artwork (the plaque is a plain rectangle, so no opacity mask is needed).
        let image: CGImage
        /// Box footprint in legacy pixels; the scene scales it into world meters.
        let sizePixels: CGSize
    }

    static func render(name: String, background: NSColor, bold: Bool) -> Rendering? {
        // Byte-clamp the wire-supplied name so a hostile server can't drive an enormous
        // supersampled bitmap (honest servers already bound nicknames at registration).
        let clamped = String(decoding: name.utf8.prefix(SomnioConstants.maxRenderedNameUTF8Bytes), as: UTF8.self)
        let font = NSFont.systemFont(ofSize: fontSize, weight: bold ? .bold : .regular)
        let text = NSAttributedString(string: clamped, attributes: [.font: font, .foregroundColor: NSColor.black])
        let textSize = text.size()
        let size = CGSize(
            width: max((textSize.width + 6).rounded(.up), 1),
            height: max((textSize.height + 4).rounded(.up), 1)
        )
        guard let image = OverlayRaster.colorImage(sizePixels: size, draw: { context in
            context.setFillColor(background.cgColor)
            context.fill(CGRect(origin: .zero, size: size))
            context.setStrokeColor(NSColor.black.cgColor)
            context.setLineWidth(1)
            context.stroke(CGRect(origin: .zero, size: size).insetBy(dx: 0.5, dy: 0.5))
            text.draw(at: CGPoint(x: (size.width - textSize.width) / 2, y: (size.height - textSize.height) / 2))
        }) else { return nil }
        return Rendering(image: image, sizePixels: size)
    }
}
