# macOS AppKit interop and file access (SwiftUI)

Two things that bite when wrapping AppKit views or handling file URLs on macOS. The editor uses `NSViewRepresentable` heavily, so both apply directly.

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
