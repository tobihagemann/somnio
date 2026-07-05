---
name: somnio-server
description: "Build and run the gameplay server locally (Postgres + dev env on port 8090) for local play and testing. Use when the user asks to run, start, or stand up the dev/local server, or needs a server for the player client or admin CLI to connect to. For production deploys, use the release-server skill instead."
---

# Run Server (Local Dev)

Runs the gameplay server locally on port 8090 against a Postgres container — the backend the player client and admin CLI connect to during development.

## Step 1: Ensure Postgres is running

Convention: a `somnio-pg` container (postgres:16). On this machine it maps host port **5433** (an unrelated stack owns 5432 — connecting there fails with confusing 28P01 auth errors, not a refused connection). Always confirm the mapped port and use it in Step 3:

```bash
docker ps --filter name=somnio-pg   # check the Ports column, e.g. 0.0.0.0:5433->5432/tcp
# if absent:
docker run -d --name somnio-pg -p 5433:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=somnio postgres:16
```

On teardown use `docker stop somnio-pg` — keep the container; `docker rm`-ing it drops the dev account/character, and the next login then shows "Bad credentials" against the fresh empty DB.

## Step 2: Build

```bash
swift build
```

Always rebuild before (re)starting — a running server keeps the old code in memory after a binary change. Also check for a stale instance holding the port before launching (`lsof -nP -iTCP:8090 -sTCP:LISTEN`): a leftover `SomnioServer` from an earlier session serves stale code while the new instance crashes on startup, which reads as a healthy-but-wrong server.

## Step 3: Run the server

Launch as its own tracked background process, **with the sandbox disabled**: the command sandbox's network allowlist blocks the localhost Postgres connection, so a sandboxed server logs repeated connect timeouts and never reaches a healthy state (looks like a DB outage, not a sandbox error).

```bash
SOMNIO_DATABASE_URL=postgres://postgres:postgres@localhost:5433/somnio \
SOMNIO_DATABASE_TLS=disable \
SOMNIO_ADMIN_TOKEN=dev-admin \
SOMNIO_HTTP_HOST=127.0.0.1 SOMNIO_HTTP_PORT=8090 \
.build/debug/SomnioServer
```

The server auto-applies pending migrations on boot (including on a fresh empty DB), so there is no manual migration step. `SOMNIO_SECTORS_DIR` defaults to the committed map fixtures (`Tests/SomnioMapFixturesTestSupport/MapFixtures`) in debug; set it to load a different sector directory. Sectors are loaded **once at startup** — after editing any `.somnio-sector` fixture (objects, collision masks, spawns), restart the server or it keeps serving the old map data.

## Step 4: Verify

```bash
curl -fsS http://127.0.0.1:8090/health   # expect 200
```

## Notes

- Port 8090 is the dev convention; the client's compile-time debug default is 8080 (often occupied by unrelated processes), so the player overrides the endpoint via `SOMNIO_SERVER_URL`.
- The admin CLI connects to `ws://127.0.0.1:8090/admin` with `SOMNIO_ADMIN_TOKEN=dev-admin`.
