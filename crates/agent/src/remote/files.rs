//! File manager operations: listing, create folder, rename, delete.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use anyhow::{Context, Result, bail};
use rustrmm_proto::remote::FileOp;
use serde_json::{Value, json};

/// Upper bound on entries returned for one directory.
const MAX_ENTRIES: usize = 5000;

pub fn list(path: &str) -> Result<Value> {
    let path = path.trim();
    if path.is_empty() {
        return Ok(json!({ "path": "", "parent": null, "entries": roots(), "truncated": false }));
    }
    let dir = absolute(path)?;
    let read = std::fs::read_dir(&dir).with_context(|| format!("cannot open {}", dir.display()))?;
    let mut entries = Vec::new();
    let mut truncated = false;
    for entry in read.flatten() {
        if entries.len() >= MAX_ENTRIES {
            truncated = true;
            break;
        }
        entries.push(describe(
            &entry.path(),
            entry.file_name().to_string_lossy().as_ref(),
        ));
    }
    entries.sort_by(|a, b| {
        b["is_dir"]
            .as_bool()
            .cmp(&a["is_dir"].as_bool())
            .then_with(|| {
                a["name"]
                    .as_str()
                    .unwrap_or("")
                    .to_lowercase()
                    .cmp(&b["name"].as_str().unwrap_or("").to_lowercase())
            })
    });
    let parent = dir.parent().map(|p| p.display().to_string());
    Ok(json!({
        "path": dir.display().to_string(),
        "parent": parent,
        "separator": std::path::MAIN_SEPARATOR.to_string(),
        "entries": entries,
        "truncated": truncated,
    }))
}

pub fn apply(op: FileOp) -> Result<Value> {
    match &op {
        FileOp::Mkdir { path } => {
            let p = absolute(path)?;
            std::fs::create_dir_all(&p)
                .with_context(|| format!("cannot create {}", p.display()))?;
        }
        FileOp::Rename { from, to } => {
            let (from, to) = (absolute(from)?, absolute(to)?);
            guard(&from)?;
            if to.exists() {
                bail!("{} already exists", to.display());
            }
            std::fs::rename(&from, &to)
                .with_context(|| format!("cannot rename {}", from.display()))?;
        }
        FileOp::Delete { path, recursive } => {
            let p = absolute(path)?;
            guard(&p)?;
            let meta = std::fs::symlink_metadata(&p)
                .with_context(|| format!("{} does not exist", p.display()))?;
            if meta.is_dir() {
                if *recursive {
                    std::fs::remove_dir_all(&p)
                } else {
                    std::fs::remove_dir(&p)
                }
                .with_context(|| format!("cannot delete {}", p.display()))?;
            } else {
                std::fs::remove_file(&p)
                    .with_context(|| format!("cannot delete {}", p.display()))?;
            }
        }
    }
    Ok(json!({ "ok": true, "summary": op.summary() }))
}

/// Requires an absolute path; rejects relative paths so nothing depends on the agent's cwd.
pub fn absolute(path: &str) -> Result<PathBuf> {
    let p = PathBuf::from(path.trim());
    if !p.is_absolute() {
        bail!("an absolute path is required");
    }
    Ok(p)
}

/// Refuses to modify file-system roots and the agent's own installation.
pub fn guard(path: &Path) -> Result<()> {
    if path.parent().is_none() || path.components().count() <= 1 {
        bail!("refusing to modify a file-system root");
    }
    let lower = path.display().to_string().to_lowercase();
    let protected = if cfg!(windows) {
        vec![
            r"c:\windows".to_string(),
            r"c:\program files\rustrmm".to_string(),
            r"c:\programdata\rustrmm".to_string(),
        ]
    } else {
        vec![
            "/opt/rustrmm".into(),
            "/var/lib/rustrmm".into(),
            "/etc/rustrmm".into(),
            "/library/rustrmm".into(),
            "/library/application support/rustrmm".into(),
        ]
    };
    for p in protected {
        if lower == p || lower.starts_with(&format!("{p}{}", std::path::MAIN_SEPARATOR)) {
            bail!("refusing to modify a protected location ({p})");
        }
    }
    Ok(())
}

fn describe(path: &Path, name: &str) -> Value {
    let link = std::fs::symlink_metadata(path).ok();
    let meta = std::fs::metadata(path).ok().or_else(|| link.clone());
    let is_link = link.as_ref().is_some_and(|m| m.file_type().is_symlink());
    let is_dir = meta.as_ref().is_some_and(|m| m.is_dir());
    let modified = meta
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    let readonly = meta.as_ref().is_some_and(|m| m.permissions().readonly());
    json!({
        "name": name,
        "path": path.display().to_string(),
        "is_dir": is_dir,
        "is_link": is_link,
        "size": if is_dir { None } else { meta.as_ref().map(|m| m.len()) },
        "modified": modified,
        "readonly": readonly,
        "hidden": hidden(name, meta.as_ref()),
    })
}

#[cfg(windows)]
fn hidden(_name: &str, meta: Option<&std::fs::Metadata>) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    meta.is_some_and(|m| m.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0)
}

#[cfg(not(windows))]
fn hidden(name: &str, _meta: Option<&std::fs::Metadata>) -> bool {
    name.starts_with('.')
}

#[cfg(windows)]
fn roots() -> Vec<Value> {
    (b'A'..=b'Z')
        .map(|l| format!("{}:\\", l as char))
        .filter(|d| Path::new(d).exists())
        .map(|d| {
            json!({ "name": d.trim_end_matches('\\'), "path": d, "is_dir": true, "is_link": false,
                    "size": null, "modified": null, "readonly": false, "hidden": false, "drive": true })
        })
        .collect()
}

#[cfg(not(windows))]
fn roots() -> Vec<Value> {
    vec![
        json!({ "name": "/", "path": "/", "is_dir": true, "is_link": false, "size": null,
                "modified": null, "readonly": false, "hidden": false, "drive": true }),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_relative_and_root_paths() {
        assert!(absolute("relative/path").is_err());
        let root = if cfg!(windows) { "C:\\" } else { "/" };
        assert!(guard(Path::new(root)).is_err());
        let protected = if cfg!(windows) {
            "C:\\Windows\\System32"
        } else {
            "/opt/rustrmm/rustrmm-agent"
        };
        assert!(guard(Path::new(protected)).is_err());
    }

    #[test]
    fn lists_and_mutates_a_temp_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        let base = dir.path().display().to_string();
        let sub = dir.path().join("child");
        apply(FileOp::Mkdir {
            path: sub.display().to_string(),
        })
        .expect("mkdir");
        std::fs::write(sub.join("a.txt"), b"hello").expect("write");
        let listing = list(&base).expect("list");
        assert_eq!(listing["entries"][0]["name"], "child");
        assert_eq!(listing["entries"][0]["is_dir"], true);
        let renamed = dir.path().join("renamed");
        apply(FileOp::Rename {
            from: sub.display().to_string(),
            to: renamed.display().to_string(),
        })
        .expect("rename");
        assert!(
            apply(FileOp::Delete {
                path: renamed.display().to_string(),
                recursive: false
            })
            .is_err(),
            "non-empty dir needs recursive"
        );
        apply(FileOp::Delete {
            path: renamed.display().to_string(),
            recursive: true,
        })
        .expect("delete");
        assert!(!renamed.exists());
    }
}
