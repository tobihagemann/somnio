# SwiftUI Localization Reference (Somnio)

Guidance for user-facing text: `Text`, `Button`, `Label`, navigation/toolbar titles, alerts, and types that carry localizable strings. For the narrower "verbatim vs localized" decision on a single `Text`, see [text-formatting.md](text-formatting.md).

## Somnio's rule: always pin the bundle

**Somnio's String Catalogs (`.xcstrings`) ship as SwiftPM `.process` resources, which live in `Bundle.module` — not `Bundle.main`.** The bare `Text("key")` / `NSLocalizedString("key")` overloads look up strings in the *main* bundle, so they **silently miss the catalog** and render the raw key. Always pin the bundle:

```swift
// AVOID: bare overloads miss the SwiftPM .process catalog
Text("start_game")
NSLocalizedString("start_game", comment: "")

// PREFER (SwiftUI views): pin Bundle.module
Text("start_game", bundle: .module)

// PREFER (Foundation / non-view paths): pin Bundle.module
String(localized: "start_game", bundle: .module)
```

**Use the per-target `enum L` shim** (mirroring `Sources/SomnioCLICore/Localization.swift`) so bundle pinning lives in one place per target — `SomnioUI`, the player client, and the editor each have their own. The UI shim's `L.resource(_:)` returns a `LocalizedStringResource` pinned to `Bundle.module` for SwiftUI surfaces that need that type (`.help`, custom-view title parameters). Every new user-facing string must be added both to the target's `.xcstrings` catalog and to its `expectedKeys` allowlist (the catalog test only checks allowlisted keys).

> This is the opposite of the generic SwiftUI advice "pass literals directly and don't wrap them" — that advice assumes an app main bundle. It does **not** hold for this project's SwiftPM library modules.

## `#bundle` macro (Swift 6.2 / Xcode 26+)

`#bundle` resolves to the current target's resource bundle and is the modern alternative to `Bundle.module` — either works; `Bundle.module` remains correct and is what the existing `enum L` shims use. It requires the Swift 6.2 / Xcode 26+ toolchain to compile and back-deploys at runtime to macOS 12+ (iOS 15+).

```swift
Text("save_to_favorites", bundle: #bundle, comment: "Button to bookmark a sector.")
```

## Route to a specific catalog with `tableName:`

When a target has more than one `.xcstrings`, `tableName:` selects which one to look up (alongside `bundle:`):

```swift
Text("explore", tableName: "Navigation", bundle: .module,
     comment: "Tab bar item title for the Explore screen.")
```

## Interpolation, never concatenation

String interpolation preserves the localization key and produces a reorderable format string in the catalog (e.g. `"Welcome, %@"`). Concatenating with `+` produces a plain `String` that isn't localized **and** freezes word order — which varies across languages. Never assemble a sentence from separately localized fragments.

```swift
// AVOID: + produces String; fragment assembly breaks word order
Text("Error: " + statusMessage, bundle: .module)

// PREFER: one interpolated string translators can rearrange
Text("Error: \(statusMessage)", bundle: .module)
```

## Bake casing into the string

Don't transform case at runtime via `.textCase(_:)` / `.localizedUppercase` / `.localizedCapitalized` on localized text — it forces the same casing on every translation and leaves translators no room to adjust per language. Bake the desired case into the catalog value instead. (Display *user-entered* text as-is; if a transform is truly unavoidable, prefer the `.localized*` variants that honor the locale.)

```swift
// AVOID
Text("section_header", bundle: .module).textCase(.uppercase)
// PREFER: store the uppercased form as the string value
Text("section_header", bundle: .module)
```

## Locale-aware formatting

- Use `Text`'s `format:` / `.formatted()` instead of `DateFormatter`/`NumberFormatter` with hardcoded format strings — format styles adapt to the locale; hardcoded patterns don't.
- For lists, `Array.formatted()` inserts locale-correct separators and conjunctions instead of `joined(separator:)`.
- Read `@Environment(\.locale)` for locale-dependent logic in views, not `Locale.current` — the environment respects preview overrides and per-view injection.

```swift
Text(product.price, format: .currency(code: store.currencyCode))
Text(playerNames.formatted())   // "Alice, Bob, and Carol" — locale-correct
```

## `LocalizedStringResource` for non-view / model types

When a model, notification, or other non-view type carries user-facing text, type it as `LocalizedStringResource` (resolved to `Bundle.module` where needed), not `String`. It defers resolution to display time, honoring the locale active when the value actually renders. For custom views that accept a "localized title" parameter, prefer `LocalizedStringResource` so resolution stays with the consumer's bundle.

```swift
// AVOID: resolved at creation, can't re-render in another locale
struct Tip { let headline: String }

// PREFER: resolution deferred to display time
struct Tip { let headline: LocalizedStringResource }
```

Apply this when designing new types — don't sweep existing `String` properties as part of unrelated edits.

## Comments for translators

Add a `comment:` describing the UI element and, for interpolated strings, each placeholder by position — translators don't see Swift variable names.

```swift
Text("Completed \(count) of \(total)", bundle: .module,
     comment: "Progress label — first placeholder is finished items, second is the total.")
```

## Checklist

- [ ] Every user-facing string pins `bundle: .module` (or `#bundle`) — never a bare `Text("key")` / `NSLocalizedString`
- [ ] String goes through the per-target `enum L` shim, and is added to both the `.xcstrings` catalog and the target's `expectedKeys` allowlist
- [ ] Interpolation (not `+`) for dynamic strings; no sentence assembly from fragments
- [ ] Case baked into the catalog value, not applied via `.textCase`
- [ ] Dates/numbers/currencies/lists use `format:` / `.formatted()`; `@Environment(\.locale)` for locale logic
- [ ] Non-view/model text typed as `LocalizedStringResource`, not `String`
- [ ] `comment:` provided for ambiguous strings and interpolated placeholders
- [ ] ASCII throughout (project convention: ASCII `...`, not the Unicode ellipsis)
