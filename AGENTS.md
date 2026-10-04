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
                    # spaces and doors, geometry, collision and ground height, the
                    # .somnio-sector codec, the model registry, the core catalog — depends
                    # on protocol
packages/data       # Postgres schema + the one migration, repositories, Argon2id hashing,
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

## Browser client (`packages/web/`)

A Three.js client that speaks the wire protocol through the shared `@somnio/protocol` package.

```
npm run dev --workspace packages/web      # Vite on :17669, proxying /ws to the local server on :17662
npm run editor --workspace packages/web   # Vite with the editor entry + sector file API (see "Web map editor")
npm run conformance                       # wire conformance against a LIVE server (SOMNIO_CONFORMANCE_URL)
```

### What holds the client and server together

The protocol and core packages are shared code, so the two sides cannot disagree about a message shape. They also run the same movement rule (`packages/core/src/collision.ts`) over the same sectors and the same registry geometry. Two suites guard the parts that are not shared:

- **Golden frames** (`packages/protocol/fixtures/golden-frames.json`) are compared as canonicalized JSON (object keys sorted) by `golden-frames.test.ts`. This is the check that catches a payload **property rename** — the round-trip suites encode and decode with the same renamed property and stay green. Re-record deliberately with `SOMNIO_RECORD_GOLDEN_FRAMES=1 npx vitest run --project protocol`.
- **Wire conformance** (`packages/web/test/conformance/`) drives the real TypeScript encoder and transport into a real server. Its outbound case is what proves application frames ship as **text**; everything else in that file passes while the transport sends binary. The over-cap frame case accepts either close code in `[1009, 1006]`: the client is still writing a ~1 MiB payload when the server refuses it, so whether the close frame arrives before the reset is transport timing.

### Browser-only decisions

- **Session tokens.** A browser page needs a refresh to survive, so the server issues a resumable token on `Login.requestSessionToken` and accepts `redeemSession`/`revokeSession`. Issuance is **request-gated** on that optional field: a client that never asks receives no `sessionToken` frame.
- **DOM UI over WebGL.** Panels and overlays are real elements, so password managers work and `agent-browser snapshot` sees them. `packages/web/src/ui/chrome.css` draws the Kenney 9-slice chrome with `border-image-slice: 36` against an 18px border — the slice is unitless *image pixels*.
- **The orthographic camera's `scale` is a vertical HALF-height**, so the Three.js mapping is `top/bottom = ±scale`, `left/right = ±scale × aspect`. The usual `frustumSize / 2` idiom halves it again and renders the whole world at 2x.
- **Resize holds the vertical world extent constant.** A gameplay contract, not a rendering detail: a bigger window magnifies rather than reveals.
- **`window.somnio`** is a read-only debug surface (dev always, production via `?debug=1`). It reports positions in metres in the space's coordinates. The `/somnio-web` skill covers driving the client with `agent-browser`.

### Web map editor

The map editor is a second Vite entry point (`packages/web/editor.html` + `packages/web/src/editor/**`) that authors `.somnio-sector` files — a development tool, not a shipped surface:

- **Dev-only by construction.** `editor.html` is deliberately never added to `build.rollupOptions.input`, so `vite build`'s default single input (`index.html`) keeps it out of `dist/` and therefore out of the image. `npm run build` machine-enforces this: `packages/web/scripts/assertEditorExcluded.mjs` runs after `vite build`, inside the image build too, and asserts `dist/editor.html` is absent and no editor marker (`__editor/sectors`, `somnioEditor`, `somnio-editor-root`) reaches `dist/bundle` or `dist/index.html`.
- **File I/O is a dev-server middleware** (`packages/web/vite.editorFs.ts`): a `configureServer`-only plugin serving `/__editor/sectors` (GET list, GET/PUT per percent-encoded stem, no DELETE), inert unless `SOMNIO_EDITOR_SECTORS_DIR` is set (the `editor` npm script sets it, defaulting to the repo-root `sectors/` staging directory; a dev server with `SOMNIO_SECTORS_DIR` pointed there plays what is being authored, and finished sectors are copied into `packages/core/fixtures/sectors`, the world the image ships), loopback-only and same-origin-gated regardless of `--host`, path-contained against the realpath'd root, and atomic on write.
- **The sector codec** (`packages/core/src/sectorFile.ts`) is pinned byte-for-byte by the committed fixtures, each of which reads and writes back identical, so an authored save never rewrites unrelated bytes of a sector the server loads. The writer runs its output through the reader before returning it, so the editor cannot save a file the server would refuse.
- **The overlay shows what blocks.** The authoring overlay draws each placement's registry colliders along with walk surfaces, ledges, door triggers, and arrival points. A door is the one record kind without a tool: it is added from its placement's inspector at one of the model's anchors.
- **The document is judged as the server would judge it.** Every other sector in the directory is loaded on open, and `documentIssues` (`packages/web/src/editor/surroundings.ts`) runs `buildWorld` over all of them. The overlay marks each reported record in red, and `window.somnioEditor.issues()` lists them.
- **Neighbours are drawn read-only.** For an outdoor document the outdoor sectors touching it are drawn at their origins, so roads, walls, and tree lines can meet across a border.
- **Record labels are DOM elements** over the canvas, so `agent-browser snapshot` sees them.
- **English-only.** The editor renders literal English and never imports `@/i18n`, keeping `RENDERED_KEYS` and the catalog tests untouched.
- The `/somnio-editor` skill covers serving and driving the editor with `agent-browser` (`window.somnioEditor` is its debug surface).

### Web asset pack

The browser reads glTF. `somnio-assets` carries `Web/Models/*.glb`, published by its `Pipeline/build-web-models.sh`; textures live in that repo's root `FloorMaterials/` and `UI/`. `Scripts/bundle-web-assets.sh` composes the served root from the three:

```
SOMNIO_ASSET_SOURCE=/path/to/somnio-assets \
SOMNIO_WEB_ASSET_DEST=packages/web/dist/assets \
  Scripts/bundle-web-assets.sh
```

The destination differs by consumer, and getting it wrong fails silently. `packages/web/dist/assets` is for the image build, where nginx serves `dist/`; the **dev server needs `packages/web/public/assets`**. Vite serves `packages/web/public` and `packages/web/`, never `dist/`, so a pack written to `dist` leaves every model and texture 404ing with a placeholder world and no error. `packages/web/public/assets` is gitignored and excluded from the Docker context, so a populated dev pack never leaks into an image.

`UI/` is required (the chrome has no fallback), models and floors warn. The script additionally verifies **external resource sidecars**, both `buffers[]` and `images[]`, which is the whole surface glTF 2.0 declares external files on. Today's pack is entirely self-contained binary GLB, so the check finds nothing. It exists because a JSON glTF can point at a sibling `.bin` or `.png`, which three.js resolves relative to the model URL, so a pipeline change that started emitting one would serve a 404 for the model's geometry or its texture.

The served layout is `/assets/...` for the pack and `/bundle/...` for hashed build output (`build.assetsDir: 'bundle'`). They must not share a directory — the client references the pack by absolute URL.

Prop models (the registry's `objectModels` stems, empty `expectedClips`) are **placement-normalized before export**: local origin at the ground-footprint center, long horizontal axis along X. The runtime adds no per-object scale and puts each clone's origin at its placement's `x`/`z`, turned by `yaw`. Collision never measures a loaded model: it comes from the registry's `footprint` and `colliders`, so an un-normalized prop draws shifted or mis-sized against what it blocks. The pipeline's footprint gate holds each written model's ground bounds to its registry `footprint`. The pipeline's sizing modes and authoring conventions live in that repo's `CLAUDE.md`.

### Hosting

`packages/web/Dockerfile` builds `ghcr.io/tobihagemann/somnio-web` from a **repository-root** context (the workspace symlinks resolve through the root `node_modules`, and the asset pack is at `assets/`). It requires `--build-arg BUILD_VERSION` like the server image, and greps the bundle for the marked stamp `somnio-web <version>` to prove the version was injected — see `packages/web/src/buildInfo.ts` for why the stamp interpolates the define directly rather than reusing the exported constant.

There are no releases, version numbers, tags, or changelog. The `publish` job in `ci.yml` builds both images from every commit on `main` that passes the other four jobs and pushes them as `ghcr.io/tobihagemann/somnio-server` and `somnio-web`, each tagged `sha-<short>` and `latest`. `BUILD_VERSION` is that short sha, so the admin `version` verb and the `somnio-web <version>` stamp name the exact commit a container runs. The deployment runs `latest` for both images and redeploys whenever any service in its stack changes, so any green commit on `main` can go live at any moment: a change that breaks the wire must bump `helloVersion` in the same commit (registry geometry counts, see "Wire protocol"), and the committed sector fixtures are the live world.

The static image does **not** proxy `/ws`; whatever fronts it performs the split (the `proxy` service in `docker-compose.example.yml` locally, Traefik in production), which is what lets the client's origin-relative `wss://<host>/ws` resolve with no dev-only branch.

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
| `SOMNIO_TRUST_PROXY` | unset: the pre-login limit is off | no (`1` behind a reverse proxy, `0` when clients connect directly) |

`SOMNIO_DEV_DEFAULTS=1` is the explicit opt-in for every development fallback. The image sets none of it, so a deployment that loses its environment refuses to boot rather than serving `/admin` on a well-known token; an empty `SOMNIO_ADMIN_TOKEN` counts as missing.

`SOMNIO_TRUST_PROXY` says where a client's address comes from, which is what the pre-login limit counts attempts against (see "Wire protocol"). `1` reads the last `X-Forwarded-For` entry, the one the proxy appended itself, and falls back to the socket address when the header is missing or that entry is not an IP address. It is right only when exactly one trusted proxy fronts the server. Behind two, the last entry is the outer proxy's address, which every client shares, and anything that can dial the server directly can forge the header. `0` reads the socket address and ignores the header. Unset or empty, the server limits nothing rather than guessing: counted against the socket address behind a proxy, every client would share the proxy's address, and one person's failures would refuse everyone. In that case it logs one error record at startup through the gameplay logger, except under `SOMNIO_DEV_DEFAULTS=1`. Any other value refuses to boot. The `SomnioServer ready` record names the mode in `prelogin_limit`: `proxy`, `direct`, or `off`.

The server exposes `GET /health` (unauthenticated, returns 200 / 503 based on a `SELECT 1`), `WS /ws` (gameplay), and `WS /admin` (operator CLI; pre-upgrade `Authorization: Bearer $SOMNIO_ADMIN_TOKEN` gate — a missing or wrong bearer answers **401**). The WebSocket routes are dispatched on the HTTP server's `upgrade` event; the Hono app carries only `/health` and the 401 for a plain request to `/admin`.

The migration is a single fresh schema (`packages/data/src/migrations/0001_metric_world.ts`), applied on boot. Migrations are **registered, not discovered**: `migrate.ts` lists them in its `MIGRATIONS` record, so a file added under `migrations/` without an entry there never runs. It refuses a database that still carries an earlier schema (`LegacyDatabaseError`): the Swift-era one, recognized by its `schema_migrations` table, or the previous TypeScript one, recognized by a `0001_initial` row in `kysely_migration`. The migration cannot be applied over either; such a database has to be dropped and recreated. The deployment repo records that procedure.

`docker-compose.example.yml` runs the full topology — `db`, `server`, `web`, and a `proxy` that is the public surface. The proxy serves the client at `/` and routes `/ws`, `/admin`, and `/health` to the gameplay server; production replaces it with Traefik doing the same split by router priority. The client's endpoint is origin-relative, so `/` and `/ws` **must** share an origin. `web` is `expose`-only, but `server` also publishes `127.0.0.1:17662` alongside the proxy, loopback-bound. That mapping is load-bearing for the `wire-conformance` CI job, which dials the server directly rather than through the proxy. Production publishes only the proxy. The server, `web`, and `proxy` all listen on `8080` inside the network, so the server's published mapping is `127.0.0.1:17662:8080`. That inner `8080` comes from the image's own `ENV SOMNIO_HTTP_PORT`, which the compose file deliberately leaves unset so a dropped `ENV` fails the health check instead of being masked.

The root `Dockerfile` is a `node:24-alpine` multi-stage build: a `deps` stage runs `npm ci --omit=dev --workspace packages/server` over the workspace manifests, and the runtime stage copies that install tree whole (so the `node_modules/@somnio/*` symlinks keep resolving into `packages/*`) plus the four server-side packages' sources and the committed sector fixtures at `/opt/somnio/sectors` (the `SOMNIO_SECTORS_SOURCE` build-arg, default `packages/core/fixtures/sectors`, guarded so an empty or sector-less source fails the build rather than the first boot), so the image carries the world it serves. It takes a **required** `BUILD_VERSION` build-arg (no default; the build fails without it), exposed as `ENV SOMNIO_SERVER_VERSION`, which the admin `version` verb reports.

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
- **Literal sets**: a vocabulary (`GAITS`, `ENTITY_KINDS`, `SECTOR_KINDS`, `PEOPLES`) is an `as const` array with its union derived from it, pinned to its literals by a test. A wire vocabulary is validated on decode with `requireStringEnum`. `PEOPLES` is the exception: it lives in core, which protocol cannot import, so `register.people` decodes as a string and the register handler checks it.
- **Identifiers in English**: types, properties, message names, Postgres column names, file names; only user-facing strings stay localizable.
- **Testing**: Vitest, one project per package; integration suites under `test/integration/` start their own Postgres. A live-server suite polls the router down to zero players in `afterEach`: a closed socket's server-side unregister and `leave` broadcast outlive the client's close event, so without it the next test's joiner can receive the previous test's stale `leave`.
- **No `.turbo/` references** in code or comments.

### Localization

Every user-facing string is looked up through a bilingual `{key: {en, de}}` JSON catalog whose keys **are** the English source strings, so an unresolved key falls back to readable English rather than a developer identifier. Three catalogs ship: `packages/core/data/catalog.json` (people names, item labels), `packages/cli/src/catalog.json` (the twelve admin lines), and `packages/web/src/i18n/catalog.json` (everything the browser renders that the core catalog does not define). `packages/core/src/i18n/catalog.ts` holds the shared reader, merger, formatter, and `catalogViolations`, which checks an allowlist of rendered keys for en/de presence, placeholder parity (`%@` / `%1$@`), and the no-Unicode-ellipsis rule — ASCII `...` throughout.

Each consumer pins its allowlist: `RENDERED_KEYS` in `packages/web/src/i18n/index.ts` and in `packages/cli/src/catalog.ts`. `packages/web/test/i18n.test.ts` additionally scans every `.ts` file under `src` for `t(...)` / `lookup(...)` literals and fails on any that is absent from `RENDERED_KEYS`, and on any allowlisted key nothing renders. The web merge reports collisions between the core and web catalogs and a test pins that set to empty, so a duplicated key fails rather than letting import order pick the winner.

### Wire protocol

Messages are a discriminated union in `packages/protocol`, serialized as JSON over WebSocket **text** frames in the shape `{"tag":"<verb>","payload":{...}}`. `encodeSomnioMessage` / `decodeSomnioMessage` are the framing entrypoints; every payload field is validated on decode (typed ranges, byte caps where the protocol declares them), and an unknown tag throws `UnrecognizedTagError`, distinct from `WireDecodingError`, which is what lets the admin route answer `unknownCommand` instead of closing. `AdminRequest`/`AdminResponse` follow the same `{tag, payload}` shape with a string payload.

`encodeSomnioMessage` throws `OversizedFrameError` if the JSON exceeds `maxFrameLength`; `MAX_WIRE_FRAME_SIZE` (the `ws` `maxPayload`) sits a small `frameSizeSlack` above it. A frame past the wire size closes 1009 before the decoder runs; a frame inside the slack window reaches the decoder, whose own cap closes 1002 with the reason `frame validation failed`. That is the reason every malformed, unrecognized, or state-illegal frame closes with. Over-cap *values* inside a valid frame (a `clientSay` over 256 bytes, a session token over 256 bytes) are handled, not closed on: the say is dropped and the session verbs answer their failure result, so the socket stays open and the next frame is still processed.

JSON keys are the property names — renaming a property changes the wire key, which only the golden-frame suite catches. Avoid raw dictionaries on payloads; prefer ordered arrays (e.g. the `EntityMove[]` of a `moves` frame) for stable, self-documenting output.

Lengths are metres, with `x` running east and `z` south. Positions are in the coordinates of the player's space, headings are degrees (0 = south, 90 = east), and numbers are plain JSON doubles. Entities carry string ids: a player its character id, an NPC `npc:<sector>/<npcId>`, a monster `monster:<n>`.

The server handles inbound frames strictly one at a time: the socket is paused while a handler runs and resumed after, so a handler that awaits Postgres never interleaves with the next frame. Broadcasts go through per-connection outboxes with a high watermark; a client that cannot keep up is closed with `outbox overflow` (1008) rather than back-pressuring the space.

**Pre-login limit.** Logins and registrations are budgeted per client address, in memory (`packages/server/src/connection/attemptLimiter.ts`). An address has ten failed logins, then one more per minute. It has ten registrations that passed validation, then one more per five minutes. A login whose password verifies gets its attempt back, whatever the join then answers. A failed login keeps it spent, including one whose account lookup throws, and so does every registration. Past the budget the server answers `loginResult` or `registerResult` with the result `throttled`, before the account lookup or the password hash. The socket stays open. A `redeemSession` is never limited, so a remembered session resumes while its address is throttled. IPv6 clients share a budget per /64. The limit is off unless `SOMNIO_TRUST_PROXY` is `1` or `0` (see "Deployment").

**Joining.** `enterSpace {spaceId, selfId, worldSeconds}` is the first frame of every join (a login, a session redeem, a door transfer, and the restore after a failed transfer), and the client resets its world on it. A `sector` frame for the player's sector and each sector touching it follows, then the player's own `entity`, `inventory`, `energy`, and an `entity` per visible entity. `worldSeconds` is the only time the wire carries: the client runs the clock forward from it at `WORLD_TIME_RATE`.

**Interest.** A player is sent their own sector and the sectors touching it, and sees the entities standing in them. When an entity's sector changes, every player whose view of it changed gets `entity` or `leave` with `leftGame: false`, whether or not they moved. When a player's own sector changes, they are sent each sector that entered their view, including one they held before, because the server keeps no record of what a client holds. The client never drops a sector it was sent: it only stops drawing the ones outside its predicted sector's neighbourhood.

**Movement.** The client predicts and reports: `move {x, z, facing, gait}` about ten times a second, plus a waypoint whenever the straight line from its last report to its next step would be illegal.

The server accepts a move when its length fits the player's allowance and `isLegalMove` passes (colliders, blockers, ledges, the step-height limit, NPCs); otherwise it answers `correction {x, z}` with the last accepted position. The allowance accrues on the server's clock at a little over running speed and holds two seconds' worth. Length is checked first: a move longer than the allowance is refused and spends nothing, and a move the allowance covers spends its length whether or not its path is legal. The predictor never reports a position its own `isLegalMove` refuses, so an honest client is corrected only when its reports were held back for longer than the allowance holds and then arrive together. Players are not checked against each other or against monsters on the server: each client stops its own player at the others where it draws them.

Accepted moves and monster steps go out as one batched `moves` frame per connection every 100 ms, which the client interpolates.

**Doors and bumps.** `useDoor {sector, doorId}` moves the player to the counterpart door's space, and is answered with `doorRefused` when the player's space has no such live door or the player stands outside its trigger (widened by `doorUseSlack`). The client sends it on entering the trigger and then reports nothing until `enterSpace` or `doorRefused` arrives. `bump {targetId}` starts an NPC's dialog and is dropped from outside `npcInteractionRadius`.

**What breaks the wire.** `helloVersion` (`packages/protocol/src/constants.ts`) is compared with strict equality by the client; bump it when the wire breaks. Registry geometry is part of the movement contract: the client collides against the registry it was bundled with, so a page loaded before a deploy would predict against the old shapes and be corrected by the new server. Changing a model's `colliders`, `walkSurfaces`, or `doors`, or a `footprint` that stands in as its collider, is a wire break.

### Sector format

Sectors are JSON, stored in `.somnio-sector` files, read and written by `packages/core/src/sectorFile.ts`. The writer produces plain JSON with a 2-space indent, recursively sorted keys, and a trailing newline, and leaves defaults out, so committed fixtures stay human-diffable and byte-stable across an unedited open-and-save. The reader checks the file's byte size before parsing (`maxSectorFileBytes`) and bounds the sector's extent, every coordinate, and every record-array count (`SOMNIO_PROTOCOL_CONSTANTS` for the view, `SOMNIO_CONSTANTS` for NPCs and monster spawns), so a hostile `.somnio-sector` cannot drive an unbounded allocation when loaded from `SOMNIO_SECTORS_DIR`.

A sector file is the **sector view** plus the content only the server acts on. The view (`SectorView` in `packages/protocol/src/sectorView.ts`) is declared once and is exactly what a `sector` frame carries; `decodeSectorView` validates it for both. Property names are the JSON keys, so renaming one changes the file and the wire. The sector's `name` is the filename stem (at most `maxSectorNameUTF8Bytes`, so an NPC's entity id always fits its cap) and never part of the file: the reader injects it and the writer strips it. One record of each kind, in reading order (the file sorts its keys):

```json
{
  "kind": "outdoor",
  "origin": { "x": 0, "z": 0 },
  "size": { "width": 40.96, "depth": 40.96 },
  "floorMaterialId": "grass-meadow",
  "floorPatches": [{ "id": "patch-1", "floorMaterialId": "cobble-town", "x": 16, "z": 0, "width": 8.96, "depth": 40.96 }],
  "placements": [{ "id": "building-townhall-1", "modelId": "building-townhall", "x": 36.8, "z": 4.48, "yaw": 270 }],
  "blockers": [{ "id": "blocker-1", "x": 0, "z": 0, "width": 5.12, "depth": 0.44 }],
  "doors": [{ "id": "to-edariabibliothek", "placement": "building-townhall-1", "anchor": "main", "target": { "sector": "EdariaBibliothek", "door": "exit" } }],
  "spawn": { "x": 2.88, "z": 4.32, "facing": 0 },
  "npcs": [{ "id": "pugnax", "name": "Pugnax", "characterModelId": "kaempfer-meister", "x": 37.32, "z": 33.2, "facing": 0, "dialogScript": "..." }],
  "monsterSpawns": [{ "id": "spawn-1", "kind": "gespenst", "x": 1.6, "z": 2.08, "width": 7.04, "depth": 4.8, "maxAlive": 3 }]
}
```

Lengths are metres, `x` runs east and `z` south, and every record position is relative to the sector's north-west corner. `x`/`z` is the centre of a placement, an NPC, and the spawn, and the north-west corner of a rect (a blocker, a floor patch, a monster spawn's area). Angles are degrees: `yaw` counter-clockwise seen from above, `facing` a heading with 0 = south and 90 = east, normalized on decode.

`kind` is `outdoor` or `interior`. An outdoor sector carries an `origin`, its north-west corner in the one outdoor space, and is lit by the world clock. An interior is a space of its own and carries a `brightness` percentage (0-100) instead. Each of the two keys is rejected on the other kind.

Every record has an `id` unique within its array (lowercase letters, digits, and hyphens, at most 64 bytes), and the decoder rejects a duplicate. Ids are what a door, the editor's selection, and persisted NPC dialog progress refer to, so reordering records changes nothing.

- **Placements** put a registry model (`modelId`) at `x`/`z`, turned by `yaw` (models are normalized with their door or long axis on +X, so 270 faces a door south) and lifted by `elevation` (a candle on a table). A placement blocks through its model's registry colliders. `elevation` is visual only, and is ignored on a model with walk surfaces. An unmapped `modelId` renders a placeholder and contributes no collision rather than rejecting the file, as an unmapped `floorMaterialId` renders an untextured floor.
- **Blockers** are invisible blocking rects for what no model covers (a wall strip, a door jamb).
- **Floor patches** paint rectangular floor-material overlays over the base floor. They are purely visual and must not overlap each other: coplanar overlapping quads z-fight.
- **Doors** are attached to a placement's door anchor (`placement` + `anchor`, the anchor being one of the model's registry `doors`) and name their counterpart (`target.sector` + `target.door`). The decoder rejects a door whose `placement` is not in the sector. The trigger is the anchor's width by `doorTriggerDepth` in front of it, and a player arrives 0.8 m out from the counterpart door, facing away from it.
- **`spawn`** is where a new character enters the world. The starter sector must have one.
- **NPCs** stand at `x`/`z`, drawn with a registry character model (`characterModelId`), and speak the steps of their `dialogScript`. The reader rejects an NPC standing outside its own sector's rect, because players are told about an NPC by the sector that owns it. It also rejects a step that could pass the say cap once each `$name` becomes the longest nickname, because a client closes on an over-cap line.
- **Monster spawns** are areas that keep up to `maxAlive` monsters (at most `maxSpawnAlive`) of one `kind` from `packages/core/src/monsterKinds.ts` alive.

The `spawn`, the NPCs, and the monster spawns never reach a client as records: `sectorView` strips the server-side content, and NPCs and monsters arrive as entities.

Omitted on write and defaulted on read: `yaw` and `elevation` at 0, empty record arrays, and an unset `spawn`.

The server builds the world from the loaded sectors at boot (`buildWorld` in `packages/core/src/world.ts`). Every outdoor sector lies in the one space `outdoors` at its origin, so sectors that touch are walked across with no transition and a sector edge with no neighbour blocks. Each interior is a space named after its sector, reached through a door. Overlapping outdoor sectors, an outdoor sector under `minOutdoorSectorExtent`, a sector named `outdoors`, a spawn a body cannot stand on, and a starter sector without a spawn fail startup.

A door is live only as half of a sound pair: both doors resolve to an anchor, point at each other, and have an arrival point a body can stand on. Any other door is logged and left inert, and the world still loads. Standing means clear of colliders, blockers, ledges, and the space's NPCs, because a body arriving in contact with an NPC could never move again. An unmapped model, an `elevation` on a model with walk surfaces, and walk surfaces of two placements that overlap are logged the same way.

The canonical `.somnio-sector` extension is used everywhere: the committed fixtures (`packages/core/fixtures/sectors`), the server's `SOMNIO_SECTORS_DIR`, and the web editor's file API. The server loads only `.somnio-sector` files and keys each by its extension-stripped filename (the filename-as-sector-id convention door targets rely on); a directory with no `.somnio-sector` files fails startup (`noSectorsLoaded`) rather than booting an empty world.

### Model registry

The 3D pack's layout and its collision geometry are data: the committed `packages/core/data/ModelRegistry.json` (exported as `@somnio/core/data/ModelRegistry.json`) holds `characterModels` (character model ids to model stems, each with its `expectedClips` clip-presence contract), `playerModel` (the one character model every player uses), `objectModels` (semantic object ids to prop stems and their geometry), and `floorMaterials` (semantic floor ids to floor-texture stems). The registry references only filename stems, so it never drifts from the uncommitted, operator-supplied model pack.

An object model's geometry is in model space: metres, the origin at the ground-footprint centre, +X east and +Z south at yaw 0, a rect's `x`/`z` its minimum (north-west) corner. A placement is tested in its model's space, so axis-aligned registry rects work at any yaw.

- `footprint` is the measured ground bounds, centred on the origin.
- `colliders` are the rects that block. Left out, they default to the footprint; `[]` never blocks (`rug`, `candle`, `door`).
- `walkSurfaces` are rects with one `height` each, a stair run being one rect per tread. A body steps between two heights up to `maxStepHeight` apart (the ground is 0), and every stretch of a surface edge with a larger drop is a blocking ledge.
- `doors` are the anchors a sector's door records attach to: `id`, `x`, `z`, a cardinal `facing` out of the door, and the opening's `width`.

`packages/core/src/modelRegistry.ts` validates the structural invariants on read: non-empty stems and ids, no duplicate ids, characters expecting at least one clip, a `playerModel` that is a character model, positive sizes and heights, cardinal door facings, and walk surfaces of one model that do not overlap (steps cut into a plinth would otherwise resolve to the plinth's height). The browser degrades to a placeholder registry with a logged error; the server parses the same file strictly at boot and fails startup on an error, because an empty registry there is a world with no collision and every door inert.

The web editor's model, character, floor, and door-anchor pickers are populated from the same registry, so the authoring surface can only reference what resolves. The asset pipeline's clip-presence and footprint gates read the same file, and its `Pipeline/glb_surface_report.py` is where a model's footprint, colliders, walk surfaces, and door anchors are measured.

## Agentic Setup

Skill kit at `Skills/`, symlinked from `.claude/skills/` (Claude Code) and `.agents/skills/` (Codex CLI). Both tools share the same set:

- `writing-for-interfaces` — upstream-derived UI-copy guidance (provenance and copyright notice in `Skills/ATTRIBUTION.md`)
- `somnio-server`, `somnio-cli`, `somnio-web` — run each component locally against the dev server
- `somnio-editor` — serve the localhost web map editor and drive it with `agent-browser`

`AGENTS.md` is the shared instructions file; `.claude/CLAUDE.md` is symlinked to it so Claude Code picks up the same content.
