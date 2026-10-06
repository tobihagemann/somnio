---
name: somnio-web
description: "Serve the Three.js browser client locally against the dev server and drive it with agent-browser — log in, walk, screenshot, and read world state headlessly for automated verification. Use when the user asks to run, open, test, or screenshot the web/browser client, or to verify a gameplay or UI change in the browser."
---

# Run Browser Client (Local Dev)

Serves the browser client against the local dev server and drives it with `agent-browser`.

## Step 1: Start the dev server

The client needs a running backend. Stand up the local server on port 17662 first — run the `/somnio-server` skill.

## Step 2: Serve the client

Node 24.17.0 or newer (the root `package.json` pins `engines`, `.nvmrc` carries the version).

Without an asset pack the page loads and plays with placeholder models, an untextured floor, and unstyled panels. To render the real world, build the served asset root from the `somnio-assets` working tree **before** starting Vite; a pack added afterwards is not served until restart:

```bash
SOMNIO_ASSET_SOURCE="<asset-pack-root>" SOMNIO_WEB_ASSET_DEST=packages/web/public/assets Scripts/bundle-web-assets.sh
npm ci && npm run dev --workspace packages/web
```

Vite serves on `http://localhost:17669` and proxies `/ws` to `127.0.0.1:17662`. The proxy is what matters: the client derives its gameplay endpoint from the page origin, so `/` and `/ws` have to share one. Point the proxy elsewhere with `SOMNIO_DEV_GAMEPLAY_ORIGIN`.

The destination is `packages/web/public/assets` for the dev server only. Vite serves `packages/web/public` and `packages/web/` and never `dist/`, so writing the pack to `packages/web/dist/assets` leaves every model and texture 404ing with no error but a placeholder world. The image build uses `dist` because nginx serves that directory.

To exercise production's routing instead of the Vite proxy, run the container topology — `proxy` serves the client at `/` and routes `/ws`, `/admin`, and `/health` to the server:

```bash
mkdir -p assets
docker compose -f docker-compose.example.yml build --build-arg BUILD_VERSION=local
docker compose -f docker-compose.example.yml up --wait   # http://127.0.0.1:17669/?debug=1
```

That topology serves a production build, so `?debug=1` is required — without it `window.somnio` is undefined and every recipe below fails.

## Step 3: Create an account

Register through the UI: click "If you don't have an account, click here!", fill nickname, both password fields, and **email** (the server rejects an empty one), pick a people, then submit. A successful sign-up returns to the login overlay with the nickname and password already filled in. Fresh characters spawn in the `EdariaBibliothek` starter sector.

Re-snapshot after every overlay change — the refs are per-snapshot, and typing against stale refs from the previous overlay silently fills the wrong fields.

To skip the UI entirely, register over the wire instead: open a WebSocket to `ws://127.0.0.1:17662/ws`, receive the hello frame, then send `{"tag":"register","payload":{"nickname":"...","password":"...","passwordRepeat":"...","people":"wachen","email":"..."}}` (password ≥ 8 UTF-8 bytes; `people` is one of `wachen`, `soporen`, `umbren`, `lumina`; expect `{"tag":"registerResult","payload":{"result":"ok"}}`).

## Step 4: Open the client and log in

```bash
agent-browser open 'http://localhost:17669/'
agent-browser wait --fn 'document.querySelector(".blocking-notice:not(.hidden)") === null && window.somnio?.overlay() === "login"'
agent-browser snapshot -i          # nickname, password, Remember password, and Log In refs
agent-browser type <nickname-ref> '<nickname>'
agent-browser type <password-ref> '<password>'
agent-browser click <log-in-ref>
agent-browser wait --fn 'window.somnio.connectionState() === "attached"'
```

That first predicate does two jobs, and both are load-bearing. The model prewarm shows a progress notice, so waiting it out is what keeps `snapshot` from running against a half-built page. And `overlay()` alone is not a readiness signal: it initializes to `login` before anything is presented, so on a host with no WebGL or a handheld viewport it answers `login` while the page actually shows a blocking notice and no form exists. Checking for a visible notice covers both.

`attached` is reached on the `enterSpace` frame, the first frame of every join, which promotes the session and starts the gameplay tick.

Checking "Remember password" stores a session token in `localStorage`, so a reload resumes without re-entering credentials.

`agent-browser type` **appends** to a pre-filled field. The overlays keep field values for the page lifetime, and Step 3's sign-up handoff deliberately pre-fills the login form — so registering and then running the login block verbatim produces doubled text and a "Falsche Zugangsdaten." / "Bad credentials." chat line. Clear the fields first (`agent-browser eval 'document.querySelectorAll("input").forEach(i => { i.value = "" })'`) or open a fresh page before typing.

## Debug API

`window.somnio` is read-only and exposes what the canvas cannot show. It is present in dev builds and requires `?debug=1` in production, because `entities()` reports the name and position of every peer in view.

Positions are metres in the coordinates of the current space: `x` runs east, `z` south, and an outdoor position includes its sector's origin (the Nordwald lies at negative `z`). `facing` is a heading in degrees, 0 = south and 90 = east.

| Call | Returns |
|---|---|
| `connectionState()` | `'disconnected'` \| `'awaitingHello'` \| `'awaitingLoginResult'` \| `'awaitingEnterSpace'` \| `'attached'` |
| `player()` | `{ x, z, facing, gait, name }` (`gait` is `'walk'` \| `'jog'` \| `'run'`), or `undefined` before placement |
| `spaceId()` | `'outdoors'` for every outdoor sector, an interior's sector name otherwise; `undefined` before the first join |
| `sectorName()` | the sector the predicted position stands in, e.g. `'EdariaMitte'` |
| `entities()` | `[{ id, kind, name, x, z, condition }]`; `kind` is `'player'` (self), `'peer'`, `'npc'`, or `'monster'`, `id` is a string (a character id, `npc:<sector>/<id>`, `monster:<n>`), and `condition` is `'hale'`, `'wounded'`, `'hurt'`, `'failing'`, or `'fallen'` |
| `energy()` | the player's own pools as last sent: `{ healthCurrent, healthMax, balanceCurrent, balanceMax, spiritCurrent, spiritMax }` |
| `lucidity()` | `{ role?, ranks: [{ teachingId, rank, practice }], study?, task? }` as last sent |
| `winded()` | whether the player's balance gave out, which holds them to `walk` |
| `servicePanel()` | the id of the master whose panel is open, or `undefined` |
| `tending()` | the id of the dreamer the player tends, or `undefined` |
| `screenPoint(entityId)` | `{ x, y }` in CSS pixels where that entity's body is drawn on the page, or `undefined` |
| `chatHistory()` | the session's chat lines as localized strings; the greeting the panel shows above them is not included, so the result is `[]` until the first line arrives |
| `placeholderObjectCount()` | objects still rendering a placeholder model; `0` when there is no scene at all |
| `cameraScale()` | vertical half-height of the orthographic frustum, or `undefined` with no scene |
| `overlay()` | `'login'` \| `'registration'` \| `'about'` \| `'updateRequired'` \| `'options'` \| `'gameMenu'` \| `undefined` |
| `zoomFactor()` | session zoom, 0.5–2.0 |

`<html data-somnio-build>` carries the build stamp (`somnio-web <version>`) with no `?debug=1` gate, so any loaded page identifies its build. It is set by `main.ts` once the bundle runs, not baked into the served HTML — read it with `agent-browser eval 'document.documentElement.dataset.somnioBuild'`, since `curl` of the same URL returns a bare `<html lang="en">`.

## Recipes

**Walk.** Movement is sampled from held keys by the frame loop, so hold the key across real time rather than tapping it. `agent-browser press` sends a keydown/keyup pair, which advances one frame's worth of distance (a few centimetres) — enough to prove input is wired, not enough to travel.

```bash
agent-browser eval --stdin <<'JS'
(async () => {
  const before = window.somnio.player()
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }))
  await new Promise((resolve) => setTimeout(resolve, 1000))
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }))
  const after = window.somnio.player()
  return { before, after, moved: before.x !== after.x || before.z !== after.z }
})()
JS
```

The default gait is a jog at 2 m/s. Hold `ShiftLeft` to run (3 m/s) and `AltLeft` to walk (1 m/s); the gait rule is left-side keys only. Arrow keys drive the same four direction bits as WASD.

**Click an entity.** A left click on the play field acts on what it points at: an NPC within speaking distance (2 m) is asked to go on past its greeting, and one further away ignores the click. A Heiler's click on another player tends them, and anything else is a swing toward the cursor. `screenPoint(id)` is where an entity's body is drawn on the page, so a click can be aimed at it. The character faces the cursor, and takes the new facing on the next frame. A swing at a nightmare therefore needs the `pointermove` first and a frame's wait before the `pointerdown`; a click on an NPC or a player does not.

```bash
agent-browser eval --stdin <<'JS'
(() => {
  const canvas = document.querySelector('canvas')
  const npc = window.somnio.entities().find((e) => e.kind === 'npc')
  const at = window.somnio.screenPoint(npc.id)
  const init = { clientX: at.x, clientY: at.y, button: 0, bubbles: true }
  canvas.dispatchEvent(new PointerEvent('pointermove', init))
  canvas.dispatchEvent(new PointerEvent('pointerdown', init))
  window.dispatchEvent(new PointerEvent('pointerup', init))
  return { npc: npc.id, at }
})()
JS
```

A swing repeats at the swing rhythm for as long as the button is down, so send the `pointerup` when one swing is all the step needs. To keep one held, withhold the `pointerup` and give every `pointermove` sent meanwhile `buttons: 1`: a constructed event defaults to `buttons: 0`, which reads as the left button having come up and ends the hold. `agent-browser click` takes a selector, not coordinates, so it cannot be aimed at an entity.

**Trigger NPC dialog.** Dialog arrives as a `serverSay` frame — there is no dialog-specific verb — so it lands in the chat scrollback. Walk within 2 m of the NPC and it greets the player with its first line, unasked: once per approach, and not again within 30 s. Clicking it as above brings its remaining lines, a few seconds apart, and opens a master's panel (`window.somnio.servicePanel()`).

```bash
agent-browser eval 'window.somnio.entities().filter((e) => e.kind === "npc")'
# hold the direction key until the player is within 2 m, then:
agent-browser wait --fn 'window.somnio.chatHistory().length > 0'
agent-browser eval 'window.somnio.chatHistory().at(-1)'
```

**Screenshot.** `agent-browser screenshot --full <path>` captures the WebGL world and the DOM panels over it in one image.

**Two players in view of each other.** Separate `agent-browser` sessions get separate `localStorage`, so each holds its own session token.

```bash
agent-browser --session a open 'http://localhost:17669/'
agent-browser --session b open 'http://localhost:17669/'
# log each in as a different account, then from a:
agent-browser --session a eval 'window.somnio.entities().filter((e) => e.kind === "peer")'
```

A client holds the entities in its own sector and the sectors touching it, so two players see each other in the same or in adjacent outdoor sectors and lose each other two sectors apart. Use this for anything needing an independent observer — that a peer's position matches what the walker believes, or that a peer walking out of view is removed. A peer's position arrives in a batched `moves` frame about ten times a second and is drawn interpolated, so compare with a tolerance.

The client's own position is predicted, not authoritative. The server sends a `correction` for self when it rejects a move and when the player falls. An unmodified client has a move rejected only when its reports are held back for longer than the movement allowance covers (two seconds' worth at a little over running speed) and then arrive together.

**Relocate the character.** The server holds the gameplay session for a few seconds after the page goes away, because the Vite proxy keeps the upstream WebSocket alive. Both the disconnect checkpoint and the periodic 30 s checkpoint write the character row, so a DB `UPDATE` issued too early is silently overwritten, and an immediate re-login fails with "Du bist bereits angemeldet." / "Already logged in." in chat. Order matters, and the post-login `sectorName()` read is the success predicate. The Notes' no-sleep rule is suspended here only because no page exists to poll between close and login:

```bash
agent-browser close; sleep 8   # closes only the default session (--session a/b need their own close)
docker exec somnio-pg psql -U postgres -d somnio -c "UPDATE characters SET space='outdoors', position_x=20, position_z=-46 WHERE name='<nickname>';"
agent-browser open 'http://localhost:17669/'
# log in, then: agent-browser eval 'window.somnio.sectorName()'  — expect 'Nordwald'; the old sector
# here means the checkpoint won the race; close and repeat. A position inside geometry or outside
# every sector self-heals to the starter spawn in EdariaBibliothek with no error, so pick open ground.
```

`space` and `position_x`/`position_z` hold what `spaceId()` and `player()` report: a space id, and metres in that space's coordinates. `(20, -46)` is open ground in the Nordwald, whose origin is `(5.12, -61.44)`. An interior's positions run from its own north-west corner.

**Set the time of day.** No admin verb sets the clock. Stop the server first: it saves the clock about every 15 s and on shutdown, so an `UPDATE` under a running server is overwritten. Then write the row and start the server again:

```bash
docker exec somnio-pg psql -U postgres -d somnio -c "INSERT INTO world_clock (id, world_seconds) VALUES (TRUE, 14515225200) ON CONFLICT (id) DO UPDATE SET world_seconds = EXCLUDED.world_seconds;"
```

`14515225200` is 07:00 on the first day of year 500; add 3600 per hour. World time runs at four times wall time, so an hour passes in 15 minutes. Outdoor light follows the clock; an interior is lit by its own `brightness`.

**Verify the asset pack resolved.** `agent-browser eval 'window.somnio.placeholderObjectCount()'` — non-zero means models are missing or a registry id has no matching stem. Read it only once Step 4's gate has passed: with no scene it returns `0`, which is indistinguishable from success.

## Notes

- Wrap any `eval --stdin` script that awaits in an async IIFE. `eval` runs a script body, not a module, so top-level `await` and top-level `return` both throw a `SyntaxError`.
- Gate every wait on a predicate over `window.somnio`, not a sleep. Model prewarm makes first-load timing variable.
- A walk that silently does nothing is usually the input gate, not broken input. The frame loop requires `attached && no overlay && chat not focused`; check `window.somnio.overlay()` first. Each frame's elapsed time is clamped to 100 ms, so a stalled tab resumes without teleporting.
- A fallen player does not move at all (their own entry in `entities()` has `condition: 'fallen'`), and a winded one (`winded()`) is held to `walk` whatever key is held.
- Focusing the chat input closes the gate and clears held keys, so a movement key held across the focus change stops the character.
- Activate a DOM control with a real pointer gesture on a ref from a snapshot: `agent-browser click @ref` for a panel button, `agent-browser dblclick @ref` for an inventory row (a single click does nothing to a row). A control replaced by a re-render between press and release never gets its click. A real gesture shows that, and `element.click()` in an `eval` hides it, because it lands in one tick. Test a panel while balance is recovering (`energy().balanceCurrent` rising after a run), when `energy` frames arrive several times a second.
- Esc opens the game menu during a session. While the player tends someone, the first Esc only lets go of them and the next opens the menu. On the version-skew overlay it goes to the login overlay, and there it is inert — nothing is behind it to resume to.
- `chatHistory()` returns localized text and the client picks German from `navigator.languages`. Assert on substrings unless the locale is pinned.
- Vite hot-reloads code changes. After an asset-pack change, re-run `Scripts/bundle-web-assets.sh` and restart Vite — the served asset root is a copy, enumerated at startup.
- When Step 4's gate times out, read the visible notice: `agent-browser eval 'document.querySelector(".blocking-notice:not(.hidden)")?.textContent'`. A WebGL or desktop-only notice means the browser cannot render the world — rerun with `agent-browser --headed` so a real GPU context is available.
- On teardown, close the browser sessions (`agent-browser close`, plus `--session a` / `--session b` for the two-player recipe) and stop Vite, but keep the Postgres container so the dev character persists (see `/somnio-server`).
