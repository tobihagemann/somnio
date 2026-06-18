---
name: somnio-editor
description: "Build and launch the Somnio map editor locally for hands-on testing. Use when the user asks to run, open, launch, or try the editor, or to test a change in the editor app. The editor is offline (no server, database, or login needed)."
---

# Run Editor (Local Dev)

The editor is a document-based macOS app for `.somnio-sector` map files. It is fully offline — no server, Postgres, login, or production endpoint involved — so launching it is just build + package + open. Run it as a packaged debug `.app` (not bare `swift run`): the `DocumentGroup` document types, icon, and Open/Save dialogs come from the bundle's `Info.plist`.

## Step 1: Build and package the debug bundle

From the repo root (run with the sandbox disabled — SwiftPM packaging needs it):

```bash
SIGNING_MODE=adhoc Scripts/package_app.sh debug editor
```

This builds `SomnioEditor` and assembles `SomnioEditor.app` at the repo root with adhoc signing. A `SOMNIO_ASSET_SOURCE not set; skipping` warning is expected and fine.

For textured map rendering, point at an asset pack root (containing `Tilesets/`, `Characters/`, `Animations/`, `System/`, `Buttons/`):

```bash
SOMNIO_ASSET_SOURCE="<asset-root>" SIGNING_MODE=adhoc Scripts/package_app.sh debug editor
```

Without it the editor opens with the nil-fallback (untextured) rendering, which is fine for most editor testing.

## Step 2: Launch

```bash
open SomnioEditor.app
```

Open or create a `.somnio-sector` document to exercise the change.

## Notes

- Rebuild and repackage after any code change — a running instance keeps the old code in memory.
- To produce a signed, notarized editor DMG for distribution (not local testing), use `Scripts/release.sh editor`.
