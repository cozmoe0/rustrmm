//! `cargo xtask <task>` — developer automation that would otherwise live in shell scripts.

mod sign;

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use sha2::{Digest, Sha256};

#[derive(Parser)]
#[command(name = "xtask", about = "RustRMM build automation")]
struct Cli {
    #[command(subcommand)]
    task: Task,
}

#[derive(Subcommand)]
enum Task {
    /// Install web dependencies (if needed) and build the console into web/dist.
    Web,
    /// Build the web console, then the server in release mode with the console embedded.
    Server,
    /// Build release agents (+ Windows MSI) into dist/agents/<platform>/ with a manifest.
    Dist {
        /// Skip the Linux cross-builds (cargo-zigbuild).
        #[arg(long)]
        no_linux: bool,
        /// Skip the MSI (needs wixl: Linux, or WSL on Windows).
        #[arg(long)]
        no_msi: bool,
        /// Signing provider (overrides signing.toml / RUSTRMM_SIGN_PROVIDER).
        #[arg(long, value_enum)]
        sign_provider: Option<sign::Provider>,
        /// Fail when the configured signing tooling or inputs are missing (release CI).
        #[arg(long)]
        require_signing: bool,
    },
    /// Code-sign agent artifacts (default: everything under dist/agents) — see docs/signing.md.
    Sign {
        /// none | pfx | pkcs11 | azure | apple-devid | apple-selfsigned (overrides the config).
        #[arg(long, value_enum)]
        provider: Option<sign::Provider>,
        /// Configuration file (default: ./signing.toml).
        #[arg(long)]
        config: Option<PathBuf>,
        /// Fail when the configured tooling or inputs are missing instead of skipping.
        #[arg(long)]
        require: bool,
        /// Files or bundle directories (laid out as <dir>/<platform>/<file>).
        paths: Vec<PathBuf>,
    },
    /// Run the full local check suite: fmt, clippy, tests, web typecheck/lint/test.
    Check,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let root = workspace_root();
    match cli.task {
        Task::Web => build_web(&root),
        Task::Server => {
            build_web(&root)?;
            run(Command::new("cargo").current_dir(&root).args([
                "build",
                "--release",
                "-p",
                "rustrmm-server",
            ]))
        }
        Task::Dist {
            no_linux,
            no_msi,
            sign_provider,
            require_signing,
        } => {
            let signer = signer(&root, None, sign_provider, require_signing)?;
            dist(&root, no_linux, no_msi, &signer)
        }
        Task::Sign {
            provider,
            config,
            require,
            paths,
        } => {
            let signer = signer(&root, config.as_deref(), provider, require)?;
            let paths = if paths.is_empty() {
                vec![root.join("dist").join("agents")]
            } else {
                paths
            };
            let mut signed = 0;
            for path in &paths {
                if path.is_dir() {
                    signed += signer.sign_tree(path)?;
                    // Hashes change when files are signed: refresh the bundle manifest.
                    let manifest = path.join("manifest.json");
                    if manifest.exists() {
                        let version = manifest_version(&manifest)
                            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
                        write_manifest(path, &version)?;
                    }
                } else if signer.sign(path)? {
                    signed += 1;
                }
            }
            println!("{signed} artifact(s) signed");
            Ok(())
        }
        Task::Check => {
            run(Command::new("cargo")
                .current_dir(&root)
                .args(["fmt", "--all", "--check"]))?;
            run(Command::new("cargo").current_dir(&root).args([
                "clippy",
                "--workspace",
                "--all-targets",
                "--",
                "-D",
                "warnings",
            ]))?;
            run(Command::new("cargo")
                .current_dir(&root)
                .args(["test", "--workspace"]))?;
            let web = root.join("web");
            if web.join("package.json").exists() {
                for script in ["typecheck", "lint", "test"] {
                    run(npm().current_dir(&web).args(["run", script]))?;
                }
            }
            Ok(())
        }
    }
}

fn signer(
    root: &Path,
    config: Option<&Path>,
    provider: Option<sign::Provider>,
    require: bool,
) -> Result<sign::Signer> {
    let mut config = sign::Config::load(config, root)?;
    if provider.is_some() {
        config.provider = provider;
    }
    let signer = sign::Signer::new(config, require)?;
    signer.announce();
    Ok(signer)
}

fn dist(root: &Path, no_linux: bool, no_msi: bool, signer: &sign::Signer) -> Result<()> {
    // The MSI takes the plain workspace version; agents and the manifest carry the build stamp so
    // every bundle is a distinct release that servers offer as an update (crates/common/build.rs).
    let version = env!("CARGO_PKG_VERSION");
    let build_id = build_id()?;
    let release = format!("{version}+{build_id}");
    println!("building agent release {release}");
    let out = root.join("dist").join("agents");
    std::fs::create_dir_all(&out)?;

    if cfg!(windows) {
        run(Command::new("cargo")
            .current_dir(root)
            .env("RUSTRMM_BUILD_ID", &build_id)
            .args([
                "build",
                "--release",
                "-p",
                "rustrmm-agent",
                "--target-dir",
                "target/rel",
            ]))?;
        copy(
            &root.join("target/rel/release/rustrmm-agent.exe"),
            &out.join("windows-x86_64/rustrmm-agent.exe"),
        )?;
        // The exe is signed before wixl packs it into the MSI.
        signer.sign(&out.join("windows-x86_64/rustrmm-agent.exe"))?;
    }
    if !no_linux {
        for (target, platform) in [
            ("x86_64-unknown-linux-musl", "linux-x86_64"),
            ("aarch64-unknown-linux-musl", "linux-aarch64"),
        ] {
            run(Command::new("cargo")
                .current_dir(root)
                .env("RUSTRMM_BUILD_ID", &build_id)
                .args([
                    "zigbuild",
                    "--release",
                    "-p",
                    "rustrmm-agent",
                    "--target",
                    target,
                    "--target-dir",
                    "target/linux",
                ]))?;
            copy(
                &root.join(format!("target/linux/{target}/release/rustrmm-agent")),
                &out.join(format!("{platform}/rustrmm-agent")),
            )?;
            signer.sign(&out.join(format!("{platform}/rustrmm-agent")))?;
        }
    }
    let exe = out.join("windows-x86_64/rustrmm-agent.exe");
    if !no_msi && exe.exists() {
        let msi = out.join("windows-x86_64/RustRMMAgent-x64.msi");
        if cfg!(windows) {
            let wsl_root = to_wsl_path(root)?;
            let script = format!(
                "cd '{wsl_root}' && bash packaging/windows/build-msi.sh dist/agents/windows-x86_64/rustrmm-agent.exe {version} dist/agents/windows-x86_64/RustRMMAgent-x64.msi"
            );
            run(Command::new("wsl.exe").args(["--", "bash", "-c", &script]))?;
        } else {
            run(Command::new("bash").current_dir(root).args([
                "packaging/windows/build-msi.sh",
                exe.to_str().context("non-UTF-8 path")?,
                version,
                msi.to_str().context("non-UTF-8 path")?,
            ]))?;
        }
        // Signed last: any later msibuild edit would break the signature.
        signer.sign(&msi)?;
    }
    write_manifest(&out, &release)
}

/// `RUSTRMM_BUILD_ID` when set (digits), otherwise the current UTC time as `YYYYMMDDHHMMSS`.
fn build_id() -> Result<String> {
    if let Ok(id) = std::env::var("RUSTRMM_BUILD_ID") {
        let id = id.trim().to_string();
        if id.is_empty() || id.len() > 18 || !id.chars().all(|c| c.is_ascii_digit()) {
            bail!("RUSTRMM_BUILD_ID must be 1 to 18 digits");
        }
        return Ok(id);
    }
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .context("system clock is before 1970")?
        .as_secs();
    Ok(utc_stamp(secs))
}

/// Unix seconds → `YYYYMMDDHHMMSS` (UTC), without a date library.
fn utc_stamp(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Civil-from-days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}{month:02}{day:02}{:02}{:02}{:02}",
        rem / 3_600,
        rem % 3_600 / 60,
        rem % 60
    )
}

/// The `version` field of an existing bundle manifest.
fn manifest_version(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value["version"].as_str().map(str::to_string)
}

fn write_manifest(out: &Path, version: &str) -> Result<()> {
    let mut files = Vec::new();
    for platform in std::fs::read_dir(out)? {
        let platform = platform?;
        if !platform.path().is_dir() {
            continue;
        }
        for file in std::fs::read_dir(platform.path())? {
            let file = file?;
            let bytes = std::fs::read(file.path())?;
            files.push(format!(
                "    {{ \"platform\": \"{}\", \"file\": \"{}\", \"size_bytes\": {}, \"sha256\": \"{}\" }}",
                platform.file_name().to_string_lossy(),
                file.file_name().to_string_lossy(),
                bytes.len(),
                hex::encode(Sha256::digest(&bytes))
            ));
        }
    }
    let manifest = format!(
        "{{\n  \"version\": \"{version}\",\n  \"files\": [\n{}\n  ]\n}}\n",
        files.join(",\n")
    );
    std::fs::write(out.join("manifest.json"), manifest)?;
    println!("dist/agents ready ({} files)", files.len());
    Ok(())
}

fn copy(from: &Path, to: &Path) -> Result<()> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(from, to)
        .with_context(|| format!("copying {} → {}", from.display(), to.display()))?;
    Ok(())
}

/// `C:\a\b` → `/mnt/c/a/b`.
fn to_wsl_path(path: &Path) -> Result<String> {
    let s = path.to_str().context("non-UTF-8 path")?.replace('\\', "/");
    let (drive, rest) = s
        .split_once(":/")
        .context("expected an absolute Windows path")?;
    Ok(format!("/mnt/{}/{}", drive.to_ascii_lowercase(), rest))
}

fn build_web(root: &Path) -> Result<()> {
    let web = root.join("web");
    if !web.join("package.json").exists() {
        bail!("web/package.json not found");
    }
    if !web.join("node_modules").exists() {
        run(npm().current_dir(&web).arg("ci"))?;
    }
    run(npm().current_dir(&web).args(["run", "build"]))
}

fn npm() -> Command {
    if cfg!(windows) {
        Command::new("npm.cmd")
    } else {
        Command::new("npm")
    }
}

fn run(cmd: &mut Command) -> Result<()> {
    let printable = format!("{cmd:?}");
    let status = cmd
        .status()
        .with_context(|| format!("failed to spawn {printable}"))?;
    if !status.success() {
        bail!("command failed ({status}): {printable}");
    }
    Ok(())
}

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    #[test]
    fn utc_stamps() {
        assert_eq!(super::utc_stamp(0), "19700101000000");
        assert_eq!(super::utc_stamp(951_782_400), "20000229000000");
        assert_eq!(super::utc_stamp(1_795_039_421), "20261118220341");
    }
}
