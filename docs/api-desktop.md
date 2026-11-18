# Remote desktop (Phase 8)

This is the contract for in-browser remote desktop: viewing and controlling a device's screen.
It covers Windows (including UAC prompts and the sign-in screen) and Linux X11. On macOS the agent
only reports the permission state for now, and Wayland is not supported yet.

The design builds on the Phase 4 tunnel broker and on the DXGI spike
(`spikes/dxgi-secure-desktop/FINDINGS.md`). Read the spike's "Pitfalls" and "Recommended
capture-loop design" sections before implementing.

## Permissions and policy

- **Permission:** `remote.desktop`. Starting a session also needs a step-up within the last 5 minutes.
- **Policy section:** `remote_access` gains these keys (all optional):

```jsonc
{ "remote_access": {
    "desktop": true,
    "desktop_consent": "when_user_present",   // never | always | when_user_present
    "consent_timeout_secs": 30,               // no answer = denied
    "desktop_banner": true,                   // on-screen "Remote session in progress" banner on the device
    "desktop_view_only": false } }            // force view-only for everyone
```

- **Defaults:** an absent key takes the value shown above (desktop on, consent when a user is
  present, 30 s, banner on, not view-only). `consent_timeout_secs` must be a whole number from 5 to
  300; the validator rejects other values, unknown keys and wrong types with a path such as
  `remote_access.desktop_consent`.
- **Enforcement:** `desktop: false` refuses the session list, new sessions and screenshots with
  `403 disabled_by_policy` (`details: { feature: "desktop", policy_id, policy_name }`), like the
  Phase 5 switches. The policy is read again when the browser attaches, and its consent, timeout,
  banner and view-only values travel to the agent inside the signed `OpenTunnel` (see "Agent
  protocol").
- **Local capability:** `desktop` (`features::DESKTOP`). A device with it disabled refuses sessions,
  screenshots and the session list.
- **Recording:** sessions are audited (start, end, consent outcome, view-only, Ctrl+Alt+Del,
  clipboard use as counts only) but are not video-recorded.

## API

| Route | Permission | Notes |
|---|---|---|
| `GET /devices/{id}/desktop/sessions` | `remote.desktop` | The device's interactive sessions. Returns `{ items: [{ session_id, kind: "console" \| "rdp", user: "CORP\\alex" \| null, state: "active" \| "disconnected" \| "locked" \| "login_screen", monitors: n \| null }] }` |
| `POST /devices/{id}/desktop` | `remote.desktop` + step-up | Body `{ session_id?: number, view_only?: bool, quality?: "auto" \| "low" \| "medium" \| "high" }`. Returns `{ session_id, ticket, expires_in: 30 }` |
| `GET /remote-sessions/{id}/ws?ticket=` | (ticket) | The same socket endpoint as shells (Phase 4). Desktop framing is defined below |
| `GET /devices/{id}/screenshot` | `remote.desktop` | A single JPEG of the console session's primary monitor, at most 1280 px wide. Audited as `remote.screenshot`; consent rules apply |

`remote_sessions.kind` gains `desktop`. SQLite cannot alter a CHECK constraint, so migration
`0008_desktop.sql` rebuilds the table. The `detail` column holds
`{ session_id, view_only, quality, consent: "not_required" | "granted" | "denied" | "timeout" }`.
`consent` is `null` until the outcome is known; `view_only` follows view-only toggles.

Route details:

- **Sessions list:** Linux items also carry `type: "x11" | "wayland"`; Linux `session_id` is the
  numeric logind id (or `null`). macOS returns `{ items: [], tcc: { screen_recording, accessibility } }`
  (each `true`, `false` or `null` when the TCC database cannot be read).
- **POST:** `409 device_offline` before anything is created; `422 validation` for an unknown
  `quality`; `422 device_error` "Remote desktop on macOS is not available yet" for macOS devices.
  `view_only` is forced on when the policy sets `desktop_view_only`. Linux ignores `session_id`
  (the active graphical session is used).
- **Screenshot:** no step-up. It returns `image/jpeg` with `Cache-Control: no-store`. Consent uses
  the screenshot wording; a refusal returns `422 device_error` "The user denied the screenshot" (or
  "The user did not answer the consent prompt"). macOS returns `422 device_error`.
- **Live sessions:** a desktop session ends on the same events as a shell (operator closes or signs
  out, administrator `POST /remote-sessions/{id}/end`, which needs `remote.desktop` for desktop
  sessions, device revocation, 8 hours) and after 30 minutes without input. Acks do not count as
  input; mouse, keyboard, text, clipboard and Ctrl+Alt+Del do. The last text frame is
  `{"type":"closed","reason"}`. The `remote.session` event carries `kind: "desktop"`.
- **Audit actions:** `remote.desktop.opened` (session id, Windows session, view-only, forced,
  quality), `remote.desktop.consent` (`status`), `remote.desktop.view_only` (`value`),
  `remote.desktop.cad`, `remote.desktop.ended` (reason, duration, bytes, consent, view-only,
  `ctrl_alt_del`, `clipboard_to_device`, `clipboard_from_device`, `dropped_inputs`) and
  `remote.screenshot` (outcome, size, consent).

## Tunnel framing (desktop)

Binary frames carry media and text frames carry JSON control messages. The server forwards both
unchanged.

### Agent → browser binary messages

The first byte is the message type. All integers are little-endian.

| Type | Layout | Meaning |
|---|---|---|
| `0x01` tile | `u32 frame_seq, u16 x, u16 y, u16 w, u16 h, u8 encoding, payload…` | A screen region. `encoding`: `1` = JPEG, `2` = raw BGRA (small tiles only), `3` = solid colour (`payload` = 4 bytes BGRA) |
| `0x02` frame end | `u32 frame_seq, u16 tiles` | All tiles of the frame were sent; the viewer presents it. `tiles` counts the `0x01` messages of the frame (copy rects are not counted) |
| `0x03` cursor position | `i16 x, i16 y, u8 visible` | |
| `0x04` cursor shape | `u16 hot_x, u16 hot_y, u16 w, u16 h, RGBA payload (w*h*4)` | Sent when the shape changes; the viewer caches shapes |
| `0x05` copy rect | `u32 frame_seq, u16 src_x, u16 src_y, u16 w, u16 h, u16 dst_x, u16 dst_y` | DXGI move rect (scrolling); applied before that frame's tiles |

Tile details:

- **Regions:** the agent finds dirty 64×64 tiles, then sends single-colour tiles as `solid` and
  merges the rest into rectangles of up to 1024×256 px (16×4 tiles). Edge tiles are smaller, so a
  tile can have any size up to that limit.
- **Raw:** regions of at most 256 pixels are sent raw (`w * h * 4` bytes, rows top-down).
- **Alpha:** raw and solid payloads always have alpha 255. JPEG has no alpha.
- **JPEG:** baseline JFIF, 4:2:0 chroma below quality 80 and 4:4:4 at 80 and above.
- **Ordering:** copy rects, then tiles, then the frame end, all with the same `frame_seq`.
  `frame_seq` starts at 0 for each stream and wraps at 2^32.
- **Cursor:** a shape is sent before the first position and whenever it changes (at most 256×256).
  Positions are relative to the active monitor and may be negative or beyond it when the pointer
  is on another monitor.

### Text control messages

| Direction | Message |
|---|---|
| agent → browser | `{"type":"ready","width","height","monitors":[{"id","name","x","y","width","height","primary","scale"}],"monitor":id,"view_only":bool,"desktop":"default" \| "winlogon" \| "screensaver"}`. Sent again after a monitor switch, each time followed by a full frame. Monitor ids are positions in the list (primary first, then left to right) |
| agent → browser | `{"type":"desktop","name":"winlogon"}` when the input desktop changes (UAC, lock screen) |
| agent → browser | `{"type":"resize","width","height"}` when the resolution changes; a full frame follows |
| agent → browser | `{"type":"clipboard","text"}` when the device's text clipboard changes; at most 1 MiB, and only if the session is not view-only |
| agent → browser | `{"type":"consent","status":"waiting" \| "granted" \| "denied" \| "timeout"}` |
| agent → browser | `{"type":"stats","fps","kbps","encode_ms","capture":"dxgi" \| "gdi" \| "x11"}`, every 2 s |
| agent → browser | `{"type":"exit","code":null}`, `{"type":"error","message"}` (same as Phase 4) |
| browser → agent | `{"type":"ack","frame_seq"}`. The viewer acks each presented frame; the agent keeps at most 2 frames in flight |
| browser → agent | `{"type":"mouse","x","y","buttons":bitmask,"wheel_x"?,"wheel_y"?}`, with coordinates in remote pixels of the active monitor. `buttons` is the DOM `MouseEvent.buttons` value (1 left, 2 right, 4 middle, 8 back, 16 forward); the agent sends press and release on changes. Wheel values are in notches (one detent = 1, fractions allowed): positive `wheel_y` scrolls down, positive `wheel_x` scrolls right |
| browser → agent | `{"type":"key","code":"KeyA","key":"a","down":true,"location":0}`. `code` uses KeyboardEvent.code values; the agent maps them to scan codes. When `code` is unknown or empty, a single-character `key` is typed as Unicode instead |
| browser → agent | `{"type":"text","text":"…"}`, Unicode input for IME/paste-as-keystrokes; at most 4096 characters |
| browser → agent | `{"type":"cad"}` (Ctrl+Alt+Del), `{"type":"monitor","id"}`, `{"type":"quality","value":"low" \| "medium" \| "high" \| "auto"}`, `{"type":"refresh"}` (full frame), `{"type":"clipboard","text"}`, `{"type":"view_only","value":bool}` |
| browser → server | `{"type":"resize"}` is not used for desktops. The server drops input messages (`mouse`, `key`, `text`, `cad`, `clipboard`) when the session is view-only, drops agent-to-browser types sent by the browser, and drops binary frames from the browser. `view_only:false` is dropped when the policy forces view-only; other toggles are applied, recorded in `detail` and audited |

### Quality and adaptation

- **JPEG quality:** low 45, medium 65, high 82.
- **Auto mode** adapts quality and fps (5–30) from ack round-trip time and backlog. The tiles of a
  frame are encoded in parallel on a small thread pool.
- **Auto in detail:** starts at quality 65 and 20 fps. Every 2 s stats window, an RTT average above
  300 ms or time blocked on the in-flight limit above 50 % lowers quality by 10 (minimum 35) and fps
  by a third; above 150 ms or 20 % lowers them by 5 and 3; below 80 ms and 5 % raises them by 3
  (maximum 82) and 5 (maximum 30). In every mode the frame rate is capped so encoding takes at most
  about 80 % of the time. Fixed levels run at up to 30 fps.
- **Flow control:** frames unacknowledged for 10 s are written off, so a hidden or stalled viewer
  gets a frame every 10 s instead of none.
- **Idle screen:** DXGI sends no frames while the screen is idle (see the spike), so nothing is
  sent. `refresh` forces a full frame.

## Agent architecture (Windows)

### Process model

- The LocalSystem service starts `rustrmm-agent desktop-helper --session <id> --pipe <name>` in the
  target session:
  1. Duplicate the SYSTEM token and set its `TokenSessionId`.
  2. Call `CreateProcessAsUserW` on `winsta0\default` with `CREATE_NO_WINDOW`, from the installed
     exe path. Never start it from a user-writable location.
- The helper exits when the service process handle signals, and on session end.
- One helper serves one desktop session at a time. The service restarts it with backoff.
- **IPC** is a named pipe created by the service with a SYSTEM-only DACL and
  `FILE_FLAG_FIRST_PIPE_INSTANCE`. Before trusting a client, the service verifies its PID, session
  and image path (`GetNamedPipeClientProcessId`).
- The helper has **no network access**. The service relays frames between the pipe and the tunnel
  socket.
- **Dev mode:** when the agent is not running as a service (`run --console`), it spawns the helper
  directly as the current user in the current session. Capture still works, but only on `Default`.

### Capture

Follow the spike's capture-loop design:

- **Desktop tracking:** a dedicated capture thread polls `OpenInputDesktop` and calls
  `SetThreadDesktop` when the desktop changes, keeping its D3D11 device.
- **DXGI:** use `DuplicateOutput1` with BGRA8, and use dirty and move rects. Skip
  `LastPresentTime == 0` frames.
- **Fallback:** paced GDI (10–15 fps) on `UNSUPPORTED`.
- **Cursor:** taken from `GetFramePointerShape` and the pointer position, and sent as cursor
  messages. The viewer composites it.
- **Display scaling:** call `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` first.
- **Frames:** never written to disk.

### Input

- Input is injected with `SendInput` from an input thread attached to the current input desktop.
- Keys are mapped to scan codes with `KEYEVENTF_SCANCODE`, plus `KEYEVENTF_EXTENDEDKEY` where needed.
- Mouse coordinates use absolute `MOUSEEVENTF_VIRTUALDESK` coordinates across the virtual screen.
- Ctrl+Alt+Del calls `SendSAS(FALSE)` from `sas.dll` in the service, which needs the
  `SoftwareSASGeneration` policy. The agent sets
  `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System\SoftwareSASGeneration = 3` at install
  and uninstall leaves it alone. When the policy is absent, the agent reports
  `{"type":"error","message":"Ctrl+Alt+Del needs the SoftwareSASGeneration policy"}`.
- **Policy details:** `sas.dll` is loaded from System32 only. An existing value of 1 or 3 is kept.
  MSI installs never run `install`, so the service applies the policy on its first start and
  writes a marker file. An administrator who later removes the value keeps it removed. In dev
  mode the agent reports "Ctrl+Alt+Del is available only when the agent runs as a service".

### Clipboard and banner

- **Clipboard:** text only. The helper runs a message-only window on a non-capture thread to watch
  clipboard changes (`AddClipboardFormatListener`) and to set clipboard text.
- **Banner:** a small topmost, click-through, layered window at the top centre, reading
  "Remote session in progress — <technician name>". It runs on its own UI thread and is hidden from
  capture with `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`.

### Consent

- **Rules:** under `always`, the prompt is shown whenever a user is signed in, including on a
  locked session, where it will usually time out. Nobody is asked on the sign-in screen in any
  mode. The browser sees `waiting` and then the outcome. After `denied` or `timeout` the agent
  sends `exit` and the server ends the session with "the user denied the session" or "the user
  did not answer the consent prompt".
- **Who answers:** the service asks the console user with `WTSSendMessageW`
  (`MB_YESNO | MB_ICONQUESTION | MB_TOPMOST`, `bWait = TRUE`) and the policy timeout.
- **Wording:** "<technician> from <MSP name> wants to view and control your screen. Allow?"
- **When to ask:** under `when_user_present`, ask only when a user is signed in and the session is
  unlocked. The sign-in screen and locked sessions need no consent.

### Implementation notes (Windows)

- **Cursor shape:** taken from `GetCursorInfo` plus `GetIconInfo` whenever the cursor handle
  changes. This works the same under DXGI and GDI, so `GetFramePointerShape` is not used.
  Monochrome "invert" pixels (the I-beam) are drawn black with a white halo.
- **GDI fallback:** paced at 12 fps. Rotated outputs also use GDI, because DXGI returns them in
  the panel's native orientation.
- **Pipe:** the name is random per launch. The DACL grants LocalSystem only; in dev mode it grants
  the current user only. The service checks the client's PID, session and image path.
- **Helper:** started as `desktop-helper --session <id> --pipe <name> --parent <agent pid>`. Its
  log lines are relayed to the agent log over the pipe, and it never writes frames to disk.
- **Pipe framing (internal):** `u8 kind, u32 length LE, payload`. Kind 1 is a media message, 2 a
  control JSON message, 3 the helper config, 4 a screenshot (`u32 w, u32 h, JPEG`) and 5 a log line.
- **Restarts:** if the helper dies (for example on logoff), the service restarts it up to 5 times
  with back-off. It re-resolves the console session when no `session_id` was requested.
- **Helper exe:** as a service, the agent refuses to launch a helper unless it is itself the
  installed binary (`%ProgramFiles%\RustRMM\Agent\rustrmm-agent.exe`).

## Agent architecture (Linux X11)

- The agent itself acts as the helper. It runs as root, so no separate process is needed for X11.
- **Display discovery:**
  1. Find the active graphical session with `loginctl` (`Type=x11`).
  2. Take `DISPLAY` and `XAUTHORITY` from the session leader's `/proc/<pid>/environ`.
  3. Connect with x11rb.
- **Capture:** use MIT-SHM `GetImage` and compare against the last frame in 64×64 tiles to find
  dirty tiles. The XDamage extension may serve as an accelerator.
- **Input:** XTEST `FakeInput`. Keys map through the keysym table.
- **Clipboard:** use the X11 selections via x11rb. Text only, best effort.
- **Unsupported setups:** a `wayland` session or no graphical session returns
  `{"type":"error","message":"Wayland sessions are not supported yet"}` or
  "No graphical session".
- **Implementation notes:**
  - An X server that advertises the `XWAYLAND` extension (such as WSLg) counts as a Wayland
    session.
  - Without logind sessions, the agent falls back to its own `DISPLAY`/`XAUTHORITY`.
  - The X11 cookie is read from the session's Xauthority file. Only local displays are supported.
  - Capture uses an MIT-SHM segment created by the server (`CreateSegment`), with core `GetImage`
    as the fallback, at up to 30 fps.
  - Characters that have no key are typed through a spare keycode.
  - Ctrl+Alt+Del is sent as key presses through XTEST.
  - There is no on-screen banner on Linux yet.
  - Consent is asked with `zenity --question`, run as the session user. If it cannot be shown,
    the answer is `denied`.

## Agent protocol

- **Tunnel:** `OpenTunnel` with `TunnelKind::Desktop { session_id?, monitor?, view_only, quality,
  consent, consent_timeout_secs, banner, technician, organization }`.
- **Policy fields:** `consent`, `consent_timeout_secs` and `banner` carry the effective policy, so
  the agent never decides on its own. `technician` (the operator's name) and `organization` (the
  MSP name) fill the banner and the consent prompt.
- **Feature:** the tunnel requires `features::DESKTOP`.
- **Commands:** `desktop_sessions` answers with the sessions document. `screenshot`
  `{ max_width, consent, consent_timeout_secs, technician, organization }` answers with
  `{ jpeg: base64, width, height, consent }`. Both require `features::DESKTOP`.
- **Capability:** the agent advertises the `desktop` capability in its hello.

## macOS

`GET /devices/{id}/desktop/sessions` returns the TCC permission state, reported in inventory under
`security.tcc`: `{ screen_recording: bool, accessibility: bool }`. `POST /devices/{id}/desktop`
returns `422 device_error` "Remote desktop on macOS is not available yet". The console explains
which permissions will be needed.

## Viewer (console)

- **Rendering:** a canvas renderer that draws JPEG tiles with `createImageBitmap` off the main
  thread where supported, applies copy rects and composites the cursor.
- **Toolbar:**
  - monitor picker, quality, view-only toggle;
  - Ctrl+Alt+Del and other special keys (Win, Alt+Tab, PrtScn);
  - clipboard send/receive;
  - full screen, scale-to-fit or 1:1, screenshot (saves locally);
  - a stats overlay;
  - a session timer and disconnect.
- **Input capture:** keyboard capture uses the Keyboard Lock API where available, plus pointer lock
  in full screen. Mobile gets touch-to-mouse and an on-screen keyboard button.
- **Status display:** UAC and secure-desktop transitions show a subtle indicator ("Secure desktop").
  The consent wait shows a waiting state.

## Tests

- **Unit tests:** tile diffing, the binary message encoder and decoder (agent side and a TS decoder
  test), the scan-code map, and quality adaptation.
- **Agent selftest:** a `desktop` check that captures one frame of the current session and encodes
  it. It skips in sessions without a display.
- **Selftest output:** `PASS desktop 2560x1440 via dxgi, 920 tiles -> 162 messages, 553 KiB, capture
  232 ms, encode 43 ms`, or `SKIP desktop <reason>`.
- **Development bench:** the hidden `rustrmm-agent desktop-bench [--frames 50] [--quality medium]
  [--incremental]` starts a real helper in the current session and prints fps and kbps. By default
  it forces a full refresh after every frame; `--incremental` only acks.
