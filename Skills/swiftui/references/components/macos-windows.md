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

## Chromeless / custom-chrome windows: `windowStyle(.hiddenTitleBar)`

For a media-player-style or custom-chrome window (the fullscreen-first game player is the canonical case), hide the standard title bar with `.windowStyle(.hiddenTitleBar)`. The content then owns the full window; draw your own chrome/overlays on top.

```swift
WindowGroup {
    PlayerRootView()
}
.windowStyle(.hiddenTitleBar)          // no standard title bar / traffic-light strip chrome
.windowToolbarStyle(.unified)          // only relevant if you keep a toolbar
```

`.windowStyle(.titleBar)` is the default. `.hiddenTitleBar` is not macOS-only in the type system, but it is a macOS concept — gate cross-platform code with `#if os(macOS)`.

## Sizing and placement

Combine sizing modifiers on the scene; enforce minimums on the content:

```swift
WindowGroup {
    ContentView()
        .frame(minWidth: 600, minHeight: 400)
}
.defaultSize(width: 900, height: 600)
.defaultPosition(.center)              // initial on-screen position
.windowResizability(.contentMinSize)   // resizable, floored by content's minWidth/minHeight
```

| `windowResizability` | Behavior |
|----------------------|----------|
| `.automatic` | System decides |
| `.contentSize` | Fixed to content; no user resize; zoom disabled |
| `.contentMinSize` | Resizable; minimum from content's `minWidth`/`minHeight` |

`defaultPosition` accepts `.center`, `.topLeading`, `.top`, `.topTrailing`, `.leading`, `.trailing`, `.bottomLeading`, `.bottom`, `.bottomTrailing`.

For precise programmatic placement (macOS 15+), `windowIdealPlacement` gives a closure with display geometry:

```swift
.windowIdealPlacement { content, context in
    // Closure takes TWO params: the layout root and the placement context.
    let bounds = context.defaultDisplay.visibleRect            // visibleRect, not visibleArea
    let size = content.sizeThatFits(.init(width: nil, height: bounds.height))
    return .init(width: size.width, height: size.height)       // WindowPlacement by size
}
```

## Toolbar style (macOS)

`.windowToolbarStyle(_:)` sets how the toolbar and title bar combine:

| Style | Description |
|-------|-------------|
| `.automatic` | System default |
| `.unified` | Title bar and toolbar in one combined row |
| `.unifiedCompact` | Unified, reduced height |
| `.expanded` | Title bar above the toolbar (more toolbar space) |

Use `.unified(showsTitle: false)` to keep the unified bar but hide the title.

## `Window` vs `WindowGroup`, and `openWindow`

- **`WindowGroup`** — multiple instances, tabbing, automatic Window-menu commands; the app keeps running after all its windows close. Use it for the primary scene.
- **`Window`** (macOS 13+) — a single unique window; as the *sole* scene the app quits when it closes; it adds itself to the Windows menu. Reserve for supplementary singletons (an inspector, a "connection doctor").

`openWindow(id:)` **brings an already-open window to the front instead of duplicating it** — the key difference from opening a fresh instance:

```swift
@Environment(\.openWindow) private var openWindow
Button("Connection Doctor") { openWindow(id: "connection-doctor") }
```

## `UtilityWindow` for editor inspectors / tool palettes (macOS 15+)

`UtilityWindow` is a floating tool-palette / inspector scene — the right fit for the editor's inspector or model/floor palette. It:

- receives `FocusedValues` from the focused main window automatically (so its content updates for the active document/selection — see [focus-advanced.md](focus-advanced.md));
- floats above main windows and hides when the app is inactive;
- is Escape-dismissible and not minimizable by default;
- auto-adds a show/hide item to the View menu.

```swift
@main
struct EditorApp: App {
    var body: some Scene {
        WindowGroup { SectorEditor() }

        UtilityWindow("Sector Info", id: "sector-info") {
            SectorInspector()   // reads @FocusedValue from the focused editor window
        }
    }
}
```

Remove the automatic View-menu item with `.commandsRemoved()` and place a `WindowVisibilityToggle` elsewhere if you want custom placement. Gate `UtilityWindow` with `#if os(macOS)`.
