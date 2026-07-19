---
name: somnio-player
description: "Build and launch the macOS player client locally against the dev server, for local play and testing. Use when the user asks to run, play, launch, or try the player or client, or to test a gameplay change in the running app. For production releases, use the release-player skill instead."
---

# Run Player (Local Dev)

Builds a debug player bundle and launches it against the local dev server.

## Step 1: Start the dev server

The player needs a running backend. Stand up the local server on port 8090 first — run the `/somnio-server` skill.

## Step 2: Build and package the debug player

Run with the sandbox disabled (SwiftPM packaging):

```bash
SOMNIO_ASSET_SOURCE="<asset-pack-root>" SIGNING_MODE=adhoc Scripts/package_app.sh debug player
```

Produces `Somnio.app` at the repo root with textures and models bundled. The asset-pack root is the `somnio-assets` working tree (sibling repo), which carries the runtime subtrees `Models/` (USDZ characters + props), `FloorMaterials/`, and `UI/` (panel chrome). `SOMNIO_ASSET_SOURCE` is **required** for the player bundle — packaging hard-fails without it (the `UI/` subtree styles every panel). Repackage after any change to code **or** to the asset pack — the running bundle holds stale copies of both.

Use `Scripts/package_app.sh debug player` here, not `Scripts/compile_and_run.sh`: that script launches via `open` with no `SOMNIO_SERVER_URL` override, so the debug client falls back to `:8080` and misses the `:8090` dev server. (Its `--release-*` variants additionally build release, which hits the unset production-URL `#error`.)

## Step 3: Launch against the dev server

Launch the inner binary directly, as its own tracked background process, so it inherits the endpoint override and uses the bundle's assets:

```bash
SOMNIO_SERVER_URL='ws://127.0.0.1:8090/ws' Somnio.app/Contents/MacOS/Somnio
```

Launch the binary directly rather than via Finder or `open`: environment variables don't propagate through `open`, and the debug client otherwise falls back to `ws://127.0.0.1:8080/ws`, missing the dev server on 8090.

## Testing multiplayer behaviors

To verify behavior that is only visible to *other* players (peer walk animation, "joined"/"left the game" chat lines, peer speech bubbles), launch a second instance with an isolated profile so two characters can be logged in at once:

```bash
SOMNIO_PROFILE=alice SOMNIO_SERVER_URL='ws://127.0.0.1:8090/ws' Somnio.app/Contents/MacOS/Somnio
```

`SOMNIO_PROFILE` gives each instance its own Application Support storage + UserDefaults (see CLAUDE.md "Dev/Prod Isolation"), so register/log in a different character in each. Fresh characters spawn in the `EdariaBibliothek` starter sector, so both land in the same sector and can see each other.

## Notes

- Rebuild and repackage after code changes — a running app holds the old code.
- Never launch via `open`/LaunchServices resolution — the sibling `somnio-poc/Somnio.app` is also named `Somnio.app` (its own bundle ID `de.realtobi.somnio` vs the player's `de.tobiha.somnio.player`), and name/registration-based resolution can silently start that stale POC app instead. Launch the freshly packaged bundle's inner binary by path (as above) and address the process by PID.
- No SwiftUI text field in the player accepts synthetic keyboard/AX text — not the chat input and not the login/registration overlay fields (keystrokes land in a stray macOS IME pill instead; key events still move the character once the world view has focus — see the input-automation bullets below). Menu-bar and Esc/menu flows automate via peekaboo AX clicks; verify chat/speech-bubble behavior manually or over the wire protocol.
- The login overlay's OK button is **not** automatable on this machine: it exposes no AX-pressable element (`peekaboo see` intermittently times out on the game window, and background coordinate clicks report nothing pressable at the point), and `peekaboo click --foreground` is blocked by the missing AppleScript automation permission. Getting past the login dialog takes a human click; plan agent verification over the wire protocol instead.
- Automated account setup still works over the wire: open a WebSocket to `ws://127.0.0.1:8090/ws`, receive the hello frame, send `{"tag":"register","payload":{"nickname":"...","password":"...","passwordRepeat":"...","characterClass":0,"gender":0,"email":"..."}}` (password ≥ 8 UTF-8 bytes; expect `{"tag":"registerResult","payload":{"result":0}}`) — then seed the debug file-backed credential store by writing `{"nickname":"...","password":"..."}` to `~/Library/Application Support/Somnio-Dev[-<profile>]/credential.json` so the login dialog pre-fills for the human click.
- A failed login attempt (typically racing a dev-server restart) clears the seeded `credential.json` and unchecks "Remember password" — re-seed it before relaunching or the dialog comes up empty.
- The login overlay pre-fills only when a credential is stored (the "Remember password" path or a seeded `credential.json`); otherwise it appears empty. Humans register via "If you don't have an account, click here!" — fresh characters spawn in the `EdariaBibliothek` starter sector.
- Fast visual-inspection loop (no movement automation needed): with the app closed, teleport the character in the database — `docker exec somnio-pg psql -U postgres -d somnio -c "UPDATE characters SET current_sector='EdariaMitte', position_x=1024, position_y=1000 WHERE name='...';"` — then relaunch; login resumes at the stored position (each relaunch still needs the human login click — re-seed `credential.json` first if a failed attempt cleared it). Repeat per area to screenshot different sectors (`peekaboo image --app Somnio --path ...` captures just the game window without disturbing the user's desktop).
- Full gameplay smoke runs headless over the wire protocol (python `websockets`): register a **fresh nickname per run** (character position persists per name, so a reused character resumes wherever the last run left it), log in, then drive the loop — resolve `outboundTrigger` portal indices from the received `enterSector` payload and send `enterPortal` directly (the server does not validate trigger proximity), assert the follow-up `mainCharacter`/`entity` position lands inside the destination's `arrivalPlacement` rect, teleport near NPCs with `clientPosition` (the tag is `clientPosition`, not `position`; stand *beside* an NPC, not on it), send `bumpNPC` and await the `serverSay` broadcast with `$name` substituted, and check monsters stay silent out of aggro range then emit `serverPosition` chase frames once approached. Monster spawn timers need ~60 s of server uptime — wrap the run in a retry loop after a fresh server boot. The smoke script pins fixture geometry — hardcoded arrival rects, floor/patch expectations, and the x±48 stand-beside offsets for NPC bumps — so update those constants whenever a fixture layout changes. A `clientPosition` teleport landing on a collision mask or an NPC's feet box is silently rejected by the server: the following `bumpNPC` then misses the 64px radius and the run dies as a TIMEOUT with no FAIL line, so a hang right after "arrived in <sector>" usually means the beside-spot is now inside furniture.
- Synthetic movement keys reach the game only after a mouse click into the 3D world view makes it first responder — right after the login click, focus still sits on the OK button and held keys are silently ignored (0 movement, no error).
- Keep the display awake before posting synthetic input: an asleep display drops CGEvents without error. Start `caffeinate -u -d` first, then send keys. `peekaboo` key-posting is permission-blocked on this machine — post CGEvents from an AX-trusted helper (e.g. a small Swift binary; `AXIsProcessTrusted()` must be true) while AX clicks via peekaboo keep working.
- For movement automation from the starter spawn, walk **east**: the `EdariaBibliothek` north wall's collision masks block a screen-up walk from the spawn point, which reads as "input broken" when it's just a wall.
- To verify movement/heartbeat behavior without pixels (screen recording is often unavailable), run a second raw-WebSocket observer client logged into the same sector and measure the relayed `serverPosition` frames for the mover: steady ~0.5 s deltas (≈2 Hz) at tempo 2 while a key is held, silence when idle.
- On teardown, stop the app but keep the Postgres container (see `/somnio-server`) so the dev character persists.
