//! Phase 7 software: the explorer over installed software, the software library (package
//! sources and uploaded files), single-use download tokens and deployments
//! (`docs/api-patching.md`).

pub mod deployments;
pub mod explorer;
pub mod files;
pub mod library;

use crate::state::AppState;

/// Scheduler pass for deployments and download tokens (driven by the patching scheduler).
pub async fn tick(state: &AppState) -> anyhow::Result<()> {
    deployments::tick(state).await?;
    files::purge_tokens(&state.db).await
}

const ARCH_MARKERS: &[&str] = &[
    "x64", "x86", "x86_64", "amd64", "arm64", "64-bit", "32-bit", "64bit", "32bit", "win64",
    "win32",
];

fn is_version_token(token: &str) -> bool {
    let t = token.trim_matches(|c| matches!(c, '(' | ')' | '[' | ']' | ','));
    let t = t
        .strip_prefix('v')
        .or_else(|| t.strip_prefix('V'))
        .unwrap_or(t);
    !t.is_empty()
        && t.starts_with(|c: char| c.is_ascii_digit())
        && t.contains('.')
        && t.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+'))
}

fn is_noise_token(token: &str) -> bool {
    let t = token
        .trim_matches(|c| matches!(c, '(' | ')' | '[' | ']' | ','))
        .to_ascii_lowercase();
    t.is_empty() || t == "-" || ARCH_MARKERS.contains(&t.as_str()) || is_version_token(token)
}

/// Display name without trailing version numbers and architecture markers
/// (`7-Zip 24.08 (x64)` → `7-Zip`).
pub fn strip_name(name: &str) -> String {
    let mut tokens: Vec<&str> = name.split_whitespace().collect();
    while tokens.len() > 1 && tokens.last().is_some_and(|t| is_noise_token(t)) {
        tokens.pop();
    }
    tokens.join(" ")
}

/// Grouping key for a product name.
pub fn normalize_name(name: &str) -> String {
    strip_name(name).to_lowercase()
}

/// Legal-form suffixes ignored when grouping publishers (`Microsoft Corporation` and
/// `Microsoft Corp.` are the same publisher).
const LEGAL_SUFFIXES: &[&str] = &[
    "inc",
    "incorporated",
    "corp",
    "corporation",
    "co",
    "company",
    "llc",
    "l.l.c",
    "ltd",
    "limited",
    "gmbh",
    "ag",
    "sa",
    "s.a",
    "bv",
    "b.v",
    "nv",
    "n.v",
    "plc",
    "pty",
    "pte",
    "srl",
    "s.r.l",
    "s.r.o",
    "oy",
    "ab",
    "a/s",
    "se",
    "kg",
    "kk",
    "spa",
    "s.p.a",
    "sas",
    "llp",
];

/// Grouping key for a publisher: case-insensitive, collapsed spaces, trademark signs, commas,
/// trailing dots and legal-form suffixes removed (always keeping the first word).
pub fn normalize_publisher(publisher: &str) -> String {
    let cleaned: String = publisher
        .replace(['®', '™', '©'], " ")
        .replace("(r)", " ")
        .replace("(R)", " ")
        .replace("(tm)", " ")
        .replace("(TM)", " ")
        .replace(',', " ");
    let mut tokens: Vec<String> = cleaned
        .split_whitespace()
        .map(|t| t.to_lowercase())
        .collect();
    while tokens.len() > 1
        && tokens
            .last()
            .is_some_and(|t| LEGAL_SUFFIXES.contains(&t.trim_end_matches('.')))
    {
        tokens.pop();
    }
    tokens
        .join(" ")
        .trim_end_matches(['.', ','])
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_normalise_versions_and_architectures_away() {
        assert_eq!(strip_name("7-Zip 24.08 (x64)"), "7-Zip");
        assert_eq!(
            normalize_name("7-Zip 23.01 (x64 edition)"),
            "7-zip 23.01 (x64 edition)"
        );
        assert_eq!(normalize_name("Python 3.12.1 (64-bit)"), "python");
        assert_eq!(
            normalize_name("Microsoft Visual C++ 2015-2022 Redistributable (x64) - 14.38.33135"),
            "microsoft visual c++ 2015-2022 redistributable"
        );
        assert_eq!(normalize_name("Google Chrome"), "google chrome");
        assert_eq!(normalize_name("1.2.3"), "1.2.3", "never strips everything");
        assert_eq!(normalize_publisher(" Igor  Pavlov. "), "igor pavlov");
        assert_eq!(normalize_publisher("Microsoft Corporation"), "microsoft");
        assert_eq!(normalize_publisher("Microsoft Corp."), "microsoft");
        assert_eq!(normalize_publisher("Google LLC"), "google");
        assert_eq!(normalize_publisher("Google, Inc."), "google");
        assert_eq!(normalize_publisher("Mozilla®"), "mozilla");
        assert_eq!(
            normalize_publisher("Oracle America, Inc."),
            "oracle america"
        );
        assert_eq!(
            normalize_publisher("Corp"),
            "corp",
            "never strips everything"
        );
    }
}
