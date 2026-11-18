use clap::Parser;
use rustrmm_server::config::{Cli, Command};

#[tokio::main]
async fn main() -> std::process::ExitCode {
    let cli = Cli::parse();
    let result = match cli.command {
        None => rustrmm_server::run(cli.serve).await,
        Some(Command::Serve(args)) => rustrmm_server::run(args).await,
        Some(Command::Init(args)) => rustrmm_server::init(args),
        Some(Command::Healthcheck(args)) => rustrmm_server::healthcheck(args).await,
        Some(Command::Restore(args)) => {
            rustrmm_common::logging::init(rustrmm_common::logging::LogFormat::Pretty, "warn");
            rustrmm_server::backup::restore::run(args).await
        }
    };
    match result {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e:#}");
            std::process::ExitCode::FAILURE
        }
    }
}
