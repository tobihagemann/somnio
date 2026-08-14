---
name: somnio-web
description: "Serve the Three.js browser client locally against the dev server and drive it with agent-browser — log in, walk, screenshot, and read world state headlessly for automated verification. Use when the user asks to run, open, test, or screenshot the web/browser client, or to verify a gameplay or UI change in the browser. For the native macOS client, use the somnio-player skill instead."
---

# Run Browser Client (Local Dev)

Serves the browser client against the local dev server and drives it with `agent-browser`.

## Step 1: Start the dev server

The client needs a running backend. Stand up the local server on port 8090 first — run the `/somnio-server` skill.

## Step 2: Serve the client

Node 24.17.0 or newer (`Web/package.json` pins `engines`, `Web/.nvmrc` carries the version).

Without an asset pack the page loads and plays with placeholder models, an untextured floor, and unstyled panels. To render the real world, build the served asset root from the `somnio-assets` working tree **before** starting Vite — the dev server enumerates `Web/public` at startup, so a pack added afterwards is not served until restart:

```bash
SOMNIO_ASSET_SOURCE="<asset-pack-root>" SOMNIO_WEB_ASSET_DEST=Web/public/assets Scripts/bundle-web-assets.sh
cd Web && npm ci && npm run dev
```

Vite serves on `http://localhost:5173` and proxies `/ws` to `127.0.0.1:8090`. The proxy is what matters: the client derives its gameplay endpoint from the page origin, so `/` and `/ws` have to share one. Point the proxy elsewhere with `SOMNIO_DEV_GAMEPLAY_ORIGIN`.

The destination is `Web/public/assets` for the dev server only. Vite serves `Web/public` and `Web/` and never `dist/`, so writing the pack to `Web/dist/assets` leaves every model and texture 404ing with no error but a placeholder world. The image build uses `dist` because nginx serves that directory.

To exercise production's routing instead of the Vite proxy, run the container topology — `proxy` serves the client at `/` and routes `/ws`, `/admin`, and `/health` to the server:

```bash
mkdir -p assets sectors
cp Tests/SomnioMapFixturesTestSupport/MapFixtures/*.somnio-sector sectors/
docker compose -f docker-compose.example.yml build --build-arg MARKETING_VERSION=0.0.0-local
docker compose -f docker-compose.example.yml up --wait   # http://127.0.0.1:8000/?debug=1
```

That topology serves a production build, so `?debug=1` is required — without it `window.somnio` is undefined and every recipe below fails.

## Step 3: Create an account

Register through the UI: click "If you don't have an account, click here!", fill nickname, both password fields, and **email** (the server rejects an empty one), then submit. A successful sign-up returns to the login overlay with the nickname and password already filled in. Fresh characters spawn in the `EdariaBibliothek` starter sector.

Re-snapshot after every overlay change — the refs are per-snapshot, and typing against stale refs from the previous overlay silently fills the wrong fields.

To skip the UI entirely, register over the wire instead: open a WebSocket to `ws://127.0.0.1:8090/ws`, receive the hello frame, then send `{"tag":"register","payload":{"nickname":"...","password":"...","passwordRepeat":"...","characterClass":0,"gender":0,"email":"..."}}` (password ≥ 8 UTF-8 bytes; expect `{"tag":"registerResult","payload":{"result":0}}`).

## Step 4: Open the client and log in

```bash
agent-browser open 'http://localhost:5173/'
agent-browser wait --fn 'document.querySelector(".blocking-notice:not(.hidden)") === null && window.somnio?.overlay() === "login"'
agent-browser snapshot -i          # nickname, password, Remember password, and Log In refs
agent-browser type <nickname-ref> '<nickname>'
agent-browser type <password-ref> '<password>'
agent-browser click <log-in-ref>
agent-browser wait --fn 'window.somnio.connectionState() === "attached"'
```

That first predicate does two jobs, and both are load-bearing. The model prewarm shows a progress notice, so waiting it out is what keeps `snapshot` from running against a half-built page. And `overlay()` alone is not a readiness signal: it initializes to `login` before anything is presented, so on a host with no WebGL or a handheld viewport it answers `login` while the page actually shows a blocking notice and no form exists. Checking for a visible notice covers both.

`attached` is reached on the `mainCharacter` frame, which promotes the session and starts the gameplay tick.

Checking "Remember password" stores a session token in `localStorage`, so a reload resumes without re-entering credentials.

`agent-browser type` **appends** to a pre-filled field. The overlays keep field values for the page lifetime, and Step 3's sign-up handoff deliberately pre-fills the login form — so registering and then running the login block verbatim produces doubled text and a "Falsche Zugangsdaten." / "Bad credentials." chat line. Clear the fields first (`agent-browser eval 'document.querySelectorAll("input").forEach(i => { i.value = "" })'`) or open a fresh page before typing.

## Debug API

`window.somnio` is read-only and exposes what the canvas cannot show. It is present in dev builds and requires `?debug=1` in production, because `entities()` reports every peer's name and position in the sector.

| Call | Returns |
|---|---|
| `connectionState()` | `'disconnected'` \| `'awaitingHello'` \| `'awaitingLoginResult'` \| `'awaitingEnterSector'` \| `'attached'` |
| `player()` | `{ x, y, facing, tempo, name }`, or `undefined` before placement |
| `sectorName()` | loaded sector id, e.g. `'EdariaMitte'` |
| `entities()` | `[{ id, kind, name, x, y }]` for players, peers, NPCs, monsters |
| `chatHistory()` | localized strings, exactly what the chat panel shows |
| `placeholderObjectCount()` | objects still rendering a placeholder model; `0` when there is no scene at all |
| `cameraScale()` | vertical half-height of the orthographic frustum, or `undefined` with no scene |
| `overlay()` | `'login'` \| `'registration'` \| `'about'` \| `'updateRequired'` \| `'options'` \| `'gameMenu'` \| `undefined` |
| `zoomFactor()` | session zoom, 0.5–2.0 |

`<html data-somnio-build>` carries the build stamp (`somnio-web <version>`) with no `?debug=1` gate, so any loaded page identifies its build. It is set by `main.ts` once the bundle runs, not baked into the served HTML — read it with `agent-browser eval 'document.documentElement.dataset.somnioBuild'`, since `curl` of the same URL returns a bare `<html lang="en">`.

## Recipes

**Walk.** Movement is sampled from held keys by the frame loop, so hold the key across real time rather than tapping it. `agent-browser press` sends a keydown/keyup pair, which advances one frame's worth of pixels — enough to prove input is wired, not enough to travel.

```bash
agent-browser eval --stdin <<'JS'
(async () => {
  const before = window.somnio.player()
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }))
  await new Promise((resolve) => setTimeout(resolve, 1000))
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }))
  const after = window.somnio.player()
  return { before, after, moved: before.x !== after.x || before.y !== after.y }
})()
JS
```

Hold `ShiftLeft` to run and `AltLeft` to walk; the tempo rule is left-side keys only. Arrow keys drive the same four direction bits as WASD.

**Trigger NPC dialog.** Dialog arrives as a `serverSay` frame — there is no dialog-specific verb — so it lands in the chat scrollback. Walk into the NPC's feet box; the bump fires on contact and blocks the step.

```bash
agent-browser eval 'window.somnio.entities().filter((e) => e.kind === "npc")'
# hold the direction key until the positions converge, then:
agent-browser wait --fn 'window.somnio.chatHistory().length > 0'
agent-browser eval 'window.somnio.chatHistory().at(-1)'
```

**Screenshot.** `agent-browser screenshot --full <path>` captures the WebGL world and the DOM panels over it in one image.

**Two players in one sector.** Separate `agent-browser` sessions get separate `localStorage`, so each holds its own session token — the browser analogue of `SOMNIO_PROFILE`.

```bash
agent-browser --session a open 'http://localhost:5173/'
agent-browser --session b open 'http://localhost:5173/'
# log each in as a different account, then from a:
agent-browser --session a eval 'window.somnio.entities().filter((e) => e.kind === "peer")'
```

Use this for anything needing an independent observer — that a peer's position matches what the walker believes, or that leaving a sector removes them. The client's own position is not authoritative: the server volunteers `serverPosition` for self only as a `snapBack` after a rejected move.

**Relocate the character to another sector.** The server holds the gameplay session for a few seconds after the page goes away (the Vite proxy keeps the upstream WebSocket alive), and both the disconnect checkpoint and the periodic 30 s checkpoint write the character row — so a DB `UPDATE` issued too early is silently overwritten, and an immediate re-login fails with "Du bist bereits angemeldet." / "Already logged in." in chat. Order matters, and the post-login `sectorName()` read is the success predicate (the Notes' no-sleep rule is suspended here only because no page exists to poll between close and login):

```bash
agent-browser close; sleep 8   # closes only the default session (--session a/b need their own close)
docker exec somnio-pg psql -U postgres -d somnio -c "UPDATE characters SET current_sector='Nordwald', position_x=1024, position_y=768 WHERE name='<nickname>';"
agent-browser open 'http://localhost:5173/'
# log in, then: agent-browser eval 'window.somnio.sectorName()'  — the old sector here means the
# checkpoint won the race; close and repeat. An unwalkable position self-heals to a spawn point,
# so pick coordinates on open floor or the character lands at spawn with no error.
```

**Verify the asset pack resolved.** `agent-browser eval 'window.somnio.placeholderObjectCount()'` — non-zero means models are missing or a registry id has no matching stem. Read it only once Step 4's gate has passed: with no scene it returns `0`, which is indistinguishable from success.

## Notes

- Wrap any `eval --stdin` script that awaits in an async IIFE. `eval` runs a script body, not a module, so top-level `await` and top-level `return` both throw a `SyntaxError`.
- Gate every wait on a predicate over `window.somnio`, not a sleep. Model prewarm makes first-load timing variable.
- A walk that silently does nothing is usually the input gate, not broken input. The frame loop requires `(attached || awaitingEnterSector) && no overlay && chat not focused`; check `window.somnio.overlay()` first. Each frame's elapsed time is clamped to 100 ms, so a stalled tab resumes without teleporting.
- Focusing the chat input closes the gate and clears held keys, so a movement key held across the focus change stops the character.
- Esc opens the game menu during a session and is inert on the login and version-skew overlays — there is nothing behind them to resume to.
- `chatHistory()` returns localized text and the client picks German from `navigator.languages`. Assert on substrings unless the locale is pinned.
- Vite hot-reloads code changes. After an asset-pack change, re-run `Scripts/bundle-web-assets.sh` and restart Vite — the served asset root is a copy, enumerated at startup.
- When Step 4's gate times out, read the visible notice: `agent-browser eval 'document.querySelector(".blocking-notice:not(.hidden)")?.textContent'`. A WebGL or desktop-only notice means the browser cannot render the world — rerun with `agent-browser --headed` so a real GPU context is available.
- On teardown, close the browser sessions (`agent-browser close`, plus `--session a` / `--session b` for the two-player recipe) and stop Vite, but keep the Postgres container so the dev character persists (see `/somnio-server`).
