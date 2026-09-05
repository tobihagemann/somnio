# Somnio

A 2D tile-based mini-MMORPG. A TypeScript gameplay server, an admin CLI, and a Three.js browser client in one npm workspace, plus a localhost-only web map editor under `packages/web/`.

## Tech Stack

- Node 24 (`.nvmrc`), TypeScript run directly through Node's type stripping — nothing is compiled, so every package's `exports` point at `.ts` sources
- Hono + `@hono/node-server` for HTTP, `ws` for the two WebSocket routes, Kysely over `pg` for Postgres, `argon2` for password hashing, pino for logging, commander for the CLI
- Vitest for every suite; `@testcontainers/postgresql` for the integration projects
- Three.js + Vite for the browser client

## Package graph

```
packages/protocol   # message catalog, wire DTOs, `{tag, payload}` codec — imports nothing
packages/core       # game models (sector, character, inventory, world clock), geometry,
                    # collision, the .somnio-sector codec, the model registry, the core
                    # catalog — depends on protocol
packages/data       # Postgres schema + the one migration, repositories, Argon2id hashing,
                    # SHA-256 session-token digests (unsalted so the digest column is directly
                    # searchable — safe because the token is a 256-bit CSPRNG value), the
                    # name policy — depends on core
packages/server     # gameplay/admin handlers, the per-connection actor, per-sector
                    # simulation, world router, services, the HTTP/WS server, boot —
                    # depends on protocol + core + data
packages/cli        # admin CLI: command tree, transport, output rendering, its catalog —
                    # depends on protocol + core
packages/web        # browser client + web map editor — depends on protocol + core
```

The graph is enforced twice: each package's `package.json` declares exactly its `@somnio/*` dependencies (which is what `npm ci --workspace` links in the images), and the root ESLint config forbids any other `@somnio/*` import under `packages/<name>/src/**`. Test files may reach outside it (the CLI's transport suite drives the server package's live harness).

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
npm run build            # the browser client's production bundle
```

`npm test` runs every project listed in the root `vitest.config.ts`; the integration projects join only under `SOMNIO_INTEGRATION=1`, which `test:integration` sets. Under rootless Podman set `TESTCONTAINERS_RYUK_DISABLED=true`.

The server: `SOMNIO_DEV_DEFAULTS=1 node packages/server/src/main.ts` (env in the Deployment section; the `/somnio-server` skill has the dev-container recipe). The CLI: `node packages/cli/src/main.ts <verb>`. Both run the sources directly, so a change takes effect on the next start.

## Browser client (`packages/web/`)

A Three.js client that speaks the wire protocol through the shared `@somnio/protocol` package.

```
npm run dev --workspace packages/web      # Vite on :17669, proxying /ws to the local server on :17662
npm run editor --workspace packages/web   # Vite with the editor entry + sector file API (see "Web map editor")
npm run conformance                       # wire conformance against a LIVE server (SOMNIO_CONFORMANCE_URL)
```

### What holds the client and server together

The protocol and core packages are shared code, so the two sides cannot disagree about a message shape. Two suites guard the parts that are not shared:

- **Golden frames** (`packages/protocol/fixtures/golden-frames.json`) are compared as canonicalized JSON by `golden-frames.test.ts`, with `Math.fround` applied to every number so a Float32 value written by any producer compares by value. This is the check that catches a payload **property rename** — the round-trip suites encode and decode with the same renamed property and stay green. Re-record deliberately with `SOMNIO_RECORD_GOLDEN_FRAMES=1 npx vitest run --project protocol`.
- **Wire conformance** (`packages/web/test/conformance/`) drives the real TypeScript encoder and transport into a real server. Its outbound case is what proves application frames ship as **text**; everything else in that file passes while the transport sends binary. The over-cap frame case accepts either close code in `[1009, 1006]`: the client is still writing a ~1 MiB payload when the server refuses it, so whether the close frame arrives before the reset is transport timing.

`Math.fround` narrowing lives in `packages/core/src/float.ts`, including `FLOAT_PI` — a 32-bit π rounds toward zero, so it is **not** `Math.fround(Math.PI)`. Headings and other Float32 wire values are compared by value, never by string.

### Browser-only decisions

- **Session tokens.** A browser page needs a refresh to survive, so the server issues a resumable token on `Login.requestSessionToken` and accepts `redeemSession`/`revokeSession`. Issuance is **request-gated** on that optional field, which is what keeps `helloVersion` at 3 rather than forcing a bump.
- **DOM UI over WebGL.** Panels and overlays are real elements, so password managers work and `agent-browser snapshot` sees them. `packages/web/src/ui/chrome.css` draws the Kenney 9-slice chrome with `border-image-slice: 36` against an 18px border — the slice is unitless *image pixels*.
- **The orthographic camera's `scale` is a vertical HALF-height**, so the Three.js mapping is `top/bottom = ±scale`, `left/right = ±scale × aspect`. The usual `frustumSize / 2` idiom halves it again and renders the whole world at 2x.
- **Resize holds the vertical world extent constant.** A gameplay contract, not a rendering detail: a bigger window magnifies rather than reveals.
- **`window.somnio`** is a read-only debug surface (dev always, production via `?debug=1`). The `/somnio-web` skill covers driving the client with `agent-browser`.

### Web map editor

The map editor is a second Vite entry point (`packages/web/editor.html` + `packages/web/src/editor/**`) that authors `.somnio-sector` files — a development tool, not a shipped surface:

- **Dev-only by construction.** `editor.html` is deliberately never added to `build.rollupOptions.input`, so `vite build`'s default single input (`index.html`) keeps it out of `dist/` and therefore out of the image. `lint.sh` machine-enforces this: it runs `npm run build` and asserts `dist/editor.html` is absent and no editor marker (`__editor/sectors`, `somnioEditor`, `somnio-editor-root`) reaches `dist/bundle` or `dist/*.html`.
- **File I/O is a dev-server middleware** (`packages/web/vite.editorFs.ts`): a `configureServer`-only plugin serving `/__editor/sectors` (GET list, GET/PUT per percent-encoded stem, no DELETE), inert unless `SOMNIO_EDITOR_SECTORS_DIR` is set (the `editor` npm script sets it, defaulting to the repo-root `sectors/` staging directory, which the local server serves only under the compose topology), loopback-only and same-origin-gated regardless of `--host`, path-contained against the realpath'd root, and atomic on write.
- **The sector codec** (`packages/core/src/sectorFile.ts`) is pinned byte-for-byte against the committed fixtures and the synthetic encoding golden (`packages/core/fixtures/sector-encoding-golden.somnio-sector`), so an authored save never rewrites unrelated bytes of a sector the server loads.
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

Prop models (the registry's `objectModels` stems, empty `expectedClips`) are **placement-normalized before export**: local origin at the ground-footprint center, long horizontal axis along X. The runtime adds no per-object scale and anchors each clone's footprint to the overlapping collision mask's south edge (falling back to the decal rect's bottom edge), so an un-normalized prop appears shifted or mis-sized. The pipeline's sizing modes and authoring conventions live in that repo's `CLAUDE.md`.

### Hosting

`packages/web/Dockerfile` builds `ghcr.io/tobihagemann/somnio-web` from a **repository-root** context (the workspace symlinks resolve through the root `node_modules`, and the asset pack is at `assets/`). It requires `--build-arg BUILD_VERSION` like the server image, and greps the bundle for the marked stamp `somnio-web <version>` to prove the version was injected — see `packages/web/src/buildInfo.ts` for why the stamp interpolates the define directly rather than reusing the exported constant.

There are no releases, version numbers, tags, or changelog. The `publish` job in `ci.yml` builds both images from every commit on `main` that passes the other four jobs and pushes them as `ghcr.io/tobihagemann/somnio-server` and `somnio-web`, each tagged `sha-<short>` and `latest`. `BUILD_VERSION` is that short sha, so the admin `version` verb and the `somnio-web <version>` stamp name the exact commit a container runs. Deploying means pinning one sha for both images in the deployment repo; the `/deploy` skill owns that procedure and the `helloVersion` check that precedes it.

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
| `SOMNIO_DIALOG_PRUNE_FORCE` | unset | no — one-shot override for the boot orphan-dialog prune's safety guard |

`SOMNIO_DEV_DEFAULTS=1` is the explicit opt-in for every development fallback. The image sets none of it, so a deployment that loses its environment refuses to boot rather than serving `/admin` on a well-known token; an empty `SOMNIO_ADMIN_TOKEN` counts as missing.

The server exposes `GET /health` (unauthenticated, returns 200 / 503 based on a `SELECT 1`), `WS /ws` (gameplay), and `WS /admin` (operator CLI; pre-upgrade `Authorization: Bearer $SOMNIO_ADMIN_TOKEN` gate — a missing or wrong bearer answers **401**). The WebSocket routes are dispatched on the HTTP server's `upgrade` event; the Hono app carries only `/health` and the 401 for a plain request to `/admin`.

The migration is a single fresh schema (`packages/data/src/migrations/0001_initial.ts`), applied on boot. It refuses a database that still carries the Swift-era schema (`LegacyDatabaseError`), which the initial migration cannot be applied over; such a database has to be dropped and recreated. The deployment repo records that procedure.

`docker-compose.example.yml` runs the full topology — `db`, `server`, `web`, and a `proxy` that is the public surface. The proxy serves the client at `/` and routes `/ws`, `/admin`, and `/health` to the gameplay server; production replaces it with Traefik doing the same split by router priority. The client's endpoint is origin-relative, so `/` and `/ws` **must** share an origin. `web` is `expose`-only, but `server` also publishes `127.0.0.1:17662` alongside the proxy, loopback-bound. That mapping is load-bearing for the `wire-conformance` CI job, which dials the server directly rather than through the proxy. Production publishes only the proxy. The server, `web`, and `proxy` all listen on `8080` inside the network, so the server's published mapping is `127.0.0.1:17662:8080`. That inner `8080` comes from the image's own `ENV SOMNIO_HTTP_PORT`, which the compose file deliberately leaves unset so a dropped `ENV` fails the health check instead of being masked.

The root `Dockerfile` is a `node:24-alpine` multi-stage build: a `deps` stage runs `npm ci --omit=dev --workspace packages/server` over the workspace manifests, and the runtime stage copies that install tree whole (so the `node_modules/@somnio/*` symlinks keep resolving into `packages/*`) plus the four server-side packages' sources. It takes a **required** `BUILD_VERSION` build-arg (no default; the build fails without it), exposed as `ENV SOMNIO_SERVER_VERSION`, which the admin `version` verb reports.

## Lint & Format

```
./Scripts/format.sh            # prettier --write, eslint --fix
./Scripts/lint.sh              # prettier --check, eslint, tsc, npm test (unit projects), production build + editor-exclusion check
./Scripts/install-hooks.sh     # install pre-commit hook (runs lint.sh before commit)
```

Both scripts go through the root `package.json` scripts, so that file is the single definition of what each check runs; CI's `checks` job invokes `lint.sh` rather than inlining its own steps, so a check added there cannot reach developers without also reaching CI. `lint.sh` never starts a container — the integration projects are CI's separate `integration-tests` job.

Anything these scripts run on Linux must not assume a macOS environment: GitHub's Ubuntu runners leave `TMPDIR` unset, so a bare `$TMPDIR` under `set -u` aborts the script before any check runs. Use `${TMPDIR:-/tmp}`.

CI on GitHub Actions (`.github/workflows/ci.yml`): `checks`, `integration-tests`, `wire-conformance` (compose-built server image), `docker-smoke` (the full topology through the proxy, including the 401 on `/admin`), and `publish`, which runs only on `main` after the other four pass.

## Code Conventions

- **Exhaustive switches**: `@typescript-eslint/switch-exhaustiveness-check` is on, and the message and state switches list every case so a new tag is a type error, never a silent fallthrough.
- **Identifiers in English**: types, properties, message names, Postgres column names, file names; only user-facing strings stay localizable.
- **Testing**: Vitest, one project per package; integration suites under `test/integration/` start their own Postgres.
- **No `.turbo/` references** in code or comments.

### Localization

Every user-facing string is looked up through a bilingual `{key: {en, de}}` JSON catalog whose keys **are** the English source strings, so an unresolved key falls back to readable English rather than a developer identifier. Three catalogs ship: `packages/core/data/catalog.json` (class and gender names, item labels), `packages/cli/src/catalog.json` (the twelve admin lines), and `packages/web/src/i18n/catalog.json` (everything the browser renders that the core catalog does not define). `packages/core/src/i18n/catalog.ts` holds the shared reader, merger, formatter, and `catalogViolations`, which checks an allowlist of rendered keys for en/de presence, placeholder parity (`%@` / `%1$@`), and the no-Unicode-ellipsis rule — ASCII `...` throughout.

Each consumer pins its allowlist: `RENDERED_KEYS` in `packages/web/src/i18n/index.ts` and in `packages/cli/src/catalog.ts`. `packages/web/test/i18n.test.ts` additionally scans every `.ts` file under `src` for `t(...)` / `lookup(...)` literals and fails on any that is absent from `RENDERED_KEYS`, and on any allowlisted key nothing renders. The web merge reports collisions between the core and web catalogs and a test pins that set to empty, so a duplicated key fails rather than letting import order pick the winner.

### Wire protocol

Messages are a discriminated union in `packages/protocol`, serialized as JSON over WebSocket **text** frames in the shape `{"tag":"<verb>","payload":{...}}`. `encodeSomnioMessage` / `decodeSomnioMessage` are the framing entrypoints; every payload field is validated on decode (typed ranges, byte caps where the protocol declares them), and an unknown tag throws `UnrecognizedTagError`, distinct from `WireDecodingError`, which is what lets the admin route answer `unknownCommand` instead of closing. `AdminRequest`/`AdminResponse` follow the same `{tag, payload}` shape with a string payload.

`encodeSomnioMessage` throws `OversizedFrameError` if the JSON exceeds `maxFrameLength`; `MAX_WIRE_FRAME_SIZE` (the `ws` `maxPayload`) sits a small `frameSizeSlack` above it. A frame past the wire size closes 1009 before the decoder runs; a frame inside the slack window reaches the decoder, whose own cap closes 1002 with the reason `frame validation failed`. That is the reason every malformed, unrecognized, or state-illegal frame closes with. Over-cap *values* inside a valid frame (a `clientSay` over 256 bytes, a session token over 256 bytes) are handled, not closed on: the say is dropped and the session verbs answer their failure result, so the socket stays open and the next frame is still processed.

JSON keys are the property names — renaming a property changes the wire key, which only the golden-frame suite catches. Avoid raw dictionaries on payloads; prefer ordered arrays (e.g. `WireInventoryExtra[]`) for stable, self-documenting output. `helloVersion` (`packages/protocol/src/constants.ts`) is compared with strict equality by the client; bump it when the wire breaks.

The server handles inbound frames strictly one at a time: the socket is paused while a handler runs and resumed after, so a handler that awaits Postgres never interleaves with the next frame. Broadcasts go through per-connection outboxes with a high watermark; a client that cannot keep up is closed with `outbox overflow` (1008) rather than back-pressuring the sector.

### Sector format

Sectors are JSON, stored in `.somnio-sector` files, read and written by `packages/core/src/sectorFile.ts`. The writer produces 2-space indent, `"key" : value` with a space before the colon, recursively sorted keys, raw `/` and raw UTF-8, an empty array as `[` / blank line / `]`, and no trailing newline, so committed fixtures stay human-diffable and byte-stable across an unedited open-and-save. The reader bounds `dimensions` and every record-array count against `SOMNIO_CONSTANTS` (the same guards the wire boundary applies in both directions of `sectorToWire`/`sectorFromWire`), so a hostile `.somnio-sector` cannot drive an unbounded tile-map allocation when loaded from `SOMNIO_SECTORS_DIR`.

The body and its sub-records (`GridSize`, `LightSetting`, `Object`, `CollisionMask`, `FloorPatch`, `SectorPortal`/`PortalDirection`, `MonsterSpawn`, `NPC`) use their property names as JSON keys, modern English, so the JSON is self-documenting. Visual identity is carried as semantic registry references: the sector's `floorMaterialID` and each `Object.modelID` resolve through the committed model registry, and an unmapped id renders a placeholder rather than rejecting the file.

The one exception to property-name keys is `NPC`: its `facing` (continuous degrees, 0° = south / 90° = east) serializes under the stable on-disk key `"direction"`, written as a bare degree number, normalized on decode rather than rejected. The reader stays placement-agnostic and carries the authored `spawnOrigin` verbatim; NPC centering lives in `npcRuntimePosition`.

`Object.rotation` is a yaw in degrees counter-clockwise seen from above (0 = as authored; models are normalized with their door/long axis on +X, so 270 faces a door south). A missing key decodes as 0 and 0 is omitted on encode. A rotated placement's `sourceWidth`/`sourceHeight` must carry the rotated footprint extents.

`floorPatches` (optional array of `{floorMaterialID, x, y, width, height}`) paints rectangular floor-material overlays over the base floor; a missing key decodes as empty and an empty array is omitted on encode. Patches are purely visual and must not overlap each other: coplanar overlapping quads z-fight. Collision masks are authored **mesh-flush**: a solid prop's mask equals its decal rect, a straight wall's mask is its exact footprint, and a corner piece contributes its two 32px arm rects as an L.

The canonical `.somnio-sector` extension is used everywhere: the committed fixtures (`packages/core/fixtures/sectors`), the server's `SOMNIO_SECTORS_DIR`, and the web editor's file API. The server loads only `.somnio-sector` files and keys each by its extension-stripped filename (the filename-as-sector-id convention); a directory with no `.somnio-sector` files fails startup (`noSectorsLoaded`) rather than booting an empty world.

### Model registry

The 3D pack's layout is data: the committed `packages/core/data/ModelRegistry.json` (exported as `@somnio/core/data/ModelRegistry.json`) maps figure bands to character model stems (with each model's `expectedClips` clip-presence contract), semantic object ids (`objectModels`) to prop stems, and semantic floor ids (`floorMaterials`) to floor-texture stems. The registry references only filename stems, so it never drifts from the uncommitted, operator-supplied model pack. `packages/core/src/modelRegistry.ts` validates the structural invariants on read (non-inverted figure ranges, non-empty stems/ids, no duplicate object or floor ids, characters expecting at least one clip) and degrades to a placeholder fallback with a logged error. The web editor's model/floor pickers are populated from the same registry ids, so the authoring surface can only reference resolvable models; the asset pipeline's clip-presence gate reads the same file.

## Agentic Setup

Skill kit at `Skills/`, symlinked from `.claude/skills/` (Claude Code) and `.agents/skills/` (Codex CLI). Both tools share the same set:

- `writing-for-interfaces` — upstream-derived UI-copy guidance (provenance and copyright notice in `Skills/ATTRIBUTION.md`)
- `somnio-server`, `somnio-cli`, `somnio-web` — run each component locally against the dev server
- `somnio-editor` — serve the localhost web map editor and drive it with `agent-browser`
- `deploy` — pin a published commit for both images in the deployment repo, with the `helloVersion` check and the sector-copy rule

`AGENTS.md` is the shared instructions file; `.claude/CLAUDE.md` is symlinked to it so Claude Code picks up the same content.
