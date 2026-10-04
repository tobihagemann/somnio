---
name: somnio-editor
description: "Serve the localhost web map editor and drive it with agent-browser for hands-on testing. Use when the user asks to run, open, launch, or try the editor, to test a change in the editor, or to author/edit .somnio-sector files. The editor is offline (no server, database, or login needed) and dev-only — it is served by vite dev alone and never ships."
---

# Run Editor (Local Dev)

The editor is a second Vite entry point in `packages/web/` (`editor.html` + `src/editor/**`) for
`.somnio-sector` map files. Fully offline — no gameplay server, Postgres, or login — and
dev-only by construction: `editor.html` is never in `build.rollupOptions.input`, so it cannot
reach `dist/` or the shipped image (`npm run build` asserts this after every bundle).

## Step 1: Serve the editor

Node 24.17.0+ (`.nvmrc`). For real models and floors, build the served asset root from the
`somnio-assets` working tree first (placeholders otherwise — fine for most editor testing):

```bash
SOMNIO_ASSET_SOURCE="<asset-pack-root>" SOMNIO_WEB_ASSET_DEST=packages/web/public/assets Scripts/bundle-web-assets.sh
mkdir -p sectors && cp packages/core/fixtures/sectors/*.somnio-sector sectors/
npm ci && npm run editor --workspace packages/web
```

`npm run editor` opens `http://localhost:17669/editor.html` and sets `SOMNIO_EDITOR_SECTORS_DIR`
(default: the repo-root `sectors/`). That variable is the load-bearing part, since it is both the
gate and the root of the file API. A bare `npm run dev --workspace packages/web` never mounts it,
and an editor served that way can render but cannot list, open, create, or save anything. Point
the variable elsewhere to author a different directory:

```bash
SOMNIO_EDITOR_SECTORS_DIR=/path/to/sectors npm run editor --workspace packages/web
```

The API is loopback-only (`/__editor/sectors`; GET list, GET/PUT per stem, no DELETE) and
saves atomically, so a running dev server can read the files while you author them. Save As
writes the new name and leaves the original file in place.

## Step 2: Drive it with agent-browser

`window.somnioEditor` is the read-only debug surface (always installed — the page is dev-only).
Gate every wait on a predicate over it, not a sleep:

```bash
agent-browser open 'http://localhost:17669/editor.html'
agent-browser wait --fn 'window.somnioEditor !== undefined && window.somnioEditor.overlay() === "sectorPicker"'
agent-browser snapshot -i        # tool palette, inspector, picker rows are real DOM with refs
agent-browser eval 'const b=[...document.querySelectorAll("button")]; b.find(x=>x.textContent==="EdariaMitte").click(); "ok"'
agent-browser wait --fn 'window.somnioEditor.sectorName() === "EdariaMitte"'
agent-browser eval 'window.somnioEditor.placeholderObjectCount()'   # 0 = real models resolved
```

| Call | Returns |
|---|---|
| `sectorName()` | loaded sector id, `''` before the first open |
| `body()` | record counts per array (`placements`, `blockers`, `doors`, `npcs`, `monsterSpawns`, `floorPatches`) |
| `selection()` | `[{ kind, id }]`; `kind` is `'placement' \| 'blocker' \| 'door' \| 'npc' \| 'monsterSpawn' \| 'floorPatch' \| 'spawn'`, `id` the record's id |
| `tool()` | `'select' \| 'placement' \| 'blocker' \| 'npc' \| 'monsterSpawn' \| 'floorPatch' \| 'spawn'` |
| `issues()` | `string[]` of what the server would report at boot: one `<record> "<id>": <message>` line per record the overlay marks in red, preceded by the reason when the world would not load at all; `[]` for a clean sector |
| `overlay()` | `'gameMenu' \| 'newMap' \| 'sectorSettings' \| 'about' \| 'preferences' \| 'sectorPicker' \| 'saveAs' \| undefined` |
| `isDirty()` | unsaved changes against the last save/load checkpoint |
| `undoDepth()` | committed undo steps |
| `placeholderObjectCount()` | placements still rendering placeholders |
| `cameraScale()` | orthographic vertical half-height |

**Canvas input.** The WebGL canvas has no AX elements; drive it with synthetic events on
`#somnio-editor-canvas` — `PointerEvent` down/move/up for select/place/drag/marquee (Shift for
additive), `KeyboardEvent` on `window` for commands. Commands bind on `metaKey || ctrlKey`:
S save, Shift+S save-as, Z/Shift+Z undo/redo, D duplicate, G grid, C/V copy/paste, A select
all; Delete removes; arrows nudge by 1 cm (Shift = grid step). All are suppressed while a
text field has focus — `document.activeElement?.blur?.()` first. Esc walks the overlay state
machine.

**Verify via file (decisive).** After a save, read the sector JSON out of the sectors
directory — screenshots can lie, the saved file cannot. An unedited open+save is byte-identical
to the input (`cmp` against the fixture), so any diff is exactly your edit. Defaults are left
out of the file (`yaw` and `elevation` at 0, empty arrays), so an absent key is not a lost
edit. AGENTS.md's "Sector format" has the full shape.

## Notes

- The sector's single spawn point is selected as `{ kind: 'spawn', id: 'spawn' }`. Placements
  move and rotate but do not resize; blockers, floor patches, and monster-spawn areas resize.
  A single selected placement, NPC, or spawn point carries a facing handle; a placement's
  turns its `yaw`.
- Collision comes from the registry: a placement blocks through its model's colliders, and the
  overlay shows them along with walk surfaces, ledges, door triggers, and arrival points. Add a
  blocker only for ground no model covers.
- The overlay marks in red what the server would report at boot, and `issues()` lists the
  same: a door that does not resolve, has no sound counterpart, or arrives on something solid
  (an NPC included), walk surfaces of two placements that overlap, an `elevation` on a model
  with walk surfaces, and an unmapped model.
- Doors, NPCs, and monster spawns carry a text label (`<door id> -> <sector>/<door>`, the
  NPC's name, `<kind> x<maxAlive>`). The labels are DOM elements (`.editor-label`,
  `.editor-label--issue` in red), so `agent-browser snapshot` sees them.
- A door has no tool. Select a placement: its inspector lists its doors and offers an
  `Add door at <anchor>` button per free anchor of its model. The new door is `door-<n>` with
  an empty target, so it shows as an issue until Target sector and Target door are picked in
  the door's own inspector. Deleting a placement deletes its doors, and a door is copied only
  together with its placement.
- Placement tools place on tap; only the Select tool picks. The placement tool stamps the
  model of the placement selected last (the registry's first model until then); change it in
  the placed record's inspector.
- Picking prefers NPCs > the spawn point > door triggers > placements > blockers > monster
  spawns > floor patches, back-to-front within a kind. A placement is hit-tested on its
  model's footprint at its yaw, so a click on a prop selects the prop and not a rect under
  it; a door trigger lies inside its building's footprint, so it wins there.
- Inspector fields are metres (degrees for `yaw` and facing) and commit on Return or blur only.
  A press on the canvas, a selection change, or Esc blurs a focused field first, so its draft
  is committed. An unparseable draft reverts, and an equal value commits nothing. Each commit
  is one undo step.
- Floor patches preview as gizmo rects during drags (their meshes bake space-coordinate UVs)
  and may never overlap: a commit that would introduce an overlap is refused with a message.
- Grid snap lives in Preferences (game menu), persisted under `somnio.editor.gridSnap`:
  1, 0.5, 0.25, or 0.1 m, or free (stored as `0`). An absent key means 0.5 m, not free.
  Snapping rounds to the nearest step, and every authored value is rounded to the millimetre.
- Every other sector in the sectors directory is loaded when a sector opens: they feed the
  door target pickers and `issues()`. With an outdoor sector open, the outdoor sectors
  touching it are drawn read-only at their origins, so roads, walls, and tree lines can be
  lined up across a border. They cannot be selected; open a neighbour to edit it. One that
  overlaps the open sector is reported in `issues()` instead of drawn.
- Vite hot-reloads editor code changes, resetting the page to the sector picker. After an
  asset-pack change, re-run `bundle-web-assets.sh` and restart Vite (the served root is a
  copy, enumerated at startup).
- On teardown, `agent-browser close` and stop Vite. The sectors directory keeps your edits.
