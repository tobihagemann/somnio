# Somnio

A 2D tile-based mini-MMORPG. Native macOS player client + Linux Swift server + macOS map editor + admin CLI, all in one SwiftPM workspace.

## Tech Stack

- Swift 6.2, macOS 15+, SwiftPM (no Xcode project)
- SwiftUI for the player client and editor UIs; RealityKit for the 3D world rendering (player client and editor authoring viewport); Sparkle for player auto-updates only
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
SomnioUI         # SwiftUI views (chat, HUD, main window composition, SpeechBubbleText)
                 # depends on SomnioCore (NOT on SomnioData)
SomnioScene3D    # RealityKit 3D render surface for the player world and the editor
                 # (WorldScene3D, WorldScene3DView, OrthographicCameraRig, EditorFraming,
                 # the editor's authoring overlay)
                 # depends on SomnioCore (NOT on SomnioProtocol/SomnioData/SomnioServerCore/SomnioUI)
SomnioApp        # macOS executable: player client + UI + Sparkle
                 # depends on SomnioCore + SomnioUI + SomnioScene3D + SomnioProtocol
SomnioEditor     # macOS executable: document-based map editor (no Sparkle; built locally)
                 # depends on SomnioCore + SomnioScene3D (NOT on SomnioProtocol or SomnioData)
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
                 # GameplayRouteTestApplication, StubAdminWorldRouter) plus the live-server
                 # test harness: `withLiveServer` replaces HummingbirdTesting's
                 # `.test(.live)` (whose unbounded awaits intermittently hung the whole
                 # suite) with a bounded startup race + deadline-bounded teardown, backed
                 # by shared primitives (PortPromise, ServiceEndedPromise, withTestTimeout,
                 # pollUntil, FirstWriteSlot, LiveTestClient). Exported as a SwiftPM
                 # library product so the sibling IntegrationTests package can consume the
                 # same factories without re-implementing them; also consumed by
                 # SomnioServerCoreTests and SomnioCLICoreTests.
                 # depends on SomnioCore + SomnioData + SomnioProtocol + SomnioServerCore +
                 # Hummingbird + HummingbirdTesting + HummingbirdWebSocket +
                 # HummingbirdWSClient + PostgresNIO + ServiceLifecycle + NIOCore + Logging
SomnioAssetValidator # macOS build-tool executable: loads a converted .usdz via RealityKit
                 # and asserts the model registry's expectedClips surface through
                 # Entity.availableAnimations (the glb->USDZ clip-presence gate,
                 # invoked by the asset repo's Pipeline/convert-glb-to-usdz.sh; never shipped).
                 # depends on SomnioCore + SomnioScene3D (shares the loader's
                 # clip-enumeration seam so the gate and runtime never drift)
SomnioCatalogTestSupport # Foundation-only helper that reads SwiftPM `.xcstrings` JSON
                 # resources straight out of a `Bundle`. Consumed by SomnioCoreTests,
                 # SomnioUITests, and SomnioCLICoreTests to verify bilingual catalogs
                 # bypassing Foundation's runtime locale resolution.
                 # depends on Foundation only
```

These boundaries are strict:

- SomnioProtocol must never import another Somnio module.
- SomnioCore must never import SomnioData or SomnioUI.
- SomnioUI must never import SomnioData, and must never import SomnioScene3D (the render-surface protocol and the `WorldEntity` DTO live in SomnioCore so both renderers conform without a cycle).
- SomnioScene3D must never import SomnioProtocol, SomnioData, SomnioServerCore, or SomnioUI (a SomnioCore-only renderer shared by the player client and the offline editor).
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
Scripts/release.sh [player|editor ...]                   # build, sign, notarize, DMG, zip (default: both bundles)
```

`Resources/Entitlements.plist` holds app entitlements (`network.client`, `files.user-selected.read-write`).

`Scripts/create_dmg.sh` (and `release.sh`, which calls it) require `create-dmg` (`brew install create-dmg`). It lays out the retro install window from `Resources/DMG/` (the `background.png` cloud art, `VolumeIcon.icns`, the app icon over the left drop-zone, no `/Applications` symlink). The per-target app/document icons live in `Resources/Icons/` and are copied into the bundle by `package_app.sh`, referenced from `Info.plist` via `CFBundleIconFile`/`CFBundleTypeIconFile`.

`Scripts/package_app.sh` injects `<key>SomnioBuildConfiguration</key><string>${CONF}</string>` (`debug` or `release`) into the bundle's `Info.plist`.

Release tags are **component-prefixed**, not `v`-prefixed: `player-X.Y.Z` triggers `release.yml` (player `.app`/DMG + Sparkle appcast + GitHub Release) and `server-X.Y.Z` triggers `docker-image.yml` (ghcr server image). Each workflow strips its own prefix to get the bare `X.Y.Z` marketing version; in `release.yml` the full tag (`RELEASE_TAG`) names the GitHub Release and the Sparkle `--download-url-prefix`, so the two stay aligned. The **editor is not released by CI** — build it locally with `Scripts/release.sh editor` (CI calls `Scripts/release.sh player`). Any new release-triggered workflow must use its own `<component>-` prefix and never the bare-numeric glob (which would collide with all components at once).

### Asset bundling

3D models, floor materials, and UI chrome textures are not committed to this repo. They are copied into the `.app/Contents/Resources/` at packaging time by `Scripts/bundle-assets.sh`, which reads three env vars:

- `SOMNIO_ASSET_SOURCE` — absolute path on the build machine to the asset root. Must contain the `Models/`, `FloorMaterials/`, and `UI/` subtrees. **Required for the player target** (packaging fails without it); the editor skips silently when unset.
- `SOMNIO_ASSET_DEST` — set automatically by `package_app.sh` to the bundle's `Resources/` path.
- `SOMNIO_BUNDLE_TARGET` — `player` or `editor`, set automatically by `package_app.sh` (unset fails closed as `player`). Selects which pack contract to enforce.

`bundle-assets.sh` rsyncs the subtrees into the destination. `Models/`/`FloorMaterials/` warn (without failing) when missing, so an in-progress operator-supplied pack still yields a runnable bundle; `UI/` is a **hard failure** for the player bundle — SomnioUI's panel chrome has no designed fallback (each missing stem logs one error, then renders unstyled). The model loader (`BundleMainModelAssets` in SomnioScene3D) loads `Models/<stem>.usdz` and `FloorMaterials/<stem>.png` from `Bundle.main`, resolving the sector format's semantic ids (`floorMaterialID`, `Object.modelID`) through the committed model registry (`Sources/SomnioCore/Resources/ModelRegistry.json`, read via `ModelRegistryCodec`); the UI texture loader (`FantasyPanelTextures` in SomnioUI) loads `UI/<stem>.png` from `Bundle.main` the same way. There is no env var or Preferences UI for asset paths.

`UI/` holds the CC0 Kenney "Fantasy UI Borders" 9-slice chrome (white line-art over transparent centers, semantic stems like `panel-primary`/`panel-button`; the runtime composites them over its own dark fills). The 3D subtrees are produced by the private `somnio-assets` repo's `Pipeline/convert-glb-to-usdz.sh` (run against its `Pipeline/staged/` glbs — that repo carries the raw sources and the whole Blender conversion pipeline; see its `CLAUDE.md`): it converts every source model into `Models/<stem>.usdz` via a headless Blender per-clip timeline merge that preserves each model's named animation-clip library, then gates each output on `usdchecker` plus `SomnioAssetValidator` (a build-tool executable that loads the USDZ through RealityKit and asserts the registry's `expectedClips` surface in `Entity.availableAnimations` — a naive export collapses the clip library, which this gate fails loudly). `FloorMaterials/` holds CC0 floor textures copied in as-is; the runtime floor resolves the sector's `floorMaterialID` through the registry's `floorMaterials` table, and an unmapped or missing material falls back to a solid untextured plane. Prop models (the registry's `objectModels` stems, empty `expectedClips`) must be **placement-normalized before conversion**: local origin at the ground-footprint center, long horizontal axis along X. Sizing has two modes (the asset repo's `Pipeline/normalize_props.py` table): same-scale KayKit furniture keeps the kit's native proportions via the shared character-derived world factor, while architecture that must span an authored map footprint (and stand-in props) is width-fit to `sourceWidth` × 0.02 m/px. The runtime adds no per-object scale and anchors each clone's footprint to the overlapping collision mask's south edge (falling back to the decal rect's bottom edge), so an un-normalized prop appears shifted or mis-sized.

No asset pack is committed to the repo. Without an operator-supplied `SOMNIO_ASSET_SOURCE`, the player cannot be packaged; a plain `swift run SomnioApp` (no bundle) renders placeholders for every model, an untextured floor, and unstyled UI panels.

### CI release configuration

CI-driven releases (`release.yml`) inject three externalized inputs at build time, so the public repo never carries licensed art or the production endpoint:

- **Asset pack** — a separate private repo (`tobihagemann/somnio-assets`) holds the runtime subtrees (`Models/`, `FloorMaterials/`, `UI/`) at its root (the repo also carries unused 2D subtrees the build ignores). `release.yml` checks it out into `assets/` with the `ASSETS_DEPLOY_KEY` secret (a read-only SSH deploy key scoped to that repo; the default `GITHUB_TOKEN` can't reach a second repo) and points `SOMNIO_ASSET_SOURCE` at it.
- **Production gameplay endpoint** — the `SOMNIO_GAMEPLAY_PRODUCTION_URL` repo *variable* (e.g. `wss://somnio.tobiha.de/ws`; not a secret — every player sees it). `Scripts/inject-release-transport.sh` rewrites `GameplayServerURL.swift`, replacing the `#error` placeholder with the literal. Required for **player + release** only; the editor and debug builds never reach the guard.
- **Pinned TLS trust root** — `Scripts/release-trust-roots.pem` (committed) holds the Let's Encrypt ISRG Root X1 + X2 roots (publicly verifiable by fingerprint). The same inject script embeds them into `gameplayProductionTrustRootPEM` in `GameplayServerPin.swift`. Pinning the long-lived roots (not the 90-day leaf) means certificate renewals never break the shipped player; both roots cover an RSA→ECDSA key-type switch.

`package_app.sh` runs the injection immediately before the player release build, backing up and restoring the sources on exit so a local release leaves the tree clean; it is gated on `player + release` (signing mode is irrelevant — what matters is that release config compiles the `#if !DEBUG` branch). The default `compile_and_run.sh` dev loop builds debug and never injects, but `compile_and_run.sh --release-*` is an adhoc release build that does inject and so needs `SOMNIO_GAMEPLAY_PRODUCTION_URL` like any release. A player release is connectable only once the current server is deployed (see Deployment) and `SOMNIO_GAMEPLAY_PRODUCTION_URL` is set; the editor release is self-contained and needs neither.

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

A committed multi-stage `Dockerfile` + `docker-compose.example.yml` build and run the server image. `SomnioServer` builds on Linux straight from the single root `Package.swift` despite its `platforms: [.macOS(.v15)]` pin: Sparkle is product-conditional (`.when(platforms: [.macOS])`), so `swift build --product SomnioServer` pulls no macOS-only target — the CI `integration-tests` job already exercises this on `ubuntu-latest`. The `Dockerfile` takes a **required** `MARKETING_VERSION` build-arg (no default; the build fails without it), injected via `sed` into `SomnioServerVersion.swift` — anything feeding that arg from CI must reject `sed`-unsafe characters.

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

Each target's bilingual catalog is guarded by a per-target catalog test (the `LocalizableCatalogTests` suites for SomnioApp/SomnioEditor/SomnioUI; the CLI's lives in `AdminOutputTests` and SomnioCore's in `CatalogAssertionsTests`) whose `expectedKeys` allowlist is the only thing checked for en/de presence, placeholder parity, and the no-Unicode-ellipsis rule. A catalog key absent from that allowlist ships unguarded, so every new user-facing string must be added both to the `.xcstrings` catalog and to its target's `expectedKeys` list.

`swift build` never compiles `.xcstrings` (the resource bundles carry the raw JSON, so non-English resolution is dead under `swift run`/`swift test` — keys are the English source strings, so this reads as English). The packaged apps get real localization from `Scripts/package_app.sh`: after copying the SwiftPM bundles it compiles each bundle's catalog via `xcstringstool` into `<lang>.lproj/Localizable.strings`, deletes the raw `.xcstrings`, validates a per-target required-bundle set (player: Core/UI/App; editor: Core/Editor), and advertises the locales in the app's `Info.plist` (`CFBundleLocalizations`, `CFBundleAllowMixedLocalizations` — required for Foundation to resolve subordinate-bundle localizations). Adding a new locale therefore means updating both the catalogs and `CFBundleLocalizations` in `package_app.sh`. `Tests/SomnioCoreTests/CatalogRuntimeResolutionTests.swift` pins the compile→resolve contract; the Linux-reachable catalogs (SomnioCore, SomnioCLICore) are additionally guarded by `assertKeysAreEnglishFallback` so their `return key` fallback always reads as English.

### Wire protocol

Messages are modelled as discriminated-union enums in `SomnioProtocol`, serialized as JSON over WebSocket **text** frames in the shape `{"tag":"<verb>","payload":{...}}`. `SomnioMessageEncoder.encode` / `SomnioMessageDecoder.decode` are the framing entrypoints; boundaries convert `Data` ⇄ `String` at the `.text` frame edge. The `tag` is a string equal to the `SomnioMessageTag` case name; `SomnioMessage.init(from:)` is hand-written so an unknown tag throws `SomnioProtocolError.unrecognizedTag(String)` (a synthesized decode would throw `DecodingError` and break the admin unknown-verb carve-out). `AdminRequest`/`AdminResponse` follow the same `{tag, payload}` string-discriminator shape. `Tests/SomnioProtocolTests/RoundTripTests.swift` (+ `AdminCodableTests.swift`, `WireFrameLimitsTests.swift`) are the regression guards.

`SomnioMessageEncoder.encode` throws `oversizedFrame` if the JSON exceeds `maxFrameLength`; `maxWireFrameSize` (the WS-layer `maxFrameSize`) sits a small `frameSizeSlack` above it so the guard fires cleanly instead of the receiver hard-closing. A malformed/unrecognized inbound frame logs + closes the connection.

Payload structs use synthesized `Codable`, so JSON keys are the property names — renaming a property changes the wire key. Avoid raw `Dictionary` fields on payloads — prefer ordered struct arrays (e.g., `[WireInventoryExtra]`) for stable, self-documenting output.

### Sector format

Sectors are JSON, stored in `.somnio-sector` files. `MapCodec` (in `SomnioCore`) is a thin facade over `JSONDecoder`/`JSONEncoder` (per-call instances): `read(_ data: Data) throws -> SectorBody` decodes, `write(_ sector: SectorBody) throws -> Data` encodes with `[.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]` so committed fixtures stay human-diffable. Decode failures surface as `Swift.DecodingError`. `read` also bounds the decoded `dimensions` against `SomnioConstants.maxSectorDimension`/`maxSectorArea` (mirroring the wire boundary in `Sector(_ wire:)`) so a hostile `.somnio-sector` can't drive an unbounded tile-map allocation when opened in the editor or loaded from `SOMNIO_SECTORS_DIR`.

`SectorBody` and its sub-models (`GridSize`, `LightSetting`, `Object`, `CollisionMask`, `SectorPortal`/`PortalDirection`, `MonsterSpawn`, `NPC`) are `Codable` with synthesized property-name keys — modern English, so the JSON is self-documenting. Visual identity is carried as semantic registry references: the sector's `floorMaterialID` and each `Object.modelID` resolve through the committed model registry (`Sources/SomnioCore/Resources/ModelRegistry.json`); an unmapped id renders a placeholder rather than rejecting the file, while a file carrying legacy tileset source-rects fails decode loudly rather than being upgraded. The one exception to synthesized keys is `NPC`: its `facing: Heading` (continuous degrees, 0° = south / 90° = east) serializes under the stable on-disk key `"direction"` via `CodingKeys`, written as a bare degree number (`"direction" : 270`) through `Heading`'s single-value `Codable`, which normalizes out-of-range persisted values on decode rather than throwing. The reader stays placement-agnostic — it carries the authored `spawnOrigin` verbatim; NPC centering lives in `NPCPlacement.runtimePosition(for:)`.

The canonical `.somnio-sector` extension is used everywhere: the editor's exported UTType (conforming to `public.json`), the three shipped fixtures (`Tests/SomnioMapFixturesTestSupport/MapFixtures`), and the server's `SOMNIO_SECTORS_DIR`. `SectorCache` loads only `.somnio-sector` files and keys each by its extension-stripped filename (the filename-as-sector-id convention); a directory with no `.somnio-sector` files fails server startup with `ServerStartupError.noSectorsLoaded` rather than booting an empty world.

### Model registry

The 3D pack's layout is data, not hardcoded Swift: the committed `Sources/SomnioCore/Resources/ModelRegistry.json` maps figure bands to character model stems (with each model's `expectedClips` clip-presence contract), semantic object ids (`objectModels`) to prop stems, and semantic floor ids (`floorMaterials`) to floor-texture stems. The registry references only filename stems, so it never drifts from the uncommitted, operator-supplied model pack. `ModelRegistryCodec` mirrors `MapCodec` (stateless `enum`, per-call coders, sorted-keys pretty-print); `read` throws `DecodingError` and `write` throws `EncodingError` on the structural invariants the synthesized `Codable` can't express (non-inverted figure ranges, non-empty stems/ids, no duplicate object or floor ids, characters expecting at least one clip). `BundleMainModelAssets(bundle:registry:)` resolves the committed registry in its initializer, degrading to `ModelRegistry.placeholderFallback` with a logged error if the bundled JSON is missing or corrupt. The editor's model/floor pickers are populated from the same registry ids, so the authoring surface can only reference resolvable models.

## Agentic Setup

Skill kit at `Skills/`, symlinked from `.claude/skills/` (Claude Code) and `.agents/skills/` (Codex CLI). Both tools share the same set:

- `swift-architecture`, `swift-concurrency`, `swift-language`, `swift-security`, `swift-testing` — Swift 6.2 patterns and APIs
- `swiftui`, `swiftui-performance-audit` — SwiftUI guidance
- `macos-spm-app-packaging` — SPM-built `.app` bundle workflows (generic; not Somnio's two-bundle player+editor pipeline)

All upstream-derived from MIT-licensed agent-skill repos; provenance and copyright notices in `Skills/ATTRIBUTION.md`.

`AGENTS.md` is the shared instructions file; `.claude/CLAUDE.md` is symlinked to it so Claude Code picks up the same content.

`.mcp.json` configures `sosumi` (`https://sosumi.ai/mcp`) for live Apple developer documentation lookups.

Project-specific skills for Somnio's two-bundle packaging (`Scripts/package_app.sh [debug|release] [player|editor]`, `Scripts/create_dmg.sh [player|editor]`, `Scripts/release.sh [player|editor ...]`) are not shipped here yet. Author them under `Skills/` when the workflow stabilizes.
