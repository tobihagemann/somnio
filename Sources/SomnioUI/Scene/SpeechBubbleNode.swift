import CoreGraphics
import Foundation
import SpriteKit

/// SpriteKit speech-bubble node that consumes already-wrapped lines (the wrapping step
/// is a separate font-driven helper). Stacks `SKLabelNode`s vertically at 150 px width
/// and fades out after `lifetime` seconds.
@MainActor final class SpeechBubbleNode: SKNode {
    static let bubbleWidth: CGFloat = 150
    static let lineHeight: CGFloat = 12

    init(lines: [String], lifetime: TimeInterval) {
        super.init()
        let capped = SpeechBubbleText.cap(lines: lines)
        for (index, text) in capped.enumerated() {
            let label = SKLabelNode(text: text)
            label.fontName = "Helvetica"
            label.fontSize = 10
            label.fontColor = .black
            label.horizontalAlignmentMode = .left
            label.verticalAlignmentMode = .top
            label.preferredMaxLayoutWidth = SpeechBubbleNode.bubbleWidth
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
