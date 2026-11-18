use clap::Parser;
use rustrmm_server::config::{Cli, Command};

fn main() -> std::process::ExitCode {
    unset_empty_env_vars();
    let cli = Cli::parse();
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(e) => {
            eprintln!("error: could not start the async runtime: {e}");
            return std::process::ExitCode::FAILURE;
        }
    };
    let result = runtime.block_on(async {
        match cli.command {
            None => rustrmm_server::run(cli.serve).await,
            Some(Command::Serve(args)) => rustrmm_server::run(args).await,
            Some(Command::Init(args)) => rustrmm_server::init(args),
            Some(Command::Healthcheck(args)) => rustrmm_server::healthcheck(args).await,
            Some(Command::Restore(args)) => {
                rustrmm_common::logging::init(rustrmm_common::logging::LogFormat::Pretty, "warn");
                rustrmm_server::backup::restore::run(args).await
            }
        }
    });
    match result {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e:#}");
            std::process::ExitCode::FAILURE
        }
    }
}

/// Docker env files and service managers often carry `RUSTRMM_NAME=` placeholders. Treat an empty
/// `RUSTRMM_*` variable as unset, so the option falls back to its default instead of failing to
/// parse (an empty CIDR list, for example).
fn unset_empty_env_vars() {
    let empty: Vec<_> = std::env::vars_os()
        .filter(|(key, value)| {
            key.to_str().is_some_and(|k| k.starts_with("RUSTRMM_"))
                && value.to_str().is_some_and(|v| v.trim().is_empty())
        })
        .map(|(key, _)| key)
        .collect();
    for key in empty {
        // SAFETY: this runs first in `main`, before the Tokio runtime or any other thread exists,
        // so nothing can read the environment concurrently.
        unsafe { std::env::remove_var(&key) };
    }
}
