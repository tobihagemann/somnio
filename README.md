# Somnio

A 2D tile-based mini-MMORPG. Native macOS player client + Linux Swift server + macOS map editor + admin CLI, all in one SwiftPM workspace.

This is a from-scratch Swift port of an old REALbasic project; the macOS player and editor ship as code-signed `.app` bundles via Sparkle, and the server ships as a Docker image alongside Postgres.

## Status

Foundation only. The workspace builds, tests pass, lint/format is wired, and the wire protocol + sector codec round-trip cleanly. The actual gameplay server, persistence, UI, and packaging are not implemented yet.

## Build & Run

```
swift build
swift test
```

Run individual targets:

```
swift run SomnioApp        # player client (macOS)
swift run SomnioEditor     # map editor (macOS)
swift run SomnioServer     # gameplay server (cross-platform)
swift run SomnioCLI        # admin CLI (cross-platform)
```

The integration test suite is a sibling SwiftPM package and skips automatically when no live database is configured:

```
swift test --package-path IntegrationTests
```

See [AGENTS.md](AGENTS.md) for the deeper guide — module boundaries, dev/prod isolation, logging, packaging, lint/format, and code conventions.

## License

TBD.
