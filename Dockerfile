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
# The root `prepare` script runs on `npm ci`; the hook installer it names exits at once here,
# but it has to exist.
COPY .husky/install.mjs .husky/
# argon2 resolves a musl prebuild, so this stage needs no build toolchain.
RUN npm ci --omit=dev --no-audit --no-fund --workspace packages/server

# The world ships inside the image: the committed fixtures are the live sectors, so the server
# and the world it serves are always from one commit and no deployment has to carry sector files
# alongside the image tag. The build-arg is a path from the repo root, overridable for a build
# that should carry a different world; the repo-root `sectors/` staging directory cannot be
# named here, since `.dockerignore` keeps it out of the build context. A separate stage so the
# guard's failure names the arg rather than surfacing as an empty runtime directory.
FROM node:24-alpine AS sectors
ARG SOMNIO_SECTORS_SOURCE=packages/core/fixtures/sectors
# Guarded before the COPY: an empty value would make its source `/`, the whole build context.
RUN test -n "${SOMNIO_SECTORS_SOURCE}" \
        || (echo "ERROR: SOMNIO_SECTORS_SOURCE must name a directory of .somnio-sector files" >&2; exit 1)
COPY ${SOMNIO_SECTORS_SOURCE}/ /staged/
# The server refuses to boot on an empty sector directory (`noSectorsLoaded`); fail the build
# instead of the first start.
RUN ls /staged/*.somnio-sector > /dev/null 2>&1 \
        || (echo "ERROR: SOMNIO_SECTORS_SOURCE=${SOMNIO_SECTORS_SOURCE} holds no .somnio-sector files" >&2; exit 1)

FROM node:24-alpine

# Required: caller must pass `--build-arg BUILD_VERSION=<id>` (CI passes the commit's short
# sha). There's no sensible default — shipping an image that reports a fabricated version
# through the admin `version` verb is worse than failing the build.
ARG BUILD_VERSION
RUN test -n "${BUILD_VERSION}" \
        || (echo "ERROR: --build-arg BUILD_VERSION=<id> is required" >&2; exit 1)
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

# The baked world; `SOMNIO_SECTORS_DIR` below points at it, and an operator who wants a
# different world overrides that variable and mounts theirs.
COPY --from=sectors /staged/ /opt/somnio/sectors/
RUN mkdir -p /opt/somnio/logs

# Run as a dedicated non-root user. The server speaks plain HTTP/WS to a reverse proxy,
# never binds privileged ports, and only reads its baked sectors; `logs/` is the one directory it
# writes.
RUN addgroup -S -g 1001 somnio && adduser -S -u 1001 -G somnio -H somnio \
    && chown -R somnio:somnio /opt/somnio
USER somnio

EXPOSE 8080
# No SOMNIO_DEV_DEFAULTS: the image refuses to boot without an admin token and a database URL.
ENV NODE_ENV=production \
    SOMNIO_HTTP_HOST=0.0.0.0 \
    SOMNIO_HTTP_PORT=8080 \
    SOMNIO_SECTORS_DIR=/opt/somnio/sectors \
    SOMNIO_SERVER_VERSION=${BUILD_VERSION}

CMD ["node", "packages/server/src/main.ts"]
