import AppKit
import SomnioCore
import SwiftUI

/// Transparent overlay that tracks the cursor over the play field and reports the resulting
/// continuous heading. The heading is computed relative to this view's own bounds center, so
/// it stays correct regardless of where the play field sits in the window.
struct MouseFacingTrackingView: NSViewRepresentable {
    let onFacing: (Heading) -> Void

    func makeNSView(context _: Context) -> TrackingNSView {
        let view = TrackingNSView()
        view.onFacing = onFacing
        return view
    }

    func updateNSView(_ nsView: TrackingNSView, context _: Context) {
        nsView.onFacing = onFacing
    }
}

/// `NSView` whose `NSTrackingArea` follows its visible rect, emitting a `Heading` for every
/// cursor move. The default (non-flipped) `NSView` coordinate space is Y-up, matching
/// `MouseFacingSampler`'s expected input, so the cursor point and bounds center feed the
/// sampler directly. Wire-rate suppression lives in `ClientViewModel`'s emit threshold, not
/// here — every move reports, and the render-side yaw slew smooths the result.
final class TrackingNSView: NSView {
    var onFacing: ((Heading) -> Void)?
    private var facingTrackingArea: NSTrackingArea?

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let facingTrackingArea {
            removeTrackingArea(facingTrackingArea)
        }
        let area = NSTrackingArea(
            rect: bounds,
            options: [.activeInKeyWindow, .mouseMoved, .inVisibleRect],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(area)
        facingTrackingArea = area
        seedFacingFromCurrentLocation()
    }

    override func mouseMoved(with event: NSEvent) {
        emitFacing(at: convert(event.locationInWindow, from: nil))
    }

    /// Emit the cursor's current facing without waiting for a `mouseMoved`: if the pointer already
    /// sits over the play field when the tracking area installs (gameplay start, sector hop), the
    /// player faces the cursor immediately instead of holding the prior facing until the next move.
    private func seedFacingFromCurrentLocation() {
        guard let window else { return }
        let point = convert(window.mouseLocationOutsideOfEventStream, from: nil)
        guard bounds.contains(point) else { return }
        emitFacing(at: point)
    }

    private func emitFacing(at point: CGPoint) {
        let center = CGPoint(x: bounds.midX, y: bounds.midY)
        onFacing?(MouseFacingSampler.heading(mouseLocation: point, viewCenter: center))
    }
}
