//! BitLocker recovery passwords from WMI (`Win32_EncryptableVolume` in
//! `root\cimv2\security\microsoftvolumeencryption`): `GetKeyProtectors` with type 3
//! (numerical password), then `GetKeyProtectorNumericalPassword` for each protector.
//!
//! The parsing works on JSON views of the WMI results so it is tested on every platform; the
//! recovery passwords themselves only ever live in zeroizing buffers.

// Collection is Windows-only; the parsers are used by tests and the self-test everywhere.
#![cfg_attr(not(windows), allow(dead_code))]

use anyhow::{Result, bail};
use serde_json::Value;
use zeroize::Zeroizing;

/// `KeyProtectorType` of a numerical (48-digit recovery) password.
pub const NUMERICAL_PASSWORD: u32 = 3;

/// One encryptable volume.
#[derive(Debug, Clone, PartialEq)]
pub struct Volume {
    /// WMI object path (`__PATH`) for method calls.
    pub path: String,
    pub device_id: String,
    pub drive: Option<String>,
    /// 0 off, 1 on, 2 unknown (locked).
    pub protection_status: Option<u64>,
}

/// One escrowable recovery password.
pub struct Protector {
    pub volume: String,
    pub drive: Option<String>,
    pub protector_id: String,
    pub password: Zeroizing<String>,
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

/// Rows of the `Win32_EncryptableVolume` query.
pub fn parse_volumes(rows: &[Value]) -> Vec<Volume> {
    rows.iter()
        .filter_map(|r| {
            Some(Volume {
                path: text(r, "__PATH")?,
                device_id: text(r, "DeviceID").unwrap_or_default(),
                drive: text(r, "DriveLetter"),
                protection_status: r.get("ProtectionStatus").and_then(Value::as_u64),
            })
        })
        .collect()
}

fn return_value(out: &Value) -> Result<()> {
    match out.get("ReturnValue").and_then(Value::as_u64) {
        Some(0) => Ok(()),
        Some(code) => bail!("WMI returned 0x{code:08X}"),
        None => bail!("WMI result without ReturnValue"),
    }
}

/// Protector ids from the `GetKeyProtectors` output parameters.
pub fn parse_protector_ids(out: &Value) -> Result<Vec<String>> {
    return_value(out)?;
    Ok(match out.get("VolumeKeyProtectorID") {
        Some(Value::Array(ids)) => ids
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|s| s.starts_with('{') && s.ends_with('}') && s.len() <= 64)
            .map(String::from)
            .collect(),
        Some(Value::String(one)) if !one.trim().is_empty() => vec![one.trim().to_string()],
        _ => Vec::new(),
    })
}

/// A recovery password: eight groups of six digits, each group divisible by 11.
pub fn valid_recovery_password(p: &str) -> bool {
    let groups: Vec<&str> = p.split('-').collect();
    groups.len() == 8
        && groups.iter().all(|g| {
            g.len() == 6
                && g.bytes().all(|b| b.is_ascii_digit())
                && g.parse::<u32>().is_ok_and(|n| n % 11 == 0)
        })
}

/// The recovery password from the `GetKeyProtectorNumericalPassword` output parameters.
pub fn parse_numerical_password(out: &Value) -> Result<Zeroizing<String>> {
    return_value(out)?;
    let Some(password) = out.get("NumericalPassword").and_then(Value::as_str) else {
        bail!("no NumericalPassword in the WMI result");
    };
    let password = Zeroizing::new(password.trim().to_string());
    if !valid_recovery_password(&password) {
        bail!("the recovery password has an unexpected format");
    }
    Ok(password)
}

#[cfg(windows)]
pub fn collect() -> Result<(Vec<Volume>, Vec<Protector>, Vec<String>)> {
    use std::collections::HashMap;

    use wmi::{Variant, WMIConnection};

    fn json(v: &Variant) -> Value {
        match v {
            Variant::String(s) => Value::String(s.clone()),
            Variant::I1(n) => Value::from(*n),
            Variant::I2(n) => Value::from(*n),
            Variant::I4(n) => Value::from(*n),
            Variant::I8(n) => Value::from(*n),
            Variant::UI1(n) => Value::from(*n),
            Variant::UI2(n) => Value::from(*n),
            Variant::UI4(n) => Value::from(*n),
            Variant::UI8(n) => Value::from(*n),
            Variant::Bool(b) => Value::from(*b),
            Variant::Array(items) => Value::Array(items.iter().map(json).collect()),
            _ => Value::Null,
        }
    }

    let con = WMIConnection::with_namespace_path(r"ROOT\CIMV2\Security\MicrosoftVolumeEncryption")
        .map_err(|e| {
            anyhow::anyhow!(
                "BitLocker WMI namespace unavailable (administrator rights needed): {e}"
            )
        })?;
    let rows: Vec<HashMap<String, Variant>> = con
        .raw_query(
            "SELECT __PATH, DeviceID, DriveLetter, ProtectionStatus FROM Win32_EncryptableVolume",
        )
        .map_err(|e| anyhow::anyhow!("querying Win32_EncryptableVolume failed: {e}"))?;
    let rows: Vec<Value> = rows
        .iter()
        .map(|r| Value::Object(r.iter().map(|(k, v)| (k.clone(), json(v))).collect()))
        .collect();
    let volumes = parse_volumes(&rows);
    let mut protectors = Vec::new();
    let mut errors = Vec::new();
    let class = con
        .get_object("Win32_EncryptableVolume")
        .map_err(|e| anyhow::anyhow!("Win32_EncryptableVolume class unavailable: {e}"))?;
    let outputs = |out: Option<wmi::IWbemClassWrapper>, keys: &[&str]| -> Value {
        let mut map = serde_json::Map::new();
        if let Some(out) = out {
            for key in keys {
                if let Ok(v) = out.get_property(key) {
                    map.insert((*key).to_string(), json(&v));
                }
            }
        }
        Value::Object(map)
    };
    for volume in &volumes {
        let ids = (|| -> Result<Vec<String>> {
            let input = class
                .get_method("GetKeyProtectors")?
                .ok_or_else(|| anyhow::anyhow!("GetKeyProtectors is missing"))?
                .spawn_instance()?;
            input.put_property("KeyProtectorType", NUMERICAL_PASSWORD)?;
            let out = con.exec_method(&volume.path, "GetKeyProtectors", Some(&input))?;
            parse_protector_ids(&outputs(out, &["ReturnValue", "VolumeKeyProtectorID"]))
        })();
        let ids = match ids {
            Ok(ids) => ids,
            Err(e) => {
                errors.push(format!(
                    "{}: {e:#}",
                    volume.drive.as_deref().unwrap_or(&volume.device_id)
                ));
                continue;
            }
        };
        for id in ids {
            let password = (|| -> Result<Zeroizing<String>> {
                let input = class
                    .get_method("GetKeyProtectorNumericalPassword")?
                    .ok_or_else(|| anyhow::anyhow!("GetKeyProtectorNumericalPassword is missing"))?
                    .spawn_instance()?;
                input.put_property("VolumeKeyProtectorID", id.as_str())?;
                let out = con.exec_method(
                    &volume.path,
                    "GetKeyProtectorNumericalPassword",
                    Some(&input),
                )?;
                let mut view = outputs(out, &["ReturnValue", "NumericalPassword"]);
                let parsed = parse_numerical_password(&view);
                // Drop the plaintext copy held by the JSON view.
                if let Some(Value::String(s)) = view.get_mut("NumericalPassword") {
                    zeroize::Zeroize::zeroize(s);
                }
                parsed
            })();
            match password {
                Ok(password) => protectors.push(Protector {
                    volume: volume.device_id.clone(),
                    drive: volume.drive.clone(),
                    protector_id: id,
                    password,
                }),
                Err(e) => errors.push(format!("{id}: {e:#}")),
            }
        }
    }
    Ok((volumes, protectors, errors))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_wmi_results() {
        let rows = vec![
            json!({ "__PATH": r#"\\HOST\ROOT\CIMV2\Security\MicrosoftVolumeEncryption:Win32_EncryptableVolume.DeviceID="\\\\?\\Volume{a1}\\""#,
                    "DeviceID": r"\\?\Volume{a1}\", "DriveLetter": "C:", "ProtectionStatus": 1 }),
            json!({ "__PATH": r#"\\HOST\...:Win32_EncryptableVolume.DeviceID="\\\\?\\Volume{b2}\\""#,
                    "DeviceID": r"\\?\Volume{b2}\", "DriveLetter": null, "ProtectionStatus": 0 }),
            json!({ "DeviceID": "no path" }),
        ];
        let volumes = parse_volumes(&rows);
        assert_eq!(volumes.len(), 2);
        assert_eq!(volumes[0].drive.as_deref(), Some("C:"));
        assert_eq!(volumes[0].protection_status, Some(1));
        assert_eq!(volumes[1].drive, None);

        let ids = parse_protector_ids(&json!({
            "ReturnValue": 0,
            "VolumeKeyProtectorID": ["{2F1C1B2A-0000-4000-8000-000000000001}", "  ", "not-a-guid"]
        }))
        .expect("ids");
        assert_eq!(
            ids,
            vec!["{2F1C1B2A-0000-4000-8000-000000000001}".to_string()]
        );
        assert!(
            parse_protector_ids(&json!({ "ReturnValue": 2_150_694_912u64 })).is_err(),
            "FVE_E_LOCKED_VOLUME"
        );
        assert_eq!(
            parse_protector_ids(&json!({ "ReturnValue": 0 })).expect("none"),
            Vec::<String>::new()
        );

        // Every group of a recovery password is a multiple of 11.
        let good = "123453-234564-345675-456786-567897-679008-790119-801130";
        assert!(valid_recovery_password(good));
        let password =
            parse_numerical_password(&json!({ "ReturnValue": 0, "NumericalPassword": good }))
                .expect("password");
        assert_eq!(password.as_str(), good);
        assert!(
            parse_numerical_password(&json!({ "ReturnValue": 0, "NumericalPassword": "123456-1" }))
                .is_err()
        );
        assert!(!valid_recovery_password(
            "123456-234567-345678-456789-567890-678901-789012-890123"
        ));
        assert!(parse_numerical_password(&json!({ "ReturnValue": 1 })).is_err());
    }
}
