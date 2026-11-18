//! Read-only registry browser (Windows).

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use winreg::RegKey;
use winreg::enums::{
    HKEY_CLASSES_ROOT, HKEY_CURRENT_CONFIG, HKEY_LOCAL_MACHINE, HKEY_USERS, KEY_READ, RegType,
};

const MAX_ITEMS: usize = 5000;
const HIVES: [(&str, &str); 4] = [
    ("HKEY_LOCAL_MACHINE", "HKLM"),
    ("HKEY_USERS", "HKU"),
    ("HKEY_CLASSES_ROOT", "HKCR"),
    ("HKEY_CURRENT_CONFIG", "HKCC"),
];

pub fn list(path: &str) -> Result<Value> {
    let path = path.trim().trim_matches('\\');
    if path.is_empty() {
        let keys: Vec<Value> = HIVES
            .iter()
            .map(|(long, short)| json!({ "name": long, "path": short }))
            .collect();
        return Ok(json!({ "path": "", "keys": keys, "values": [] }));
    }
    let (hive, sub) = path.split_once('\\').unwrap_or((path, ""));
    let (root, short) = match hive.to_ascii_uppercase().as_str() {
        "HKLM" | "HKEY_LOCAL_MACHINE" => (HKEY_LOCAL_MACHINE, "HKLM"),
        "HKU" | "HKEY_USERS" => (HKEY_USERS, "HKU"),
        "HKCR" | "HKEY_CLASSES_ROOT" => (HKEY_CLASSES_ROOT, "HKCR"),
        "HKCC" | "HKEY_CURRENT_CONFIG" => (HKEY_CURRENT_CONFIG, "HKCC"),
        _ => bail!("unknown hive {hive}"),
    };
    let base = RegKey::predef(root);
    let key = if sub.is_empty() {
        base
    } else {
        base.open_subkey_with_flags(sub, KEY_READ)
            .with_context(|| format!("cannot open {short}\\{sub}"))?
    };
    let prefix = if sub.is_empty() {
        short.to_string()
    } else {
        format!("{short}\\{sub}")
    };
    let mut keys: Vec<Value> = key
        .enum_keys()
        .flatten()
        .take(MAX_ITEMS)
        .map(|name| json!({ "name": name, "path": format!("{prefix}\\{name}") }))
        .collect();
    keys.sort_by(|a, b| {
        a["name"]
            .as_str()
            .unwrap_or("")
            .to_lowercase()
            .cmp(&b["name"].as_str().unwrap_or("").to_lowercase())
    });
    let values: Vec<Value> = key
        .enum_values()
        .flatten()
        .take(MAX_ITEMS)
        .map(|(name, value)| {
            let data = match value.vtype {
                RegType::REG_SZ
                | RegType::REG_EXPAND_SZ
                | RegType::REG_MULTI_SZ
                | RegType::REG_DWORD
                | RegType::REG_QWORD => value.to_string(),
                _ => {
                    let shown: Vec<String> = value
                        .bytes
                        .iter()
                        .take(256)
                        .map(|b| format!("{b:02x}"))
                        .collect();
                    let mut s = shown.join(" ");
                    if value.bytes.len() > 256 {
                        s.push_str(&format!(" … ({} bytes)", value.bytes.len()));
                    }
                    s
                }
            };
            json!({
                "name": if name.is_empty() { "(Default)".to_string() } else { name },
                "type": format!("{:?}", value.vtype),
                "data": data,
            })
        })
        .collect();
    Ok(json!({ "path": prefix, "keys": keys, "values": values }))
}
