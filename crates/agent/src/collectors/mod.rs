//! Inventory collection. Each section is a JSON document; the agent only sends a section when
//! its hash differs from what the server already holds.

mod common;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
pub mod windows;

use anyhow::{Result, bail};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use rustrmm_proto::messages::sections;

#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(windows)]
use windows as platform;

/// macOS permission state for remote desktop (`security.tcc`).
#[cfg(target_os = "macos")]
pub fn macos_tcc() -> Value {
    macos::tcc()
}

pub fn os_family() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

/// Collects one section. Blocking (runs WMI queries and helper programs).
pub fn collect(section: &str) -> Result<Value> {
    let mut doc = Map::new();
    match section {
        sections::SYSTEM => {
            common::system(&mut doc);
            platform::system(&mut doc);
        }
        sections::HARDWARE => {
            common::hardware(&mut doc);
            platform::hardware(&mut doc);
        }
        sections::STORAGE => {
            common::storage(&mut doc);
            platform::storage(&mut doc);
        }
        sections::NETWORK => {
            common::network(&mut doc);
            platform::network(&mut doc);
        }
        sections::SOFTWARE => platform::software(&mut doc),
        sections::SECURITY => platform::security(&mut doc),
        sections::USERS => platform::users(&mut doc),
        sections::SERVICES => platform::services(&mut doc),
        sections::UPDATES => platform::updates(&mut doc),
        other => bail!("unknown section {other}"),
    }
    Ok(Value::Object(doc))
}

/// Stable hash of a section document (keys are serialised in a fixed order).
pub fn hash(value: &Value) -> String {
    let canonical = serde_json::to_vec(value).unwrap_or_default();
    hex::encode(Sha256::digest(&canonical))
}

/// Identity facts sent at enrollment and in every hello.
pub struct EnrollmentFacts {
    pub hostname: String,
    pub os_name: String,
    pub os_version: String,
    pub hardware_uuid: Option<String>,
    pub serial: Option<String>,
    pub domain: Option<String>,
}

pub fn enrollment_facts() -> EnrollmentFacts {
    let hostname = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "unknown".into());
    let (hardware_uuid, serial, domain) = platform::identity();
    EnrollmentFacts {
        hostname,
        os_name: sysinfo::System::long_os_version()
            .or_else(|_| sysinfo::System::name())
            .unwrap_or_default(),
        os_version: sysinfo::System::os_version().unwrap_or_default(),
        hardware_uuid,
        serial,
        domain,
    }
}

/// User signed in at the physical console, if any.
pub fn console_user() -> Option<String> {
    platform::console_user()
}

/// Helpers shared by platform modules.
pub(crate) fn opt_str(s: impl AsRef<str>) -> Value {
    let s = s.as_ref().trim();
    if s.is_empty() {
        Value::Null
    } else {
        Value::String(s.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_section_collects_without_error() {
        for section in sections::ALL {
            let value = collect(section).unwrap_or_else(|e| panic!("{section}: {e:#}"));
            assert!(value.is_object(), "{section} returns an object");
            assert_eq!(hash(&value), hash(&value), "{section} hash is stable");
        }
    }

    #[test]
    fn system_section_has_core_fields() {
        let sys = collect(sections::SYSTEM).expect("system");
        assert!(
            sys.get("hostname")
                .and_then(Value::as_str)
                .is_some_and(|h| !h.is_empty())
        );
        assert!(sys.pointer("/os/family").and_then(Value::as_str).is_some());
    }
}
