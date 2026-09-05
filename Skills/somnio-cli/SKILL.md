---
name: somnio-cli
description: "Run the Somnio admin CLI against a running gameplay server's /admin endpoint. Use when the user asks to run an admin command, list players, broadcast a say, read the world time, manage the weblog, kick a player, or otherwise drive the server over the somniocli tool."
---

# Somnio Admin CLI

The admin CLI (`somniocli`) connects over a bearer-gated WebSocket to a running server's `/admin` endpoint and issues operator commands. It needs a live server; it does not start one.

## Step 1: Install

```bash
npm ci
```

Nothing is compiled: `node packages/cli/src/main.ts` runs the sources directly.

## Step 2: Resolve the connection

The CLI needs an admin WebSocket URL and a bearer token:

- **URL** — `--server-url ws://<host>:<port>/admin` (or env `SOMNIO_ADMIN_URL`).
- **Token** — env `SOMNIO_ADMIN_TOKEN`. Pass it via the environment, not the URL — the CLI rejects a `user:password@host` URL.

Against the local dev server (port 17662 with `SOMNIO_ADMIN_TOKEN=dev-admin`) no environment is needed: with the URL and token unset the CLI falls back to `ws://127.0.0.1:17662/admin` and `dev-admin`. A remote endpoint must be `wss://`, because the CLI refuses to send the token over plaintext to a non-loopback host. It also requires `SOMNIO_ADMIN_TOKEN`, because the dev token is a loopback-only fallback; a remote URL without a token exits 64. The `wss://` dial is pinned to the Let's Encrypt ISRG roots in `packages/cli/trust-roots.pem`.

## Step 3: Run a command

Run with the sandbox disabled — the command sandbox's network allowlist blocks the localhost WebSocket connection. Example, list connected players:

```bash
node packages/cli/src/main.ts players
```

Every subcommand takes the same `--server-url` (before or after the verb) and reads `SOMNIO_ADMIN_TOKEN`. Output is English, or German when `LANG`/`LC_ALL` names German.

## Subcommands

- `players` — number of logged-in players
- `say <message...>` — broadcast an admin message (an empty message is a no-op)
- `time` — read the world clock
- `kick <name>` — disconnect a player by character name
- `weblog` / `weblog rm` — read or delete the admin log
- `log` / `log rm` — read or delete the gameplay log
- `version` — server version

A usage error (unknown verb, invalid URL) exits 64; a transport failure prints `The error ... occurred.` and exits 1. Run `node packages/cli/src/main.ts <subcommand> --help` for each subcommand's options.
