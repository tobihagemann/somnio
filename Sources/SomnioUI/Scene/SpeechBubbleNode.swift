import AppKit
import CoreGraphics
import Foundation
import SpriteKit

/// SpriteKit speech-bubble node that consumes already-wrapped lines (the wrapping step
/// is a separate font-driven helper). Stacks `SKLabelNode`s vertically at `SpeechBubbleText`'s
/// bubble width over the optional `002-Balloon01` template and fades out after `lifetime` seconds.
@MainActor final class SpeechBubbleNode: SKNode {
    static let lineHeight: CGFloat = 12
    /// Legacy balloon sheet width (`002-Balloon01.png` is 150 x 200). The sheet stacks four
    /// vertical frames sized `lines x 12 + 20` px tall — `sprechblasenpics.Append NewPicture(150,
    /// i*12+20)` (`Somnio.txt` decoded :461-465).
    static let balloonSheetWidth: CGFloat = 150
    /// The node's origin sits at the balloon's downward tail tip so the scene can pin it just above
    /// the speaker's head. Measured in `002-Balloon01`: tip at x = 74.5 (the 150 px frame's center),
    /// tail = the bottom 10 px of every frame, so the rounded-rect body is the top `height - 10`.
    private static let tailTipX: CGFloat = 74.5
    /// Vertical inset between the body's top/bottom edges and the text block; the frame's `+20`
    /// chrome is the tail (10) plus this split top and bottom (5 each).
    private static let bodyPadding: CGFloat = 5

    init(lines: [String], lifetime: TimeInterval, template: SKTexture? = nil) {
        let capped = SpeechBubbleText.cap(lines: lines)
        let frame = SpeechBubbleNode.balloonFrameRect(lineCount: capped.count)
        super.init()
        // Balloon template behind the text. Graceful nil-fallback to a plain text stack when no
        // asset pack is present. Slices the frame matching the line count out of the stacked sheet
        // (the original indexes `sprechblasenpics(lines)`) and draws it at native size — no stretch.
        // Anchored at the tail tip (bottom-center) so the balloon rises centered above the origin.
        if let template, !capped.isEmpty {
            let balloon = SKSpriteNode(
                texture: SpeechBubbleNode.frameTexture(from: template, frame: frame),
                size: frame.size
            )
            balloon.anchorPoint = CGPoint(x: SpeechBubbleNode.tailTipX / frame.width, y: 0)
            balloon.position = .zero
            // Keep the balloon at the labels' zPosition (drawn behind them via add order, since it
            // is added first) rather than lifting the labels above it. A z gap here would let this
            // bubble's text leapfrog a neighbouring bubble's balloon when two speakers sit at
            // near-equal screen-Y (their entity-node z differs by < 1), bleeding text across it.
            addChild(balloon)
        }
        // Text centered horizontally over the tail and centered vertically in the rounded-rect body
        // (above the tail), stacked downward from the body's top edge.
        let firstLineTop = frame.height - SpeechBubbleNode.bodyPadding
        for (index, text) in capped.enumerated() {
            let label = SKLabelNode()
            label.attributedText = NSAttributedString(
                string: text,
                attributes: [
                    .font: NSFont.systemFont(ofSize: SpeechBubbleText.fontSize),
                    .foregroundColor: NSColor.black
                ]
            )
            label.horizontalAlignmentMode = .center
            label.verticalAlignmentMode = .top
            label.position = CGPoint(x: 0, y: firstLineTop - CGFloat(index) * SpeechBubbleNode.lineHeight)
            addChild(label)
        }
        run(SKAction.sequence([
            .wait(forDuration: lifetime),
            .fadeOut(withDuration: 0.25),
            .removeFromParent()
        ]))
    }

    /// Top-left pixel sub-rect of the stacked balloon sheet for a capped line count (1...4). Frame
    /// heights are `lines x 12 + 20`; each frame's Y offset is the sum of the heights above it
    /// (offsets 0/32/76/132 for heights 32/44/56/68, summing to the sheet's 200 px).
    static func balloonFrameRect(lineCount: Int) -> CGRect {
        let lines = max(1, min(lineCount, 4))
        var offsetY: CGFloat = 0
        for priorLines in 1 ..< lines {
            offsetY += CGFloat(priorLines) * lineHeight + 20
        }
        let height = CGFloat(lines) * lineHeight + 20
        return CGRect(x: 0, y: offsetY, width: balloonSheetWidth, height: height)
    }

    /// Slices `frame` (top-left pixels) out of the whole balloon sheet as a UV sub-rect texture,
    /// delegating the top-left-pixel-to-bottom-left-UV flip to `uvRect`. Falls back to the whole
    /// sheet if its size is unknown.
    private static func frameTexture(from sheet: SKTexture, frame: CGRect) -> SKTexture {
        let size = sheet.size()
        guard let uv = uvRect(forTopLeftPixelRect: frame, imageWidth: size.width, imageHeight: size.height) else {
            return sheet
        }
        let sliced = SKTexture(rect: uv, in: sheet)
        // Nearest sampling so the slice's bottom edge doesn't linearly blend in the next stacked
        // frame's black top border (a thin dark line). The balloon is pixel art drawn at native
        // size, so nearest is the correct filter regardless.
        sliced.filteringMode = .nearest
        return sliced
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("SpeechBubbleNode must be created with init(lines:lifetime:)")
    }
}
