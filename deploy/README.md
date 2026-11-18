# Deploying RustRMM with Docker Compose

The image contains a single static binary (`/app/rustrmm-server`) with the web console embedded.
It runs as an unprivileged user on a read-only root filesystem with all capabilities dropped.

## First start

```bash
cd deploy
cp .env.example .env
docker compose up -d --build
docker compose logs rustrmm    # look for the "first-run setup" box with the setup token
```

Browse to `RUSTRMM_CONSOLE_URL`, enter the token, and complete the wizard:

1. Organization name, your owner account (min. 12-character password).
2. The first client and site.
3. **Recovery kit** — download it and keep it offline. It contains:
   - the **master key**, which unlocks the server's private keys and encrypted settings;
   - the **backup identity** (`AGE-SECRET-KEY-1…`), the only key that can decrypt backups.
4. Sign in and enroll an authenticator app (MFA is mandatory).

## Ports

| Container | Default host | Purpose |
|---|---|---|
| 8443 | 443 | Web console and REST API. Keep it reachable from your LAN/VPN only. |
| 8444 | 8444 | Agent gateway. The only port to publish for off-site devices (map public 443 → 8444 on your firewall). |
| 8080 | — | Optional HTTP→HTTPS redirect (`RUSTRMM_HTTP_BIND=0.0.0.0:8080`). |

## TLS modes (`RUSTRMM_TLS_MODE`)

- **internal** (default) — a private CA is created under `/data/pki`; the server certificate covers
  the console/agent host names plus `RUSTRMM_EXTRA_SANS` and renews automatically. Download the CA
  from `https://<console>/api/v1/system/ca.crt` and deploy it to admin workstations (e.g. via Group
  Policy) to remove browser warnings. Agents pin it automatically.
- **custom** — mount a certificate and key (for example issued by Active Directory Certificate
  Services, already trusted by domain machines) and set `RUSTRMM_TLS_CERT` / `RUSTRMM_TLS_KEY`.
- **proxy** — the server speaks plain HTTP for a TLS-terminating reverse proxy. Set
  `RUSTRMM_TRUSTED_PROXIES` so client IPs in the audit log are correct. Agents must support the
  Noise IK end-to-end channel in this mode (`RUSTRMM_AGENT_NOISE=required` by default), so the
  proxy never sees agent traffic in clear.

The full guides are in `docs/deployment.md`, `docs/hardening.md` and `docs/backup-restore.md`.

## Master key handling

By default the server generates the master key inside the data volume on first start (and shows
it in the recovery kit). For a hardened install keep it outside the volume:

```bash
mkdir -p secrets
openssl rand -base64 32 > secrets/master.key          # Linux/macOS
# PowerShell: [Convert]::ToBase64String((1..32 | % {[byte](Get-Random -Max 256)})) > secrets\master.key
```

Then uncomment the `environment`/`secrets` blocks in `docker-compose.yml`. On Linux make sure the
container user can read it: `sudo chown 65532 secrets/master.key && chmod 400 secrets/master.key`.

## Backups

Backups run on the schedule configured in **Settings → Backups** (default 02:00 daily) and before
every database upgrade. Archives are written to `./backups` and optionally an S3-compatible bucket.
A copy on the same host is not a real backup — configure S3 (ideally with Object Lock).

On Linux, the bind-mounted `./backups` directory must be writable by UID 65532:

```bash
mkdir -p backups && sudo chown 65532:65532 backups
```

### Restoring

```bash
docker compose stop rustrmm
docker compose run --rm -v "$PWD/restore:/restore" rustrmm restore \
  --file /backups/rustrmm-backup-YYYYMMDD-HHMMSS-xxxxxxxx.tar.zst.age \
  --identity-file /restore/backup-identity.txt
docker compose start rustrmm
```

`backup-identity.txt` holds the `AGE-SECRET-KEY-1…` line from your recovery kit. The previous data
is moved aside to `/data/pre-restore-<timestamp>`. When restoring onto a new machine, install the
master key from the recovery kit first.

## Upgrading

```bash
docker compose pull   # or: git pull && docker compose build
docker compose up -d
```

The server takes an automatic backup before applying any database migration.
