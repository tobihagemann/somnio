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

**Scope: player-facing only, framed as a net delta.** `CHANGELOG.md` becomes the *player* GitHub Release notes, so it must describe only what a player experiences between releases. Before promoting, review every `[Unreleased]` entry and:

- **Drop non-player changes.** Editor-only work (map authoring, object/floor pickers, sector-file save/open) does not ship to players — the editor isn't CI-released. Server-only work releases separately via `/release-server` and has no changelog. Neither belongs here.
- **State the net delta from the last released version, not the development history.** The `[Unreleased]` section accumulates commit-by-commit, so it collects entries that only make sense relative to an intermediate unreleased build (e.g. "no longer does X" / "removed the Y jitter" where X or the Y bug never shipped to players). Rewrite or drop those so each entry reads as a change the previous release's users will actually notice.
- **Check each entry's subject against the last tag, don't just scan the phrasing.** A positively-phrased entry hides the same trap: "Match wall collision exactly to the visible walls — no more invisible barriers beside thin walls" reads like a fix players would notice, but if the walls arrived in this same cycle, nobody on the previous release ever hit that bug. For every entry, confirm the thing it changes or fixes existed at the last player tag — `git show <last-player-tag>:<path>`, or diff the fixture/source it touches. When it did not, fold the entry into whatever introduced the feature, or drop it. One entry per net user-visible change, not one per commit.
- **Describe the experience, not the mechanism.** "Sector floors can carry material patches" is the implementation; "Edaria has cobbled streets" is what a player sees. Authoring detail ("rotated props", "the mask sits flush on the sector edge") belongs in the commit, not the release notes.

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

- **Check for a breaking wire change before tagging:** `git diff <last-player-tag> HEAD -- Sources/SomnioProtocol/`. If any wire shape, JSON key, or field type changed, bump `SomnioProtocolConstants.helloVersion` first (a fresh commit on `main`) and deploy the matching server. The Hello handshake shows an outdated player the clean "update required" overlay only when the version differs; a stale `helloVersion` lets a skewed pair pass the handshake and then fail with an opaque decode/close.
- **A breaking wire change is a three-component release.** The browser client sits on the same Hello gate but does not share `SomnioProtocol` — it carries its own hand-mirrored `helloVersion` (`Web/src/protocol/constants.ts`), so a Swift-side bump must be repeated there in the same commit or every browser player is locked out. Run the `/release` skill to sequence all three.
- A published player connects to production only once the matching server is deployed (run the `/release-server` skill) and `SOMNIO_GAMEPLAY_PRODUCTION_URL` points at it.
- Reserve each `X.Y.Z` for one set of artifacts — re-tagging a published version reuses the Release and appcast URLs for different content.
- The editor, server, and browser client release separately: a signed editor DMG via `Scripts/release.sh editor`, the server via the `/release-server` skill, the browser client via the `/release-web` skill.
