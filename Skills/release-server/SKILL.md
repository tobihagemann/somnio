---
name: release-server
description: "Cut a server release by pushing a server-X.Y.Z tag, which triggers the docker-image.yml CI workflow to build and publish the gameplay server image to ghcr.io, then deploy it. Use when the user asks to release the server, ship a new server version, publish the server image, or cut a server-X.Y.Z release."
---

# Release Server

The server ships as a container image: pushing a `server-X.Y.Z` git tag triggers `.github/workflows/docker-image.yml`, which builds the Linux server image and pushes it to `ghcr.io/tobihagemann/somnio-server` tagged `X.Y.Z` (plus `latest` and `sha-<sha>`). The bare `X.Y.Z` is baked into the image as `SOMNIO_SERVER_VERSION`, which the admin `version` verb reports; the `server-` prefix is the component selector. The server is a Package (ghcr), not a GitHub Release.

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

Dispatch is not equivalent to tagging: it publishes `:X.Y.Z` and `:sha-<sha>` but does **not** move `:latest` (that is tag-push only), and it builds the dispatched ref's current HEAD rather than a chosen commit. The main-ancestry guard is unconditional, so dispatching from a side branch fails there rather than producing a dev image.

## Step 3: Monitor

Watch the run to completion — `gh run watch <id> --exit-status`. The reliable confirmation is that workflow's **Build and publish image** step succeeds; that step is what pushes the tags. Querying ghcr directly (`gh api .../packages/container/somnio-server/versions`) needs a `read:packages`-scoped token and otherwise returns HTTP 403, so don't rely on it.

## Step 4: Deploy

On the deployment host, pull the new tag and restart the server (TLS terminates at the reverse proxy; the server speaks plain HTTP/WS):

```bash
docker pull ghcr.io/tobihagemann/somnio-server:X.Y.Z
# point compose/runtime at :X.Y.Z, then:
docker compose up -d
```

The server auto-applies the migration on boot. Verify readiness:

```bash
curl -fsS http://<host>:<port>/health   # expect 200
```

## Notes

- **Check for a breaking wire change before releasing:** `git diff <last-server-tag> HEAD -- packages/protocol/`. If any wire shape, JSON key, or field type changed, bump `helloVersion` in `packages/protocol/src/constants.ts` first (a fresh commit on `main`, tagged by this release and the web release). The server and the browser client share that one package; the only guard is the Hello handshake, where the server sends `helloVersion` and the client compares it with strict equality. Bumping it makes a skewed pair show the clean "update required" overlay; a stale `helloVersion` lets the pair pass the handshake and then fail with an opaque decode/close.
- Deploy the server **before** a web release whose wire protocol changed — with no version negotiation beyond the Hello gate, an old client hitting the new server (or vice versa) only fails gracefully if `helloVersion` was bumped. The `/release` skill owns the cross-component sequencing and its outage window.
- **The target database must be free of the Swift-era schema:** the migration refuses one (`LegacyDatabaseError`), so it has to be dropped and recreated. The deployment repo records the steps.
- ghcr image tags are mutable — re-pushing `server-X.Y.Z` overwrites `:X.Y.Z`. A running container keeps its current image until the next pull + recreate.
- **Rolling back to 0.2.0 or earlier means pulling `ghcr.io/tobihagemann/somnio`.** ghcr cannot rename a package in place, so the pre-0.3.0 history stays under the bare name.
