---
name: somnio-editor
description: "Build and launch the Somnio map editor locally for hands-on testing. Use when the user asks to run, open, launch, or try the editor, to test a change in the editor app, or to drive/smoke-test it with synthetic events. The editor is offline (no server, database, or login needed)."
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
- To screenshot or drive the editor programmatically, see "Driving the editor (synthetic events)" below (window-id discovery, clicks, ⌘-keys, verification). System python has no PyObjC/Quartz — use swift snippets for CGWindowList/CGEvent.
- To produce a signed, notarized editor DMG for distribution (not local testing), use `Scripts/release.sh editor`.

## Driving the editor (synthetic events)

Validated recipe for hands-off smoke-driving the running editor:

- **Work on a copy**: `cp Tests/.../Fixture.somnio-sector /tmp/...` and open that — any edit dirties the document and macOS autosaves in place, so never drive edits against a committed fixture.
- **Window + coordinates**: find the window via a swift `CGWindowListCopyWindowInfo` snippet (owner contains "Somnio", Height > 100). Its bounds are in points; global CGEvent coordinates = window origin + window-local point. Screenshots (`caffeinate -u -t 2; screencapture -l <id> -x`) are 2x pixels.
- **Clicks**: post `.leftMouseDown` then `.leftMouseUp` ~60ms apart to `.cghidEventTap`, preceded by a short `.mouseMoved` glide (SwiftUI hover tracking wants movement).
- **⌘-shortcuts**: the app must be frontmost (`osascript -e 'tell application "SomnioEditor" to activate'` — safe despite the launch-by-name warning above: `activate` targets the already-running repo-root instance) and the ⌘ flag goes on BOTH events: `event.flags = .maskCommand` on keyDown and keyUp. Key codes: Esc=53, C=8, V=9, S=1.
- **Verify via UI**: crop the bottom-left `X/Y/W/H` readout and the top-right inspector panel out of window captures — the readout doubles as a pick-alignment oracle (hover a feature with known legacy coords and compare).
- **Verify via file (decisive)**: post ⌘S, then read the saved JSON (record counts, field values) — screenshots can lie, the saved sector cannot.
- **Quitting an edited doc** raises the native save sheet: dismiss without saving via System Events (`click button "Delete"` — or "Don't Save"/"Löschen" — `of sheet 1 of window 1`).
- **Locked screen = dead end**: CGEvents don't route and Metal/RealityKit freezes (black canvas in captures) while SwiftUI chrome still renders. Check `CGSessionCopyCurrentDictionary()["CGSSessionScreenIsLocked"]` and wait for unlock instead of debugging phantom failures.
