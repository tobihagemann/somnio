---
name: somnio-server
description: "Run the gameplay server locally (Postgres + dev env on port 17662) for local play and testing. Use when the user asks to run, start, or stand up the dev/local server, or needs a server for the browser client or admin CLI to connect to. For production deploys, use the deploy skill instead."
---

# Run Server (Local Dev)

Runs the gameplay server locally on port 17662 against a Postgres container — the backend the browser client and admin CLI connect to during development.

## Step 1: Ensure Postgres is running

Convention: a `somnio-pg` container (postgres:16) on host port **17663**, Somnio's assigned database port.

```bash
docker ps --filter name=somnio-pg
# if not listed, it has likely EXITED rather than never existed — check and restart:
docker ps -a --filter name=somnio-pg
docker start somnio-pg
# only if truly absent:
docker run -d --name somnio-pg -p 17663:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=somnio postgres:16
```

The container can exit silently between sessions (podman machine hiccups). A server started against the dead container fails at startup with a connection error from the readiness probe — that signature means "start the container", not a code bug and not a reason to re-create the container.

The migration refuses a database carrying the Swift-era schema (`LegacyDatabaseError`). Reset one with `docker exec somnio-pg psql -U postgres -c 'DROP DATABASE somnio' -c 'CREATE DATABASE somnio'`; that drops the dev account and character, so the next login shows "Bad credentials" until you register again.

On teardown use `docker stop somnio-pg` — keep the container; `docker rm`-ing it drops the dev account/character the same way.

## Step 2: Install

```bash
npm ci
```

Node 24.17.0 or newer (`.nvmrc`). Nothing is compiled: Node runs the TypeScript sources directly, so a source change takes effect on the next start. A running server keeps the old code in memory, so restart it after editing.

Check for a stale instance holding the port before launching (`lsof -nP -iTCP:17662 -sTCP:LISTEN`). A leftover server from an earlier session serves stale code while the new instance fails to bind, which reads as a healthy-but-wrong server.

## Step 3: Run the server

Launch as its own tracked background process, **with the sandbox disabled**: the command sandbox's network allowlist blocks the localhost Postgres connection (and, in some sessions, binding the listen port), so a sandboxed server logs connect failures and never reaches a healthy state.

Launch from the **main session, never from inside a subagent**: a background process started by a subagent is terminated the moment that subagent completes, so a verification subagent that restarts the server hands back a dead server. A subagent that finds the server down should report it for the main session to restart, not restart it itself.

```bash
SOMNIO_DEV_DEFAULTS=1 \
SOMNIO_DATABASE_URL=postgres://postgres:postgres@localhost:17663/somnio \
SOMNIO_DATABASE_TLS=disable \
SOMNIO_ADMIN_TOKEN=dev-admin \
SOMNIO_HTTP_HOST=127.0.0.1 SOMNIO_HTTP_PORT=17662 \
node packages/server/src/main.ts
```

`SOMNIO_DEV_DEFAULTS=1` is the explicit opt-in for the development fallbacks (the `dev-admin` token, the committed sector fixtures, the localhost database); without it a missing variable refuses to boot. The server auto-applies the migration on boot (including on a fresh empty database), so there is no manual migration step. `SOMNIO_SECTORS_DIR` defaults to the committed map fixtures (`packages/core/fixtures/sectors`); set it to load a different sector directory.

Sectors are loaded **once at startup** — after editing any `.somnio-sector` fixture, restart the server or it keeps serving the old map data.

Logs go to stdout as JSON and to `./logs/gameplay-log.log` and `./logs/admin-log.log` under the working directory (the admin `log`/`weblog` verbs read those files).

## Step 4: Verify

```bash
curl -fsS http://127.0.0.1:17662/health   # expect {"status":"ok","db":"ok"}
```

## Notes

- Port 17662 is Somnio's assigned dev port and the browser client's Vite proxy target, so the client reaches it with no override.
- The admin CLI connects to `ws://127.0.0.1:17662/admin` with token `dev-admin`, which is also what it falls back to with no environment set.
