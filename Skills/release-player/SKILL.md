---
name: release-player
description: "Cut a player (macOS client) release by pushing a player-X.Y.Z tag, which triggers the release.yml CI workflow to build, sign, notarize, DMG, generate the Sparkle appcast, and publish a GitHub Release. Use when the user asks to release the player, ship a new player/client version, or cut a player-X.Y.Z release."
---

# Release Player

Releasing the player is just pushing a `player-X.Y.Z` git tag; CI (`.github/workflows/release.yml`) does the rest, and all secrets (signing/notarization, the `ASSETS_DEPLOY_KEY` asset pack, the `SOMNIO_GAMEPLAY_PRODUCTION_URL` variable) are already configured. The bare `X.Y.Z` is the marketing version that names the bundle and assets; the full tag (`RELEASE_TAG`, `player-X.Y.Z`) names the GitHub Release and the Sparkle download URL, so the two must stay aligned.

## Step 1: Pick the version and confirm the commit is on main

Choose the bare version `X.Y.Z`. The workflow signs only commits reachable from `origin/main`, so the release commit must already be pushed to `main`. Confirm with `git merge-base --is-ancestor <commit> origin/main`.

## Step 2: Trigger the release

Preferred — push a component-prefixed tag:

```bash
git tag player-X.Y.Z <commit>
git push origin player-X.Y.Z
```

Alternative — manual dispatch (enter the bare version; the `player-` prefix is added). The `dry_run` input defaults to true (build + sign + notarize, skip publish); set it false to publish:

```bash
gh workflow run release.yml -f version=X.Y.Z -f dry_run=false
```

## Step 3: Monitor and finish

1. Watch the run: `gh run watch` (or `gh run list --workflow=release.yml`).
2. On success the workflow commits the regenerated `appcast.xml` to `main` — run `git pull` so local `main` keeps it.
3. Verify the GitHub Release and its assets: `gh release view player-X.Y.Z`.

## Notes

- A published player connects to production only once the matching server is deployed (run the `/release-server` skill) and `SOMNIO_GAMEPLAY_PRODUCTION_URL` points at it.
- Reserve each `X.Y.Z` for one set of artifacts — re-tagging a published version reuses Release/appcast URLs for different content.
- The editor is not released here; build a signed, notarized editor DMG locally with `Scripts/release.sh editor`.
