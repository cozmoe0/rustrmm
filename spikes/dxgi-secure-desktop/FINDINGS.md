# Spike: DXGI capture of the secure desktop from a LocalSystem service helper

Phase-0 throwaway spike, 2026-11-17. Code in this folder; nothing here is used by the
main workspace.

## Status

| Part | Status |
| --- | --- |
| `cargo build` (debug + release), clippy, rustfmt | Done, zero warnings |
| Console-mode capture (DXGI and GDI) of the current desktop | **Verified** on this machine |
| Following input-desktop switches (`OpenInputDesktop` + `SetThreadDesktop`), simulated with a private desktop | **Verified** (non-elevated) |
| `EVENT_SYSTEM_DESKTOPSWITCH` delivery to `SetWinEventHook` hooks | **Verified** for user-created desktops |
| Helper watchdog (exit when the parent service dies) | **Verified** |
| Service install + launch of the helper into the console session as SYSTEM | Built, **not run**: needs an elevated prompt (this session had none) |
| Capture of the UAC secure desktop and the Winlogon / lock screen | **Pending the elevated run** below |

## Test machine

Windows 11 Enterprise 10.0.26200, NVIDIA GeForce RTX 5060 Ti (driver 32.0.16.1088), two
2560x1440 monitors at 59.95 Hz (primary `\\.\DISPLAY1` at 0,0; `\\.\DISPLAY2` at -2560,0),
physical console session 1. Rust 1.98.1, `windows` 0.62.2, `windows-service` 0.8.1,
`jpeg-encoder` 0.6.1.

## What the spike does

One binary, `dxgi-spike.exe`:

- `console`: runs the capture loop in the current process (no service, no elevation).
  `--animate` adds a small topmost window repainted every vsync, so the screen really
  changes and frame rates mean something. `--switch-test` creates a private desktop with a
  full-screen window, `SwitchDesktop`s the console to it for `--hold` seconds and back:
  the same "input desktop changed" event a UAC prompt or Win+L produces, minus the
  Winlogon ACL.
- `install` / `start` / `stop` / `status` / `uninstall [--purge]`: manage the LocalSystem
  service `RustRMMSpikeCapture`. `install` copies the binary to
  `C:\Program Files\RustRMMSpike\` first (see pitfall 13).
- `service`: SCM entry point. The service supervises one helper in the active console
  session: it duplicates its own SYSTEM token (`DuplicateTokenEx`), sets `TokenSessionId` to
  `WTSGetActiveConsoleSessionId()`, and calls `CreateProcessAsUserW` with
  `lpDesktop = "winsta0\default"` and `CREATE_NO_WINDOW`. It relaunches the helper when
  the console session changes (session-change notifications plus a 1 s poll) and restarts
  it with exponential back-off if it dies.
- `helper`: the capture loop, run by the service inside the console session.
- `outputs`: lists DXGI adapters and outputs.

Capture loop (`src/capture_loop.rs`), once per iteration:

1. `OpenInputDesktop`. If its name differs from the thread's desktop, drop the duplication
   and any GDI DC, then `SetThreadDesktop` to it. If that is refused, continue on a fresh
   thread (never needed in testing).
2. Make sure there is a capturer. DXGI first: one cached D3D11 device per adapter, and
   `IDXGIOutput5::DuplicateOutput1` (BGRA8) with `DuplicateOutput` as the fallback.
   - `DXGI_ERROR_UNSUPPORTED`: wait up to 1 s for `EVENT_SYSTEM_DESKTOPSWITCH`, retry once,
     then fall back to GDI `BitBlt`. DXGI is retried on the next switch notification or
     after 10 s.
   - `E_ACCESSDENIED`, `DXGI_ERROR_SESSION_DISCONNECTED`, `DXGI_ERROR_NOT_CURRENTLY_AVAILABLE`:
     treated as a transition. Wait for a switch notification (250 ms poll). After about 2 s
     of refusals while attached to the input desktop, fall back to GDI.
3. `AcquireNextFrame(100 ms)`. On `DXGI_ERROR_ACCESS_LOST`, recreate the duplication.
4. Save proof frames as JPEG on a worker thread: the first frame on each desktop, then the
   latest changed frame every `--save-interval`. Files go to
   `C:\ProgramData\RustRMMSpike\frames\{console|svc}-{seq}-{time}-{desktop}-{dxgi|gdi}.jpg`,
   and each save logs the mean luma and non-black percentage, so black frames show up in
   the log. Stats lines go to `C:\ProgramData\RustRMMSpike\logs\{console,helper,service}.log`.

`EVENT_SYSTEM_DESKTOPSWITCH` hooks run on two dedicated message-pump threads. One stays
pinned to the start desktop and one follows the input desktop, so the log shows which
hooks receive switches. The capture thread never owns a hook or window, so its own
`SetThreadDesktop` cannot be refused.

## Results so far

All runs were non-elevated, in console session 1, on the primary 2560x1440 output.

| Scenario | Observed |
| --- | --- |
| DXGI, static desktop | Event-driven: 1 new frame in 2.8 s (the rest timed out). The first acquire is pointer-only with a black surface (pitfall 1). |
| DXGI, `--animate` (continuous change) | **58.5 to 60 fps**, vsync-bound at 59.95 Hz. Frame-to-CPU time (`CopyResource` + `Map` + 14.7 MB row copy): average 2.3 to 3.9 ms, worst 30 ms. |
| GDI `BitBlt` + `CAPTUREBLT`, unpaced, `--animate` | **32 fps** maximum. Blit plus copy averages 31 ms (worst 45 ms), about 10x DXGI's cost. |
| DXGI setup cost | `D3D11CreateDevice` takes **109 to 156 ms**; `DuplicateOutput1` takes 0.6 to 2.9 ms; output enumeration takes about 1 ms (8 ms the first time). |
| Desktop switch test, following, fresh device per switch | Switch detected; in-place `SetThreadDesktop` worked both ways; first new frame on the new desktop 170 to 190 ms later; 59.2 fps on the test desktop. |
| Same test with the cached device | Device reused across desktops; re-duplication took 0.6 to 1.1 ms. **First new frame 6 to 10 ms after the switch was detected.** |
| Switch test with `--no-follow` (negative) | `DXGI_ERROR_ACCESS_LOST` at the switch, then `DuplicateOutput1` returned **`E_ACCESSDENIED` for the whole time the other desktop was input**. Recovered after switching back. |
| `EVENT_SYSTEM_DESKTOPSWITCH` | Delivered within about 1 to 3 ms, in both directions, to out-of-context hooks on threads attached to `Default`, including the pinned one that never moved. |
| JPEG proof frames (q80, one core) | 27 to 62 ms per 2560x1440 frame, 56 to 260 KiB. |
| Helper `--parent-pid` watchdog | Helper exited when its parent exited. |

The saved frame `console-00004-…-RustRMMSpikeTest-dxgi.jpg` shows the synthetic desktop's
window with a timestamp that matches the log, so the frame came from the switched-to
desktop. It is not a stale image of `Default`.

## Elevated test (still to do: UAC prompt and lock screen)

The helper captures the primary monitor only (`\\.\DISPLAY1`). Start the UAC prompt from a
window on that monitor.

1. Open an elevated PowerShell (Win+X, then "Terminal (Admin)") and run:

   ```powershell
   cd C:\Users\Kyle\Development\Projects\Personal\rustrmm\spikes\dxgi-secure-desktop
   .\target\release\dxgi-spike.exe install
   .\target\release\dxgi-spike.exe start
   ```

2. Wait about 5 s. From a **non-elevated** context, trigger UAC: press Win+R, type `cmd`, and
   press Ctrl+Shift+Enter. Leave the prompt up about 5 s, move the mouse over it, then click
   **No**.
3. Lock with Win+L, wait about 10 s, and sign back in.
4. Optional: press Ctrl+Alt+Del, wait 5 s, then press Esc.
5. Inspect the results (any prompt):

   ```powershell
   Get-ChildItem C:\ProgramData\RustRMMSpike\frames\svc-* | Select-Object Name, Length
   Select-String -Path C:\ProgramData\RustRMMSpike\logs\helper.log -Pattern "LocalSystem|desktop changed|first new frame|setup:|stats:|unavailable|GDI|refused" | Select-Object -Last 60
   Get-Content C:\ProgramData\RustRMMSpike\logs\service.log
   ```

   Success looks like:
   - `helper starting: ... user S-1-5-18 (LocalSystem) ... thread desktop 'Default'`
   - `input desktop changed 'Default' -> 'Winlogon'`, then `first new frame on 'Winlogon' N ms ...`
   - `svc-…-Winlogon-dxgi.jpg` files showing the dimmed desktop with the UAC dialog, and the
     lock screen, with non-black values in the `saver: wrote` lines.

   A `-Winlogon-gdi.jpg` file means DXGI refused the secure desktop but the GDI fallback
   worked. That is still a pass for the spike, and worth recording.
6. Uninstall (elevated):

   ```powershell
   .\target\release\dxgi-spike.exe uninstall
   ```

   `uninstall --purge` also deletes `C:\ProgramData\RustRMMSpike` (frames and logs).

Record the outcome in the table below.

| Elevated scenario | Result |
| --- | --- |
| Helper runs as `S-1-5-18` in session 1 on `WinSta0\Default` | _pending_ |
| UAC prompt: input desktop `Winlogon`; method and frame captured | _pending_ |
| Lock screen: input desktop `Winlogon`; method and frame captured | _pending_ |
| Cached D3D device reused on `Winlogon` (no "retried with a freshly created device" line) | _pending_ |
| `EVENT_SYSTEM_DESKTOPSWITCH` seen by the hook pinned on `Default` when switching to `Winlogon` | _pending_ |
| Session-change log lines on lock and unlock | _pending_ |

## Pitfalls

1. **The first frame is black.** The first `AcquireNextFrame` after `DuplicateOutput1`
   returned `LastPresentTime=0` and `AccumulatedFrames=0` (a pointer-only update) with an
   all-black surface. The real full-desktop frame followed 2 to 15 ms later. Never copy a
   frame whose `LastPresentTime == 0`, not even before you have any image.
2. **You must follow the input desktop.** A duplication on a non-input desktop gets
   `ACCESS_LOST`, and recreating it fails with `E_ACCESSDENIED` until that desktop is input
   again. The fix is `OpenInputDesktop` + `SetThreadDesktop` on the capture thread.
3. **`SetThreadDesktop` works in place on a thread that uses D3D11/DXGI**, even with the
   device kept alive. D3D objects do not count as the "windows or hooks" that make it fail
   with `ERROR_BUSY`. GDI screen DCs and any hooks or windows must still go first, so keep
   hooks and windows off the capture thread.
4. **Creating the D3D11 device is the slow part** (110 to 156 ms; duplication takes about
   1 ms). The device is not tied to a desktop: reusing it across desktop switches cut
   switch-to-first-frame from 170 to 190 ms down to 6 to 10 ms. Still to confirm on `Winlogon`;
   the code retries with a fresh device once if a reused one is refused.
5. **There is a race at transitions.** A duplication created during a switch was lost
   again 10 to 18 ms later (once per switch, whenever it was created within the
   transition). Treat `ACCESS_LOST` right after
   creation as normal and recreate; with the cached device this is cheap.
6. **`OpenInputDesktop` changes before `SwitchDesktop` returns** to the switching thread.
   Polling it every loop iteration caught every switch before `ACCESS_LOST` arrived, so
   desktop detection does not depend on `ACCESS_LOST` or on WinEvents.
7. **WinEvent delivery:** a hook on a thread attached to `Default` received switches in
   both directions. WinEvents are only an accelerator for the `UNSUPPORTED` and denied
   waits; correctness comes from polling.
8. **DXGI is event-driven.** A static desktop yields about 0 fps and returns
   `DXGI_ERROR_WAIT_TIMEOUT`. The encoder pipeline must cope with idle periods (repeat the
   last frame or send nothing; produce a keyframe on demand).
9. **GDI is about 10x the cost of DXGI** (31 ms per 2560x1440 blit) and cannot tell
   whether anything changed. Use it only as a paced fallback (10 to 15 fps).
10. **DPI awareness:** call `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` before any
    GDI capture or `DuplicateOutput1`. Otherwise GDI sizes are virtualised on scaled
    displays.
11. **Console-subsystem helper:** without `CREATE_NO_WINDOW`, `CreateProcessAsUserW` pops a
    conhost window onto the user's desktop. Either pass the flag or build the helper as a
    windows-subsystem binary.
12. **Job objects cannot span sessions** (service in session 0, helper in session 1). The
    helper instead waits on the service's process handle and exits with it (verified).
13. **Service binary location is a privilege boundary.** A LocalSystem service pointing
    into a user-writable path such as `target\` lets any process running as the user swap
    the binary, or plant a DLL next to it, and get SYSTEM. `install` copies the binary to
    `C:\Program Files\RustRMMSpike\`. The real agent must install only to admin-only
    locations.
14. **Proof frames are readable by every local user.** `C:\ProgramData\RustRMMSpike`
    inherits `BUILTIN\Users: ReadAndExecute` (checked). That is acceptable for a spike that
    writes UAC and lock-screen images, never for the product: the agent must not persist
    frames, and anything it does persist needs a SYSTEM/Administrators-only DACL.
15. **The cursor is not in DXGI frames.** It needs `GetFramePointerShape` plus
    `PointerPosition` (not done here). Rotated outputs return the panel's native
    orientation (`DXGI_OUTDUPL_DESC.Rotation`, only logged here).
16. **Software JPEG is too slow for streaming:** 27 to 62 ms per 2560x1440 frame on one
    core. Streaming needs a hardware encoder fed from the GPU texture.
17. The `windows-service` error `Display` is just "IO error in winapi call"; print
    `Error::source()` to get the OS error (e.g. 1060).

## Recommended capture-loop design for the agent

Process model:

- The LocalSystem service (session 0) launches one **desktop agent** per interactive
  session it serves. It duplicates its SYSTEM token, sets `TokenSessionId`, and calls
  `CreateProcessAsUserW` on `winsta0\default` with `CREATE_NO_WINDOW` (or a
  windows-subsystem binary).
- Start with the console session (`WTSGetActiveConsoleSessionId`). Add RDP sessions from
  `WTSEnumerateSessions` when needed; expect GDI there.
- Supervise with `SERVICE_CONTROL_SESSIONCHANGE` plus a 1 s poll. Kill and relaunch the
  helper when its session stops being the target, and restart it with back-off when it dies.
- The helper exits when the service's process handle signals.
- IPC: a named pipe with a SYSTEM-only DACL. The service checks the client's PID and
  session. The helper never opens a network socket.

Capture thread inside the helper (one per output, or one looping over outputs):

- Dedicated thread with no windows, hooks or COM STA. Each iteration:
  `OpenInputDesktop` and compare the name (cheap). On a change: drop the duplication and
  any GDI DC, then `SetThreadDesktop`; keep the D3D11 device. If `SetThreadDesktop` is ever
  refused, restart the capture thread.
- DXGI: cache one D3D11 device per adapter, created on the adapter that owns the output.
  Use `DuplicateOutput1(BGRA8)`, falling back to `DuplicateOutput`. Set the
  `AcquireNextFrame` timeout to the frame interval.
- Error policy:
  - `LastPresentTime == 0`: the image is unchanged, so only update the pointer.
  - `ACCESS_LOST`: recreate the duplication immediately.
  - `E_ACCESSDENIED`, `SESSION_DISCONNECTED`, `NOT_CURRENTLY_AVAILABLE`: a transition. Wait
    for a switch notification or 250 ms.
  - `UNSUPPORTED`: wait once for a switch notification, then use paced GDI. Retry DXGI on
    the next switch or every 10 s.
  - `DEVICE_REMOVED` or `DEVICE_RESET`: recreate the device.
  - Output topology change: re-enumerate.
- Streaming path: use `GetFrameDirtyRects` / `GetFrameMoveRects` and keep the frame on the
  GPU. Copy into a texture shared with a hardware encoder (Media Foundation H.264/HEVC)
  instead of mapping to the CPU. Use the CPU path only for software codecs and the GDI
  fallback.
- Send the pointer separately (`GetFramePointerShape`) and composite it in the viewer.
- Run a WinEvent hook thread (`EVENT_SYSTEM_DESKTOPSWITCH`, out of context, own message
  pump) only to cut waits. Polling stays the source of truth.
- Never write frames to disk.

## Not covered by this spike

- HDR or FP16 desktops (`DuplicateOutput1` asks for BGRA8; untested)
- Rotated outputs
- Multi-monitor capture; only one output here, and the secondary is at negative coordinates
- Cursor capture
- RDP sessions
- Hyper-V or Microsoft Basic Display Adapter (where GDI or `DesktopImageInSystemMemory` matters)
- Hybrid-GPU laptops
- Fast user switching
- `PromptOnSecureDesktop=0`: UAC then appears on `Default` and needs no secure-desktop handling
- DRM-protected content (`ProtectedContentMaskedOut`)
- Input injection on `Winlogon`, which is the next spike

## Files

- `src/main.rs`: CLI.
- `src/capture_loop.rs`: the loop described above.
- `src/capture/{dxgi,gdi}.rs`: the capture back ends.
- `src/desktop.rs`: input-desktop handles and names.
- `src/winevent.rs`: hook threads.
- `src/service.rs`: service, supervisor, and install/uninstall.
- `src/launch.rs`: token duplication and `CreateProcessAsUserW`.
- `src/saver.rs`: JPEG worker.
- `src/testdesk.rs`: animation window and private-desktop switch test.
- `src/logging.rs`, `src/util.rs`, `src/paths.rs`: support code.
