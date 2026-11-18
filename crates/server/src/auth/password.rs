//! Argon2id password hashing and password policy.

use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};

pub const MIN_LENGTH: usize = 12;
pub const MAX_LENGTH: usize = 256;

/// A tiny deny-list of passwords that satisfy the length rule but are still trivially guessable.
const COMMON: &[&str] = &[
    "password1234",
    "password12345",
    "passwordpassword",
    "123456789012",
    "qwertyuiopas",
    "letmein12345",
    "administrator",
    "welcome12345",
    "changeme1234",
    "iloveyou1234",
    "rustrmm12345",
    "p@ssw0rd1234",
];

/// Hashes a password (Argon2id, library default parameters, random salt). CPU-heavy: call from
/// `spawn_blocking`.
pub fn hash(password: &str) -> anyhow::Result<String> {
    let hash = Argon2::default()
        .hash_password(password.as_bytes())
        .map_err(|e| anyhow::anyhow!("password hashing failed: {e}"))?;
    Ok(hash.to_string())
}

/// Verifies a password against a stored PHC string. CPU-heavy: call from `spawn_blocking`.
pub fn verify(password: &str, phc: &str) -> bool {
    match PasswordHash::new(phc) {
        Ok(parsed) => Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

/// Burns roughly the same CPU as a real verification so unknown accounts are not distinguishable
/// by response time.
pub fn verify_dummy(password: &str) {
    static DUMMY: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let phc = DUMMY.get_or_init(|| hash("dummy-password-for-timing").unwrap_or_default());
    let _ = verify(password, phc);
}

/// Returns a human-readable reason when the password is not acceptable.
pub fn policy_violation(password: &str, email: &str, name: &str) -> Option<String> {
    let chars = password.chars().count();
    if chars < MIN_LENGTH {
        return Some(format!("Password must be at least {MIN_LENGTH} characters"));
    }
    if chars > MAX_LENGTH {
        return Some(format!("Password must be at most {MAX_LENGTH} characters"));
    }
    let lower = password.to_lowercase();
    if COMMON.contains(&lower.as_str()) {
        return Some("Password is too common".into());
    }
    let distinct: std::collections::HashSet<char> = password.chars().collect();
    if distinct.len() < 5 {
        return Some("Password needs more variety".into());
    }
    let local = email.split('@').next().unwrap_or("").to_lowercase();
    if local.len() >= 4 && lower.contains(&local) {
        return Some("Password must not contain your email address".into());
    }
    let name_lower = name.trim().to_lowercase();
    if name_lower.len() >= 4 && lower.contains(&name_lower) {
        return Some("Password must not contain your name".into());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_and_verify() {
        let phc = hash("correct-horse-battery").expect("hash");
        assert!(phc.starts_with("$argon2id$"));
        assert!(verify("correct-horse-battery", &phc));
        assert!(!verify("wrong-horse-battery", &phc));
        assert!(!verify("anything", "not-a-phc-string"));
    }

    #[test]
    fn policy() {
        assert!(policy_violation("short", "a@b.c", "A").is_some());
        assert!(policy_violation("password1234", "a@b.c", "A").is_some());
        assert!(policy_violation("aaaaaaaaaaaaaaa", "a@b.c", "A").is_some());
        assert!(policy_violation("jordan-is-great-2026", "jordan@x.io", "J").is_some());
        assert!(policy_violation("correct-horse-battery", "owner@example.com", "Owner").is_none());
    }
}
