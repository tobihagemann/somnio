# Advanced focus: keyboard-driven views, menu commands, default focus (macOS)

## Intent

Focus beyond form fields: making non-text views focusable for keyboard play, seeding initial focus reliably, and wiring focused state into menu commands keyed to the active editor document or selection. For form-field chaining (`@FocusState` enum, `.onSubmit` field-to-field), see [focus.md](focus.md) first — this file is the macOS/game + editor superset.

## Make non-text views focusable

`TextField`/`SecureField` are implicitly focusable; custom views (stacks, shapes, the game surface) are not. `.focusable()` opts a view into the focus system so it can receive keyboard events via `onKeyPress` and menu commands like Edit > Delete via `onDeleteCommand`. This is the hook for the fullscreen player's key handling.

```swift
struct PlayerSurface: View {
    @FocusState private var isFocused: Bool

    var body: some View {
        WorldSceneView()
            .focusable()
            .focused($isFocused)
            .focusEffectDisabled()                 // suppress the system ring; game draws its own chrome
            .onKeyPress(.escape) { openGameMenu(); return .handled }
            .onKeyPress(characters: .init(charactersIn: "wasd")) { press in
                move(press.characters); return .handled
            }
            .onDeleteCommand { /* Edit > Delete */ }
            .defaultFocus($isFocused, true)        // seed focus on appearance (see below)
    }
}
```

### `.focusable(interactions:)`

Controls which focus-driven interactions the view supports:

- `.activate` — button-like: focusable only when system keyboard navigation is on. Use for custom button-like views that should match system behavior.
- `.edit` — captures keyboard input (text-entry-like custom views).
- `.automatic` — platform default (both).

```swift
CustomButtonView(...)
    .focusable(interactions: .activate)
```

## Seed initial focus with `.defaultFocus` — not `.onAppear`

**`.defaultFocus($field, value)` is the reliable way to place initial focus.** This corrects the older `.onAppear { field = ... }` approach: setting `@FocusState` in `.onAppear` can fail if the view tree hasn't settled, which is why that pattern often needs a fragile `DispatchQueue.main.async` delay. Prefer `.defaultFocus`.

```swift
enum Field: Hashable { case name, email }
@FocusState private var focusedField: Field?

VStack {
    TextField("Name", text: $name).focused($focusedField, equals: .name)
    TextField("Email", text: $email).focused($focusedField, equals: .email)
}
.defaultFocus($focusedField, .email)
```

Priority: `.automatic` (default) applies on window appearance and programmatic focus changes; `.userInitiated` also applies during user-driven focus navigation. On macOS, `.focusScope(_:)` + `prefersDefaultFocus(_:in:)` scope default focus to a namespace, and the `\.resetFocus` environment action re-evaluates it.

## Focused values for context-sensitive menu commands

Focused values let the App/Scene/`Commands` read state from whichever view currently has focus — the standard way to enable or disable menu commands based on the active editor document or selection. Declare with `@Entry` on `FocusedValues`, publish from the focused view, consume with `@FocusedValue` / `@FocusedBinding`.

```swift
// Declare
extension FocusedValues {
    @Entry var activeSector: Binding<SectorDocument>?
}

// Publish — scene-scoped: available while this document window has focus
ContentView()
    .focusedSceneValue(\.activeSector, $document)

// Consume in commands
@main
struct EditorApp: App {
    @FocusedBinding(\.activeSector) private var sector

    var body: some Scene {
        DocumentGroup(newDocument: SectorDocument()) { config in
            SectorEditor(document: config.$document)
        }
        .commands {
            CommandGroup(after: .pasteboard) {
                Button("Duplicate Selection") { sector?.duplicateSelection() }
                    .disabled(sector == nil)
            }
        }
    }
}
```

Use `.focusedValue(_:_:)` for view-scoped values (available when that view or a descendant has focus) and `.focusedSceneValue(_:_:)` for scene-scoped values (available while the whole scene has focus). A floating `UtilityWindow` inspector/palette reads these automatically from the focused main window — see [macos-windows.md](macos-windows.md).

## The `isFocused` environment value

Read-only; `true` when the nearest focusable ancestor has focus. Useful for styling a non-focusable child of a `.focusable()` wrapper.

```swift
struct HighlightWrapper: View {
    @Environment(\.isFocused) private var isFocused
    var body: some View {
        content.background(isFocused ? Color.accentColor.opacity(0.1) : .clear)
    }
}
```

## `.focusSection()` for directional navigation (macOS)

Guides directional/sequential focus through spatially separated focusable views that arrow-key navigation would otherwise skip. Apply to a group so it receives directional focus and forwards it to its first focusable child.

```swift
HStack {
    VStack { Button("1") {}; Button("2") {}; Spacer() }
    Spacer()
    VStack { Spacer(); Button("A") {}; Button("B") {} }
        .focusSection()   // without this, arrowing right finds nothing
}
```

## Pitfalls

- **Redundant `@FocusState` writes revoke focus.** `.focusable()` + `.focused()` already handles focus-on-click. Adding a tap gesture that *also* writes `@FocusState` (e.g. `.onTapGesture { isFocused = true }`) triggers a redundant state write and a second body evaluation that *revokes* focus — focus flickers on then off, and key commands like `onDeleteCommand` stop firing. Remove the redundant write and let `.focusable()` + `.focused()` do the work.
- **Ambiguous bindings.** Binding the same enum case to two views is ambiguous; SwiftUI picks the first and warns at runtime. Use a distinct case per focusable view.
- **Missing `.focusable()`.** On a non-text view, forgetting `.focusable()` means `.focused()` bindings do nothing and key handlers never fire.
- **Focus state is view-local.** Don't store `@FocusState` in shared objects; mark it `private`. Avoid aggressive focus changes mid-animation.
