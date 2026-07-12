# macOS AppKit interop and file access (SwiftUI)

macOS-specific traps when wrapping AppKit views, handling file URLs, or bridging clipboard and gesture behavior. The editor uses `NSViewRepresentable` heavily, so these apply directly.

## NSViewRepresentable: never touch the managed view's layout

**SwiftUI owns the layout of an `NSViewRepresentable`'s managed view — never set `frame` or `bounds` on it yourself.** Setting them fights SwiftUI's layout pass and produces mis-sized or jumping views. Size the view from the SwiftUI side (`.frame(...)` on the representable) and let `updateNSView` only push *data*, not geometry.

Forward AppKit delegate / target-action callbacks back to SwiftUI through a `Coordinator`, not by mutating SwiftUI state directly from the AppKit view.

```swift
struct SearchField: NSViewRepresentable {
    @Binding var text: String

    func makeNSView(context: Context) -> NSSearchField {
        let field = NSSearchField()
        field.delegate = context.coordinator   // route callbacks through the Coordinator
        return field
    }

    func updateNSView(_ nsView: NSSearchField, context: Context) {
        nsView.stringValue = text               // push data only — no frame/bounds here
    }

    func makeCoordinator() -> Coordinator { Coordinator(text: $text) }

    final class Coordinator: NSObject, NSSearchFieldDelegate {
        let text: Binding<String>
        init(text: Binding<String>) { self.text = text }
        func controlTextDidChange(_ note: Notification) {
            guard let field = note.object as? NSSearchField else { return }
            text.wrappedValue = field.stringValue
        }
    }
}
```

## Security-scoped resources from `fileImporter`

URLs returned by `.fileImporter` (and `.fileMover`) are **security-scoped**: you must bracket access with `startAccessingSecurityScopedResource()` / `stopAccessingSecurityScopedResource()`, or reads/writes silently fail (no error — just empty or denied I/O).

```swift
.fileImporter(isPresented: $showImporter,
              allowedContentTypes: [.somnioSector],
              allowsMultipleSelection: false) { result in
    guard case .success(let urls) = result, let url = urls.first else { return }
    guard url.startAccessingSecurityScopedResource() else { return }
    defer { url.stopAccessingSecurityScopedResource() }
    // read/write url here
}
```

`DocumentGroup` / `FileDocument` / `ReferenceFileDocument` handle this bracketing **automatically** — you only need the manual calls for URLs you obtain yourself via `fileImporter`/`fileMover` outside the document system.

## Custom-UTI clipboard: `onCopyCommand`'s provider bridge drops the bytes

SwiftUI's `onCopyCommand` → `NSPasteboard` bridge **advertises** a custom, LaunchServices-unregistered UTI but never materializes its data: `NSPasteboard.general.data(forType:)` later returns nil (or a stale 0-byte promise). Both provider forms fail — the lazy `registerDataRepresentation(forTypeIdentifier:visibility:loadHandler:)` and the eager `NSItemProvider(item: data as NSData, typeIdentifier:)`. Paste then silently no-ops while Edit ▸ Paste stays enabled (the type IS on the pasteboard).

Use `onCopyCommand` only as the Edit-menu trigger and write the pasteboard yourself, one dispatch turn later so SwiftUI's own (empty) write can't clobber it:

```swift
.onCopyCommand {
    guard let data = try? JSONEncoder().encode(payload) else { return [] }
    DispatchQueue.main.async {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setData(data, forType: NSPasteboard.PasteboardType(UTType.myRecords.identifier))
    }
    return []
}
.onPasteCommand(of: [.myRecords]) { _ in
    // Read synchronously — the provider callbacks are not main-actor friendly.
    guard let data = NSPasteboard.general.data(forType: .init(UTType.myRecords.identifier)) else { return }
    ...
}
```

`onPasteCommand(of:)` gates Edit ▸ Paste on the type correctly either way.

## `DragGesture` cancellation never calls `.onEnded`

On macOS a `DragGesture` can be cancelled (system interruption, view churn mid-drag) with **no callback at all** — there is no `onCancelled`, and `.onEnded` is skipped. Any per-gesture state that only `.onEnded` clears goes stale, and the next press silently continues the dead session.

Defenses: detect a fresh gesture inside `.onChanged` (compare `value.startLocation` against the active session's recorded start; a differing start means the old session was abandoned — reset it), keep one reset function shared by `.onEnded` and that recovery path, and clear live sessions whenever an external mutation (undo, a menu command) invalidates what the session snapshotted. `@GestureState` auto-resets on cancellation and can serve as a cancellation detector, but it cannot drive imperative session state by itself.
