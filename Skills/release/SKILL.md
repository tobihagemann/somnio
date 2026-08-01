---
name: release
description: "Decide which Somnio components a change requires releasing, bump helloVersion across Swift and TypeScript when the wire broke, and sequence the player, server, and browser-client releases in the order that avoids an outage. Use when the user asks to cut a release, release Somnio, release everything, or does not yet know which components need releasing. For a single named component, use the release-player, release-server, or release-web skill instead."
---

# Release

Somnio releases per component, each with its own tag prefix and its own skill. This skill decides what to release, whether the wire broke, and in what order.

## Step 1: Determine which components changed

Each component has its own last-released tag, so take the union of three diffs:

```bash
git tag -l 'player-*' --sort=-v:refname | head -1
git tag -l 'server-*' --sort=-v:refname | head -1
git tag -l 'web-*' --sort=-v:refname | head -1
git diff --name-only <that-component-tag>..HEAD
```

A component with no tag yet has changed by definition — release it if anything in its column moved. (`web-*` currently returns nothing; the browser client has never been tagged.)

Map the changed paths. The `Sources/` rows are the ones that surprise people: the browser client is not confined to `Web/`, because `Web/Dockerfile` copies four files out of `Sources/` and Vite resolves them through aliases.

| Changed path | Needs releasing |
|---|---|
| `Sources/SomnioProtocol/` | all three — go to Step 2 |
| `Sources/SomnioCore/Resources/ModelRegistry.json`, or `Localizable.xcstrings` under `SomnioCore/`, `SomnioUI/`, or `SomnioApp/` | player + **web** — these four are the only `Sources/` files the web image copies. Not the server: it links SomnioCore but resolves neither the registry nor any catalog |
| `Sources/SomnioCore/` (anything else) | player + server |
| `Sources/SomnioUI/`, `SomnioTheme/`, `SomnioScene3D/`, `SomnioApp/` (outside the catalogs above) | player |
| `Sources/SomnioServerCore/`, `SomnioData/`, `SomnioServer/` | server |
| `Web/`, `Scripts/bundle-web-assets.sh`, `Scripts/glb-buffer-uris.mjs` | web |
| `Scripts/package_app.sh`, `bundle-assets.sh`, `inject-release-transport.sh`, `release.sh`, `version.env`, `Resources/` | player |
| root `Dockerfile` | server |
| `Sources/SomnioEditor/` | nothing via CI — the editor ships from `Scripts/release.sh editor`, built locally |
| `Sources/SomnioCLICore/`, `Sources/SomnioCLI/` | nothing — the admin CLI has no release channel; operators run it from a local build |
| `.somnio-sector` files | no image release, but **not** a no-op: production bind-mounts the world from the deployment repo (copies of `Tests/SomnioMapFixturesTestSupport/MapFixtures/`). Copy the current fixtures there in the same commit as the version pin, or the new server serves the old world |
| anything else | trace it through `Package.swift`: whichever executables link the changed target need releasing |

When a path is ambiguous, release the extra component. That costs a version number; missing one leaves players on stale code.

## Step 2: Decide whether the wire broke

```bash
git diff <last-server-tag> HEAD -- Sources/SomnioProtocol/
```

The wire broke if any message shape, JSON key, or field type changed. Payloads use synthesized `Codable`, so **renaming a property renames the wire key** — that counts.

- **Wire intact** (the common case): skip Step 3. The components are independent; release each changed one in any order, then stop.
- **Wire broke**: continue to Step 3. All three components are now coupled, whatever Step 1 said.

Additive-only changes (a new Optional field) do not break the wire and need no bump. When unsure, treat it as broken — an unnecessary bump costs one forced update; a missed one costs an opaque decode failure with no diagnosis path.

## Step 3: Bump `helloVersion` in one commit

The gate is strict equality on both clients, and the two language halves are not generated from each other. Bump both in the **same commit** on `main`:

- `Sources/SomnioProtocol/Constants.swift` — covers the server and the native player
- `Web/src/protocol/constants.ts` — hand-mirrored, covers the browser client

Read the two constants and confirm they match before tagging. CI's `wire-conformance` job does test this, but it cannot stop a bad release: `main` is unprotected and the history is direct-push, so a skewed commit lands and the job merely goes red afterwards.

## Step 4: Release in order

**Wire intact:** order is irrelevant. Run the skill for each component Step 1 flagged — the `/release-player`, `/release-server`, or `/release-web` skill — and stop.

**Wire broke:** the Hello gate admits no overlap, so the instant the server flips, every client on the old protocol is locked out. The sibling skills interleave building and deploying, so do not run them end to end back-to-back — split them into two phases:

**Phase 1 — build everything from the bump commit.** Run the `/release-player` skill in full, then the `/release-server` skill through its Step 3, then the `/release-web` skill through its Step 4. Both images now sit in ghcr, undeployed. Version numbers are per-component and need not match.

Note that the player is already live at this point: pushing its tag publishes the GitHub Release and the appcast, so Sparkle offers the update immediately. Anyone who takes it sits behind the "update required" overlay until Phase 2 completes, which is why Phase 2 follows promptly rather than the next day. Publishing it first is still correct — once the server flips, the remedy has to already exist.

**Phase 2 — deploy.** Run the `/release-server` skill's Step 4, then the `/release-web` skill's Step 5 immediately after. Browser players self-heal on their next reload (the entry document is `no-store`); the gap between the two is their outage window, so keep it to minutes.

Server before web, not the reverse: a web image deployed ahead of the server hands every browser player a bundle that cannot connect, and it stays broken until the operator finishes. Server-first leaves only a state a reload repairs.

**Confirm the window is closed.** `/health` and a 200 at `/` prove the containers booted, not that the protocol matches — read the handshake the clients actually gate on:

```bash
node -e 'const W=require("ws"),s=new W("wss://<host>/ws");s.on("message",d=>{console.log(d.toString());process.exit(0)})'
```

Expect `{"tag":"hello","payload":{"protocolVersion":N}}` with `N` equal to the `helloVersion` in the commit you tagged. Anything else means a client is still locked out. (`ws` is already in `Web/node_modules`.)

## Notes

- Only `CHANGELOG.md` gates the player release; the server and web images have no changelog step. The `/release-player` skill covers its scoping rules.
- A player release also needs `SOMNIO_GAMEPLAY_PRODUCTION_URL` pointing at the deployed server, or the shipped client has nowhere to connect.
- Check what is **deployed**, not what is on `main` — they routinely differ, and only the deployed `helloVersion` governs whether a client can connect. The pinned tags live in the deployment repo.
