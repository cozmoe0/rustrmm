# Security model

RustRMM assumes the network is hostile and that a compromised console is the worst-case event (an
RMM console is fleet-wide remote code execution). Controls are layered so one failure does not
expose the fleet.

## Trust anchors and transport

- **Server identity key (Ed25519)** — pinned by every agent from the deploy key. Every agent
  connection starts with a mutual challenge: the server signs `(agent_nonce, server_nonce,
  device_id, server_time)`, the agent verifies it, then proves possession of its device key. A
  TLS-intercepting proxy cannot impersonate the server.
- **TLS** — rustls only (AEAD + ECDHE suites; TLS 1.2 is allowed for Windows 10 Schannel clients
  such as PowerShell 5.1). In `internal` mode the server runs its own CA; deploy keys carry the CA's
  SPKI pin and agents trust *only* that CA afterwards (host name checked). `custom` mode supports
  AD CS certificates; `proxy` mode relies on the identity-key handshake.
- **Noise IK end-to-end channel** (`Noise_IK_25519_ChaChaPoly_BLAKE2s`, pure-Rust `snow`). Agents
  and servers that both support it wrap every frame after the identity handshake — control
  connection and tunnels — so a TLS-terminating proxy or inspection box sees only ciphertext. The
  server's static key is offered signed by the identity key and pinned by the agent after first
  use; the agent's static key is vouched for by its device key. Pinned agents refuse a different
  key or a session without the channel (downgrade). Required in `proxy` TLS mode. Each side rekeys
  after 1 GiB or one hour.
- **Separate keys** for identity, command signing and release signing, plus an age X25519 escrow
  key and the Noise static key. Private keys live wrapped (XChaCha20-Poly1305 under a
  master-derived key) in `/data/keys`, never in the database.

## Enrollment

- Deploy keys (`rrmm1_…`) are per-site enrollment tokens: expiry, maximum uses, allowed AD/DNS
  domains, allowed source networks, optional approval queue, revocable at any time.
- A deploy key on a GPO share is treated as semi-public; revoking it never affects enrolled agents.
- Duplicate hardware fingerprints (reinstall or clone) park the new device for approval; the same
  device key connecting from two addresses is flagged on the device timeline.
- The device key is generated on the endpoint (DPAPI machine scope on Windows, `0600` root file on
  Unix) and never leaves it. The agent data directory is restricted to SYSTEM/Administrators.
- MSI: prefer the sidecar `deploy.key` (nothing secret in installer logs). The `DEPLOY_KEY`
  property is written to a registry value locked to SYSTEM/Administrators and deleted after
  enrollment; verbose MSI logs can still record it, so treat such logs as sensitive.

## Commands and updates

- Every state-changing command is an Ed25519-signed envelope bound to the device, the current
  connection (handshake nonce), a strictly increasing sequence number and an expiry checked against
  server time. Forged, replayed, cross-device and expired commands are rejected (unit-tested).
- Agent releases: the server verifies artifact hashes on import and signs the exact manifest bytes
  with the release key. Agents verify the manifest signature, refuse downgrades, verify size and
  SHA-256 of the download, then a detached helper swaps the binary and rolls back automatically if
  the new version does not reconnect within three minutes. Rollouts auto-pause above a failure
  threshold.

## Remote tools

- Each remote action is a signed command; interactive and bulk traffic uses a separate tunnel
  socket the agent dials with a one-time token delivered inside that signed command.
- Permissions are split (`remote.shell`, `remote.files`, `remote.system`, `remote.power`,
  `remote.recordings`) and checked against the device's client/site scope. Opening a shell and
  reboot/shutdown/sign-out need a recent MFA step-up.
- Shells are recorded (asciicast v2 in `/data/recordings`), end on sign-out, session revocation,
  device revocation, 30 minutes without input or after 8 hours, and every open/close, file transfer,
  file change, process kill, service action and power action is in the audit log.
- Endpoints can lock features locally (`DISABLE_FEATURES=shell,files,system,power`); the agent
  refuses those commands whatever the server says.
- The agent starts shells with a fresh default environment (never its own), resolves shells and
  system tools to absolute system paths (never `PATH`), validates diagnostics targets and service
  names against option injection, puts every shell in a kill-on-close job (Windows) or its own
  session/process group (Unix), and refuses to modify file-system roots, `C:\Windows` or its own
  installation.

## Console

- Argon2id passwords (minimum 12 characters, deny-list, progressive lockout, rate limits).
- MFA is mandatory (TOTP with replay protection, passkeys, recovery codes stored as peppered HMACs).
- `__Host-` session cookies (Secure, HttpOnly, SameSite=Strict), stored only as SHA-256 hashes, idle
  and absolute expiry, revocable; CSRF header on every mutation; strict `Origin` checks; one-time
  30-second tickets for WebSockets.
- **Step-up** re-authentication for destructive or sensitive actions (deleting clients/sites/users,
  revoking devices, backup settings/downloads, agent rollouts, regenerating recovery codes).
- First-run setup is gated by a token printed to the server console, and ends with a recovery kit
  (master key + backup decryption identity) the owner must store.
- Strict CSP (`script-src 'self'`), HSTS, frame denial, no-referrer, COOP/CORP.

## Single sign-on, API tokens and webhooks

- **OIDC SSO** uses the authorization code flow with PKCE (S256), state and nonce in an encrypted,
  10-minute `__Host-` cookie, and verifies ID tokens against the provider's JWKS (signature,
  issuer, audience/azp, expiry, nonce; `none` and HMAC algorithms refused). Users are linked by
  subject, then by verified e-mail. Local MFA still applies unless the provider asserts MFA
  (`amr`/`acr`), and can be forced per provider. Global owners always keep password + MFA
  sign-in when SSO is enforced (break glass). The Owner role cannot be granted by SSO mappings.
- **API tokens** (`rrmm_pat_…`, 256-bit) are stored as SHA-256 hashes, carry a subset of the
  creator's permissions and clients, expire within a year, can be fenced to source networks,
  are rate limited (600/min) and audited (creation, revocation, sampled use). They can never
  step up, open shells/desktops/live streams, manage the account or mint tokens; creating one
  needs a console session with step-up.
- **Webhooks** are HMAC-SHA256 signed over `"<timestamp>.<body>"`, delivered only through the
  SSRF guard, and never carry secrets (secret reveals report who, what and why).
- **Branding uploads** are size-limited; SVGs are rebuilt from an allowlist (no scripts, event
  handlers, foreign objects, styles, images, links or external references) and served with a
  sandboxing CSP.

## RBAC and tenancy

~50 fine-grained permissions, built-in roles (Owner, Administrator, Technician, Help Desk, Auditor)
and custom roles, assigned globally or per client or per site. The access scope is enforced in the
server's queries, not only in the UI.

## Data at rest

- Sensitive columns (TOTP secrets, passkeys, S3 secrets, enrollment secrets) are field-encrypted
  with AAD bound to table/column/row.
- The audit log is append-only (database triggers) and hash-chained; the console can verify the
  chain.
- Backups are tar + zstd encrypted with age to a recipient whose private key exists only in the
  recovery kit, so the server can write backups but not read them. The master key is never included.

## Assurance

- **Authorization matrix test:** every API route (read from the router, so none can be missed) is
  called as each built-in role, a client-scoped technician, a user without roles, anonymously,
  without step-up and with an API token; expectations live in one table
  (`crates/server/tests/authz_matrix.rs`).
- **Fuzzing:** cargo-fuzz targets for agent frames and the Noise parsers, signed commands, deploy
  keys, tunnel and desktop messages and the rule engine; stable smoke tests run them in CI.
- **Headers and rate limits** are asserted per response type and per endpoint class
  (`crates/server/tests/hardening.rs`).
- **Supply chain:** `cargo deny` (advisories with written justifications for ignores, licence
  allowlist, bans on aws-lc-rs/OpenSSL), `npm audit`, CycloneDX SBOMs per release, GitHub Actions
  pinned by commit SHA, Dependabot.
- **Code signing** of agent binaries is optional (`docs/signing.md`); **Settings → Code signing**
  shows the Authenticode/Apple/minisign signer of every shipped file.

## Reporting a vulnerability

Please report security issues privately to the maintainers rather than opening a public issue.
