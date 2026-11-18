//! Phase-0 throwaway spike: host an interactive shell from a Windows LocalSystem service through
//! a hand-written ConPTY host (windows-rs). Results and design notes: FINDINGS.md.

#[cfg(not(windows))]
compile_error!("conpty-service-spike is Windows-only");

#[macro_use]
mod log;
mod conpty;
mod demo;
mod service;
mod token;
mod vt;
mod win;

use std::process::ExitCode;

const USAGE: &str = r#"usage: conpty-service-spike <command> [options]

commands:
  console        run the ConPTY scenarios in this console (no elevation needed)
                   --shell cmd|powershell|all  shells for the basic scenario (default all)
                   --skip-self-token           skip CreateProcessAsUserW with our own token
                   --skip-pitfalls             skip the deliberate close-without-drain repro
                   --service-dry-run           run the service's scenario list + stop-time
                                               teardown here, without the SCM
                   pitfall repros (defaults are the recommended behaviour):
                   --no-usestdhandles          spawn without STARTF_USESTDHANDLES
                   --inherit-env               shells inherit our environment (PATH etc.)
                   --inherit-ctrl-c-state      keep an inherited "ignore Ctrl+C" flag
  install        copy this exe to %ProgramFiles%\RustRMMSpike and register the
                 LocalSystem service RustRMMConPtySpike (elevated)
  uninstall      stop and delete the service, remove the installed copy (elevated)
  run-service    service entry point; started by the SCM, not by hand
  service-test   install, start, wait for the scenarios, stop, print the log,
                 uninstall (elevated)

service log: %ProgramData%\RustRMMSpike\conpty-service.log
"#;

fn main() -> ExitCode {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // Services have no stderr; make sure panics reach the log file too.
        logln!("PANIC: {info}");
        default_hook(info);
    }));

    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(command) = args.first() else {
        eprint!("{USAGE}");
        return ExitCode::from(2);
    };
    let result = match command.as_str() {
        "console" => demo::console_main(&args[1..]),
        "install" => service::install().map(|()| true),
        "uninstall" => service::uninstall().map(|()| true),
        "run-service" => service::run_dispatcher().map(|()| true),
        "service-test" => service::service_test(),
        "help" | "-h" | "--help" => {
            print!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        other => {
            eprintln!("unknown command {other:?}\n");
            eprint!("{USAGE}");
            return ExitCode::from(2);
        }
    };
    match result {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::from(1),
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::from(1)
        }
    }
}
