//! Rules shared by the server and the agent for scripts: languages, environment names and
//! output masking. Both sides enforce them, so a bug on one side cannot leak a secret.

/// Replacement for every masked secret value in script output.
pub const MASK: &str = "••••••";

/// Mask entries shorter than this are ignored (masking `a` would destroy the output).
pub const MIN_MASK_LEN: usize = 4;

/// Script languages the agent can run.
pub const LANGUAGES: &[&str] = &["powershell", "pwsh", "cmd", "bash", "sh", "zsh", "python"];

/// Operating systems a device can report.
pub const PLATFORMS: &[&str] = &["windows", "linux", "macos"];

/// Environment names that scripts may never set (compared case-insensitively). Anything that
/// starts with `RUSTRMM_` is reserved too.
pub const RESERVED_ENV_NAMES: &[&str] = &[
    "PATH",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "SHELL",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "PSMODULEPATH",
];

/// Lowercase hex SHA-256 of script content.
pub fn sha256_hex(content: &str) -> String {
    rustrmm_crypto::random::sha256_hex(content.as_bytes())
}

/// `[A-Za-z_][A-Za-z0-9_]{0,63}`
pub fn valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    name.len() <= 64 && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Whether `name` is reserved for the platform or for RustRMM itself.
pub fn is_reserved_env_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    upper.starts_with("RUSTRMM_") || RESERVED_ENV_NAMES.contains(&upper.as_str())
}

/// Whether `language` is one the agent knows.
pub fn known_language(language: &str) -> bool {
    LANGUAGES.contains(&language)
}

/// Operating systems that can run `language` (interpreters are resolved by absolute path, so
/// PowerShell 7 and cmd are Windows-only here).
pub fn language_platforms(language: &str) -> &'static [&'static str] {
    match language {
        "powershell" | "pwsh" | "cmd" => &["windows"],
        "bash" | "sh" | "zsh" => &["linux", "macos"],
        "python" => PLATFORMS,
        _ => &[],
    }
}

/// File extension the agent writes the script with.
pub fn file_extension(language: &str) -> Option<&'static str> {
    match language {
        "powershell" | "pwsh" => Some("ps1"),
        "cmd" => Some("cmd"),
        "bash" | "sh" | "zsh" => Some("sh"),
        "python" => Some("py"),
        _ => None,
    }
}

/// Replaces every mask value (at least [`MIN_MASK_LEN`] characters) with [`MASK`]. Longer values
/// are masked first so a secret that contains another secret disappears completely. When the
/// output was cut at the cap (`truncated`), a trailing fragment that begins a secret is removed
/// as well, so a secret split by the cut cannot leak its first characters.
pub fn mask_output(text: &str, masks: &[String], truncated: bool) -> String {
    let mut values: Vec<&str> = masks
        .iter()
        .map(String::as_str)
        .filter(|m| m.chars().count() >= MIN_MASK_LEN)
        .collect();
    if values.is_empty() {
        return text.to_string();
    }
    values.sort_by_key(|v| std::cmp::Reverse(v.len()));
    values.dedup();
    let mut out = text.to_string();
    for value in &values {
        if out.contains(value) {
            out = out.replace(value, MASK);
        }
    }
    if truncated {
        let mut cut = out.len();
        for value in &values {
            // Longest proper prefix of `value` that ends the text.
            for (idx, _) in value.char_indices().skip(1) {
                let prefix = &value[..idx];
                if out.ends_with(prefix) {
                    cut = cut.min(out.len() - prefix.len());
                }
            }
        }
        out.truncate(cut);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_names() {
        assert!(valid_env_name("ServiceName"));
        assert!(valid_env_name("_x1"));
        assert!(valid_env_name(&"a".repeat(64)));
        assert!(!valid_env_name(&"a".repeat(65)));
        assert!(!valid_env_name("1abc"));
        assert!(!valid_env_name("a-b"));
        assert!(!valid_env_name(""));
        assert!(!valid_env_name("é"));
        for reserved in [
            "path",
            "Path",
            "SystemRoot",
            "ld_preload",
            "RUSTRMM_JOB",
            "rustrmm_x",
        ] {
            assert!(is_reserved_env_name(reserved), "{reserved}");
        }
        assert!(!is_reserved_env_name("PATHS"));
        assert!(!is_reserved_env_name("ServiceName"));
    }

    #[test]
    fn languages_and_platforms() {
        for language in LANGUAGES {
            assert!(known_language(language));
            assert!(file_extension(language).is_some());
            assert!(!language_platforms(language).is_empty());
        }
        assert!(!known_language("perl"));
        assert_eq!(language_platforms("cmd"), &["windows"]);
        assert_eq!(language_platforms("zsh"), &["linux", "macos"]);
        assert_eq!(file_extension("pwsh"), Some("ps1"));
    }

    #[test]
    fn masking_replaces_secrets_longest_first() {
        let masks = vec![
            "hunter2".to_string(),
            "hunter22".to_string(),
            "abc".to_string(),
        ];
        let out = mask_output("pw=hunter22 short=abc again hunter2.", &masks, false);
        assert_eq!(out, format!("pw={MASK} short=abc again {MASK}."));
        assert_eq!(mask_output("nothing here", &[], false), "nothing here");
    }

    #[test]
    fn masking_trims_a_secret_cut_by_truncation() {
        let masks = vec!["s3cr3t-value".to_string()];
        assert_eq!(mask_output("token: s3cr3t-v", &masks, true), "token: ");
        // Without truncation the text is left alone: it is not the secret.
        assert_eq!(
            mask_output("token: s3cr3t-v", &masks, false),
            "token: s3cr3t-v"
        );
        // Multi-byte secrets are cut on character boundaries.
        let masks = vec!["päss-wörd".to_string()];
        assert_eq!(mask_output("x päss-w", &masks, true), "x ");
    }
}
