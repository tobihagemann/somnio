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

Start Vite with the sandbox disabled, and restart one that was started sandboxed. A Vite inside the command sandbox misses file-change events and keeps serving its first transform of an edited module, so a reload shows stale code with no error. Before judging a change in the browser, confirm the served module carries a runtime identifier or string literal the change adds, since types and most comments are stripped: `curl -s http://localhost:17669/src/<path>.ts | grep -c '<identifier>'`. A core or protocol module is served under `/@fs/<absolute path>/packages/<pkg>/src/<path>.ts` instead.

Without an asset pack the page loads and plays with placeholder models, unstyled panels, and no wordmark or favicon. To render the real world, build the served asset root from the `somnio-assets` working tree **before** starting Vite; a pack added afterwards is not served until restart:

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

Register through the UI: click "If you don't have an account, click here!", fill the email and both password fields, then submit. The account's characters, each with a name and a people, are made on the character card after login (Step 4). The email must look like an address (one `@`, a dot in the domain), and `example.invalid` addresses do. A successful sign-up returns to the login overlay with the email and password already filled in.

Re-snapshot after every overlay change — the refs are per-snapshot, and typing against stale refs from the previous overlay silently fills the wrong fields.

To skip the UI entirely, register over the wire instead: open a WebSocket to `ws://127.0.0.1:17662/ws`, receive the hello frame, then send `{"tag":"register","payload":{"email":"...","password":"...","passwordRepeat":"..."}}` (password ≥ 8 UTF-8 bytes; expect `{"tag":"registerResult","payload":{"result":"ok"}}`, or `emailExists` for a taken email).

To make a character, send `{"tag":"login","payload":{"email":"...","password":"..."}}` on the same socket, wait for the `characters` frame, then `{"tag":"createCharacter","payload":{"name":"...","people":"vigils"}}` (`people` is one of `vigils`, `sopors`, `umbrae`, `lumina`). A created character is answered with the new `characters` list, then `{"tag":"characterResult","payload":{"result":"ok"}}`. A character's name goes through the name policy and is unique among all characters, whatever their account. An account holds at most four.

## Step 4: Open the client and log in

```bash
agent-browser open 'http://localhost:17669/'
agent-browser wait --fn 'document.querySelector(".blocking-notice:not(.hidden)") === null && window.somnio?.overlay() === "login"'
agent-browser snapshot -i          # email, password, Remember password, and Log In refs
agent-browser type <email-ref> '<email>'
agent-browser type <password-ref> '<password>'
agent-browser click <log-in-ref>
agent-browser wait --fn 'window.somnio.overlay() === "characters"'
agent-browser snapshot -i          # the card: a Play and a Delete per dreamer, Log Out, New Dreamer
```

That first predicate does two jobs, and both are load-bearing. The model prewarm shows a progress notice, so waiting it out is what keeps `snapshot` from running against a half-built page. And `overlay()` alone is not a readiness signal: it initializes to `login` before anything is presented, so on a host with no WebGL, or in a coarse-pointer session at an upright phone viewport, it answers `login` while the page actually shows a blocking notice in front of everything. Checking for a visible notice covers both.

A password login always lands on the character card ("Your Dreamers"), whose `connectionState()` reads `awaitingEnterSpace`. A new account has no dreamers yet, so make one first; once the account holds four, New Dreamer gives way to a note:

```bash
agent-browser click <new-dreamer-ref>
agent-browser wait --fn 'window.somnio.overlay() === "newCharacter"'
agent-browser snapshot -i          # Name, People, Cancel, Create
agent-browser type <name-ref> '<character>'
agent-browser select <people-ref> vigils   # vigils, sopors, umbrae, or lumina
agent-browser click <create-ref>
agent-browser wait --fn 'window.somnio.overlay() === "characters"'
```

A refused name keeps the form up with the reason under the fields. Then play a dreamer from the card:

```bash
agent-browser snapshot -i
agent-browser click <play-ref>     # the Play in the dreamer's row
agent-browser wait --fn 'window.somnio.connectionState() === "attached"'
agent-browser wait --fn 'window.somnio.player() !== undefined'
```

A new character starts at the starter spawn in `EdariaLibrary`. Delete in a row opens a confirmation of its own (`overlay()` reads `'deleteCharacter'`) with Delete and Cancel. Log Out on the card returns to the login card and revokes a remembered session, as Leave Game does.

`attached` is reached on the `enterSpace` frame, the first frame of every join, which promotes the session and starts the gameplay tick. That is a little before the world is on screen. The splash veil and the wordmark go, and the HUD appears, only once the player's own body is placed, which is what the last wait checks.

Checking "Remember password" stores a session token in `localStorage`, so a reload resumes without re-entering credentials. A resume skips the card and joins the dreamer played last; it shows the card only when none of the account's dreamers has been played yet, or joining the last one fails. The resume opens its socket at page load, before any `eval` runs, so to watch it start the observing session with `agent-browser --session <name> --init-script <file>`. The script is registered before the first navigation, and only when that session's browser launches. Read the `somnio.sessionToken` value from the session that issued it and set it in the observing one. Then close the issuing session with `agent-browser --session <issuer> close`, not Leave Game, which revokes the token. Give the server a few seconds to unregister the account before reloading the observing session; otherwise the resume retries and ends in "Du bist bereits angemeldet." / "Already logged in."

To test that retry itself, keep the issuing session connected while the observing one resumes. The retry is bounded at three retries 250 ms apart, so "Verbindung wird wiederhergestellt..." / "Reconnecting..." shows under the wordmark for under a second before the login card returns. A later `eval` finds only the card, so have the init script record `.splash-wordmark__status` as it changes and read that record afterwards. The element does not exist yet when the script runs, so poll for it or observe the whole document.

`agent-browser type` **appends** to a pre-filled field. The overlays keep field values for the page lifetime, and Step 3's sign-up handoff deliberately pre-fills the login form — so registering and then running the login block verbatim produces doubled text and "Falsche Zugangsdaten." / "Bad credentials." on the login card, under the form. Clear the fields first (`agent-browser eval 'document.querySelectorAll("input").forEach(i => { i.value = "" })'`) or open a fresh page before typing.

## Debug API

`window.somnio` is read-only and exposes what the canvas cannot show. It is present in dev builds and requires `?debug=1` in production, because `entities()` reports the name and position of every peer in view.

Positions are metres in the coordinates of the current space: `x` runs east, `z` south, and an outdoor position includes its sector's origin (the North Wood lies at negative `z`). `facing` is a heading in degrees, 0 = south and 90 = east.

| Call | Returns |
|---|---|
| `connectionState()` | `'disconnected'` \| `'awaitingHello'` \| `'awaitingLoginResult'` \| `'awaitingEnterSpace'` \| `'attached'` |
| `player()` | `{ x, z, facing, gait, name }` (`name` is the character's name; `gait` is `'walk'` \| `'jog'` \| `'run'`), or `undefined` before placement |
| `walk()` | the walk under way: `{ kind: 'path', destination: { x, z }, waypoints: [{ x, z }] }` (the waypoints left, the next first; empty until the path's search has run) or `{ kind: 'steer', toward: { x, z } }` while a held press steers, or `{ kind: 'leap', end: { x, z } }` while Lunge carries the player, or `undefined` while the player stands, and from a door until the player is placed in the space it leads to |
| `spaceId()` | `'outdoors'` for every outdoor sector, an interior's sector name otherwise; `undefined` before the first join |
| `sectorName()` | the sector the predicted position stands in, e.g. `'EdariaSquare'` |
| `entities()` | `[{ id, kind, name, x, z, condition, held?, rank?, trait? }]`; `kind` is `'player'` (self), `'peer'`, `'npc'`, or `'monster'`, `id` is a string (a character id, `npc:<sector>/<id>`, `monster:<n>`), `condition` is `'hale'` (full health), `'grazed'`, `'wounded'`, `'hurt'`, `'failing'`, or `'fallen'`, and `held` is what a dreamer's hands hold as base ids, `{ mainHand?, offHand? }` (`{ mainHand: 'sword', offHand: 'moonstone' }`), absent for an NPC or a nightmare. An elite nightmare also carries `rank: 'elite'` and `trait`, its trait's id (`'stony'` or `'shielded'`), and a boss (the Necromancer) `rank: 'boss'` with no `trait`, both absent for any other entity; `name` stays the kind's (`'Ghost'`), while its plaque and the target frame read "Stony Ghost" |
| `energy()` | the player's own pools as last sent: `{ healthCurrent, healthMax, balanceCurrent, balanceMax, spiritCurrent, spiritMax }` |
| `lucidity()` | `{ role?, ranks: [{ teachingId, rank, practice }], study? }` as last sent |
| `quests()` | the quest log as the last `quests` frame said, in its shape: `{ active: [{ questId, progress, definition? }], done: [questId], bounties: [{ day, land, monsterKind, objective, count, reward: { coins, gear } }] }`. `progress` holds a count for each objective in order (a `visit` or a `reach` is 1 once met), `definition` is a bounty's, and `bounties` are the world day's. A quest id is a committed one (`'newcomer-errand'`, `'restless-graves'`, `'cracked-skulls'`, `'into-the-crypt'`, `'fighter-trial'`, `'healer-trial'`, `'mystic-trial'`, `'follow-through-task'`, `'drawing-back-task'`) or a bounty's, `bounty:<day>:<land>:<kind>:<objective>`. A quest this build does not know is left out |
| `questMarkers()` | `[{ carrierId, marker, screen }]`, each carrier in view that shows the player a mark: `marker` is `'turnIn'` (a gold ?, one of theirs ready to turn in there), else `'offer'` (a gold !, a quest they may take on), else `'inProgress'` (a grey ?, one of theirs not finished yet is turned in there); `carrierId` is an NPC's entity id or a fixture's carrier id; `screen` is `{ x, y }` in CSS pixels where the NPC's body or the fixture's model is drawn, or `undefined` for one not drawn. The scene draws at most 8 marks at once |
| `questTracker()` | `{ shown, listShown, folded, quests: [{ questId, title, lines, returnTo? }] }`, what the quest tracker under the clock (`.hud-tracker`) says: `shown` is whether it shows at all (not with no quest held, nor while the Quest log is open, nor beside a carrier's panel or a window without room), `listShown` whether its heading shows the list (the choice kept in `localStorage` under `somnio.questTracker.hidden`), and `folded` whether a phone layout's list shows its first quest alone. `quests` is in its order, the quest that last moved first: `lines` as drawn (`'Visit Mercus in his shop: 1/1'`), empty for a quest done, which reads `returnTo` (`'Return to Libus.'`) instead |
| `fixtures()` | `[{ id, service, x, z, screen }]`, the fixtures of the sectors the client holds: `id` is the carrier id (`'fixture:EdariaSquare/fixture-1'`, the bounty board), `service` what it carries (`'bountyBoard'`), `x`/`z` its placement's centre, where speaking distance is measured from, and `screen` `{ x, y }` in CSS pixels on its drawn model, where a press picks it, or `undefined` for one not drawn |
| `inventory()` | what the player carries as last sent, in the `inventory` frame's shape: `{ coins, equipped: [{ slot, item }], bag: [{ place, item }] }`, worn items in slot order and the bag in place order (`place` 0–23, the cell `[data-place="<place>"]` of the Character window), each item `{ id, baseId, tier, rarity, affixes: [{ affixId, value }] }`. An item this build does not know is left out |
| `characterBody()` | `{ left, top, width, height, turnDegrees }`: the rect in CSS pixels where the Character window draws the player's live body, and how far a drag (or the slow sway after one rests) has turned it from its usual three-quarter view; `undefined` while the body is not shown (the window closed, or another tab) |
| `winded()` | whether the player's balance gave out, which holds them to `walk` |
| `running()` | whether Run is on |
| `engaged()` | whether slot 1 is on |
| `engageAction()` | what slot 1 does at the target: `'attack'` or `'mend'` (also at a fallen dreamer, where the slot reads Raise), or `undefined` while it cannot be switched on |
| `servicePanel()` | the id of the carrier whose panel is open: an NPC's entity id (a master, the shopkeeper, or a quest giver such as Libus or Memor) or a fixture's carrier id (the bounty board); `undefined` while none is open |
| `target()` | the id of the entity the player has targeted, the player's own id included, or `undefined` |
| `gazeLocked()` | whether the player's facing is locked on the target |
| `vitals(entityId)` | the share of the target's health (0–1): as the server last sent it (two decimals), or from the player's own pools when they are their own target. `undefined` before the first `vitals` frame and for anyone but the target |
| `abilities()` | the belt's slots after slot 1, in its order: `[{ abilityId, usable, cooldownSeconds }]`, one per ability the player has learned. `usable` is whether the server would act on it now but for its cooldowns; `cooldownSeconds` is what is left of the cooldown its slot waits on, its own or the global one, whichever ends later, `0` while none runs |
| `effects(entityId)` | `[{ effectId, seconds }]`, the effects the server last sent of the player or of their target, with the seconds each has left (`seconds` is absent for one lasting as long as its holder); `[]` for anyone else |
| `channel(entityId)` | `{ abilityId, seconds }`, the channel the server last showed that entity has under way (Deep mend), with the seconds it has left; `undefined` while none runs. The player sees their own, everyone in view sees one start and end, and a dreamer who targets the caster mid-channel is sent the rest |
| `raise(entityId)` | `{ healerNames, seconds }`, the raise under way on that fallen dreamer as its last `raising` snapshot states it: the Healers holding on whose names the client knows, and the seconds left at their pace; `undefined` while none runs. Everyone who sees the fallen dreamer's sector is sent it |
| `sensed()` | `[{ name, x, z }]`, where each other fallen dreamer in the space lies, nearest first, as the server last told a player who senses the fallen (a Mystic with Sense the fallen); `[]` for anyone else and after each join until the first `sensed` frame |
| `telegraphs()` | `[{ id, kind, casterId, x, z, radius, seconds }]`, the circles a nightmare in view has telegraphed and not yet struck (`kind` is `'wail'`, the Necromancer's: 4 m round where it stood, striking 2.5 s after it begins), with the seconds left before each strikes. One leaves the list as it strikes, or once its caster is driven off or leaves view; `[]` after each join until a `telegraph` frame. A dreamer standing in the circle as `seconds` reaches 0 loses 45 health; step out (centre more than `radius` from `x`, `z`) before then |
| `loot()` | `[{ lootId, kind, baseId?, rarity?, monsterKind?, shared, x, z, label, model }]`, the drops lying on the ground for the player as the server last said, oldest first; `kind` is `'item'`, with the item's `baseId` and `rarity`, or `'trophy'`, with the `monsterKind` that left it (`'skeleton-warrior'` for a cracked skull), which has no model, so its `model` is `undefined`; `shared` is `true` for an item a dreamer dropped for anyone, `false` for a drop of the player's own; `label` and `model` are `{ x, y }` in CSS pixels where the drop's name and the middle of its lying model are drawn, where it lands even while a throw still has it in the air, or `undefined` for one not drawn (a base this build does not know, or one waiting for a marker past the 16 drawn), and `model` also while the drop's model is not loaded (the name alone is drawn then). `[]` after each join |
| `screenPoint(entityId)` | `{ x, y }` in CSS pixels where that entity's body is drawn on the page (a fallen body where it lies), or `undefined` |
| `groundScreenPoint(x, z)` | `{ x, y }` in CSS pixels where that point of the space is drawn on the ground a body there would stand on (a walk surface's top, else the floor), or `undefined` before the first join. A point outside the canvas's rect is off screen |
| `chatHistory()` | the session's chat lines as localized strings; the greeting the chat shows above them is not included, so the result is `[]` until the first line arrives |
| `placeholderObjectCount()` | objects still rendering a placeholder model; `0` when there is no scene at all |
| `cameraScale()` | vertical half-height of the orthographic frustum (7 at the default zoom, 14 m shown top to bottom), or `undefined` with no scene |
| `overlay()` | `'login'` \| `'registration'` \| `'characters'` (the card) \| `'newCharacter'` \| `'deleteCharacter'` \| `'about'` \| `'updateRequired'` \| `'options'` \| `'gameMenu'` \| `'logOutOtherBrowsers'` \| `undefined` |
| `zoomFactor()` | session zoom, 0.78–1.4; the camera's half-height is 7 divided by it |
| `splashShot()` | the id of the splash shot playing behind the pre-login screens (`'town'`, `'follow-dreamer'`, ... `'time-lapse'`), or `undefined` while none plays |

`<html data-somnio-build>` carries the build stamp (`somnio-web <version>`) with no `?debug=1` gate, so any loaded page identifies its build. It is set by `main.ts` once the bundle runs, not baked into the served HTML — read it with `agent-browser eval 'document.documentElement.dataset.somnioBuild'`, since `curl` of the same URL returns a bare `<html lang="en">`.

## Recipes

**Walk.** A press on the ground walks the player: a tap walks along a path to where it landed, and a press held past 180 ms or moved more than 12 px steers. Drive it with pointer events at a page point: `groundScreenPoint(x, z)` is where a point of the space is drawn, the inverse of the pick the client runs on a press. Send the `pointerdown` to the canvas and the `pointerup` to `window`, both with the point's `clientX`/`clientY`, and give them `pointerId: 1` and `isPrimary: true`. A constructed event defaults to `isPrimary: false`, and the client clears a press whose `pointerup` it never saw only on a primary `pointerdown`; without it, one stray press left down turns the next into a pinch, which walks nowhere. `agent-browser click` takes a selector, not coordinates, so it cannot be aimed at the ground.

A tap is the down and the up in one `eval`, so no frame runs between them to make it a hold. The path is searched on the next frame, so `walk()` reads a path with no waypoints until then, and `undefined` again once the player stands, at the goal or at the nearest point toward it they can reach:

```bash
agent-browser eval --stdin <<'JS'
(async () => {
  const goal = { x: 12, z: 6 }   // in the space's coordinates, on screen
  const canvas = document.querySelector('canvas')
  const at = window.somnio.groundScreenPoint(goal.x, goal.z)
  const rect = canvas.getBoundingClientRect()
  if (at === undefined || at.x < rect.left || at.x > rect.right || at.y < rect.top || at.y > rect.bottom) return { offScreen: at }
  const init = { clientX: at.x, clientY: at.y, button: 0, buttons: 1, pointerId: 1, isPrimary: true, bubbles: true }
  canvas.dispatchEvent(new PointerEvent('pointerdown', init))
  window.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }))
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  await sleep(100)
  const planned = window.somnio.walk()
  for (let waited = 0; window.somnio.walk() !== undefined && waited < 10000; waited += 100) await sleep(100)
  const after = window.somnio.player()
  return { planned, walk: window.somnio.walk(), after, away: Math.hypot(after.x - goal.x, after.z - goal.z) }
})()
JS
```

A `pointerdown` dispatched on the canvas reaches it even where a panel covers that point, which a real press could not; check `document.elementFromPoint(at.x, at.y)` is the canvas when the case is about what a player can reach. The view shows 14 m of ground top to bottom at the default zoom, so walk further in several taps, each at a point still on screen. A tap on a body selects it instead of walking (see the next recipe), so aim beside one. A press on the ground drops a green ring there, which follows a held press and stays at the walk's destination after the up, lifting away when that walk ends or the next press lands; only a screenshot shows it.

The gait is a jog at 2 m/s. Run (3 m/s) is a toggle, and `running()` reports it. Switch it with the Run button at the end of the belt (`.hud-slot--run`, or `.hud-orb--run` at the end of the thumb's arc on a phone layout), or with a Shift keydown while no overlay is up and the chat field is not focused. A winded player walks at 1 m/s whatever it says. Facing follows the cursor on a fine pointer, unless the gaze is locked (next recipe): the press and every `pointermove` over the canvas set it, at body height. The cursor stays where it last was on the page while the camera follows the player, so a path that turns is walked partly sideways or backwards, and slower. Send a `pointermove` (with `buttons: 0`, and no press down) toward where the player should face.

To steer, keep the press down. The camera follows the player, so the ground under a still pointer moves on ahead of them, and they walk on in that direction for as long as it is held, like a stick. On the `pointerup` they walk on along a path to the ground under the pointer then. A `pointermove` while the press is down needs `buttons: 1` and the press's `pointerId`: a constructed event defaults to `buttons: 0`, which reads as the press having come up.

```bash
agent-browser eval --stdin <<'JS'
(async () => {
  const self = window.somnio.player()
  const at = window.somnio.groundScreenPoint(self.x + 3, self.z)   // 3 m east of the player
  const init = { clientX: at.x, clientY: at.y, button: 0, buttons: 1, pointerId: 1, isPrimary: true, bubbles: true }
  document.querySelector('canvas').dispatchEvent(new PointerEvent('pointerdown', init))
  await new Promise((resolve) => setTimeout(resolve, 2000))
  const steering = window.somnio.walk()   // { kind: 'steer', toward }
  window.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }))
  return { steering, after: window.somnio.walk(), moved: window.somnio.player().x - self.x }
})()
JS
```

A press on the player's own body is a press on the ground under it: a tap walks there and a hold steers, and it never targets them (their own frame does). A walk ends at a fall, a correction, and an overlay, but not at chat focus. A tapped path that ends at a door takes it, and one that only passes a door walks on through its trigger. A press held through a door steers on: `walk()` reads `undefined` from the door until the player is placed in the new space, then `steer` again toward the ground under the pointer there. A loop that walks toward a point has to stop tapping as soon as `spaceId()` changes. Otherwise a path that ends at a door, or a steer into its trigger, takes the player through, and the loop goes on tapping by the old space's coordinates and can walk straight back out. `player()` reads `undefined` during that join, so guard every read.

**Pick up a drop.** A nightmare driven off may leave each dreamer who shared it a drop of their own (by `DROP_ODDS`: one roll at three in ten from an ordinary one, two at one in two from an elite, and four at nine in ten from the Necromancer, at least four in five of them a base their role can use), seen by them alone: the item's own model, bursting out of the nightmare as the blow that drove it off lands, in a high, spinning arc over 0.65 s to 1 to 2 m from where it stood, several drops fanned round it, lying on the ground with its name under it on screen in its rarity's colour (plain bone, magic blue, rare gold), a faint glow under a magic or a rare one, and a gold beam rising from a rare one. A tap at `loot()[i].model` or `.label`, sent as in the walk recipe, walks the player into 1 m of the drop and picks it up on arriving: the drop leaves `loot()`, it lands in the bag, and the chat says "Leather cap picked up." A body standing on the drop covers its model, so a press there selects the body; press the name instead. A right press on a drop does nothing. A press on the ground on the way drops the pick-up, and a full bag says "Your bag is full." and leaves the drop lying. A drop lies until the player logs out: it waits through doors and wakes and is in `loot()` again, with no pop, on coming back into its space. Past 50 drops across the world the oldest goes.

**Drop an item for someone.** Open the Character window and drag a carried or a worn item out of it onto the world (see the drag recipe below), or, on a finger's layout, tap a carried item to open its card and press Drop (left of Equip; the Moonstone and worn items have none). Over the world the ghost says "Drop". A worn item goes in the one `dropItem`, whatever room the bag has. The Moonstone stays: over the world its ghost says "Stays with you", and letting it go there says "This stays with you." The item leaves the bag or its slot, and the chat says "Leather cap dropped." The player turns to the throw and plays `Throw`. Every session whose view covers that sector sees the item leave their hand a quarter of a second later (a held weapon, shield, or focus stays in the hand until then and flies from exactly where it was held), arc over 0.45 s, show its name as it lands, and hop once.

It lands 1 m from where the player stood, toward where the drag let it go, or for Drop toward the cursor's last point over the world on a mouse (a finger throws the way the player faces), short of a wall in the way, and lies there for 15 minutes with `shared: true` in `loot()`. Its `loot()` points are where it lands throughout, so read them after the flight for a screenshot of it lying; to film the flight, take screenshots about every 0.1 s from the release. Under reduced motion, or in a tab hidden for 1.5 s, it lies there at once. A second session standing within 1 m picks it up with the pick-up recipe, its stat lines intact, and it leaves every session's `loot()`; the first to ask takes it. It stays on the ground when the dropper leaves, and a server restart loses it.

**Equip from the Character window.** Open it with C or I, or the Character button (`.hud-menu`, right of the Spirit globe; its tip says "Character" and "C"). On a mouse, `agent-browser dblclick` a carried item (`[data-place="<place>"] button.hud-item`), or right-click it, to wear it; a single click does nothing. On a finger's layout a tap opens its card (`.hud-item-card`) with Drop and Equip. `inventory()` then lists it under `equipped` with its slot (a ring on `ring1` or `ring2`, whichever is free, else `ring1`), whatever the slot wore before takes the item's bag place, the doll's `[data-slot="<slot>"] button.hud-item` shows it, and `energy()`'s maxima and the globes follow its stat lines. The body in the window shows a weapon or an off-hand item in hand at once. A weapon or an off-hand item shows in the dreamer's hand in the world and in the portraits, and every other player in view reads it in their `entities()` entry's `held` once the `held` frame arrives. A double click on a worn item, or Unequip on its card, puts it at the bag's first free place, and is refused while the bag holds 24 (the card's button disabled, a mouse's gesture answered by "Your bag is full." beside the slot). Equipping or unequipping the Moonstone or a wand changes what slot 1 and the belt can do at once, so check `engageAction()` and `abilities()` after it.

**Drag an item.** A drag is real pointer events: `agent-browser mouse move` to the item's centre, `mouse down`, a few `mouse move`s past 4 px (12 px for a finger) toward the target, `mouse up` over it, in one `agent-browser batch`. A ghost of the item follows the pointer at the offset it was taken at. Let go on another bag place to move it there (`moveItem`; onto an occupied place the two swap, read the places from `inventory().bag`), on a slot its base fits to wear it there (both ring slots light up for a ring, and a ring dragged from one ring slot to the other moves there), and a worn item on a bag place to put it away there (or swap it with the item there when that one fits the slot). A slot the base does not fit shows "<slot> only" under the ghost and, on letting go, shakes beside "Fits only the <slot> slot.". Held 450 ms over a tab, a carried item opens it. Drag the body (`.hud-body`, `characterBody()`) sideways to turn it, which turns only that view: `characterBody().turnDegrees` follows, holds 3.5 s, and then sways slowly round it.

**Select, and slot 1.** A press on a body never walks the player. It makes the entity the target (`target()`): a ring marks it, its plaque draws over every other and through the world, and the target frame at the top centre (`.hud-unit--target`) shows its portrait, its name, and a bar of its health, from `vitals(id)`, with its condition only in the frame's `aria-label` ("Target, wounded"). An NPC within speaking distance (2 m) is also asked to go on past its greeting (`interact`), and opens its panel when it carries a service or quests (a master, Mercus, Libus, Memor); one further away is only selected. A press on a dreamer's name in the Players window (`.hud-list__select`) targets them while they are in view. A press on the player's own frame (`.hud-unit--self`, top left) or their own name there makes them their own target. A press on the ground keeps the target.

Bodies are picked by shape, before the ground, within the radius they are drawn with (at least 0.6 m on a phone layout), so aim at `screenPoint(id)`, where the body is drawn, a fallen body where it lies:

```bash
agent-browser eval --stdin <<'JS'
(() => {
  const canvas = document.querySelector('canvas')
  const npc = window.somnio.entities().find((e) => e.kind === 'npc')
  const at = window.somnio.screenPoint(npc.id)
  const init = { clientX: at.x, clientY: at.y, button: 0, buttons: 1, pointerId: 1, isPrimary: true, bubbles: true }
  canvas.dispatchEvent(new PointerEvent('pointerdown', init))
  window.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }))
  return { npc: npc.id, target: window.somnio.target() }
})()
JS
```

The ✕ on the target frame (tooltip "Clear target") clears the target; a press on the frame itself does not. Escape clears it once nothing the HUD has open is left to close (see Notes).

A right press acts and locks the gaze: a `pointerdown` on the canvas at `screenPoint(id)` with `button: 2, buttons: 2, pointerType: 'mouse'` (no `pointerup` needed) targets that body, has the player face it whatever the cursor does, and switches slot 1 on wherever it can act there. `gazeLocked()` reads `true`, `engaged()` reads `true` at a nightmare (or at a dreamer for a Healer with the Moonstone) and `false` at an NPC, and the target frame's `aria-label` ends "facing locked". The target's ring tells both apart: green while slot 1 is off and gold while it acts, a plain ring without the lock and a reticle with four ticks pointing in while locked. A second right press on the target unlocks, switches slot 1 off, and keeps the target. One on the ground unlocks alone, keeping the target and slot 1, and so does one on the player's own body, which is the ground under it; one without `pointerType: 'mouse'` is ignored. A right press made while the left button is held, as during a steer, fires no `pointerdown`: send a canvas `pointermove` at `screenPoint(id)` with `button: 2, buttons: 3, pointerType: 'mouse'` and the held press's `pointerId` instead, and its release while the left stays down as a `pointermove` with `button: 2, buttons: 1, pointerType: 'mouse'`. The steer recipe's `init` carries no `pointerType`, so add it. The lock also ends with the target: cleared, changed, out of view, driven off, or left in another space.

Slot 1 acts on the target: the first slot of the belt (`.hud-slot--act`; the big `.hud-orb--act` under the right thumb on a phone layout), or a `Digit1` keydown on `window` under the same conditions as Shift: `window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1', key: '1' }))`. `engaged()` reads whether it is on, and `engageAction()` what it does. The 1 key leaves a gaze lock as it is. The button's `data-look` (`attack`, `mend`, `raise`) and its localized `aria-label` name it: Attack at a nightmare not yet driven off, with the main hand empty or holding a weapon, whatever the off hand holds; Mend at a dreamer, the player included, for a Healer with the Moonstone in the off hand; Raise at a fallen dreamer, where `engageAction()` still reads `'mend'`. It is disabled at anything else. The client never walks the player toward the target.

With Attack on, the server swings at the target alone, at the swing rhythm, while it stands in reach (0.85 m centre to centre for a Ghost) inside 120° of where the player faces, and every swing it makes arrives as a `blow`. Tap the ground beside the nightmare to close in, and lock the gaze on it before switching slot 1 on: an unlocked gaze faces the cursor, which stays put while the camera follows, so the swing arc can miss. Watch `vitals(id)` fall and the target's `condition` in `entities()`. Mend and Raise have a recipe of their own below.

Ghosts hit hard: a dreamer standing among two or three falls in well under a minute. Plan the reset into the case: close the session, wait for the checkpoint, and restore position with the relocation recipe and health with a `health_current` update to `energy().healthMax` in the role recipe's heredoc.

Slot 1 stays on when the target changes to another it can act on, and goes off at any other target, at no target, at the target driven off or out of view, at the Moonstone put away while it mends, at a fall, and in a new space. A dreamer it mends who falls keeps it on, since Mend raises them.

**Use an ability.** The belt's slots after slot 1 hold the abilities the player's ranks teach, in the order of their teachings, so a Fighter with the whole kit has Cleave on 2, Challenge on 3, Brace on 4, Lunge on 5, and Rally on 6. To give a character the kit, follow "Give a character a role, ranks, or pools" below, with these statements in its heredoc in place of the Healer and fallen-dreamer ones. Every Fighter ability needs the main hand empty or holding a weapon, as Attack does.

```sql
UPDATE characters SET role='fighter' WHERE name='<fighter>';
INSERT INTO character_ranks (character_id, teaching_id, rank, practice)
  SELECT id, t, r, 0 FROM characters, (VALUES ('strike', 2), ('guard', 1), ('balance-recovery', 1), ('cleave', 1), ('challenge', 1), ('brace', 1), ('lunge', 1), ('rally', 1)) AS v(t, r) WHERE name='<fighter>'
  ON CONFLICT (character_id, teaching_id) DO UPDATE SET rank = EXCLUDED.rank;
```

Use one with a `Digit2`–`Digit6` keydown on `window`, under the same conditions as `Digit1`, or a click on its slot: a `.hud-slot--ability` button on a mouse's belt, named by its localized `aria-label` (a fresh `snapshot -i` finds it), or a `.hud-orb--ability` on the thumb's arc on a phone layout. A slot is a disabled button while its ability is not `usable` or `cooldownSeconds` is above 0, so a click on it then does nothing. The client sends `useAbility` only when the rule allows it. After one, it sends no other until the server's `cooldowns` answer arrives, or for 1 s, so two keydowns in one `eval` send one use. Wait about a second between uses. Each use plays the ability's clip on the user, which only a screenshot shows.

```bash
agent-browser eval --stdin <<'JS'
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const self = window.somnio.entities().find((e) => e.kind === 'player').id
  const before = window.somnio.abilities()
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit4', key: '4' }))   // Brace, in the whole kit's order
  await sleep(300)
  return { before, after: window.somnio.abilities(), effects: window.somnio.effects(self), runHeld: document.querySelector('.hud-run--held') !== null }
})()
JS
```

Brace (`braced` in `effects(self)`, about 4 s at rank 1) halves the harm the player takes and holds them to a jog: with Run on, `running()` stays `true` while `player().gait` reads `'jog'` on a walk, and the Run slot carries `.hud-run--held`. Rally gives Balance back to every standing dreamer within 12 m, the player included, so drain some first and watch `energy().balanceCurrent`. Cleave swings at every nightmare within touch that the swing arc meets, each swing a `blow`. The arc follows facing, so lock the gaze on a target among them first, as for slot 1. Challenge puts `challenged` on every nightmare within 5 m beyond contact, and they turn on the player; target one to read it in `effects(id)`. Lunge needs a targeted nightmare within 3 m beyond contact. The leap starts only once the server's `ability` frame for the player arrives, a round trip after the press. While it carries the player, `walk()` reads `{ kind: 'leap', end }`.

The frames show the same effects as a row (`.hud-effects`): a glyph per effect with its whole seconds left, and an `aria-label` such as "Braced, 4 s left". Effects and cooldowns go through a door, so `abilities()` and `effects(self)` read on in the next space.

**The HUD's tip.** HUD parts carry no `title`. A mouse resting on one shows the HUD's own tip at once: one `[role="tooltip"]` element in `.hud` (`.hud-tip`), hidden by the `hidden` class while nothing is under the pointer. `agent-browser hover @eN` on a slot from `snapshot -i`, or `mouse move` to its centre, shows it, and the part's `aria-describedby` names the tip's id while it shows. A synthetic `pointerover` works too, with `pointerType: 'mouse'` and `buttons: 0`, since a held button or a touch shows nothing. Read it part by part:

```bash
agent-browser eval --stdin <<'JS'
(() => {
  const tip = document.querySelector('.hud [role="tooltip"]')
  if (tip.classList.contains('hidden')) return null
  return [...tip.querySelectorAll('.hud-tip__title, .hud-tip__aside, .hud-tip__fact, .hud-tip__line, .hud-tip__warning')].map((node) => [node.className, node.textContent])
})()
JS
```

An ability's tip reads its name, its key, its cost (`.hud-tip__fact--spirit` or `--balance`), its channel or "Instant", and its cooldown at the rank held. Then come whom it lands on, the teaching's line, and in `.hud-tip__warning` why a greyed slot waits ("Not enough Spirit", "Needs the Moonstone in your off hand", "Target a nightmare in range") or "Ready in 4 s" while its own cooldown runs. An effect glyph's tip reads its name, its seconds left, and what it does. Moving the mouse off the part, or a press, hides it. On a phone layout the tip shows after a 400 ms hold, and the click after that hold does nothing. Drive it with `pointerdown`, a wait, and `pointerup` with `pointerType: 'touch'`, then a click whose `detail` is 1.

**The Healer's and the Mystic's kits.** A Healer with the whole kit has Deep mend on 2, Renewal on 3, Radiance on 4, and Calm on 5, and every one needs the Moonstone in the off hand. A Mystic's has Ward on 2, Weaken on 3, Bind on 4, Dream-bolt on 5, and Veil on 6, and every one needs a focus (a wand or a skull staff) in the off hand. Give either kit with the role recipe's heredoc, keeping its Moonstone statements for a Healer and putting `'wand'` in place of `'moonstone'` in them for a Mystic:

```sql
UPDATE characters SET role='healer' WHERE name='<healer>';
INSERT INTO character_ranks (character_id, teaching_id, rank, practice)
  SELECT id, t, r, 0 FROM characters, (VALUES ('touch', 2), ('depth', 1), ('drawing-back', 1), ('deep-mend', 1), ('renewal', 1), ('radiance', 1), ('calm', 1)) AS v(t, r) WHERE name='<healer>'
  ON CONFLICT (character_id, teaching_id) DO UPDATE SET rank = EXCLUDED.rank;
UPDATE characters SET role='mystic' WHERE name='<mystic>';
INSERT INTO character_ranks (character_id, teaching_id, rank, practice)
  SELECT id, t, r, 0 FROM characters, (VALUES ('ward', 1), ('weaken', 1), ('bind', 1), ('dream-bolt', 1), ('veil', 1), ('sense-the-fallen', 1)) AS v(t, r) WHERE name='<mystic>'
  ON CONFLICT (character_id, teaching_id) DO UPDATE SET rank = EXCLUDED.rank;
```

Deep mend, Renewal, and Ward land on the targeted dreamer within reach (5 m beyond contact, 6 m for Ward), or on the player with a nightmare or nothing targeted; at a fallen dreamer, or one too far off, the slot is greyed out. Radiance heals and Veil hides every standing dreamer within 5 m, the player included. Weaken, Bind, and Dream-bolt need a targeted nightmare in reach (6 m beyond contact, 8 m for Dream-bolt). Read their effects with `effects(id)`: `renewing`, `calmed`, `warded`, `veiled` on dreamers, `weakened` and `bound` on the targeted nightmare. A bound nightmare stays put in `entities()` but still strikes whoever stands in its reach. A Dream-bolt sends no `blow`, so watch `vitals(id)` fall. A Ward takes the harm of the next blows in the player's place, up to 12 harm at rank 1, so a warded player's `energy().healthCurrent` holds until it is spent and `warded` leaves `effects(self)`; the blow that spends it lands only what the ward could not take.

Deep mend is a channel of 1.5 s at rank 1. `channel(self)` reads `{ abilityId: 'deep-mend', seconds }` while it runs, and a thin bar drains under the player's frame (`.hud-unit--self .hud-timed`, `aria-label` "Channelling Deep mend"), and under the target frame when the target channels. The walk under way, a held press's steer included, waits with the player standing and goes on once `channel(self)` reads `undefined` again (or after 1 s with no answer); `walk()` keeps reading it meanwhile. A new press on the ground ends it, and the step it makes breaks the channel; a turn of the cursor does not. Slot 1 stays on through the channel and holds its mends until it lands:

```bash
agent-browser eval --stdin <<'JS'
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const self = window.somnio.player()
  const target = window.somnio.target()   // a dreamer in reach, or none for the Healer themselves
  const before = target === undefined ? window.somnio.energy().healthCurrent : window.somnio.vitals(target)
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2', key: '2' }))
  await sleep(400)
  const during = window.somnio.channel(window.somnio.entities().find((e) => e.name === self.name).id)
  await sleep(1600)
  const after = target === undefined ? window.somnio.energy().healthCurrent : window.somnio.vitals(target)
  const moved = Math.hypot(window.somnio.player().x - self.x, window.somnio.player().z - self.z)
  return { during, before, after, moved }
})()
JS
```

`during` must read the channel and `moved` stay 0; `after` above `before` shows it landed, given someone short of health. To see it break, tap the ground during the channel: `channel(self)` reads `undefined` at once and nothing is healed.

**Sense the fallen.** A Mystic holding `sense-the-fallen` reads every other fallen dreamer in the space in `sensed()`, however far off, from the moment they log in. For each one lying off screen, a marker sits at the screen's edge toward them (`.hud-sensed__marker`, inside `.hud-sensed`), with their name and an `aria-label` such as "Mira lies fallen to the north-east". A fallen dreamer on screen gets no marker. Stage it with the role recipe: lay a bot's dreamer down fallen and relocate them out of view, such as the North Meadow at `(20, -15)` while the Mystic stands in Edaria Square, then log both in. A raise or a wake of that dreamer empties `sensed()`.

**Trigger NPC dialog.** Dialog arrives as a `serverSay` frame — there is no dialog-specific verb — so it lands in the chat scrollback. Walk within 2 m of the NPC and it greets the player with its first line, unasked: once per approach, and not again within 30 s. A press on it as above brings its remaining lines, a few seconds apart, and opens its panel when it has one (`window.somnio.servicePanel()`).

```bash
agent-browser eval 'window.somnio.entities().filter((e) => e.kind === "npc")'
# tap the ground beside the NPC (the Walk recipe) until the player is within 2 m, then:
agent-browser wait --fn 'window.somnio.chatHistory().length > 0'
agent-browser eval 'window.somnio.chatHistory().at(-1)'
```

**Quests: Libus's errand.** A carrier with a quest for the player shows a mark over its head: a gold ? while one of theirs is ready to turn in there, else a gold ! while it offers one they may take on, else a grey ? while one of theirs not finished yet is turned in there. `questMarkers()` lists those in view, and `quests()` the log. A new character opens their eyes in the Library at `(2.7, 4.4)`, with Libus at `(5.3, 4.98)` showing `'offer'`. Tap the ground beside him, then press him (`screenPoint`): his panel opens (`servicePanel()` reads `'npc:EdariaLibrary/libus'`) with a row `[data-quest="newcomer-errand"]` and its "Take the quest" button. Click it with a real gesture (a fresh `snapshot -i` finds it). `quests().active` gains `{ questId: 'newcomer-errand', progress: [0, 0] }`, his mark turns to `'inProgress'`, and the Quest log (L, or the Quest log button in `.hud-menu`) lists it with "Visit Mercus in his shop." and "Read the bounty board on the square." The quest tracker under the clock (`.hud-tracker`, `questTracker()`) lists it too, as "Visit Mercus in his shop: 0/1", though it hides on a 1280-wide window while a carrier's panel is open, having no room beside it there.

1. **Mercus.** Leave the Library by its door. The player arrives on the square below the town hall's doorway at about `(35.9, 6.7)`. The shop's door faces south from the house at the square's north edge, its doorway at about `(28.3, 4.3)`; tap just inside it. In `EdariaShop` Mercus stands at `(2.56, 1.96)`. A press on him within 2 m counts the visit, whatever is bought: `progress` reads `[1, 0]`, and a line under the target frame (`.hud-quest-line`) says "Visit Mercus in his shop: 1/1" for 3.2 s.
2. **The board.** The notice board stands on the square at `(18.15, 18.1)`, near the well. `fixtures()` lists it as `fixture:EdariaSquare/fixture-1` with its `screen` point. A press there from anywhere on screen walks the player into 2 m of its centre and opens its panel ("Bounty board"); from within 2 m it opens at once. `walk()` reads the path meanwhile, and `servicePanel()` the board's id once it opens. The chat then says "Quest done: A newcomer's errand. Return to Libus.", and a banner under the target frame (`.hud-quest-banner`) says "A newcomer's errand complete" over "Return to Libus." for 4.5 s. A press on the board's model is picked before the ground, but after a body standing in front of it.
3. **Turn in.** Back at Libus, whose mark reads `'turnIn'`, his panel shows "Turn in" (`aria-label` "Turn in A newcomer's errand"). It pays 15 coins (`inventory().coins`), and `quests().done` gains `'newcomer-errand'`.

A panel closes on walking out of speaking distance, and the Quest log's Give up (`aria-label` "Give up <title>") drops a quest from anywhere, with what was done toward it. A player holds at most 10, and every offer is greyed out at 10.

**Take and turn in a bounty.** The board's panel lists the world day's bounties, one for each land with nightmares (the crypt among them, not the burial chamber), each a row `[data-quest="bounty:<day>:<land>:<kind>:<objective>"]` titled "Bounty: <place>", with what it asks, what it pays, and "Take the bounty" (`aria-label` "Take Bounty: <place>"). `quests().bounties` holds the same offers. A taken one joins `quests().active` with its `definition` and reads "Taken" on the board. A `driveOff` bounty counts only nightmares driven off in its land, as the shared credit counts: by every standing dreamer within the share radius, and the one whose harm drove it off. A `collect` bounty counts the trophies the player picks up (see Memor's chain). Done, the chat says "Bounty done. Return to the bounty board.", the board's mark reads `'turnIn'`, and its row's "Turn in" pays its coins and an item at the land's highest tier into the bag. With the bag full the button is greyed out beside "Your bag is full. Make room in it before you turn this in." The board shows `'offer'` while a bounty of the day is neither taken nor turned in, and else `'inProgress'` while a bounty taken is not finished yet.

The bounties change with the world day, 6 hours of real time. To see the board turn, stop the server, set the clock to 23:55 with the time recipe below (`14515286100`), start it again, and wait 75 s: every `quests()` reads the new day's `bounties`, and a bounty taken the day before stays in `active` and is still paid at the board as it was offered.

**Watch the splash.** Before login the world behind the pre-login screens plays the splash reel: ten shots of 6–8 s joined by a half-second dip to dark, then from the first again. A dip into another space stays dark until the world there has settled, for at most 3 s, and so does the held first shot under reduced motion. It needs no server. It stops when a session attaches, and its last frame stays until the player's body is placed. Poll `window.somnio.splashShot()` to see which shot is up and wait for the next, and screenshot each: `agent-browser screenshot` captures the reel, the 50% veil over it, and the wordmark. Under `prefers-reduced-motion: reduce` it holds the first shot, `town`. Emulate that with `agent-browser set media light reduced-motion` and confirm with `matchMedia('(prefers-reduced-motion: reduce)').matches`. The client reads it once at startup, so set it before opening the page or reload after.

**Screenshot.** `agent-browser screenshot --full <path>` captures the WebGL world and the DOM panels over it in one image. A capture is at 1x device scale unless the viewport says otherwise. Judge fine detail, such as where two outlines join, at 2x: `agent-browser set viewport <width> <height> 2`. Set it before opening the page. On an open page, change the size along with the scale, or reload. The client follows a real zoom or a move to another display, but a `set viewport` that changes only the scale fires neither `resize` nor the media-query change the client watches, so the world stays drawn at the old scale. Confirm with `document.querySelector('canvas').width`, which reads twice the canvas's `clientWidth` at 2x; `window.devicePixelRatio` reads `2` even while the world is still drawn at 1x. Enlarged, a 1x capture shows lines as joined that are visibly broken on a 2x display.

A screenshot arrives too late for a combat effect under a second long, such as a swing arc, a Cleave sweep, sparks, or a Lunge trail. Capture those from page code, in the same `eval` that makes the press or keydown, so the frames start with the effect. A `requestAnimationFrame` callback that registers itself again copies the canvas each frame for a second or two by `drawImage` onto a fresh 2D canvas, because the WebGL buffer is readable only in the frame that drew it. Encode with `toDataURL()` only once the capture ends, since encoding each frame slows the frames being captured. Slot 1's first swing comes at the server's swing rhythm, a round trip after the keydown, so give it the longer window. Store the frames on `window`, read them back a few per `eval`, and decode each data URL to a PNG.

**Check a layout across window widths.** A `set viewport <width> <height>` on an open page resizes it and the client lays out again, so one session can judge a panel at several widths without reloading. happy-dom does no layout, so measure a width rule here: compare rects in pixels rather than judging from a screenshot alone. The HUD's parts are:

- `.hud-unit--self`, the player's own frame, top left
- `.hud-unit--target`, the target frame, top centre
- `.hud-clock`, the time and the place name, top right
- `.hud-belt`, bottom centre: the `.hud-globe--health` and `.hud-globe--spirit` globes, `.hud-belt__panel` with the Balance arc, the `.hud-slots`, and the study line, and the `.hud-menu` of Players, Character, Quest log, and Settings right of the Spirit globe
- `.hud-chat`, the chat, bottom left
- `.hud-tracker`, the quest tracker under the clock, with its heading `button.hud-tracker__head` ("Hide quests" or "Show quests (N)"), a `.hud-tracker__quest[data-quest="<questId>"]` per quest held, and on a phone layout its `button.hud-tracker__fold` ("+N more" or "Tap to fold"); hidden with no quest held
- `.hud-quest-line` and `.hud-quest-banner`, under the target frame, each hidden while it says nothing
- `.hud-window--players`, `.hud-window--character`, and `.hud-window--quests`, the windows, each with its title alone in `.hud-window__head` and its ✕ (`button.hud-window__close`, "Close Players", "Close Character", "Close Quest log") on the panel's top-right corner. The Quest log holds a `.hud-quest[data-quest="<questId>"]` per quest held, with its objective lines and a Give up button. The Character window has tabs (`[role="tab"][data-tab="items|stats"]`, on a finger `gear|items|stats`). Its doll `.hud-doll` holds the body `.hud-body` and a place per slot (`[data-slot="<slot>"]`, an empty one naming the slot), the purse `.hud-purse`, and the bag `.hud-bag`, a place per bag place (`[data-place="<0-23>"]`). An item is a `button.hud-item[data-item="<id>"]` in its place. `.hud-stats` holds the Stats tab's groups, a `.hud-stat[data-stat="<key>"]` per line
- `.hud-item-card`, an item's card, opened by a finger's tap or Enter on an item; `.hud-notice`, a refused drag's line; `.hud-ghost`, the item a drag carries

A hidden part's rect reads zero: open a window from the menu first, and give the player a target for the target frame. A surface shown in one game state only needs that state before the loop: the fallen notice, which takes the target frame's place, needs a fallen player, which the "Give a character a role, ranks, or pools" recipe below sets up.

```bash
for w in 1280 760 700; do
  agent-browser set viewport $w 700
  agent-browser eval --stdin <<'JS'
(() => {
  const rect = (selector) => document.querySelector(selector).getBoundingClientRect()
  const box = rect('.fallen-notice')
  const self = rect('.hud-unit--self')
  const clock = rect('.hud-clock')
  return { width: innerWidth, boxWidth: box.width, gapLeft: box.left - self.right, gapRight: clock.left - box.right }
})()
JS
done
agent-browser set viewport 1280 720   # the other recipes assume a wide window
```

A negative gap is an overlap.

**Zoom.** Use real wheel input over the bare play field. The client ignores a wheel event while the pointer is over a panel, so a `WheelEvent` dispatched from `eval` after the pointer last rested on a panel zooms nothing. A negative delta zooms in, toward `zoomFactor()` 1.4:

```bash
agent-browser mouse move 700 450   # a point on the canvas, clear of the panels
agent-browser mouse wheel -200
agent-browser eval 'window.somnio.zoomFactor()'
```

A pinch is two pointers down on the canvas, the second with another `pointerId` and `isPrimary: false`, then `pointermove`s with `buttons: 1` that spread them (zoom in) or close them (zoom out), then a `pointerup` for each. The pinch zooms by the ratio of the pointers' spans and walks nowhere until both are up.

**Phone layout.** The client reads `(pointer: coarse)` once at startup, so launch the session with a coarse primary pointer, then size it as a phone on its side. `--args` splits on commas, so pass the one setting alone:

```bash
agent-browser --session phone --args "--blink-settings=primaryPointerType=2" open 'http://localhost:17669/'
agent-browser --session phone set viewport 844 390
agent-browser --session phone eval 'matchMedia("(pointer: coarse)").matches'   # expect true
```

There one strip runs along the top (`.hud-strip`): the own frame with small Health and Spirit bars, the target frame, the clock, and ≡ (`.hud-sheet-toggle`), which opens a sheet (`.hud-sheet`) with Players, Character, Settings, and the study line. Slot 1 is the big orb under the right thumb (`.hud-orb--act`), with slots 2–6 on an arc round it (`.hud-orb--ability` for an ability learned, `.hud-orb--empty` after them) and Run at the arc's end. Balance is a thin bar at the bottom centre. The chat is an icon bottom left (`.hud-chat-toggle`) with its newest lines peeking above it (`.hud-chat-peek`), and opens as a panel. The chat, the sheet, and the windows start closed, and one window opens at a time, down the right edge, covering the clock and the thumb while open. Bodies pick from at least 0.6 m round them, and the player faces their target, or the way they walk without one, instead of the cursor; a gaze lock needs a mouse. `set viewport 390 844` shows the "Turn your phone sideways." card over everything, and turning back to 844 by 390 takes it away with the game as it was. The browser here has no touch input of its own (`navigator.maxTouchPoints` reads `0`), so drive it with the pointer events of the recipes above. Touch on a real phone is not covered.

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
const [name, dx, dz, line] = process.argv.slice(2)
const ws = new WebSocket('ws://127.0.0.1:17662/ws')
const send = (tag, payload) => ws.send(JSON.stringify({ tag, payload }))
let selfId
ws.onmessage = ({ data }) => {
  const { tag, payload } = JSON.parse(data)
  // Each bot's account was registered as `<name>@example.invalid`.
  if (tag === 'hello') send('login', { email: `${name}@example.invalid`, password: '<password>' })
  // The card: make a character called `name` the first time, then play the first one.
  if (tag === 'characters') {
    const [first] = payload.characters
    if (first === undefined) send('createCharacter', { name, people: 'vigils' })
    else send('selectCharacter', { characterId: first.id })
  }
  if (tag === 'enterSpace') selfId = payload.selfId
  if (tag === 'correction') console.log(name, 'step refused, still at', payload.x, payload.z)
  if (tag === 'entity' && payload.id === selfId) {
    // A step under 7.5 m onto open floor stays inside the movement allowance.
    setTimeout(() => send('move', { x: payload.x + Number(dx), z: payload.z + Number(dz), facing: 0, gait: 'walk' }), 500)
    if (line) setInterval(() => send('clientSay', { text: line, kind: 'say' }), 4000)
  }
}
```

```bash
node <dir>/bot.mjs <name> 0.7 0.3 'Hallo' & echo $!   # character name, step east, step south, a line to repeat
```

New characters start at the starter spawn in `EdariaLibrary`, so log the browser player in there too. Run the bots with the sandbox off, since they dial a local port. Keep the script in a fixed directory that both sandboxed and unsandboxed commands can read, not under `$TMPDIR`, which names a different directory inside and outside the sandbox. When done, stop the bots by the PIDs `echo $!` printed, then delete the accounts. Deleting an account removes its characters and sessions: `docker exec somnio-pg psql -U postgres -d somnio -c "DELETE FROM accounts WHERE email IN ('<name>@example.invalid', ...);"`.

For a crowd of hundreds, hold every bot's socket in one Node process rather than one process per bot, and open them in batches that log in before the next batch dials. The server holds at most 128 sockets awaiting login, and 8 per address while `SOMNIO_TRUST_PROXY` is set (the compose topology sets it). It answers past those caps with 503 or 429, and closes a socket not logged in within 30 s. A logged-in socket is closed after 10 minutes on the card without a request there. At most 128 may sit there at once, and 8 per address while `SOMNIO_TRUST_PROXY` is set. A login past either is closed 1013, so have each bot pick its character as soon as `characters` arrives. Register the accounts over the wire one after another first, give their emails a shared prefix, and delete them afterwards with `DELETE FROM accounts WHERE email LIKE '<prefix>%'`. To count or size the frames the browser player receives, wrap the `onmessage` setter on `WebSocket.prototype` from an `eval` before logging in, so the game's socket reports each frame to the wrapper. A remembered session opens its socket at page load, before any `eval` runs, so log in without "Remember password" for this, or install the wrapper with `--init-script` as Step 4 describes.

**Hide the tab.** Open the session `--headed` from its first command. There, a second tab in front fires `visibilitychange` on the game page and stops its `requestAnimationFrame`; switching back makes it visible again. Tab ids are the `t<n>` ids `tab list` prints, and positional integers are refused. An `eval` sent while the blank tab is in front runs in that tab, so switch back before reading `window.somnio`.

```bash
agent-browser --session a --headed open 'http://localhost:17669/'
# log in, then:
agent-browser --session a tab new about:blank   # the game tab is now hidden
agent-browser --session a tab t1                # t1 in a fresh session; otherwise the game's id from `tab list`
```

Hiding forgets every pointer down and ends a steer, so press again after switching back; a walk along a path goes on once frames run again. Peers, speech bubbles, and raise rings follow the clock, so on return they show where things stand now.

Combat effects do not catch up. Once the tab has been hidden for 1.5 s, a blow, sweep, wave, or burst still to land is dropped on its return, and an arc, ring, spark, trail, stagger, flash, hit-pause, shake, or lift under way ends, as does a drop's flight, which lies where it lands. A `blow` or `ability` arriving while the tab stays hidden shows nothing, so act again after switching back to see one. A Challenge mark or a Brace outline lasts its effect's time, so one that ended while the tab was hidden is gone and one that still runs shows on. A one-shot clip started in the first 1.5 s of a hide may still finish on return, because the clips are the animation mixers', not the combat effects'.

To see what the first frames back draw, install a `visibilitychange` listener before hiding that, on `visible`, records a sample (say a peer's `entities()` position) on each `requestAnimationFrame` for a few hundred milliseconds, and read the samples after switching back.

To land a frame at a chosen moment, such as an `ability` frame once the tab has been hidden past 1.5 s, or to stage a slow answer, hold the inbound frames. Wrap the `onmessage` setter on `WebSocket.prototype` before logging in, as "More players without more browsers" describes, so the game's handler runs behind a wrapper that, while a hold is on, queues each message and on a timer hands the queue to the real handler in order. Queue every frame during the hold, not only the one under test, so none overtakes another. A hidden tab fires its timers at most about once a second, so allow that slack in the release time. Confirm the hide from the game tab itself: have a `visibilitychange` listener there, such as the one above, also record `document.visibilityState` and `performance.now()` on each change, and reading that record after switching back shows how long the tab was hidden when the held frame was released.

Headless, hold the animation frames instead: a hidden tab is a page whose `requestAnimationFrame` stops while its socket keeps delivering, so a login can complete there. Dispatching `visibilitychange` alone is no substitute, because the frame loop keeps running and catches up before anything is read.

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

**Speech bubbles.** Log two players in as above, put them where the case needs, and have the speaker press Enter to open the chat, type `/y <text>` into its field (a fresh `snapshot -i` finds it), and press Enter, which sends the line and closes the chat. Both new characters start inside `EdariaLibrary`, where each draws the other and the bubble hangs over the speaker's head. With several speakers together, each bubble takes the nearest spot round its speaker's head that is clear of heads, other bubbles, and panels, and glides back over the head once that is free. The bubbles are painted on their own canvas (`#somnio-bubbles`) over the world and under the panels. Only a screenshot shows them: `snapshot` finds no element for them, and `window.somnio` has no call that reports them.

To read what the scene computed, such as where each bubble was placed and in which mode, wrap a scene method from an `eval` on the dev server. Inside an async IIFE, `const { WorldScene } = await import('/src/scene/worldScene.ts')` returns the module the page runs, so replacing `WorldScene.prototype.placedBubbles` with a wrapper that stores its result on `window` records every frame's placements. The working tree stays untouched, and a page reload removes the wrapper. Restart Vite first when `worldScene.ts` or anything it imports was edited since Vite started: the page then loads the module under a `?t=` URL, the plain import returns a second copy, and the wrapper on it never runs. Without a restart, import the URL the page loaded instead: `performance.getEntriesByType('resource').map((entry) => entry.name).filter((name) => name.includes('/src/scene/worldScene.ts')).at(-1)`.

- **Pinned at the edge.** Put both outdoors, further apart than the screen shows, and within a yell's 80 m. At the default zoom in a 1280×720 window the view reaches about 12 m to either side of the listener and about 10 m of ground up and down the screen, and zoomed fully out about 16 m and 13 m, so 20 m apart is enough in any direction at any zoom. The bubble pins on the line toward the speaker, as near the screen's edge as is clear of heads, other bubbles, and panels. The listener's chat line names a compass direction.
- **Past a room's wall.** Keep the listener in the room and put the speaker outdoors within about 30 m of that room's door. The starter room is 7.68 m square, so at the default zoom all of it and the spot past its wall are on screen wherever the listener stands in it. Where a panel covers that spot the bubble pins at the edge and the chat line names a direction. The chat's lines bottom left count as a panel while they show, and every arriving line, the voice's own included, keeps them shown for another 8 s. Move the listener until the spot lies clear of them. A voice placed by the door names no direction in chat, which tells the two placements apart, and it always arrives crumbled.

Relocate with the recipe below. Its `sectorName()` check cannot confirm a move within the starter room, since a lost race and a self-heal land there too, so check `player()` instead.

**Portraits.** The HUD frames' portraits are drawn on the world canvas, in the circles the frames leave open (`.hud-portrait`, `GameHUD.portraits`), so only a screenshot shows them. To time the pass, wrap `WorldScene.prototype.drawPortraits` as the bubble recipe wraps `placedBubbles`, and repeat the pass inside the wrapper until frames slow. On Apple's ANGLE Metal renderer, `EXT_disjoint_timer_query_webgl2` overstates the pass many times over, so do not time it that way.

**Relocate the character.** The server holds the gameplay session for a few seconds after the page goes away, because the Vite proxy keeps the upstream WebSocket alive. Both the disconnect checkpoint and the periodic 30 s checkpoint write the character row, so a DB `UPDATE` issued too early is silently overwritten, and an immediate re-login fails with "Du bist bereits angemeldet." / "Already logged in." on the login card. When a re-login still fails that way after the wait, restart Vite: its proxy can keep the old upstream socket open. Order matters, and the post-login `sectorName()` read is the success predicate. The Notes' no-sleep rule is suspended here only because no page exists to poll between close and login:

```bash
agent-browser close; sleep 8   # closes only the default session (--session a/b need their own close)
docker exec somnio-pg psql -U postgres -d somnio -c "UPDATE characters SET space='outdoors', position_x=20, position_z=-15 WHERE name='<character>';"
agent-browser open 'http://localhost:17669/'
# log in and play <character>, then: agent-browser eval 'window.somnio.sectorName()'  — expect 'NorthMeadow'; the old sector
# here means the checkpoint won the race; close and repeat. A position inside geometry or outside
# every sector self-heals to the starter spawn in EdariaLibrary with no error, so pick open ground.
```

`space` and `position_x`/`position_z` hold what `spaceId()` and `player()` report: a space id, and metres in that space's coordinates. `(20, -15)` is open ground in the North Meadow, whose origin is `(5.12, -30.72)`. The North Wood north of it, at origin `(5.12, -61.44)`, holds a nightmare spawn area: a player placed inside it, as at `(20, -46)`, is struck and falls within half a minute. An interior's positions run from its own north-west corner.

**Give a character a role, ranks, or pools.** Write under the same rule as relocating: close both players' sessions (and stop any bot) and wait for the checkpoint first, or it overwrites the row. Several statements go in one heredoc, and `docker exec` needs `-i` for it: without `-i` the heredoc never reaches psql, which prints nothing and applies nothing. This makes `<healer>` a Healer with `touch` at rank 2 and `drawing-back` at rank 1 (a raise needs Drawing back, which needs Touch 2) and the Moonstone in the off hand, in place of whatever it held, which slot 1 needs to mend or raise. It also lays `<dreamer>` down fallen (a partial `health_current`, such as 40, gives a mend something to do instead). The upserts and the replaced off hand make the block safe to run again:

```bash
docker exec -i somnio-pg psql -U postgres -d somnio -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
UPDATE characters SET role='healer' WHERE name='<healer>';
INSERT INTO character_ranks (character_id, teaching_id, rank, practice)
  SELECT id, t, r, 0 FROM characters, (VALUES ('touch', 2), ('drawing-back', 1)) AS v(t, r) WHERE name='<healer>'
  ON CONFLICT (character_id, teaching_id) DO UPDATE SET rank = EXCLUDED.rank;
DELETE FROM items WHERE character_id=(SELECT id FROM characters WHERE name='<healer>') AND equipped_slot='offHand';
INSERT INTO items (id, character_id, base_id, tier, rarity, affixes, equipped_slot)
  SELECT gen_random_uuid(), id, 'moonstone', 1, 'plain', '[]', 'offHand' FROM characters WHERE name='<healer>';
UPDATE characters SET health_current=0 WHERE name='<dreamer>';
COMMIT;
SQL
```

After logging in, `window.somnio.lucidity().role` on the healer reads `'healer'` and `window.somnio.energy().healthCurrent` on the dreamer reads `0`. Anything else means a checkpoint won the race, so close and repeat. A raised dreamer stands again, and one who wakes is also moved to the inn, so a retry re-runs the block, plus the relocation recipe after a wake.

**Mend and raise.** With Mend on, a Healer mends a standing dreamer within 3 m, centre to centre, once a second: +10 health for 8 spirit. It waits, still on, while the dreamer is at full health or the Healer is short of spirit. With the player as their own target it mends them. At a fallen dreamer it raises them instead, only within touch (0.85 m) and with Drawing back held. The raise takes 6 s and 40 spirit, then the dreamer stands and Mend goes on mending them.

Play the Healer in the browser and the dreamer as a bot from "More players without more browsers", run with no step and no line (`node <dir>/bot.mjs <dreamer> 0 0`). Run the bot once so it makes its character, stop it, and run the block above with both sessions closed. Start the bot again and log the Healer in; both stand on the `EdariaLibrary` spawn at (2.7, 4.4). Then step off the dreamer, target them, and switch slot 1 on in one eval:

```bash
agent-browser eval --stdin <<'JS'
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const canvas = document.querySelector('canvas')
  const press = (at) => {
    const init = { clientX: at.x, clientY: at.y, button: 0, buttons: 1, pointerId: 1, isPrimary: true, bubbles: true }
    canvas.dispatchEvent(new PointerEvent('pointerdown', init))
    window.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }))
  }
  const dreamer = window.somnio.entities().find((e) => e.kind === 'peer')
  press(window.somnio.groundScreenPoint(dreamer.x + 0.7, dreamer.z))   // within touch, beside the body
  for (let waited = 0; window.somnio.walk() !== undefined && waited < 4000; waited += 100) await sleep(100)
  press(window.somnio.screenPoint(dreamer.id))
  const look = document.querySelector('.hud-slot--act').dataset.look   // 'raise' at a fallen dreamer, else 'mend'
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1', key: '1' }))
  const self = window.somnio.player()
  const samples = []
  for (let second = 0; second < 7; second += 1) {
    await sleep(1000)
    const condition = window.somnio.entities().find((e) => e.id === dreamer.id)?.condition
    samples.push({ vitals: window.somnio.vitals(dreamer.id), spirit: window.somnio.energy().spiritCurrent, condition })
  }
  return { target: window.somnio.target(), look, engaged: window.somnio.engaged(), away: Math.hypot(self.x - dreamer.x, self.z - dreamer.z), samples }
})()
JS
```

`target` must be the dreamer's id and `engaged` `true`. A mend shows `vitals` rising about 0.1 a second and `spirit` falling 8 a mend until the dreamer is whole. A raise shows `condition` at `fallen` for about 6 s, then a standing band, and needs `away` under 0.85. While it runs, `raise(dreamer.id)` reads the Healer's name and the seconds left, and a gold bar fills under the target frame (`.hud-unit--target .hud-timed`, its fill `.hud-timed__fill--raise`, `aria-label` "Being drawn back by <healer>"); the dreamer's own client shows the same bar under its own frame. To see the reaches hold, stand the Healer about 2 m off instead: a mend still lands there, and a raise never begins.

**Set the time of day.** No admin verb sets the clock. Stop the server first: it saves the clock about every 15 s and on shutdown, so an `UPDATE` under a running server is overwritten. Then write the row and start the server again:

```bash
docker exec somnio-pg psql -U postgres -d somnio -c "INSERT INTO world_clock (id, world_seconds) VALUES (TRUE, 14515225200) ON CONFLICT (id) DO UPDATE SET world_seconds = EXCLUDED.world_seconds;"
```

`14515225200` is 07:00 on the first day of year 500; add 3600 per hour. World time runs at four times wall time, so an hour passes in 15 minutes. Outdoor light follows the clock. An interior is lit by its `brightness` and its flames, whatever the hour, and only the light through its first door to the outdoors follows the clock (a room with none, such as the burial chamber, has no such light). `world_seconds` is double precision, so cast it before `%` in SQL: `world_seconds::bigint % 86400`.

**The night door and Tacita.** Tacita, the Mystic master (`npc:EdariaMysticTower/tacita`), stands at `(3.55, 1.45)` in `EdariaMysticTower`. Its door, `to-edariamystictower` on the tower in the north-east corner of Edaria Square's south-west quarter, opens only from 22:00 to 06:00 world time, while the HUD clock shows ☾. It faces south; tap the ground at its doorway, about `(12.6, 31.5)` in the outdoor space. By day the server answers `doorRefused`, the player stays outside, and `chatHistory().at(-1)` reads "This door opens only at night." To get in, set the clock with the recipe above to 23:00, `14515282800`, and start the server again; with 2 h of real time per night, that leaves time for a run. The door out of the tower opens at every hour.

Inside, a press on Tacita opens her panel ("Master of the Mystics") for a dreamer with no role, and her dialog hints at the trial's three hidden places. Each is a 3 m circle round a point, which in the outdoor space are `(-24, 30)` in the West Meadow, `(50, 8)` in the Autumn Wood, and `(12, -14)` in the North Meadow. With the trial taken ("Ask for the trial" in her panel), walking into each one sets that place's count in the `'mystic-trial'` entry of `quests().active` to 1 (`progress` `[1, 0, 0]` after the West Meadow's), and the chat says "You found a hidden place, 1 of 3." for each but the last, which says "Quest done: The Mystics' trial. Return to Tacita." Her panel then offers "Become a Mystic", which makes the role theirs. A dreamer holding another master's trial is told to finish or give that one up first. To skip the walk, relocate the character beside each circle with the relocation recipe, then tap the ground inside it: the space counts a place only on an accepted `move` there.

**The Graveyard and the crypt.** The Graveyard is the outdoor sector at origin `(-71.68, 0)`, west of the West Meadow, which it touches. Relocate a character to `(-36, 20.4)` in the outdoor space, open ground on the road east of its arched gate, and `sectorName()` reads `'Graveyard'`. Inside the iron fence the church stands in the middle, Skeletons (`name: 'Skeleton'`, the `skeleton-minion` kind) keep to the graves south of it, about x -60 to -42 and z 23 to 29, and Skeleton Warriors to its east side, about x -47 to -42 and z 10 to 17. The crypt's door, `to-graveyardcrypt` on the tomb south-west of the church, faces east; tap the ground at its doorway, about `(-56.8, 20.5)`. `spaceId()` then reads `'GraveyardCrypt'`, and the player stands at `(14.56, 5.12)`, inside its door on the east wall and beyond every nightmare's reach. The door to the burial chamber is across the crypt on its west wall: tap about `(0.3, 5.12)`. The crypt's two spawn areas fill its middle (Skeletons x 7.7 to 12.2, Skeleton Warriors x 2.6 to 7.7, both z 0.6 to 9.6), so the way west is a fight. To skip it, relocate into the chamber itself, `space='GraveyardBurialChamber', position_x=13, position_z=6.4`, inside its only door, which leads back to the crypt.

The spawns first fill within a minute of the server starting. In the crypt each Skeleton is an elite one time in four and each Skeleton Warrior three times in ten; the Graveyard's own spawns make none. `entities().filter((e) => e.rank === 'elite')` lists them with `trait` `'stony'` or `'shielded'`. Targeted, its plaque and the target frame read "Stony Skeleton" or "Shielded Skeleton Warrior", a column of sandstone or ice light stands round it, and `effects(id)` reads its trait's effect with no `seconds`. With no elite standing, drive a Skeleton off: its spawn refills it 45 s later (a Warrior 75 s) and rolls again.

**The Necromancer.** It stands in the burial chamber, `{ kind: 'monster', name: 'Necromancer', rank: 'boss' }` in `entities()`, and once driven off comes back only 10 minutes later. Its home ground is the chamber's spawn area, x 1.28 to 9.6 and z 1.28 to 10.24, so from the relocation point it stands in view and leaves the player be. It chases a dreamer who steps inside within 6 m of it. 4 s into a fight, while a dreamer stands within 4 m of it, it wails: `telegraphs()` gains `{ kind: 'wail', casterId: <its id>, x, z, radius: 4, seconds }` with `seconds` about 2.5, a red circle fills on the ground round where it stood, and it plays its long cast. A dreamer whose centre is still inside as `seconds` reaches 0 loses 45 health and 15 balance in `energy()`, and falls if that was the last of it; one who stepped out loses nothing. It wails again 10 s after each wail strikes. As the fight begins and every 15 s, it calls up two Skeletons 1 to 3 m from it, up to four of its own, each rising in a ring of green light. Once every dreamer has left its ground or fallen, it walks home, and 5 s later, with no dreamer back in the fight, it gives the fight up and its Skeletons crumble into green light and sink away, gone from `entities()` at once and never `fallen`; a dreamer it chases again before then finds them still there. Driven off, its Skeletons crumble with it, and each dreamer who shared it rolls four times for third-ring drops, mostly magic and rare.

A fresh dreamer barely scratches its 900 health, and it heals 10 a second while left alone, so fight it with two prepared dreamers in two sessions ("Two players in view of each other"): a Fighter with Strike 5 and a tier-3 war axe, and the Healer from "Give a character a role, ranks, or pools", whose block runs here without its line that lays a dreamer down. With both sessions closed and the checkpoint waited for, as there:

```bash
docker exec -i somnio-pg psql -U postgres -d somnio -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
UPDATE characters SET role='fighter' WHERE name='<fighter>';
INSERT INTO character_ranks (character_id, teaching_id, rank, practice)
  SELECT id, 'strike', 5, 0 FROM characters WHERE name='<fighter>'
  ON CONFLICT (character_id, teaching_id) DO UPDATE SET rank = EXCLUDED.rank;
DELETE FROM items WHERE character_id=(SELECT id FROM characters WHERE name='<fighter>') AND equipped_slot='mainHand';
INSERT INTO items (id, character_id, base_id, tier, rarity, affixes, equipped_slot)
  SELECT gen_random_uuid(), id, 'war-axe', 3, 'plain', '[]', 'mainHand' FROM characters WHERE name='<fighter>';
UPDATE characters SET space='GraveyardBurialChamber', position_x=13, position_z=5.6 WHERE name='<fighter>';
UPDATE characters SET space='GraveyardBurialChamber', position_x=13, position_z=7.2 WHERE name='<healer>';
COMMIT;
SQL
```

Log both in. The Fighter right-presses the Necromancer at `screenPoint(id)` (target, gaze lock, and slot 1 in one press, see "Select, and slot 1") and taps the ground beside it; the Healer targets the Fighter, switches slot 1 on, and follows to within 3 m, staying out of the circle. Each steps out of a circle once `telegraphs()` lists one, and a Fighter who falls to a wail is raised by the Healer as in "Mend and raise". Driving it off still takes minutes.

**Memor's chain.** Memor, the priest (`npc:Graveyard/memor`), stands beside the church at `(-51.88, 18)` in the outdoor space, west of the relocation point on the Graveyard's road, past the arched gate. He gives three quests, each once the one before it is turned in, and takes each back: "Restless graves" (`'restless-graves'`, drive off 4 Skeletons in the Graveyard; 60 coins and 30 practice), "Cracked skulls" (`'cracked-skulls'`, gather 3 cracked skulls from Skeleton Warriors; 90 coins and 40 practice), and "Into the crypt" (`'into-the-crypt'`, drive off the Necromancer; 250 coins, 60 practice, and a third-ring item). Take and turn in each at his panel as in Libus's errand. A Skeleton driven off elsewhere, such as in the crypt, does not count toward the first.

A trophy drops only for a dreamer holding a quest that still gathers it, as a drop of their own beside the nightmare's gear: `loot()` lists it as `{ kind: 'trophy', monsterKind: 'skeleton-warrior' }` with its name ("Cracked skull") drawn in plain bone and no model, so press its `label`. Picking it up never needs room in the bag and leaves `inventory()` as it was; the chat says "Cracked skull picked up." and the quest's `progress` rises by one.

To start further along the chain, mark the quests before it turned in, with the sessions closed and the checkpoint waited for as in the role recipe. This replaces the character's whole quest log:

```bash
docker exec -i somnio-pg psql -U postgres -d somnio -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
DELETE FROM character_quests WHERE character_id=(SELECT id FROM characters WHERE name='<character>');
INSERT INTO character_quests (character_id, quest_id, state, place)
  SELECT id, q, 'done', p FROM characters, (VALUES ('restless-graves', 0), ('cracked-skulls', 1)) AS v(q, p) WHERE name='<character>';
COMMIT;
SQL
```

A held quest's row is `state='active'` with `progress` a JSON array of a count per objective (`'[2]'`), and `place` orders each state's rows from 0. A row the server cannot read refuses the join, and the character card says "Could not enter the world. Try again."

**A trial that forbids striking.** Sana's trial (`'healer-trial'`, walk into the North Wood and come back) carries `withoutStriking`: while it is held, `engageAction()` reads `undefined` at a nightmare, and slot 1 cannot switch on there and goes off if it was on. Slot 1 then shows Attack greyed out at a nightmare, and its tip says in red "Not while a quest forbids striking".

**Render a staged scene without a server.** To screenshot any sector with figures placed by hand, such as stills for a prototype, draw it from an `eval` on the dev page. It needs no gameplay server and no login. Wait for Step 4's prewarm gate first, then run an async IIFE from a script in the session scratchpad with `agent-browser eval --stdin`. The working tree stays untouched.

- **Modules.** Import `/src/scene/worldScene.ts`, `/src/scene/modelAssets.ts`, and `/src/scene/cameraRig.ts`. `@somnio/core` alone has no fixed dev URL, because Vite serves it from a machine-specific `/@fs/<absolute path>/packages/core/src/index.ts`: fetch `/src/scene/worldScene.ts` as text, take the import URL that ends in `packages/core/src/index.ts`, and import that.
- **Sectors.** Fixtures load from core's `/@fs` URL with `src/index.ts` replaced by `fixtures/sectors/<Name>.somnio-sector`. Read each with `core.readSectorFile(text, name)` and draw it with `scene.addSector(core.sectorView(sector))`. Any file inside the repo fetches this way, committed or not. To draw sectors that exist only in memory or outside the repo, such as lands a generator variant composed in a scratch run, put each one's file text in a name-to-text map. Prepend `window.__texts = <the map as JSON>;` to the script, and read the text from that map in place of the fetch.
- **Scene and renderer.** Build `new WorldScene(new HttpModelAssets(registry), registry, innerWidth / innerHeight, false)` (the last argument is reduced motion) with `registry = core.bundledModelRegistry()`, and `await scene.prewarm()`. Draw through `createWorldRenderer(canvas)` and `sizeWorldRenderer` onto a fixed, full-window canvas above the page.
- **Figures.** Call `scene.placeEntity({ id, kind, characterModelId, name, position: { x, z }, facing, gait: 'walk', radius: 0.3, condition: 'hale', service: undefined })`. Stage dreamers as `'peer'`: the camera follows a `'player'` every tick and overrides the framing. With no `enterSpace` the scene has no walk surfaces, so every figure stands at height 0, even on stairs or a plinth.
- **Framing.** Set `scene.camera`'s `left`/`right`/`top`/`bottom` from the rig's `frustumBounds(scale, aspect)`, its position from `cameraPosition({ x, y: 0, z })`, then `lookAt`, `updateProjectionMatrix`, and `scene.anchorSunShadow({ x, z })`.
- **Light.** Call `scene.setClock(worldSeconds)`, counting from the 07:00 value in the recipe above: subtract or add 3600 per hour.
- **Capture.** Call `scene.tick(dt)` and `renderer.render(scene.scene, scene.camera)` once per `requestAnimationFrame` until `scene.isSettled()` is true, then for about 30 frames more, before the screenshot. The ground is painted in a worker, which answers between frames, and the grass grows one sector a tick, so a fixed run of frames in one turn of the event loop captures flat ground. The extra frames let models resolve and pose.

**Verify the asset pack resolved.** `agent-browser eval 'window.somnio.placeholderObjectCount()'` — non-zero means models are missing or a registry id has no matching stem. Read it only once Step 4's gate has passed: with no scene it returns `0`, which is indistinguishable from success.

A `0` proves only that the models resolved, not that anything drew. A lit material whose shadow map is missing draws nothing, with no console error. Judge what draws from a screenshot. Include a fresh page whose first view is outdoors, such as the splash's first shots, because a run that starts in a room can miss a fault that only shows outside.

## Notes

- Wrap any `eval --stdin` script that awaits in an async IIFE. `eval` runs a script body, not a module, so top-level `await` and top-level `return` both throw a `SyntaxError`.
- An `eval` whose promise awaits longer than about 25 s never returns, and its `agent-browser` process hangs. Keep each eval's awaits to 12 s or less, and run several evals from the shell for a longer hold. A press held down stays held across evals, until its `pointerup` or a hidden tab.
- Gate every wait on a predicate over `window.somnio`, not a sleep. Model prewarm makes first-load timing variable.
- A tap that silently walks nowhere is usually the input gate, not broken input. The frame loop requires `attached` and no overlay; check `window.somnio.overlay()` first. Then read `walk()`: `undefined` straight after the tap means the press never reached the ground (it landed on a body, which selects instead, or before the first join), and a path that stays empty means no way was found, often just after `enterSpace` while the sector's walk raster is still being computed. Each frame's elapsed time is clamped to 100 ms, so a stalled tab resumes the player's walk without teleporting.
- Before blaming movement for a player who looks trapped, check that the client still ticks. Wrap `GameplayPredictor.prototype.runTick` from `/src/client/predictor.ts`, as the bubble recipe wraps `placedBubbles`, so each call counts a tick and records `this.walk?.kind` and `this.walk?.searches`, which `walk()` leaves out. Sample that record on a `setInterval` over a few seconds, not on `requestAnimationFrame`, which stops with the tick, together with `document.visibilityState` and each sample's distance from `player()` to the bodies in `entities()`. A headless page that stops ticking looks like a body trap: the walk stays under way, nothing moves, and the tick count and the searches stand still. A real trap keeps ticking while the searches climb until the walk ends.
- A fallen player does not move at all (their own entry in `entities()` has `condition: 'fallen'`), and a winded one (`winded()`) is held to `walk` whatever Run says.
- Enter, while the world has the keyboard and no focused control takes it, opens the chat with its field focused; Enter there sends the line and closes it, and so does Escape without sending. The open chat leaves the gate open, so a walk goes on while the player types. Shift and `Digit1`–`Digit6` type into the field then instead of toggling Run and slot 1 or using an ability.
- Activate a DOM control with a real pointer gesture on a ref from a snapshot: `agent-browser click @ref` for a panel button or a tab of the Character window, opened from the Character button right of the Spirit globe. A mouse's click on an item does nothing; `agent-browser dblclick @ref` on an item does its action at once and leaves no card open; on the purse it says the coins in the chat. On a finger's layout a tap on an item opens its card (`.hud-item-card`, a dialog named for the item) with its icon, rarity, slot, and stat lines and its buttons: Drop and Equip on a carried item, Unequip on a worn one, which is disabled and says "Your bag is full." while the bag is full. A second tap on the item, a press anywhere else, or Escape closes the card, and Escape closes it before the window. Enter on a focused item opens its card with its button focused, and Enter on the purse says the coins. Hovering an item shows its tip with the same lines and how to act on it. A control replaced by a re-render between press and release never gets its click. A real gesture shows that, and `element.click()` in an `eval` hides it, because it lands in one tick. `agent-browser dblclick` sends one click with `detail: 2`, not two clicks, so a double click on a button (a trade the lock should let through once) needs `mouse move` to the button's centre, then `mouse down` and `mouse up` twice, in one `agent-browser batch`.
- Confirm a new or moved clickable HUD control with a real `agent-browser click` on it. The web unit suite runs under happy-dom with none of the HUD's CSS loaded and no hit testing, so a `pointer-events: none` rule that wins over the control, such as a later rule of equal specificity for another class the control carries, passes every unit test while no real click reaches it. `agent-browser click` refuses a covered target with "covered by <element>", which names what takes the click.
- Test a panel while balance is recovering, when `energy` frames arrive several times a second. Away from nightmares only running drains balance, and one run drains little. Drain with Run on and repeated short walks back and forth within 2 m of the NPC (taps on the ground either side of the player), then open the panel with a press at the NPC and press its button in the very next call: balance is back to full in about eight seconds.
- A carrier's panel (a master's, Mercus's, a quest giver's, or the bounty board's) stands down the right edge. On a mouse in a window at least 760 px wide (`BESIDE_CARRIER_PANEL_WIDTH` in `hud.ts`), every window stands to its left, so a real click on an item in the Character window reaches it with the panel open. In a narrower window, and on a finger, a window and the panel take turns: the panel opening closes the windows, and a window opening closes the panel, so widen the viewport when a test needs both. The panel's body scrolls and keeps its offset across rebuilds, so in a short window its first lines can be scrolled out of view; that is not a defect.
- `agent-browser mouse wheel` over the chat scrollback does not scroll it in a headless session: its `scrollTop` is unchanged even when read after a pause. To scroll it to a given offset, set its `scrollTop` from an `eval` (`document.querySelector('.chat-scrollback').scrollTop = 40`). The play field's zoom still takes the wheel.
- Navigating the game tab to `about:blank` (`agent-browser open about:blank`) leaves its gameplay socket open, and the server keeps the player logged in. To log that player in again, close the session (`agent-browser --session <name> close`) and wait as in the relocation recipe.
- Bodies standing on one spot (a bot on the spawn) overlap on screen, and a press at `screenPoint(id)` reaches the body nearer the camera. Aim a little beside it, on the side away from the other body, and confirm the press reached the intended entity: `target()` for a selection, `servicePanel()` for a carrier. A press at another body's `screenPoint` never picks the player's own, which is left out of the pick.
- Separate `agent-browser` calls are slow enough to miss a short server window, such as letting go before a 6 s raise finishes. Do the timed steps inside one `eval`, within the 12 s limit on its awaits.
- Esc takes one thing away at a time during a session: the chat, a phone's menu sheet, the newest open window, then the target, and only then does it open the game menu. On the version-skew overlay it goes to the login overlay, and there it is inert — nothing is behind it to resume to.
- `chatHistory()` returns localized text and the client picks German from `navigator.languages`. Assert on substrings unless the locale is pinned (the German UI recipe pins it).
- Vite hot-reloads code changes. An edit to a `.ts` file made while a session is attached reloads the page: a client that did not check "Remember password" is back on the login overlay, the earlier snapshot's refs are dead, and the fields may still hold their text. After an asset-pack change, re-run `Scripts/bundle-web-assets.sh` and restart Vite — the served asset root is a copy, enumerated at startup.
- When Step 4's gate times out, read the visible notice: `agent-browser eval 'document.querySelector(".blocking-notice:not(.hidden)")?.textContent'`. The WebGL notice means the browser cannot render the world — rerun with `agent-browser --headed`, which gets a hardware GPU context. "Turn your phone sideways." means a coarse-pointer session at an upright viewport: widen it past its height.
- A headless session renders on the hardware GPU or on software GL, depending on the host. Read the renderer before measuring frame times: `agent-browser eval '(() => { const gl = document.createElement("canvas").getContext("webgl2"); return gl.getParameter(gl.getExtension("WEBGL_debug_renderer_info").UNMASKED_RENDERER_WEBGL) })()'`. When it names the GPU, frame times measured headless are representative, so treat a spike that recurs at the same trigger as real and profile it (`agent-browser profiler start`, then `profiler stop <path>`) before attributing it. When it names SwiftShader or llvmpipe, rerun `--headed` before measuring.
- On teardown, close the browser sessions (`agent-browser close`, plus `--session a` / `--session b` for the two-player recipe, `--session de` for the German UI, and `--session phone` for the phone layout) and stop Vite, but keep the Postgres container so the dev character persists (see `/somnio-server`).
