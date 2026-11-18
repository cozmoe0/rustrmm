# RustRMM — Architecture

## Context

`C:\Users\Kyle\Development\Projects\Personal\rustrmm` is empty apart from a JetBrains `.idea/` folder — this is a greenfield build. The goal is a self-hosted, security-first RMM platform written in Rust with feature breadth comparable to Datto RMM / ConnectWise Automate, for an MSP (or internal IT team) managing 50+ endpoints across several client companies. Nothing is borrowed from the user's other projects: architecture, code and UI are designed fresh for this product.

Decisions confirmed with the user:
- **Name:** RustRMM.
- **Tenancy:** MSP multi-client — Client → Site → Device everywhere; client switcher; per-client reports and branding; technicians scoped to clients.
- **Optional modules in scope (all four):** remote desktop; secrets escrow (BitLocker/FileVault keys + LAPS-style local admin rotation); network discovery + SNMP; ticketing/helpdesk.
- **UI layout:** "Command Rail" — slim icon rail, contextual sub-nav, live Fleet Pulse bar, Ctrl+K palette, device workspace tabs.

Hard requirements from the request: Rust agent for Windows/macOS/Linux with deep inventory and remote management; remote agent self-update; silent Group Policy deployment; code signing optional but easy to switch on; docker compose deployment on Windows or Linux hosts; native run on a Windows PC for development; React + TypeScript + Tailwind + shadcn/ui console with a premium, custom look; SQLite with automatic backups.

Outcome: one monorepo producing (1) `rustrmm-server` — a single binary / single container serving the web console, REST API and agent gateway; (2) `rustrmm-agent` — one cross-platform binary plus installers (MSI, shell installers, deb/rpm, pkg). Delivered in phases, each demoable end-to-end.

Environment found: Rust 1.98 (MSVC host; musl, darwin and linux targets installed), Node 26.7 / npm 11.19, .NET SDK, zig 0.17, WSL2 with a Kali (Debian-based) distro. Not installed: Docker (needed later for compose testing), cmake/clang/nasm — so prefer crates that build with plain MSVC (rustls with the `ring` provider, not aws-lc-rs).

A verification pass (crate/tool status as of 2026-11) shaped several choices below: utoipa v6, sqlx 0.9, shadcn CLI v4 on Base UI, React 19.3 / Vite 8 / Tailwind 4.3; **WiX is avoided** (v3 is end-of-life; v6+ requires a paid maintenance fee for organisations above $10k revenue) in favour of `wixl` (msitools); rustls-acme dropped (TLS-ALPN-01 only works on port 443); `scrap` dropped (abandoned; its maintained fork is AGPL); `rcodesign` kept only as a fallback (no release in two years) — native `codesign`/`notarytool` on macOS runners instead.

---

## 1. System overview

```
 Browser (React SPA)                                     Endpoints (Win / macOS / Linux)
   │ HTTPS + WSS  console listener :8443                   rustrmm-agent (service, SYSTEM/root)
   ▼                                                         └─ session-helper (per logged-in user)
 ┌───────────────────────────── rustrmm-server ───────────────────▲─────────────────┐
 │ CONSOLE LISTENER :8443 (LAN/VPN by default)                    │ outbound WSS    │
 │   /                       embedded SPA                         │ only            │
 │   /api/v1/*               REST + OpenAPI docs                  │                 │
 │   /api/v1/stream          UI live-event WebSocket              │                 │
 │   /api/v1/sessions/:id/ws browser side of shell/desktop/file tunnels             │
 │ AGENT LISTENER :8444 (the only port ever exposed to the internet)                │
 │   /agent/v1/enroll   /agent/v1/connect (control WS)   /agent/v1/tunnel/:id       │
 │   /agent/v1/download/* installers + update artifacts (token-gated)               │
 │ domain: auth+RBAC · tenancy · inventory · metrics · monitoring · alerts          │
 │         automation · patching · software · releases · remote sessions            │
 │         tickets · escrow · discovery/SNMP · reports · audit                      │
 │ infra:  SQLite (WAL) · scheduler · event bus · signer · PKI · notifications      │
 │         backups (local + S3)                                                     │
 └──────────────────────────────────────────────────────────────────────────────────┘
   /data (named volume: db, keys, pki, files, agents, recordings)        /backups
```

- **Two listeners** by default: the agent gateway can face the internet for remote workers while the console/API stays LAN/VPN-only (the ScreenConnect CVE-2024-1709 lesson). A single-listener mode exists for dev and simple LAN setups.
- Endpoints only connect outbound; nothing listens on managed machines.
- Each interactive session (shell, desktop, file transfer) gets its own tunnel WebSocket so bulk traffic never blocks the control channel.

## 2. Repository layout

```
rustrmm/
├─ Cargo.toml              workspace: shared deps, lints, release profiles (LTO, strip)
├─ rust-toolchain.toml     pinned stable
├─ deny.toml               cargo-deny: advisories, licenses, bans
├─ .gitignore              target/, node_modules/, data/, secrets/, .idea/
├─ crates/
│  ├─ proto/   rustrmm-proto   wire types, signed envelopes, tunnel framing, versioning
│  ├─ crypto/  rustrmm-crypto  Ed25519 (algorithm-agile), age/X25519 escrow, XChaCha20 field enc, PKI
│  ├─ common/  rustrmm-common  IDs, errors, time, tracing setup, platform constants
│  ├─ server/  rustrmm-server  axum app + all server modules (lib + bin)
│  ├─ agent/   rustrmm-agent   agent binary: service, collectors, executors, desktop, updater
│  ├─ sim/     rustrmm-sim     simulated fleet (N fake agents over the real protocol, old versions too)
│  └─ xtask/                   build, package, sign, codegen (cargo xtask …)
├─ web/                    React console (Vite)
├─ packaging/
│  ├─ windows/  RustRMMAgent.wxs (wixl), gpo/Install-RustRMM.ps1, intune notes
│  ├─ linux/    install.sh, rustrmm-agent.service, OpenRC script, deb/rpm metadata
│  └─ macos/    install.sh, LaunchDaemon + LaunchAgent (.app helper) plists, pkg scripts
├─ deploy/      Dockerfile, docker-compose.yml, .env.example
├─ spikes/      throwaway risk spikes (Phase 0), deleted once proven
├─ .github/workflows/  ci.yml, release.yml
└─ docs/        architecture, security, deployment, GPO guide, signing guide, API
```

## 3. Technology choices

| Area | Choice |
|---|---|
| Server runtime / HTTP | tokio, axum 0.8, tower-http (compression, timeouts, request IDs, tracing), axum-server |
| TLS / PKI | rustls (ring provider), rcgen (internal CA + leaf), instant-acme (HTTP-01 on :80, DNS-01 for LAN-only hosts); agents use rustls-platform-verifier (OS trust store, so AD CS certs work) or the pinned internal CA |
| Database | sqlx 0.9 + SQLite (bundled), WAL; compile-time-checked queries with committed `.sqlx/` offline data; embedded migrations |
| API contract | utoipa v6 (OpenAPI 3.1 document) + a self-hosted docs page → `openapi-typescript` + `openapi-fetch` for the REST client; ts-rs for WebSocket event types — the TypeScript frontend is typed straight from Rust |
| Auth | argon2 (Argon2id), totp-rs, webauthn-rs (passkeys), OIDC SSO implemented on reqwest + `ring` (JWKS/JWT verification; no OpenSSL, no extra crypto stack), in-memory token-bucket rate limits |
| Crypto | ed25519-dalek 3, chacha20poly1305 (XChaCha20), hkdf, sha2, age (escrow + backups), zeroize/secrecy; snow (Noise IK, optional end-to-end channel) |
| Agent protocol | MessagePack (`rmp_serde::to_vec_named`) + zstd over WebSocket (tokio-tungstenite) |
| Jobs / schedules | croner + persistent job tables driven by tokio tasks |
| Notifications | lettre (SMTP), reqwest (webhooks, Slack, Teams, Discord, ntfy) with SSRF guard, async-imap (email-to-ticket) |
| Reports | Renderer-independent section model → JSON, CSV and PDF via the pure-Rust `pdf-writer` (typst was evaluated and deferred; see `api-platform.md`) |
| Backups | `VACUUM INTO` snapshot, tar + zstd, age encryption, object_store (S3-compatible, Object Lock aware) |
| Agent platform | sysinfo; Windows: windows-rs, windows-service, wmi (dedicated COM thread), winreg; Linux: zbus (systemd/logind), /proc, /sys; macOS: system_profiler JSON, core-foundation/core-graphics, ScreenCaptureKit bindings |
| Agent local state | rusqlite (bundled) for offline queue, state, check history; self-replace for binary swaps |
| Remote shell | Windows: own ConPTY on windows-rs (choose SYSTEM or user token, Job-object cleanup); Unix: portable-pty |
| Remote desktop | Windows: own DXGI Desktop Duplication + GDI fallback, raw SendInput, SendSAS; macOS: ScreenCaptureKit + enigo (CGEvent); X11: x11rb (XShm/XTest) + enigo; Wayland: portal RemoteDesktop/ScreenCast + reis (libei) + PipeWire in a separate glibc helper. Encoders: Media Foundation / VideoToolbox hardware H.264 → OpenH264 via Cisco's runtime-downloaded binary (`libloading`) → JPEG dirty tiles (jpeg-encoder) always available; browser decodes with WebCodecs. xcap for thumbnails; arboard clipboard |
| Network | surge-ping (ICMP), snmp2 (v1/v2c/v3), mdns-sd |
| Web | React 19.3, TypeScript strict, Vite 8, Tailwind CSS 4.3, shadcn/ui (CLI v4, Base UI primitives — the current default), TanStack Router/Query/Table/Virtual, react-hook-form + zod, Recharts 3 (shadcn charts), @xterm/xterm 6, CodeMirror 6, cmdk, sonner, lucide-react, motion, dnd-kit, react-resizable-panels |
| Testing | cargo test, Vitest + Testing Library, Playwright, cargo-fuzz |
| Build / release | cargo xtask, cargo-zigbuild (musl server + Linux agents), cargo-xwin (Windows agent from Linux), wixl/msitools 0.106 (MSI — Docker, WSL or MSYS2), cargo-deb, cargo-generate-rpm, osslsigncode / signtool, codesign + notarytool (macOS runner; rcodesign fallback), cargo-deny, cargo-cyclonedx (SBOM) |

## 4. Security architecture

**Transport & trust anchors**
- TLS 1.3 only. TLS modes: `internal` (default — auto-generated P-256 root CA + server leaf, auto-renewed with a stable key), `acme` (Let's Encrypt via HTTP-01 or DNS-01), `custom` (mount PEM, e.g. from the company's AD CS — already trusted by domain machines), `proxy` (plain HTTP behind a trusted TLS-terminating proxy).
- The primary trust anchor is the **server identity key** (Ed25519), pinned by every agent. TLS pinning is an extra layer used in `internal` mode only, so certificates can rotate, move to ACME or sit behind a proxy without redeploying agents.
- Separate keys for identity, command signing and release signing. Private keys live in `/data/keys`, wrapped by the master key — never in the database, so SQL-level compromise cannot forge commands. Key types are algorithm-agile (Ed25519 now; P-256 for TPM/Secure Enclave-backed keys later).
- **Noise IK** end-to-end channel inside the WebSocket (negotiated `noise` capability, used whenever both sides support it, required in `proxy` mode) so a TLS-terminating proxy or corporate TLS-inspection box cannot read commands, shell or desktop traffic; tunnels use it too (`docs/api-platform.md`).

**First-run protection**
- The setup wizard is gated by a one-time setup token printed to the server console/logs, so nobody can race to claim a fresh install.
- Setup produces a **recovery kit** (master key + backup decryption identity) that the owner must download and confirm before finishing.

**Deploy key & enrollment**
- A per-site **deploy key** is one copy-paste string: `rrmm1_<base64url{agent URLs, 128-bit enrollment secret, server identity pubkey, optional TLS pin}>` — used as the MSI `DEPLOY_KEY` property (marked `Hidden` so it stays out of msiexec logs), the sidecar `deploy.key` file, or the shell-installer argument. No trust-on-first-use.
- A deploy key on a GPO share is treated as semi-public: tokens are time-boxed with max uses ≈ fleet size, the approval queue switches on automatically after the rollout window, enrollment can be restricted by AD domain / DNS suffix / source CIDR, and an optional LDAP check confirms the computer object's OU. The agent deletes its local copy of the secret after enrolling; tokens rotate without affecting enrolled agents.
- Duplicate hardware fingerprints (SMBIOS UUID + serial) trigger a re-enroll flow (approve / merge / replace). The same device key connecting from two places at once flags a cloned agent.
- Device keys are generated on the endpoint and never leave it. Windows: DPAPI machine-scope blob in a ProgramData folder created with a protected ACL whose owner is verified at every start (defeats pre-creation attacks). Unix: root-owned `0700` directory, `0600` key.

**Per-connection mutual authentication**
1. Agent → `Hello{device_id, agent_nonce, protocol major.minor, capabilities, agent_version}`.
2. Server → `Challenge{server_nonce, server_time, sig_identity(ctx ‖ agent_nonce ‖ server_nonce ‖ device_id)}` — the agent verifies against the pinned identity key.
3. Agent → `Proof{sig_device(ctx ‖ server_nonce ‖ agent_nonce ‖ device_id)}` — the server checks the device key and status (active / quarantined / revoked).
Revocation drops live connections immediately.

**Signed commands (anti-injection, anti-replay)**
- Every server→agent command is `Envelope{payload_bytes, sig, key_id}`; the payload carries `cmd_id (ULID), device_id, connection nonce, seq, issued_at, expires_at, kind`. Sequence numbers are scoped to the connection handshake nonce; expiry is checked against server time (offset learned in the handshake), not the endpoint clock; queued jobs are re-signed at delivery.

**Updates**
- Agent bundles carry a manifest signed by the build's publisher key; the server verifies on import and issues per-installation release manifests (version, per-platform SHA-256, size, minimum protocol) signed by the release key. Downgrades are refused unless an admin signs an explicit rollback. Optional offline publisher key compiled into agents, so they require both signatures.

**Web console**
- Argon2id passwords (min 12 chars), progressive lockout, per-IP and per-account rate limits.
- Sessions: 256-bit random tokens stored as SHA-256 hashes; `__Host-rustrmm_session` cookie (Secure, HttpOnly, SameSite=Strict); idle 30 min / absolute 12 h; rotated on login and privilege change; users can list and revoke sessions; open tunnels are killed on logout or role change.
- CSRF token header on every state-changing request; strict `Origin` check plus one-time 30-second tickets (bound to session, device and purpose) on every WebSocket upgrade.
- MFA mandatory (TOTP or passkeys, hashed recovery codes). **Step-up re-authentication** (MFA within 5 min) before shell, desktop, script runs, secret reveals, mass actions, user/role changes, backup download/restore and key/signing settings.
- SSO via OIDC (Entra ID, Google, Okta, Keycloak, Authentik) with group → role mapping; a local owner account stays as break-glass.
- API tokens: prefixed, 256-bit, stored hashed, scoped (permissions + clients), expiring, optional IP allowlist.
- Headers: strict CSP (`script-src 'self'`, no inline scripts; `style-src` relaxed only if a component library needs it), `frame-ancestors 'none'`, HSTS, nosniff, `Referrer-Policy: no-referrer`, COOP/CORP. Body limits and timeouts everywhere. Outbound webhooks block private/loopback/link-local targets unless allowlisted (SSRF).

**RBAC & tenancy isolation**
- ~60 fine-grained permissions (e.g. `devices.shell`, `devices.desktop`, `scripts.run`, `secrets.reveal`, `patches.approve`, `tickets.manage`). Built-in roles: Owner, Admin, Technician, Help Desk, Auditor (read-only); custom roles.
- Assignments scoped to global / client(s) / site(s). A per-request `AccessScope` is enforced in the repository layer (every query filtered), not just in the UI; an authorization-matrix test suite covers every endpoint.

**Secrets at rest**
- 256-bit master key supplied as a Docker secret / key file, kept outside both the database and the backup set; HKDF subkeys per purpose.
- Sensitive columns (SMTP/S3/SNMP/IMAP credentials, script secret variables, OIDC secrets) use XChaCha20-Poly1305 with AAD = table/column/row ID. Secret script variables are only sent to approved devices.
- Escrow (BitLocker keys, LAPS passwords): the agent encrypts to the server's escrow X25519 recipient (age format). Reveal needs the permission + step-up + a typed reason; it is audited, can notify owners, and can trigger LAPS auto-rotation.

**Audit**
- Append-only, hash-chained audit log (`hash = SHA-256(prev_hash ‖ canonical_row)`), daily anchor digest, "Verify integrity" button, CSV/JSON export, syslog/webhook forwarding off-box to a SIEM. Covers auth, settings, enroll/revoke, remote sessions (with recordings), script runs (content hash), secret reveals, API token use.

**Blast-radius controls** (a compromised RMM console is fleet-wide root)
- Mass-action guard: more than N devices or "all" requires typed confirmation + step-up, and optionally a second admin's approval (four-eyes).
- Optional script approval workflow keyed to content hash; edits invalidate approval.
- Per-client remote-access policy (allow shell/desktop/files, end-user consent, allowed hours).
- **Local capability lock** on the endpoint (`DISABLE_FEATURES=shell,desktop,scripts` at install or a local file) that the server cannot override — e.g. no remote desktop on domain controllers.
- **Lockdown mode:** a global switch pausing all command dispatch while monitoring continues.
- Security alerts to owners: new admin, MFA disabled, mass script run, burst of reveals, new API token, login from a new IP.

**Endpoint hardening**
- No listening ports; binaries under Program Files / root-owned paths; quoted service path; `SetDefaultDllDirectories` against DLL hijacking; named pipes with `FILE_FLAG_FIRST_PIPE_INSTANCE`, SYSTEM-only DACL and client-image verification; ACL'd script temp dir with deletion after run; sanitized child environment; output caps, timeouts and process-tree kill (Job Objects / process groups); optional tamper protection (uninstall requires a server-issued token).

**Supply chain**
- Committed `Cargo.lock` / `package-lock.json`; cargo-deny (advisories + license allowlist) and `npm audit` in CI; CycloneDX SBOM per release; GitHub Actions pinned by SHA; Renovate/Dependabot.

## 5. Agent

**Process model**
- `rustrmm-agent service` (SYSTEM/root): connection manager, scheduler, collectors, executors, check engine, updater, and a hardened local IPC endpoint for helpers.
- `rustrmm-agent session-helper` (one per interactive session): screen capture + input, user notifications and consent prompts, the on-screen "session in progress" banner, run-as-user scripts, and an optional tray icon with "Request support" (creates a ticket with screenshot + device context).
  - Windows: launched by the service into the user's session with a duplicated SYSTEM token (needed for the secure desktop) or the user's token (for run-as-user).
  - macOS: LaunchAgent `.app` bundle running in Aqua and LoginWindow sessions; TCC permission state (Screen Recording, Accessibility, Full Disk Access) reported to the console.
  - Linux: per-session launch discovered via logind; a separate glibc-linked helper handles Wayland/PipeWire so the main agent stays a static musl binary.
- `rustrmm-agent update-helper` (transient, during updates).
- Subcommands: `install`, `uninstall`, `enroll --key`, `run --console` (foreground dev mode), `status`, `diag` (connectivity self-test), `version`.

**Paths and identifiers**
- Windows: service `RustRMMAgent` ("RustRMM Agent"), `C:\Program Files\RustRMM\Agent\`, data `C:\ProgramData\RustRMM\Agent\`.
- Linux: `/opt/rustrmm/rustrmm-agent`, `/etc/rustrmm/`, `/var/lib/rustrmm/`, systemd unit `rustrmm-agent.service` (OpenRC on Alpine).
- macOS: `/Library/RustRMM/`, `/Library/Application Support/RustRMM/`, LaunchDaemon `com.rustrmm.agent`, LaunchAgent `com.rustrmm.agent.helper`.

**Inventory collectors** (each section hashed; only changed sections are sent; the server turns diffs into device-timeline events)
- *System:* hostname, domain/workgroup, Entra ID join, OS name/edition/version/build/kernel, install date, uptime, last boot, timezone, pending-reboot flag + reasons.
- *Hardware:* manufacturer, model, serial, SMBIOS UUID, BIOS/UEFI, Secure Boot, TPM, CPU, RAM modules, GPUs, monitors (EDID), chassis, battery health/cycles, USB peripherals, printers.
- *Storage:* physical disks (model, serial, media, bus, SMART health/attributes), volumes (filesystem, size, free, encryption).
- *Network:* interfaces (MAC, IPv4/6, gateway, DNS, DHCP, speed), Wi-Fi SSID/signal, VPN adapters, listening ports with owning process, public IP as seen by the server.
- *Software:* installed apps (registry/MSI/AppX/winget; dpkg/rpm/pacman/apk/snap/flatpak; .app bundles/pkgutil/brew) with version, publisher, install date.
- *Updates:* installed hotfixes, pending updates (classification, severity, KB, size, reboot), last scan/install, WSUS/WU configuration.
- *Security:* AV products and Defender detail (real-time protection, signature age, last scan), firewall profiles, UAC, BitLocker/FileVault/LUKS, Gatekeeper/SIP, SELinux/AppArmor, local admin members, RDP/SMBv1/guest/autologon flags, screen-lock policy.
- *Users:* local accounts (enabled, admin, last logon, password age), logged-in sessions, last user, profiles and sizes.
- *Services/daemons, startup items, scheduled tasks/cron, event-log error summary;* custom inventory via scripts.

Cadence (policy-driven defaults): heartbeat 30 s; metrics 60 s (2 s "live mode" while someone views the device); volatile sections 15 min; software/hardware/security 4 h plus change triggers; full refresh daily.

**Executors**
- Scripts: PowerShell 5.1 / pwsh 7, cmd, bash/sh/zsh, Python; parameters as environment variables; secret masking; run as SYSTEM or the logged-in user; timeouts; output caps; `::rustrmm::set-field name=value` directives.
- Remote shell; file operations (list/stat/chunked read+write/mkdir/rename/delete/hash/zip folder); processes; services; event logs (Windows channels / journald / unified log); registry; power (reboot/shutdown/logoff/lock with delay + message); Wake-on-LAN relay; user messages; package managers (winget, choco, brew, apt, dnf, zypper, pacman, apk, snap, flatpak); patch scan/install; Defender actions; network diagnostics from the device (ping, traceroute, DNS, port test); screenshot; discovery scans; SNMP polling (probe role).

**Check engine (agent-side monitors)**
- CPU/memory over a window, disk free (% or GB), SMART, service state (optional auto-restart), process running/not running/resource use, event-log match, script check (exit 0/1/2 = ok/warn/crit), ping, TCP port, HTTP(S) (status, keyword, latency, cert expiry), local certificate expiry, pending reboot, AV/firewall disabled, Windows Update failures, battery health, uptime threshold, file/registry conditions, bandwidth. Only state transitions are sent.

**Resilience & footprint**
- Offline queue (rusqlite) flushed on reconnect; metrics dropped first when the cap is hit.
- Exponential backoff + jitter; multiple agent URLs for failover; HTTP CONNECT proxy support.
- Targets: idle RAM < 25 MB, idle CPU < 1 %, binary < 20 MB.

**Self-update (one code path on every OS)**
- Agent receives `UpdateAvailable{manifest, signature}` → downloads → verifies signature + SHA-256 → stages the new binary → spawns a detached `update-helper` (on Windows with breakaway from the service's job object).
- The helper stops the service, renames the current binary to `.old`, moves the new one in, starts the service, and waits for the new version to write a health marker after a successful handshake. On timeout or crash-loop it restores `.old`, restarts, and reports the failure.
- Windows MSI is used only for install/uninstall: the ProductCode never changes, so GPO Software Installation never re-runs the old package. The MSI sets `ARPNOREPAIR`/`ARPNOMODIFY` (no "Repair" reverting the binary) and the agent refreshes the Add/Remove Programs `DisplayVersion` after each update (cosmetic).
- Linux .deb/.rpm installs update via `dpkg -i` / `rpm -U` so the package database stays truthful.
- Rollouts: rings (pilot → broad), percentage steps, pause/resume, auto-pause when the failure rate crosses a threshold.

## 6. Agent ↔ server protocol

- WSS binary frames carry an envelope `{type: String, id, body: bytes}` (MessagePack, zstd above 4 KB), so receivers can skip unknown message types. Bodies are encoded with `to_vec_named` (field names on the wire); new fields are `#[serde(default)]`; fields are never repurposed.
- Protocol `major.minor` + capability list in `Hello`; the server supports the current minor and the two before it. Golden MessagePack fixtures per released version are checked in, and `rustrmm-sim` exercises old protocol versions in CI.
- Message families: Session (Hello / Challenge / Proof / Welcome / Ping / Bye) · Telemetry (Heartbeat, Metrics, InventorySection) · Policy (PolicyUpdate, CheckStateChange) · Commands (SignedCommand → Ack → Progress → Result) · Events · Tunnels (`OpenTunnel` → agent dials `/agent/v1/tunnel/:id` with a one-time token + device signature).
- Tunnels use a tiny binary header the server forwards without decoding, credit-based flow control/backpressure, idle timeout and max duration, plus a recording tap (shell → asciicast v2).
- Limits: max frame 16 MB (inventory), 1 MB tunnel chunks, connection limits per IP.

## 7. Server

**Module map (`crates/server/src/`)**
`config` · `listeners` (console + agent) · `tls` (internal CA, ACME, custom, proxy) · `db` (pool, writer task, migrations, repositories) · `auth` (sessions, MFA, passkeys, OIDC, API tokens, setup token) · `rbac` · `tenancy` (clients, sites, contacts, branding) · `agents` (enroll, gateway, presence, command dispatch) · `tunnels` · `inventory` · `metrics` · `monitoring` (server-side checks) · `alerts` · `notify` · `automation` (scripts, jobs, schedules, variables) · `policies` · `patching` · `software` · `releases` (bundle import, manifests, rollouts) · `escrow` · `discovery` (scans, SNMP) · `tickets` · `reports` · `audit` · `backup` · `files` (content-addressed blobs) · `events` (bus → UI stream) · `api` (routes + OpenAPI) · `web` (embedded SPA, security headers).

**Concurrency & storage**
- SQLite WAL, `busy_timeout`, foreign keys. One writer task batches telemetry (flush every 1 s or 500 rows); request-path writes use `BEGIN IMMEDIATE`; retention and rollups run in small batches so checkpoints never stall. `/data` must be a named Docker volume — never a Windows bind mount. Sized for ~1,000 devices on 2 vCPU / 2 GB.
- Metrics retention: raw 1-min for 7 days, 15-min rollups 90 days, 1-hour rollups 2 years (configurable).
- Blob store `/data/files` (SHA-256 addressed) for packages, attachments and recordings; agents download via short-lived signed URLs.

**Scheduler & event bus**
- Persistent schedules (croner) for jobs, patch windows, reports, backups, rollups, discovery; offline targets wait until they come online within the job's expiry.
- `tokio::broadcast` topics → `/api/v1/stream`, filtered by AccessScope; also drives presence ("Alice is connected to this device").

**Backups (core requirement)**
- Scheduled (default daily 02:00; hourly optional), automatic before every migration/upgrade, and on demand.
- Contents: `VACUUM INTO` snapshot into a fresh file, checked with `PRAGMA integrity_check`, plus keys/PKI (still wrapped by the master key) + config (+ optional blob store); tar + zstd; encrypted with **age to an offline X25519 recipient** — the server can write backups but cannot read them.
- Destinations: local `/backups` (bind-mounted to the host for convenience) and S3-compatible storage (AWS, B2, MinIO, Wasabi; Object Lock for immutability). The UI warns that a same-host copy alone is not a backup. GFS retention (e.g. 24 hourly / 14 daily / 8 weekly / 12 monthly).
- Restore via `rustrmm-server restore <file> --identity <key>` or the UI (upload → restart into restore mode); backup history with SHA-256/size; optional scheduled test-restore.

**API**
- REST `/api/v1`, OpenAPI 3.2 + Scalar docs at `/api/docs`, API tokens, outbound webhooks (`device.enrolled`, `alert.triggered`, `job.completed`, `ticket.updated`, …) signed with HMAC-SHA256 and retried.

## 8. Data model (SQLite; UUIDv7 TEXT keys; JSON1 for flexible inventory)

- **Tenancy:** clients, sites, client_contacts, client_branding.
- **Devices:** devices, device_keys, device_inventory (section, json, hash, updated_at), device_inventory_history, device_software, device_metrics_raw / _15m / _1h, tags, device_tags, custom_fields, custom_field_values, device_notes, device_timeline.
- **Groups & policies:** groups (static / dynamic + rule JSON), group_members, policies (versioned JSON docs), policy_assignments (inheritance global → client → site → group → device).
- **Monitoring:** check_states, alerts, alert_events, maintenance_windows.
- **Notifications:** notification_channels, notification_rules, notification_log.
- **Automation:** scripts, script_versions, script_approvals, variables, jobs, job_targets, job_results, schedules.
- **Patching & software:** patch_catalog, patch_approvals, device_patches, patch_runs, software_catalog, software_library, deployments, deployment_results.
- **Remote:** remote_sessions, session_recordings, file_transfers.
- **Escrow:** escrow_items (type, device, age ciphertext, rotated_at), escrow_reveals.
- **Network:** discovery_scans, discovered_assets, snmp_devices, snmp_credentials, snmp_metrics.
- **Ticketing:** tickets, ticket_comments, ticket_time_entries, ticket_attachments, sla_policies, ticket_links, canned_responses.
- **Reports:** report_definitions, report_schedules, report_runs.
- **Identity:** users, user_totp, webauthn_credentials, recovery_codes, sessions, api_tokens, roles, role_permissions, role_assignments, oidc_providers.
- **System:** settings, enrollment_tokens, agent_bundles, rollouts, device_update_state, backups, audit_log, webhooks, webhook_deliveries.

## 9. Feature modules (functional scope)

- **Clients & sites:** client directory with health score, device counts, open alerts/tickets and patch compliance; contacts; per-client branding (logo, colours) for reports and the tray helper; per-client policies and remote-access rules; device counts for billing.
- **Devices:** fleet grid (saved views, faceted filters, column chooser, bulk action bar, CSV export); device cockpit with tabs Overview · Hardware · Software · Patches · Storage · Network · Security · Users · Processes · Services · Events · Files · Registry · Scripts · Alerts · Tickets · Timeline · Notes; composite health score (0–100); custom fields; tags; static and dynamic groups (visual rule builder).
- **Remote tools:** shell with transcript recording + replay; file manager (drag-and-drop upload, folder download); process, service, event-log and registry managers; power actions; message user; network diagnostics; quick screenshot; presence indicators.
- **Remote desktop:** in-browser view/control; multi-monitor; UAC/secure desktop and login screen on Windows; Ctrl+Alt+Del via SendSAS (agent sets the `SoftwareSASGeneration` policy at install); text clipboard sync; quality/FPS adaptation; view-only; consent prompt + on-screen banner per client policy; session audit; latency/FPS overlay. macOS needs user-approved Screen Recording/Accessibility (state shown per device); Wayland is attended-only (one consent, then restore tokens).
- **Automation:** script library (CodeMirror editor, typed parameters, versions, categories, platform targeting, approval workflow, high-risk flag); ~40 built-in starter scripts written fresh (disk cleanup, flush DNS, gpupdate, restart spooler, collect logs, …); global/client/site variables + encrypted secrets; jobs (now / scheduled / cron; targets = devices, groups, sites, filters; offline-wait; concurrency limits; live progress; per-device output); policy-driven scheduled tasks.
- **Monitoring & alerts:** agent-side checks (§5) + server-side checks (offline, patch compliance, outdated agent, security-relevant inventory changes such as a new local admin or new software, disk-fill forecast); alert lifecycle (dedupe, severity, acknowledge, snooze, resolve, auto-resolve, notes); triage inbox; maintenance windows; auto-remediation scripts; alert → ticket rules.
- **Notifications:** email, Slack, Microsoft Teams (Workflows webhook), Discord, ntfy, generic HMAC webhook; rules by client/site/severity; quiet hours; escalation when unacknowledged; digests.
- **Patching:** Windows Update via WUA COM (scan/download/install, classifications, MSRC severity, WSUS-aware); Linux (apt/dnf/zypper/pacman/apk); macOS report-only plus user-approved installs via the helper (Apple Silicon requires a volume owner's consent without MDM); approvals with auto-approval rules, deferral days and rings; maintenance windows; reboot policies (prompt with deferrals, or force at window end); third-party updates via winget/choco/brew; compliance dashboard per client/site/OS.
- **Software:** fleet-wide inventory explorer (product → versions → devices); software library (package-manager references or uploaded MSI/EXE/PKG/DEB/RPM with silent args and detection rules); deploy / uninstall jobs.
- **Secrets escrow:** BitLocker recovery-key escrow (auto-captured on change); FileVault/LUKS escrow where the OS permits (attended flows); LAPS-style local admin rotation (schedule, rotate after reveal, per-client policy) on Windows/macOS/Linux; reveal flow with step-up, reason and audit.
- **Network discovery & SNMP:** designated site probe agent; scans (ICMP sweep, ARP table, TCP probes, mDNS/SSDP/NetBIOS names, SNMP sysDescr, MAC OUI vendor) → discovered assets with type guess and "unmanaged" flag; SNMP v2c/v3 monitoring templates (IF-MIB, HOST-RESOURCES, Printer-MIB toner, UPS-MIB battery) → thresholds, alerts, graphs; optional trap receiver.
- **Ticketing / helpdesk:** tickets (status, priority, type, queue, assignee, SLA timers, due dates), public/internal comments, client contacts with email notifications, email-to-ticket via IMAP, billable time entries per client, links to devices/alerts, canned responses, end-user "Request support" from the tray helper, SLA dashboard.
- **Reports:** executive summary per client (MSP + client branding), hardware and software/licensing inventory, patch compliance, alert history, security posture, tickets and time, agent status, audit; on-screen, CSV and PDF (typst); scheduled email delivery.
- **Agent deployment & updates:** per-site installers and deploy keys, one-liners, GPO wizard, enrollment approval queue; agent bundle import and rollouts (§5).
- **Administration:** users, roles and scopes; SSO; MFA and session policy; API tokens and webhooks; notification channels; backups and recovery kit; TLS/certificates; code-signing status; white-label branding; audit log; system health (DB size, queue depth, agent connections); Lockdown mode.

## 10. Web console

**Design language (custom, not stock shadcn)**
- *Palette:* cool graphite neutrals; brand accent **copper** (≈ `oklch(0.68 0.15 45)`) for primary actions, focus rings, active-nav indicator and selection; secondary accent **verdigris** teal (≈ `oklch(0.72 0.10 185)`) for live/online states and charts — copper + patina is a cohesive "rust" brand story that stands apart from blue SaaS defaults. Semantic success / warning (amber) / critical (rose-red) / info (sky). A 6-hue categorical chart palette checked for contrast in both themes and for colour-vision deficiency.
- *Themes:* dark (console default; base `#0C0E11`, elevation by surface tone rather than heavy shadows, hairline borders with a faint top highlight) and light (warm paper `#F7F7F5`); follows system preference.
- *Type:* Mona Sans (variable weight + width — narrower widths in dense tables; tabular numerals for metrics) for UI; Monaspace Neon for terminal, code and IDs; both OFL and self-hosted.
- *Shape & motion:* 6 px control radius / 10 px cards (a squarer "instrument" feel); 120–180 ms ease-out; respects reduced-motion; 2 px copper focus ring.
- *Density:* compact by default (13 px tables, 14 px body) with a comfortable toggle.
- Tokens live in CSS variables (Tailwind v4 `@theme`); shadcn components are copied in and restyled. A hidden `/design` route is a living kitchen sink for visual QA.

**Shell ("Command Rail", as chosen)**
```
+---+------------------------------------------------------------+
| R | Client: Acme v  Site: All v   [Ctrl+K] Search…   + New  (o) |
|   +------------------------------------------------------------+
| H | * 47 online  o 3 offline  ! 2 critical  96% patched  7 tix  | <- Fleet Pulse (live, clickable)
| D +------------------------------------------------------------+
| A | [Devices] [WS-0142 x] [SRV-DC01 x] [Ticket #212 x]         | <- workspace tabs
| P | +- context panel -+ +---------------------------------------+|
| T | | views / filters | |  page content                         ||
| R | +-----------------+ +---------------------------------------+|
| S |                                         inspector drawer ->   |
+---+------------------------------------------------------------+
```
- 56 px icon rail (Home, Clients, Devices, Alerts, Automation, Patching, Software, Tickets, Network, Reports, Settings) with tooltips and a copper active bar; notifications, theme toggle and profile at the bottom.
- Collapsible 240 px context panel per section (saved views, filters, sub-pages).
- Top bar: searchable client switcher with logos (or "All clients"), site filter, breadcrumb, Ctrl+K command palette (navigate, find devices/scripts/tickets, run actions), quick-create menu.
- Fleet Pulse ribbon: live, scope-aware counts; each opens a pre-filtered view.
- Workspace tabs: devices, tickets and jobs open as persistent tabs (Ctrl+1–9, middle-click to close), synced to user preferences.
- Inspector drawer: space-bar quick-look from any list without losing context.
- Terminals and desktop viewers open docked, split, or popped out to their own window.
- Keyboard-first: `g d` (go devices), `j/k` row navigation, `/` focus filter, `?` shortcut sheet.

**Key screens**
MSP overview (client cards: health, alerts, compliance, tickets) · Client dashboard · Devices grid · Device cockpit (bento overview: health ring, live CPU/RAM/disk/network sparklines, security posture checklist, last user, alerts, quick actions) · Alerts inbox (list + detail split) · Script library + editor · Job run view · Policies · Patching (compliance, catalog/approvals, policies) · Software explorer + library · Remote desktop viewer · Terminal · File manager · Tickets (queue, ticket view, SLA board) · Network (discovered assets, SNMP) · Reports gallery + viewer · Deploy (installers, GPO wizard, approvals) · Agent bundles/rollouts · Settings · Audit log · Setup wizard · Login/MFA · first-run onboarding checklist (deploy first agent, alerts, invite team, backups).

Empty states use custom line illustrations with guided calls to action; skeleton loaders throughout; AA contrast in both themes.

**Frontend architecture**
- `web/src/features/<area>/` feature folders; `web/src/components/ui` (restyled shadcn); `web/src/lib/api` (generated types + openapi-fetch client); TanStack Router file-based routes with typed search params (filters and saved views live in the URL); TanStack Query with WebSocket-driven invalidation; TanStack Table + Virtual for 10k-row grids.
- One multiplexed `/api/v1/stream` WebSocket with topic subscriptions and reconnect/backoff.
- Route-level code splitting; xterm, CodeMirror and the desktop viewer lazy-loaded; bundle budget enforced in CI.
- Production build embedded in the server binary; in dev Vite proxies `/api` to the Rust server for hot reload.

## 11. Deployment, packaging, signing, CI

**Docker compose (Linux host, or Windows via Docker Desktop/WSL2)**
```yaml
services:
  rustrmm:
    image: ghcr.io/<owner>/rustrmm-server:latest   # or: build: { context: .., dockerfile: deploy/Dockerfile }
    restart: unless-stopped
    ports:
      - "443:8443"     # console + API (keep LAN/VPN-only)
      - "8444:8444"    # agent gateway (the only port to publish for remote workers)
      - "80:8080"      # optional: ACME HTTP-01 + redirect
    env_file: .env     # RUSTRMM_CONSOLE_URL, RUSTRMM_AGENT_URL, RUSTRMM_TLS_MODE, TZ …
    volumes:
      - rustrmm-data:/data        # named volume: SQLite must not live on a Windows bind mount
      - ./backups:/backups
    secrets: [master_key]
    read_only: true
    tmpfs: ["/tmp"]
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    healthcheck: { test: ["CMD", "/app/rustrmm-server", "healthcheck"], interval: 30s }
volumes: { rustrmm-data: {} }
secrets: { master_key: { file: ./secrets/master.key } }
```
- `docker compose run --rm rustrmm init` writes the master key and a starter `.env`; `docker compose up -d`; the setup token appears in `docker compose logs`; the wizard covers owner account + MFA, MSP name, first client/site, TLS confirmation, recovery kit, SMTP (optional) and a pre-set backup schedule.
- Image: multi-arch (amd64 + arm64), distroless nonroot runtime with a static musl server binary (SPA embedded) and a baseline agent bundle; further bundles (macOS, re-signed builds, new versions) are imported as data (`rustrmm-server agents import` or UI upload) into `/data/agents` without rebuilding the image.
- Upgrade: `docker compose pull && docker compose up -d` → automatic pre-migration backup → migrations → new agent bundle offered for rollout.

**Native (development, or a small internal Windows server)**
- `cargo run -p rustrmm-server -- --data-dir .\data` (console `https://localhost:8443`, agents `:8444`); `npm run dev` in `web/`; `cargo run -p rustrmm-agent -- run --console` for a foreground agent; `cargo run -p rustrmm-sim -- --devices 500`. Optional `rustrmm-server service install` registers a Windows service. Firewall rules documented.

**Windows agent: MSI + Group Policy**
- One generic MSI built with wixl (x64; also runs on Windows on ARM via emulation): per-machine, fully silent, installs and starts the service with recovery actions; properties `DEPLOY_KEY` (Hidden), `DISABLE_FEATURES`, `PROXY`. If `DEPLOY_KEY` is absent, the service itself asks Windows Installer for its install source (`MsiGetProductInfo` → `InstallSource`) and reads `deploy.key` from that folder — so GPO Software Installation (which cannot pass properties) works with no transform and no custom action.
- Console **Deploy → Group Policy** wizard downloads `RustRMM-GPO-<site>.zip` (MSI + `deploy.key` + `Install-RustRMM.ps1` + illustrated steps):
  - *Option A — Software Installation:* share readable by Domain Computers → GPMC → Computer Configuration → Policies → Software Settings → Software installation → New → Package (UNC path) → Assigned.
  - *Option B — Startup script:* Computer Configuration → Policies → Windows Settings → Scripts → Startup → `Install-RustRMM.ps1` (idempotent; installs only when missing; logs to `%WINDIR%\Temp`).
- Also: Intune LOB/Win32 instructions; a PowerShell one-liner with pinned-TLS bootstrap; Defender ASR / AV exclusion guidance (the ASR prevalence rule blocks new unsigned EXEs and can only be excluded, not tuned).

**Linux & macOS agents**
- Linux: `install.sh` one-liner (`curl --pinnedpubkey …` bootstrap; detects arch and init system; static musl binary for Debian/Ubuntu, RHEL/Alma/Rocky/Fedora, SUSE, Arch, Alpine) plus .deb/.rpm for config-management tools.
- macOS: `install.sh` (universal binary, LaunchDaemon + LaunchAgent `.app`) and a .pkg built on a macOS runner for Jamf/Intune/Kandji. Every macOS build is signed with at least a **stable self-signed identity** (created once with `cargo xtask signing init-macos`) so TCC grants survive updates; Developer ID + notarization optional. PPPC profiles cannot pre-approve Screen Recording, so the console guides the one-time user approval and shows per-device permission state.

**Optional code signing (zero friction when unset)**
- `cargo xtask sign --provider none|pfx|pkcs11|azure|apple-devid|apple-selfsigned`, fed by `signing.toml` locally or BuildKit/CI secrets; missing secrets mean skip-and-warn, never a failed build.
- Windows Authenticode: osslsigncode (PFX or PKCS#11 token; works in the Linux build) or signtool (cert store / Azure Artifact Signing). The EXE is signed before wixl packs it, the MSI after; RFC 3161 timestamps.
- macOS: codesign + notarytool on the macOS runner (rcodesign fallback elsewhere). Linux: optional minisign/GPG detached signatures.
- Settings → Code signing shows per-platform status with a guided setup. Ed25519 update signing (§4) is always on regardless.

**Builds & CI/CD**
- Dockerfile (BuildKit): every builder stage `FROM --platform=$BUILDPLATFORM` so each artifact builds once — web (`npm ci` + `vite build`) → server (cargo-zigbuild musl x64/arm64) → Linux agents (zigbuild musl) → Windows agent (cargo-xwin, SDK cached in a BuildKit cache mount) → MSI (`debian:trixie` + msitools/wixl) → distroless runtime. An empty `prebuilt/` folder (for macOS bundles) never breaks the build.
- `ci.yml`: fmt, clippy `-D warnings`, tests on Ubuntu/Windows/macOS, cargo-deny, web lint/typecheck/Vitest, Playwright E2E (server + `rustrmm-sim`), Docker build smoke test.
- `release.yml` (tag `v*`): macOS runner → universal agent + .pkg (+ signing/notarization); Linux → everything else via the Dockerfile stages (+ optional osslsigncode signing); signed agent bundle + multi-arch image → GHCR + GitHub Release (artifacts, SHA256SUMS, SBOM).
- Local equivalent without CI: `cargo xtask dist` on this PC builds the Windows agent natively, Linux agents via cargo-zigbuild (zig installed) and the MSI via wixl inside the Kali WSL distro (`apt install msitools`); macOS bundles come from CI or a Mac.

## 12. Phased delivery (each phase ends with a working demo)

| Phase | Scope | Demo |
|---|---|---|
| **0. Risk spikes** (throwaway, in `spikes/`) | (a) own ConPTY spawned from a LocalSystem service, incl. clean shutdown; (b) DXGI duplication from a SYSTEM-token helper in the user session across a UAC secure-desktop switch; (c) wixl MSI built in WSL that installs/starts a service which finds `deploy.key` via `InstallSource`; (d) cross-build of all artifacts (zigbuild, xwin, wixl). Spikes needing unavailable environments — GPO-assigned install in a Hyper-V DC lab, macOS stable-identity TCC test on a Mac/CI runner — run before their dependent phase and don't block. | Each spike proven on this PC / WSL; findings folded into the design. |
| **1. Foundation** | Workspace, lints, xtask, CI. Server: config, two listeners, TLS modes, SQLite + writer task + migrations + pre-migration backup, setup token + wizard + recovery kit, users/sessions/CSRF/TOTP/passkeys, RBAC with client/site scoping, hash-chained audit, **backups** (schedule, age encryption, local + S3, GFS retention, restore CLI/UI), OpenAPI + ts-rs codegen, embedded SPA, Dockerfile + compose. Web: Vite/React/TS/Tailwind/shadcn, design tokens, Command Rail shell (client switcher, Fleet Pulse, Ctrl+K, workspace tabs), login/MFA, setup wizard, Clients & Sites, Users & Roles, Audit, Backups, `/design` kitchen sink. | `cargo run` (and later `docker compose up`) → setup token → wizard → clients, sites, MFA users → audit trail → scheduled backup + restore drill. |
| **2. Agent core** | proto + crypto crates; agent service on Windows/Linux/macOS (`run --console` for dev); deploy keys, enrollment policies, approval queue; mutual-auth handshake; heartbeats/presence; collectors v1; metrics + rollups; offline queue; installers (MSI + GPO bundle + PowerShell one-liner, Linux and macOS install.sh); Devices grid; device cockpit (overview, hardware, software, storage, network, security, users, timeline); live Fleet Pulse; `rustrmm-sim` with realistic devices. | MSI on this Windows PC and the agent in WSL appear live with full inventory; the simulator adds 50 devices. |
| **3. Signed commands & self-update** | Command envelopes + replay protection; bundle import, manifest signing; rollouts (rings, %, auto-pause); unified binary-swap updater with health-check rollback; version compliance UI. Early, so every later phase updates lab agents remotely. | Bump the agent version → staged rollout updates real agents; a deliberately broken build rolls back automatically. |
| **4. Remote tools** | Tunnels; remote shell (ConPTY/PTY, xterm, recording + replay); file manager; processes, services, event logs, registry; power actions; message user; network diagnostics; screenshot; presence. | PowerShell on the Windows agent and bash on Linux from the browser; file transfer; service restart; transcript replay. |
| **5. Automation & policies** | Script library + editor, parameters, versions, approval workflow; variables + secrets; jobs (targets, now/scheduled/cron, offline-wait, live progress, per-device output); custom fields + directives; static/dynamic groups; policy inheritance; mass-action guard + four-eyes; starter script pack. | Dynamic group "Windows with < 15 % disk free" → scheduled cleanup job → results grid. |
| **6. Monitoring & alerts** | Agent check engine (all check types); server-side checks; alert lifecycle; alerts inbox; notification channels + rules + escalation; maintenance windows; auto-remediation. | Stop a service → alert in < 60 s → Slack/email → auto-restart remediation → auto-resolve. |
| **7. Patching & software** | WUA COM, Linux package updates, macOS report-only + user-approved installs; catalog/approvals/rings; maintenance windows; reboot prompts via helper; compliance dashboards; software explorer, library, deployments. | Approve patches for the pilot ring → window installs → compliance updates; deploy 7-Zip via winget to a group. |
| **8. Remote desktop** | Session helper (Windows session/secure-desktop handling; macOS LaunchAgent app + TCC state; Linux X11); capture; JPEG tiles → hardware/OpenH264 H.264 + WebCodecs; input incl. Ctrl+Alt+Del; clipboard; multi-monitor; consent + banner; viewer UI. | Control a Windows desktop through a UAC prompt; view and control a Linux X11 session. |
| **9. Ticketing** | Tickets, SLA, comments, contacts + email notifications, IMAP ingest, time entries, alert → ticket, tray "Request support", SLA dashboard. | An alert opens a ticket; a technician works it from the device tab; an end user submits one from the tray. |
| **10. Escrow + network** | BitLocker escrow, LAPS rotation, FileVault/LUKS attended flows, reveal UX; site probe, discovery scans, SNMP v2c/v3 templates, thresholds, graphs, trap receiver. | Reveal a BitLocker key (step-up + audit); discovery finds a printer; a low-toner alert fires. |
| **11. Reports, SSO, API, hardening** | Report library (typst PDF, client branding, scheduled email); customizable dashboard widgets; OIDC SSO; API tokens + public docs + webhooks; white-label; Noise IK channel; attended Wayland desktop; performance pass; security hardening + pentest-style review; full docs. | Monthly executive summary PDF emailed per client; SSO via Entra ID; an external script driving the API. |

## 13. Verification

- **Automated (every phase, in CI):** `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` (unit + integration on in-memory SQLite: API, authorization matrix, enrollment, handshake, replay/expiry rejection, backup/restore round-trip, migrations); agent collector tests on Windows/Linux/macOS runners; golden protocol fixtures + `rustrmm-sim` speaking older protocol versions; `cargo fuzz` targets for envelope/frame decoding; Vitest component tests; Playwright E2E (setup token → wizard → MFA login → simulated enrollment → script job → alert → ticket); cargo-deny + npm audit.
- **Lab (manual demos):**
  - This Windows PC: server via `cargo run`; agent MSI installed locally (service, inventory, shell, desktop, patching, self-update).
  - WSL2 (Kali, systemd enabled): Linux agent via install.sh, self-update + rollback; wixl MSI builds.
  - Hyper-V lab (Windows 11 Enterprise host): Windows Server DC + Windows 11 client to validate both GPO options, silent install, deploy-key domain restriction, self-update after a GPO install, GPO not re-running the package.
  - macOS: CI macOS runner smoke test (install → enroll against an ephemeral server → inventory); a physical Mac if available for desktop/TCC.
  - Docker: Docker Desktop on Windows and a Linux host — `docker compose up -d`, TLS modes, two-listener exposure, backups to `./backups` and S3, restore drill, image upgrade with pre-migration backup.
  - Scale: `rustrmm-sim --devices 1000` to confirm headroom (server CPU/RAM, grid responsiveness).
  - Security: OWASP ZAP baseline against the console, header/CSP checks, CSRF/session-fixation tests, tampered/replayed/expired command tests, revoked-device and cloned-key reconnect tests, setup-token enforcement, SSRF guard tests.

## 14. Key risks & mitigations

| Risk | Mitigation |
|---|---|
| Remote desktop complexity (Windows secure desktop, macOS TCC, Wayland) | Phase-0 spike on the secure desktop; own DXGI loop with desktop-switch handling and GDI fallback; macOS stable signing identity + permission-state UI; Wayland attended-only and last |
| ConPTY from a SYSTEM service | Own windows-rs implementation (token choice, Job-object cleanup, careful close/drain ordering); Phase-0 spike |
| MSI tooling | wixl only (one `.wxs`), built in Docker/WSL/MSYS2; no WiX licensing exposure; Phase-0 spike + Hyper-V GPO test |
| H.264 licensing | OS hardware encoders first, Cisco's runtime-downloaded OpenH264 binary second, JPEG tiles always available |
| SQLite write contention | Single batched writer, `BEGIN IMMEDIATE`, small-batch retention, named volume; target ≤ 1,000 devices |
| Unsigned agents blocked by AV/ASR/SmartScreen | Silent msiexec/GPO installs avoid SmartScreen; documented ASR/AV exclusions; one-command optional signing |
| Very large scope | Strict phase gates, each shippable; the simulator keeps UI work unblocked by agent work |
