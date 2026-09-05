# syntax=docker/dockerfile:1.7

# Gameplay server image, published as ghcr.io/tobihagemann/somnio-server. Node 24 runs the
# TypeScript sources directly (type stripping), so there is no build step — only the
# production dependency install.

FROM node:24-alpine AS deps

WORKDIR /opt/somnio

# The root manifests plus every workspace manifest at its workspace path: npm needs all of them
# to reconcile the lockfile, and `--workspace packages/server` then installs only the server's
# closure. The `@somnio/*` entries land as the relative symlinks npm creates under
# `node_modules/@somnio/`, which is what Node's type stripping requires — it never strips
# types under a real `node_modules` directory, so `--install-links` (which would copy the
# packages in) must never be added here.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/core/package.json packages/core/
COPY packages/data/package.json packages/data/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
COPY packages/web/package.json packages/web/
# argon2 resolves a musl prebuild, so this stage needs no build toolchain.
RUN npm ci --omit=dev --no-audit --no-fund --workspace packages/server

# Sector staging for local smoke builds, in its own stage so the build context never lands in a
# runtime layer: a `COPY` into the final stage is retained in the image even after a later `rm`.
# Optional path-from-repo-root, e.g. `--build-arg SOMNIO_SECTORS_SOURCE=packages/core/fixtures/sectors`.
# The repo-root `sectors/` staging directory cannot be named here: `.dockerignore` keeps it out
# of the build context (it is the compose volume, mounted at deploy time, not baked in).
# Production builds leave this empty and mount sectors at deploy time.
FROM node:24-alpine AS sectors
ARG SOMNIO_SECTORS_SOURCE=
COPY . /context
# `if`/`fi` rather than an `||` chain because more commands follow in this `RUN`: an `exit`
# inside a `(...)` fallback leaves only the subshell, and the layer would go on.
RUN mkdir -p /staged; \
    if [ -n "$SOMNIO_SECTORS_SOURCE" ] && [ ! -d "/context/${SOMNIO_SECTORS_SOURCE}" ]; then \
      echo "ERROR: SOMNIO_SECTORS_SOURCE=${SOMNIO_SECTORS_SOURCE} is not in the build context (see .dockerignore)" >&2; \
      exit 1; \
    fi; \
    if [ -n "$SOMNIO_SECTORS_SOURCE" ]; then cp -R "/context/${SOMNIO_SECTORS_SOURCE}/." /staged/; fi

FROM node:24-alpine

# Required: caller must pass `--build-arg MARKETING_VERSION=<x.y.z>`. There's no
# sensible default — shipping an image that reports a fabricated version through the
# admin `version` verb is worse than failing the build.
ARG MARKETING_VERSION
RUN test -n "${MARKETING_VERSION}" \
        || (echo "ERROR: --build-arg MARKETING_VERSION=<x.y.z> is required" >&2; exit 1)
# curl for the docker-compose HEALTHCHECK.
RUN apk add --no-cache curl

WORKDIR /opt/somnio

# The whole install tree, so the `node_modules/@somnio/*` symlinks keep resolving into
# `packages/*`, then the sources over their manifests. One `COPY` per package: a multi-source
# `COPY` merges directory contents.
COPY --from=deps /opt/somnio /opt/somnio
COPY packages/protocol/ packages/protocol/
COPY packages/core/ packages/core/
COPY packages/data/ packages/data/
COPY packages/server/ packages/server/

# Sectors at a fixed path so the runtime layout is unconditional: empty unless the build staged
# some; operators provide the real sector content via a volume mount in production.
COPY --from=sectors /staged/ /opt/somnio/sectors/
RUN mkdir -p /opt/somnio/logs

# Run as a dedicated non-root user. The server speaks plain HTTP/WS to a reverse proxy,
# never binds privileged ports, and reads sectors from a world-readable mount; `logs/` is the
# one directory it writes.
RUN addgroup -S -g 1001 somnio && adduser -S -u 1001 -G somnio -H somnio \
    && chown -R somnio:somnio /opt/somnio
USER somnio

EXPOSE 8080
# No SOMNIO_DEV_DEFAULTS: the image refuses to boot without an admin token and a database URL.
ENV NODE_ENV=production \
    SOMNIO_HTTP_HOST=0.0.0.0 \
    SOMNIO_HTTP_PORT=8080 \
    SOMNIO_SECTORS_DIR=/opt/somnio/sectors \
    SOMNIO_SERVER_VERSION=${MARKETING_VERSION}

CMD ["node", "packages/server/src/main.ts"]
