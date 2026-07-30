# syntax=docker/dockerfile:1.7

# Static-serving image for the browser client, published as
# ghcr.io/tobihagemann/somnio-web.
#
# The build context is the **repository root**, not `Web/`. That is not an oversight: the
# client reads four files straight out of the Swift tree through Vite aliases — the model
# registry and the three `.xcstrings` catalogs — so a context rooted at `Web/` cannot resolve
# them and the build fails at transform time. The `COPY` lines below mirror those alias paths
# exactly; adding a new alias above `Web/` means adding a `COPY` here.
#
# The context must also contain an `assets/` directory (the operator-supplied pack; empty is
# fine). CI checks the private somnio-assets repo out to that path; a local build without a
# pack runs `mkdir -p assets` first and gets placeholder models, an untextured floor, and
# unstyled panels. `assets/` is gitignored, so creating it is free.
#
# Build with:
#   mkdir -p assets
#   docker build -f Web/Dockerfile --build-arg MARKETING_VERSION=0.1.0 .

FROM node:24-bookworm-slim AS build

# Required: caller must pass `--build-arg MARKETING_VERSION=<x.y.z>`. Same reasoning as the
# server image — an "About" panel reporting a fabricated version is worse than a failed build.
ARG MARKETING_VERSION
# Path *inside the build context* to the asset pack root. Empty skips the pack entirely.
ARG SOMNIO_ASSET_PACK=assets

WORKDIR /src/Web

# Dependency layer first, so an application-only change does not re-run `npm ci`.
COPY Web/package.json Web/package-lock.json ./
RUN npm ci --no-audit --no-fund

# The Swift-tree files the Vite aliases resolve, at the paths the aliases expect
# (`../Sources/...` relative to the web root) — which is why the web app lives in `/src/Web`.
COPY Sources/SomnioCore/Resources/ModelRegistry.json /src/Sources/SomnioCore/Resources/
COPY Sources/SomnioCore/Resources/Localizable.xcstrings /src/Sources/SomnioCore/Resources/
COPY Sources/SomnioUI/Resources/Localizable.xcstrings /src/Sources/SomnioUI/Resources/
COPY Sources/SomnioApp/Resources/Localizable.xcstrings /src/Sources/SomnioApp/Resources/
COPY Web/ ./

# The version reaches the bundle through `vite.config.ts`'s `define`, which reads
# `SOMNIO_WEB_VERSION` at config time — no source rewriting, unlike the server image's `sed` of a
# Swift constant (`-D NAME=value` cannot carry a value).
#
# The grep is not ceremony. An earlier revision built a bundle whose stamp came out as
# `somnio-web ${Xh}` — the define applied, but the template literal read an *exported* binding, so
# the minifier kept it as a variable and no version string reached the output. The page rendered
# fine and reported the wrong version. This guard is what turns that into a failed build.
#
# Three statements rather than one `||`/`&&` chain. Shell associates such a chain so that the final
# `||` is the fallback for *everything* preceding it, so a genuine compile error out of `npm run
# build` aborted printing only "version was not injected into the bundle" — sending whoever was
# cutting a release to investigate the version stamp. Every branch failed closed either way; the
# defect was purely in which message the operator read.
RUN if [ -z "${MARKETING_VERSION}" ]; then \
      echo "ERROR: --build-arg MARKETING_VERSION=<x.y.z> is required" >&2; \
      exit 1; \
    fi
RUN SOMNIO_WEB_VERSION="${MARKETING_VERSION}" npm run build
RUN if ! grep -q "somnio-web ${MARKETING_VERSION}" dist/bundle/*.js; then \
      echo "ERROR: version was not injected into the bundle" >&2; \
      exit 1; \
    fi

# Compose the served `/assets` root from the pack. Reuses the same script the local build
# loop uses, so the hard/soft failure split (UI required, models and floors warn-only) and the
# external-buffer check are identical in CI and on a developer machine.
COPY Scripts/glb-buffer-uris.mjs Scripts/bundle-web-assets.sh /src/Scripts/
COPY ${SOMNIO_ASSET_PACK}/ /src/assets/
RUN if [ -n "$(ls -A /src/assets 2>/dev/null)" ]; then \
      SOMNIO_ASSET_SOURCE=/src/assets \
      SOMNIO_WEB_ASSET_DEST=/src/Web/dist/assets \
        bash /src/Scripts/bundle-web-assets.sh; \
    else \
      echo "WARN: asset pack is empty; serving placeholders and unstyled panels."; \
    fi

# Runtime stage: unprivileged nginx. The upstream `nginx:alpine` runs its master process as
# root and listens on 80; this variant runs as uid 101 on 8080, which is what lets the
# container drop root without a writable-cache workaround.
FROM nginxinc/nginx-unprivileged:1.29-alpine

COPY Web/nginx.conf /etc/nginx/conf.d/default.conf
COPY Web/nginx-security-headers.conf /etc/nginx/somnio-security-headers.conf
COPY --from=build /src/Web/dist /usr/share/nginx/html

# Useful when a deployed tag has to be identified from the running container alone.
ARG MARKETING_VERSION
ENV SOMNIO_WEB_VERSION=${MARKETING_VERSION}

EXPOSE 8080

# Static files only, so a 200 on the entry document is the whole readiness question. The image
# carries BusyBox rather than curl, so this uses wget.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget --quiet --spider http://127.0.0.1:8080/ || exit 1
