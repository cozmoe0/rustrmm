//! Shared building blocks used by every RustRMM binary.

pub mod logging;

/// Product name shown in UIs, logs and installers.
pub const PRODUCT_NAME: &str = "RustRMM";

/// Version of this build (workspace version).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Generates a new time-ordered identifier (UUIDv7, hyphenated lowercase).
pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

/// Current UTC time truncated to whole milliseconds.
///
/// Truncation keeps timestamps stored as text in SQLite uniformly formatted (and therefore
/// lexically sortable) and makes values round-trip exactly through the database.
pub fn now() -> chrono::DateTime<chrono::Utc> {
    use chrono::Timelike;
    let now = chrono::Utc::now();
    let millis = now.nanosecond() / 1_000_000 * 1_000_000;
    now.with_nanosecond(millis).unwrap_or(now)
}

/// Converts a display name into a URL-safe slug (`"Harbor & Pine"` → `"harbor-pine"`).
pub fn slugify(input: &str) -> String {
    let mut slug = String::with_capacity(input.len());
    let mut last_dash = true;
    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            slug.push('-');
            last_dash = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        slug.push_str("item");
    }
    slug.truncate(64);
    slug
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_handles_symbols_and_case() {
        assert_eq!(slugify("Harbor & Pine Legal"), "harbor-pine-legal");
        assert_eq!(slugify("  --Summit Freight-- "), "summit-freight");
        assert_eq!(slugify("&&&"), "item");
    }

    #[test]
    fn ids_are_unique_and_ordered() {
        let a = new_id();
        let b = new_id();
        assert_ne!(a, b);
        assert!(a < b, "UUIDv7 ids sort by creation time");
    }
}
