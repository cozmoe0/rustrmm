//! Detection rules: is a package present? Evaluated before an action (to skip work that is
//! already done) and after it (to verify the result).

use rustrmm_proto::software::{Detection, software_detected};

/// `None` when the rule is `none` (nothing to check).
pub fn detect(rule: &Detection) -> Option<bool> {
    match rule {
        Detection::None => None,
        Detection::SoftwareName {
            pattern,
            min_version,
        } => Some(software_detected(
            &installed_software(),
            pattern,
            min_version.as_deref(),
        )),
        Detection::File { path, min_version } => Some(file_detected(path, min_version.as_deref())),
        Detection::Registry { key, value, equals } => {
            Some(registry_detected(key, value.as_deref(), equals.as_deref()))
        }
    }
}

/// `(name, version)` of installed software, from the inventory collector.
fn installed_software() -> Vec<(String, String)> {
    let Ok(doc) = crate::collectors::collect(rustrmm_proto::messages::sections::SOFTWARE) else {
        return Vec::new();
    };
    doc.get("items")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|i| {
                    Some((
                        i.get("name")?.as_str()?.to_string(),
                        i.get("version")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Expands `%VAR%` references (Windows-style) from the agent's environment.
pub fn expand_env(path: &str) -> String {
    let mut out = String::new();
    let mut rest = path;
    while let Some(start) = rest.find('%') {
        let Some(len) = rest[start + 1..].find('%') else {
            break;
        };
        let name = &rest[start + 1..start + 1 + len];
        out.push_str(&rest[..start]);
        match std::env::var(name) {
            Ok(value) if !name.is_empty() => out.push_str(&value),
            _ => out.push_str(&rest[start..start + len + 2]),
        }
        rest = &rest[start + len + 2..];
    }
    out.push_str(rest);
    out
}

fn file_detected(path: &str, min_version: Option<&str>) -> bool {
    let path = std::path::PathBuf::from(expand_env(path));
    if !path.is_file() {
        return false;
    }
    match min_version.map(str::trim).filter(|v| !v.is_empty()) {
        None => true,
        Some(min) => match file_version(&path) {
            Some(version) => rustrmm_proto::software::version_satisfies(&version, Some(min)),
            // No version resource (or not Windows): presence is all we can tell.
            None => true,
        },
    }
}

#[cfg(windows)]
fn file_version(path: &std::path::Path) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Storage::FileSystem::{
        GetFileVersionInfoSizeW, GetFileVersionInfoW, VS_FIXEDFILEINFO, VerQueryValueW,
    };
    use windows::core::PCWSTR;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    // SAFETY: NUL-terminated path; the buffer is sized by the API and outlives the queries.
    unsafe {
        let size = GetFileVersionInfoSizeW(PCWSTR(wide.as_ptr()), None);
        if size == 0 {
            return None;
        }
        let mut buffer = vec![0u8; size as usize];
        GetFileVersionInfoW(
            PCWSTR(wide.as_ptr()),
            None,
            size,
            buffer.as_mut_ptr().cast(),
        )
        .ok()?;
        let root: Vec<u16> = "\\".encode_utf16().chain([0]).collect();
        let mut info: *mut std::ffi::c_void = std::ptr::null_mut();
        let mut len = 0u32;
        if !VerQueryValueW(
            buffer.as_ptr().cast(),
            PCWSTR(root.as_ptr()),
            &mut info,
            &mut len,
        )
        .as_bool()
            || info.is_null()
            || (len as usize) < size_of::<VS_FIXEDFILEINFO>()
        {
            return None;
        }
        let fixed = &*(info as *const VS_FIXEDFILEINFO);
        Some(format!(
            "{}.{}.{}.{}",
            fixed.dwFileVersionMS >> 16,
            fixed.dwFileVersionMS & 0xffff,
            fixed.dwFileVersionLS >> 16,
            fixed.dwFileVersionLS & 0xffff
        ))
    }
}

#[cfg(not(windows))]
fn file_version(_path: &std::path::Path) -> Option<String> {
    None
}

#[cfg(windows)]
fn registry_detected(key: &str, value: Option<&str>, equals: Option<&str>) -> bool {
    use winreg::RegKey;
    use winreg::enums::{
        HKEY_CLASSES_ROOT, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, HKEY_USERS, KEY_READ,
        KEY_WOW64_64KEY,
    };
    let Some((hive, sub)) = rustrmm_proto::software::split_registry_key(key) else {
        return false;
    };
    let root = RegKey::predef(match hive {
        "HKLM" => HKEY_LOCAL_MACHINE,
        "HKCU" => HKEY_CURRENT_USER,
        "HKU" => HKEY_USERS,
        _ => HKEY_CLASSES_ROOT,
    });
    let Ok(opened) = root.open_subkey_with_flags(sub, KEY_READ | KEY_WOW64_64KEY) else {
        return false;
    };
    let Some(name) = value else {
        return true;
    };
    let actual: Option<String> = opened
        .get_value::<String, _>(name)
        .ok()
        .or_else(|| opened.get_value::<u32, _>(name).ok().map(|v| v.to_string()))
        .or_else(|| opened.get_value::<u64, _>(name).ok().map(|v| v.to_string()));
    match (actual, equals) {
        (None, _) => false,
        (Some(_), None) => true,
        (Some(a), Some(e)) => a.trim().eq_ignore_ascii_case(e.trim()),
    }
}

#[cfg(not(windows))]
fn registry_detected(_key: &str, _value: Option<&str>, _equals: Option<&str>) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detection_rules_on_this_machine() {
        assert_eq!(detect(&Detection::None), None);
        let exe = std::env::current_exe().expect("exe");
        assert_eq!(
            detect(&Detection::File {
                path: exe.display().to_string(),
                min_version: None
            }),
            Some(true)
        );
        assert_eq!(
            detect(&Detection::File {
                path: exe.with_extension("missing").display().to_string(),
                min_version: None
            }),
            Some(false)
        );
        assert_eq!(
            detect(&Detection::SoftwareName {
                pattern: "rustrmm-no-such-product-*".into(),
                min_version: None
            }),
            Some(false)
        );
        if cfg!(windows) {
            assert_eq!(
                detect(&Detection::Registry {
                    key: r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion".into(),
                    value: Some("CurrentBuildNumber".into()),
                    equals: None
                }),
                Some(true)
            );
            assert_eq!(
                detect(&Detection::Registry {
                    key: r"HKLM\SOFTWARE\RustRMM-Selftest-Missing".into(),
                    value: None,
                    equals: None
                }),
                Some(false)
            );
            let kernel =
                std::path::PathBuf::from(expand_env(r"%SystemRoot%\System32\kernel32.dll"));
            assert!(file_version(&kernel).is_some_and(|v| v.split('.').count() == 4));
            assert_eq!(
                detect(&Detection::File {
                    path: r"%SystemRoot%\System32\kernel32.dll".into(),
                    min_version: Some("1.0".into())
                }),
                Some(true)
            );
            assert_eq!(
                detect(&Detection::File {
                    path: r"%SystemRoot%\System32\kernel32.dll".into(),
                    min_version: Some("99.0".into())
                }),
                Some(false)
            );
        } else {
            assert_eq!(
                detect(&Detection::Registry {
                    key: r"HKLM\SOFTWARE\x".into(),
                    value: None,
                    equals: None
                }),
                Some(false)
            );
        }
    }

    #[test]
    fn environment_expansion() {
        // SAFETY (test only): a variable unique to this test.
        unsafe { std::env::set_var("RUSTRMM_DETECT_TEST", "C:\\Apps") };
        assert_eq!(expand_env(r"%RUSTRMM_DETECT_TEST%\x.exe"), r"C:\Apps\x.exe");
        assert_eq!(
            expand_env(r"%NO_SUCH_VAR_RUSTRMM%\x"),
            r"%NO_SUCH_VAR_RUSTRMM%\x"
        );
        assert_eq!(expand_env("/usr/bin/x"), "/usr/bin/x");
        assert_eq!(expand_env("50% off"), "50% off");
    }
}
