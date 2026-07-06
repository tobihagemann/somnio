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

Produces `Somnio.app` at the repo root with textures and models bundled. The asset-pack root is the `somnio-assets` working tree (sibling repo), which carries the two runtime subtrees `Models/` (USDZ characters + props) and `FloorMaterials/`. Omit `SOMNIO_ASSET_SOURCE` to run with placeholder/nil-fallback rendering. Repackage after any change to code **or** to the asset pack — the running bundle holds stale copies of both.

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
- The chat input cannot be driven by synthetic keyboard/AX automation — key events move the character (WASD works), but the SwiftUI chat TextField overlaid on the RealityKit view never takes focus or accepts synthetic text (its AX value stays nil). Verify chat/speech-bubble behavior manually or over the wire protocol, not via UI automation.
- Auto-login fires only when "Remember password" was saved; otherwise the login sheet appears. Register via "If you don't have an account, click here!" — fresh characters spawn in the `EdariaBibliothek` starter sector.
- On teardown, stop the app but keep the Postgres container (see `/somnio-server`) so the dev character persists.
