# Somnio

A 2D tile-based mini-MMORPG. Native macOS player client + Linux Swift server + admin CLI in one SwiftPM workspace, plus a Three.js browser client and a localhost web map editor.

This is a from-scratch Swift port of an old REALbasic project; the macOS player ships as a code-signed `.app` bundle with Sparkle auto-updates, and the server ships as a Docker image alongside Postgres.

## Build & Run

```
swift build
swift test
```

Run individual targets:

```
swift run SomnioApp        # player client (macOS)
swift run SomnioServer     # gameplay server (cross-platform)
swift run SomnioCLI        # admin CLI (cross-platform)
```

The Three.js browser client and the localhost web map editor live in `Web/` (their own npm workspace):

```
cd Web
npm ci
npm run dev                # browser client (Vite on :5173, proxies /ws to the local server)
npm run editor             # web map editor (authors .somnio-sector files)
```

The integration test suite is a sibling SwiftPM package and skips automatically when no live database is configured:

```
swift test --package-path IntegrationTests
```

See [AGENTS.md](AGENTS.md) for the deeper guide — module boundaries, dev/prod isolation, logging, packaging, lint/format, and code conventions.

## License

Distributed under the GNU Affero General Public License v3.0. See the [LICENSE](LICENSE) file for details.

The license covers the source code in this repository. The game's art assets are separately licensed, are not included here, and are bundled only into official release builds.
