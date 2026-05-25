import AppKit
import CoreGraphics
import Foundation
import SpriteKit

/// SpriteKit speech-bubble node that consumes already-wrapped lines (the wrapping step
/// is a separate font-driven helper). Stacks `SKLabelNode`s vertically at `SpeechBubbleText`'s
/// bubble width over the optional `002-Balloon01` template and fades out after `lifetime` seconds.
@MainActor final class SpeechBubbleNode: SKNode {
    static let lineHeight: CGFloat = 12

    init(lines: [String], lifetime: TimeInterval, template: SKTexture? = nil) {
        super.init()
        let capped = SpeechBubbleText.cap(lines: lines)
        // Balloon template behind the text. Graceful nil-fallback to a plain text stack when no
        // asset pack is present. Sized to the bubble width by line count, like the original
        // `sprechblasenpics`.
        if let template, !capped.isEmpty {
            let height = CGFloat(capped.count) * SpeechBubbleNode.lineHeight + 20
            let balloon = SKSpriteNode(
                texture: template,
                size: CGSize(width: SpeechBubbleText.bubbleWidth, height: height)
            )
            balloon.anchorPoint = CGPoint(x: 0, y: 1)
            balloon.position = CGPoint(x: -4, y: 8)
            balloon.zPosition = -1
            addChild(balloon)
        }
        for (index, text) in capped.enumerated() {
            let label = SKLabelNode()
            label.attributedText = NSAttributedString(
                string: text,
                attributes: [
                    .font: NSFont.systemFont(ofSize: SpeechBubbleText.fontSize),
                    .foregroundColor: NSColor.black
                ]
            )
            label.horizontalAlignmentMode = .left
            label.verticalAlignmentMode = .top
            label.position = CGPoint(x: 0, y: -CGFloat(index) * SpeechBubbleNode.lineHeight)
            addChild(label)
        }
        run(SKAction.sequence([
            .wait(forDuration: lifetime),
            .fadeOut(withDuration: 0.25),
            .removeFromParent()
        ]))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("SpeechBubbleNode must be created with init(lines:lifetime:)")
    }
}
