//! RustRMM Phase-0 spike: capture the active console session's screen from a
//! helper process launched by a LocalSystem service, following desktop
//! switches so the UAC secure desktop and the Winlogon / lock screen are
//! captured too. DXGI Desktop Duplication first, GDI BitBlt as the fallback.
//!
//! Throwaway code: see FINDINGS.md for what it proved and what to keep.

/// Log a line to this process's log file (and to stderr in console mode).
macro_rules! log {
    ($($arg:tt)*) => {
        $crate::logging::write(format_args!($($arg)*))
    };
}

mod capture;
mod capture_loop;
mod desktop;
mod launch;
mod logging;
mod paths;
mod saver;
mod service;
mod testdesk;
mod util;
mod winevent;

use std::str::FromStr;
use std::time::Duration;

use anyhow::{Context, anyhow, bail};

use crate::capture_loop::LoopOptions;

const USAGE: &str = "\
dxgi-spike - RustRMM Phase-0 secure-desktop capture spike

USAGE:
  dxgi-spike console [loop options] [--seconds N] [--animate] [--switch-test] [--hold S]
      Capture the current input desktop from this process (no service, no elevation).
      --seconds N       stop after N seconds (default 15)
      --animate         show a small animated window so the screen changes every vsync
      --switch-test     create a private desktop, switch the console to it for --hold
                        seconds (default 4) and back, to exercise desktop following
  dxgi-spike install | start | stop | status | uninstall [--purge]
      Manage the LocalSystem service. install/uninstall/start/stop need an elevated prompt.
  dxgi-spike outputs
      List DXGI adapters and outputs.
  dxgi-spike helper [loop options] [--parent-pid PID]
      Capture loop that the service launches inside the console session (internal).
  dxgi-spike service
      Service entry point used by the SCM (internal).

LOOP OPTIONS:
  --output N          DXGI output index from `outputs` (default: primary)
  --save-interval S   save the latest changed frame every S seconds (default 2)
  --max-saved N       stop writing frames after N files (console 200, helper 600)
  --quality Q         JPEG quality 1-100 (default 80)
  --force-gdi         skip DXGI and capture with GDI BitBlt
  --gdi-fps F         GDI capture rate cap, 0 = unpaced (default 15)
  --no-follow         do not follow input-desktop switches (negative test)

Frames: C:\\ProgramData\\RustRMMSpike\\frames    Logs: C:\\ProgramData\\RustRMMSpike\\logs
";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Err(e) = run(&args) {
        log!("fatal: {e:#}");
        if !logging::echoing() {
            eprintln!("error: {e:#}");
        }
        std::process::exit(1);
    }
}

fn run(args: &[String]) -> anyhow::Result<()> {
    let Some((command, rest)) = args.split_first() else {
        print!("{USAGE}");
        return Ok(());
    };
    match command.as_str() {
        "console" => console(rest),
        "helper" => helper(rest),
        "service" => service::run_dispatcher(),
        "install" => service::install(),
        "uninstall" => service::uninstall(rest.iter().any(|a| a == "--purge")),
        "start" => service::start(),
        "stop" => service::stop(),
        "status" => service::status(),
        "outputs" => outputs(),
        "help" | "-h" | "--help" => {
            print!("{USAGE}");
            Ok(())
        }
        other => bail!("unknown command '{other}'; run with --help"),
    }
}

fn console(rest: &[String]) -> anyhow::Result<()> {
    let mut opts = LoopOptions::console();
    let mut animate = false;
    let mut switch_test = false;
    let mut hold = Duration::from_secs(4);
    let mut cursor = Cursor::new(rest);
    while let Some(flag) = cursor.next_flag() {
        if loop_option(flag, &mut cursor, &mut opts)? {
            continue;
        }
        match flag {
            "--seconds" => opts.duration = Some(cursor.seconds(flag)?),
            "--animate" => animate = true,
            "--switch-test" => switch_test = true,
            "--hold" => hold = cursor.seconds(flag)?,
            other => bail!("unknown console option '{other}'"),
        }
    }

    logging::init(&paths::logs_dir().join("console.log"), true)?;
    util::set_dpi_awareness();
    util::install_ctrl_handler();
    log!("console mode: {}", util::identity_summary());

    let animation = if animate {
        Some(testdesk::AnimationWindow::spawn()?)
    } else {
        None
    };
    let switcher = switch_test.then(|| {
        std::thread::spawn(move || testdesk::run_switch_sequence(Duration::from_secs(3), hold))
    });

    let summary = capture_loop::run(opts);

    // Always join the switcher before exiting: it is what switches the console
    // back to the original desktop.
    if let Some(handle) = switcher {
        match handle.join() {
            Ok(Ok(())) => {}
            Ok(Err(e)) => log!("switch-test failed: {e:#}"),
            Err(_) => log!("switch-test thread panicked"),
        }
    }
    drop(animation);
    summary?.log();
    Ok(())
}

fn helper(rest: &[String]) -> anyhow::Result<()> {
    let mut opts = LoopOptions::helper();
    let mut parent_pid: Option<u32> = None;
    let mut cursor = Cursor::new(rest);
    while let Some(flag) = cursor.next_flag() {
        if loop_option(flag, &mut cursor, &mut opts)? {
            continue;
        }
        match flag {
            "--parent-pid" => parent_pid = Some(cursor.value(flag)?),
            other => bail!("unknown helper option '{other}'"),
        }
    }

    logging::init(&paths::logs_dir().join("helper.log"), false)?;
    log!("helper starting: {}", util::identity_summary());
    util::set_dpi_awareness();
    if let Some(pid) = parent_pid {
        util::exit_when_process_exits(pid);
    }
    capture_loop::run(opts)?.log();
    Ok(())
}

fn outputs() -> anyhow::Result<()> {
    util::set_dpi_awareness();
    let list = capture::dxgi::list_outputs().context("enumerating DXGI outputs")?;
    if list.is_empty() {
        println!("no DXGI outputs found");
    }
    for entry in &list {
        let i = &entry.info;
        println!(
            "#{} {}  adapter '{}'  desktop ({},{})-({},{})  attached={}  rotation={}",
            i.index,
            i.device_name,
            i.adapter_name,
            i.rect.left,
            i.rect.top,
            i.rect.right,
            i.rect.bottom,
            i.attached,
            i.rotation
        );
    }
    Ok(())
}

/// Handles the options shared by `console` and `helper`. Returns false for
/// flags it does not know so the caller can try its own.
fn loop_option(
    flag: &str,
    cursor: &mut Cursor<'_>,
    opts: &mut LoopOptions,
) -> anyhow::Result<bool> {
    match flag {
        "--output" => opts.output = Some(cursor.value(flag)?),
        "--save-interval" => opts.save_interval = cursor.seconds(flag)?,
        "--max-saved" => opts.max_saved = cursor.value(flag)?,
        "--quality" => opts.jpeg_quality = cursor.value::<u8>(flag)?.clamp(1, 100),
        "--force-gdi" => opts.force_gdi = true,
        "--gdi-fps" => opts.gdi_fps = cursor.value(flag)?,
        "--no-follow" => opts.follow = false,
        _ => return Ok(false),
    }
    Ok(true)
}

struct Cursor<'a> {
    args: &'a [String],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn new(args: &'a [String]) -> Self {
        Self { args, pos: 0 }
    }

    fn next_flag(&mut self) -> Option<&'a str> {
        let arg = self.args.get(self.pos)?;
        self.pos += 1;
        Some(arg.as_str())
    }

    fn value<T>(&mut self, flag: &str) -> anyhow::Result<T>
    where
        T: FromStr,
        T::Err: std::fmt::Display,
    {
        let raw = self
            .args
            .get(self.pos)
            .ok_or_else(|| anyhow!("{flag} needs a value"))?;
        self.pos += 1;
        raw.parse::<T>()
            .map_err(|e| anyhow!("invalid value '{raw}' for {flag}: {e}"))
    }

    fn seconds(&mut self, flag: &str) -> anyhow::Result<Duration> {
        let secs: f64 = self.value(flag)?;
        Duration::try_from_secs_f64(secs).map_err(|e| anyhow!("invalid duration for {flag}: {e}"))
    }
}
