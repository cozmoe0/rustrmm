//! Stamps the build version. With `RUSTRMM_BUILD_ID` set (digits only, e.g. the UTC build time
//! `20261118220341`) the version becomes `<workspace version>+<build id>`, so every image or
//! bundle build is a distinct agent release that compares newer than the previous one.

fn main() {
    println!("cargo:rerun-if-env-changed=RUSTRMM_BUILD_ID");
    let base = std::env::var("CARGO_PKG_VERSION").unwrap_or_default();
    let build = std::env::var("RUSTRMM_BUILD_ID").unwrap_or_default();
    let build = build.trim();
    let version = if build.is_empty() {
        base
    } else if build.len() <= 18 && build.chars().all(|c| c.is_ascii_digit()) {
        format!("{base}+{build}")
    } else {
        panic!("RUSTRMM_BUILD_ID must be 1 to 18 digits, got {build:?}");
    };
    println!("cargo:rustc-env=RUSTRMM_VERSION={version}");
}
