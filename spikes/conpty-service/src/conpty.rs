//! Hand-written ConPTY host: pseudoconsole + anonymous pipes + kill-on-close job + process launch.
//!
//! Lifecycle (details and rationale in FINDINGS.md):
//!
//! spawn:    job -> pipes -> CreatePseudoConsole -> close conhost-side pipe ends -> start the
//!           reader thread -> attribute list (PSEUDOCONSOLE + JOB_LIST) -> CreateProcess[AsUser]W
//!           -> optionally ReleasePseudoConsole (build 26100+).
//! shutdown: TerminateJobObject if the shell still runs -> ClosePseudoConsole on a helper thread
//!           while the reader keeps draining -> reader sees ERROR_BROKEN_PIPE -> close handles.

use std::ffi::c_void;
use std::marker::PhantomData;
use std::os::windows::io::AsRawHandle;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use windows::Win32::Foundation::{
    ERROR_BROKEN_PIPE, ERROR_OPERATION_ABORTED, ERROR_PRIVILEGE_NOT_HELD, HANDLE, WAIT_OBJECT_0,
};
use windows::Win32::Security::{SE_ASSIGNPRIMARYTOKEN_NAME, SE_INCREASE_QUOTA_NAME};
use windows::Win32::Storage::FileSystem::{ReadFile, WriteFile};
use windows::Win32::System::Console::{
    COORD, ClosePseudoConsole, CreatePseudoConsole, HPCON, ResizePseudoConsole,
    SetConsoleCtrlHandler,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock};
use windows::Win32::System::IO::CancelSynchronousIo;
use windows::Win32::System::JobObjects::{
    CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectBasicAccountingInformation,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject,
};
use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
use windows::Win32::System::Pipes::{CreatePipe, PeekNamedPipe};
use windows::Win32::System::Threading::{
    CREATE_UNICODE_ENVIRONMENT, CreateProcessAsUserW, CreateProcessW,
    DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetCurrentProcessId,
    GetExitCodeProcess, InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
    PROC_THREAD_ATTRIBUTE_JOB_LIST, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, PROCESS_INFORMATION,
    STARTF_USESTDHANDLES, STARTUPINFOEXW, UpdateProcThreadAttribute, WaitForSingleObject,
};
use windows::core::{HRESULT, PCWSTR, PWSTR, s, w};

use crate::token::{self, UserToken};
use crate::vt;
use crate::win::{Handle, from_wide, is_win32, wide, wide_os};

/// Upper bound for ClosePseudoConsole; it can block forever if conhost cannot flush.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(10);
/// How long the reader may take to see EOF once conhost is gone.
const READER_TIMEOUT: Duration = Duration::from_secs(5);
/// Exit code given to processes killed by TerminateJobObject.
const KILLED_EXIT_CODE: u32 = 0xC000_013A; // STATUS_CONTROL_C_EXIT, what a closed console yields

#[derive(Clone, Copy, Debug)]
pub struct PtySize {
    pub cols: i16,
    pub rows: i16,
}

impl PtySize {
    fn coord(self) -> COORD {
        COORD { X: self.cols, Y: self.rows }
    }
}

pub enum RunAs<'a> {
    /// `CreateProcessW`: the child inherits this process's token (LocalSystem in the service).
    Caller,
    /// `CreateProcessAsUserW` with this primary token (lands in the token's session).
    Token(&'a UserToken),
}

impl RunAs<'_> {
    pub fn label(&self) -> String {
        match self {
            RunAs::Caller => "caller-token".into(),
            RunAs::Token(user) => format!("user-token({})", user.account),
        }
    }
}

pub struct SpawnOptions<'a> {
    /// Absolute path; never resolved through PATH.
    pub application: PathBuf,
    /// Appended after the quoted application path.
    pub arguments: String,
    pub cwd: Option<PathBuf>,
    pub size: PtySize,
    pub run_as: RunAs<'a>,
    /// Set STARTF_USESTDHANDLES with null handles (see `launch`). Off only to reproduce the pitfall.
    pub use_std_handles: bool,
    /// `RunAs::Caller` only: inherit this process's environment instead of a fresh default
    /// block for its account. On only to reproduce the pitfall (PATH hijack, leaked variables).
    pub inherit_environment: bool,
    /// Call ReleasePseudoConsole right after the child is created (build 26100+).
    pub release_after_spawn: bool,
    /// Start the reader blocked; only for reproducing the close-without-drain hang.
    pub start_reader_paused: bool,
}

/// Bytes produced by conhost, collected by the reader thread.
#[derive(Default)]
pub struct Output {
    state: Mutex<OutputState>,
    changed: Condvar,
}

#[derive(Default)]
struct OutputState {
    data: Vec<u8>,
    eof: Option<(String, Instant)>,
}

impl Output {
    fn lock(&self) -> MutexGuard<'_, OutputState> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn push(&self, bytes: &[u8]) {
        self.lock().data.extend_from_slice(bytes);
        self.changed.notify_all();
    }

    fn finish(&self, reason: String) {
        self.lock().eof = Some((reason, Instant::now()));
        self.changed.notify_all();
    }

    pub fn len(&self) -> usize {
        self.lock().data.len()
    }

    pub fn raw_from(&self, offset: usize) -> Vec<u8> {
        let state = self.lock();
        state.data[offset.min(state.data.len())..].to_vec()
    }

    pub fn text_from(&self, offset: usize) -> String {
        vt::strip(&self.raw_from(offset))
    }

    pub fn eof(&self) -> Option<(String, Instant)> {
        self.lock().eof.clone()
    }

    /// Waits until `check` (fed the VT-stripped text received since `offset`) returns Some,
    /// the stream ends, or `timeout` passes.
    pub fn wait_for<T>(
        &self,
        offset: usize,
        timeout: Duration,
        mut check: impl FnMut(&str) -> Option<T>,
    ) -> Option<T> {
        let deadline = Instant::now() + timeout;
        let mut state = self.lock();
        loop {
            let text = vt::strip(&state.data[offset.min(state.data.len())..]);
            if let Some(found) = check(&text) {
                return Some(found);
            }
            let now = Instant::now();
            if state.eof.is_some() || now >= deadline {
                return None;
            }
            state = self
                .changed
                .wait_timeout(state, deadline - now)
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
    }

    pub fn wait_eof(&self, timeout: Duration) -> Option<(String, Instant)> {
        let deadline = Instant::now() + timeout;
        let mut state = self.lock();
        loop {
            if let Some(eof) = &state.eof {
                return Some(eof.clone());
            }
            let now = Instant::now();
            if now >= deadline {
                return None;
            }
            state = self
                .changed
                .wait_timeout(state, deadline - now)
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
    }
}

/// Lets a test hold the reader back so the output pipe fills up.
struct Gate {
    open: Mutex<bool>,
    changed: Condvar,
}

impl Gate {
    fn new(open: bool) -> Self {
        Self { open: Mutex::new(open), changed: Condvar::new() }
    }

    fn lock(&self) -> MutexGuard<'_, bool> {
        self.open.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn open(&self) {
        *self.lock() = true;
        self.changed.notify_all();
    }

    fn is_open(&self) -> bool {
        *self.lock()
    }

    fn wait(&self) {
        let mut open = self.lock();
        while !*open {
            open = self.changed.wait(open).unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }
}

fn reader_loop(pipe: Handle, output: &Output, gate: &Gate) {
    gate.wait();
    let mut buf = vec![0u8; 16 * 1024];
    let reason = loop {
        let mut read = 0u32;
        // SAFETY: valid pipe handle and buffer; synchronous (non-overlapped) read.
        match unsafe { ReadFile(pipe.raw(), Some(&mut buf), Some(&raw mut read), None) } {
            Ok(()) => output.push(&buf[..read as usize]),
            Err(e) if is_win32(&e, ERROR_BROKEN_PIPE) => {
                break "broken pipe (conhost closed its end)".to_string();
            }
            Err(e) if is_win32(&e, ERROR_OPERATION_ABORTED) => {
                break "read cancelled (CancelSynchronousIo)".to_string();
            }
            Err(e) => break format!("ReadFile failed: {e}"),
        }
    };
    drop(pipe);
    output.finish(reason);
}

/// Kill-on-close job holding the shell and everything it starts.
pub struct Job(Handle);

impl Job {
    pub fn kill_on_close() -> Result<Self> {
        // Unnamed: nothing else can open it by name.
        // SAFETY: default security, no name.
        let raw = unsafe { CreateJobObjectW(None, PCWSTR::null()) }.context("CreateJobObjectW")?;
        let job = Self(Handle::new(raw));
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: `info` is a valid JOBOBJECT_EXTENDED_LIMIT_INFORMATION of the stated size.
        unsafe {
            SetInformationJobObject(
                job.raw(),
                JobObjectExtendedLimitInformation,
                (&raw const info).cast(),
                size_of_val(&info) as u32,
            )
        }
        .context("SetInformationJobObject(KILL_ON_JOB_CLOSE)")?;
        Ok(job)
    }

    pub fn raw(&self) -> HANDLE {
        self.0.raw()
    }

    pub fn active_processes(&self) -> Result<u32> {
        let mut acct = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        // SAFETY: `acct` is a valid buffer of the stated size.
        unsafe {
            QueryInformationJobObject(
                Some(self.raw()),
                JobObjectBasicAccountingInformation,
                (&raw mut acct).cast(),
                size_of_val(&acct) as u32,
                None,
            )
        }
        .context("QueryInformationJobObject")?;
        Ok(acct.ActiveProcesses)
    }

    pub fn terminate(&self, exit_code: u32) -> Result<()> {
        // SAFETY: valid job handle.
        unsafe { TerminateJobObject(self.raw(), exit_code) }.context("TerminateJobObject")
    }
}

/// PROC_THREAD_ATTRIBUTE_LIST in pointer-aligned storage. `'a` ties the list to the values whose
/// addresses it stores (the job handle array) so they cannot be dropped before CreateProcess.
struct AttributeList<'a> {
    buf: Vec<usize>,
    initialized: bool,
    _values: PhantomData<&'a [HANDLE]>,
}

impl<'a> AttributeList<'a> {
    fn new(count: u32) -> Result<Self> {
        let mut size = 0usize;
        // Size query: expected to fail with ERROR_INSUFFICIENT_BUFFER.
        // SAFETY: a null list is allowed for the size query.
        let _ = unsafe { InitializeProcThreadAttributeList(None, count, None, &mut size) };
        if size == 0 {
            bail!("InitializeProcThreadAttributeList size query returned 0");
        }
        // Vec<usize>, not Vec<u8>: the opaque list stores pointers and must be aligned for them.
        let mut list = Self {
            buf: vec![0usize; size.div_ceil(size_of::<usize>())],
            initialized: false,
            _values: PhantomData,
        };
        // SAFETY: the buffer holds at least `size` bytes.
        unsafe { InitializeProcThreadAttributeList(Some(list.as_raw()), count, None, &mut size) }
            .context("InitializeProcThreadAttributeList")?;
        list.initialized = true;
        Ok(list)
    }

    fn as_raw(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        LPPROC_THREAD_ATTRIBUTE_LIST(self.buf.as_mut_ptr().cast())
    }

    fn set_pseudoconsole(&mut self, hpc: HPCON) -> Result<()> {
        // The attribute *value* is the HPCON itself, not a pointer to an HPCON.
        // SAFETY: initialized list; the HPCON stays alive until after CreateProcess.
        unsafe {
            UpdateProcThreadAttribute(
                self.as_raw(),
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                Some(hpc.0 as *const c_void),
                size_of::<HPCON>(),
                None,
                None,
            )
        }
        .context("UpdateProcThreadAttribute(PSEUDOCONSOLE)")
    }

    fn set_job_list(&mut self, jobs: &'a [HANDLE]) -> Result<()> {
        // The list keeps this pointer (not a copy), hence the `'a` borrow.
        // SAFETY: initialized list; `jobs` outlives the list by construction.
        unsafe {
            UpdateProcThreadAttribute(
                self.as_raw(),
                0,
                PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
                Some(jobs.as_ptr().cast()),
                size_of_val(jobs),
                None,
                None,
            )
        }
        .context("UpdateProcThreadAttribute(JOB_LIST)")
    }
}

impl Drop for AttributeList<'_> {
    fn drop(&mut self) {
        if self.initialized {
            // SAFETY: initialized exactly once, deleted exactly once.
            unsafe { DeleteProcThreadAttributeList(self.as_raw()) };
        }
    }
}

/// The target user's environment (USERPROFILE, APPDATA, ...) instead of the service's.
struct EnvironmentBlock(*mut c_void);

impl EnvironmentBlock {
    fn for_token(token: HANDLE) -> Result<Self> {
        let mut block = std::ptr::null_mut();
        // SAFETY: valid token; the block is freed in Drop.
        unsafe { CreateEnvironmentBlock(&mut block, Some(token), false) }
            .context("CreateEnvironmentBlock")?;
        Ok(Self(block))
    }
}

impl Drop for EnvironmentBlock {
    fn drop(&mut self) {
        // SAFETY: allocated by CreateEnvironmentBlock.
        unsafe {
            let _ = DestroyEnvironmentBlock(self.0);
        }
    }
}

type ReleasePseudoConsoleFn = unsafe extern "system" fn(HPCON) -> HRESULT;

/// `ReleasePseudoConsole` exists only on build 26100+ and is missing from the `windows` crate
/// metadata, so resolve it at runtime; a static import would stop the exe loading on older builds.
pub fn release_pseudoconsole_fn() -> Option<ReleasePseudoConsoleFn> {
    static FUNCTION: OnceLock<Option<ReleasePseudoConsoleFn>> = OnceLock::new();
    *FUNCTION.get_or_init(|| {
        for dll in [w!("kernel32.dll"), w!("kernelbase.dll")] {
            // SAFETY: both modules are always loaded in a Win32 process.
            let Ok(module) = (unsafe { GetModuleHandleW(dll) }) else { continue };
            // SAFETY: valid module handle and NUL-terminated name.
            if let Some(address) = unsafe { GetProcAddress(module, s!("ReleasePseudoConsole")) } {
                // SAFETY: documented signature: HRESULT WINAPI ReleasePseudoConsole(HPCON).
                return Some(unsafe {
                    std::mem::transmute::<unsafe extern "system" fn() -> isize, ReleasePseudoConsoleFn>(
                        address,
                    )
                });
            }
        }
        None
    })
}

/// Clears this process's "ignore Ctrl+C" flag. The flag is inherited by every process we create
/// (and theirs): if our own launcher used CREATE_NEW_PROCESS_GROUP, the shells we host would
/// silently ignore the 0x03 that ConPTY turns into CTRL_C_EVENT. Process-wide; call once.
pub fn enable_ctrl_c_for_children() -> Result<()> {
    // SAFETY: a null handler only toggles the process's ignore-Ctrl+C flag.
    unsafe { SetConsoleCtrlHandler(None, false) }.context("SetConsoleCtrlHandler(NULL, FALSE)")
}

/// PIDs of conhost.exe / OpenConsole.exe processes whose parent is this process.
fn child_conhosts() -> Vec<u32> {
    // SAFETY: no preconditions.
    let me = unsafe { GetCurrentProcessId() };
    // SAFETY: plain snapshot; the handle is owned below.
    let Ok(raw) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
        return Vec::new();
    };
    let snapshot = Handle::new(raw);
    let mut entry =
        PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
    let mut found = Vec::new();
    // SAFETY: valid snapshot and correctly sized entry.
    let mut more = unsafe { Process32FirstW(snapshot.raw(), &mut entry) }.is_ok();
    while more {
        if entry.th32ParentProcessID == me {
            let name = from_wide(&entry.szExeFile);
            if name.eq_ignore_ascii_case("conhost.exe") || name.eq_ignore_ascii_case("OpenConsole.exe")
            {
                found.push(entry.th32ProcessID);
            }
        }
        // SAFETY: as above.
        more = unsafe { Process32NextW(snapshot.raw(), &mut entry) }.is_ok();
    }
    found
}

fn anonymous_pipe() -> Result<(Handle, Handle)> {
    let mut read = HANDLE::default();
    let mut write = HANDLE::default();
    // No SECURITY_ATTRIBUTES => not inheritable: only conhost receives (duplicated) ends.
    // SAFETY: valid out pointers.
    unsafe { CreatePipe(&mut read, &mut write, None, 0) }?;
    Ok((Handle::new(read), Handle::new(write)))
}

fn millis(d: Duration) -> u32 {
    u32::try_from(d.as_millis()).unwrap_or(u32::MAX - 1)
}

/// One shell attached to one pseudoconsole.
pub struct PtySession {
    hpc: Option<HPCON>,
    input: Option<Handle>,
    process: Option<Handle>,
    pub pid: u32,
    job: Job,
    output: Arc<Output>,
    gate: Arc<Gate>,
    reader: Option<JoinHandle<()>>,
    /// Non-owning copy of the reader's pipe handle, for PeekNamedPipe while the reader is paused.
    output_peek: HANDLE,
    pub conhost_pid: Option<u32>,
    pub released: bool,
    closed: bool,
}

pub fn spawn(opts: &SpawnOptions<'_>) -> Result<PtySession> {
    let job = Job::kill_on_close()?;

    // Input pipe: we write `input_ours`, conhost reads `input_theirs`.
    // Output pipe: conhost writes `output_theirs`, we read `output_ours`.
    let (input_theirs, input_ours) = anonymous_pipe().context("CreatePipe(input)")?;
    let (output_ours, output_theirs) = anonymous_pipe().context("CreatePipe(output)")?;

    let conhosts_before = child_conhosts();
    // SAFETY: valid pipe handles; CreatePseudoConsole duplicates them into conhost.
    let hpc = unsafe {
        CreatePseudoConsole(opts.size.coord(), input_theirs.raw(), output_theirs.raw(), 0)
    }
    .context("CreatePseudoConsole")?;
    let conhost_pid = child_conhosts().into_iter().find(|pid| !conhosts_before.contains(pid));
    // conhost holds its own duplicates. Keeping ours open would mean the reader never sees EOF.
    drop(input_theirs);
    drop(output_theirs);

    // Start draining *before* the child exists, so no later error path can deadlock in close.
    let output = Arc::new(Output::default());
    let gate = Arc::new(Gate::new(!opts.start_reader_paused));
    let output_peek = output_ours.raw();
    let spawned = {
        let output = Arc::clone(&output);
        let gate = Arc::clone(&gate);
        thread::Builder::new()
            .name("pty-reader".into())
            .spawn(move || reader_loop(output_ours, &output, &gate))
    };
    let reader = match spawned {
        Ok(reader) => reader,
        Err(e) => {
            // The read end was dropped with the closure, so conhost cannot block on output.
            // SAFETY: created above, closed exactly once.
            unsafe { ClosePseudoConsole(hpc) };
            return Err(e).context("spawn reader thread");
        }
    };

    // From here on, dropping `session` runs the full shutdown sequence.
    let mut session = PtySession {
        hpc: Some(hpc),
        input: Some(input_ours),
        process: None,
        pid: 0,
        job,
        output,
        gate,
        reader: Some(reader),
        output_peek,
        conhost_pid,
        released: false,
        closed: false,
    };

    let (process, pid) = launch(opts, hpc, session.job.raw())?;
    session.process = Some(process);
    session.pid = pid;

    if opts.release_after_spawn {
        session.release()?;
    }
    Ok(session)
}

fn launch(opts: &SpawnOptions<'_>, hpc: HPCON, job: HANDLE) -> Result<(Handle, u32)> {
    let jobs = [job];
    let mut attributes = AttributeList::new(2)?;
    attributes.set_pseudoconsole(hpc)?;
    // Atomic job assignment at creation: no CREATE_SUSPENDED/AssignProcessToJobObject window in
    // which the shell could spawn something outside the job.
    attributes.set_job_list(&jobs)?;

    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    if opts.use_std_handles {
        // Null std handles + STARTF_USESTDHANDLES: the child binds stdio to the pseudoconsole.
        // Without it the child can pick up this process's redirected stdio instead.
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    }
    startup.lpAttributeList = attributes.as_raw();

    let application = wide_os(opts.application.as_os_str());
    let command_line = || {
        let mut line = format!("\"{}\"", opts.application.display());
        if !opts.arguments.is_empty() {
            line.push(' ');
            line.push_str(&opts.arguments);
        }
        // Fresh buffer per call: CreateProcess* may write into it.
        wide(&line)
    };
    let cwd = opts.cwd.as_ref().map(|p| wide_os(p.as_os_str()));
    let cwd_ptr = cwd.as_ref().map_or(PCWSTR::null(), |c| PCWSTR(c.as_ptr()));
    // No CREATE_NO_WINDOW / DETACHED_PROCESS / CREATE_NEW_CONSOLE: they conflict with attaching
    // to the pseudoconsole. bInheritHandles = false: the shell inherits nothing from us.
    let flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT;
    let mut info = PROCESS_INFORMATION::default();

    match &opts.run_as {
        RunAs::Caller => {
            // A fresh default environment for our own account rather than our inherited one:
            // the agent's PATH (here: Git's usr\bin ahead of System32) and any secrets in its
            // environment must not flow into an operator's shell.
            let environment = if opts.inherit_environment {
                None
            } else {
                Some(EnvironmentBlock::for_token(token::own_token()?.raw())?)
            };
            let mut line = command_line();
            // SAFETY: all buffers outlive the call; STARTUPINFOEXW begins with STARTUPINFOW and
            // EXTENDED_STARTUPINFO_PRESENT tells the API to read the extended struct.
            unsafe {
                CreateProcessW(
                    PCWSTR(application.as_ptr()),
                    Some(PWSTR(line.as_mut_ptr())),
                    None,
                    None,
                    false,
                    flags,
                    environment.as_ref().map(|e| e.0.cast_const()),
                    cwd_ptr,
                    (&raw const startup).cast(),
                    &mut info,
                )
            }
            .context("CreateProcessW")?;
        }
        RunAs::Token(user) => {
            // A child in another session must not inherit the service's session-0 desktop.
            let mut desktop = wide(r"winsta0\default");
            startup.StartupInfo.lpDesktop = PWSTR(desktop.as_mut_ptr());
            let environment = EnvironmentBlock::for_token(user.token.raw())?;
            let create = |info: &mut PROCESS_INFORMATION| {
                let mut line = command_line();
                // SAFETY: as for CreateProcessW; the token, environment and desktop outlive the call.
                unsafe {
                    CreateProcessAsUserW(
                        Some(user.token.raw()),
                        PCWSTR(application.as_ptr()),
                        Some(PWSTR(line.as_mut_ptr())),
                        None,
                        None,
                        false,
                        flags,
                        Some(environment.0.cast_const()),
                        cwd_ptr,
                        (&raw const startup).cast(),
                        info,
                    )
                }
            };
            match create(&mut info) {
                Ok(()) => {}
                Err(e) if is_win32(&e, ERROR_PRIVILEGE_NOT_HELD) => {
                    let assign = token::enable_privilege(SE_ASSIGNPRIMARYTOKEN_NAME);
                    let quota = token::enable_privilege(SE_INCREASE_QUOTA_NAME);
                    logln!(
                        "CreateProcessAsUserW: {e}; enabled SeAssignPrimaryToken={assign:?} SeIncreaseQuota={quota:?}; retrying"
                    );
                    create(&mut info).context("CreateProcessAsUserW (after enabling privileges)")?;
                }
                Err(e) => return Err(e).context("CreateProcessAsUserW"),
            }
        }
    }
    drop(Handle::new(info.hThread));
    Ok((Handle::new(info.hProcess), info.dwProcessId))
}

/// What happened during shutdown, for the log.
pub struct CloseReport {
    pub exit_code: Option<u32>,
    pub terminated_job: bool,
    pub job_active_before: Option<u32>,
    pub job_active_after: Option<u32>,
    /// None: already closed earlier. Some(None): timed out (HPCON abandoned on its thread).
    pub close_pseudoconsole: Option<Option<Duration>>,
    pub reader_finished: bool,
    /// EOF reason and when it arrived relative to the start of shutdown (0 if before).
    pub reader_eof: Option<(String, Duration)>,
    pub total: Duration,
}

impl CloseReport {
    pub fn clean(&self) -> bool {
        !matches!(self.close_pseudoconsole, Some(None))
            && self.reader_finished
            && self.reader_eof.is_some()
            && self.job_active_after.unwrap_or(0) == 0
    }

    pub fn log(&self) {
        let close = match self.close_pseudoconsole {
            None => "was already closed".to_string(),
            Some(Some(d)) => format!("returned in {}", fmt_ms(d)),
            Some(None) => format!("TIMED OUT after {CLOSE_TIMEOUT:?}"),
        };
        let eof = match &self.reader_eof {
            Some((reason, at)) => format!("{reason} at +{}", fmt_ms(*at)),
            None => "none".to_string(),
        };
        logln!(
            "close: exit code {}, job terminated {}, job processes before/after {:?}/{:?}",
            self.exit_code.map_or_else(|| "none".into(), |c| format!("{c:#x}")),
            self.terminated_job,
            self.job_active_before,
            self.job_active_after
        );
        logln!(
            "close: ClosePseudoConsole {close}; reader EOF: {eof}; reader joined {}; total {}",
            self.reader_finished,
            fmt_ms(self.total)
        );
    }
}

pub fn fmt_ms(d: Duration) -> String {
    format!("{:.1} ms", d.as_secs_f64() * 1000.0)
}

impl PtySession {
    pub fn output(&self) -> &Output {
        &self.output
    }

    pub fn job(&self) -> &Job {
        &self.job
    }

    pub fn identity(&self) -> String {
        match &self.process {
            Some(p) => token::process_identity(p.raw(), self.pid),
            None => "<no process>".into(),
        }
    }

    /// Writes VT input (keystrokes). Enter is "\r", Ctrl+C is "\x03".
    pub fn write(&self, mut data: &[u8]) -> Result<()> {
        let input = self.input.as_ref().context("input already closed")?;
        while !data.is_empty() {
            let mut written = 0u32;
            // SAFETY: valid pipe handle and buffer; synchronous write.
            unsafe { WriteFile(input.raw(), Some(data), Some(&raw mut written), None) }
                .context("WriteFile(pty input)")?;
            data = &data[written as usize..];
        }
        Ok(())
    }

    pub fn resize(&self, size: PtySize) -> Result<()> {
        let hpc = self.hpc.context("pseudoconsole already closed")?;
        // SAFETY: live HPCON.
        unsafe { ResizePseudoConsole(hpc, size.coord()) }.context("ResizePseudoConsole")
    }

    pub fn exit_code(&self) -> Option<u32> {
        let process = self.process.as_ref()?;
        // SAFETY: valid process handle.
        if unsafe { WaitForSingleObject(process.raw(), 0) } != WAIT_OBJECT_0 {
            return None;
        }
        let mut code = 0u32;
        // SAFETY: valid process handle and out pointer.
        unsafe { GetExitCodeProcess(process.raw(), &mut code) }.ok()?;
        Some(code)
    }

    pub fn wait_exit(&self, timeout: Duration) -> Option<u32> {
        let process = self.process.as_ref()?;
        // SAFETY: valid process handle.
        unsafe { WaitForSingleObject(process.raw(), millis(timeout)) };
        self.exit_code()
    }

    /// Drops our reference so conhost exits by itself when its last client leaves (26100+).
    fn release(&mut self) -> Result<()> {
        let release = release_pseudoconsole_fn()
            .context("ReleasePseudoConsole is not exported (needs build 26100+)")?;
        let hpc = self.hpc.context("pseudoconsole already closed")?;
        // SAFETY: live HPCON; resolved function has the documented signature.
        unsafe { release(hpc) }.ok().context("ReleasePseudoConsole")?;
        self.released = true;
        Ok(())
    }

    pub fn open_gate(&self) {
        self.gate.open();
    }

    /// Unread bytes in the output pipe. Only while the reader is paused: with a synchronous
    /// ReadFile in flight on the same handle this call would block.
    pub fn pending_output_bytes(&self) -> Option<u32> {
        if self.gate.is_open() {
            return None;
        }
        let mut available = 0u32;
        // SAFETY: the paused reader still owns (and has not closed) this handle.
        unsafe { PeekNamedPipe(self.output_peek, None, 0, None, Some(&raw mut available), None) }
            .ok()?;
        Some(available)
    }

    /// Runs ClosePseudoConsole on a helper thread (it can block until output is drained).
    /// The receiver yields how long the call took.
    pub fn close_pseudoconsole_async(&mut self) -> Option<mpsc::Receiver<Duration>> {
        let hpc = self.hpc.take()?;
        let (done, receiver) = mpsc::channel();
        let spawned = thread::Builder::new().name("pty-close".into()).spawn(move || {
            let started = Instant::now();
            // SAFETY: taken out of `self`, so closed exactly once.
            unsafe { ClosePseudoConsole(hpc) };
            let _ = done.send(started.elapsed());
        });
        if let Err(e) = spawned {
            logln!("could not spawn close thread ({e}); closing inline");
            // SAFETY: the closure never ran, so this is still the only close.
            unsafe { ClosePseudoConsole(hpc) };
            return None;
        }
        Some(receiver)
    }

    /// Kills the shell tree if needed and tears everything down without hanging.
    pub fn close(mut self) -> CloseReport {
        self.shutdown()
    }

    fn shutdown(&mut self) -> CloseReport {
        let start = Instant::now();
        self.closed = true;
        // conhost flushes a final frame during close; someone must be reading it.
        self.gate.open();

        let job_active_before = self.job.active_processes().ok();
        let mut terminated_job = false;
        if self.process.is_some() && self.exit_code().is_none() {
            match self.job.terminate(KILLED_EXIT_CODE) {
                Ok(()) => terminated_job = true,
                Err(e) => logln!("shutdown: {e:#}"),
            }
            let _ = self.wait_exit(Duration::from_secs(5));
        }
        let job_active_after = self.wait_job_empty(Duration::from_secs(2));

        let close_pseudoconsole = self.close_pseudoconsole_async().map(|receiver| {
            let took = receiver.recv_timeout(CLOSE_TIMEOUT).ok();
            if took.is_none() {
                logln!("shutdown: ClosePseudoConsole still blocked after {CLOSE_TIMEOUT:?}; abandoning it");
            }
            took
        });

        self.input = None;
        let reader_finished = self.join_reader(READER_TIMEOUT);
        let reader_eof =
            self.output.eof().map(|(reason, at)| (reason, at.saturating_duration_since(start)));

        CloseReport {
            exit_code: self.exit_code(),
            terminated_job,
            job_active_before,
            job_active_after,
            close_pseudoconsole,
            reader_finished,
            reader_eof,
            total: start.elapsed(),
        }
    }

    fn wait_job_empty(&self, timeout: Duration) -> Option<u32> {
        let deadline = Instant::now() + timeout;
        loop {
            let active = self.job.active_processes().ok()?;
            if active == 0 || Instant::now() >= deadline {
                return Some(active);
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn join_reader(&mut self, timeout: Duration) -> bool {
        let Some(reader) = self.reader.take() else { return true };
        let thread = HANDLE(reader.as_raw_handle());
        // SAFETY: the JoinHandle keeps the thread handle open while we wait on it.
        let mut finished = unsafe { WaitForSingleObject(thread, millis(timeout)) } == WAIT_OBJECT_0;
        if !finished {
            logln!("shutdown: reader still blocked after {timeout:?}; CancelSynchronousIo");
            // SAFETY: std creates thread handles with THREAD_ALL_ACCESS.
            let _ = unsafe { CancelSynchronousIo(thread) };
            // SAFETY: as above.
            finished = unsafe { WaitForSingleObject(thread, 2000) } == WAIT_OBJECT_0;
        }
        if finished {
            let _ = reader.join();
        } else {
            logln!("shutdown: reader thread leaked");
        }
        finished
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        if !self.closed {
            let _ = self.shutdown();
        }
    }
}
