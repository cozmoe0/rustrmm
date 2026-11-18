# Deploying RustRMM

RustRMM is one binary, `rustrmm-server`, with the web console embedded. It keeps everything in one
data directory (SQLite database, wrapped keys, PKI, uploaded files) and serves two listeners:

| Listener | Default | Serves | Who should reach it |
|---|---|---|---|
| Console | `0.0.0.0:8443` (`RUSTRMM_CONSOLE_BIND`) | Web console, REST API (`/api/v1`), API docs, `/healthz` | Administrators: LAN, VPN or a zero-trust proxy. **Do not publish it to the internet.** |
| Agent gateway | `0.0.0.0:8444` (`RUSTRMM_AGENT_BIND`) | Enrollment, the agents' control and tunnel WebSockets, installer and update downloads, support requests, `/healthz` | Every managed device, usually from anywhere. The only port to publish. |

`RUSTRMM_SINGLE_LISTENER=true` serves both on the console listener (labs, small LAN-only setups).
An optional third listener (`RUSTRMM_HTTP_BIND`, e.g. `0.0.0.0:8080`) only redirects HTTP to HTTPS.

Every option is a flag or an environment variable (`rustrmm-server --help`); this guide uses the
variables.

## 1. Docker Compose (Linux or Windows)

The image (`deploy/Dockerfile`) contains the server and an agent bundle (Windows exe + MSI, Linux
x86-64/ARM64). It runs as UID 65532 on a read-only root filesystem with all capabilities dropped.

### Linux host

```bash
git clone <your fork> rustrmm && cd rustrmm/deploy
cp .env.example .env            # set RUSTRMM_CONSOLE_URL, RUSTRMM_AGENT_URL, RUSTRMM_TLS_MODE
mkdir -p backups && sudo chown 65532:65532 backups
docker compose up -d --build    # or: set RUSTRMM_IMAGE=ghcr.io/<owner>/rustrmm-server:<version>, docker compose pull
docker compose logs rustrmm     # the first start prints a setup token in a box
```

Open `RUSTRMM_CONSOLE_URL`, enter the token and finish the wizard (owner account, MFA, first
client and site, **recovery kit**). Keep the recovery kit offline: it holds the master key and the
only key that can decrypt backups.

### Windows host (Docker Desktop with the WSL 2 engine)

```powershell
cd rustrmm\deploy
Copy-Item .env.example .env      # edit with Notepad
docker compose up -d --build
docker compose logs rustrmm
```

- The database lives in the named volume `rustrmm-data`. Never replace it with a bind mount to a
  Windows folder: SQLite needs file locking that Windows bind mounts do not provide.
- `./backups` is a bind mount on purpose (easy to copy off the machine).
- Docker Desktop publishes ports on all interfaces. Restrict the console port with the Windows
  firewall (section 5) or bind it to one address: `"192.168.10.5:443:8443"` in
  `docker-compose.yml`.
- Docker Desktop must start at boot (Settings → General → *Start Docker Desktop when you sign
  in*, plus automatic sign-in of a service account, or use Docker Engine inside a WSL distribution
  started by a scheduled task) — otherwise agents lose the server after a reboot.

### Hardened master key

By default the master key is generated in `/data/keys/master.key`. To keep it outside the data
volume (recommended), create it once and pass it as a Docker secret:

```bash
mkdir -p secrets && openssl rand -base64 32 > secrets/master.key
sudo chown 65532 secrets/master.key && chmod 400 secrets/master.key
```

Uncomment the `environment`/`secrets` blocks in `docker-compose.yml`
(`RUSTRMM_MASTER_KEY_FILE=/run/secrets/master_key`). An explicitly configured key file must exist:
the server refuses to start rather than invent a new key.

### Upgrades

```bash
docker compose pull && docker compose up -d     # published image
git pull && docker compose up -d --build         # building from source
```

The server takes an automatic backup before any database migration, then migrates, then imports
the new agent bundle and offers it for rollout (**Devices → Agent releases**).

## 2. Native install

Build the release binary with the console embedded (Rust toolchain from `rust-toolchain.toml`,
Node.js 22+):

```bash
cargo xtask server        # → target/release/rustrmm-server(.exe)
cargo xtask dist          # optional: agent bundle in dist/agents (see docs/development.md)
```

### Linux (systemd)

```bash
sudo useradd --system --home /var/lib/rustrmm --shell /usr/sbin/nologin rustrmm
sudo install -m 0755 target/release/rustrmm-server /usr/local/bin/
sudo install -d -o rustrmm -g rustrmm -m 0700 /var/lib/rustrmm /var/backups/rustrmm
sudo cp -r dist/agents /opt/rustrmm-agents     # optional agent bundle
```

`/etc/systemd/system/rustrmm.service`:

```ini
[Unit]
Description=RustRMM server
After=network-online.target
Wants=network-online.target

[Service]
User=rustrmm
Group=rustrmm
Environment=RUSTRMM_DATA_DIR=/var/lib/rustrmm
Environment=RUSTRMM_BACKUP_DIR=/var/backups/rustrmm
Environment=RUSTRMM_AGENT_DIST=/opt/rustrmm-agents
Environment=RUSTRMM_CONSOLE_URL=https://rmm.example.internal
Environment=RUSTRMM_AGENT_URL=https://agents.example.com:8444
Environment=RUSTRMM_LOG_FORMAT=json
ExecStart=/usr/local/bin/rustrmm-server
Restart=on-failure
# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/rustrmm /var/backups/rustrmm
CapabilityBoundingSet=
AmbientCapabilities=
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
LockPersonality=true
MemoryDenyWriteExecute=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now rustrmm
journalctl -u rustrmm -f        # setup token on first start
```

Ports below 1024 need either a reverse proxy, a firewall redirect (`nft`/`iptables` 443 → 8443) or
`AmbientCapabilities=CAP_NET_BIND_SERVICE` — keep the default ports and redirect instead.

### Windows

The server has no Windows service mode yet (see the roadmap). Run it at boot as a scheduled task
under a dedicated local account:

```powershell
New-Item -ItemType Directory C:\RustRMM\data, C:\RustRMM\backups | Out-Null
Copy-Item target\release\rustrmm-server.exe C:\RustRMM\
icacls C:\RustRMM\data /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" "rustrmm-svc:(OI)(CI)M"
$action  = New-ScheduledTaskAction -Execute C:\RustRMM\rustrmm-server.exe `
  -Argument '--data-dir C:\RustRMM\data --backup-dir C:\RustRMM\backups --console-url https://rmm.corp.example --log-format json'
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit 0
Register-ScheduledTask RustRMM -Action $action -Trigger $trigger -Settings $settings -User 'rustrmm-svc' -Password (Read-Host 'password')
```

The server logs to standard output only, which a scheduled task discards. Run it once
interactively with the same arguments to read the setup token and finish the wizard, stop it,
then start the task.

## 3. TLS modes

| Mode | `RUSTRMM_TLS_MODE` | Certificates | Agents trust | When |
|---|---|---|---|---|
| Internal CA | `internal` (default) | The server creates a CA in `<data>/pki` and a leaf for the console/agent host names plus `RUSTRMM_EXTRA_SANS`; renews automatically with a stable key | **Only** the internal CA (its SPKI pin is in the deploy key) | Most installations |
| Custom | `custom` | `RUSTRMM_TLS_CERT` (chain, PEM) and `RUSTRMM_TLS_KEY`, e.g. from Active Directory Certificate Services | The operating system trust store | Domain environments with an internal PKI |
| Proxy | `proxy` | None: plain HTTP behind your TLS-terminating reverse proxy | The proxy's certificate (system trust store) | Let's Encrypt via Caddy/Traefik/nginx, existing load balancers |

In every mode each agent connection starts with the identity handshake: the server signs a
challenge with its Ed25519 identity key, which agents pinned at enrollment, so a TLS-intercepting
proxy cannot impersonate the server.

**Internal mode:** browsers warn until administrators trust the CA. Download it from
`https://<console>/api/v1/system/ca.crt` and deploy it to admin workstations (Group Policy:
Computer Configuration → Policies → Windows Settings → Security Settings → Public Key Policies →
Trusted Root Certification Authorities). Add every name or IP people use to
`RUSTRMM_EXTRA_SANS`.

### Proxy mode and the Noise channel

In proxy mode the proxy terminates TLS and could read agent traffic (commands, shell and desktop
streams). RustRMM therefore wraps every agent frame — control connection and tunnels — in a
**Noise IK** end-to-end channel (`Noise_IK_25519_ChaChaPoly_BLAKE2s`) between the agent and the
server. It is negotiated with every agent that supports it in all modes, and **required** in proxy
mode: agents without the `noise` capability are refused with `noise_required`
(`RUSTRMM_AGENT_NOISE=required` is the default there; `auto` accepts older agents during a
migration, at the cost of the proxy seeing their traffic). Agents pin the server's Noise key on
first use; it lives in `<data>/keys/noise.key` and is part of every backup. See
`docs/api-platform.md` for the protocol.

Reverse proxy requirements:

- WebSocket upgrades on `/agent/v1/connect` and `/agent/v1/tunnel/*` (and `/api/v1/stream`,
  `/api/v1/remote-sessions/*/ws` on the console).
- Request bodies up to 32 MiB on the agent site (inventory, uploads) and 16 MiB on the console.
- Long timeouts: the control connection stays open for days; ping every 30 s keeps it alive.
- Set `RUSTRMM_TRUSTED_PROXIES` to the proxy's addresses so audit logs and enrollment network
  restrictions see real client IPs (`X-Forwarded-For`).

Caddy example (automatic Let's Encrypt; two sites, two upstream ports):

```caddyfile
rmm.example.com {
    @admins remote_ip 10.0.0.0/8 192.168.0.0/16
    handle @admins {
        reverse_proxy 127.0.0.1:8443
    }
    respond 403
}

agents.example.com {
    request_body {
        max_size 32MB
    }
    reverse_proxy 127.0.0.1:8444
}
```

```bash
RUSTRMM_TLS_MODE=proxy
RUSTRMM_CONSOLE_URL=https://rmm.example.com
RUSTRMM_AGENT_URL=https://agents.example.com
RUSTRMM_TRUSTED_PROXIES=127.0.0.1/32
```

nginx equivalent for the agent site:

```nginx
server {
    listen 443 ssl http2;
    server_name agents.example.com;
    client_max_body_size 32m;
    location / {
        proxy_pass http://127.0.0.1:8444;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_read_timeout 1d;
        proxy_send_timeout 1d;
    }
}
```

Switching an existing installation between modes changes how agents validate TLS: agents enrolled
in `internal` mode trust only the internal CA. Plan such a move by re-issuing deploy keys and
reinstalling, or keep the internal CA on the agent listener and use the proxy for the console only.

## 4. Exposing the two listeners

Recommended layout for an MSP:

```text
             internet                         management network / VPN
                │                                        │
      public DNS agents.example.com               rmm.example.internal
                │ TCP 443                                │ TCP 443
        ┌───────┴────────┐                       ┌───────┴───────┐
        │ firewall / NAT │  443 → host:8444      │  admin hosts  │ → host:8443
        └───────┬────────┘                       └───────────────┘
                │
          rustrmm-server  (console 8443 — never forwarded)
```

- Forward only the agent port. Agents need nothing else inbound; they never listen on any port.
- The console has its own login rate limits, MFA and step-up, but an RMM console is fleet-wide
  remote code execution: keep it behind your VPN or an identity-aware proxy.
- `RUSTRMM_AGENT_URL` is written into every deploy key; choose a stable public name. Additional
  URLs can be added for failover later (agents try them in order).
- The agent gateway is safe to expose: enrollment needs a deploy key (rate limited to 120 attempts
  per minute per address, deploy keys can be fenced to networks and AD/DNS domains), and the
  control connection needs a device key.

## 5. Firewall rules

| Direction | Port | Purpose |
|---|---|---|
| Inbound | TCP 8444 (or 443 mapped to it) | Agents, from anywhere your devices are |
| Inbound | TCP 8443 (or 443 mapped to it) | Console, from admin networks only |
| Inbound | TCP 8080 | Optional HTTP redirect |
| Outbound | TCP 443 | S3 backups, webhooks, notification channels (Slack/Teams/…), OIDC providers |
| Outbound | TCP 587/465 | SMTP (notifications, reports, ticket replies) |
| Outbound | TCP 993 | IMAP (e-mail to ticket) |

Linux (ufw):

```bash
sudo ufw allow 8444/tcp comment 'RustRMM agents'
sudo ufw allow from 10.20.0.0/16 to any port 8443 proto tcp comment 'RustRMM console (admins)'
```

firewalld:

```bash
sudo firewall-cmd --permanent --add-port=8444/tcp
sudo firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=10.20.0.0/16 port port=8443 protocol=tcp accept'
sudo firewall-cmd --reload
```

Windows (PowerShell, elevated):

```powershell
New-NetFirewallRule -DisplayName 'RustRMM agents' -Direction Inbound -Protocol TCP -LocalPort 8444 -Action Allow
New-NetFirewallRule -DisplayName 'RustRMM console (admins)' -Direction Inbound -Protocol TCP -LocalPort 8443 `
  -RemoteAddress 10.20.0.0/16 -Action Allow
```

Docker on Linux bypasses ufw for published ports; restrict the console by binding it to an internal
address in `docker-compose.yml` (`"10.20.0.5:443:8443"`) or with rules in the `DOCKER-USER` chain.

Endpoints need outbound TCP to the agent URL only (plus the same URL for updates and installers).

## 6. Health and monitoring

- `GET /healthz` on either listener returns `200 {"status":"ok"}` when the database answers (Docker
  healthcheck: `rustrmm-server healthcheck`, add `--plain` in proxy mode).
- `GET /api/v1/system/health` (signed in, `settings.view` installation-wide) adds version, uptime,
  database and WAL sizes, connected agents and the TLS mode.
- Logs go to stdout; `RUSTRMM_LOG_FORMAT=json` for log shippers. The audit log (console → Audit)
  is hash-chained; export it to your SIEM regularly.

Continue with `docs/hardening.md` (operator checklist), `docs/backup-restore.md`, `docs/gpo.md` and
`docs/signing.md`.
