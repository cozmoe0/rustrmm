# Roadmap

Each phase ends with something demoable end to end. Status as of 2026-11-18.

| Phase | Scope | Status |
|---|---|---|
| 0. Risk spikes | ConPTY from a SYSTEM service, DXGI capture across the secure desktop, wixl MSI + cross-builds (`spikes/*/FINDINGS.md`) | ✅ Done (elevated SCM runs of the ConPTY/DXGI spikes still to do) |
| 1. Foundation | Server core: TLS modes + internal CA, SQLite + migrations, setup token + wizard + recovery kit, sessions/CSRF/TOTP/passkeys, RBAC with client/site scoping, hash-chained audit, encrypted backups (local + S3, GFS, pre-migration, restore CLI), Docker image + compose. Web console shell, login/MFA, clients & sites, users & roles, audit, backups | ✅ Done |
| 2. Agent core | Protocol crate, deploy keys + enrollment policies + approval queue, mutual-auth gateway, heartbeats/presence, inventory collectors (Windows/Linux/macOS), metrics + rollups, health score, device timeline, installers (MSI + GPO bundle + PowerShell/shell one-liners), fleet simulator, devices/cockpit/deploy UI | ✅ Done |
| 3. Signed commands & self-update | Ed25519 command envelopes bound to device/connection/sequence/expiry, release import + manifest signing, staged rollouts with auto-pause, binary-swap updater with health check and rollback | ✅ Core done; releases UI and elevated install test pending |
| 4. Remote tools | Tunnels, remote shell with recording, file manager, processes/services/event logs/registry, power actions, user messages, network diagnostics ([API](api-remote.md)) | ✅ Done — verified end to end against a live Windows agent; Linux tools and PTY verified with `rustrmm-agent selftest` |
| 5. Automation & policies | Script library (49 built-in scripts), variables/secrets, jobs (now/once/cron, offline wait), custom fields + script directives, static/dynamic groups, policy inheritance with origins, mass-action guard + four-eyes ([API](api-automation.md)) | ✅ Done — verified against a live Windows agent |
| 6. Monitoring & alerts | Agent check engine, server-side checks, alert lifecycle and inbox, notification channels, maintenance windows, auto-remediation ([API](api-monitoring.md)) | ✅ Done — 18 check types; verified against a live Windows agent |
| 7. Patching & software | Windows Update (WUA COM), Linux package managers, macOS report-only, approvals/rings/windows, software explorer and deployments ([API](api-patching.md)) | ✅ Done — live WUA scan verified; installs/reboots not exercised on a real machine |
| 8. Remote desktop | Session helper, DXGI capture following UAC/sign-in desktops, X11, JPEG tiles with dirty/move rects, input, clipboard, consent, banner ([API](api-desktop.md)) | ✅ Done — live session verified (2560×1440, 2 monitors, DXGI, ~21 fps); SYSTEM-mode helper, secure desktop and SendSAS need an elevated test |
| 9. Ticketing | Tickets, SLAs, contacts, email-to-ticket, time entries, agent "Request support" ([API](api-tickets.md)) | ✅ Done — verified live (tickets, replies with attachments, SLA pause, alert-to-ticket, time report, headless agent support request); support dialogs and real SMTP/IMAP untested |
| 10. Escrow + network | BitLocker escrow, LAPS rotation, discovery scans, SNMP monitoring ([API](api-escrow-network.md)) | ✅ Done — verified live (probe, host-only scan with live progress, asset matched to its agent, SNMP credentials, unreachable alert, topology, escrow coverage); BitLocker reads with admin rights, LAPS rotation, the FileVault attended flow and SNMPv3 traps not exercised |
| 11. Reports, SSO, API, hardening | PDF reports + schedules, dashboards, OIDC SSO, API tokens + OpenAPI docs + webhooks, branding, Noise IK channel, code-signing tooling, hardening pass ([API](api-platform.md); guides: [deployment](deployment.md), [hardening](hardening.md), [backup/restore](backup-restore.md), [GPO](gpo.md), [signing](signing.md)) | ✅ Done — console verified live (dashboard Home, report viewer, API tokens, webhooks with the SSRF guard, SSO provider and login button, branding, code-signing status); Noise IK verified live (real agent: handshake, key pin reused across restarts, a tampered pin refused, signed commands over the wrapped channel) and in tests (tunnels, rekey, pin mismatch, downgrade, legacy agents); Authenticode/MSI signer detection verified against real signed files; authorization matrix over all 353 routes; `cargo deny` clean; attended Wayland desktop moved to the gaps below |

## Known gaps / next verifications

- dnf5 parsing is covered by fixtures; not yet run against a live Fedora 41+ host.
- SSO verified against an in-process fake issuer (ES256/RS256); not yet against Entra ID, Google, Okta or Keycloak.
- PDF reports use the standard Helvetica font, so text outside Latin-1 is replaced and SVG logos are left out (PNG logos embed). The executive-summary health trend starts from the first day the server records it (no backfill).
- Report and alert e-mail, and email-to-ticket, have not been run against a real SMTP/IMAP server.
- Generated API types (`web/src/lib/api/openapi.gen.ts`, from the `web/openapi.json` snapshot) sit beside the hand-written `types.ts`; adopt them gradually. Some older routes still describe their request bodies loosely in the spec.

- Install the MSI elevated on a real machine and run a full self-update with rollback (needs an administrator prompt).
- Group Policy deployment in a lab domain (Software Installation with sidecar `deploy.key`, startup script).
- Docker: the full image build (console, agents for three targets, MSI, server) and `docker compose up` were verified on Docker Desktop (linux/amd64); a native Linux host and a multi-arch `buildx` build are still to run.
- macOS agent build and test on a Mac or CI macOS runner.
- Remote shell as the signed-in user (per-session broker, spike recommendation) — shells currently run as SYSTEM/root.
- Remote shell and tools under the real Windows service (LocalSystem) and on Linux/macOS hosts; verified so far from a foreground agent.
- Agent VERSIONINFO resource so an MSI repair can never put an older exe back (spike finding 3).
- **Attended Wayland remote desktop** (portal/PipeWire helper): out of scope for Phase 11; Linux
  remote desktop supports X11 sessions only (`selftest` reports Wayland sessions as unsupported).
- **Code signing with real certificates:** `cargo xtask sign` (osslsigncode/signtool/Azure dlib,
  codesign + notarytool, minisign) and `packaging/windows/sign.sh` were exercised only for the
  "not configured" and "tool missing" paths; no certificate, token, Azure account or Apple account
  was available. The signing-status parser was checked against real Authenticode-signed exes and
  MSIs. MSI digests are not recomputed (signer only).
- **Release workflow** (`.github/workflows/release.yml`: SBOMs, bundle export, multi-arch image,
  macOS signing, GitHub release) has not run on GitHub yet; the Docker signing step ran only
  without secrets (unsigned path).
- **cargo-fuzz** targets build on stable (`cargo check` of `fuzz/`) and run as stable smoke tests;
  no nightly toolchain was available, so no libFuzzer campaign has been run yet.
- **Noise key rotation:** agents pin the server's Noise key permanently; rotating `keys/noise.key`
  needs a procedure (dual keys or a signed re-pin). Losing it requires deleting
  `server-noise.pub` on agents or re-enrolling (`docs/backup-restore.md`).
- **Authorization matrix fixtures:** approvals, escrow items, patch runs, software deployments,
  remote sessions, rollouts and SSO providers are addressed with placeholder ids (no seeded row),
  so denials on those id routes are accepted as `404`.
- `chrono` / `chrono-tz` are flagged unmaintained (RUSTSEC-2026-0543/0555, ignored with
  justification in `deny.toml`); plan a replacement once sqlx, croner and object_store move.
- `rsa` 0.10 release candidate via webauthn-rs (RUSTSEC-2023-0071, verification only) — upgrade when
  webauthn-rs drops the pinned release candidate.
- Server as a native Windows service (deployment guide uses a scheduled task), agent HTTP proxy
  support, and backup-recipient rotation in the console.
