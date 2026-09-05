---
name: release
description: "Decide which Somnio components a change requires releasing, bump helloVersion when the wire broke, and sequence the server and browser-client releases in the order that avoids an outage. Use when the user asks to cut a release, release Somnio, release everything, or does not yet know which components need releasing. For a single named component, use the release-server or release-web skill instead."
---

# Release

Somnio releases per component, each with its own tag prefix and its own skill. This skill decides what to release, whether the wire broke, and in what order.

## Step 1: Determine which components changed

Each component has its own last-released tag, so take the union of two diffs:

```bash
git tag -l 'server-*' --sort=-v:refname | head -1
git tag -l 'web-*' --sort=-v:refname | head -1
git diff --name-only <that-component-tag>..HEAD
```

A component whose glob returns nothing has no tag to diff against, so treat every path in the table below as changed for it and diff from the root commit instead: `git diff --name-only $(git rev-list --max-parents=0 HEAD)..HEAD`.

Map the changed paths. The package graph is what decides: the browser client is not confined to `packages/web/`, because it imports `@somnio/protocol` and `@somnio/core`, and the server imports those plus `@somnio/data`.

| Changed path | Needs releasing |
|---|---|
| `packages/protocol/` | server + web — go to Step 2 |
| `packages/core/` (including `data/ModelRegistry.json` and `data/catalog.json`) | server + web |
| `packages/data/`, `packages/server/`, root `Dockerfile` | server |
| `packages/web/`, `Scripts/bundle-web-assets.sh`, `Scripts/glb-buffer-uris.mjs` | web |
| `packages/web/src/editor/`, `packages/web/editor.html`, `packages/web/vite.editorFs.ts` | nothing — the web editor is dev-only, served by `vite dev` and excluded from the image by construction |
| `packages/cli/` | nothing — the admin CLI has no release channel; operators run it from a checkout |
| `packages/core/fixtures/sectors/*.somnio-sector` | no image release, but **not** a no-op: production bind-mounts the world from the deployment repo (copies of those fixtures). Copy the current fixtures there in the same commit as the version pin, or the new server serves the old world |
| anything else | trace it through the `package.json` dependency graph: whichever image's package depends on the changed package needs releasing |

When a path is ambiguous, release the extra component. That costs a version number; missing one leaves players on stale code.

## Step 2: Decide whether the wire broke

```bash
git diff <last-server-tag> HEAD -- packages/protocol/
```

The wire broke if any message shape, JSON key, or field type changed. The decoders read JSON keys by name, so **renaming a payload property renames the wire key** — that counts.

- **Wire intact** (the common case): skip Step 3. The components are independent; release each changed one in any order, then stop.
- **Wire broke**: continue to Step 3. Both components are now coupled, whatever Step 1 said.

Additive-only changes (a new optional field) do not break the wire and need no bump. When unsure, treat it as broken — an unnecessary bump costs one forced reload; a missed one costs an opaque decode failure with no diagnosis path.

## Step 3: Bump `helloVersion`

The gate is strict equality on the client. `helloVersion` lives in one file, `packages/protocol/src/constants.ts`, which the server and the browser client both import — bump it in a commit on `main` and tag both releases from that commit or later.

## Step 4: Release in order

**Wire intact:** order is irrelevant. Run the skill for each component Step 1 flagged — the `/release-server` or `/release-web` skill — and stop.

**Wire broke:** the Hello gate admits no overlap, so the instant the server flips, every client on the old protocol is locked out. The sibling skills interleave building and deploying, so do not run them end to end back-to-back — split them into two phases:

**Phase 1 — build both from the bump commit.** Run the `/release-server` skill through its Step 3, then the `/release-web` skill through its Step 4. Both images now sit in ghcr, undeployed. Version numbers are per-component and need not match.

**Phase 2 — deploy.** Run the `/release-server` skill's Step 4, then the `/release-web` skill's Step 5 immediately after. Browser players self-heal on their next reload (the entry document is `no-store`); the gap between the two is their outage window, so keep it to minutes.

Phase 1 proves the tags you built. It says nothing about one the deployment repo already pins — a placeholder from an earlier session pins a version just as convincingly as a real release. For any pin you did not build just now, confirm the image exists:

```bash
gh run list --workflow=<file> --branch <component-tag>   # zero runs = never built
```

Scope it to the tag. Unscoped, the command counts every run of that workflow and stays non-zero while the version you are about to deploy is missing entirely.

Server before web, not the reverse: a web image deployed ahead of the server hands every browser player a bundle that cannot connect, and it stays broken until the operator finishes. Server-first leaves only a state a reload repairs.

**Confirm the window is closed.** `/health` and a 200 at `/` prove the containers booted, not that the protocol matches — read the handshake the client actually gates on:

```bash
node -e 'const W=require("ws"),s=new W("wss://<host>/ws");s.on("message",d=>{console.log(d.toString());process.exit(0)})'
```

Expect `{"tag":"hello","payload":{"protocolVersion":N}}` with `N` equal to the `helloVersion` in the commit you tagged. Anything else means a client is still locked out. (`ws` is already in `node_modules`.)

## Notes

- Neither image has a changelog step; `CHANGELOG.md` records player-facing changes per server release under the `server-*` tags.
- Check what is **deployed**, not what is on `main` — they routinely differ, and only the deployed `helloVersion` governs whether a client can connect. The pinned tags live in the deployment repo.
