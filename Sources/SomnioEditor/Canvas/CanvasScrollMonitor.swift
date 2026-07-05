import AppKit
import SwiftUI

/// Scroll-wheel bridge for the 3D canvas. SwiftUI exposes no scroll-wheel events on macOS
/// and the `RealityView` swallows none, so a local `NSEvent` monitor watches the window's
/// scroll stream and forwards events whose cursor sits over this view — without joining the
/// hit-test path, so taps and hover tracking on the sibling overlay stay untouched.
struct CanvasScrollMonitor: NSViewRepresentable {
    /// Called with the scroll event; the monitor swallows events it forwards so the window
    /// doesn't also rubber-band an enclosing scroll view.
    let onScroll: (NSEvent) -> Void

    func makeNSView(context _: Context) -> ScrollMonitorView {
        let view = ScrollMonitorView()
        view.onScroll = onScroll
        return view
    }

    func updateNSView(_ nsView: ScrollMonitorView, context _: Context) {
        nsView.onScroll = onScroll
    }

    @MainActor final class ScrollMonitorView: NSView {
        var onScroll: ((NSEvent) -> Void)?
        private var monitor: Any?

        /// Installs on joining a window and tears down on leaving it — the strict-concurrency
        /// substitute for a deinit removal (a nonisolated deinit cannot touch the monitor
        /// token), and the view always leaves the window before deallocation.
        override func viewDidMoveToWindow() {
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
                onScroll?(event)
                return nil
            }
        }

        override func hitTest(_: NSPoint) -> NSView? {
            nil
        }
    }
}
