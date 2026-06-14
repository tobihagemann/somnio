# Somnio

A 2D tile-based mini-MMORPG. Native macOS player client + Linux Swift server + macOS map editor + admin CLI, all in one SwiftPM workspace.

## Tech Stack

- Swift 6.2, macOS 26+, SwiftPM (no Xcode project)
- SwiftUI + SpriteKit for the player client and editor; Sparkle for auto-updates
- Hummingbird + WebSockets + PostgresNIO for the server
- swift-log facade with OSLog (Apple) / JSON-stdout (Linux) backends and a rotating-file fallback
- swift-argument-parser for the admin CLI
- swift-service-lifecycle for graceful server shutdown
- All types use Swift strict concurrency (`Sendable`, actors, structured concurrency); value types preferred

## Module Boundaries

```
SomnioProtocol   # message catalog + wire framing — Foundation only
SomnioCore       # game models (Sector, Character, NPC, Monster, Inventory, World, MapCodec)
                 # depends on SomnioProtocol
SomnioData       # Postgres persistence (schema, migrations, repositories) +
                 # server bootstrap helpers (config resolution, readiness wait) +
                 # Argon2id password hashing (lives next to the accounts table).
                 # depends on SomnioCore
SomnioUI         # SwiftUI views + SpriteKit scene
                 # depends on SomnioCore (NOT on SomnioData)
SomnioApp        # macOS executable: player client + UI + Sparkle
                 # depends on SomnioCore + SomnioUI + SomnioProtocol
SomnioEditor     # macOS executable: document-based map editor + Sparkle
                 # depends on SomnioCore + SomnioUI (NOT on SomnioProtocol or SomnioData)
SomnioServerCore # gameplay/admin handlers, per-connection + per-sector actors,
                 # Hummingbird app, sector cache, registration repo, checkpoint service
                 # depends on SomnioCore + SomnioData + SomnioProtocol +
                 # Hummingbird + HummingbirdWebSocket
SomnioServer     # Hummingbird executable: thin shim that calls SomnioServerCore.runServer()
                 # depends on SomnioServerCore + Logging
SomnioCLICore    # Admin CLI command tree, transport, output rendering, localization
                 # depends on SomnioCore + SomnioProtocol + ArgumentParser +
                 # HummingbirdWSClient + NIOCore + NIOFoundationCompat + Logging
SomnioCLI        # macOS/Linux executable: thin @main shim invoking SomnioCLICore.SomnioCLITool
                 # depends on SomnioCLICore
SomnioTestSupport # Shared test fixtures (no-op repository stubs, AdminRouteTestApplication,
                 # GameplayRouteTestApplication, StubAdminWorldRouter). Exported as a SwiftPM
                 # library product so the sibling IntegrationTests package can consume the
                 # same factories without re-implementing them; also consumed by
                 # SomnioServerCoreTests and SomnioCLICoreTests.
                 # depends on SomnioCore + SomnioData + SomnioProtocol + SomnioServerCore +
                 # Hummingbird + HummingbirdWebSocket + PostgresNIO + NIOCore + Logging
SomnioCatalogTestSupport # Foundation-only helper that reads SwiftPM `.xcstrings` JSON
                 # resources straight out of a `Bundle`. Consumed by SomnioCoreTests,
                 # SomnioUITests, and SomnioCLICoreTests to verify bilingual catalogs
                 # bypassing Foundation's runtime locale resolution.
                 # depends on Foundation only
```

These boundaries are strict:

- SomnioProtocol must never import another Somnio module.
- SomnioCore must never import SomnioData or SomnioUI.
- SomnioUI must never import SomnioData.
- SomnioApp must never import SomnioData or SomnioServerCore (the client never opens a Postgres connection; all server data flows in over the wire protocol).
- SomnioEditor must never import SomnioProtocol, SomnioData, SomnioServerCore, or SomnioServer (the editor is offline).
- SomnioCLICore must never import SomnioUI, Sparkle, or SomnioServerCore.
- SomnioCLI is a thin executable shim and must depend only on SomnioCLICore.

Enforce by reading `Package.swift` dependency lists and grepping for forbidden imports per module.

## Build & Test

```
swift build
swift build --build-tests            # compile test targets without running them
swift test
swift test --filter SomnioCoreTests  # run a specific test target
swift run SomnioApp                  # run the player client
swift run SomnioServer               # run the gameplay server
swift run SomnioCLI                  # run the CLI
```

Note: `swift build` only compiles executable and library targets. Use `swift build --build-tests` to verify test target compilation.

After `swift build`, binaries are directly runnable from `.build/debug/` (e.g., `.build/debug/SomnioCLI`).

Build prerequisites: `libargon2-dev` (Debian/Ubuntu: `apt install libargon2-dev`; macOS: `brew install argon2`; Alpine: `apk add argon2-dev`). The `CArgon2` SwiftPM system-library target links against this; `swift build` fails with a `pkg-config` / linker error pointing at the missing library if it's not installed.

### Integration Tests

Integration tests live in a sibling SwiftPM package at `IntegrationTests/` so a plain `swift test` at the repo root never runs them. The suite is self-contained: each test auto-spawns a `postgres:16` container via Docker (or Podman if Docker isn't on PATH), applies migrations, runs, and tears the container down. No env vars, no manual setup. The suite skips cleanly when neither container runtime is available; the only hard prerequisite for actually running the tests is having `docker` or `podman` installed.

```
swift test --package-path IntegrationTests
```

## Packaging

`version.env` is the single source of truth for app metadata (`APP_NAME`, `BUNDLE_ID`, `EXEC_NAME`, `CLI_NAME`, `EDITOR_EXEC_NAME`, `SERVER_EXEC_NAME`). All scripts source it.

```
Scripts/package_app.sh [debug|release] [player|editor]   # build + assemble .app bundle
Scripts/compile_and_run.sh                               # package + launch player (dev loop)
Scripts/create_dmg.sh [player|editor]                    # wrap .app in DMG
Scripts/release.sh                                       # build, sign, notarize, DMG, zip both bundles
```

`Resources/Entitlements.plist` holds app entitlements (`network.client`, `files.user-selected.read-write`).

`Scripts/package_app.sh` injects `<key>SomnioBuildConfiguration</key><string>${CONF}</string>` (`debug` or `release`) into the bundle's `Info.plist`.

Release tags are **bare-numeric** (`[0-9]*.[0-9]*.[0-9]*`, e.g. `1.2.3`), not `v`-prefixed. `release.yml` triggers on this glob; any new release-triggered workflow must mirror it.

### Asset bundling

Tilesets, character sprites, and animation strips are not committed to this repo. They are copied into the `.app/Contents/Resources/` at packaging time by `Scripts/bundle-assets.sh`, which reads two env vars:

- `SOMNIO_ASSET_SOURCE` — absolute path on the build machine to the asset root. Set this when releasing. Must contain `Tilesets/`, `Characters/`, `Animations/`, `System/`, and `Buttons/` subdirectories.
- `SOMNIO_ASSET_DEST` — set automatically by `package_app.sh` to the bundle's `Resources/` path.

`bundle-assets.sh` rsyncs each of the five subtrees into the destination and warns (without failing) on any missing subtree, so an in-progress operator-supplied pack still yields a runnable bundle. Runtime apps load assets exclusively from `Bundle.main` via `BundleMainSpriteAssets`. There is no env var or Preferences UI for asset paths.

No asset pack is committed to the repo. A runtime app launched without an operator-supplied `SOMNIO_ASSET_SOURCE` renders with the loader's nil-fallback path: empty ground (no ground tile map is built), untextured object decals, untextured entity sprites (sized to mask), and a solid-color splash.

## Logging

Uses `swift-log` as a facade. Two bootstrap surfaces:

- `LoggingConfiguration.bootstrap()` (in `SomnioCore`) — used by the player client, editor, and CLI. On Apple platforms: `MultiplexLogHandler([OSLogHandler, FileLogHandler(somnio.log)])`. On Linux: `MultiplexLogHandler([JSONLogHandler, FileLogHandler(somnio.log)])`.
- `ServerLoggingConfiguration.bootstrap()` (in `SomnioServerCore`) — composes a JSON stdout backend (container-friendly) with two label-filtered file backends: `gameplay-log.log` for `de.tobiha.somnio.server.gameplay.*` and `admin-log.log` for `de.tobiha.somnio.server.admin.*`. Records that don't match either prefix go only to stdout.

Logger labels use dot notation: `Logger(label: "de.tobiha.somnio.app.lifecycle")` — last component is the category (flat lowercase), rest is the OSLog subsystem.

File log verbosity is controlled by the `advancedLogLevel` UserDefaults key — `"default"` → info, `"debug"` → debug, `"verbose"` → trace.

## Dev/Prod Isolation

`BuildEnvironment` (in SomnioCore) centralizes `#if DEBUG` config. Debug builds use separate storage to avoid polluting production data:

| Component | Prod | Dev |
|-----------|------|-----|
| Application Support | `~/Library/Application Support/Somnio/` | `~/Library/Application Support/Somnio-Dev/` |
| Credentials | macOS Keychain | file-based under `Somnio-Dev/` |
| UserDefaults | `.standard` | `UserDefaults(suiteName: "de.tobiha.somnio.dev")` |

Set `SOMNIO_USE_KEYCHAIN=1` to use real Keychain in debug builds.

Set `SOMNIO_PROFILE=<name>` to run multiple isolated instances side by side:

| Component | Default Dev | `SOMNIO_PROFILE=alice` |
|-----------|-------------|------------------------|
| Application Support | `Somnio-Dev/` | `Somnio-Dev-alice/` |
| UserDefaults | `de.tobiha.somnio.dev` | `de.tobiha.somnio.dev.alice` |

## Deployment

The gameplay server speaks **plain HTTP/WebSocket** — TLS is terminated by a reverse proxy at the deployment boundary. The `HTTP1WebSocketUpgrade` `Application` listens on `SOMNIO_HTTP_HOST:SOMNIO_HTTP_PORT` (default `0.0.0.0:8080`) without certificates. Do not push TLS into the app process; the docker-compose example pins the proxy contract.

Server runtime configuration is resolved from environment variables (resolution lives in `SomnioServerCore.ServerConfiguration`):

| Variable | Default (debug) | Required in release |
|----------|-----------------|---------------------|
| `SOMNIO_HTTP_HOST` | `0.0.0.0` | no |
| `SOMNIO_HTTP_PORT` | `8080` | no |
| `SOMNIO_ADMIN_TOKEN` | `dev-admin` | yes |
| `SOMNIO_SECTORS_DIR` | `Tests/SomnioMapFixturesTestSupport/MapFixtures` | yes |
| `SOMNIO_DATABASE_URL` | localhost fallback | yes |

The server exposes `GET /health` (unauthenticated, returns 200 / 503 based on a `SELECT 1`), `WS /ws` (gameplay), and `WS /admin` (operator CLI; pre-upgrade `Authorization: Bearer $SOMNIO_ADMIN_TOKEN` gate). The `/admin` route is wired end-to-end through `AdminConnectionActor` → `AdminCommandDispatcher`; dispatch events log under `de.tobiha.somnio.server.admin.dispatch`.

A committed multi-stage `Dockerfile` + `docker-compose.example.yml` build and run the server image. `SomnioServer` builds on Linux straight from the single root `Package.swift` despite its `platforms: [.macOS(.v26)]` pin: Sparkle is product-conditional (`.when(platforms: [.macOS])`), so `swift build --product SomnioServer` pulls no macOS-only target — the CI `integration-tests` job already exercises this on `ubuntu-latest`. The `Dockerfile` takes a **required** `MARKETING_VERSION` build-arg (no default; the build fails without it), injected via `sed` into `SomnioServerVersion.swift` — anything feeding that arg from CI must reject `sed`-unsafe characters.

## Lint & Format

SwiftFormat, SwiftLint, and Periphery are installed via Homebrew:

```
./Scripts/format.sh            # auto-format + autocorrect
./Scripts/lint.sh              # check format + lint + unused code (read-only)
./Scripts/install-hooks.sh     # install pre-commit hook (runs lint.sh before commit)
```

CI on GitHub Actions mirrors the same checks (`.github/workflows/ci.yml`).

## Code Conventions

- **No Objective-C**: pure Swift, no `@objc`, no NSObject subclasses.
- **Value types preferred**: structs and enums over classes, except where reference semantics are required (`@Observable`, actors).
- **Concurrency**: value types are automatically `Sendable`. Never use `@unchecked Sendable`. Use actors for mutable shared state.
- **Testing**: Swift Testing (`import Testing`, `@Test`, `#expect`, `#require`), not XCTest. Struct-based suites; parameterized via `@Test(arguments:)`.
- **Exhaustive switches**: never use `default:` when switching on project-defined enums. List all cases explicitly so the compiler catches new cases at build time.
- **Identifiers in English**: Swift types, properties, packet/message names, Postgres column names, file names. The original source's German identifiers are translated; only user-facing strings stay localizable.

### Localization

Every user-facing string is loaded with an explicit bundle. SwiftPM `.process` resources live in `Bundle.module`, not `Bundle.main`, so the bare `NSLocalizedString("key")` and `Text("key")` overloads silently miss the catalog. Use `String(localized: key, bundle: .module)` from Foundation paths and `Text(_, bundle: .module)` from SwiftUI views. When the player client and editor add user-facing views, define a per-target `L` enum (matching `Sources/SomnioCLICore/Localization.swift`) that wraps these calls so the bundle pinning stays in one place.

For custom views that accept a "localized title" parameter, prefer `LocalizedStringResource` — it defers locale resolution to the consumer's bundle.

`SomnioCore` ships its own catalog (`Sources/SomnioCore/Resources/Localizable.xcstrings`) for library-internal localized strings (currently the `CharacterClass.displayName` set and the `ItemCatalog` inventory labels). The admin CLI and the UI module each ship their own bilingual catalogs (`Sources/SomnioCLICore/Resources/Localizable.xcstrings`, `Sources/SomnioUI/Resources/Localizable.xcstrings`) and per-target `enum L` shims (`Sources/SomnioCLICore/Localization.swift`, `Sources/SomnioUI/Localization.swift`). The UI shim adds `L.resource(_:)` returning a `LocalizedStringResource` pinned to `Bundle.module` for SwiftUI surfaces that need that type (`.help`, custom view title parameters). The player client and editor each have their own empty catalogs scoped to their `Bundle.module`, ready to be populated as views land.

ASCII `...` ellipsis throughout, with one historical exception: the editor's "Ladevorgang läuft…" window title uses Unicode `…`. Every other user-visible string uses ASCII.

### Wire protocol

Messages are modelled as discriminated-union enums in `SomnioProtocol`, serialized as JSON over WebSocket **text** frames in the shape `{"tag":"<verb>","payload":{...}}`. `SomnioMessageEncoder.encode` / `SomnioMessageDecoder.decode` are the framing entrypoints; boundaries convert `Data` ⇄ `String` at the `.text` frame edge. The `tag` is a string equal to the `SomnioMessageTag` case name; `SomnioMessage.init(from:)` is hand-written so an unknown tag throws `SomnioProtocolError.unrecognizedTag(String)` (a synthesized decode would throw `DecodingError` and break the admin unknown-verb carve-out). `AdminRequest`/`AdminResponse` follow the same `{tag, payload}` string-discriminator shape. `Tests/SomnioProtocolTests/RoundTripTests.swift` (+ `AdminCodableTests.swift`, `WireFrameLimitsTests.swift`) are the regression guards.

`SomnioMessageEncoder.encode` throws `oversizedFrame` if the JSON exceeds `maxFrameLength`; `maxWireFrameSize` (the WS-layer `maxFrameSize`) sits a small `frameSizeSlack` above it so the guard fires cleanly instead of the receiver hard-closing. A malformed/unrecognized inbound frame logs + closes the connection.

Payload structs use synthesized `Codable`, so JSON keys are the property names — renaming a property changes the wire key. Avoid raw `Dictionary` fields on payloads — prefer ordered struct arrays (e.g., `[WireInventoryExtra]`) for stable, self-documenting output.

### Sector format

Sectors are JSON, stored in `.somnio-sector` files. `MapCodec` (in `SomnioCore`) is a thin facade over `JSONDecoder`/`JSONEncoder` (per-call instances): `read(_ data: Data) throws -> SectorBody` decodes, `write(_ sector: SectorBody) throws -> Data` encodes with `[.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]` so committed fixtures stay human-diffable. Decode failures surface as `Swift.DecodingError`. `read` also bounds the decoded `dimensions` against `SomnioConstants.maxSectorDimension`/`maxSectorArea` (mirroring the wire boundary in `Sector(_ wire:)`) so a hostile `.somnio-sector` can't drive an unbounded tile-map allocation when opened in the editor or loaded from `SOMNIO_SECTORS_DIR`.

`SectorBody` and its sub-models (`GridSize`, `GroundTile`, `LightSetting`, `Object`, `CollisionMask`, `SectorPortal`/`PortalDirection`, `MonsterSpawn`, `NPC`) are `Codable` with synthesized property-name keys — modern English, so the JSON is self-documenting. The one exception is `NPC`, whose `Codable` is hand-written so `direction` serializes as a semantic `Direction` case name (`"south"`); the stored field stays `Int16` (legacy `richtung`) because the wire/sprite/DB seams read its rawValue. An out-of-range direction throws on encode/decode. The reader stays placement-agnostic — it carries the authored `spawnOrigin` verbatim; NPC centering lives in `NPCPlacement.runtimePosition(for:)`.

The canonical `.somnio-sector` extension is used everywhere: the editor's exported UTType (conforming to `public.json`), the three shipped fixtures (`Tests/SomnioMapFixturesTestSupport/MapFixtures`), and the server's `SOMNIO_SECTORS_DIR`. `SectorCache` loads only `.somnio-sector` files and keys each by its extension-stripped filename (the filename-as-sector-id convention); a directory with no `.somnio-sector` files fails server startup with `ServerStartupError.noSectorsLoaded` rather than booting an empty world.

### Asset manifest

The 2003 art-pack layout conventions are data, not hardcoded Swift: a committed `Sources/SomnioCore/Resources/AssetManifest.json` states the figure-banding ranges (player=1, npc=2-10&61-109, monster=11-60), the tileset filename format + 1-based offset, the sprite-sheet row order (legacy S/W/E/N), the per-band cell geometry, and the walk-frame count. The manifest references no filenames, so it never drifts from the uncommitted, operator-supplied art pack. Output must stay **pixel-identical** to the hardcoded behavior — `Tests/SomnioUITests/BundleMainSpriteAssetsTests.swift` is the guard.

The data type + pure rule helpers (`AssetManifest`, `band(forLeadingNumber:)`, `tilesetFilenamePrefix(forIndex:)`, `rowIndex(for:)`) live in **SomnioCore** (expressible from `Direction`/`Int16`/`GridSize`); the consuming loader stays in **SomnioUI** (`BundleMainSpriteAssets` owns bundle I/O, caching, and the `WorldEntity.Kind -> CharacterBand` mapping, since `WorldEntity.Kind` is a SomnioUI type). `AssetManifestCodec` mirrors `MapCodec` (stateless `enum`, per-call coders, sorted-keys pretty-print); `read` throws `DecodingError` and `write` throws `EncodingError` on the structural invariants the synthesized `Codable` can't express (all four directions present once, positive frame count, player band carries both `sheetGrid`+`cell` while single-region bands carry neither, non-inverted ranges). `directionRows` serializes by `Direction` case name via the shared `Direction.caseName` seam, decoupling the asset path from `legacyRichtung` (which survives only for the NPC/DB seam). `BundleMainSpriteAssets(bundle:manifest:)` resolves the committed manifest in its initializer, degrading to `AssetManifest.legacyFallback` with a logged error if the bundled JSON is missing or corrupt.

## Agentic Setup

Skill kit at `Skills/`, symlinked from `.claude/skills/` (Claude Code) and `.agents/skills/` (Codex CLI). Both tools share the same set:

- `swift-architecture`, `swift-concurrency`, `swift-language`, `swift-security`, `swift-testing` — Swift 6.2 patterns and APIs
- `swiftui`, `swiftui-performance-audit` — SwiftUI guidance
- `macos-spm-app-packaging` — SPM-built `.app` bundle workflows (generic; not Somnio's two-bundle player+editor pipeline)

All upstream-derived from MIT-licensed agent-skill repos; provenance and copyright notices in `Skills/ATTRIBUTION.md`.

`AGENTS.md` is the shared instructions file; `.claude/CLAUDE.md` is symlinked to it so Claude Code picks up the same content.

`.mcp.json` configures `sosumi` (`https://sosumi.ai/mcp`) for live Apple developer documentation lookups.

Project-specific skills for Somnio's two-bundle packaging (`Scripts/package_app.sh [debug|release] [player|editor]`, `Scripts/create_dmg.sh [player|editor]`, `Scripts/release.sh`) are not shipped here yet. Author them under `Skills/` when the workflow stabilizes.
