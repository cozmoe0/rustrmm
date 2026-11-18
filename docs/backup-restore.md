# Backup and restore

RustRMM backs itself up: on a schedule, on demand, and automatically before every database
migration. Backups are encrypted so that the server can **write** them but cannot **read** them.

## What a backup contains

Each backup is one file, `rustrmm-backup-<YYYYMMDD-HHMMSS>-<id>.tar.zst.age`:

| Entry | Content |
|---|---|
| `manifest.json` | Server version, schema version, creation time, trigger |
| `rustrmm.db` | A consistent `VACUUM INTO` snapshot of the SQLite database, verified with `PRAGMA integrity_check` before it is packed |
| `keys/*` | The server's private keys — identity, command signing, release signing, escrow, Noise channel — **still wrapped by the master key**. `master.key` itself is never included |
| `pki/*` | The internal CA and leaf certificate (internal TLS mode), wrapped the same way |
| `files/*` | Optional (`include_files`): uploaded blobs — software packages, ticket attachments, branding files. Shell recordings are not included |

The tar stream is compressed with zstd and encrypted with **age** to an X25519 recipient. The
matching identity (`AGE-SECRET-KEY-1…`) was shown **once**, in the recovery kit at the end of the
setup wizard, and is not stored on the server. Restoring therefore needs two secrets from the
recovery kit:

1. the **backup identity** — decrypts the archive;
2. the **master key** — unwraps the keys inside it (and decrypts field-encrypted settings such as
   SMTP, S3 and SNMP credentials, TOTP secrets and passkeys).

If either is lost, backups cannot be used. Store the recovery kit offline (password manager vault
plus a printed copy in a safe) and test a restore before you need it.

## Configure

**Settings → Backups** (`GET`/`PUT /api/v1/settings/backups`, `backups.manage`; changes need a
recent MFA step-up):

| Setting | Default | Notes |
|---|---|---|
| Schedule | `0 2 * * *` (02:00 daily, server time zone `TZ`) | Any cron expression; hourly (`0 * * * *`) for busy installations |
| Retention | 24 hourly, 14 daily, 8 weekly, 12 monthly | Grandfather-father-son: the newest backup of each hour/day/ISO week/month is kept up to these counts; the five most recent pre-migration backups are always kept on top |
| Local copy | on | Written to `RUSTRMM_BACKUP_DIR` (default `<data>/backups`; Docker: `/backups`, bind-mounted to `deploy/backups`) |
| S3 | off | Any S3-compatible service: AWS, Backblaze B2, Wasabi, MinIO, Cloudflare R2. Endpoint, region, bucket, prefix, access key; the secret key is stored field-encrypted |
| Include files | off | Adds uploaded files; backups grow accordingly |

**A copy on the same host is not a backup.** Configure S3, ideally a bucket in another account
with versioning and **Object Lock** (compliance or governance mode, default retention at least as
long as your daily retention) so a compromised server cannot delete its own history. Object Lock is
configured on the bucket by the storage provider; RustRMM writes objects normally and the
bucket's default retention applies. Give the access key only `s3:PutObject`, `s3:GetObject`,
`s3:ListBucket` and `s3:DeleteObject` on the prefix (deletes are refused by Object Lock during the
retention period, which is what you want).

**Test the S3 settings** with **Test connection** (`POST /api/v1/backups/test-s3`): it writes and
deletes a small probe object.

## Run, list, download

- **Run now:** `POST /api/v1/backups` (or the button). Runs are serialised; the result appears in
  the list with size, SHA-256 and destinations.
- **List:** `GET /api/v1/backups` (`backups.view`).
- **Download:** `GET /api/v1/backups/{id}/download` (`backups.manage` + step-up). The file is still
  encrypted.
- **Delete:** `DELETE /api/v1/backups/{id}` (`backups.manage` + step-up).

Every run, download and deletion is in the audit log. A failed scheduled backup raises an error in
the server log; watch for `backup failed` in your log monitoring.

## Restore

Restores are done offline with the server stopped, from the command line.

### 1. Prepare

- The backup file (`.tar.zst.age`) — from the local directory, S3, or a download.
- `backup-identity.txt` containing the `AGE-SECRET-KEY-1…` line from the recovery kit.
- The master key from the recovery kit (base64, one line) when restoring onto a **new** machine or
  a fresh data directory.

### 2a. Docker

```bash
cd deploy
docker compose stop rustrmm
mkdir -p restore && cp ~/backup-identity.txt restore/
# New machine only: put the master key in place first (hardened layout: secrets/master.key;
# default layout: it lives in the data volume at /data/keys/master.key)
docker compose run --rm -v "$PWD/restore:/restore" rustrmm restore \
  --file /backups/rustrmm-backup-20261118-020000-0193….tar.zst.age \
  --identity-file /restore/backup-identity.txt
docker compose start rustrmm
shred -u restore/backup-identity.txt          # do not leave the identity on the server
```

To restore a downloaded file, copy it into `deploy/backups/` first (it is mounted at `/backups`).

On a new machine with the default master-key layout, write the key into the volume before
restoring:

```bash
docker volume create rustrmm_rustrmm-data
docker run --rm -v rustrmm_rustrmm-data:/data -v "$PWD/restore:/restore" busybox \
  sh -c 'mkdir -p /data/keys && cp /restore/master.key /data/keys/master.key && chown -R 65532:65532 /data'
```

### 2b. Native

```bash
sudo systemctl stop rustrmm
sudo -u rustrmm rustrmm-server restore \
  --file /var/backups/rustrmm/rustrmm-backup-….tar.zst.age \
  --identity-file /root/backup-identity.txt \
  --data-dir /var/lib/rustrmm
sudo systemctl start rustrmm
```

Windows: `rustrmm-server.exe restore --file … --identity-file … --data-dir C:\RustRMM\data`.

### What the restore does

1. Takes the data directory's lock (fails if a server is still running on it).
2. Decrypts and unpacks the archive into a staging folder and runs `PRAGMA integrity_check` on the
   database.
3. Moves the current `rustrmm.db` (+ `-wal`, `-shm`), `keys/`, `pki/` and, when the backup has
   them, `files/` to `pre-restore-<timestamp>/` — nothing is deleted.
4. Moves the restored database, keys and PKI into place, keeping an existing `keys/master.key`.

Start the server normally afterwards. If the backup came from an older version, the usual startup
migrations bring it up to date (taking a fresh pre-migration backup first).

### After a restore

- **Agents** reconnect on their own: device keys live on the endpoints, and the restored key ring
  contains the same identity and Noise keys they pinned. Devices enrolled *after* the backup was
  taken are unknown to the restored server; re-enroll them.
- **Commands, jobs and alerts** in flight after the backup time are lost; check scheduled jobs and
  rollouts.
- **Sessions** created after the backup no longer exist; users sign in again.
- **Restoring onto a different host name or IP:** internal-mode certificates are re-issued
  automatically for the configured names, but deploy keys and enrolled agents contain the old
  agent URL — keep the old DNS name pointing at the new server.

### Disaster checklist

| Lost | Consequence | Recovery |
|---|---|---|
| The server (disk, VM) | — | New host, install, restore the latest backup with the recovery kit |
| The master key, but you have the data directory | Keys and encrypted settings cannot be unwrapped | Restore needs the master key too — there is no recovery without it. Keep it in the recovery kit |
| The backup identity | Backups cannot be decrypted | Existing backups are unusable. Rotating the backup recipient is not in the console yet (see the roadmap), so the recovery kit is the only copy — keep it safe |
| `keys/noise.key` only | Agents that pinned the old Noise key refuse the new one (`PinMismatch` in the agent log) | Restore `keys/` from a backup; otherwise delete `server-noise.pub` in each agent's data directory (`C:\ProgramData\RustRMM\Agent`, `/var/lib/rustrmm`) through another management channel, or re-enroll |
| `keys/identity.key` | Agents refuse the server (identity verification fails) | Restore from backup; otherwise every agent must be re-enrolled |

## Test restores

Schedule a quarterly drill: restore the latest backup on a scratch VM or container (no network
access to agents), start it, sign in, check device counts and the audit log's integrity
verification (**Audit → Verify**), then destroy the copy. The drill proves that the recovery kit
is complete and that backups are readable.
