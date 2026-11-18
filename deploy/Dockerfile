# syntax=docker/dockerfile:1.7
#
# RustRMM server image with the agent bundle (Windows exe + MSI, Linux x86-64/ARM64) built in.
#
#   docker compose -f deploy/docker-compose.yml build
#   docker buildx build --platform linux/amd64,linux/arm64 -f deploy/Dockerfile -t rustrmm-server .
#
# Every builder stage runs on the build machine's own architecture ($BUILDPLATFORM) and
# cross-compiles, so a multi-arch build compiles the console and each binary exactly once.
# macOS agents need Apple's SDK: build them on a Mac/CI runner and import the bundle later.

ARG RUST_VERSION=1.98
ARG NODE_VERSION=24
ARG ZIG_VERSION=0.15.2

# ---------------------------------------------------------------- web console
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---------------------------------------------------------------- rust toolchain (zig for cross builds)
FROM --platform=$BUILDPLATFORM rust:${RUST_VERSION}-bookworm AS rust-base
ARG ZIG_VERSION
RUN apt-get update \
 && apt-get install -y --no-install-recommends xz-utils ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && arch="$(uname -m)" \
 && curl -fsSL "https://ziglang.org/download/${ZIG_VERSION}/zig-${arch}-linux-${ZIG_VERSION}.tar.xz" -o /tmp/zig.tar.xz \
 && mkdir -p /opt/zig && tar -xJf /tmp/zig.tar.xz -C /opt/zig --strip-components=1 && rm /tmp/zig.tar.xz \
 && ln -s /opt/zig/zig /usr/local/bin/zig \
 && cargo install --locked cargo-zigbuild
WORKDIR /src
# rust-toolchain.toml pins the toolchain by channel ("1.98"), which rustup treats as a different
# toolchain from the base image's ("1.98.1"). Install the pinned one with the cross targets here,
# inside /src, so cargo uses it instead of downloading a bare toolchain without them.
COPY rust-toolchain.toml ./
RUN rustup toolchain install \
 && rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl x86_64-pc-windows-gnu \
 && rustup show active-toolchain \
 && rustup target list --installed
COPY Cargo.toml Cargo.lock ./
COPY .cargo .cargo
COPY crates crates

# ---------------------------------------------------------------- agents (built once)
FROM rust-base AS agents
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target,sharing=locked \
    set -e; \
    for t in x86_64-unknown-linux-musl:linux-x86_64 aarch64-unknown-linux-musl:linux-aarch64; do \
      target="${t%%:*}"; platform="${t##*:}"; \
      cargo zigbuild --release --locked -p rustrmm-agent --target "$target"; \
      mkdir -p "/dist/$platform" && cp "target/$target/release/rustrmm-agent" "/dist/$platform/"; \
    done; \
    cargo zigbuild --release --locked -p rustrmm-agent --target x86_64-pc-windows-gnu; \
    mkdir -p /dist/windows-x86_64 && cp target/x86_64-pc-windows-gnu/release/rustrmm-agent.exe /dist/windows-x86_64/

# ---------------------------------------------------------------- Windows MSI (wixl) + bundle manifest
# Optional Authenticode signing (docs/signing.md): pass the PFX as BuildKit secrets
#   --secret id=signing_pfx_b64,env=RUSTRMM_SIGN_PFX_BASE64 --secret id=signing_pfx_password,env=RUSTRMM_SIGN_PFX_PASSWORD
# The exe is signed before wixl packs it, the MSI last. Without the secrets both stay unsigned.
FROM --platform=$BUILDPLATFORM debian:trixie-slim AS bundle
RUN apt-get update && apt-get install -y --no-install-recommends msitools wixl osslsigncode ca-certificates && rm -rf /var/lib/apt/lists/*
COPY packaging /packaging
COPY Cargo.toml /src/Cargo.toml
COPY --from=agents /dist /dist
RUN --mount=type=secret,id=signing_pfx_b64 --mount=type=secret,id=signing_pfx_password \
    version="$(tr -d '\r' < /src/Cargo.toml | sed -n 's/^version = "\(.*\)"/\1/p' | head -1)" \
 && sh /packaging/windows/sign.sh /dist/windows-x86_64/rustrmm-agent.exe \
 && bash /packaging/windows/build-msi.sh /dist/windows-x86_64/rustrmm-agent.exe "$version" /dist/windows-x86_64/RustRMMAgent-x64.msi \
 && sh /packaging/windows/sign.sh /dist/windows-x86_64/RustRMMAgent-x64.msi \
 && sh /packaging/make-manifest.sh /dist "$version"

# The bundle alone (release workflow: --target bundle-export --output type=local,dest=…).
FROM scratch AS bundle-export
COPY --from=bundle /dist /

# ---------------------------------------------------------------- server binary
FROM rust-base AS server
ARG TARGETPLATFORM
COPY --from=web /src/web/dist web/dist
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target,sharing=locked \
    case "${TARGETPLATFORM:-linux/amd64}" in \
      linux/amd64) target=x86_64-unknown-linux-musl ;; \
      linux/arm64) target=aarch64-unknown-linux-musl ;; \
      *) echo "unsupported platform ${TARGETPLATFORM}" >&2; exit 1 ;; \
    esac \
 && cargo zigbuild --release --locked -p rustrmm-server --target "$target" \
 && mkdir -p /out/data /out/backups \
 && cp "target/$target/release/rustrmm-server" /out/rustrmm-server

# ---------------------------------------------------------------- runtime
FROM gcr.io/distroless/static-debian12:nonroot
LABEL org.opencontainers.image.title="RustRMM server" \
      org.opencontainers.image.description="Self-hosted remote monitoring and management: web console, API and agent gateway"
COPY --from=server /out/rustrmm-server /app/rustrmm-server
COPY --from=bundle /dist /app/agents
# Pre-create volume mount points owned by the nonroot user so fresh named volumes are writable.
COPY --from=server --chown=65532:65532 /out/data /data
COPY --from=server --chown=65532:65532 /out/backups /backups
ENV RUSTRMM_DATA_DIR=/data \
    RUSTRMM_BACKUP_DIR=/backups \
    RUSTRMM_AGENT_DIST=/app/agents \
    RUSTRMM_LOG_FORMAT=json \
    RUSTRMM_CONSOLE_BIND=0.0.0.0:8443 \
    RUSTRMM_AGENT_BIND=0.0.0.0:8444
VOLUME ["/data", "/backups"]
EXPOSE 8443 8444 8080
USER 65532:65532
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["/app/rustrmm-server", "healthcheck"]
ENTRYPOINT ["/app/rustrmm-server"]
