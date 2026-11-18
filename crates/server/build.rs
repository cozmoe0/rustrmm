//! Embeds the built-in script pack (`builtin-scripts/`) at compile time: every file in the
//! directory becomes an `include_str!` entry, and the manifest is parsed at start-up.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

fn collect(dir: &Path, root: &Path, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.path());
    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            collect(&path, root, out);
        } else if let Ok(relative) = path.strip_prefix(root) {
            let name = relative
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            out.push((name, path));
        }
    }
}

fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let root = manifest_dir.join("builtin-scripts");
    println!("cargo:rerun-if-changed={}", root.display());
    // `sqlx::migrate!` embeds the migrations; a new file must rebuild the crate.
    println!(
        "cargo:rerun-if-changed={}",
        manifest_dir.join("migrations").display()
    );
    let mut files = Vec::new();
    collect(&root, &root, &mut files);
    let mut code =
        String::from("/// Built-in script files: (path relative to builtin-scripts/, content).\n");
    code.push_str("pub static BUILTIN_FILES: &[(&str, &str)] = &[\n");
    for (name, path) in &files {
        println!("cargo:rerun-if-changed={}", path.display());
        let _ = writeln!(
            code,
            "    ({name:?}, include_str!({:?})),",
            path.to_string_lossy()
        );
    }
    code.push_str("];\n");
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("out dir")).join("builtin_scripts.rs");
    std::fs::write(out, code).expect("write builtin_scripts.rs");
}
