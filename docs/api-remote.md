# Remote tools API (Phase 4)

All routes live under `/api/v1`, use the console session cookie, and need the `X-CSRF-Token` header
on every non-GET request. Each request is scoped to the device's client/site; a device outside the
caller's scope answers `404`. Every call travels to the agent as an Ed25519-signed command, so the
device must be **online** and **active**.

## Errors

Errors use the standard envelope `{"error": {"code", "message", "details?"}}`.

| HTTP | `code` | Meaning |
|---|---|---|
| 409 | `device_offline` | The device has no live connection |
| 409 | `device_inactive` | The device is pending, revoked or retired |
| 504 | `device_timeout` | The agent did not answer in time (60 s queries, 90 s actions) |
| 422 | `device_error` | The agent refused or failed; `message` is the agent's reason (for example "shell is disabled on this device by local policy", "Access is denied") |
| 409 | `tunnel_failed` | A shell or file-transfer tunnel could not be opened |
| 403 | `step_up_required` | Confirm MFA on this session (it then lasts until the session ends), then retry |
| 403 | `forbidden` | Missing permission (`details.permission`) |

## Permissions

| Permission | Covers |
|---|---|
| `remote.system` | processes, services, event logs, registry, network diagnostics |
| `remote.files` | file browser, upload, download, create folder/rename/delete |
| `remote.power` | reboot, shutdown, cancel, lock, sign-out, message the user |
| `remote.shell` | interactive shells, ending live sessions |
| `remote.recordings` | replaying shell recordings |

## Processes

`GET /devices/{id}/processes`

```json
{ "count": 508, "items": [ { "pid": 1234, "parent": 900, "name": "chrome.exe", "exe": "C:\\…\\chrome.exe",
  "user": "kyle", "cpu": 0.56, "memory": 97000000, "started_at": 1794960000, "status": "Run" } ] }
```

`cpu` is the percentage of the whole machine (0–100), `memory` is in bytes, `started_at` is in
Unix seconds. Items are sorted by CPU, then memory.

`POST /devices/{id}/processes/{pid}/kill` with body `{ "tree": true }` (optional). It returns
`{ "ok": true, "message": "", "data": { "pid", "name", "terminated": 2 } }`. The agent refuses
PID 0, PID 4 and itself.

## Services

`GET /devices/{id}/services` returns `{ "items": [ … ] }`. The fields depend on the platform:

- **Windows:** `name`, `display_name`, `state` (`running` | `stopped` | …), `start_mode` (`auto` | `manual` | `disabled`), `account`.
- **Linux:** `name`, `display_name`, `state` (systemd sub-state: `running`, `exited`, `dead` …), `active`, `load`.
- **macOS:** `name` (launchd label), `state` (`running` | `stopped`), `last_exit`.

`POST /devices/{id}/services/{name}/{start|stop|restart}` returns
`{ "ok": true, "data": { "name", "action", "state" } }`. Stopping the RustRMM agent's own service is
refused.

## Event logs

`GET /devices/{id}/event-logs?log=System&level=3&limit=200&hours=24`

| Parameter | Values |
|---|---|
| `level` | 0 = all; 1 = critical; 2 = error and above; 3 = warning and above; 4 = information and above |
| `limit` | 1–1000 |
| `hours` | look-back window; default 24 |
| `log` | Windows: `System`, `Application`, `Security`, `Setup` or any channel name. Linux: empty or `system` for the whole journal, otherwise a systemd unit name. macOS: ignored (unified log). |

```json
{ "log": "System", "hours": 24, "items": [ { "time": "2026-11-18T01:27:35.11Z", "level": 3, "id": 4231,
  "source": "Tcpip", "message": "…" } ] }
```

Items are newest first. `id` is `null` outside Windows. A query takes about 0.5–1 s on Windows.

## Registry (Windows only)

`GET /devices/{id}/registry?path=HKLM\SOFTWARE\Microsoft`

```json
{ "path": "HKLM\\SOFTWARE\\Microsoft", "keys": [ { "name": "Windows", "path": "HKLM\\SOFTWARE\\Microsoft\\Windows" } ],
  "values": [ { "name": "(Default)", "type": "REG_SZ", "data": "…" } ] }
```

An empty `path` lists the hives (`HKLM`, `HKU`, `HKCR`, `HKCC`). Binary values come back as hex,
truncated after 256 bytes. The registry is read-only in this phase. On other platforms the call
returns `422` with `device_error`.

## Power and messages

`POST /devices/{id}/power` with body
`{ "action": "reboot" | "shutdown" | "cancel" | "lock" | "logoff", "delay_secs": 0, "message": "" }`.

- `reboot`, `shutdown` and `logoff` need an MFA step-up on the session.
- `cancel` aborts a pending delayed reboot or shutdown.
- Linux rounds delays up to whole minutes. macOS supports only reboot, shutdown and cancel.

`POST /devices/{id}/message` with body `{ "title": "Message from IT", "body": "…", "timeout_secs": 0 }`.
On Windows this shows a message box in the console session. Linux uses `wall`; macOS shows a dialog.

## Network diagnostics (run from the device)

`POST /devices/{id}/diagnostics` with body
`{ "kind": "ping" | "traceroute" | "dns" | "port", "target": "example.com", "port": 443 }`.

| Kind | Result |
|---|---|
| `ping`, `traceroute` | `{ "command", "exit_code", "timed_out", "duration_ms", "output" }`; `output` is the raw tool output |
| `dns` | `{ "resolved", "addresses": [], "duration_ms", "error?" }` |
| `port` | `{ "open", "address?", "latency_ms?", "error?" }` |

Targets must be a host name or an IP literal: no spaces and no leading `-`. Anything else returns
`422 validation`. A traceroute can take up to 90 s.

## Files

`GET /devices/{id}/files?path=C:\Users`

```json
{ "path": "C:\\Users", "parent": "C:\\", "separator": "\\", "truncated": false,
  "entries": [ { "name": "Kyle", "path": "C:\\Users\\Kyle", "is_dir": true, "is_link": false, "size": null,
                 "modified": 1794960000000, "readonly": false, "hidden": false } ] }
```

- An empty `path` lists the roots: drives on Windows (`"drive": true`), or `/`.
- Folders come first, then entries sorted by name. A listing is capped at 5000 entries.
- `modified` is in Unix milliseconds.

`POST /devices/{id}/files/op` takes one of these bodies:

- `{ "op": "mkdir", "path" }`
- `{ "op": "rename", "from", "to" }`
- `{ "op": "delete", "path", "recursive": false }`

Paths must be absolute. The agent refuses file-system roots, `C:\Windows`, and its own install and
data folders.

`GET /devices/{id}/files/download?path=…` streams the file with `Content-Disposition: attachment`
and `Content-Length`, so the browser can download it natively (for example with `<a href>`).

`POST /devices/{id}/files/upload?path=<full target path including the file name>&overwrite=false`
takes the raw file as the body; send `Content-Length` and `X-CSRF-Token`. It returns
`{ "ok": true, "bytes", "path" }`.

- The limit is 2 GiB.
- If the target already exists and `overwrite` is false, it fails with `422`.
- The file is written to a temporary name and renamed when complete.
- Use `XMLHttpRequest` (`upload.onprogress`) to show progress.

## Interactive shell

1. Create the session with `POST /devices/{id}/shell` and body `{ "shell": "", "cols": 120, "rows": 32 }`. It needs step-up.
   - `shell` is `powershell`, `pwsh` or `cmd` on Windows; `bash`, `zsh` or `sh` on Unix.
   - An empty `shell` means the platform default: PowerShell 5.1 on Windows, otherwise bash, falling back to sh.
   - The response is `{ "session_id", "ticket", "expires_in": 30 }`.
2. Within 30 s, open the WebSocket `/api/v1/remote-sessions/{session_id}/ws?ticket=…`. Use `ws:` or `wss:` to match the page; the ticket works once.
3. Message types on the socket:

| Direction | Frame | Content |
|---|---|---|
| server → browser | binary | Terminal output (VT bytes); write it to xterm as-is |
| server → browser | text | `{"type":"status","message"}` while connecting; `{"type":"ready"}`; `{"type":"exit","code"}`; `{"type":"error","message"}`; `{"type":"closed","reason"}` (always last) |
| browser → server | binary | Keystrokes as UTF-8 bytes (Enter is `\r`, Ctrl+C is `\x03`) |
| browser → server | text | `{"type":"resize","cols","rows"}` |

The server ends a session when:

- the operator closes the socket or signs out, or the web session is revoked;
- there is no input for 30 minutes;
- the session reaches 8 hours;
- an administrator ends it (`POST /remote-sessions/{id}/end`);
- the device is revoked.

Each shell is recorded as asciicast v2.

## Session history and recordings

`GET /remote-sessions?device_id=&limit=100`

```json
{ "items": [ { "id", "device_id", "hostname", "user_name", "kind": "shell" | "download" | "upload",
  "detail": { "shell", "cols", "rows" } | { "path" }, "started_at", "connected_at", "ended_at", "end_reason",
  "bytes_to_device", "bytes_from_device", "has_recording", "recording_bytes", "live" } ] }
```

`GET /remote-sessions/{id}/recording` needs `remote.recordings` and returns an asciicast v2 file
(`application/x-asciicast`):

- The first line is the header: `{version: 2, width, height, timestamp, title, env}`.
- Each following line is either `[seconds, "o", text]` (output) or `[seconds, "r", "COLSxROWS"]` (resize).

`POST /remote-sessions/{id}/end` returns `204` and ends a live session.

## Live events

The `/api/v1/stream` topic `remote.session` carries
`{ "session_id", "device_id", "status": "active" | "ended", "kind": "shell" }`.
