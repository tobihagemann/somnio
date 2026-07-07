# macOS window management

## Intent

Configure macOS window sizing, resizability, and fullscreen behavior from a SwiftUI scene, including launching into fullscreen.

## Core patterns

- Set the windowed default with `.defaultSize(width:height:)` on the scene; enforce a minimum via `.windowResizability(.contentMinSize)` plus `.frame(minWidth:minHeight:)` on the content.
- Persist the windowed frame across launches with `NSWindow.setFrameAutosaveName(_:)`.
- `.windowFullScreenBehavior(_:)` (macOS 15+) only enables or disables the fullscreen *capability* — it cannot enter fullscreen. `.defaultLaunchBehavior(_:)` controls scene presentation, not fullscreen either.
- There is no SwiftUI API to launch into fullscreen. Bridge to AppKit: grab the `NSWindow` via an `NSViewRepresentable` window accessor (`viewDidMoveToWindow`) and call `window.toggleFullScreen(nil)` on first attach.
- To remember fullscreen state across launches, observe `NSWindow.didEnterFullScreenNotification` / `didExitFullScreenNotification`, persist a flag to `UserDefaults`, and only call `toggleFullScreen` at launch when the flag is set.

## Example: fullscreen-at-launch accessor

```swift
struct WindowConfigurator: NSViewRepresentable {
    func makeNSView(context: Context) -> ConfiguratorView { ConfiguratorView() }
    func updateNSView(_ nsView: ConfiguratorView, context: Context) {}

    final class ConfiguratorView: NSView {
        private var configured = false

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            guard let window, !configured else { return }
            configured = true
            window.setFrameAutosaveName("main")
            if UserDefaults.standard.object(forKey: "launchFullscreen") as? Bool ?? true {
                window.toggleFullScreen(nil)
            }
        }
    }
}
```

## Pitfalls

- `UserDefaults.bool(forKey:)` returns `false` for a missing key — guard with `object(forKey:) != nil` when the default should be `true`.
- macOS exits fullscreen on Esc by default; consume the key event (local `NSEvent` monitor) if the app handles Esc itself.
- `toggleFullScreen` on a window that is already fullscreen exits it — gate the launch call on the window's current `styleMask.contains(.fullScreen)` when re-entrancy is possible.
