//! ConPTY host for SYSTEM shells, built directly on the Win32 API.
//!
//! Lifecycle (measured in the Phase 0 spike, `spikes/conpty-service/FINDINGS.md`):
//! * spawn: kill-on-close job → anonymous pipes → `CreatePseudoConsole` → drop conhost's pipe
//!   ends → start the reader → attribute list (PSEUDOCONSOLE + JOB_LIST, so the shell is in the
//!   job atomically) → `CreateProcessW` with a fresh environment block and null std handles.
//! * shutdown: `TerminateJobObject` if the shell still runs → `ClosePseudoConsole` on a helper
//!   thread while the reader keeps draining → reader sees `ERROR_BROKEN_PIPE` → close handles.

use std::ffi::c_void;
use std::marker::PhantomData;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Once};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use tokio::sync::{mpsc, oneshot};
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Security::{TOKEN_DUPLICATE, TOKEN_QUERY};
use windows::Win32::Storage::FileSystem::{ReadFile, WriteFile};
use windows::Win32::System::Console::{
    COORD, ClosePseudoConsole, CreatePseudoConsole, HPCON, ResizePseudoConsole,
    SetConsoleCtrlHandler,
};
use windows::Win32::System::Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock};
use windows::Win32::System::IO::CancelSynchronousIo;
use windows::Win32::System::JobObjects::{
    CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
};
use windows::Win32::System::Pipes::CreatePipe;
use windows::Win32::System::Threading::{
    CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DeleteProcThreadAttributeList,
    EXTENDED_STARTUPINFO_PRESENT, GetCurrentProcess, GetExitCodeProcess, INFINITE,
    InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST, OpenProcessToken,
    PROC_THREAD_ATTRIBUTE_JOB_LIST, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, PROCESS_INFORMATION,
    STARTF_USESTDHANDLES, STARTUPINFOEXW, UpdateProcThreadAttribute, WaitForSingleObject,
};
use windows::core::{PCWSTR, PWSTR};

use super::{PtyExit, PtyOutput};

const CLOSE_TIMEOUT: Duration = Duration::from_secs(10);
const READER_TIMEOUT: Duration = Duration::from_secs(5);
/// STATUS_CONTROL_C_EXIT — what a closed console yields.
const KILLED_EXIT_CODE: u32 = 0xC000_013A;

/// Owned kernel handle, closed exactly once.
struct Handle(HANDLE);

// SAFETY: kernel handles have no thread affinity; this wrapper is the single owner.
unsafe impl Send for Handle {}
// SAFETY: shared access only reads the raw value.
unsafe impl Sync for Handle {}

impl Handle {
    fn raw(&self) -> HANDLE {
        self.0
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_invalid() && !self.0.0.is_null() {
            // SAFETY: owned handle, closed once.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

/// Wrapper so the HPCON can move to the close thread.
struct Hpcon(HPCON);
// SAFETY: an HPCON is an opaque kernel-side handle usable from any thread.
unsafe impl Send for Hpcon {}

fn wide_os(s: &std::ffi::OsStr) -> Vec<u16> {
    s.encode_wide().chain(std::iter::once(0)).collect()
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn millis(d: Duration) -> u32 {
    u32::try_from(d.as_millis()).unwrap_or(u32::MAX - 1)
}

fn anonymous_pipe() -> Result<(Handle, Handle)> {
    let mut read = HANDLE::default();
    let mut write = HANDLE::default();
    // Not inheritable: only conhost receives (duplicated) ends.
    // SAFETY: valid out pointers.
    unsafe { CreatePipe(&mut read, &mut write, None, 0) }.context("CreatePipe")?;
    Ok((Handle(read), Handle(write)))
}

fn kill_on_close_job() -> Result<Handle> {
    // SAFETY: default security, unnamed.
    let raw = unsafe { CreateJobObjectW(None, PCWSTR::null()) }.context("CreateJobObjectW")?;
    let job = Handle(raw);
    let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // SAFETY: `info` is valid for the stated size.
    unsafe {
        SetInformationJobObject(
            job.raw(),
            JobObjectExtendedLimitInformation,
            (&raw const info).cast(),
            size_of_val(&info) as u32,
        )
    }
    .context("SetInformationJobObject")?;
    Ok(job)
}

/// PROC_THREAD_ATTRIBUTE_LIST in pointer-aligned storage; `'a` keeps the job array alive.
struct AttributeList<'a> {
    buf: Vec<usize>,
    initialized: bool,
    _values: PhantomData<&'a [HANDLE]>,
}

impl<'a> AttributeList<'a> {
    fn new(count: u32) -> Result<Self> {
        let mut size = 0usize;
        // SAFETY: size query with a null list.
        let _ = unsafe { InitializeProcThreadAttributeList(None, count, None, &mut size) };
        if size == 0 {
            bail!("InitializeProcThreadAttributeList size query failed");
        }
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
        // The attribute value is the HPCON itself, not a pointer to it.
        // SAFETY: initialized list; the HPCON outlives CreateProcess.
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
        // SAFETY: initialized list; `jobs` outlives it (lifetime `'a`).
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
            // SAFETY: initialized once, deleted once.
            unsafe { DeleteProcThreadAttributeList(self.as_raw()) };
        }
    }
}

/// A fresh default environment for this process's account: the agent's own PATH and any
/// variables in its environment must not flow into an operator's shell.
struct EnvironmentBlock(*mut c_void);

impl EnvironmentBlock {
    fn for_self() -> Result<Self> {
        let mut raw = HANDLE::default();
        // SAFETY: pseudo-handle of the current process.
        unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, &mut raw) }
            .context("OpenProcessToken")?;
        let token = Handle(raw);
        let mut block = std::ptr::null_mut();
        // SAFETY: valid token; freed in Drop.
        unsafe { CreateEnvironmentBlock(&mut block, Some(token.raw()), false) }
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

fn coord(cols: u16, rows: u16) -> COORD {
    COORD {
        X: cols.clamp(10, 500) as i16,
        Y: rows.clamp(5, 300) as i16,
    }
}

/// One shell attached to one pseudoconsole.
pub struct PtySession {
    hpc: Option<Hpcon>,
    input: Option<std::sync::mpsc::Sender<Vec<u8>>>,
    writer: Option<JoinHandle<()>>,
    process: Arc<Handle>,
    job: Handle,
    reader: Option<JoinHandle<()>>,
    closed: bool,
}

impl PtySession {
    pub fn spawn(
        program: &Path,
        args: &[String],
        cols: u16,
        rows: u16,
    ) -> Result<(Self, PtyOutput, PtyExit)> {
        static CTRL_C: Once = Once::new();
        CTRL_C.call_once(|| {
            // Children inherit an "ignore Ctrl+C" flag; clear it so 0x03 reaches the shell.
            // SAFETY: a null handler only toggles the process-wide flag.
            let _ = unsafe { SetConsoleCtrlHandler(None, false) };
        });

        let job = kill_on_close_job()?;
        let (input_theirs, input_ours) = anonymous_pipe()?;
        let (output_ours, output_theirs) = anonymous_pipe()?;
        // SAFETY: valid pipe handles; conhost duplicates them.
        let hpc = unsafe {
            CreatePseudoConsole(
                coord(cols, rows),
                input_theirs.raw(),
                output_theirs.raw(),
                0,
            )
        }
        .context("CreatePseudoConsole")?;
        // conhost holds its own duplicates; keeping ours would prevent EOF.
        drop(input_theirs);
        drop(output_theirs);

        // Drain before the child exists so no error path can deadlock in close.
        let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>(64);
        let reader = thread::Builder::new()
            .name("pty-reader".into())
            .spawn(move || reader_loop(output_ours, out_tx));
        let reader = match reader {
            Ok(r) => r,
            Err(e) => {
                // SAFETY: created above, closed once.
                unsafe { ClosePseudoConsole(hpc) };
                return Err(e).context("spawn reader thread");
            }
        };

        let (in_tx, in_rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let writer = thread::Builder::new()
            .name("pty-writer".into())
            .spawn(move || writer_loop(input_ours, in_rx))
            .context("spawn writer thread")?;

        let process = match launch(program, args, hpc, job.raw()) {
            Ok(p) => Arc::new(p),
            Err(e) => {
                let mut partial = Self {
                    hpc: Some(Hpcon(hpc)),
                    input: Some(in_tx),
                    writer: Some(writer),
                    process: Arc::new(Handle(HANDLE::default())),
                    job,
                    reader: Some(reader),
                    closed: false,
                };
                partial.shutdown();
                return Err(e);
            }
        };

        let (exit_tx, exit_rx) = oneshot::channel();
        let watched = Arc::clone(&process);
        thread::Builder::new()
            .name("pty-exit".into())
            .spawn(move || {
                // SAFETY: the Arc keeps the process handle open while we wait.
                unsafe { WaitForSingleObject(watched.raw(), INFINITE) };
                let mut code = 0u32;
                // SAFETY: valid process handle.
                let _ = unsafe { GetExitCodeProcess(watched.raw(), &mut code) };
                let _ = exit_tx.send(i64::from(code as i32));
            })
            .context("spawn exit watcher")?;

        Ok((
            Self {
                hpc: Some(Hpcon(hpc)),
                input: Some(in_tx),
                writer: Some(writer),
                process,
                job,
                reader: Some(reader),
                closed: false,
            },
            out_rx,
            exit_rx,
        ))
    }

    /// Queues keystrokes (never blocks the caller).
    pub fn write(&self, data: Vec<u8>) {
        if let Some(input) = &self.input {
            let _ = input.send(data);
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        let hpc = self.hpc.as_ref().context("pseudoconsole closed")?;
        // SAFETY: live HPCON.
        unsafe { ResizePseudoConsole(hpc.0, coord(cols, rows)) }.context("ResizePseudoConsole")
    }

    fn running(&self) -> bool {
        // SAFETY: valid (or null, which fails the wait) process handle.
        !self.process.raw().0.is_null()
            && unsafe { WaitForSingleObject(self.process.raw(), 0) } != WAIT_OBJECT_0
    }

    /// Bounded-time teardown; blocking — call from `spawn_blocking`.
    pub fn close(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        let started = Instant::now();
        if self.running() {
            // SAFETY: valid job handle.
            let _ = unsafe { TerminateJobObject(self.job.raw(), KILLED_EXIT_CODE) };
            // SAFETY: valid process handle.
            unsafe { WaitForSingleObject(self.process.raw(), 5000) };
        }
        // ClosePseudoConsole can block until output is drained; the reader keeps draining.
        if let Some(hpc) = self.hpc.take() {
            let (done_tx, done_rx) = std::sync::mpsc::channel();
            let spawned = thread::Builder::new()
                .name("pty-close".into())
                .spawn(move || {
                    let hpc = hpc;
                    // SAFETY: taken out of `self`, closed exactly once.
                    unsafe { ClosePseudoConsole(hpc.0) };
                    let _ = done_tx.send(());
                });
            if spawned.is_ok() && done_rx.recv_timeout(CLOSE_TIMEOUT).is_err() {
                tracing::warn!("ClosePseudoConsole still blocked; abandoning it");
            }
        }
        // Dropping the sender ends the writer, which closes the input pipe.
        self.input = None;
        if let Some(writer) = self.writer.take() {
            let _ = writer.join();
        }
        if let Some(reader) = self.reader.take() {
            let thread = HANDLE(reader.as_raw_handle());
            // SAFETY: the JoinHandle keeps the thread handle open.
            let mut finished =
                unsafe { WaitForSingleObject(thread, millis(READER_TIMEOUT)) } == WAIT_OBJECT_0;
            if !finished {
                // SAFETY: std thread handles carry THREAD_ALL_ACCESS.
                let _ = unsafe { CancelSynchronousIo(thread) };
                // SAFETY: as above.
                finished = unsafe { WaitForSingleObject(thread, 2000) } == WAIT_OBJECT_0;
            }
            if finished {
                let _ = reader.join();
            } else {
                tracing::warn!("pty reader thread leaked");
            }
        }
        tracing::debug!(
            elapsed_ms = started.elapsed().as_millis() as u64,
            "pty closed"
        );
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn reader_loop(pipe: Handle, tx: mpsc::Sender<Vec<u8>>) {
    let mut buf = vec![0u8; 16 * 1024];
    let mut consumer_alive = true;
    loop {
        let mut read = 0u32;
        // SAFETY: valid pipe handle and buffer; synchronous read.
        match unsafe { ReadFile(pipe.raw(), Some(&mut buf), Some(&raw mut read), None) } {
            Ok(()) if read > 0 => {
                // Keep draining even if nobody listens any more: conhost must never block.
                if consumer_alive && tx.blocking_send(buf[..read as usize].to_vec()).is_err() {
                    consumer_alive = false;
                }
            }
            Ok(()) => {}
            Err(_) => break, // ERROR_BROKEN_PIPE (conhost gone) or cancelled
        }
    }
}

fn writer_loop(pipe: Handle, rx: std::sync::mpsc::Receiver<Vec<u8>>) {
    while let Ok(data) = rx.recv() {
        let mut rest = data.as_slice();
        while !rest.is_empty() {
            let mut written = 0u32;
            // SAFETY: valid pipe handle and buffer; synchronous write.
            if unsafe { WriteFile(pipe.raw(), Some(rest), Some(&raw mut written), None) }.is_err() {
                return;
            }
            rest = &rest[written as usize..];
        }
    }
}

fn launch(program: &Path, args: &[String], hpc: HPCON, job: HANDLE) -> Result<Handle> {
    let jobs = [job];
    let mut attributes = AttributeList::new(2)?;
    attributes.set_pseudoconsole(hpc)?;
    attributes.set_job_list(&jobs)?;

    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    // Null std handles + STARTF_USESTDHANDLES: the child binds stdio to the pseudoconsole
    // instead of picking up the agent's (redirected) handles.
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.lpAttributeList = attributes.as_raw();

    let application = wide_os(program.as_os_str());
    let mut line = format!("\"{}\"", program.display());
    for arg in args {
        line.push(' ');
        line.push_str(arg);
    }
    let mut line = wide(&line);
    let cwd: PathBuf = program
        .ancestors()
        .last()
        .map(Path::to_path_buf)
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| PathBuf::from(r"C:\"));
    let cwd = wide_os(cwd.as_os_str());
    let environment = EnvironmentBlock::for_self()?;
    let mut info = PROCESS_INFORMATION::default();
    // SAFETY: every buffer outlives the call; EXTENDED_STARTUPINFO_PRESENT tells the API the
    // struct is a STARTUPINFOEXW. bInheritHandles = false: the shell inherits nothing from us.
    unsafe {
        CreateProcessW(
            PCWSTR(application.as_ptr()),
            Some(PWSTR(line.as_mut_ptr())),
            None,
            None,
            false,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
            Some(environment.0.cast_const()),
            PCWSTR(cwd.as_ptr()),
            (&raw const startup).cast(),
            &mut info,
        )
    }
    .context("CreateProcessW")?;
    drop(Handle(info.hThread));
    Ok(Handle(info.hProcess))
}
