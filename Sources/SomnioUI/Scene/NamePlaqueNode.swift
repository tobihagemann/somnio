import AppKit
import CoreGraphics
import Foundation
import SpriteKit

/// Name label rendered under a player or NPC sprite, mirroring the original's `namesprite`: black
/// System-11 text on a filled box with a black 1px border (gray for players, cyan for NPCs;
/// monsters get none). The local player's text is bold. Built with a top-center origin so the
/// box hangs below its position, letting the caller pin it 1px under the sprite's feet without
/// knowing the box height.
@MainActor final class NamePlaqueNode: SKNode {
    init(name: String, background: SKColor, bold: Bool) {
        super.init()
        let font = NSFont.systemFont(ofSize: 11, weight: bold ? .bold : .regular)
        let label = SKLabelNode()
        label.attributedText = NSAttributedString(
            string: name,
            attributes: [.font: font, .foregroundColor: NSColor.black]
        )
        label.horizontalAlignmentMode = .center
        label.verticalAlignmentMode = .center
        let textSize = label.frame.size
        let boxWidth = max(textSize.width + 6, 1)
        let boxHeight = max(textSize.height + 4, 1)
        let box = SKShapeNode(rect: CGRect(x: -boxWidth / 2, y: -boxHeight, width: boxWidth, height: boxHeight))
        box.fillColor = background
        box.strokeColor = .black
        box.lineWidth = 1
        addChild(box)
        label.position = CGPoint(x: 0, y: -boxHeight / 2)
        // Keep the label at the box's zPosition (drawn above it via add order) rather than lifting
        // it. A local z above the box would let this label leapfrog a neighbouring plate's box when
        // two entities sit at near-equal screen-Y (their entity-node z differs by < 1), so the rear
        // plate's text would render over the front plate's box without its own box behind it.
        addChild(label)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("NamePlaqueNode must be created with init(name:background:bold:)")
    }
}
