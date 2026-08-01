---
name: release-web
description: "Cut a browser-client release by pushing a web-X.Y.Z tag, which triggers the web-image.yml CI workflow to build and publish the Three.js client image to ghcr.io, then deploy it. Use when the user asks to release or deploy the web/browser client, ship a new web version, publish the web image, or cut a web-X.Y.Z release."
---

# Release Web

The browser client ships as a static-nginx container image: pushing a `web-X.Y.Z` git tag triggers `.github/workflows/web-image.yml`, which builds `Web/Dockerfile` from a **repository-root** context and pushes to `ghcr.io/tobihagemann/somnio-web` tagged `X.Y.Z` (plus `latest` and `sha-<sha>`). The bare `X.Y.Z` is the marketing version; the `web-` prefix is the component selector. The web client is a Package (ghcr), not a GitHub Release, and has no changelog step — `CHANGELOG.md` is the *player* release notes.

## Step 1: Pick the version and confirm the commit is on main

Choose the bare version `X.Y.Z`. The workflow publishes only commits reachable from `origin/main`, so the release commit must already be pushed to `main`. Confirm with `git merge-base --is-ancestor <commit> origin/main`.

## Step 2: Check the protocol pair and the asset pack

Two things the workflow does not verify, both of which ship a broken client if wrong:

- **`helloVersion` is hand-mirrored in TypeScript.** `Web/src/protocol/constants.ts` carries its own `helloVersion`, and the connection gate is strict equality (`Web/src/client/connectionController.ts`). Bumping `SomnioProtocolConstants.helloVersion` in Swift does **not** propagate — the local `npm test` suite has no pin for it, and CI's `wire-conformance` job only proves the client agrees with the *same commit's* server, never the deployed one. Before tagging, compare the TS constant against `Sources/SomnioProtocol/Constants.swift` and against the deployed server's tag (the image pinned in the deployment repo, then `git show <tag>:Sources/SomnioProtocol/Constants.swift`).
- **The asset pack is a separate repo, taken at its default-branch HEAD.** The workflow checks out `tobihagemann/somnio-assets` with no `ref:`, so a release referencing a newly authored model needs that model pushed to `somnio-assets` **first**. The workflow hard-fails only on missing `Web/Models/`, `FloorMaterials/`, or `UI/` subtrees; an individual missing `.glb` renders a placeholder with no error. The pack is therefore not pinned to the release either: an unrelated asset change landing between two web tags ships silently, and re-running the same tag later can produce a different image.

## Step 3: Trigger the build

Preferred — push a component-prefixed tag:

```bash
git tag -a web-X.Y.Z -m "web-X.Y.Z" <commit>
git push origin web-X.Y.Z
```

Alternative — manual dispatch (a blank version produces a `0.0.0-<sha>` dev image):

```bash
gh workflow run web-image.yml -f version=X.Y.Z
```

Dispatch is not equivalent to tagging: it publishes `:X.Y.Z` and `:sha-<sha>` but does **not** move `:latest` (that is tag-push only), and it builds the dispatched ref's current HEAD rather than a chosen commit. The main-ancestry guard is unconditional, so dispatching from a side branch fails there rather than producing a dev image.

## Step 4: Monitor

Watch the run to completion — `gh run watch <id> --exit-status`. The reliable confirmation is the **Build and publish image** step succeeding; that step is what pushes the tags. Querying ghcr directly (`gh api .../packages/container/somnio-web/versions`) needs a `read:packages`-scoped token and otherwise returns HTTP 403, so don't rely on it.

The build fails closed on a missing version stamp: `Web/Dockerfile` greps `dist/bundle/*.js` for the literal `somnio-web ${MARKETING_VERSION}`. Two distinct defects trip it — the version never reached `vite.config.ts`'s `define` (the About overlay would report the `0.0.0` fallback), or the stamp did not fold to a string literal (About is correct, but no deployed build can be identified from its bundle). Read the preceding build output rather than assuming which.

## Step 5: Deploy

On the deployment host, pull the new tag and restart (the image serves static files only; TLS and the `/` vs `/ws` split both live in the fronting proxy):

```bash
docker pull ghcr.io/tobihagemann/somnio-web:X.Y.Z
# point compose/runtime at :X.Y.Z, then:
docker compose up -d
```

Verify:

```bash
curl -fsS https://<host>/ >/dev/null                  # entry document serves
docker compose exec web printenv SOMNIO_WEB_VERSION   # expect X.Y.Z
```

Do **not** try to `grep` the version out of the served document. The `data-somnio-build` stamp is written by `Web/src/main.ts` once the bundle executes, so it exists only in the live DOM — a `curl` of `index.html` shows nothing, and a grep against it fails on every correct deploy. The runtime `SOMNIO_WEB_VERSION` env var exists in the nginx stage for exactly this check.

End-to-end, the About overlay shows players the same version: log in, then Esc menu → About (Esc is inert while disconnected).

## Notes

- **A web deploy reaches every player on their next reload.** `Web/nginx.conf` serves the entry document `no-store`, so there is no opt-in step like the player's Sparkle prompt. On a wire-breaking release, deploy the server first and the web image immediately after — the reverse leaves every browser player locked out at the handshake until the server catches up. The `/release` skill owns the full sequencing.
- The client's endpoint is origin-relative (`wss://<host>/ws`), so `/` and `/ws` must share an origin. The image does **not** proxy `/ws` itself; whatever fronts it performs the split (Traefik in production, the `proxy` service in `docker-compose.example.yml` locally).
- ghcr image tags are mutable — re-pushing `web-X.Y.Z` overwrites `:X.Y.Z`. A running container keeps its current image until the next pull + recreate.
- The player and server release separately, via the `/release-player` and `/release-server` skills. A protocol change needs all three.
