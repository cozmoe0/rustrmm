# RustRMM

Self-hosted, security-first remote monitoring and management (RMM) for MSPs and IT teams —
written in Rust, with a React + TypeScript web console.

> **Status:** Phases 1–3 — server core, authentication, RBAC, audit, backups, the web console,
> Windows/Linux/macOS agents with deep inventory and live metrics, MSI + Group Policy deployment,
> signed commands and remote self-update. See [docs/roadmap.md](docs/roadmap.md).

## Highlights

- **One server binary / one container** serving the console, REST API and agent gateway.
- **Two listeners** by default: the agent gateway (`:8444`) can face the internet while the
  console/API (`:8443`) stays on the LAN or VPN.
- **Mandatory MFA** (authenticator apps, passkeys, recovery codes), step-up re-authentication for
  destructive actions, `__Host-` session cookies, CSRF + Origin checks, strict CSP.
- **MSP tenancy**: clients → sites → devices, with roles scoped globally, per client or per site.
- **Tamper-evident audit log** (hash chain + append-only triggers) with integrity verification.
- **Automatic encrypted backups** (`VACUUM INTO` snapshot → tar → zstd → age) to local disk and
  S3-compatible storage with grandfather-father-son retention and a pre-migration safety backup.
  The server holds only the backup *public* key — restoring requires your recovery kit.
- **Built-in PKI**: an internal CA issues and renews the server certificate; agents pin it.
- **Cross-platform agent** (one Rust binary): Windows service, systemd/OpenRC, launchd. Nine
  inventory sections (system, hardware, storage, network, software, security, users, services,
  updates), live metrics, health score and a device timeline built from inventory diffs.
- **Silent deployment**: per-site deploy keys, a generic MSI that finds `deploy.key` next to itself
  (works with GPO Software Installation, no transforms), a GPO bundle with a startup script,
  PowerShell and shell one-liners with a pinned TLS bootstrap, and an approval queue.
- **Signed commands and remote updates**: every command is an Ed25519 envelope bound to the
  device, connection, sequence number and expiry; staged rollouts with auto-pause; the updater
  swaps the binary and rolls back automatically if the new version fails to reconnect.
- **Code signing optional**: nothing needs a certificate; update integrity uses RustRMM's own keys.

## Quick start (development, Windows/macOS/Linux)

Requirements: Rust (see `rust-toolchain.toml`), Node.js 22+.

```bash
# 1. Start the server (creates ./data, prints a one-time setup token)
cargo run -p rustrmm-server -- --data-dir ./data --dev

# 2. In another terminal, run the console with hot reload (proxies /api to https://localhost:8443)
cd web && npm install && npm run dev
```

Open <http://localhost:5173>, enter the setup token from the server output, and complete the
wizard. Save the recovery kit — it contains the master key and the backup decryption key.

To try the console without a backend: `cd web && npm run dev:mock`.

Add agents from **Devices → Deploy agents**, or run one in the foreground without installing it
and simulate a fleet — see [docs/development.md](docs/development.md).

## Deploy with Docker Compose

```bash
cd deploy
cp .env.example .env        # set RUSTRMM_CONSOLE_URL and RUSTRMM_AGENT_URL
docker compose up -d --build
docker compose logs rustrmm # one-time setup token
```

Works on Linux hosts and on Windows with Docker Desktop (WSL2). See
[docs/deployment.md](docs/deployment.md) (Docker, native, TLS modes, exposure, firewall),
[docs/hardening.md](docs/hardening.md) (operator checklist), [docs/backup-restore.md](docs/backup-restore.md),
[docs/gpo.md](docs/gpo.md) (Group Policy) and [docs/signing.md](docs/signing.md).

## Repository layout

| Path | Contents |
|---|---|
| `crates/server` | axum server: API, auth, RBAC, audit, backups, PKI, agent gateway, releases, embedded console |
| `crates/agent` | endpoint agent: service, collectors, metrics, signed-command executor, self-updater |
| `crates/proto` | agent wire protocol: frames, handshake, deploy keys, signed commands, release manifests |
| `crates/crypto` | master key, field encryption, signing keys, internal CA |
| `crates/common` | ids, time, logging |
| `crates/sim` | simulated fleet speaking the real protocol (dashboards, load tests) |
| `crates/xtask` | `cargo xtask web|server|dist|sign|check` build automation (optional code signing) |
| `crates/fuzzing` | fuzz target bodies, exercised by stable tests; `fuzz/` holds the cargo-fuzz crate |
| `web/` | React 19 + TypeScript + Tailwind v4 + shadcn/ui console |
| `packaging/` | MSI definition (wixl), manifest script, Authenticode signing script |
| `deploy/` | Dockerfile (server + agent bundle), docker-compose.yml |
| `spikes/` | Phase 0 risk spikes and their findings |
| `docs/` | architecture, security model, API contracts, deployment/hardening/backup/GPO/signing guides, roadmap |

## Checks

```bash
cargo xtask check   # fmt, clippy -D warnings, tests, web typecheck/lint/test
```

## Acknowledgements

The agent's remote desktop JPEG encoder (the `jpeg-encoder` crate) is based in part on the work of
the Independent JPEG Group. Third-party licences are checked with `cargo deny` (`deny.toml`) and
listed in the CycloneDX SBOMs attached to each release.
