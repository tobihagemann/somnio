import AppKit
import SomnioCore
import SwiftUI

/// Window bridge for the fullscreen-first launch policy plus the app-wide Esc owner.
/// SwiftUI on macOS 15 has no launch-into-fullscreen API (`windowFullScreenBehavior` only
/// enables/disables the capability), so an `NSViewRepresentable` grabs the `NSWindow` on
/// first attach: it registers the windowed-frame autosave, enters fullscreen when the
/// persisted launch flag says so (default true when unset — first launch is fullscreen),
/// and keeps that flag in sync via the enter/exit notifications, so quitting windowed
/// relaunches windowed.
///
/// The Esc monitor lives here (not in `KeyboardSampler`, whose monitor only runs with the
/// gameplay ticker post-attach) because the login/registration/update overlays present
/// pre-attach and their Esc handling must already work. It consumes every Esc for this
/// window — macOS's default Esc-exits-fullscreen never fires — and routes the key to
/// `onEscape` for the view model's state table.
struct WindowConfigurator: NSViewRepresentable {
    let onEscape: () -> Void

    func makeNSView(context _: Context) -> ConfiguratorView {
        let view = ConfiguratorView()
        view.onEscape = onEscape
        return view
    }

    func updateNSView(_ nsView: ConfiguratorView, context _: Context) {
        nsView.onEscape = onEscape
    }

    @MainActor final class ConfiguratorView: NSView {
        var onEscape: (() -> Void)?
        private var configured = false
        private var keyMonitor: Any?
        private var fullscreenObservers: [NSObjectProtocol] = []

        private static let escapeKeyCode: UInt16 = 53
        private static let frameAutosaveName = "SomnioMainWindow"
        private nonisolated static let launchFullscreenKey = "launchFullscreen"

        /// Defaults to `true` when the key was never written (first launch is fullscreen);
        /// `bool(forKey:)` alone would read a missing key as `false`.
        private nonisolated static var launchFullscreen: Bool {
            let defaults = UserDefaults(suiteName: BuildEnvironment.userDefaultsSuiteName) ?? .standard
            guard defaults.object(forKey: launchFullscreenKey) != nil else { return true }
            return defaults.bool(forKey: launchFullscreenKey)
        }

        private nonisolated static func persistLaunchFullscreen(_ value: Bool) {
            let defaults = UserDefaults(suiteName: BuildEnvironment.userDefaultsSuiteName) ?? .standard
            defaults.set(value, forKey: launchFullscreenKey)
        }

        /// Installs on joining a window and tears down on leaving it — the strict-concurrency
        /// substitute for a deinit removal (a nonisolated deinit cannot touch the monitor
        /// token), and the view always leaves the window before deallocation.
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            teardown()
            guard let window else { return }
            keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard let self, event.keyCode == Self.escapeKeyCode, event.window === self.window else { return event }
                onEscape?()
                return nil
            }
            fullscreenObservers = [
                NotificationCenter.default.addObserver(
                    forName: NSWindow.didEnterFullScreenNotification, object: window, queue: .main
                ) { _ in
                    Self.persistLaunchFullscreen(true)
                },
                NotificationCenter.default.addObserver(
                    forName: NSWindow.didExitFullScreenNotification, object: window, queue: .main
                ) { _ in
                    Self.persistLaunchFullscreen(false)
                }
            ]
            guard !configured else { return }
            configured = true
            window.setFrameAutosaveName(Self.frameAutosaveName)
            if Self.launchFullscreen {
                // Deferred a runloop turn: toggling inside the attach callback races the
                // window's own presentation and can silently no-op. The style-mask check
                // runs inside the deferral — checked earlier, a window that entered
                // fullscreen in the gap (e.g. via state restoration) would be toggled
                // back OUT.
                Task { @MainActor [weak window] in
                    guard let window, !window.styleMask.contains(.fullScreen) else { return }
                    window.toggleFullScreen(nil)
                }
            }
        }

        private func teardown() {
            if let keyMonitor {
                NSEvent.removeMonitor(keyMonitor)
                self.keyMonitor = nil
            }
            for observer in fullscreenObservers {
                NotificationCenter.default.removeObserver(observer)
            }
            fullscreenObservers = []
        }
    }
}
