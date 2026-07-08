# SwiftUI List Patterns Reference

## ForEach Identity and Stability

**Always provide stable identity for `ForEach`.** Never use `.indices` for dynamic content.

```swift
// Good - stable identity via Identifiable
extension User: Identifiable {
    var id: String { userId }
}

ForEach(users) { user in
    UserRow(user: user)
}

// Good - stable identity via keypath
ForEach(users, id: \.userId) { user in
    UserRow(user: user)
}

// Wrong - indices create static content
ForEach(users.indices, id: \.self) { index in
    UserRow(user: users[index])  // Can crash on removal!
}

// Wrong - unstable identity
ForEach(users, id: \.self) { user in
    UserRow(user: user)  // Only works if User is Hashable and stable
}
```

**Critical**: Ensure **constant number of views per element** in `ForEach`:

```swift
// Good - consistent view count
ForEach(items) { item in
    ItemRow(item: item)
}

// Bad - variable view count breaks identity
ForEach(items) { item in
    if item.isSpecial {
        SpecialRow(item: item)
        DetailRow(item: item)
    } else {
        RegularRow(item: item)
    }
}
```

**Avoid inline filtering:**

```swift
// Bad - unstable identity, changes on every update
ForEach(items.filter { $0.isEnabled }) { item in
    ItemRow(item: item)
}

// Good - prefilter and cache
@State private var enabledItems: [Item] = []

var body: some View {
    ForEach(enabledItems) { item in
        ItemRow(item: item)
    }
    .onChange(of: items) { _, newItems in
        enabledItems = newItems.filter { $0.isEnabled }
    }
}
```

**Avoid `AnyView` in list rows:**

```swift
// Bad - hides identity, increases cost
ForEach(items) { item in
    AnyView(item.isSpecial ? SpecialRow(item: item) : RegularRow(item: item))
}

// Good - Create a unified row view with a single top-level container
ForEach(items) { item in
    ItemRow(item: item)
}

struct ItemRow: View {
    let item: Item

    var body: some View {
        // The VStack keeps the row "unary" (one top-level view) so the
        // List can template row ids without evaluating every row's body.
        VStack {
            if item.isSpecial {
                SpecialRow(item: item)
            } else {
                RegularRow(item: item)
            }
        }
    }
}
```

**Why**: Stable identity is critical for performance and animations. Unstable identity causes excessive diffing, broken animations, and potential crashes.

### Prefer unary rows in `List`

`List` needs the identity of every row up front. When each row's body produces a **single top-level view** (a "unary" row), SwiftUI templates the row id from the `ForEach` element's id alone, without running each row's `body`. When the body branches between different top-level shapes — a bare top-level `switch`, a top-level `if` without `else`, or an `AnyView` — structural identity varies per row, so SwiftUI falls back to evaluating every row's body just to compute ids. That cost scales with the number of rows.

The fix is to wrap branching content in any single-root container (`VStack`, `HStack`, `ZStack`, or a custom wrapper) so the row is always exactly one top-level view — as the `ItemRow` above already does. A top-level `if` without an `else` is also "multi" (0 or 1 views); if some elements shouldn't be rows at all, filter the collection before it reaches the `ForEach` rather than producing a zero-view row.

To find non-constant row builders in an existing app, launch with `-LogForEachSlowPath YES`; SwiftUI logs each `ForEach` inside a lazy container whose row body produces a non-constant number of views.

### Keep ids stable, unique, and cheap

- **The id must outlive the view and not change on edit.** Don't derive `id` from a mutable property (e.g. `var id: String { title }`). Editing the title changes the id, so SwiftUI treats it as a removal plus insertion — focus and per-row state are lost mid-edit. Use a stable `let id: UUID` or a persisted key (e.g. a sector filename id).
- **Don't synthesize a fresh id inside `body`.** `ForEach(items.map { Item(title: $0) })` mints new `UUID`s on every body pass, so the whole collection reads as replaced every update. Create ids once in storage that outlives `body` (the model layer), not inline.
- **Keep the id cheap to hash.** Avoid `id: \.self` on a large `Hashable` struct; hashing walks every field on every diff. Use a small primitive (`UUID`, `Int`, short `String`, `URL`) and still pass the full element to the row.

## Enumerated Sequences

**Using `.enumerated()` is fine; the index just must not be the identity.** Using `\.offset` as the id is the same anti-pattern as `\.self` on `items.indices` — the id becomes the position, not the element, so inserts and reorders reset row state and break animations. Keep the element's own identity as the id and treat the index as ordinary row data.

```swift
// Wrong - offset is the position, not the element
ForEach(items.enumerated(), id: \.offset) { index, item in
    ItemRow(number: index + 1, item: item)
}

// Correct - id comes from the element; index is just data
ForEach(items.enumerated(), id: \.element.id) { index, item in
    ItemRow(number: index + 1, item: item)
}
```

**Whether you need the `Array(...)` wrapper depends on the deployment target, not just the compiler.** SE-0459 gives `.enumerated()` a conditional `RandomAccessCollection` conformance (so `ForEach` accepts it directly), but that conformance is `@available(SwiftStdlib 6.1, *)` — it requires a **macOS 15.4+ / iOS 18.4+** deployment target at runtime, not merely a Swift 6.1+ toolchain. Somnio floors at macOS 15.0, so the direct `ForEach(items.enumerated(), id: \.element.id)` form fails to compile here; keep the `Array(...)` wrapper (or gate the direct form with `#available(macOS 15.4, *)`). The wrapper forces an eager copy on every body evaluation — that is the price of supporting the macOS 15.0 floor.

```swift
// Somnio (macOS 15.0 floor): wrap in Array(...)
ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
    ItemRow(number: index + 1, item: item)
}
```

## List with Custom Styling

```swift
// Remove default background and separators
List(items) { item in
    ItemRow(item: item)
        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
        .listRowSeparator(.hidden)
}
.listStyle(.plain)
.scrollContentBackground(.hidden)
.background(Color.customBackground)
.environment(\.defaultMinListRowHeight, 1)  // Allows custom row heights
```

## List with Pull-to-Refresh

```swift
List(items) { item in
    ItemRow(item: item)
}
.refreshable {
    await loadItems()
}
```

## List Selection & Double-Click (macOS)

For single-click select + double-click open, use native selection plus `contextMenu`'s `primaryAction` — **never** a row tap gesture.

```swift
List(selection: $selection) {
    ForEach(items) { item in
        ItemRow(item: item)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())   // whole row hit-testable for selection
            .tag(item.id)
    }
}
.contextMenu(forSelectionType: Item.ID.self) { _ in
    // per-selection menu (may be empty; per-row .contextMenu still works)
} primaryAction: { ids in
    if let id = ids.first { open(id) }   // fires on double-click AND Return
}
```

- **Do not** attach `.onTapGesture(count:)` or `.simultaneousGesture(TapGesture())` to a row for double-click. The gesture owns the row's hit-tested content area (its `.contentShape`) and wins the gesture arena there, so `List` never sees single clicks in the content — **only the `listRowInsets` margins (no content/gesture) still select**. Symptom: "edges select, center doesn't; double-click works everywhere." `primaryAction` avoids this because it installs no row gesture.
- A plain `Button` row selects reliably but **can't deselect** (it only ever *sets* selection) — wrong for list semantics. Use `List(selection:)`, not buttons.
- Exclude headers/section rows from selection with `.selectionDisabled()`.
- Requires macOS 13+ (`forSelectionType`); `.selectionDisabled()` is macOS 14+.

## Sizing a Window to List Content (macOS)

`.windowResizability(.contentSize)` fits a window to its content — but a `List` is **greedy in both axes and reports no intrinsic content size**, so the window won't shrink to fit it. Drive the size explicitly:

- **Height**: give the `List` a `.frame(height:)` computed from visible row count × measured row heights, capped at screen height (so a long list scrolls instead of overflowing).
- **Width**: a `List` never reports the widest row, so measure it yourself (e.g. render the labels off-screen with `.fixedSize()` and a max-reducing `PreferenceKey`) and set the content's width.

Two measurement gotchas:

- `.plain` reserves its **own** per-row horizontal padding (~8pt leading, ~9pt trailing — trailing leaves room for the scroller) **on top of** your `listRowInsets`; compensate when aligning row content to a header outside the list.
- A `List` row renders its text **noticeably wider** (~14pt for a ~20-char label) than an identical off-screen `Text` with the same modifiers, so off-screen measurement under-reports row width — add an offset. `.accessibilityElement(children: .combine)` on a row also hides the inner label, so AX can't expose its width directly.

## Animating List Resize (macOS)

A `List` does **not** animate size + content changes cleanly. `.frame(height: computedHeight).animation(.smooth, value: computedHeight)` animates the container's height while the rows pop in/out (jumpy on insert/remove); keying the animation on the data triggers (search text, expansion state) instead of a derived height is better but still not smooth. Separately, a **window-level** frame `.animation(value: width/height)` animates every static sibling in that view tree too (e.g. a header's avatar slides as the window reflows) — scope animation to only the changing subtree. For an auto-sizing list (e.g. an Adium-style buddy list), snapping (no animation) is the safe default; a smooth resize needs coordinated row-transition + frame animation, or an AppKit-level window-frame animation.

## Summary Checklist

- [ ] ForEach uses stable identity (never `.indices` or `\.offset` for dynamic content)
- [ ] id is stable across edits (not a mutable property), created outside `body`, and cheap to hash
- [ ] Constant number of views per ForEach element; rows are unary (single top-level view)
- [ ] No inline filtering in ForEach (prefilter and cache instead)
- [ ] No `AnyView` in list rows
- [ ] `.enumerated()` uses the element's id (`\.element.id`, not `\.offset`); wrap in `Array(...)` unless the deployment target is macOS 15.4+ (the direct form's Collection conformance is `@available(SwiftStdlib 6.1, *)`; Somnio floors at 15.0)
- [ ] Use `.refreshable` for pull-to-refresh
- [ ] Custom list styling uses appropriate modifiers
