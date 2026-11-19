# Agent updates

How device agents follow the server when you upgrade it, and the API behind **Devices → Agent
updates**.

## How a server upgrade reaches the agents

1. **Build.** `docker compose up -d --build` (or `docker buildx build -f deploy/Dockerfile …`)
   compiles the agents and the server with a *build stamp*: the UTC build time as
   `YYYYMMDDHHMMSS`. Both report `<workspace version>+<stamp>`, for example
   `0.1.0+20261118220341`. Pin the stamp with `--build-arg RUSTRMM_BUILD_ID=<digits>`. The stamp
   layer is cached until the sources change, so rebuilding unchanged sources keeps the old stamp
   and does not create a new release. `cargo xtask dist` stamps development bundles the same way.
2. **Import.** When the server starts it imports the bundled agents (`RUSTRMM_AGENT_DIST`,
   `/app/agents` in the image) if the manifest's version is new. It verifies every file hash,
   copies the files to `<data>/agents/releases/<version>/` and signs the manifest with the release
   key the agents pinned at enrollment.
3. **Housekeeping.** Automatic rollouts of older releases are closed (their waiting devices are
   marked `skipped`, superseded). Only the newest three releases keep their files. Older releases
   are *pruned*: the files go, the row and its rollout history stay, and they can no longer be
   rolled out. A release that a device is still waiting for is never pruned.
4. **Update.** Devices whose policy allows automatic updates are queued in the release's
   *automatic rollout*. This happens when they connect, and in a sweep every two minutes, which
   also picks up policy changes. At most 25 automatic updates run at once; the rest wait for the
   next sweep. Anyone with `agents.update` can update any device at once with **Update now**,
   whatever its policy says.
5. **Install.** The agent verifies the signature and the hash, stages the new binary and hands
   over to a detached helper that swaps it in and restarts the service. If the new version does
   not reconnect within 3 minutes, the helper restores the old binary and the update is reported
   as failed. A failed automatic update is not retried automatically; use **Update now** to try
   again. Development agents (`run --console --data-dir …`) verify and stage the update but never
   install it; their attempt is marked `skipped`.

Versions compare numerically on their first four parts, so the stamp orders builds of one version:
`0.1.0` < `0.1.0+20261118220341` < `0.1.0+20261119080000` < `0.1.1`.

## Policy

```jsonc
{ "agent_updates": {
    "auto_update": true } }   // default true; false = devices wait for "Update now"
```

Set it in any policy layer (global, client, site, group, device) under **Automation → Policies →
Agent → Automatic agent updates**. The validator rejects unknown keys and non-boolean values with
a path such as `agent_updates.auto_update`.

## Update states

| State | Meaning |
|---|---|
| `current` | Runs the latest release or newer |
| `outdated` | Runs an older agent and no update is waiting |
| `queued` | An update waits to be sent (device offline, rollout paused, or no free automatic slot) |
| `updating` | The update was sent; the device has not come back with the new version yet |
| `failed` | The last attempt for the latest release failed (`last_error` says why) |
| `unsupported` | The latest release has no agent build for the device's platform (macOS agents are not built in the Linux image) |
| `unknown` | No release has been imported |

## API

| Route | Permission | Notes |
|---|---|---|
| `GET /agent-updates?client_id&site_id` | `devices.view` | Returns `{ server_version, latest: { id, version, imported_at, platforms } \| null, summary: { total, current, outdated, queued, updating, failed, unsupported, auto_update }, items }`. Each item has the device (`id, hostname, display_name, os_family, os_name, arch, agent_version, online, last_seen_at, site_id, site_name, client_id, client_name`) and its status: `state, latest_version, target_version, last_error, attempt_at, attempt_kind (manual \| auto), auto_update, auto_update_policy` (the policy name, `null` for the default). Scoped to the caller's sites |
| `GET /devices/{id}/agent-update` | `devices.view` | The status fields alone, for one device |
| `POST /agent-updates/update` | `agents.update` + step-up | Body `{ device_ids: [] }` or `{ all_outdated: true, client_id?, site_id? }`. Creates a manual rollout of the latest release for the devices in your scope. Online devices start at once; offline ones update when they reconnect. Returns `{ rollout_id, version, targeted }`, where `targeted` counts the devices that were outdated and have a build. `409 no_release` when nothing has been imported. Audited as `agent_rollout.created` |
| `POST /devices/{id}/update` | `agents.update` + step-up | One device. `409 not_needed` when it is already current or has no build |
| `GET /rollouts` | `devices.view` | The latest 100 rollouts, including `kind` (`manual` \| `auto`), `created_by` (name) and `counts` per target status |
| `POST /rollouts/{id}/pause\|resume\|cancel` | global `agents.update` | Pausing stops new installs. Cancelling an automatic rollout turns automatic updates off for that release; they start again with the next release |
| `GET /agent-releases` | `devices.view` | Imported releases, newest first, with `pruned_at` |
| `POST /agent-releases/import` | global `agents.update` | Imports the distribution directory's release now (the server also does this at start-up) |
| `POST /agent-releases/{id}/rollouts` | global `agents.update` + step-up | Staged rollout to `{ scope: { type: all \| client \| site \| devices }, percent }`; `409 release_unavailable` for a pruned release |

Live updates: the event stream publishes `agent_updates.changed` (data `{ device_id? }`) whenever
a target changes, so the console refreshes without polling.
