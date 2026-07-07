import AppKit
import SwiftUI

/// Scroll-wheel bridge for the 3D viewport, shared by the editor canvas and the player's
/// zoom. SwiftUI exposes no scroll-wheel events on macOS and the `RealityView` swallows
/// none, so a local `NSEvent` monitor watches the window's scroll stream and forwards
/// events whose cursor sits over this view — without joining the hit-test path, so taps
/// and hover tracking on sibling overlays stay untouched.
public struct CanvasScrollMonitor: NSViewRepresentable {
    /// Called with the scroll event; returns whether it was consumed. The monitor swallows
    /// consumed events (so the window doesn't also rubber-band an enclosing scroll view)
    /// and returns the rest to the responder chain — a handler declining an event over a
    /// floating panel lets the panel's own scroll view receive it.
    public let onScroll: (NSEvent) -> Bool

    public init(onScroll: @escaping (NSEvent) -> Bool) {
        self.onScroll = onScroll
    }

    public func makeNSView(context _: Context) -> ScrollMonitorView {
        let view = ScrollMonitorView()
        view.onScroll = onScroll
        return view
    }

    public func updateNSView(_ nsView: ScrollMonitorView, context _: Context) {
        nsView.onScroll = onScroll
    }

    @MainActor public final class ScrollMonitorView: NSView {
        var onScroll: ((NSEvent) -> Bool)?
        private var monitor: Any?

        /// Installs on joining a window and tears down on leaving it — the strict-concurrency
        /// substitute for a deinit removal (a nonisolated deinit cannot touch the monitor
        /// token), and the view always leaves the window before deallocation.
        override public func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let monitor {
                NSEvent.removeMonitor(monitor)
                self.monitor = nil
            }
            guard window != nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
                guard let self, event.window === self.window else { return event }
                let local = convert(event.locationInWindow, from: nil)
                guard bounds.contains(local) else { return event }
                return onScroll?(event) == true ? nil : event
            }
        }

        override public func hitTest(_: NSPoint) -> NSView? {
            nil
        }
    }
}
