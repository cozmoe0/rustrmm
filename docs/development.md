# Development guide

## Prerequisites

- Rust (version pinned in `rust-toolchain.toml`), Node.js 22+.
- Optional: zig + `cargo install cargo-zigbuild` (Linux/Windows-GNU cross builds), WSL with
  `msitools wixl` (MSI builds on Windows), Docker (image builds).

## Run everything locally

```bash
# Server (creates ./data and prints a one-time setup token)
cargo run -p rustrmm-server -- --data-dir ./data --dev --agent-dist ./dist/agents

# Console with hot reload (proxies /api to https://localhost:8443)
cd web && npm install && npm run dev
```

Open <http://localhost:5173>, enter the setup token, finish the wizard and enroll an
authenticator app.

### Run an agent without installing it

Create a deploy key in **Devices → Deploy agents** (or `POST /api/v1/sites/{id}/enrollment-tokens`),
then:

```bash
cargo run -p rustrmm-agent -- enroll --data-dir ./agent-dev --key rrmm1_…
cargo run -p rustrmm-agent -- run --console --data-dir ./agent-dev
cargo run -p rustrmm-agent -- collect hardware   # print one inventory section
```

`--data-dir` keeps identity and logs in a local folder, so no administrator rights are needed.

### Simulated fleet

```bash
cargo run -p rustrmm-sim -- --key rrmm1_… --devices 50
```

Identities persist in `./sim-state`; about 10 % of devices stay offline, a few run hot or have
security issues, so dashboards look realistic. Use `--devices 1000` for load testing.

## Build release artifacts

```bash
cargo xtask dist      # dist/agents/{windows-x86_64,linux-x86_64,linux-aarch64}/… + manifest.json (signed when configured)
cargo xtask server    # web console + release server binary with the console embedded
cargo xtask check     # fmt, clippy -D warnings, tests, web typecheck/lint/test
```

`xtask dist` builds the Windows agent natively, the Linux agents with cargo-zigbuild and the MSI
with wixl inside WSL (`packaging/windows/build-msi.sh`). The server imports and signs the bundle
at startup when it finds a new version in `RUSTRMM_AGENT_DIST`.

## Tests

```bash
cargo test --workspace          # unit + integration (API flow, agent gateway over a real socket)
cd web && npm run test          # Vitest
```

The integration tests start the real router in-process: first-run setup, mandatory MFA,
CSRF/Origin rejection, client scoping, step-up, audit chain verification, encrypted backup +
decrypt, enrollment, the mutual-auth handshake, inventory ingestion and refusal of
pending/revoked/forged devices.

## Hardening tests and fuzzing

```bash
cargo test -p rustrmm-server --test authz_matrix      # every route × every role (≈2 min in debug)
AUTHZ_DISCOVER=1 cargo test -p rustrmm-server --test authz_matrix authorization_matrix -- --nocapture
cargo test -p rustrmm-server --test hardening         # headers, rate limits, signing status, webhooks
cargo test -p rustrmm-server --test noise_channel     # Noise IK handshake, tunnels, rekey, pinning
cargo test -p rustrmm-fuzzing                         # stable smoke run of every fuzz target
```

A new `/api/v1` route fails `authz_matrix` until it has a row in its `MATRIX` table (and, when it
needs step-up or must refuse API tokens, in `STEP_UP` / `SESSION_ONLY`). `AUTHZ_DISCOVER=1`
prints what each role actually gets.

Real fuzzing needs nightly and cargo-fuzz:

```bash
cargo install cargo-fuzz
cargo test -p rustrmm-fuzzing -- --ignored write_seed_corpus   # optional seed corpus in fuzz/corpus
cargo +nightly fuzz run frame_decode -- -max_total_time=600
cargo +nightly fuzz list                                      # all targets
```

## Code signing

Optional; see `docs/signing.md`. Copy `signing.toml.example` to `signing.toml` (git-ignored) or
set `RUSTRMM_SIGN_*` variables, then `cargo xtask dist` signs the Windows exe before the MSI is
built, the MSI after, and (with minisign configured) the Linux agents.

## API documentation and console types

The server serves its OpenAPI document at `/api/openapi.json` and a documentation page at
`/api/docs`. Generate the console's TypeScript types from a running dev server:

```bash
npx openapi-typescript https://localhost:8443/api/openapi.json -o web/src/api/schema.d.ts
```

New handlers should carry a `#[utoipa::path(...)]` annotation and be listed in
`crates/server/src/openapi_routes.rs`; routes without one still appear (method, path, tag,
summary) because the document also reads the router. `cargo test -p rustrmm-server openapi`
checks that the document parses and lists every route.

## Project layout

See the README; the approved architecture lives in `docs/architecture.md` and the security model in
`docs/security.md`.
