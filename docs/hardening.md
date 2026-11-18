# Hardening checklist for operators

An RMM server is fleet-wide remote code execution: whoever controls it controls every managed
device. RustRMM layers its defences (see `docs/security.md`); this checklist covers what you, the
operator, decide. Work through it at installation and review it every quarter.

## Network exposure

- [ ] Only the **agent gateway** (`8444`) is reachable from the internet. The **console** (`8443`)
      is reachable from admin networks, a VPN or an identity-aware proxy only
      (`docs/deployment.md` §4–5).
- [ ] Docker on Linux: the console port is bound to an internal address or filtered in
      `DOCKER-USER` (Docker bypasses ufw/firewalld for published ports).
- [ ] `RUSTRMM_TRUSTED_PROXIES` lists exactly your reverse proxies (never `0.0.0.0/0`), so audit
      logs, rate limits and deploy-key network fences see real client addresses.
- [ ] `RUSTRMM_DEV` is **not** set in production (it accepts `http://localhost` origins).
- [ ] Outbound traffic from the server is limited to what you use: SMTP, IMAP, S3, webhook and
      notification endpoints, OIDC providers.

## TLS and the agent channel

- [ ] Internal TLS mode: every host name and IP people use is in `RUSTRMM_EXTRA_SANS`, and the
      internal CA is deployed to admin workstations (no "click through the warning" habit).
- [ ] Proxy mode: `RUSTRMM_AGENT_NOISE` is left at its default (`required`), so agent traffic stays
      end-to-end encrypted past the proxy. `auto` only for a short migration of old agents.
- [ ] Custom mode: the certificate renews before it expires (the server does not renew custom
      certificates).
- [ ] `keys/noise.key`, `keys/identity.key` and the rest of `keys/` are covered by backups — losing
      them strands enrolled agents (`docs/backup-restore.md`).

## Secrets and recovery

- [ ] The recovery kit (master key + backup identity) is stored offline, in two places, and was
      **tested** with a restore drill.
- [ ] Hardened installs keep the master key outside the data volume (`RUSTRMM_MASTER_KEY_FILE`
      from a Docker secret or a root-only file).
- [ ] The data directory is readable only by the server account (Docker: named volume; native:
      `0700`, owner `rustrmm`).
- [ ] Backups go to S3 in another account with Object Lock, not only to the local disk.
- [ ] Old recovery kits and decrypted copies are destroyed.

## Accounts and access

- [ ] At most two **Owner** accounts (break glass), each with a passkey or TOTP plus recovery codes
      stored offline. Owners always keep password + MFA sign-in even when SSO is enforced.
- [ ] Day-to-day work uses **Administrator** or narrower roles; technicians of one customer get
      roles **scoped to that client** (or site), not global ones.
- [ ] **Auditor** for read-only reviewers; **Help Desk** for front-line staff (desktop and power
      only, no shell or scripts).
- [ ] SSO (OIDC) is configured with MFA enforced at the provider, or *require local MFA* is on for
      the provider. Group → role mappings never grant Owner (the server refuses it anyway).
- [ ] Leavers are disabled the same day (their sessions and API tokens stop working at once).
- [ ] Session lifetimes fit your policy (`RUSTRMM_SESSION_IDLE_MINUTES`, default 30;
      `RUSTRMM_SESSION_MAX_HOURS`, default 12).
- [ ] Review **Users & roles** and the role assignment scopes quarterly.

## Blast-radius controls

- [ ] **Automation settings:** the mass-action threshold is low enough that fleet-wide actions need
      typed confirmation and step-up; consider *four-eyes approval* for large jobs and *script
      approval* (scripts run only in an approved version).
- [ ] **Remote access policy** per client: consent prompts and allowed hours where customers
      require them.
- [ ] **Local capability locks** on sensitive machines: `DISABLE_FEATURES=shell,desktop,scripts` on
      domain controllers and other tier-0 systems (`docs/gpo.md` §3). The server cannot override
      them.
- [ ] Secrets escrow (BitLocker, LAPS): only a few people hold `secrets.reveal`; reveals need a
      reason and step-up and are audited — review them.

## API tokens and webhooks

- [ ] API tokens carry the smallest permission set and client scope, expire (default 90 days, at
      most one year), and are fenced to the caller's addresses (`allowed_cidrs`).
- [ ] Tokens are reviewed under **API tokens → all** (`api.manage`); unused ones are revoked.
      Tokens can never open shells or desktops, step up, manage accounts or mint tokens.
- [ ] Webhook receivers verify `X-RustRMM-Signature` (HMAC-SHA256 over `"<t>.<body>"`) and reject
      old timestamps; webhook targets on private networks are allowed explicitly
      (`webhook_allowlist`) only when needed.

## Deployment of agents

- [ ] Deploy keys used on shares (Group Policy) expire, have a maximum number of uses, are fenced
      to your AD/DNS domains and networks, and switch to *require approval* after the rollout.
- [ ] The approval queue is watched: a duplicate hardware fingerprint (clone, reinstall) parks the
      new device until someone approves, merges or rejects it.
- [ ] Revoked or retired devices are revoked in the console (their connections drop at once).
- [ ] Agent binaries are code-signed with your organisation's certificate where Defender ASR or
      Gatekeeper requires it (`docs/signing.md`), and **Settings → Code signing** shows the
      expected signer for every platform.
- [ ] Agent rollouts go to a pilot ring first; auto-pause stays enabled.

## Monitoring the server itself

- [ ] **Audit → Verify** shows an intact hash chain; the audit log is exported to your SIEM.
- [ ] Alerts for: new administrator, MFA reset, new API token, secret reveals, mass actions,
      failed backups (server log `backup failed`), sign-ins from new addresses.
- [ ] `/healthz` is monitored on both listeners; disk space for the data volume and backups is
      monitored.
- [ ] Device timelines are checked for `agent.duplicate_connection` (the same device key from two
      addresses: possible cloned agent), `agent.auth_failed` and `agent.noise_failed`.

## Updates and supply chain

- [ ] The server is updated promptly (`docker compose pull && docker compose up -d`); a
      pre-migration backup is taken automatically.
- [ ] Release artifacts are verified against `SHA256SUMS`; the CycloneDX SBOMs attached to each
      release (Rust and web) feed your vulnerability management.
- [ ] Building from source: `cargo deny check` and `npm audit --omit=dev` are clean, and GitHub
      Actions stay pinned by commit SHA (Dependabot proposes updates).

## Host

- [ ] The host OS receives security updates automatically; SSH/RDP to it is restricted to admins
      with MFA.
- [ ] Docker: the provided compose file is used unchanged in its security settings (read-only root
      filesystem, `cap_drop: [ALL]`, `no-new-privileges`, non-root user).
- [ ] Native Linux: the systemd unit's sandboxing options are kept (`docs/deployment.md` §2).
- [ ] Time is synchronised (NTP): signed commands expire against server time, TOTP needs a correct
      clock.
