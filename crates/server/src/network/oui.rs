//! OUI vendor lookup from the bundled compact table (`oui.txt`).

use std::collections::HashMap;
use std::sync::LazyLock;

static TABLE: LazyLock<HashMap<u32, &'static str>> =
    LazyLock::new(|| parse(include_str!("oui.txt")));

fn parse(text: &'static str) -> HashMap<u32, &'static str> {
    let mut map = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((vendor, prefixes)) = line.split_once('|') else {
            continue;
        };
        for prefix in prefixes.split_whitespace() {
            if prefix.len() == 6
                && let Ok(n) = u32::from_str_radix(prefix, 16)
            {
                map.insert(n, vendor.trim());
            }
        }
    }
    map
}

/// Normalises a MAC address (`aa-bb-cc-dd-ee-ff`, `AABB.CCDD.EEFF`, `aa:bb:…`) to
/// `aa:bb:cc:dd:ee:ff`; `None` when it is not 48 bits of hex.
pub fn normalize_mac(mac: &str) -> Option<String> {
    let hex: String = mac.chars().filter(char::is_ascii_hexdigit).collect();
    if hex.len() != 12
        || mac
            .chars()
            .any(|c| !c.is_ascii_hexdigit() && !matches!(c, ':' | '-' | '.' | ' '))
    {
        return None;
    }
    let hex = hex.to_ascii_lowercase();
    let parts: Vec<&str> = (0..6).map(|i| &hex[i * 2..i * 2 + 2]).collect();
    let joined = parts.join(":");
    if joined == "00:00:00:00:00:00" || joined == "ff:ff:ff:ff:ff:ff" {
        return None;
    }
    Some(joined)
}

/// Vendor for a MAC address. Locally administered addresses (randomised phone MACs, most
/// virtual NICs) have no vendor, except the well-known QEMU/KVM prefix.
pub fn vendor(mac: &str) -> Option<&'static str> {
    let mac = normalize_mac(mac)?;
    let hex: String = mac.chars().filter(|c| *c != ':').collect();
    let prefix = u32::from_str_radix(&hex[..6], 16).ok()?;
    TABLE.get(&prefix).copied()
}

/// Number of prefixes in the bundled table.
pub fn len() -> usize {
    TABLE.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oui_lookup() {
        assert!(len() > 300, "bundled table has {} prefixes", len());
        assert_eq!(vendor("00:50:56:12:34:56"), Some("VMware"));
        assert_eq!(vendor("00-0C-29-AA-BB-CC"), Some("VMware"));
        assert_eq!(vendor("b827.eb01.0203"), Some("Raspberry Pi"));
        assert_eq!(vendor("00:11:32:01:02:03"), Some("Synology"));
        assert_eq!(vendor("00:1B:A9:00:00:01"), Some("Brother"));
        assert_eq!(
            vendor("00:C0:B7:00:00:01"),
            Some("American Power Conversion")
        );
        assert_eq!(vendor("52:54:00:12:34:56"), Some("QEMU/KVM"));
        assert_eq!(
            vendor("02:00:00:00:00:01"),
            None,
            "locally administered, unknown"
        );
        assert_eq!(vendor("not a mac"), None);
        assert_eq!(vendor("00:50:56:12:34"), None);
        assert_eq!(
            normalize_mac("AA-BB-CC-DD-EE-0F").as_deref(),
            Some("aa:bb:cc:dd:ee:0f")
        );
        assert_eq!(normalize_mac("ff:ff:ff:ff:ff:ff"), None);
        assert_eq!(normalize_mac("zz:bb:cc:dd:ee:ff"), None);
    }
}
