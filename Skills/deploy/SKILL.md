---
name: deploy
description: "Deploy Somnio by pinning one published commit for both ghcr images (server and browser client) in the deployment repo, after checking whether the wire protocol changed since the deployed commit. Use when the user asks to deploy, ship to production, roll out, update the live server or client, or roll back."
---

# Deploy

There are no releases, tags, or version numbers. CI publishes both images from every commit on `main` that passes its checks, tagged `sha-<short>` (the commit's 7-character sha) and `latest`. Deploying is pinning one such sha for both images in the deployment repo, which redeploys on push.

## Step 1: Pick the commit

Only a commit whose `publish` job finished has images. Take the newest green run on `main` and confirm the job is in it:

```bash
gh run list --workflow=ci.yml --branch main --status success --limit 5
gh run view <run-id> --json jobs --jq '.jobs[] | select(.name == "Publish Images") | .conclusion'
```

The images are `ghcr.io/tobihagemann/somnio-server:sha-<short>` and `ghcr.io/tobihagemann/somnio-web:sha-<short>`, where `<short>` is the first seven characters of that run's commit. A run whose `Publish Images` job is absent was a pull request or a failed check; pick another commit.

## Step 2: Find what is deployed

Read the current pins from the deployment repo's compose file for Somnio: both images carry the same `sha-<short>`. That sha, not `main`, is the baseline for every check below — `main` routinely runs ahead of production.

## Step 3: Decide whether the wire broke

```bash
git diff <deployed-sha> <target-sha> -- packages/protocol/
```

The wire broke if any message shape, JSON key, or field type changed; the decoders read JSON keys by name, so a renamed payload property renames the wire key. Additive-only changes (a new optional field) do not break it. When unsure, treat it as broken.

If it broke and `helloVersion` in `packages/protocol/src/constants.ts` was not bumped between the two commits, bump it in a commit on `main`, wait for that commit's `publish` job, and deploy that sha instead. The client compares `helloVersion` with strict equality, so a mismatch is a hard lockout with no diagnosis path; a bump makes a skewed pair show the "update required" overlay instead.

## Step 4: Carry the world along

```bash
git diff --stat <deployed-sha> <target-sha> -- packages/core/fixtures/sectors/
```

Neither image contains sectors. Production bind-mounts the world from the deployment repo, so when that diff is non-empty, copy the fixtures at the target sha into the deployment repo's sector directory in the **same commit** as the pin, or the new server serves the old world.

## Step 5: Pin and push

In the deployment repo, set both image tags to `sha-<short>` of the target commit, stage only the Somnio-scoped paths (the compose file and the sector directory), and commit with a terse message naming the sha. Pushing is deploying: the deployment repo's own workflow pulls and recreates the whole stack.

Both containers restart in the same `up`, so on a wire break every open browser is locked out until it reloads; the entry document is `no-store`, so a reload repairs it. The window is the seconds between the two restarts.

## Step 6: Verify

```bash
curl -fsS https://<host>/health                       # 200
curl -fsS https://<host>/ | grep -q 'id="somnio-root"'
node -e 'const W=require("ws"),s=new W("wss://<host>/ws");s.on("message",d=>{console.log(d.toString());process.exit(0)})'
```

Expect `{"tag":"hello","payload":{"protocolVersion":N}}` with `N` equal to `helloVersion` at the target sha. The build stamp is readable from a loaded page as `document.documentElement.dataset.somnioBuild` (`somnio-web <short>`) and from the server through the admin `version` verb; both name the deployed commit. (`ws` is already in `node_modules`.)

## Rollback

Pin an earlier `sha-<short>` for both images and push. Every earlier pin is in the deployment repo's history. A rollback across a `helloVersion` bump locks out browsers the same way a forward break does, and a rollback across a sector change needs the matching sector files restored in the same commit.

## Notes

- The deployment repo is private; refer to it as "the deployment repo" in anything tracked here.
- A database carrying the Swift-era schema is refused by the migration (`LegacyDatabaseError`); it has to be dropped and recreated once. The deployment repo records the steps.
