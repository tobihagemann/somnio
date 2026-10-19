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

Without an asset pack the page loads and plays with placeholder models, an untextured floor, unstyled panels, and no wordmark or favicon. To render the real world, build the served asset root from the `somnio-assets` working tree **before** starting Vite; a pack added afterwards is not served until restart:

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
agent-browser wait --fn 'window.somnio.player() !== undefined'
```

That first predicate does two jobs, and both are load-bearing. The model prewarm shows a progress notice, so waiting it out is what keeps `snapshot` from running against a half-built page. And `overlay()` alone is not a readiness signal: it initializes to `login` before anything is presented, so on a host with no WebGL or a handheld viewport it answers `login` while the page actually shows a blocking notice and no form exists. Checking for a visible notice covers both.

`attached` is reached on the `enterSpace` frame, the first frame of every join, which promotes the session and starts the gameplay tick. That is a little before the world is on screen. The splash veil and the wordmark go, and the panels appear, only once the player's own body is placed, which is what the last wait checks.

Checking "Remember password" stores a session token in `localStorage`, so a reload resumes without re-entering credentials. The resume opens its socket at page load, before any `eval` runs, so to watch it start the observing session with `agent-browser --session <name> --init-script <file>`. The script is registered before the first navigation, and only when that session's browser launches. Read the `somnio.sessionToken` value from the session that issued it and set it in the observing one. Then close the issuing session with `agent-browser --session <issuer> close`, not Leave Game, which revokes the token. Give the server a few seconds to unregister the account before reloading the observing session; otherwise the resume retries and ends in "Du bist bereits angemeldet." / "Already logged in."

`agent-browser type` **appends** to a pre-filled field. The overlays keep field values for the page lifetime, and Step 3's sign-up handoff deliberately pre-fills the login form — so registering and then running the login block verbatim produces doubled text and "Falsche Zugangsdaten." / "Bad credentials." on the login card, under the form. Clear the fields first (`agent-browser eval 'document.querySelectorAll("input").forEach(i => { i.value = "" })'`) or open a fresh page before typing.

## Debug API

`window.somnio` is read-only and exposes what the canvas cannot show. It is present in dev builds and requires `?debug=1` in production, because `entities()` reports the name and position of every peer in view.

Positions are metres in the coordinates of the current space: `x` runs east, `z` south, and an outdoor position includes its sector's origin (the Nordwald lies at negative `z`). `facing` is a heading in degrees, 0 = south and 90 = east.

| Call | Returns |
|---|---|
| `connectionState()` | `'disconnected'` \| `'awaitingHello'` \| `'awaitingLoginResult'` \| `'awaitingEnterSpace'` \| `'attached'` |
| `player()` | `{ x, z, facing, gait, name }` (`gait` is `'walk'` \| `'jog'` \| `'run'`), or `undefined` before placement |
| `spaceId()` | `'outdoors'` for every outdoor sector, an interior's sector name otherwise; `undefined` before the first join |
| `sectorName()` | the sector the predicted position stands in, e.g. `'EdariaMitte'` |
| `entities()` | `[{ id, kind, name, x, z, condition }]`; `kind` is `'player'` (self), `'peer'`, `'npc'`, or `'monster'`, `id` is a string (a character id, `npc:<sector>/<id>`, `monster:<n>`), and `condition` is `'hale'` (full health), `'grazed'`, `'wounded'`, `'hurt'`, `'failing'`, or `'fallen'` |
| `energy()` | the player's own pools as last sent: `{ healthCurrent, healthMax, balanceCurrent, balanceMax, spiritCurrent, spiritMax }` |
| `lucidity()` | `{ role?, ranks: [{ teachingId, rank, practice }], study?, task? }` as last sent |
| `winded()` | whether the player's balance gave out, which holds them to `walk` |
| `servicePanel()` | the id of the master or the shopkeeper whose panel is open, or `undefined` |
| `tending()` | the id of the dreamer the player tends, or `undefined` |
| `screenPoint(entityId)` | `{ x, y }` in CSS pixels where that entity's body is drawn on the page (a fallen body where it lies), or `undefined` |
| `chatHistory()` | the session's chat lines as localized strings; the greeting the panel shows above them is not included, so the result is `[]` until the first line arrives |
| `placeholderObjectCount()` | objects still rendering a placeholder model; `0` when there is no scene at all |
| `cameraScale()` | vertical half-height of the orthographic frustum, or `undefined` with no scene |
| `overlay()` | `'login'` \| `'registration'` \| `'about'` \| `'updateRequired'` \| `'options'` \| `'gameMenu'` \| `'logOutOtherBrowsers'` \| `undefined` |
| `zoomFactor()` | session zoom, 0.5–2.0 |
| `splashShot()` | the id of the splash shot playing behind the pre-login screens (`'town'`, `'follow-dreamer'`, ... `'time-lapse'`), or `undefined` while none plays |

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

The keys move in screen directions, which the camera's fixed 35° yaw turns on the ground. `KeyA` moves about (−0.82, +0.57) in world x/z and `KeyW` about (−0.57, −0.82). `KeyW`+`KeyA` heads about 10° north of west and `KeyS`+`KeyD` about 10° south of east. Read `player()` after each hold and correct.

**Click an entity.** A left click on the play field acts on what it points at: an NPC within speaking distance (2 m) is asked to go on past its greeting, and one further away ignores the click. A Heiler's click on another player tends them, and anything else is a swing toward the cursor. `screenPoint(id)` is where an entity's body is drawn on the page, a fallen body where it lies, so a click can be aimed at it. The character faces the cursor. A swing aims where the `pointerdown` lands, so it needs no `pointermove` or frame's wait before it.

```bash
agent-browser eval --stdin <<'JS'
(() => {
  const canvas = document.querySelector('canvas')
  const npc = window.somnio.entities().find((e) => e.kind === 'npc')
  const at = window.somnio.screenPoint(npc.id)
  const init = { clientX: at.x, clientY: at.y, button: 0, bubbles: true }
  canvas.dispatchEvent(new PointerEvent('pointerdown', init))
  window.dispatchEvent(new PointerEvent('pointerup', init))
  return { npc: npc.id, at }
})()
JS
```

A swing repeats at the swing rhythm for as long as the button is down, so send the `pointerup` when one swing is all the step needs. To keep one held, withhold the `pointerup` and give every `pointermove` sent meanwhile `buttons: 1`: a constructed event defaults to `buttons: 0`, which reads as the left button having come up and ends the hold. `agent-browser click` takes a selector, not coordinates, so it cannot be aimed at an entity.

**Trigger NPC dialog.** Dialog arrives as a `serverSay` frame — there is no dialog-specific verb — so it lands in the chat scrollback. Walk within 2 m of the NPC and it greets the player with its first line, unasked: once per approach, and not again within 30 s. Clicking it as above brings its remaining lines, a few seconds apart, and opens a master's or the shopkeeper's panel (`window.somnio.servicePanel()`).

```bash
agent-browser eval 'window.somnio.entities().filter((e) => e.kind === "npc")'
# hold the direction key until the player is within 2 m, then:
agent-browser wait --fn 'window.somnio.chatHistory().length > 0'
agent-browser eval 'window.somnio.chatHistory().at(-1)'
```

**Watch the splash.** Before login the world behind the pre-login screens plays the splash reel: ten shots of 6–8 s joined by a half-second dip to dark, then from the first again. It needs no server. It stops when a session attaches, and its last frame stays until the player's body is placed. Poll `window.somnio.splashShot()` to see which shot is up and wait for the next, and screenshot each: `agent-browser screenshot` captures the reel, the 50% veil over it, and the wordmark. Under `prefers-reduced-motion: reduce` it holds the first shot, `town`. Emulate that with `agent-browser set media light reduced-motion` and confirm with `matchMedia('(prefers-reduced-motion: reduce)').matches`. The client reads it once at startup, so set it before opening the page or reload after.

**Screenshot.** `agent-browser screenshot --full <path>` captures the WebGL world and the DOM panels over it in one image. A capture is at 1x device scale unless the viewport says otherwise. Judge fine detail, such as where two outlines join, at 2x: `agent-browser set viewport <width> <height> 2`. Set it before opening the page. On an open page, change the size along with the scale, or reload. The client follows a real zoom or a move to another display, but a `set viewport` that changes only the scale fires neither `resize` nor the media-query change the client watches, so the world stays drawn at the old scale. Confirm with `document.querySelector('canvas').width`, which reads twice the canvas's `clientWidth` at 2x; `window.devicePixelRatio` reads `2` even while the world is still drawn at 1x. Enlarged, a 1x capture shows lines as joined that are visibly broken on a 2x display.

**Zoom.** Use real wheel input over the bare play field. The client ignores a wheel event while the pointer is over a panel, so a `WheelEvent` dispatched from `eval` after the pointer last rested on a panel zooms nothing. A negative delta zooms in, toward `zoomFactor()` 2.0:

```bash
agent-browser mouse move 700 450   # a point on the canvas, clear of the panels
agent-browser mouse wheel -200
agent-browser eval 'window.somnio.zoomFactor()'
```

**German UI.** Open a session with the browser's accepted language set; `--lang` alone is ignored. `--args` applies only when the session's browser launches, and splits on commas. `agent-browser --session de --args "--accept-lang=de-DE" open 'http://localhost:17669/'`, then confirm `agent-browser --session de eval 'navigator.languages'` reads `["de-DE"]`.

**Two players in view of each other.** Separate `agent-browser` sessions get separate `localStorage`, so each holds its own session token.

```bash
agent-browser --session a open 'http://localhost:17669/'
agent-browser --session b open 'http://localhost:17669/'
# log each in as a different account, then from a:
agent-browser --session a eval 'window.somnio.entities().filter((e) => e.kind === "peer")'
```

A client holds the entities in its own sector and the sectors touching it, so two players see each other in the same or in adjacent outdoor sectors and lose each other two sectors apart. Use this for anything needing an independent observer — that a peer's position matches what the walker believes, or that a peer walking out of view is removed. A peer's position arrives in a batched `moves` frame about ten times a second and is drawn interpolated, so compare with a tolerance.

The client's own position is predicted, not authoritative. The server sends a `correction` for self when it rejects a move and when the player falls. An unmodified client has a move rejected only when its reports are held back for longer than the movement allowance covers (two seconds' worth at a little over running speed) and then arrive together.

**Log Out Other Browsers.** The game menu offers it only while the player is in the world and another browser remembers the account. To make it appear, log the account in with "Remember password" in a second session and close that session with `agent-browser --session <name> close`, not Leave Game, which revokes its token. Wait for the server to drop it as Step 4 describes, then log in the session under test. The entry opens a dialog of its own (`window.somnio.overlay()` reads `'logOutOtherBrowsers'`) with "Log Them Out" and "Cancel". Confirming closes it, and `chatHistory()` ends with the count ("Einen anderen Browser abgemeldet." / "Logged out one other browser.").

**More players without more browsers.** When a case needs several bodies on screen at once (crowded plaques or bubbles), run each extra player as a small Node script beside one browser session. Node 24 has a global `WebSocket`. Register the accounts over the wire first (Step 3), then per player:

```js
const [nickname, dx, dz, line] = process.argv.slice(2)
const ws = new WebSocket('ws://127.0.0.1:17662/ws')
const send = (tag, payload) => ws.send(JSON.stringify({ tag, payload }))
let selfId
ws.onmessage = ({ data }) => {
  const { tag, payload } = JSON.parse(data)
  if (tag === 'hello') send('login', { nickname, password: '<password>' })
  if (tag === 'enterSpace') selfId = payload.selfId
  if (tag === 'correction') console.log(nickname, 'step refused, still at', payload.x, payload.z)
  if (tag === 'entity' && payload.id === selfId) {
    // A step under 7.5 m onto open floor stays inside the movement allowance.
    setTimeout(() => send('move', { x: payload.x + Number(dx), z: payload.z + Number(dz), facing: 0, gait: 'walk' }), 500)
    if (line) setInterval(() => send('clientSay', { text: line, kind: 'say' }), 4000)
  }
}
```

```bash
node <dir>/bot.mjs <nickname> 0.7 0.3 'Hallo' & echo $!   # nickname, step east, step south, a line to repeat
```

New accounts start at the starter spawn in `EdariaBibliothek`, so log the browser player in there too. Run the bots with the sandbox off, since they dial a local port. Keep the script in a fixed directory that both sandboxed and unsandboxed commands can read, not under `$TMPDIR`, which names a different directory inside and outside the sandbox. When done, stop the bots by the PIDs `echo $!` printed, then delete the accounts. Deleting an account removes its character and sessions: `docker exec somnio-pg psql -U postgres -d somnio -c "DELETE FROM accounts WHERE name IN ('<nickname>', ...);"`.

For a crowd of hundreds, hold every bot's socket in one Node process rather than one process per bot, and open them in batches that log in before the next batch dials. The server holds at most 128 sockets awaiting login, and 8 per address while `SOMNIO_TRUST_PROXY` is set (the compose topology sets it). It answers past those caps with 503 or 429, and closes a socket not logged in within 30 s. Register the accounts over the wire one after another first, give them a shared name prefix, and delete them afterwards with `DELETE FROM accounts WHERE name LIKE '<prefix>%'`. To count or size the frames the browser player receives, wrap the `onmessage` setter on `WebSocket.prototype` from an `eval` before logging in, so the game's socket reports each frame to the wrapper. A remembered session opens its socket at page load, before any `eval` runs, so log in without "Remember password" for this, or install the wrapper with `--init-script` as Step 4 describes.

**Hide the tab.** Open the session `--headed` from its first command. There, a second tab in front fires `visibilitychange` on the game page and stops its `requestAnimationFrame`; switching back makes it visible again. Tab ids are the `t<n>` ids `tab list` prints, and positional integers are refused. An `eval` sent while the blank tab is in front runs in that tab, so switch back before reading `window.somnio`.

```bash
agent-browser --session a --headed open 'http://localhost:17669/'
# log in, then:
agent-browser --session a tab new about:blank   # the game tab is now hidden
agent-browser --session a tab t1                # t1 in a fresh session; otherwise the game's id from `tab list`
```

Hiding clears held keys, so dispatch a held key again after switching back. Peers, speech bubbles, and raise rings follow the clock, so on return they show where things stand now. To see what the first frames back draw, install a `visibilitychange` listener before hiding that, on `visible`, records a sample (say a peer's `entities()` position) on each `requestAnimationFrame` for a few hundred milliseconds, and read the samples after switching back.

Headless, hold the frames instead: a hidden tab is a page whose `requestAnimationFrame` stops while its socket keeps delivering, so a login can complete there. Dispatching `visibilitychange` alone is no substitute, because the frame loop keeps running and catches up before anything is read.

```bash
agent-browser eval --stdin <<'JS'
window.__realRAF = window.requestAnimationFrame
window.__heldFrames = []
window.requestAnimationFrame = (callback) => { window.__heldFrames.push(callback); return 0 }
Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
document.dispatchEvent(new Event('visibilitychange'))
JS
# act while hidden, then return and let the frames run again:
agent-browser eval --stdin <<'JS'
delete document.visibilityState
document.dispatchEvent(new Event('visibilitychange'))
window.requestAnimationFrame = window.__realRAF
window.__heldFrames.splice(0).forEach((callback) => window.__realRAF(callback))
JS
```

What the frame loop writes to the page, such as the splash dip's opacity, changes only on a frame, so read it inside a `requestAnimationFrame` callback scheduled after the restore, not straight after the return. `splashShot()` is current at once, because the return itself halts a reel whose session has attached.

**Speech bubbles.** Log two players in as above, put them where the case needs, and have the speaker type `/y <text>` into the chat field and press Enter. Both new characters start inside `EdariaBibliothek`, where each draws the other and the bubble hangs over the speaker's head. With several speakers together, each bubble takes the nearest spot round its speaker's head that is clear of heads, other bubbles, and panels, and glides back over the head once that is free. The bubbles are painted on their own canvas (`#somnio-bubbles`) over the world and under the panels. Only a screenshot shows them: `snapshot` finds no element for them, and `window.somnio` has no call that reports them.

To read what the scene computed, such as where each bubble was placed and in which mode, wrap a scene method from an `eval` on the dev server. Inside an async IIFE, `const { WorldScene } = await import('/src/scene/worldScene.ts')` returns the module the page runs, so replacing `WorldScene.prototype.placedBubbles` with a wrapper that stores its result on `window` records every frame's placements. The working tree stays untouched, and a page reload removes the wrapper. Restart Vite first when `worldScene.ts` or anything it imports was edited since Vite started: the page then loads the module under a `?t=` URL, the plain import returns a second copy, and the wrapper on it never runs.

- **Pinned at the edge.** Put both outdoors, further apart than the screen shows (12 m is enough at the default zoom) and within a yell's 80 m. The bubble pins on the line toward the speaker, as near the screen's edge as is clear of heads, other bubbles, and panels. The listener's chat line names a compass direction.
- **Past a room's wall.** Keep the listener in the room and put the speaker outdoors within about 30 m of that room's door. Collapse the listener's chat panel first with its toggle button: while it is open it covers the spot past the starter room's wall for all but the shortest lines, so the bubble pins at the edge and the chat line names a direction. The listener has to stand just inside the door: walking in through the door lands them on its arrival point, 0.8 m in. Further in, at the default zoom, the spot past the wall no longer fits on screen and the bubble falls back to the edge pin. A voice placed by the door names no direction in chat, which tells the two placements apart, and it always arrives crumbled.

Relocate with the recipe below. Its `sectorName()` check cannot confirm a move within the starter room, since a lost race and a self-heal land there too, so check `player()` instead.

**Relocate the character.** The server holds the gameplay session for a few seconds after the page goes away, because the Vite proxy keeps the upstream WebSocket alive. Both the disconnect checkpoint and the periodic 30 s checkpoint write the character row, so a DB `UPDATE` issued too early is silently overwritten, and an immediate re-login fails with "Du bist bereits angemeldet." / "Already logged in." on the login card. When a re-login still fails that way after the wait, restart Vite: its proxy can keep the old upstream socket open. Order matters, and the post-login `sectorName()` read is the success predicate. The Notes' no-sleep rule is suspended here only because no page exists to poll between close and login:

```bash
agent-browser close; sleep 8   # closes only the default session (--session a/b need their own close)
docker exec somnio-pg psql -U postgres -d somnio -c "UPDATE characters SET space='outdoors', position_x=20, position_z=-15 WHERE name='<nickname>';"
agent-browser open 'http://localhost:17669/'
# log in, then: agent-browser eval 'window.somnio.sectorName()'  — expect 'Nordwiese'; the old sector
# here means the checkpoint won the race; close and repeat. A position inside geometry or outside
# every sector self-heals to the starter spawn in EdariaBibliothek with no error, so pick open ground.
```

`space` and `position_x`/`position_z` hold what `spaceId()` and `player()` report: a space id, and metres in that space's coordinates. `(20, -15)` is open ground in the Nordwiese, whose origin is `(5.12, -30.72)`. The Nordwald north of it, at origin `(5.12, -61.44)`, holds a nightmare spawn area: a player placed inside it, as at `(20, -46)`, is struck and falls within half a minute. An interior's positions run from its own north-west corner.

**Give a character a role, ranks, or pools.** Write under the same rule as relocating: close both players' sessions (and stop any bot) and wait for the checkpoint first, or it overwrites the row. Several statements go in one heredoc, and `docker exec` needs `-i` for it: without `-i` the heredoc never reaches psql, which prints nothing and applies nothing. This makes `<healer>` a Heiler with `touch` at rank 2 and `drawing-back` at rank 1 (the ranks the game requires for raising) and the Mondstein in the right hand, in inventory slot 2. It also lays `<dreamer>` down fallen (a partial `health_current` gives a mend something to do instead). The upserts make the block safe to run again:

```bash
docker exec -i somnio-pg psql -U postgres -d somnio -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
UPDATE characters SET role='heiler' WHERE name='<healer>';
INSERT INTO character_ranks (character_id, teaching_id, rank, practice)
  SELECT id, t, r, 0 FROM characters, (VALUES ('touch', 2), ('drawing-back', 1)) AS v(t, r) WHERE name='<healer>'
  ON CONFLICT (character_id, teaching_id) DO UPDATE SET rank = EXCLUDED.rank;
UPDATE inventory_rows SET equipped_hand=NULL WHERE character_id=(SELECT id FROM characters WHERE name='<healer>');
INSERT INTO inventory_rows (character_id, slot, item_id, quantity, equipped_hand)
  SELECT id, 2, 'mondstein', 1, 'right' FROM characters WHERE name='<healer>'
  ON CONFLICT (character_id, slot) DO UPDATE SET item_id = EXCLUDED.item_id, quantity = 1, equipped_hand = 'right';
UPDATE characters SET health_current=0 WHERE name='<dreamer>';
COMMIT;
SQL
```

After logging in, `window.somnio.lucidity().role` on the healer reads `'heiler'` and `window.somnio.energy().healthCurrent` on the dreamer reads `0`. Anything else means a checkpoint won the race, so close and repeat. A raised dreamer stands again, and one who wakes is also moved to the inn, so a retry re-runs the block, plus the relocation recipe after a wake.

**Set the time of day.** No admin verb sets the clock. Stop the server first: it saves the clock about every 15 s and on shutdown, so an `UPDATE` under a running server is overwritten. Then write the row and start the server again:

```bash
docker exec somnio-pg psql -U postgres -d somnio -c "INSERT INTO world_clock (id, world_seconds) VALUES (TRUE, 14515225200) ON CONFLICT (id) DO UPDATE SET world_seconds = EXCLUDED.world_seconds;"
```

`14515225200` is 07:00 on the first day of year 500; add 3600 per hour. World time runs at four times wall time, so an hour passes in 15 minutes. Outdoor light follows the clock; an interior is lit by its own `brightness`.

**Render a staged scene without a server.** To screenshot any sector with figures placed by hand, such as stills for a prototype, draw it from an `eval` on the dev page. It needs no gameplay server and no login. Wait for Step 4's prewarm gate first, then run an async IIFE from a script in the session scratchpad with `agent-browser eval --stdin`. The working tree stays untouched.

- **Modules.** Import `/src/scene/worldScene.ts`, `/src/scene/modelAssets.ts`, and `/src/scene/cameraRig.ts`. `@somnio/core` alone has no fixed dev URL, because Vite serves it from a machine-specific `/@fs/<absolute path>/packages/core/src/index.ts`: fetch `/src/scene/worldScene.ts` as text, take the import URL that ends in `packages/core/src/index.ts`, and import that.
- **Sectors.** Fixtures load from core's `/@fs` URL with `src/index.ts` replaced by `fixtures/sectors/<Name>.somnio-sector`. Read each with `core.readSectorFile(text, name)` and draw it with `scene.addSector(core.sectorView(sector))`.
- **Scene and renderer.** Build `new WorldScene(new HttpModelAssets(registry), registry, innerWidth / innerHeight)` with `registry = core.bundledModelRegistry()`, and `await scene.prewarm()`. Draw through `createWorldRenderer(canvas)` and `sizeWorldRenderer` onto a fixed, full-window canvas above the page.
- **Figures.** Call `scene.placeEntity({ id, kind, characterModelId, name, position: { x, z }, facing, gait: 'walk', radius: 0.3, condition: 'hale', service: undefined })`. Stage dreamers as `'peer'`: the camera follows a `'player'` every tick and overrides the framing. With no `enterSpace` the scene has no ground, so every figure stands at height 0, even on stairs or a plinth.
- **Framing.** Set `scene.camera`'s `left`/`right`/`top`/`bottom` from the rig's `frustumBounds(scale, aspect)`, its position from `cameraPosition({ x, y: 0, z })`, then `lookAt`, `updateProjectionMatrix`, and `scene.anchorSunShadow({ x, z })`.
- **Light.** Call `scene.setClock(worldSeconds)`, counting from the 07:00 value in the recipe above: subtract or add 3600 per hour.
- **Capture.** Call `scene.tick(dt)` and `renderer.render(scene.scene, scene.camera)` for about 30 frames before the screenshot, so models resolve and pose.

**Verify the asset pack resolved.** `agent-browser eval 'window.somnio.placeholderObjectCount()'` — non-zero means models are missing or a registry id has no matching stem. Read it only once Step 4's gate has passed: with no scene it returns `0`, which is indistinguishable from success.

## Notes

- Wrap any `eval --stdin` script that awaits in an async IIFE. `eval` runs a script body, not a module, so top-level `await` and top-level `return` both throw a `SyntaxError`.
- An `eval` whose promise awaits longer than about 25 s never returns, and its `agent-browser` process hangs. Keep each eval's awaits to 12 s or less, and run several evals from the shell for a longer hold. A key held down stays held across evals.
- Gate every wait on a predicate over `window.somnio`, not a sleep. Model prewarm makes first-load timing variable.
- A walk that silently does nothing is usually the input gate, not broken input. The frame loop requires `attached && no overlay && chat not focused`; check `window.somnio.overlay()` first. Each frame's elapsed time is clamped to 100 ms, so a stalled tab resumes the player's walk without teleporting.
- A fallen player does not move at all (their own entry in `entities()` has `condition: 'fallen'`), and a winded one (`winded()`) is held to `walk` whatever key is held.
- Focusing the chat input closes the gate and clears held keys, so a movement key held across the focus change stops the character.
- Activate a DOM control with a real pointer gesture on a ref from a snapshot: `agent-browser click @ref` for a panel button, `agent-browser dblclick @ref` for an inventory row (a single click does nothing to a row). A control replaced by a re-render between press and release never gets its click. A real gesture shows that, and `element.click()` in an `eval` hides it, because it lands in one tick. `agent-browser dblclick` sends one click with `detail: 2`, not two clicks, so a double click on a button (a trade the lock should let through once) needs `mouse move` to the button's centre, then `mouse down` and `mouse up` twice, in one `agent-browser batch`.
- Test a panel while balance is recovering, when `energy` frames arrive several times a second. With bare hands or a dagger, standing recovery outpaces a held swing, and one run drains little. Drain with repeated short runs back and forth within 2 m of the NPC, holding a swing, then open the panel with a click at the NPC and press its button in the very next call: balance is back to full in about eight seconds.
- A master's or the shopkeeper's panel covers the Players and Items lists, so a double-click on an Items row lands on the panel. Close the panel first. When the test needs the panel open, dispatch the event on the row element from an `eval`, which gives up the real-gesture check above. The panel's body scrolls and keeps its offset across rebuilds, so in a short window its first lines can be scrolled out of view; that is not a defect.
- `agent-browser mouse wheel` over the chat scrollback does not scroll it in a headless session: its `scrollTop` is unchanged even when read after a pause. To scroll it to a given offset, set its `scrollTop` from an `eval` (`document.querySelector('.chat-scrollback').scrollTop = 40`). The play field's zoom still takes the wheel.
- Navigating the game tab to `about:blank` (`agent-browser open about:blank`) leaves its gameplay socket open, and the server keeps the player logged in. To log that player in again, close the session (`agent-browser --session <name> close`) and wait as in the relocation recipe.
- Bodies standing on one spot (a bot on the spawn) overlap on screen, and a click at `screenPoint(id)` reaches the body nearer the camera. Aim a little beside it, on the side away from the other body, and confirm the click reached the intended entity: `tending()` for a tend, `servicePanel()` for a master or the shopkeeper.
- A Mondstein reaches another player only within 0.85 m, centre to centre (`reachDistance` in `packages/core/src/combat.ts`). A Heiler placed by coordinates further off still tends, but never mends or raises. Place them about 0.6 m from the dreamer, and confirm the distance from `entities()` before waiting for a mend or a raise.
- Separate `agent-browser` calls are slow enough to miss a short server window, such as letting go before a 6 s raise finishes. Do the timed steps inside one `eval`, within the 12 s limit on its awaits.
- Esc opens the game menu during a session. While the player tends someone, the first Esc only lets go of them and the next opens the menu. On the version-skew overlay it goes to the login overlay, and there it is inert — nothing is behind it to resume to.
- `chatHistory()` returns localized text and the client picks German from `navigator.languages`. Assert on substrings unless the locale is pinned (the German UI recipe pins it).
- Vite hot-reloads code changes. An edit to a `.ts` file made while a session is attached reloads the page: a client that did not check "Remember password" is back on the login overlay, the earlier snapshot's refs are dead, and the fields may still hold their text. After an asset-pack change, re-run `Scripts/bundle-web-assets.sh` and restart Vite — the served asset root is a copy, enumerated at startup.
- When Step 4's gate times out, read the visible notice: `agent-browser eval 'document.querySelector(".blocking-notice:not(.hidden)")?.textContent'`. A WebGL or desktop-only notice means the browser cannot render the world — rerun with `agent-browser --headed` so a real GPU context is available.
- On teardown, close the browser sessions (`agent-browser close`, plus `--session a` / `--session b` for the two-player recipe and `--session de` for the German UI) and stop Vite, but keep the Postgres container so the dev character persists (see `/somnio-server`).
