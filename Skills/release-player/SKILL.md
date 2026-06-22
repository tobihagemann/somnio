---
name: release-player
description: "Cut a player (macOS client) release: update CHANGELOG.md on main, then push the player-X.Y.Z tag that triggers the release.yml CI workflow (build, sign, notarize, DMG, Sparkle appcast, GitHub Release). Use when the user asks to release the player, prepare/cut a player release, or ship a new client version."
---

# Release Player

Cut a player release straight from `main`: update the changelog, then push a `player-X.Y.Z` tag. CI does the build — the tag triggers `.github/workflows/release.yml`, which builds, signs, notarizes, packages a DMG, regenerates the Sparkle appcast, and publishes a GitHub Release whose body comes from `CHANGELOG.md`. Signing, asset-pack, and production-endpoint secrets are already configured in CI.

There is no version file to bump — the marketing version comes from the tag, and `CHANGELOG.md` is the only prep artifact (`version.env` holds names, not the version).

## Step 1: Determine the version

If the user did not give one, infer the next `X.Y.Z` from the latest player tag and propose a patch/minor/major bump, then confirm:

```bash
git tag -l 'player-*' --sort=-v:refname | head -1
```

## Step 2: Update the changelog

Make sure `main` is clean and current (`git checkout main && git pull origin main`). `CHANGELOG.md` keeps a running `## [Unreleased]` section, so a release completes that section and then promotes it to a version heading.

1. **Complete `[Unreleased]` via `/update-changelog`.** Run it to capture anything missing, then double-check completeness against `git log <last-player-tag>..HEAD --oneline` — that range always includes the prior `Update appcast for <last>` commit (CI pushes it to `main` after the tag) as noise, and real changes can land *after* it, so don't stop scanning there.
2. **Promote** by inserting the version heading under the kept-empty `## [Unreleased]` heading so the accumulated entries fall under the new version, add the `[X.Y.Z]: .../releases/tag/player-X.Y.Z` link reference, and repoint `[Unreleased]` to `compare/player-X.Y.Z...HEAD` (mirror the previous `Prepare player X.Y.Z` commit's changelog diff). `release.yml` extracts this version section as the GitHub Release notes.

## Step 3: Commit and push to main

```bash
git add CHANGELOG.md
git commit -m "Prepare player X.Y.Z"
git push origin main
```

The tag must land on a `main` commit: `release.yml` signs only commits reachable from `origin/main`, and it reads `CHANGELOG.md` at the tagged commit.

## Step 4: Tag and trigger the release

Tag the changelog commit and push the tag — this is what starts CI:

```bash
git tag -a player-X.Y.Z -m "player-X.Y.Z"
git push origin player-X.Y.Z
```

`release.yml` then builds, signs, notarizes, generates the appcast, creates the `player-X.Y.Z` GitHub Release (notes from the changelog section), and commits the updated `appcast.xml` back to `main`.

To rehearse the build without publishing, dispatch a dry run instead of tagging: `gh workflow run release.yml -f version=X.Y.Z -f dry_run=true`.

## Step 5: Finish

```bash
git pull origin main            # pick up the appcast commit CI pushed
gh release view player-X.Y.Z    # verify the Release and its assets
```

## Notes

- A published player connects to production only once the matching server is deployed (run the `/release-server` skill) and `SOMNIO_GAMEPLAY_PRODUCTION_URL` points at it.
- Reserve each `X.Y.Z` for one set of artifacts — re-tagging a published version reuses the Release and appcast URLs for different content.
- The editor and server release separately: a signed editor DMG via `Scripts/release.sh editor`, the server via the `/release-server` skill.
