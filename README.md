<div align="center">

<img src="docs/assets/banner.svg" alt="RustRMM — every endpoint, every client, one calm console" width="100%">

<br>
<br>

**Self-hosted remote monitoring and management for MSPs and IT teams.**<br>
Monitor, control, automate, patch and support Windows, macOS and Linux endpoints from one console,<br>
served by a single Rust binary you run on your own hardware.

<br>

[![Rust 1.98](https://img.shields.io/badge/Rust-1.98-E07444?style=flat-square&logo=rust&logoColor=white)](rust-toolchain.toml)
[![React 19](https://img.shields.io/badge/React-19-3FC1B0?style=flat-square&logo=react&logoColor=white)](web/package.json)
[![Platforms](https://img.shields.io/badge/agents-Windows%20·%20macOS%20·%20Linux-2B3138?style=flat-square)](#deploy-agents)
[![Database](https://img.shields.io/badge/storage-SQLite%20%2B%20encrypted%20backups-2B3138?style=flat-square&logo=sqlite&logoColor=white)](docs/backup-restore.md)
[![Deploy](https://img.shields.io/badge/deploy-Docker%20or%20native-2B3138?style=flat-square&logo=docker&logoColor=white)](docs/deployment.md)
[![OpenAPI 3.1](https://img.shields.io/badge/API-OpenAPI%203.1-2B3138?style=flat-square&logo=openapiinitiative&logoColor=white)](docs/api-platform.md)

<br>

[**Features**](#features) &nbsp;·&nbsp;
[**Screenshots**](#a-tour-of-the-console) &nbsp;·&nbsp;
[**Quick start**](#quick-start) &nbsp;·&nbsp;
[**Architecture**](#architecture) &nbsp;·&nbsp;
[**Security**](#security-model) &nbsp;·&nbsp;
[**Docs**](#documentation)

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/dashboard-dark.webp">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/screenshots/dashboard-light.webp">
  <img src="docs/assets/screenshots/dashboard-dark.webp" alt="The RustRMM home dashboard: fleet health, alerts by severity, patch compliance, open alerts, offline devices, tickets, operating systems and agent versions" width="100%">
</picture>

<sub>The Home dashboard, shown in your GitHub theme. Every widget can be moved, resized and swapped per user.</sub>

</div>

<br>

## Why RustRMM

<table>
<tr>
<td width="33%" valign="top">

### Built for MSPs

Clients → sites → devices tenancy from day one. Roles are scoped globally, per client or per site,
and every list, report, API token and webhook respects that scope.

</td>
<td width="33%" valign="top">

### Secure by default

Mandatory MFA, step-up for sensitive actions, Ed25519-signed commands, a pinned internal CA, an
end-to-end Noise channel inside TLS, and a tamper-evident audit log.

</td>
<td width="33%" valign="top">

### Yours to run

One binary or one container. SQLite with automatic encrypted backups to disk and S3. No cloud
account, no telemetry, no per-device licence server.

</td>
</tr>
</table>

<div align="center">

| **11** feature modules | **49** built-in scripts | **18** monitoring check types | **353** API routes in the authorization matrix | **865** automated tests |
|:---:|:---:|:---:|:---:|:---:|

</div>

## Features

<table>
<tr>
<td width="50%" valign="top">

**Endpoints and inventory**
- One agent binary for Windows (service), macOS (launchd) and Linux (systemd / OpenRC)
- Nine inventory sections: system, hardware, storage, network, software, security, users,
  services and updates
- Live metrics, a 0–100 health score and a device timeline built from inventory changes

**Remote control**
- Remote desktop with DXGI capture that follows UAC and sign-in screens, X11 on Linux,
  multi-monitor, clipboard, user consent and an on-screen banner
- Remote shell (PowerShell, PowerShell 7, cmd, bash, zsh, sh) with session recording
- File manager, processes, services, event logs, registry, power actions, user messages and
  network diagnostics

**Automation**
- Script library with 49 built-in scripts, variables and encrypted secrets
- Jobs that run now, once or on a cron schedule, and wait for offline devices
- Static and dynamic groups, policy inheritance with visible origins, custom fields
- Mass-action guard and four-eyes approval for fleet-wide changes

**Monitoring and alerts**
- 18 agent and server-side check types, alert inbox with acknowledge / snooze / assign
- Notifications by e-mail, Slack, Microsoft Teams, Discord, ntfy and webhooks
- Maintenance windows and auto-remediation scripts

</td>
<td width="50%" valign="top">

**Patching and software**
- Windows Update through the WUA COM API; apt, dnf, zypper, pacman and apk on Linux;
  macOS report-only
- Approval rules, deployment rings, patch windows and compliance reporting
- Software explorer across the fleet and software deployments

**Helpdesk**
- Tickets with queues, SLAs that pause on hold, contacts and canned responses
- Email-to-ticket over IMAP, time tracking and time reports
- Alerts become tickets in one click; end users raise them from the agent

**Secrets and network**
- BitLocker recovery-key escrow and LAPS-style local admin password rotation, sealed with age
- Network discovery (ICMP, ARP, TCP, mDNS, NetBIOS) from any agent acting as a site probe
- SNMP v1 / v2c / v3 monitoring, traps and a topology view

**Platform**
- PDF / CSV reports with schedules, and per-user drag-and-drop dashboards
- OpenID Connect single sign-on (Entra ID, Google, Okta, Keycloak) with role mapping
- Scoped API tokens, an OpenAPI 3.1 document with interactive docs, HMAC-signed webhooks
- White-label branding, staged agent rollouts with automatic rollback, optional code signing

</td>
</tr>
</table>

## A tour of the console

The console is a React 19 + TypeScript + Tailwind + shadcn/ui application designed around a
**Command Rail**: an icon rail for modules, a live *Fleet Pulse* bar, workspace tabs for the devices
you are working on, and a <kbd>Ctrl</kbd> <kbd>K</kbd> command palette. It ships light and dark
themes and works down to phone width.

> [!TIP]
> Every screenshot below comes from the console's built-in demo mode, so you can click through the
> same screens yourself in about a minute. See [Try the console in demo mode](#1-try-the-console-in-demo-mode).

### Devices and the device cockpit

Filter the whole fleet by client, site, operating system, health, patch state or tag, then open a
device into its cockpit: live telemetry, hardware, software, storage, security posture, patches,
scripts, policies, secrets, tickets, a timeline and every remote tool, one tab away.

<img src="docs/assets/screenshots/devices.webp" alt="Devices list with saved views, filters and health scores" width="100%">

<img src="docs/assets/screenshots/device-cockpit.webp" alt="Device cockpit for a Windows file server with live CPU, memory, disk and network telemetry" width="100%">

### Remote desktop and remote shell

Sessions are relayed through the server, so endpoints never accept inbound connections. The
desktop viewer streams JPEG tiles with dirty-rectangle updates, follows the secure desktop, and
shows the user a banner while you are connected. Shell sessions are recorded for later review.

<table>
<tr>
<td width="50%"><img src="docs/assets/screenshots/remote-desktop.webp" alt="Remote desktop session to a Windows workstation"></td>
<td width="50%"><img src="docs/assets/screenshots/remote-shell.webp" alt="Remote PowerShell session on a domain controller"></td>
</tr>
</table>

### Monitoring, alerts and auto-remediation

Checks run on the agent (services, processes, CPU, memory, disks, event logs, certificates, ports,
HTTP endpoints, antivirus, Windows Update and custom scripts) and on the server (offline devices,
SNMP). Alerts carry their full timeline: the check result, notifications sent and any remediation
script that ran.

<img src="docs/assets/screenshots/alerts.webp" alt="Alert inbox with an alert opened, showing the check result and a remediation timeline" width="100%">

### Automation: scripts, jobs and policies

<table>
<tr>
<td width="50%"><img src="docs/assets/screenshots/scripts.webp" alt="Script library with built-in PowerShell, Bash and Zsh scripts"></td>
<td width="50%"><img src="docs/assets/screenshots/jobs.webp" alt="Job history with progress per device, schedules and approvals"></td>
</tr>
<tr>
<td colspan="2"><img src="docs/assets/screenshots/policies.webp" alt="Policies inherited from installation to client, site, group and device"></td>
</tr>
</table>

### Patching and software

<table>
<tr>
<td width="50%"><img src="docs/assets/screenshots/patching.webp" alt="Patch compliance by client with missing critical updates and failed installs"></td>
<td width="50%"><img src="docs/assets/screenshots/software.webp" alt="Software explorer listing products, versions and device counts across the fleet"></td>
</tr>
</table>

### Helpdesk and network

<table>
<tr>
<td width="50%"><img src="docs/assets/screenshots/ticket.webp" alt="Ticket conversation with SLA timers, internal notes, linked device and contact"></td>
<td width="50%"><img src="docs/assets/screenshots/network.webp" alt="Network overview with discovered assets, SNMP devices, traps and site probes"></td>
</tr>
</table>

### Secrets escrow, reports and audit

<table>
<tr>
<td width="50%"><img src="docs/assets/screenshots/secrets.webp" alt="BitLocker and local admin password escrow coverage with step-up protected reveals"></td>
<td width="50%"><img src="docs/assets/screenshots/report.webp" alt="Executive summary report with KPIs and a health trend chart"></td>
</tr>
<tr>
<td colspan="2"><img src="docs/assets/screenshots/audit-log.webp" alt="Hash-chained audit log with actor, action, target and integrity verification"></td>
</tr>
</table>

### Everywhere you work

<table>
<tr>
<td width="60%" valign="top"><img src="docs/assets/screenshots/command-palette.webp" alt="Command palette searching devices, pages and actions"><br><sub>Jump anywhere with <kbd>Ctrl</kbd> <kbd>K</kbd>.</sub><br><br><img src="docs/assets/screenshots/sign-in.webp" alt="Sign-in page with single sign-on and password plus MFA"><br><sub>Sign-in with SSO buttons, password and mandatory MFA.</sub></td>
<td width="20%" valign="top"><img src="docs/assets/screenshots/mobile-dashboard.webp" alt="Home dashboard on a phone"></td>
<td width="20%" valign="top"><img src="docs/assets/screenshots/mobile-device.webp" alt="Device cockpit on a phone"></td>
</tr>
</table>

## Architecture

<img src="docs/assets/architecture.svg" alt="RustRMM architecture diagram" width="100%">

- **One server, two listeners.** The console and REST API listen on `:8443` and stay on your LAN or
  VPN. The agent gateway on `:8444` is the only port you publish for off-site devices.
- **Agents dial out.** Every agent holds a persistent WebSocket to the gateway: mutual
  authentication with its device key, a pinned CA, and a Noise IK channel inside TLS so even a
  TLS-terminating proxy never sees agent traffic.
- **Everything in one data directory.** SQLite in WAL mode, wrapped keys, the internal PKI and
  uploads live together, and the backup runner snapshots them with `VACUUM INTO`, compresses with
  zstd and encrypts with age before they leave the process.

| Crate / folder | What it is |
|---|---|
| [`crates/server`](crates/server) | axum server: REST API, auth, RBAC, audit, backups, PKI, agent gateway, every feature module, embedded console |
| [`crates/agent`](crates/agent) | Endpoint agent: service, collectors, metrics, checks, remote tools, desktop helper, signed-command executor, self-updater |
| [`crates/proto`](crates/proto) | Wire protocol: frames, handshake, Noise channel, deploy keys, signed command envelopes, release manifests |
| [`crates/crypto`](crates/crypto) | Master key, field encryption, signing keys, internal CA |
| [`crates/sim`](crates/sim) | Simulated fleet that speaks the real protocol, for demos and load tests |
| [`crates/xtask`](crates/xtask) | `cargo xtask` build automation: console, server, agent bundle, signing, checks |
| [`crates/fuzzing`](crates/fuzzing) · [`fuzz/`](fuzz) | Fuzz target bodies (run as stable tests) and the cargo-fuzz crate |
| [`web/`](web) | React 19 + TypeScript + Tailwind v4 + shadcn/ui console, with an MSW-powered demo mode |
| [`packaging/`](packaging) · [`deploy/`](deploy) | MSI definition and signing script · Dockerfile and Compose file |

The full design, including the data model and protocol, is in [docs/architecture.md](docs/architecture.md).

## Security model

<img src="docs/assets/command-flow.svg" alt="Life of a remote command: request, step-up MFA, scope check, guardrails, sign and audit, verify and run" width="100%">

| Layer | Controls |
|---|---|
| **Identity** | Mandatory MFA (TOTP, passkeys, recovery codes) · step-up re-authentication · OIDC SSO with PKCE · `__Host-` cookies, CSRF and Origin checks · strict CSP |
| **Authorization** | RBAC scoped to installation, client or site · API tokens narrowed to a subset of your permissions · an authorization test that calls all 353 routes as every role |
| **Commands** | Ed25519 envelopes bound to device, connection, sequence number and expiry · mass-action guard and four-eyes approval · per-device local policy can disable whole feature groups |
| **Transport** | TLS 1.3 with a pinned internal CA (or your own certificate) · Noise IK end-to-end channel with key pinning and downgrade protection |
| **Data** | Master-key-wrapped private keys and field encryption · secrets sealed with age · hash-chained, append-only audit log · encrypted backups the server itself cannot decrypt |
| **Supply chain** | `cargo deny` (advisories, licences, bans) · `npm audit` · CycloneDX SBOMs · GitHub Actions pinned by commit SHA · fuzzed protocol parsers · optional Authenticode / Apple / minisign signing |

Read [docs/security.md](docs/security.md) for the full model and [docs/hardening.md](docs/hardening.md)
for the operator checklist. To report a vulnerability, see
[docs/security.md#reporting-a-vulnerability](docs/security.md#reporting-a-vulnerability).

## Quick start

Pick the path that matches what you want to do:

| I want to… | Go to | Time |
|---|---|---|
| Click through the console with realistic demo data | [1. Demo mode](#1-try-the-console-in-demo-mode) | 1 minute |
| Run RustRMM for real on Linux or Windows | [2. Docker Compose](#2-deploy-with-docker-compose) | 10 minutes |
| Build from source, develop, or run natively on Windows | [3. Build from source](#3-build-and-run-from-source) | 15 minutes |

### 1. Try the console in demo mode

Demo mode runs the full console against an in-browser mock API (Mock Service Worker) with 55
devices across 8 clients. No Rust toolchain or server needed.

```bash
git clone <your-fork-url> rustrmm
cd rustrmm/web
npm install
npm run dev:mock
```

Open <http://localhost:5173> and sign in with the demo account:

| Email | Password | Authenticator code |
|---|---|---|
| `owner@example.com` | `correct-horse-battery` | `123456` |

> [!NOTE]
> Demo data lives in your browser's local storage. Visit `/login?mock-reset` to start fresh.

### 2. Deploy with Docker Compose

Works on Linux hosts and on Windows with Docker Desktop (WSL 2 engine). The image holds the server
with the console embedded plus an agent bundle (Windows exe + MSI, Linux x86-64 and ARM64), and
runs as an unprivileged user on a read-only root filesystem.

**Step 1 — Configure**

```bash
git clone <your-fork-url> rustrmm
cd rustrmm/deploy
cp .env.example .env
```

Edit `.env` and set at least:

| Variable | Example | Meaning |
|---|---|---|
| `RUSTRMM_CONSOLE_URL` | `https://rmm.example.internal` | Where people open the console |
| `RUSTRMM_AGENT_URL` | `https://agents.example.com:8444` | Where agents reach the gateway |
| `RUSTRMM_TLS_MODE` | `internal` | `internal` CA, `custom` certificate, or `proxy` behind a reverse proxy |

**Step 2 — Start**

```bash
mkdir -p backups && sudo chown 65532:65532 backups   # Linux only
docker compose up -d --build
```

On Windows (PowerShell), use `Copy-Item .env.example .env` in step 1 and skip the `chown`.

**Step 3 — Get the one-time setup token**

```bash
docker compose logs rustrmm
```

**Step 4 — Run the setup wizard** at `RUSTRMM_CONSOLE_URL`:

1. Enter the setup token.
2. Name your organization and create the owner account (12+ character password).
3. Create your first client and site.
4. **Download the recovery kit and store it offline.** It holds the master key and the only key
   that can decrypt your backups.
5. Sign in and enroll an authenticator app or passkey. MFA is mandatory.

> [!IMPORTANT]
> Publish only the agent port (`8444`) to the internet. Keep the console port on your LAN or VPN.
> [docs/deployment.md](docs/deployment.md) covers TLS modes, reverse proxies, firewall rules and a
> hardened master key kept outside the data volume.

**Upgrading** is `git pull && docker compose up -d --build` (or `docker compose pull` for a
published image). The server takes a backup before every database migration.

### 3. Build and run from source

Native development works on Windows, macOS and Linux. The steps below use Windows; the commands
are identical in a POSIX shell.

**Prerequisites**

| Tool | Version | Used for |
|---|---|---|
| [Rust](https://rustup.rs) | 1.98 (pinned in `rust-toolchain.toml`, installed automatically by rustup) | Server, agent, tooling |
| [Node.js](https://nodejs.org) | 22 or newer | Web console |
| Git | any | Cloning |
| *Optional:* WSL with `msitools` | — | Building the Windows MSI (`wixl`) |
| *Optional:* zig + `cargo install cargo-zigbuild` | — | Cross-building Linux agents |

**Step 1 — Clone and start the server**

```powershell
git clone <your-fork-url> rustrmm
cd rustrmm
cargo run -p rustrmm-server -- --data-dir ./data --dev
```

The first start creates `./data`, generates keys and the internal CA, and prints a **setup token**
in a box. `--dev` only allows the Vite dev server's `http://localhost` origin.

**Step 2 — Start the console with hot reload** (second terminal)

```powershell
cd web
npm install
npm run dev
```

Open <http://localhost:5173>. Vite proxies `/api` to `https://localhost:8443`. Complete the setup
wizard as described in [Docker step 4](#2-deploy-with-docker-compose).

**Step 3 — Connect an agent without installing it** (third terminal)

Create a deploy key in **Devices → Deploy agents**, then:

```powershell
cargo run -p rustrmm-agent -- enroll --data-dir ./agent-dev --key rrmm1_...
cargo run -p rustrmm-agent -- run --console --data-dir ./agent-dev
```

`--data-dir` keeps the agent's identity in a local folder, so no administrator rights are needed.
Your machine appears in the console within seconds, with full inventory and live metrics.

**Step 4 — (Optional) Simulate a fleet**

```powershell
cargo run -p rustrmm-sim -- --key rrmm1_... --devices 50
```

The simulator speaks the real protocol. About 10 % of devices stay offline and a few run hot, so
dashboards look realistic. Use `--devices 1000` for load testing.

**Step 5 — Build release artifacts**

```powershell
cargo xtask server   # release server with the console embedded → target/release/rustrmm-server(.exe)
cargo xtask dist     # agent bundle → dist/agents/{windows-x86_64,linux-x86_64,linux-aarch64}/ + signed manifest
```

Point the server at the bundle with `--agent-dist ./dist/agents` (or `RUSTRMM_AGENT_DIST`). It
imports and signs new agent versions at startup and offers them for staged rollout.

To run the server natively as a service, follow [docs/deployment.md § Native install](docs/deployment.md#2-native-install)
(systemd unit with sandboxing on Linux, a scheduled task on Windows).

## Deploy agents

Open **Devices → Deploy agents**, pick a client and site, and RustRMM generates a per-site
**deploy key** and ready-to-paste installers. New devices land in an approval queue unless the
key's enrollment policy approves them automatically.

| Platform | Method | Details |
|---|---|---|
| **Windows** | MSI (silent) | `msiexec /i RustRMMAgent-x64.msi /qn` with `deploy.key` next to the MSI. Installs the `RustRMMAgent` service as LocalSystem. |
| **Windows** | Group Policy | Software Installation or a startup script; no transforms and no secrets on command lines. Step-by-step: [docs/gpo.md](docs/gpo.md). |
| **Windows** | PowerShell one-liner | Downloads the agent over a pinned TLS bootstrap and installs it as a service. |
| **Linux** | Shell one-liner | Static musl binary; registers a systemd or OpenRC service. |
| **macOS** | Shell one-liner | Universal binary; registers a launchd daemon. |

Updates after that are remote: import a new release, roll it out in stages, and the updater swaps
the binary and rolls back automatically if the new version fails to reconnect.

## Configuration

Every option is both a command-line flag and an environment variable (`rustrmm-server --help`).
The most useful ones:

| Variable | Default | Description |
|---|---|---|
| `RUSTRMM_DATA_DIR` | `./data` | Database, keys, PKI and uploads |
| `RUSTRMM_CONSOLE_URL` | `https://localhost:8443` | Public URL of the console (used in links, SSO redirects, CSRF origin checks) |
| `RUSTRMM_AGENT_URL` | console host on port `8444` | URL agents use to reach the gateway |
| `RUSTRMM_CONSOLE_BIND` / `RUSTRMM_AGENT_BIND` | `0.0.0.0:8443` / `0.0.0.0:8444` | Listener addresses |
| `RUSTRMM_SINGLE_LISTENER` | `false` | Serve console and gateway on one port (labs, LAN-only setups) |
| `RUSTRMM_TLS_MODE` | `internal` | `internal` · `custom` (with `RUSTRMM_TLS_CERT` / `RUSTRMM_TLS_KEY`) · `proxy` |
| `RUSTRMM_EXTRA_SANS` | — | Extra host names / IPs for the internal certificate |
| `RUSTRMM_TRUSTED_PROXIES` | — | CIDRs allowed to set `X-Forwarded-For` (proxy mode) |
| `RUSTRMM_AGENT_NOISE` | `auto` (`required` in proxy mode) | Noise IK end-to-end channel for agents |
| `RUSTRMM_MASTER_KEY_FILE` | `<data>/keys/master.key` | Keep the master key outside the data volume |
| `RUSTRMM_BACKUP_DIR` | `<data>/backups` | Local backup destination (S3 is configured in the console) |
| `RUSTRMM_AGENT_DIST` | — | Agent bundle to import and offer for rollout |
| `RUSTRMM_SESSION_IDLE_MINUTES` / `RUSTRMM_SESSION_MAX_HOURS` | `30` / `12` | Console session lifetime |
| `RUSTRMM_LOG_FORMAT` | `pretty` | `pretty` or `json` |

Server subcommands: `serve` (default), `init` (generate a master key and a starter `.env`),
`healthcheck` (container health probe) and `restore` (restore a backup archive).

## Development

```bash
cargo xtask check                 # fmt, clippy -D warnings, Rust tests, web typecheck / lint / test
cargo test --workspace            # unit + integration tests (real router, real agent socket)
cd web && npm run test            # Vitest
```

Focused suites worth knowing:

```bash
cargo test -p rustrmm-server --test authz_matrix    # every route × every role
cargo test -p rustrmm-server --test noise_channel   # Noise handshake, tunnels, rekey, pinning, downgrade
cargo test -p rustrmm-server --test hardening       # security headers, rate limits, signing status
cargo test -p rustrmm-fuzzing                       # stable smoke run of every fuzz target
```

- **API docs:** a running server serves its OpenAPI 3.1 document at `/api/openapi.json` and
  interactive docs at `/api/docs`. The console's generated types are refreshed with
  `npm run gen:api` (see [web/scripts/gen-api.mjs](web/scripts/gen-api.mjs)).
- **Mock mode:** `npm run dev:mock` runs the console against the in-browser mock API; new
  features ship with mock handlers so the UI can be built and reviewed without a backend.
- **Code signing** is optional and never required for updates (RustRMM verifies its own
  Ed25519-signed manifests). To sign installers, copy `signing.toml.example` to `signing.toml`
  and run `cargo xtask dist`; [docs/signing.md](docs/signing.md) covers six providers.

More in [docs/development.md](docs/development.md).

## Documentation

| Guide | What it covers |
|---|---|
| [Deployment](docs/deployment.md) | Docker on Linux and Windows, native installs, TLS modes, reverse proxies, exposure, firewall rules, health checks |
| [Hardening checklist](docs/hardening.md) | Operator checklist: network exposure, secrets, accounts, blast-radius controls, tokens, host |
| [Backup and restore](docs/backup-restore.md) | Encrypted backups, S3 and Object Lock, retention, restoring, recovery kit, key loss |
| [Group Policy deployment](docs/gpo.md) | Software Installation and startup-script options, verification, per-OU feature locks, AV exclusions |
| [Code signing](docs/signing.md) | Self-signed, OV/EV, Azure Trusted Signing, PKCS#11 tokens, Apple notarization, minisign |
| [Security model](docs/security.md) | Trust anchors, enrollment, commands and updates, remote tools, console, RBAC, data at rest |
| [Architecture](docs/architecture.md) | System overview, technology choices, agent, protocol, server, data model, console design |
| [Development](docs/development.md) | Local setup, agents without installing, simulator, release builds, tests, fuzzing |
| [Roadmap](docs/roadmap.md) | Status of every phase and the verifications still to do |

<details>
<summary><b>API contracts by module</b></summary>
<br>

| Contract | Module |
|---|---|
| [api-remote.md](docs/api-remote.md) | Tunnels, remote shell, files, processes, services, event logs, registry, power, diagnostics |
| [api-automation.md](docs/api-automation.md) | Scripts, variables, jobs, custom fields, groups, policies, approvals |
| [api-monitoring.md](docs/api-monitoring.md) | Checks, alerts, notification channels, maintenance windows, remediation |
| [api-patching.md](docs/api-patching.md) | Patch scans, approvals, rings, windows, software inventory and deployments |
| [api-desktop.md](docs/api-desktop.md) | Remote desktop sessions, capture, input, clipboard, consent |
| [api-tickets.md](docs/api-tickets.md) | Tickets, SLAs, contacts, email-to-ticket, time entries |
| [api-escrow-network.md](docs/api-escrow-network.md) | BitLocker / LAPS escrow, discovery scans, SNMP |
| [api-platform.md](docs/api-platform.md) | Reports, dashboards, SSO, API tokens, webhooks, branding, Noise channel, signing |

</details>

## Project status

All eleven planned phases are built and verified end to end on Windows: every Rust and web test
passes, `cargo deny` and `npm audit` are clean, and each phase was exercised live against a real
agent. A few checks need hardware, accounts or elevation that the development machine did not
have, such as an elevated MSI install with self-update rollback, a Group Policy rollout in a lab
domain, a macOS build, and real SMTP / OIDC providers. They are tracked in
[docs/roadmap.md](docs/roadmap.md#known-gaps--next-verifications).

## Acknowledgements

The agent's remote-desktop JPEG encoder (the `jpeg-encoder` crate) is based in part on the work of
the Independent JPEG Group. Third-party licences are checked with `cargo deny` ([deny.toml](deny.toml))
and listed in the CycloneDX SBOMs attached to each release.

## License

No license has been chosen for RustRMM yet, so all rights are reserved by the author until a
`LICENSE` file is added. Third-party components keep their own licences.

<div align="center">
<br>
<img src="web/public/favicon.svg" width="40" alt="">
<br>
<sub>Built with Rust, React and a healthy distrust of the network.</sub>
</div>
