//! `cargo xtask sign` — optional code signing of agent artifacts (`docs/signing.md`).
//!
//! Configuration comes from `signing.toml` (git-ignored; see `signing.toml.example`) and is
//! overridden by `RUSTRMM_SIGN_*` environment variables, so CI can inject secrets without a
//! file. When nothing is configured, signing is skipped with a warning and the build goes on.
//!
//! | Provider | Signs | Tooling |
//! |---|---|---|
//! | `pfx` | Windows exe/MSI | `osslsigncode` (default) or `signtool` with a PFX file |
//! | `pkcs11` | Windows exe/MSI | `osslsigncode` with a PKCS#11 token, or `signtool` with a token's certificate |
//! | `azure` | Windows exe/MSI | `signtool` with the Azure Trusted Signing dlib |
//! | `apple-devid` | macOS binaries | `codesign` (hardened runtime, timestamp) + `notarytool` |
//! | `apple-selfsigned` | macOS binaries | `codesign` with a stable self-signed identity |
//!
//! Linux binaries get detached minisign signatures (`<file>.minisig`) whenever `[minisign]` is
//! configured, whatever the provider. Authenticode signatures always carry an RFC 3161
//! timestamp.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, Result, bail};
use serde::Deserialize;

pub const DEFAULT_TIMESTAMP_URL: &str = "http://timestamp.digicert.com";
pub const AZURE_TIMESTAMP_URL: &str = "http://timestamp.acs.microsoft.com";

#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Provider {
    None,
    Pfx,
    Pkcs11,
    Azure,
    AppleDevid,
    AppleSelfsigned,
}

impl Provider {
    fn parse(text: &str) -> Result<Self> {
        Ok(match text.trim().to_ascii_lowercase().as_str() {
            "" | "none" => Self::None,
            "pfx" => Self::Pfx,
            "pkcs11" => Self::Pkcs11,
            "azure" => Self::Azure,
            "apple-devid" => Self::AppleDevid,
            "apple-selfsigned" => Self::AppleSelfsigned,
            other => bail!("unknown signing provider '{other}'"),
        })
    }

    fn signs_windows(self) -> bool {
        matches!(self, Self::Pfx | Self::Pkcs11 | Self::Azure)
    }

    fn signs_macos(self) -> bool {
        matches!(self, Self::AppleDevid | Self::AppleSelfsigned)
    }
}

#[derive(Debug, Default, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub provider: Option<Provider>,
    pub timestamp_url: Option<String>,
    #[serde(default)]
    pub windows: WindowsConfig,
    #[serde(default)]
    pub pfx: PfxConfig,
    #[serde(default)]
    pub pkcs11: Pkcs11Config,
    #[serde(default)]
    pub azure: AzureConfig,
    #[serde(default)]
    pub apple: AppleConfig,
    #[serde(default)]
    pub minisign: MinisignConfig,
}

#[derive(Debug, Default, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WindowsConfig {
    /// `osslsigncode` (default) or `signtool`.
    pub tool: Option<String>,
    pub osslsigncode: Option<String>,
    pub signtool: Option<String>,
    /// Program name shown in the UAC prompt.
    pub description: Option<String>,
    pub url: Option<String>,
}

#[derive(Debug, Default, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PfxConfig {
    pub path: Option<PathBuf>,
    /// Name of the environment variable holding the password (never put it in the file).
    pub password_env: Option<String>,
}

#[derive(Debug, Default, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pkcs11Config {
    /// PKCS#11 module of the token (osslsigncode).
    pub module: Option<String>,
    /// OpenSSL engine (osslsigncode with OpenSSL 1.x only).
    pub engine: Option<String>,
    /// Certificate chain (PEM or DER); the private key never leaves the token.
    pub certificate: Option<PathBuf>,
    /// Key reference, e.g. a `pkcs11:` URI.
    pub key: Option<String>,
    pub pin_env: Option<String>,
    /// signtool: SHA-1 thumbprint of the token's certificate in the certificate store.
    pub thumbprint: Option<String>,
}

#[derive(Debug, Default, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AzureConfig {
    /// `Azure.CodeSigning.Dlib.dll` from the Trusted Signing client tools.
    pub dlib: Option<PathBuf>,
    /// JSON with `Endpoint`, `CodeSigningAccountName` and `CertificateProfileName`.
    pub metadata: Option<PathBuf>,
}

#[derive(Debug, Default, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppleConfig {
    /// `Developer ID Application: …` (apple-devid) or a self-signed identity's name.
    pub identity: Option<String>,
    pub keychain: Option<String>,
    pub entitlements: Option<PathBuf>,
    /// `xcrun notarytool store-credentials` profile (apple-devid).
    pub notary_profile: Option<String>,
}

#[derive(Debug, Default, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MinisignConfig {
    pub secret_key: Option<PathBuf>,
    pub password_env: Option<String>,
    pub trusted_comment: Option<String>,
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

impl Config {
    /// Loads `signing.toml` (if present) and applies `RUSTRMM_SIGN_*` overrides.
    pub fn load(path: Option<&Path>, root: &Path) -> Result<Self> {
        let default = root.join("signing.toml");
        let path = path.map(Path::to_path_buf).unwrap_or(default);
        let mut config: Config = if path.exists() {
            let text = std::fs::read_to_string(&path)
                .with_context(|| format!("reading {}", path.display()))?;
            toml::from_str(&text).with_context(|| format!("parsing {}", path.display()))?
        } else {
            Config::default()
        };
        if let Some(p) = env("RUSTRMM_SIGN_PROVIDER") {
            config.provider = Some(Provider::parse(&p)?);
        }
        let set = |slot: &mut Option<String>, var: &str| {
            if let Some(v) = env(var) {
                *slot = Some(v);
            }
        };
        let set_path = |slot: &mut Option<PathBuf>, var: &str| {
            if let Some(v) = env(var) {
                *slot = Some(PathBuf::from(v));
            }
        };
        set(&mut config.timestamp_url, "RUSTRMM_SIGN_TIMESTAMP_URL");
        set(&mut config.windows.tool, "RUSTRMM_SIGN_WINDOWS_TOOL");
        set(&mut config.windows.description, "RUSTRMM_SIGN_DESCRIPTION");
        set_path(&mut config.pfx.path, "RUSTRMM_SIGN_PFX_PATH");
        set(&mut config.pkcs11.module, "RUSTRMM_SIGN_PKCS11_MODULE");
        set_path(&mut config.pkcs11.certificate, "RUSTRMM_SIGN_PKCS11_CERT");
        set(&mut config.pkcs11.key, "RUSTRMM_SIGN_PKCS11_KEY");
        set(
            &mut config.pkcs11.thumbprint,
            "RUSTRMM_SIGN_PKCS11_THUMBPRINT",
        );
        set_path(&mut config.azure.dlib, "RUSTRMM_SIGN_AZURE_DLIB");
        set_path(&mut config.azure.metadata, "RUSTRMM_SIGN_AZURE_METADATA");
        set(&mut config.apple.identity, "RUSTRMM_SIGN_APPLE_IDENTITY");
        set(
            &mut config.apple.notary_profile,
            "RUSTRMM_SIGN_APPLE_NOTARY_PROFILE",
        );
        set_path(&mut config.minisign.secret_key, "RUSTRMM_SIGN_MINISIGN_KEY");
        Ok(config)
    }

    pub fn provider(&self) -> Provider {
        self.provider.unwrap_or(Provider::None)
    }

    fn timestamp_url(&self) -> String {
        self.timestamp_url.clone().unwrap_or_else(|| {
            if self.provider() == Provider::Azure {
                AZURE_TIMESTAMP_URL.into()
            } else {
                DEFAULT_TIMESTAMP_URL.into()
            }
        })
    }

    fn uses_signtool(&self) -> bool {
        self.provider() == Provider::Azure
            || self
                .windows
                .tool
                .as_deref()
                .is_some_and(|t| t.eq_ignore_ascii_case("signtool"))
    }
}

/// A secret read from the environment (`RUSTRMM_SIGN_*` first, then the configured variable).
fn secret(fixed_var: &str, configured_var: Option<&str>) -> Option<String> {
    env(fixed_var).or_else(|| configured_var.and_then(env))
}

/// Writes a secret to a private temporary file (osslsigncode `-readpass`), deleted on drop.
struct SecretFile(tempfile::NamedTempFile);

impl SecretFile {
    fn new(value: &str) -> Result<Self> {
        use std::io::Write as _;
        let mut file = tempfile::NamedTempFile::new()?;
        file.write_all(value.as_bytes())?;
        file.flush()?;
        Ok(Self(file))
    }

    fn path(&self) -> &Path {
        self.0.path()
    }
}

/// What the build should do about signing.
pub struct Signer {
    config: Config,
    /// Fail instead of skipping when the configured tooling or inputs are missing.
    require: bool,
    /// PFX decoded from `RUSTRMM_SIGN_PFX_BASE64` (CI secret), kept for the signer's lifetime.
    _pfx_temp: Option<tempfile::TempPath>,
}

/// Kind of artifact, from its path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Artifact {
    WindowsPe,
    WindowsMsi,
    MacBinary,
    LinuxBinary,
    Other,
}

pub fn classify(path: &Path) -> Artifact {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let platform = path
        .parent()
        .and_then(Path::file_name)
        .map(|n| n.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if name.ends_with(".minisig") || name.ends_with(".sig") || name == "manifest.json" {
        return Artifact::Other;
    }
    if name.ends_with(".exe") || name.ends_with(".dll") {
        Artifact::WindowsPe
    } else if name.ends_with(".msi") {
        Artifact::WindowsMsi
    } else if platform.starts_with("macos") {
        Artifact::MacBinary
    } else if platform.starts_with("linux") {
        Artifact::LinuxBinary
    } else {
        Artifact::Other
    }
}

fn which(program: &str) -> bool {
    let probe = if cfg!(windows) { "where" } else { "which" };
    Command::new(probe)
        .arg(program)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

fn warn(message: &str) {
    eprintln!("warning: code signing: {message}");
}

impl Signer {
    pub fn new(config: Config, require: bool) -> Result<Self> {
        let mut signer = Self {
            config,
            require,
            _pfx_temp: None,
        };
        if signer.config.provider() == Provider::Pfx
            && let Some(b64) = env("RUSTRMM_SIGN_PFX_BASE64")
        {
            use base64::Engine as _;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64.trim())
                .context("RUSTRMM_SIGN_PFX_BASE64 is not valid base64")?;
            let mut file = tempfile::NamedTempFile::new()?;
            std::io::Write::write_all(&mut file, &bytes)?;
            let path = file.into_temp_path();
            signer.config.pfx.path = Some(path.to_path_buf());
            signer._pfx_temp = Some(path);
        }
        Ok(signer)
    }

    pub fn provider(&self) -> Provider {
        self.config.provider()
    }

    fn minisign_configured(&self) -> bool {
        self.config.minisign.secret_key.is_some()
    }

    /// Prints what will (not) be signed; called once per build.
    pub fn announce(&self) {
        match (self.provider(), self.minisign_configured()) {
            (Provider::None, false) => warn(
                "not configured (no signing.toml or RUSTRMM_SIGN_PROVIDER); artifacts stay unsigned — see docs/signing.md",
            ),
            (Provider::None, true) => {
                println!("code signing: minisign only (Linux artifacts)")
            }
            (p, m) => println!(
                "code signing: provider {p:?}{}",
                if m { " + minisign" } else { "" }
            ),
        }
    }

    /// Reports a missing prerequisite: an error with `--require`, otherwise a skip warning.
    fn missing(&self, what: &str) -> Result<bool> {
        if self.require {
            bail!("code signing: {what}");
        }
        warn(&format!("{what}; skipping"));
        Ok(false)
    }

    /// Signs one artifact in place according to its kind. Returns true when it was signed.
    pub fn sign(&self, path: &Path) -> Result<bool> {
        match classify(path) {
            Artifact::WindowsPe | Artifact::WindowsMsi if self.provider().signs_windows() => {
                self.sign_windows(path)
            }
            Artifact::MacBinary if self.provider().signs_macos() => self.sign_macos(path),
            Artifact::LinuxBinary if self.minisign_configured() => self.minisign(path),
            _ => Ok(false),
        }
    }

    /// Signs every artifact under `dir/<platform>/`.
    pub fn sign_tree(&self, dir: &Path) -> Result<usize> {
        let mut signed = 0;
        let mut entries: Vec<PathBuf> = Vec::new();
        for platform in std::fs::read_dir(dir)? {
            let platform = platform?.path();
            if platform.is_dir() {
                for file in std::fs::read_dir(&platform)? {
                    entries.push(file?.path());
                }
            }
        }
        // Executables before installers: an MSI must embed an already signed exe.
        entries.sort_by_key(|p| (classify(p) == Artifact::WindowsMsi, p.clone()));
        let has_msi = entries.iter().any(|p| classify(p) == Artifact::WindowsMsi);
        if has_msi && self.provider().signs_windows() {
            warn(
                "signing an existing MSI does not sign the exe packed inside it; run `cargo xtask dist` with signing configured to sign the exe before the MSI is built",
            );
        }
        for path in entries {
            if self.sign(&path)? {
                signed += 1;
            }
        }
        Ok(signed)
    }

    fn sign_windows(&self, path: &Path) -> Result<bool> {
        let description = self
            .config
            .windows
            .description
            .clone()
            .unwrap_or_else(|| "RustRMM Agent".into());
        let ts = self.config.timestamp_url();
        if self.config.uses_signtool() {
            if !cfg!(windows) {
                return self.missing("signtool only runs on Windows");
            }
            let tool = self
                .config
                .windows
                .signtool
                .clone()
                .unwrap_or_else(|| "signtool.exe".into());
            if !which(&tool) && !Path::new(&tool).exists() {
                return self.missing(&format!(
                    "{tool} not found (Windows SDK); set [windows] signtool"
                ));
            }
            let mut cmd = Command::new(&tool);
            cmd.args(["sign", "/fd", "SHA256", "/tr", &ts, "/td", "SHA256", "/d"])
                .arg(&description);
            if let Some(url) = &self.config.windows.url {
                cmd.arg("/du").arg(url);
            }
            match self.provider() {
                Provider::Azure => {
                    let (Some(dlib), Some(metadata)) =
                        (&self.config.azure.dlib, &self.config.azure.metadata)
                    else {
                        return self.missing("[azure] dlib and metadata are required");
                    };
                    cmd.arg("/dlib").arg(dlib).arg("/dmdf").arg(metadata);
                }
                Provider::Pfx => {
                    let Some(pfx) = self.config.pfx.path.as_ref().filter(|p| p.exists()) else {
                        return self.missing("the PFX file is not configured or missing");
                    };
                    cmd.arg("/f").arg(pfx);
                    if let Some(pw) = secret(
                        "RUSTRMM_SIGN_PFX_PASSWORD",
                        self.config.pfx.password_env.as_deref(),
                    ) {
                        cmd.arg("/p").arg(pw);
                    }
                }
                Provider::Pkcs11 => {
                    let Some(thumbprint) = &self.config.pkcs11.thumbprint else {
                        return self.missing(
                            "[pkcs11] thumbprint is required with signtool (the token's certificate in the store)",
                        );
                    };
                    cmd.arg("/sha1").arg(thumbprint);
                }
                _ => return Ok(false),
            }
            cmd.arg(path);
            run_quiet(&mut cmd, &format!("signtool {}", path.display()))?;
        } else {
            let tool = self
                .config
                .windows
                .osslsigncode
                .clone()
                .unwrap_or_else(|| "osslsigncode".into());
            if !which(&tool) && !Path::new(&tool).exists() {
                return self.missing(&format!(
                    "{tool} not found (apt install osslsigncode / brew install osslsigncode)"
                ));
            }
            let out = path.with_extension(format!(
                "{}.signed",
                path.extension()
                    .map(|e| e.to_string_lossy().to_string())
                    .unwrap_or_default()
            ));
            let _ = std::fs::remove_file(&out);
            let mut cmd = Command::new(&tool);
            cmd.args(["sign", "-h", "sha256", "-ts", &ts, "-n"])
                .arg(&description);
            if let Some(url) = &self.config.windows.url {
                cmd.arg("-i").arg(url);
            }
            let _secret_file;
            match self.provider() {
                Provider::Pfx => {
                    let Some(pfx) = self.config.pfx.path.as_ref().filter(|p| p.exists()) else {
                        return self.missing("the PFX file is not configured or missing");
                    };
                    cmd.arg("-pkcs12").arg(pfx);
                    if let Some(pw) = secret(
                        "RUSTRMM_SIGN_PFX_PASSWORD",
                        self.config.pfx.password_env.as_deref(),
                    ) {
                        let file = SecretFile::new(&pw)?;
                        cmd.arg("-readpass").arg(file.path());
                        _secret_file = file;
                    }
                }
                Provider::Pkcs11 => {
                    let p = &self.config.pkcs11;
                    let (Some(module), Some(cert), Some(key)) = (&p.module, &p.certificate, &p.key)
                    else {
                        return self.missing("[pkcs11] module, certificate and key are required");
                    };
                    if let Some(engine) = &p.engine {
                        cmd.arg("-pkcs11engine").arg(engine);
                    }
                    cmd.arg("-pkcs11module")
                        .arg(module)
                        .arg("-certs")
                        .arg(cert)
                        .arg("-key")
                        .arg(key);
                    if let Some(pin) = secret("RUSTRMM_SIGN_PKCS11_PIN", p.pin_env.as_deref()) {
                        let file = SecretFile::new(&pin)?;
                        cmd.arg("-readpass").arg(file.path());
                        _secret_file = file;
                    }
                }
                Provider::Azure => {
                    return self.missing("Azure Trusted Signing needs signtool (Windows)");
                }
                _ => return Ok(false),
            }
            cmd.arg("-in").arg(path).arg("-out").arg(&out);
            if let Err(e) = run_quiet(&mut cmd, &format!("osslsigncode {}", path.display())) {
                let _ = std::fs::remove_file(&out);
                return Err(e);
            }
            std::fs::rename(&out, path)
                .with_context(|| format!("replacing {} with its signed copy", path.display()))?;
        }
        println!(
            "signed {} (Authenticode, RFC 3161 timestamp)",
            path.display()
        );
        Ok(true)
    }

    fn sign_macos(&self, path: &Path) -> Result<bool> {
        if !cfg!(target_os = "macos") {
            return self.missing("codesign and notarytool only run on macOS");
        }
        let Some(identity) = &self.config.apple.identity else {
            return self.missing("[apple] identity is required");
        };
        let mut cmd = Command::new("codesign");
        cmd.args(["--force", "--sign"]).arg(identity);
        if self.provider() == Provider::AppleDevid {
            // Notarization requires the hardened runtime and a secure timestamp.
            cmd.args(["--options", "runtime", "--timestamp"]);
        }
        if let Some(keychain) = &self.config.apple.keychain {
            cmd.arg("--keychain").arg(keychain);
        }
        if let Some(entitlements) = &self.config.apple.entitlements {
            cmd.arg("--entitlements").arg(entitlements);
        }
        cmd.arg(path);
        run_quiet(&mut cmd, &format!("codesign {}", path.display()))?;
        if self.provider() == Provider::AppleDevid {
            let Some(profile) = &self.config.apple.notary_profile else {
                warn("[apple] notary_profile not set; signed but not notarized");
                return Ok(true);
            };
            let dir = tempfile::tempdir()?;
            let zip = dir.path().join("notarize.zip");
            run_quiet(
                Command::new("ditto")
                    .args(["-c", "-k", "--keepParent"])
                    .arg(path)
                    .arg(&zip),
                "ditto",
            )?;
            run_quiet(
                Command::new("xcrun")
                    .args(["notarytool", "submit"])
                    .arg(&zip)
                    .args(["--keychain-profile", profile, "--wait"]),
                "notarytool submit",
            )?;
            // A bare Mach-O cannot be stapled; Gatekeeper checks the ticket online.
            println!("notarized {}", path.display());
        }
        println!("signed {} (codesign)", path.display());
        Ok(true)
    }

    fn minisign(&self, path: &Path) -> Result<bool> {
        if !which("minisign") {
            return self.missing("minisign not found");
        }
        let Some(key) = &self.config.minisign.secret_key else {
            return Ok(false);
        };
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let comment = self
            .config
            .minisign
            .trusted_comment
            .clone()
            .unwrap_or_else(|| format!("RustRMM {file_name} {}", env!("CARGO_PKG_VERSION")));
        let mut sig = path.as_os_str().to_owned();
        sig.push(".minisig");
        let mut cmd = Command::new("minisign");
        cmd.arg("-S")
            .arg("-s")
            .arg(key)
            .arg("-m")
            .arg(path)
            .arg("-x")
            .arg(&sig)
            .arg("-t")
            .arg(&comment);
        let password = secret(
            "RUSTRMM_SIGN_MINISIGN_PASSWORD",
            self.config.minisign.password_env.as_deref(),
        );
        if let Some(pw) = password {
            use std::io::Write as _;
            let mut child = cmd
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .spawn()
                .context("starting minisign")?;
            if let Some(mut stdin) = child.stdin.take() {
                writeln!(stdin, "{pw}")?;
            }
            let status = child.wait()?;
            if !status.success() {
                bail!("minisign failed for {}", path.display());
            }
        } else {
            run_quiet(&mut cmd, &format!("minisign {}", path.display()))?;
        }
        println!("signed {} (minisign)", path.display());
        Ok(true)
    }
}

/// Runs a signing tool without echoing its command line (it may contain a password).
fn run_quiet(cmd: &mut Command, label: &str) -> Result<()> {
    let status = cmd
        .status()
        .with_context(|| format!("failed to start {label}"))?;
    if !status.success() {
        bail!("{label} failed ({status})");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_artifacts_by_platform_and_extension() {
        let d = Path::new("dist/agents");
        assert_eq!(
            classify(&d.join("windows-x86_64/rustrmm-agent.exe")),
            Artifact::WindowsPe
        );
        assert_eq!(
            classify(&d.join("windows-x86_64/RustRMMAgent-x64.msi")),
            Artifact::WindowsMsi
        );
        assert_eq!(
            classify(&d.join("linux-x86_64/rustrmm-agent")),
            Artifact::LinuxBinary
        );
        assert_eq!(
            classify(&d.join("linux-x86_64/rustrmm-agent.minisig")),
            Artifact::Other
        );
        assert_eq!(
            classify(&d.join("macos-universal/rustrmm-agent")),
            Artifact::MacBinary
        );
        assert_eq!(classify(&d.join("manifest.json")), Artifact::Other);
    }

    #[test]
    fn example_config_parses_and_nothing_configured_signs_nothing() {
        let example = include_str!("../../../signing.toml.example");
        let config: Config = toml::from_str(example).expect("signing.toml.example parses");
        assert_eq!(config.provider(), Provider::None);
        let signer = Signer::new(Config::default(), false).expect("signer");
        assert_eq!(signer.provider(), Provider::None);
        let dir = tempfile::tempdir().expect("tempdir");
        let exe = dir.path().join("windows-x86_64").join("rustrmm-agent.exe");
        std::fs::create_dir_all(exe.parent().expect("parent")).expect("mkdir");
        std::fs::write(&exe, b"MZ").expect("write");
        assert_eq!(signer.sign_tree(dir.path()).expect("never fails"), 0);
        assert_eq!(std::fs::read(&exe).expect("read"), b"MZ", "untouched");
    }

    #[test]
    fn missing_tooling_skips_unless_required() {
        let config = Config {
            provider: Some(Provider::Pfx),
            windows: WindowsConfig {
                osslsigncode: Some("definitely-not-a-real-osslsigncode".into()),
                ..Default::default()
            },
            ..Default::default()
        };
        let dir = tempfile::tempdir().expect("tempdir");
        let exe = dir.path().join("windows-x86_64").join("rustrmm-agent.exe");
        std::fs::create_dir_all(exe.parent().expect("parent")).expect("mkdir");
        std::fs::write(&exe, b"MZ").expect("write");
        let lenient = Signer::new(config.clone(), false).expect("signer");
        assert!(!lenient.sign(&exe).expect("skips"));
        let strict = Signer::new(config, true).expect("signer");
        assert!(strict.sign(&exe).is_err());
    }

    #[test]
    fn provider_names_parse() {
        assert_eq!(
            Provider::parse("apple-devid").expect("p"),
            Provider::AppleDevid
        );
        assert_eq!(Provider::parse("").expect("p"), Provider::None);
        assert!(Provider::parse("gpg").is_err());
    }
}
