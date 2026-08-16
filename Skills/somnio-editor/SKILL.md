---
name: somnio-editor
description: "Serve the localhost web map editor and drive it with agent-browser for hands-on testing. Use when the user asks to run, open, launch, or try the editor, to test a change in the editor, or to author/edit .somnio-sector files. The editor is offline (no server, database, or login needed) and dev-only — it is served by vite dev alone and never ships."
---

# Run Editor (Local Dev)

The editor is a second Vite entry point in `Web/` (`editor.html` + `src/editor/**`) for
`.somnio-sector` map files. Fully offline — no gameplay server, Postgres, or login — and
dev-only by construction: `editor.html` is never in `build.rollupOptions.input`, so it cannot
reach `dist/` or the shipped image (`lint.sh --web` machine-enforces this).

## Step 1: Serve the editor

Node 24.17.0+ (`Web/.nvmrc`). For real models and floors, build the served asset root from the
`somnio-assets` working tree first (placeholders otherwise — fine for most editor testing):

```bash
SOMNIO_ASSET_SOURCE="<asset-pack-root>" SOMNIO_WEB_ASSET_DEST=Web/public/assets Scripts/bundle-web-assets.sh
mkdir -p sectors && cp Tests/SomnioMapFixturesTestSupport/MapFixtures/*.somnio-sector sectors/
cd Web && npm ci && npm run editor
```

`npm run editor` opens `http://localhost:5173/editor.html` and — this is the load-bearing
part — sets `SOMNIO_EDITOR_SECTORS_DIR` (default `../sectors`), which is both the gate and the
root of the file API: a bare `npm run dev`
never mounts it, and an editor served that way can render but cannot list, open, create, or
save anything. Point the variable elsewhere to author a different directory:

```bash
SOMNIO_EDITOR_SECTORS_DIR=/path/to/sectors npm run editor
```

The API is loopback-only (`/__editor/sectors`; GET list, GET/PUT per stem, no DELETE) and
saves atomically, so a running dev server can read the files while you author them. Save As
writes the new name and leaves the original file in place.

## Step 2: Drive it with agent-browser

`window.somnioEditor` is the read-only debug surface (always installed — the page is dev-only).
Gate every wait on a predicate over it, not a sleep:

```bash
agent-browser open 'http://localhost:5173/editor.html'
agent-browser wait --fn 'window.somnioEditor !== undefined && window.somnioEditor.overlay() === "sectorPicker"'
agent-browser snapshot -i        # tool palette, inspector, picker rows are real DOM with refs
agent-browser eval 'const b=[...document.querySelectorAll("button")]; b.find(x=>x.textContent==="EdariaMitte").click(); "ok"'
agent-browser wait --fn 'window.somnioEditor.sectorName() === "EdariaMitte"'
agent-browser eval 'window.somnioEditor.placeholderObjectCount()'   # 0 = real models resolved
```

| Call | Returns |
|---|---|
| `sectorName()` | loaded sector id, `''` before the first open |
| `body()` | record counts per array (`objects`, `collisionMasks`, `portals`, `npcs`, `monsterSpawns`, `floorPatches`) |
| `selection()` | `[{ kind, index }]` |
| `tool()` | `'select' \| 'object' \| 'mask' \| 'portal' \| 'npc' \| 'monster' \| 'floorPatch'` |
| `overlay()` | `'gameMenu' \| 'newMap' \| 'sectorSettings' \| 'about' \| 'preferences' \| 'sectorPicker' \| 'saveAs' \| undefined` |
| `isDirty()` | unsaved changes against the last save/load checkpoint |
| `undoDepth()` | committed undo steps |
| `placeholderObjectCount()` | placed objects still rendering placeholders |
| `cameraScale()` | orthographic vertical half-height |

**Canvas input.** The WebGL canvas has no AX elements; drive it with synthetic events on
`#somnio-editor-canvas` — `PointerEvent` down/move/up for select/place/drag/marquee (Shift for
additive), `KeyboardEvent` on `window` for commands. Commands bind on `metaKey || ctrlKey`:
S save, Shift+S save-as, Z/Shift+Z undo/redo, D duplicate, G grid, C/V copy/paste, A select
all; Delete removes; arrows nudge (Shift = grid step). All are suppressed while a text field
has focus — `document.activeElement?.blur?.()` first. Esc walks the overlay state machine.

**Verify via file (decisive).** After a save, read the sector JSON out of the sectors
directory — screenshots can lie, the saved file cannot. An unedited open+save is byte-identical
to the input (`cmp` against the fixture), so any diff is exactly your edit.

## Notes

- Placement tools place on tap; only the Select tool picks. Picking prefers NPCs > monsters >
  portals > masks > objects > floor patches, back-to-front within a kind — a click overlapping
  a mask selects the mask, so aim inside the prop's rect but outside every mask.
- Inspector fields commit on Return or blur only; an unparseable draft reverts, an equal value
  commits nothing. Each commit is one undo step.
- Floor patches preview as gizmo rects during drags (their meshes bake sector-space UVs) and
  may never overlap: a commit that would introduce an overlap is refused with a message.
- Grid snap lives in Preferences (game menu), persisted under `somnio.editor.gridSnap`; an
  absent key means 32, not free.
- Vite hot-reloads editor code changes, resetting the page to the sector picker. After an
  asset-pack change, re-run `bundle-web-assets.sh` and restart Vite (the served root is a
  copy, enumerated at startup).
- On teardown, `agent-browser close` and stop Vite. The sectors directory keeps your edits.
