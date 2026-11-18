# ConPTY from a LocalSystem service: spike findings

Throwaway Phase-0 spike. The question: can the RustRMM agent, running as a LocalSystem service, host an
interactive shell through a hand-written ConPTY host? It uses `windows` 0.62.2 and `windows-service`
0.8.1, with no ConPTY wrapper crate. All runs were on Windows 11 25H2, build 26200.9974, on 2026-11-17.

| Mode | Status |
|---|---|
| Console (unelevated) | **Verified.** `console` passes all 9 scenarios. |
| Service sequence without the SCM | **Verified.** `console --service-dry-run` runs the service's scenario list and its stop-time teardown of a live session; all pass. |
| Under the SCM as LocalSystem | **Not run yet.** It needs an elevated shell; see [Running it](#running-it). |

Code layout:

- `src/conpty.rs`: the host. Pipes, `CreatePseudoConsole`, the attribute list, `CreateProcess[AsUser]W`, the job, the reader thread and shutdown.
- `src/token.rs`: the console user's token and the identity helpers.
- `src/service.rs`: install, uninstall, `run-service`, `service-test` and the log directory.
- `src/demo.rs`: the scenarios, shared by console and service mode.

## What worked (measured)

- **Spawn:** `cmd.exe` and `powershell.exe -NoLogo -NoProfile` in an 80x25 pseudoconsole. `CreateProcess` returns in 35-60 ms (outliers up to 140 ms). The cmd prompt is up in about 40 ms; the PowerShell prompt in 0.3-0.5 s.
- **Commands:** typed `whoami` (UTF-8 bytes, Enter sent as `\r`) and read the answer back out of the VT stream.
- **Resize:** after `ResizePseudoConsole` to 120x40, `mode con` and `[Console]::WindowWidth/Height` both report 120x40.
- **Ctrl+C:** byte `0x03` stops a foreground `ping`. The job drops from 2 processes to 1 and the prompt returns. This needs pitfall 2 handled.
- **Clean exit:** type `exit`, the process exits, call `ClosePseudoConsole`, and the reader gets `ERROR_BROKEN_PIPE`. The whole close usually takes under 7 ms; the worst seen was 50 ms.
- **Forced close with a grandchild running** (`cmd` running `ping`): `TerminateJobObject` takes down the whole tree (2 processes to 0, exit code `0xC000013A`), then the same close. Total 4-58 ms. Nothing hung in any run.
- **`ReleasePseudoConsole`** is exported on this build (26100+). Called right after `CreateProcess`, it lets conhost exit with its last client. The reader then sees EOF 5-32 ms after `exit`, with no `ClosePseudoConsole` call.
- **`CreateProcessAsUserW`** works with a primary-token duplicate of our own token, the user's environment block, the profile directory as cwd and the `winsta0\default` desktop. No privilege had to be enabled. This is the service's user-shell code path; only the token source (`WTSQueryUserToken`) differs.
- **conhost identity:** conhost always runs as the caller of `CreatePseudoConsole`, in the caller's session. Every scenario logs this.

## Pitfalls hit

Each of the first three was reproduced on purpose with a `console` flag, then fixed. The fix is the default.

1. **Inherited environment hijacks commands** (`--inherit-env`).
   - The shell inherited the host's PATH, which has Git's `usr\bin` ahead of System32. `whoami` ran Git's `whoami.exe` and printed `Kyle`.
   - Fix: always pass a fresh `CreateEnvironmentBlock` (our own token for SYSTEM shells, the user's token for user shells). This also keeps secrets in the agent's environment out of operator shells.
2. **Inherited "ignore Ctrl+C" flag** (`--inherit-ctrl-c-state`).
   - Our launcher started us with Ctrl+C disabled (what `CREATE_NEW_PROCESS_GROUP` does). Every descendant inherits the flag, so `0x03` was silently ignored.
   - Fix: call `SetConsoleCtrlHandler(NULL, FALSE)` once at startup.
   - Service mode logs an `INFO` observation before the reset, which will show whether the SCM sets the flag too.
3. **No `STARTF_USESTDHANDLES`** (`--no-usestdhandles`).
   - The shell bound to the host's own redirected stdio. Its banner landed in our stdout pipe and ConPTY received nothing.
   - Fix: set `STARTF_USESTDHANDLES` with null handles, and `bInheritHandles = FALSE`.
4. **The close-without-drain hang does not reproduce on 26200, but the shell can survive the close.**
   - With the reader paused and 4158 bytes stuck in the pipe, `ClosePseudoConsole` still returned in under 0.1 ms. The documented hang is real on older builds, so keep draining during close.
   - With the shell still running and the pipe undrained, the shell was still alive 3 s after `ClosePseudoConsole`.
   - With the pipe drained, `ClosePseudoConsole` ends a live shell in 2-11 ms (exit `0xC000013A`).
   - So `ClosePseudoConsole` alone does not guarantee teardown. The job does.
5. **`ReleasePseudoConsole` is missing from the `windows` 0.62 metadata.** Resolve it at runtime with `GetProcAddress` (kernel32, then kernelbase). A static import would also stop the binary loading on builds before 26100.
6. **Attribute-list traps:**
   - The `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE` value is the HPCON itself, not a pointer to it.
   - `JOB_LIST` stores a pointer to your array, so the array must outlive `CreateProcess`. The spike enforces this with a lifetime.
   - Allocate the list as `Vec<usize>` so it is pointer-aligned.
   - Use `PROC_THREAD_ATTRIBUTE_JOB_LIST` rather than `CREATE_SUSPENDED` followed by `AssignProcessToJobObject`. It assigns the job atomically, with no window for the shell to escape.
7. **The shared spike directory is user-owned.**
   - The DXGI spike created `C:\ProgramData\RustRMMSpike` while unelevated. It is owned by the user, with ProgramData's inherited ACL, which lets Users create files and folders.
   - Anything a SYSTEM process writes below such a directory can be redirected with a junction.
   - This spike therefore logs to its own `conpty-service\` subfolder. The folder is created with a protected DACL: SYSTEM and Administrators full control, Authenticated Users read.
   - The service log carries a `WARNING` line whenever either directory is not owned by SYSTEM or Administrators.

Also observed: conhost's first output is `ESC[?9001h ESC[?1004h`, which requests win32-input-mode and focus events. xterm.js can ignore both. With flags = 0 there are no DSR or DA queries to answer.

## Recommended design for the agent

### API shape

```rust
pub enum PtyIdentity { LocalSystem, SessionUser { session_id: u32 } }

pub struct PtyConfig {
    pub shell: ShellKind,      // resolved to an absolute System32 path, never via PATH
    pub size: PtySize,
    pub identity: PtyIdentity,
}

impl PtySession {
    pub fn spawn(cfg: PtyConfig) -> Result<(PtySession, mpsc::Receiver<Bytes>)>;
    pub fn write(&self, keys: Bytes) -> Result<()>;      // queued to the writer thread
    pub fn resize(&self, size: PtySize) -> Result<()>;
    pub fn exited(&self) -> impl Future<Output = u32>;
    pub fn close(self) -> CloseReport;                   // bounded time, idempotent, also on Drop
}
```

Bytes pass through untouched in both directions: VT output goes to xterm.js and keystrokes come back. The agent never parses VT.

### Threading

- **Reader:** one OS thread per session. It does blocking `ReadFile` into a bounded `tokio::mpsc` channel, which gives backpressure. It must keep reading until `ERROR_BROKEN_PIPE`. If the consumer has gone, it discards the bytes, but it never stops reading before EOF.
- **Writer:** a writer thread (or `spawn_blocking`) fed by a bounded channel. `WriteFile` blocks when conhost stops reading, so it must never run on a runtime worker.
- **Exit watch:** wait on the process handle in a blocking task. On 26100+, call `ReleasePseudoConsole` after spawn; reader EOF then also means "session over".
- **Teardown:** run `TerminateJobObject` and `ClosePseudoConsole` in `spawn_blocking` with timeouts.
- **Scaling:** anonymous pipes cannot be overlapped. If thread count ever matters, switch to named pipes opened overlapped on our side only.

### Shutdown order

This is what the spike implements and measured.

1. Stop accepting input.
2. If the shell is alive, call `TerminateJobObject(job, 0xC000013A)` and wait on the process for up to 5 s.
3. Run `ClosePseudoConsole` on a helper thread while the reader keeps draining. After a 10 s timeout, abandon the HPCON.
4. The reader sees `ERROR_BROKEN_PIPE`. Join it with a timeout, using `CancelSynchronousIo` as the fallback.
5. Close the input pipe, the process handle and the job. `KILL_ON_JOB_CLOSE` is the backstop if the agent crashes.

A graceful end (the operator types `exit`) runs the same steps; step 2 is then a no-op.

### Run-as-user path

1. **Find the user's token.** Call `WTSGetActiveConsoleSessionId`, then `WTSQueryUserToken`.
   - This needs SeTcbPrivilege, so it only works as LocalSystem. Unelevated, it fails with `0x80070522`.
   - Fall back to `WTSEnumerateSessionsW` to find active RDP sessions. When more than one session is active, the operator should pick.
2. **Launch the shell.**
   - Build the environment with `CreateEnvironmentBlock(user token)` and take the cwd from `GetUserProfileDirectoryW`. Set `lpDesktop = "winsta0\default"`.
   - Call `CreateProcessAsUserW` with the same STARTUPINFOEXW (pseudoconsole plus job list).
   - On `ERROR_PRIVILEGE_NOT_HELD`, the spike enables SeAssignPrimaryToken and SeIncreaseQuota and retries. The service log will show whether that was needed.
3. **Elevation.** For an admin user the token is the UAC-limited one (observed here), so the shell runs unelevated. "Elevated as that user" would use `TokenLinkedToken`; that is not built or tested.
4. **Open question for service mode.** In the direct design, conhost belongs to the service. A user's shell would then talk to a SYSTEM conhost in session 0. Even if that works, it exposes a SYSTEM process's console-API parser to user-controlled code.
5. **Recommendation for user shells: a per-session broker.** Use the direct path for SYSTEM shells only. For user shells:
   - Start the agent exe in `pty-host` mode with `CreateProcessAsUserW`, without ConPTY.
   - The broker creates the ConPTY and the shell itself, so conhost runs as the user.
   - It relays bytes over a named pipe whose DACL admits only SYSTEM and that user's SID.
   - The service verifies the broker with `GetNamedPipeClientProcessId`.

### Other rules

- Launch shells only by absolute path from `GetSystemDirectoryW`. Start PowerShell with `-NoLogo -NoProfile`.
- Never run a LocalSystem binary from a user-writable path. The spike's `install` copies the exe to `%ProgramFiles%\RustRMMSpike`.
- The installer should create `%ProgramData%\RustRMM` with a protected DACL. The agent should check owner and DACL at startup and refuse to run if they are wrong.
- `KILL_ON_JOB_CLOSE` also kills anything the operator started on purpose, such as an installer. Offer "run detached" through the script runner instead.
- A remote SYSTEM shell is full control of the machine. Gate it with step-up authentication, audit logging and session recording.

## Not verified

- Anything under the SCM:
  - SYSTEM shells;
  - user shells across sessions (conhost in session 0, shell in session 1);
  - whether the SCM sets the "ignore Ctrl+C" flag;
  - service stop with a live session.
- Builds older than 26100, which lack `ReleasePseudoConsole` and are where the close-without-drain hang appears.
- Larger pipe buffers (the default held about 4 KB), elevated linked-token shells, Unicode and IME input.

## Running it

**Console mode** (no elevation):

```powershell
cargo build
.\target\debug\conpty-service-spike.exe console
```

**Service mode** runs from an **elevated** PowerShell in this folder. The one-shot `service-test` installs the service, starts it, streams the log, stops it while a session is live, and uninstalls it:

```powershell
cargo build
.\target\debug\conpty-service-spike.exe service-test
```

Or step by step:

```powershell
.\target\debug\conpty-service-spike.exe install
sc.exe start RustRMMConPtySpike
Get-Content C:\ProgramData\RustRMMSpike\conpty-service\conpty-service.log -Wait   # Ctrl+C after "PHASE: holding"
sc.exe stop RustRMMConPtySpike
Get-Content C:\ProgramData\RustRMMSpike\conpty-service\conpty-service.log -Tail 40
.\target\debug\conpty-service-spike.exe uninstall
```

You can read the log without elevation (Authenticated Users have read access). What to look for:

- `account NT AUTHORITY\SYSTEM, session 0`.
- `observe/ctrl-c-with-launcher-inherited-flag: INFO`, which shows whether the SCM sets the "ignore Ctrl+C" flag.
- `whoami: "nt authority\system"` for the caller-token scenarios.
- For `basic/*/user-token(...)`: the shell's account and session, and the `conhost:` line. If there is no prompt, read the shell's exit code in the error.
- The final `RESULT:` line, and how long the stop took.
