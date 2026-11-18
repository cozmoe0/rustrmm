//! Tracing/logging initialisation shared by the server, agent and tools.

use tracing_subscriber::{EnvFilter, fmt, prelude::*};

/// Output format for log lines.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LogFormat {
    /// Human-friendly coloured output (development).
    #[default]
    Pretty,
    /// One JSON object per line (containers, log shippers).
    Json,
}

impl std::str::FromStr for LogFormat {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_ascii_lowercase().as_str() {
            "pretty" | "text" => Ok(Self::Pretty),
            "json" => Ok(Self::Json),
            other => Err(format!(
                "unknown log format '{other}' (expected pretty or json)"
            )),
        }
    }
}

/// Installs a global tracing subscriber. `default_filter` applies when `RUST_LOG` is unset.
pub fn init(format: LogFormat, default_filter: &str) {
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(default_filter));
    let registry = tracing_subscriber::registry().with(filter);
    let result = match format {
        LogFormat::Pretty => registry
            .with(fmt::layer().with_target(false).with_writer(std::io::stderr))
            .try_init(),
        LogFormat::Json => registry
            .with(
                fmt::layer()
                    .with_writer(std::io::stderr)
                    .json()
                    .flatten_event(true)
                    .with_current_span(false),
            )
            .try_init(),
    };
    // A subscriber may already be installed (tests); that is fine.
    let _ = result;
}
