# syntax=docker/dockerfile:1.7

# Build stage: compile the gameplay server against the official Swift Linux image. The
# Argon2 password hasher pulls in libargon2 via the CArgon2 system-library shim, so the
# build stage installs the headers + pkg-config and the runtime stage carries the shared
# lib next to the binary.
FROM swift:6.2-jammy AS build

# Required: caller must pass `--build-arg MARKETING_VERSION=<x.y.z>`. There's no
# sensible default — shipping an image that reports a fabricated version through the
# admin `version` verb is worse than failing the build.
ARG MARKETING_VERSION
# Optional path-from-repo-root used by local smoke builds, e.g.
# `--build-arg SOMNIO_SECTORS_SOURCE=Tests/SomnioMapFixturesTestSupport/MapFixtures`.
# Production builds leave this empty and mount sectors at deploy time.
ARG SOMNIO_SECTORS_SOURCE=

RUN apt-get update \
    && apt-get install -y --no-install-recommends libargon2-dev pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY . .

# `-D NAME=value` discards the value at the Swift command line (active-compilation
# conditions are booleans), so the build-time version is injected by rewriting the
# constant before compilation. Keeps the source path identical to a dev build. The
# `grep` guard fails the image build if `SomnioServerVersion.value`'s `"0.0.0-dev"`
# placeholder ever drifts.
RUN test -n "${MARKETING_VERSION}" \
        || (echo "ERROR: --build-arg MARKETING_VERSION=<x.y.z> is required" >&2; exit 1) \
    && sed -i "s/public static let value: String = \"0.0.0-dev\"/public static let value: String = \"${MARKETING_VERSION}\"/" \
        Sources/SomnioServerCore/Configuration/SomnioServerVersion.swift \
    && grep -q "public static let value: String = \"${MARKETING_VERSION}\"" \
        Sources/SomnioServerCore/Configuration/SomnioServerVersion.swift \
        || (echo "ERROR: version injection failed — placeholder may have drifted" >&2; exit 1)

RUN swift build -c release --product SomnioServer

# Stage sectors into a fixed path so the runtime `COPY` is unconditional. An empty arg
# leaves an empty directory; operators provide the real sector content via a volume
# mount in production.
RUN mkdir -p /tmp/somnio-sectors \
    && if [ -n "$SOMNIO_SECTORS_SOURCE" ]; then \
         cp -R "/src/${SOMNIO_SECTORS_SOURCE}/." /tmp/somnio-sectors/; \
       fi

# Runtime stage: slim image carrying the runtime shared lib for libargon2 plus curl for
# the docker-compose HEALTHCHECK. JSON-stdout logging is wired by the server's logging
# bootstrap, so no extra entrypoint env is needed.
FROM swift:6.2-jammy-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends libargon2-1 curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /src/.build/release/SomnioServer /usr/local/bin/somnio-server
COPY --from=build /tmp/somnio-sectors /opt/somnio/sectors

# Fail the image build if libargon2 isn't reachable; better than first-run discovery.
RUN ldd /usr/local/bin/somnio-server | grep -q libargon2

# Run as a dedicated non-root user. The server speaks plain HTTP/WS to a reverse proxy,
# never binds privileged ports, and reads sectors from a world-readable mount, so
# dropping root carries no runtime surface cost.
RUN useradd --system --no-create-home --uid 1001 somnio
USER somnio

EXPOSE 8080
ENV SOMNIO_HTTP_HOST=0.0.0.0 \
    SOMNIO_HTTP_PORT=8080 \
    SOMNIO_SECTORS_DIR=/opt/somnio/sectors

ENTRYPOINT ["/usr/local/bin/somnio-server"]
