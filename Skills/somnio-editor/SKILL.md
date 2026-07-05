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

This builds `SomnioEditor` and assembles `SomnioEditor.app` at the repo root with adhoc signing. A `SOMNIO_ASSET_SOURCE not set; skipping` message is expected and fine.

For textured map rendering, point at an asset pack root (containing `Models/` and `FloorMaterials/`; the local pack lives at `../somnio-assets`):

```bash
SOMNIO_ASSET_SOURCE="<asset-root>" SIGNING_MODE=adhoc Scripts/package_app.sh debug editor
```

Without it the editor opens with the nil-fallback rendering (placeholder gray models, untextured floor), which is fine for most editor testing.

## Step 2: Launch

```bash
open SomnioEditor.app
```

Or open a sector file directly (the fixtures under `Tests/SomnioMapFixturesTestSupport/MapFixtures/` make good test documents):

```bash
open -a "$PWD/SomnioEditor.app" Tests/SomnioMapFixturesTestSupport/MapFixtures/EdariaBibliothek.somnio-sector
```

Never launch with `open -a SomnioEditor` (by name) — that resolves a stale copy in /Applications, not the freshly built app. Always use the repo-root app by path.

## Notes

- Rebuild and repackage after any code change — a running instance keeps the old code in memory.
- To screenshot the editor when its window sits on another Space, find the window id with a swift CGWindowList snippet (`CGWindowListCopyWindowInfo`; system python has no PyObjC/Quartz) and capture via `screencapture -l <id>`.
- To produce a signed, notarized editor DMG for distribution (not local testing), use `Scripts/release.sh editor`.
