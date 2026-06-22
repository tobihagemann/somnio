---
name: release-server
description: "Cut a server release by pushing a server-X.Y.Z tag, which triggers the docker-image.yml CI workflow to build and publish the gameplay server image to ghcr.io, then deploy it. Use when the user asks to release the server, ship a new server version, publish the server image, or cut a server-X.Y.Z release."
---

# Release Server

The server ships as a container image: pushing a `server-X.Y.Z` git tag triggers `.github/workflows/docker-image.yml`, which builds the Linux server image and pushes it to `ghcr.io/tobihagemann/somnio` tagged `X.Y.Z` (plus `latest` and `sha-<sha>`). The bare `X.Y.Z` is stamped into the binary as the marketing version; the `server-` prefix is the component selector. The server is a Package (ghcr), not a GitHub Release.

## Step 1: Pick the version and confirm the commit is on main

Choose the bare version `X.Y.Z`. The workflow publishes only commits reachable from `origin/main`, so the release commit must already be pushed to `main`. Confirm with `git merge-base --is-ancestor <commit> origin/main`.

## Step 2: Trigger the build

Preferred — push a component-prefixed tag:

```bash
git tag -a server-X.Y.Z -m "server-X.Y.Z" <commit>
git push origin server-X.Y.Z
```

Alternative — manual dispatch (a blank version produces a `0.0.0-<sha>` dev image):

```bash
gh workflow run docker-image.yml -f version=X.Y.Z
```

Dispatch is not equivalent to tagging: it publishes `:X.Y.Z` and `:sha-<sha>` but does **not** move `:latest` (that is tag-push only), and it builds the dispatched ref's current HEAD rather than a chosen commit.

## Step 3: Monitor

Watch the run to completion — `gh run watch <id> --exit-status`. The reliable confirmation is that workflow's **Build and publish image** step succeeds; that step is what pushes the tags. Querying ghcr directly (`gh api .../packages/container/somnio/versions`) needs a `read:packages`-scoped token and otherwise returns HTTP 403, so don't rely on it.

## Step 4: Deploy

On the deployment host, pull the new tag and restart the server (TLS terminates at the reverse proxy; the server speaks plain HTTP/WS):

```bash
docker pull ghcr.io/tobihagemann/somnio:X.Y.Z
# point compose/runtime at :X.Y.Z, then:
docker compose up -d
```

The server auto-applies pending migrations on boot. Verify readiness:

```bash
curl -fsS http://<host>:<port>/health   # expect 200
```

## Notes

- Deploy the server **before or together with** a player release whose wire protocol changed: the player and server share `SomnioProtocol` and there is no version negotiation yet, so a skewed pair fails with an opaque decode/close.
- ghcr image tags are mutable — re-pushing `server-X.Y.Z` overwrites `:X.Y.Z`. A running container keeps its current image until the next pull + recreate.
