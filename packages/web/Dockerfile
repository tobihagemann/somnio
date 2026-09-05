# syntax=docker/dockerfile:1.7

# Static-serving image for the browser client, published as
# ghcr.io/tobihagemann/somnio-web.
#
# The build context is the **repository root**, not `packages/web/`. That is not an oversight:
# the client is one workspace of the root npm workspace and imports its sibling packages
# (`@somnio/protocol`, `@somnio/core`) through the symlinks npm creates, and the core package
# reads the committed model registry out of the tree — so a context rooted at the package
# cannot resolve any of them.
#
# The context must also contain an `assets/` directory (the operator-supplied pack; empty is
# fine). CI checks the private somnio-assets repo out to that path; a local build without a
# pack runs `mkdir -p assets` first and gets placeholder models, an untextured floor, and
# unstyled panels. `assets/` is gitignored, so creating it is free.
#
# Build with:
#   mkdir -p assets
#   docker build -f packages/web/Dockerfile --build-arg BUILD_VERSION=local .

FROM node:24-bookworm-slim AS build

# Required: caller must pass `--build-arg BUILD_VERSION=<id>` (CI passes the commit's short sha).
# Same reasoning as the server image — an "About" panel reporting a fabricated version is worse
# than a failed build.
ARG BUILD_VERSION
# Path *inside the build context* to the asset pack root. To build without a pack, point it at an
# empty directory; an empty value would copy the whole context.
ARG SOMNIO_ASSET_PACK=assets

WORKDIR /src

# Dependency layer first, so an application-only change does not re-run `npm ci`. npm needs
# every workspace manifest the lockfile links to reconcile it, one `COPY` per package.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/core/package.json packages/core/
COPY packages/web/package.json packages/web/
RUN npm ci --no-audit --no-fund --workspace packages/web

# One `COPY` per package: a multi-source `COPY` merges directory contents. The core package
# carries the committed model registry under its own `data/`.
COPY packages/protocol/ packages/protocol/
COPY packages/core/ packages/core/
COPY packages/web/ packages/web/

# The version reaches the bundle through `vite.config.ts`'s `define`, which reads
# `SOMNIO_WEB_VERSION` at config time — no source rewriting.
#
# The grep is not ceremony: a template literal that reads an *exported* binding is kept as a
# variable by the minifier, the stamp comes out as `somnio-web ${Xh}`, and the page renders fine
# while reporting the wrong version. This guard turns that into a failed build.
#
# Three statements rather than one `||`/`&&` chain. Shell makes the final `||` the fallback for
# *everything* preceding it, so a compile error out of `npm run build` would print only "version
# was not injected into the bundle" and send the operator to investigate the wrong thing.
RUN if [ -z "${BUILD_VERSION}" ]; then \
      echo "ERROR: --build-arg BUILD_VERSION=<id> is required" >&2; \
      exit 1; \
    fi
RUN SOMNIO_WEB_VERSION="${BUILD_VERSION}" npm run build --workspace packages/web
RUN if ! grep -q "somnio-web ${BUILD_VERSION}" packages/web/dist/bundle/*.js; then \
      echo "ERROR: version was not injected into the bundle" >&2; \
      exit 1; \
    fi

# Compose the served `/assets` root from the pack. Reuses the same script the local build
# loop uses, so the hard/soft failure split (UI required, models and floors warn-only) and the
# external-buffer check are identical in CI and on a developer machine.
COPY Scripts/glb-buffer-uris.mjs Scripts/bundle-web-assets.sh Scripts/
COPY ${SOMNIO_ASSET_PACK}/ assets/
RUN if [ -n "$(ls -A assets 2>/dev/null)" ]; then \
      SOMNIO_ASSET_SOURCE=/src/assets \
      SOMNIO_WEB_ASSET_DEST=/src/packages/web/dist/assets \
        bash Scripts/bundle-web-assets.sh; \
    else \
      echo "WARN: asset pack is empty; serving placeholders and unstyled panels."; \
    fi

# Runtime stage: unprivileged nginx. The upstream `nginx:alpine` runs its master process as
# root and listens on 80; this variant runs as uid 101 on 8080, which is what lets the
# container drop root without a writable-cache workaround.
FROM nginxinc/nginx-unprivileged:1.29-alpine

COPY packages/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY packages/web/nginx-security-headers.conf /etc/nginx/somnio-security-headers.conf
COPY --from=build /src/packages/web/dist /usr/share/nginx/html

# Useful when a deployed image has to be identified from the running container alone.
ARG BUILD_VERSION
ENV SOMNIO_WEB_VERSION=${BUILD_VERSION}

EXPOSE 8080

# Static files only, so a 200 on the entry document is the whole readiness question. The image
# carries BusyBox rather than curl, so this uses wget.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget --quiet --spider http://127.0.0.1:8080/ || exit 1
