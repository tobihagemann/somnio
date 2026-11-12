# Somnio

A browser-based mini-MMORPG with a 3D world. A TypeScript gameplay server, an admin CLI, and a Three.js browser client in one npm workspace, plus a localhost-only web map editor under `packages/web/`.

## Tech Stack

- Node 24 (`.nvmrc`), TypeScript run directly through Node's type stripping — nothing is compiled, so every package's `exports` point at `.ts` sources
- Hono + `@hono/node-server` for HTTP, `ws` for the two WebSocket routes, Kysely over `pg` for Postgres, `argon2` for password hashing, pino for logging, commander for the CLI
- Vitest for every suite; `@testcontainers/postgresql` for the integration projects
- Three.js + Vite for the browser client

## Package graph

```
packages/protocol   # message catalog, the sector view, `{tag, payload}` codec — imports nothing
packages/core       # game models (sector, character, inventory, world clock), the world of
                    # spaces and doors, geometry, collision and ground height, the rules of
                    # combat, lucidity, speech, gear, drops, the shop, quests, and bounties,
                    # the .somnio-sector codec, the model registry, the core catalog —
                    # depends on protocol
packages/data       # Postgres schema + its migrations, repositories, Argon2id hashing,
                    # SHA-256 session-token digests (unsalted so the digest column is directly
                    # searchable — safe because the token is a 256-bit CSPRNG value), the
                    # name policy — depends on core
packages/server     # gameplay/admin handlers, the per-connection actor, per-space
                    # simulation, world router, services, the HTTP/WS server, boot —
                    # depends on protocol + core + data
packages/cli        # admin CLI: command tree, transport, output rendering, its catalog —
                    # depends on protocol + core
packages/web        # browser client + web map editor — depends on protocol + core
```

The graph is enforced twice: each package's `package.json` declares exactly its `@somnio/*` dependencies (which is what `npm ci --workspace` links in the images), and the root ESLint config forbids any other `@somnio/*` import under `packages/<name>/src/**`. Test files may reach outside it through `devDependencies`.

Module rules for the non-web packages: relative imports carry the `.ts` extension, `import type` for types, no `enum`, no constructor parameter properties (`erasableSyntaxOnly`), `with { type: 'json' }` for JSON imports. The web package keeps its Vite conventions.

**Type stripping and `node_modules`.** Node never strips types under a real `node_modules` directory; it works here only because npm links the workspace packages as symlinks, which resolve back into `packages/*`. Never install them with `--install-links`, and the server image copies the whole install tree for the same reason.

## Build & Test

```
npm ci
npm test                 # every package's unit project; never starts a container
npm run test:integration # data + server integration projects over testcontainers Postgres (Docker or Podman)
npm run typecheck        # tsc --noEmit over both tsconfigs (web, and the rest)
npm run lint             # eslint, including the package-graph rule
npm run format:check     # prettier
npm run knip             # unused files, exports, and dependencies
npm run build            # the browser client's production bundle, then the editor-exclusion assertion
npm run dev              # gameplay server (dev defaults) and the Vite client together; needs the somnio-pg container
```

`npm test` runs every project listed in the root `vitest.config.ts`; the integration projects join only under `SOMNIO_INTEGRATION=1`, which `test:integration` sets. Under rootless Podman set `TESTCONTAINERS_RYUK_DISABLED=true`.

`npm test` starts no container but does bind loopback ports, so a sandbox that denies `listen` fails these files with `EPERM`: the server's live-socket suites (`packages/server/test/live/`, `admin-auth-gate`, `socket-close`) and the CLI's `transport.test.ts` start the gameplay server or a bare `ws` server, and `packages/web/test/editor-fs.test.ts` runs the editor's file middleware behind an HTTP server.

The server: `SOMNIO_DEV_DEFAULTS=1 node packages/server/src/main.ts` (env in the Deployment section; the `/somnio-server` skill has the dev-container recipe). The CLI: `node packages/cli/src/main.ts <verb>`. Both run the sources directly, so a change takes effect on the next start.

## Instructions by package

This file holds what every package shares. The rest lives beside the code it describes, and Claude Code loads each file when it first reads a file under that directory. **Read the file for a subject before working on it from anywhere else**: a change under `packages/server` to a gameplay rule needs `packages/core/AGENTS.md`, and one to login or joining needs `packages/protocol/AGENTS.md`.

- `packages/protocol/AGENTS.md`: the wire protocol. Framing and frame sizes, the pre-login limit, characters, joining, interest, and what breaks the wire (`helloVersion`).
- `packages/core/AGENTS.md`: the gameplay rules and their frames (movement, doors, acting, abilities and effects, threat, elites, bosses, gear, trading, drops, speech, pools and condition, falling and raising, fixtures and services, lucidity, quests, the bounty board), the sector format, and the model registry.
- `packages/web/AGENTS.md`: the browser client (golden frames and wire conformance, the HUD, input, the scene, the splash reel, `window.somnio`), the web map editor, the web asset pack, and hosting.

## Logging

pino, three logger roots chosen at the call site the way a subsystem chooses its label (`packages/server/src/logging.ts`): server records go to stdout only; gameplay records (`de.tobiha.somnio.server.gameplay.<category>`) additionally to `logs/gameplay-log.log`; admin records (`de.tobiha.somnio.server.admin.<category>`) additionally to `logs/admin-log.log`. Stdout is JSON, one record per line. The `logs/` directory is fixed relative to the working directory (the image's `WORKDIR` owns it), the files rotate by size, and the admin `logRemove`/`weblogRemove` verbs close and unlink the current file plus its archives — the next write reopens.

## Deployment

The gameplay server speaks **plain HTTP/WebSocket** — TLS is terminated by a reverse proxy at the deployment boundary. It listens on `SOMNIO_HTTP_HOST:SOMNIO_HTTP_PORT` (default `0.0.0.0:17662`) without certificates. Do not push TLS into the app process; the docker-compose example pins the proxy contract.

Server runtime configuration is resolved from environment variables (`packages/server/src/config.ts`, `packages/data/src/postgresConfig.ts`):

| Variable | Default | Required |
|----------|---------|----------|
| `SOMNIO_HTTP_HOST` | `0.0.0.0` | no |
| `SOMNIO_HTTP_PORT` | `17662` | no |
| `SOMNIO_ADMIN_TOKEN` | `dev-admin` with `SOMNIO_DEV_DEFAULTS=1` | otherwise yes |
| `SOMNIO_SECTORS_DIR` | `packages/core/fixtures/sectors` with `SOMNIO_DEV_DEFAULTS=1` | otherwise yes |
| `SOMNIO_DATABASE_URL` | the `somnio-pg` dev container (`postgres://postgres:postgres@localhost:17663/somnio`, TLS off) with `SOMNIO_DEV_DEFAULTS=1` | otherwise yes |
| `SOMNIO_DATABASE_TLS` | `require` | no (`disable` for a local Postgres) |
| `SOMNIO_TRUST_PROXY` | unset: the per-address pre-login limits are off | no (`1` behind a reverse proxy, `0` when clients connect directly) |

`SOMNIO_DEV_DEFAULTS=1` is the explicit opt-in for every development fallback. The image sets none of it, so a deployment that loses its environment refuses to boot rather than serving `/admin` on a well-known token; an empty `SOMNIO_ADMIN_TOKEN` counts as missing.

`SOMNIO_TRUST_PROXY` says where a client's address comes from, which is what the per-address limits count logins, registrations, `/admin` bearers, and sockets against (see "Wire protocol"). `1` reads the last `X-Forwarded-For` entry, the one the proxy appended itself, and falls back to the socket address when the header is missing or that entry is not an IP address. It is right only when exactly one trusted proxy fronts the server. Behind two, the last entry is the outer proxy's address, which every client shares, and anything that can dial the server directly can forge the header. `0` reads the socket address and ignores the header. Any other value refuses to boot.

Unset or empty, the server limits no address rather than guessing. Counted against the socket address behind a proxy, every client would share the proxy's address, and one person's failures would refuse everyone. The account budget, the login deadline, the character-card deadline, and the total caps on sockets awaiting login and on sockets on the card count no address, so they stay on. Outside `SOMNIO_DEV_DEFAULTS=1` the server logs one error record at startup through the gameplay logger. The `SomnioServer ready` record names the mode in `prelogin_limit`: `proxy`, `direct`, or `off`.

The server exposes `GET /health` (unauthenticated, returns 200 / 503 based on a `SELECT 1`), `WS /ws` (gameplay), and `WS /admin` (operator CLI; pre-upgrade `Authorization: Bearer $SOMNIO_ADMIN_TOKEN` gate — a missing or wrong bearer answers **401**). While the per-address limits are on (`SOMNIO_TRUST_PROXY` is `1` or `0`), an address has ten failed bearers, then one more per minute, so nothing guesses the token at speed. Past that its upgrade answers **429** before the bearer is compared. A correct bearer gets its attempt back. The WebSocket routes are dispatched on the HTTP server's `upgrade` event; the Hono app carries only `/health` and the 401 for a plain request to `/admin`.

The schema is `packages/data/src/migrations/0001_dreamers.ts` plus any migration registered after it, applied on boot. A later migration applies in place, so existing accounts and characters survive it. `0002_items` replaces the inventory rows with the `items` table and `characters.coins`: each character keeps their purse's coins and is given a plain cudgel at the bag's first place in place of their rows, and every Healer the Moonstone and every Mystic a plain wand, in the off hand. `0003_quests` adds the quest log, `character_quests`, a row for each quest a character holds or turned in, and drops the `characters.task_*` columns without converting a task held, which the dreamer takes on again from their master. Roles and ranks are untouched. Migrations are **registered, not discovered**: `migrate.ts` lists them in its `MIGRATIONS` record, so a file added under `migrations/` without an entry there never runs. It refuses a database that still carries an earlier schema (`LegacyDatabaseError`): the Swift-era one, recognized by its `schema_migrations` table, or an earlier TypeScript one, recognized by a `0001_initial` or `0001_metric_world` row in `kysely_migration`. The first migration cannot be applied over any of them; such a database has to be dropped and recreated, the production one and the local `somnio-pg` dev container's alike. The deployment repo records the production procedure, and the `/somnio-server` skill the local one.

`docker-compose.example.yml` runs the full topology — `db`, `server`, `web`, and a `proxy` that is the public surface. The proxy serves the client at `/` and routes `/ws`, `/admin`, and `/health` to the gameplay server; production replaces it with Traefik doing the same split by router priority. The client's endpoint is origin-relative, so `/` and `/ws` **must** share an origin. `web` is `expose`-only, but `server` also publishes `127.0.0.1:17662` alongside the proxy, loopback-bound. That mapping is load-bearing for the `wire-conformance` CI job, which dials the server directly rather than through the proxy. Production publishes only the proxy. The server, `web`, and `proxy` all listen on `8080` inside the network, so the server's published mapping is `127.0.0.1:17662:8080`. That inner `8080` comes from the image's own `ENV SOMNIO_HTTP_PORT`, which the compose file deliberately leaves unset so a dropped `ENV` fails the health check instead of being masked.

The root `Dockerfile` is a `node:24-alpine` multi-stage build: a `deps` stage runs `npm ci --omit=dev --workspace packages/server` over the workspace manifests, and the runtime stage copies that install tree whole (so the `node_modules/@somnio/*` symlinks keep resolving into `packages/*`) plus the four server-side packages' sources and the committed sector fixtures at `/opt/somnio/sectors` (the `SOMNIO_SECTORS_SOURCE` build-arg, default `packages/core/fixtures/sectors`, guarded so an empty or sector-less source fails the build rather than the first boot), so the image carries the world it serves. It takes a **required** `BUILD_VERSION` build-arg (no default; the build fails without it), exposed as `ENV SOMNIO_SERVER_VERSION`, which the admin `version` verb reports.

The server image upgrades the system CA bundle at build time, in a step that never comes from the build cache, so a rebuild picks up a distrusted CA's removal without waiting for a new base image. Its `ENV NODE_OPTIONS=--use-openssl-ca` makes Node verify TLS, which for the server is the Postgres connection, against that system store. Without it Node uses its own bundled CA list, which only a Node release updates. `--use-system-ca` would not do, because it adds the system store to the bundled list rather than replacing it. The `docker-smoke` job asserts that the running server carries the setting. The web image's nginx makes no outbound TLS connection, so it trusts no CA store.

## Lint & Format

```
npm run format           # prettier --write
npm run lint:fix         # eslint --fix
npm run knip             # unused files, exports, and dependencies (config in knip.jsonc)
```

The root `package.json` scripts are the single definition of every check. The pre-commit hook (husky, installed by `npm ci` through the `prepare` script; `.husky/install.mjs` skips CI and the image builds) runs lint-staged, which applies `eslint --fix` and `prettier --write` to the staged files only, so a commit takes seconds. The full gate is CI's `checks` job, which runs `format:check`, `lint`, `typecheck`, `knip`, `test`, and `build` as those same scripts; nothing in it starts a container, since the integration projects are the `integration-tests` job.

`Scripts/bundle-web-assets.sh` runs inside the web image build on Linux and must not assume macOS: GitHub's Ubuntu runners leave `TMPDIR` unset, so a bare `$TMPDIR` under `set -u` aborts the script. Use `${TMPDIR:-/tmp}`.

CI on GitHub Actions (`.github/workflows/ci.yml`): `checks`, `integration-tests`, `wire-conformance` (compose-built server image), `docker-smoke` (the full topology through the proxy, including the 401 on `/admin`), and `publish`, which runs only on `main` after the other four pass.

## Code Conventions

- **Exhaustive switches**: `@typescript-eslint/switch-exhaustiveness-check` is on, and the message and state switches list every case so a new tag is a type error, never a silent fallthrough.
- **Literal sets**: a vocabulary (`GAITS`, `ENTITY_KINDS`, `SECTOR_KINDS`, `ROLES`, `CONDITIONS`, `ABILITY_PHASES`, `EQUIP_SLOTS`, `HANDS`, `RARITIES`, `LOOT_KINDS`, `NIGHTMARE_RANKS`, `TELEGRAPH_KINDS`, `SERVICES`, `BOUNTY_OBJECTIVES`, `PEOPLES`) is an `as const` array with its union derived from it, pinned to its literals by a test. A wire vocabulary is validated on decode with `requireStringEnum`. `PEOPLES` is the exception: it lives in core, which protocol cannot import, so `createCharacter.people` decodes as a string and the character handler checks it. The `people` the server sends, on a `characters` entry and on `enterSpace`, decodes as an id, and the client draws only a people it knows. Teaching ids are the same kind of exception: `TEACHINGS` lives in core, so a `teachingId` decodes as an id (lowercase letters, digits, and hyphens) and the space checks it. Ability and effect ids, from `ABILITIES` and `EFFECTS`, are exceptions of the same kind. The `abilityId` of `useAbility`, `ability`, and `cooldowns` decodes as an id that `isAbilityId` checks: the server checks it on `useAbility`, and the client on the other two. The client draws only the `effects` entries `isEffectId` knows. Elite trait ids, from `ELITE_TRAITS`, decode as ids too, and the client keeps an elite's trait only when `isEliteTraitId` knows it. Items split: `EQUIP_SLOTS` and `RARITIES` are wire vocabularies in protocol, which core takes from there, while base and affix ids belong to `BASE_ITEMS` and `AFFIXES` in core, so a `baseId` and an `affixId` decode as ids, as does an item's own id (a UUIDv7), and a tier as a whole number of at least 1. The server finds an item by its id in what the player carries and checks a base id against `SHOP`, and the client keeps only the items `inventoryOf` knows. Nightmare kinds belong to `MONSTER_KINDS` in core, so a trophy's and a bounty's `monsterKind` decode as ids, and the client draws only a trophy `trophyLabelKey` knows and keeps only a bounty `bountyOf` knows. Quest ids belong to `QUESTS` in core, so a `questId` decodes as either an id or a bounty's id, `bounty:<day>:<land>:<kind>:<objective>`, within `maxQuestIdUTF8Bytes`. The land is a sector's name, which may hold a colon, so `bountyIdParts` reads the kind and the objective from the end. The server takes only a quest `isQuestId` knows or a bounty it offers or holds, and the client keeps only what `questsOf` knows. A `carrierId` decodes as an entity id.
- **Identifiers in English**: types, properties, message names, Postgres column names, file names; only user-facing strings stay localizable.
- **Testing**: Vitest, one project per package; integration suites under `test/integration/` start their own Postgres. A live-server suite polls the router down to zero players in `afterEach`: a closed socket's server-side unregister and `leave` broadcast outlive the client's close event, so without it the next test's joiner can receive the previous test's stale `leave`.
- **No `.turbo/` references** in code or comments.

### Localization

Every user-facing string is looked up through a bilingual `{key: {en, de}}` JSON catalog whose keys **are** the English source strings, so an unresolved key falls back to readable English rather than a developer identifier. Three catalogs ship: `packages/core/data/catalog.json` (the names of the peoples, roles, items, teachings, nightmares, and trophies, and the quests' titles and objective lines, a bounty's included), `packages/cli/src/catalog.json` (the twelve admin lines), and `packages/web/src/i18n/catalog.json` (everything the browser renders that the core catalog does not define). `packages/core/src/i18n/catalog.ts` holds the shared reader, merger, formatter, and `catalogViolations`, which checks an allowlist of rendered keys for en/de presence, placeholder parity (`%@` / `%1$@`), and the no-Unicode-ellipsis rule — ASCII `...` throughout.

Each consumer pins its allowlist: `RENDERED_KEYS` in `packages/web/src/i18n/index.ts` and in `packages/cli/src/catalog.ts`. `packages/web/test/i18n.test.ts` additionally scans every `.ts` file under `src` for `t(...)` / `lookup(...)` literals and fails on any that is absent from `RENDERED_KEYS`, and on any allowlisted key nothing renders. The web merge reports collisions between the core and web catalogs and a test pins that set to empty, so a duplicated key fails rather than letting import order pick the winner.

World words are English, and cosmology and the peoples' names are Latin. German translates the English and leaves the Latin as it is. NPC dialog is the one server-rendered text that is translated. A sector file holds each `dialogScript` in English, and `packages/core/data/dialog.json` maps each English step to `{en, de}`. `localizedDialogLine` looks a step up, says a step the catalog lacks as written, and substitutes `$name`. It is a catalog of the same shape, held to `catalogViolations`. A core test requires an entry for every step a committed NPC says. Each entry's German names the player as often as its English and stays within the say cap once every `$name` becomes the longest character name.

## Agentic Setup

Skill kit at `Skills/`, symlinked from `.claude/skills/` (Claude Code) and `.agents/skills/` (Codex CLI). Both tools share the same set:

- `writing-for-interfaces` — upstream-derived UI-copy guidance (provenance and copyright notice in `Skills/ATTRIBUTION.md`)
- `somnio-server`, `somnio-cli`, `somnio-web` — run each component locally against the dev server
- `somnio-editor` — serve the localhost web map editor and drive it with `agent-browser`

`AGENTS.md` is the shared instructions file; `.claude/CLAUDE.md` is symlinked to it so Claude Code picks up the same content. Each package's `AGENTS.md` (see "Instructions by package") has a `CLAUDE.md` symlink beside it for the same reason.
