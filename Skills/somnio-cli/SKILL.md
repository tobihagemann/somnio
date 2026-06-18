---
name: somnio-cli
description: "Build and run the Somnio admin CLI against a running gameplay server's /admin endpoint. Use when the user asks to run an admin command, list players, broadcast a say, set world time, manage the weblog, kick a player, or otherwise drive the server over the somniocli tool."
---

# Somnio Admin CLI

The admin CLI (`somniocli`) connects over a bearer-gated WebSocket to a running server's `/admin` endpoint and issues operator commands. It needs a live server; it does not start one.

## Step 1: Build

```bash
swift build
```

The binary is then at `.build/debug/SomnioCLI` (or run via `swift run SomnioCLI -- <args>`).

## Step 2: Resolve the connection

The CLI needs an admin WebSocket URL and a bearer token:

- **URL** — `--server-url ws://<host>:<port>/admin` (or env `SOMNIO_ADMIN_URL`).
- **Token** — env `SOMNIO_ADMIN_TOKEN`. Pass it via the environment, not the URL — the CLI rejects a `user:password@host` URL.

For the local dev server (run on port 8090 with `SOMNIO_ADMIN_TOKEN=dev-admin`), use `ws://127.0.0.1:8090/admin` and token `dev-admin`. When the URL/token are unset, a debug build falls back to a built-in default — but that default points at port **8080** (`ws://127.0.0.1:8080/admin`), not 8090, so pass `--server-url ws://127.0.0.1:8090/admin` explicitly to reach the dev server.

## Step 3: Run a command

Run with the sandbox disabled — the command sandbox's network allowlist blocks the localhost WebSocket connection (a sandboxed run hangs on connect, not an auth error). Example, list connected players:

```bash
SOMNIO_ADMIN_TOKEN=dev-admin .build/debug/SomnioCLI players --server-url ws://127.0.0.1:8090/admin
```

Every subcommand takes the same `--server-url` and reads `SOMNIO_ADMIN_TOKEN`.

## Subcommands

- `players` — list connected players
- `say <message>` — broadcast an admin message
- `time` — read/set the world clock
- `kick <name>` — disconnect a player by character name
- `weblog` / `weblog rm` — manage the web log
- `log` / `log rm` — manage the server log
- `version` — server version

Run `.build/debug/SomnioCLI <subcommand> --help` for each subcommand's options.
