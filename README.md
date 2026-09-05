# Somnio

A 2D tile-based mini-MMORPG. A TypeScript gameplay server, an admin CLI, and a Three.js browser client in one npm workspace, plus a localhost web map editor.

This is a from-scratch port of an old REALbasic project. The server and the browser client each ship as a Docker image; the server runs alongside Postgres.

## Build & Run

Node 24.17.0 or newer (`.nvmrc`). Nothing is compiled — Node runs the TypeScript sources directly.

```
npm ci
npm test                                  # every package's unit suite; no container
npm run lint && npm run typecheck
```

Run the components against a local Postgres (see `Skills/somnio-server/SKILL.md` for the dev container):

```
SOMNIO_DEV_DEFAULTS=1 node packages/server/src/main.ts   # gameplay server against the somnio-pg dev container
node packages/cli/src/main.ts players     # admin CLI against the dev server
npm run dev --workspace packages/web      # browser client (Vite on :17669, proxies /ws to the local server)
npm run editor --workspace packages/web   # web map editor (authors .somnio-sector files)
```

The integration suites start a throwaway Postgres per file through testcontainers and need Docker or Podman:

```
npm run test:integration
```

See [AGENTS.md](AGENTS.md) for the deeper guide — package boundaries, wire protocol, sector format, deployment, lint/format, and code conventions.

## License

Distributed under the GNU Affero General Public License v3.0. See the [LICENSE](LICENSE) file for details.

The license covers the source code in this repository. The game's art assets are separately licensed, are not included here, and are bundled only into the published web image.
